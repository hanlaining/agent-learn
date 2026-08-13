# Codex 式父子 Agent 协作与共享数据板：完整实施计划

日期：2026-08-12  
项目：`D:\练手\agent-learn`  
状态：方案已对齐，尚未施工。  
官方参考：[OpenAI Docs：Codex Subagents](https://developers.openai.com/codex/agent-configuration/subagents)

关联资料：

- [问题清单](./Chat独立Job与单Job-Agent树-问题清单.md)
- [根因分析](./Chat独立Job与单Job-Agent树-根因分析.md)
- [已有解决方案](./Chat独立Job与单Job-Agent树-解决方案.md)
- [`run_return` 总排查记录](./Multi-Agent-run_return根因排查与修复方案-2026-08-12.md)
- [阿卡夏 Graph Engineering 借鉴与 Chat 级 Agent 控制器方案](./阿卡夏Graph-Engineering借鉴与Chat级Agent控制器方案.md)

## 1. 最终目标

将当前项目实现为：

```text
多个 Chat = 多个彼此独立、可同时运行的 Job

Chat A / Job A
└─ 首脑 Agent
   ├─ 排查 Agent
   ├─ 资料 Agent
   ├─ 编程 Agent
   └─ 测试 Agent

Chat B / Job B
└─ 首脑 Agent
   ├─ 资料 Agent
   └─ 编程 Agent
```

产品必须满足：

- Chat A 正在执行时，用户可以新建、切换并运行 Chat B。
- 不同 Chat 的上下文、取消、超时、Agent 树、Return 和最终结果完全隔离。
- 每个 Job 由一个首脑 Agent负责任务拆解、分派、追踪和汇总。
- 每个 Job 默认最多创建 10 个子 Agent，用户可通过模型选择器旁的 Chat 级下拉控制器选择上限和角色。
- 子 Agent以树形挂在直接父 Agent下面，支持子 Agent继续委派。
- 子 Agent共享当前 Job 的已确认数据和产物，避免重复搜索、重复读文件和重复验证。
- 子 Agent保留独立执行上下文，只把结构化成果和摘要返回共享数据板与父 Agent。
- 子 Agent返回后，父 Agent自动恢复并完成任务，不询问用户是否继续。
- 用户可以查看、引导、停止单个子 Agent，也可以取消整个 Job。

## 2. 与 Codex 官方机制的对齐

OpenAI Docs 已明确 Codex Subagents 的核心行为：

- 主 Agent可以创建专业子 Agent并行工作；
- 编排器负责创建、追加指令、等待、停止和关闭子线程；
- 子 Agent拥有独立线程；
- 子 Agent返回精炼摘要，主 Agent等待并汇总；
- 子 Agent默认继承父 Turn 的权限与沙箱策略；
- 可配置子 Agent并发数、模型、推理强度和自定义指令；
- 用户可以打开子 Agent线程查看进度和结果。

本项目不重新发明这套协作概念，而是在相同原则上增加：

1. Job 级持久化共享数据板；
2. 模型选择器旁的 Chat 级 Agent 控制器；
3. 可重启恢复的 Return Outbox + Ack；
4. 当前 Job 的多层树形可视化；
5. 多 Chat 后台并行与切换隔离。

## 3. 当前已有能力与真实缺口

| 能力 | 当前状态 | 结论 |
|---|---|---|
| 多 Chat 数据容器 | 已有 Thread、Turn、RuntimeSession | 有基础，但未形成明确 Job 边界 |
| Agent Profile | 已有 orchestrator/investigator/coder/tester | 主 Profile 尚未进入真实主 Turn |
| 子 Agent Tool | 已有 `run_agent` | 可触发子执行，但仍是同步等待 |
| 父子结构 | 已有 `parentRunId`、`childRunIds`、`depth` | 缺少 `jobId/rootRunId` 强隔离 |
| 并行调度 | 已有全局并发 4 | 缺少每 Job 配额、10 个总量限制和公平调度 |
| Return | Tool output 中带 `type=run_return` | 无 Outbox/Ack，receipt 提前提交 |
| 取消 | 已有父级联取消后代 | 需要按 Job 隔离 Return 和排队任务 |
| 持久化 | 已保存 AgentRun、receipt、Session | 缺少共享数据板和未消费 Return |
| 权限 | 已有 PermissionGate 和客户端弹窗 | 子 Agent角色权限与团队配置未接入 |
| UI 树 | 已按 `parentRunId` 递归 | 查询包含历史根 Turn，统计口径错误 |
| 多 Chat 后台运行 | Controller 已按 thread 保存部分运行状态 | 需要完整并发切换验收 |

## 4. 核心领域模型

### 4.1 Job

每次用户发送任务创建一个 Job；第一版可让 `jobId` 对应当前根 Turn/根 AgentRun。

```ts
interface AgentJob {
  id: string;
  threadId: string;
  rootTurnId: string;
  rootRunId: string;
  status:
    | "queued"
    | "running"
    | "waiting_children"
    | "resuming"
    | "completed"
    | "failed"
    | "cancelled"
    | "timed_out";
  teamConfig: AgentTeamConfig;
  createdAt: string;
  completedAt?: string;
}
```

约束：一个 Job 只有一个根 Agent；所有后代节点的 `jobId`、`rootRunId` 必须相同。

### 4.2 团队配置

```ts
interface AgentTeamConfig {
  enabled: boolean;
  delegationMode: "auto" | "manual";
  maxSubagents: number;       // 默认 10，允许 1–10
  maxConcurrent: number;      // 默认 4，不超过 maxSubagents
  maxDepth: number;           // 默认 3
  scheduling: "dependency_graph" | "independent_only";
  completionStrategy: "event_driven_first_completed";
  allowedProfiles: string[];
  permissionMode: "inherit" | "least_privilege";
  shareBoard: boolean;
  independentReview: boolean;
}
```

数量规则：

- `maxSubagents = 10` 是一个 Job 整棵树的子节点总预算，不是每个父节点 10 个。
- 根 Agent不计入这 10 个。
- 默认同时运行 4 个，其余自动排队。
- 最大深度默认 3，根节点深度为 0。
- 多个 Job 共用一个全局并发池，但每个 Job 都有自己的总量和并发额度。

### 4.3 AgentRun

```ts
interface AgentRun {
  id: string;
  jobId: string;
  rootRunId: string;
  parentRunId?: string;
  threadId: string;
  turnId: string;
  agentProfileId: string;
  status: AgentRunStatus;
  task: string;
  depth: number;
  childRunIds: string[];
  createdAt: string;
  completedAt?: string;
  result?: AgentRunResult;
}
```

### 4.4 共享数据板

共享不是把每个 Agent 的完整上下文合并，而是共享经过筛选的 Job 数据：

```ts
interface SharedBoardEntry {
  id: string;
  jobId: string;
  producerRunId: string;
  kind:
    | "fact"
    | "artifact"
    | "source"
    | "decision"
    | "test_result"
    | "file_claim"
    | "warning";
  title: string;
  summary: string;
  payload?: unknown;
  confidence?: "unverified" | "supported" | "confirmed";
  visibility: "job" | "parent_only";
  createdAt: string;
  supersedesId?: string;
}
```

允许共享：

- 已确认事实和来源；
- 代码路径、符号和文件索引；
- 测试结果；
- 生成的文档或产物位置；
- 决策、风险和待办；
- 文件写入占用状态；
- 子 Agent的精炼总结。

禁止直接共享：

- 隐藏思维链；
- 完整模型上下文；
- 未过滤的 Tool 日志；
- 密钥、Token、环境变量和认证数据；
- 没有标记可信度的临时猜测。

每个子 Agent启动时只注入：父任务、自己的限定子任务、Job 约束、共享数据板相关条目和可用工具，而不是复制主对话的全部噪声。

### 4.5 Return Outbox

```ts
interface AgentReturn {
  id: string;
  jobId: string;
  rootRunId: string;
  parentRunId: string;
  childRunId: string;
  parentTurnId: string;
  sequence: number;
  status: "ready" | "delivering" | "consumed" | "failed";
  result: AgentRunResult;
  boardEntryIds: string[];
  attempts: number;
  createdAt: string;
  consumedAt?: string;
}
```

receipt 只能在父 Agent成功消费 continuation 后提交。

## 5. 完整运行流程

```text
用户发送任务
  → 创建独立 Job 和根 AgentRun
  → 加载团队配置
  → 首脑 Agent判断是否需要委派
  → 创建 1–10 个子 AgentRun
  → Scheduler 按全局/Job 并发额度运行
  → 子 Agent读取共享数据板相关条目
  → 子 Agent独立搜索、分析、执行或测试
  → 子 Agent写入结构化成果
  → 创建 AgentReturn(status=ready)
  → 任一子 Task 完成即持久化 Evidence 和 Return
  → Runtime 立即验收该节点并重新计算 ready 集合
  → join 节点只等待自己的硬依赖，不等待整个批次
  → Runtime 按父子边 sequence 投递 Return
  → 父 Agent自动续跑并汇总
  → continuation 成功后 Return=consumed
  → 输出最终结果
```

采用事件驱动的“先完成先处理”：任一子 Task 到达可动作终态便立即进入独立验收，通过后关闭节点并解锁下游；其他兄弟继续运行。需要汇合的父节点或 join Task 只等待自己声明的硬依赖。这样既保留依赖顺序，又不会让快任务被无关慢任务阻塞。

## 6. 首脑 Agent 的职责与规则

首脑 Agent必须做到：

1. 判断任务是否值得委派，简单任务直接完成。
2. 把任务拆成互相独立、范围明确的子任务。
3. 选择合适的 Agent Profile、模型和推理强度。
4. 避免两个写 Agent同时修改相同文件。
5. 跟踪子 Agent状态，必要时追加指令、停止或重试。
6. 读取 Return 和共享数据板，解决结论冲突。
7. 自动输出最终回答，不询问用户是否继续。

建议内置角色：

| 角色 | 默认能力 | 默认权限 |
|---|---|---|
| 首脑 Agent | 拆解、分派、汇总、冲突处理 | 继承当前 Job |
| 排查 Agent | 读代码、日志、状态，定位根因 | 只读 |
| 资料 Agent | 搜索官方资料、整理引用 | 只读 |
| 编程 Agent | 实现限定代码切片 | 工作区写入 |
| 测试 Agent | 测试、浏览器验收、回归 | 默认只读；测试产物例外 |
| 审查 Agent | 检查风险、回归和边界 | 只读 |

## 7. 防止重复造轮子的共享策略

### 7.1 任务去重

首脑分派前对 `taskFingerprint` 去重：目标、范围、关键输入相同的子任务不重复创建。

### 7.2 成果复用

新子 Agent启动前检索共享数据板：

- 已存在 confirmed 事实：直接引用；
- 已有文件索引：不再重复扫描；
- 已有官方来源：不再重复搜索；
- 已有通过的测试：仅在相关代码变化后重跑；
- 已有失败证据：从失败点继续。

### 7.3 写入租约

默认采用“多读一写”：

```text
多个排查/资料/测试 Agent → 可并行只读
一个编程 Agent             → 获得目标文件写入租约
其他写 Agent               → 不重叠文件则并行，重叠则排队
```

共享数据板记录 `file_claim`，包含文件、持有者、状态和过期时间。首脑负责解决冲突。

### 7.4 结论冲突

同一事实出现冲突时不覆盖旧条目，而是：

- 新条目标记 `supersedesId`；
- 首脑或审查 Agent对证据做裁决；
- 被采纳结论标为 `confirmed`；
- 最终回答只使用 confirmed 或明确标注不确定性的 supported 条目。

## 8. Chat 级 Agent 下拉控制器

入口与作用范围：

- 控制器与模型、推理选择器处于同一层级；
- 点击当前 Chat 的“Agent”按钮展开下拉面板；
- 配置只保存到当前 Chat，发送时冻结为当前 Job 快照；
- 首脑准备创建超过当前授权额度的子 Agent时，仅提示调整额度，不逐个询问。

推荐界面：

```text
┌─────────────────────────────────────────┐
│ Agent 协作                              │
│                                         │
│ 协作模式                                │
│ ○ 关闭  ● 自动编排  ○ 手动团队          │
│                                         │
│ 最多子 Agent       [－] 10 [＋]          │
│ 同时运行           [－]  4 [＋]          │
│ 最大树深度         [－]  3 [＋]          │
│                                         │
│ 可用角色                                │
│ ☑ 排查  ☑ 资料  ☑ 编程  ☑ 测试  ☑ 审查 │
│                                         │
│ 子 Agent 权限                           │
│ ● 最小权限，写入角色单独授权            │
│ ○ 全部继承当前任务权限                  │
│                                         │
│ ☑ 使用 Job 共享数据板                   │
│ ☑ 完成后独立验收                        │
│                                         │
│ [角色与模型…]              [管理团队…]   │
└─────────────────────────────────────────┘
```

产品规则：

- 默认最多 10 个子 Agent；第一版用户选择范围为 1–10。
- 默认并发 4，不能大于子 Agent上限。
- 选择“手动”时，用户可勾选角色；首脑仍负责具体任务分派。
- 选择“自动”时，首脑在授权角色和额度内自行选择。
- 保存为当前 Chat 默认配置；发送时冻结为 Job 快照，运行中修改默认只影响下一个 Job。
- 不为每次 spawn 弹窗，避免打断自动执行。
- 涉及具体敏感 Tool 的权限仍由现有 PermissionGate 处理。
- 紧凑态显示 `Agent：关闭`、`Agent：自动 4/10` 或 `Agent：手动 3 人`；运行时显示运行/排队数。

## 9. Agent 执行树 UI

```text
Agent 执行树                         3/10

● 首脑 Agent       正在汇总
├─ ● 排查 Agent     已返回
│  └─ ● 审查 Agent  已返回
├─ ● 资料 Agent     已返回
├─ ● 编程 Agent     运行中
└─ ○ 测试 Agent     等待编程结果

当前运行 1 · 已完成 3 · 排队 1
```

交互：

- 点击节点：展开任务摘要、关键产物、使用模型和运行时间。
- “查看线程”：打开该子 Agent独立执行记录。
- “追加指令”：首脑或用户给运行中的子 Agent补充方向。
- “停止”：只停止该节点及其后代。
- “重试”：创建同任务的新 attempt，保留旧失败记录。
- 树默认显示当前 Job；历史 Job放在独立折叠区。
- Return 状态显示为“已返回 / 正在汇总 / 已消费 / 返回重试中”。

## 10. 分阶段施工计划

### 阶段 0：锁定协议与迁移基线

目标：先固定 Job、团队配置、共享数据板和 Return 数据合同。

涉及文件：

- `src/agents/agent-run.ts`
- 新增 `src/agents/agent-job.ts`
- 新增 `src/agents/agent-team-config.ts`
- 新增 `src/agents/shared-board.ts`
- 新增 `src/agents/agent-return.ts`
- `src/runtime/json-file-runtime-persistence.ts`

验证：类型检查、旧 v2 快照兼容加载、新快照 round-trip。

回滚点：只新增类型和兼容读取，不改变运行行为。

### 阶段 1：让主 Agent Profile 真正生效

目标：用户选择的 orchestrator 真正进入主 Turn。

改造：

- Desktop `runTurn` 传递或由 App Server按 threadId读取 `agentProfileId`；
- Handler 使用 AgentRegistry 解析 Profile；
- AgentLoop 接收 Profile instructions、Tool/Skill 白名单；
- 明确用户模型与 Profile 默认模型优先级。

涉及文件：

- `src/electron/desktop-controller.ts`
- `src/electron/app-server-client.ts`
- `src/app-server/handlers.ts`
- `src/app-server/main.ts`
- `src/agent/agent-loop.ts`
- `src/agents/agent-profile.ts`

验证：捕获真实请求，断言 orchestrator instructions 已注入；非 orchestrator Profile 行为同步变化。

回滚点：可恢复默认 Agent instructions。

### 阶段 2：建立 Job 隔离和多 Chat 后台运行

目标：每个 Turn 创建独立 Job，所有父子节点绑定同一 `jobId/rootRunId`。

改造：

- 创建 AgentJobStore；
- Scheduler 所有操作显式携带 jobId；
- AgentRunStore 增加按 Job 查询；
- 取消、超时、排队、事件按 Job 路由；
- 切换 Chat 不影响后台 Job。

涉及文件：

- `src/agents/agent-run-store.ts`
- `src/agents/multi-agent-scheduler.ts`
- 新增 `src/agents/agent-job-store.ts`
- `src/app-server/handlers.ts`
- `src/electron/desktop-controller.ts`

验证：同时启动 3 个 Chat，切换、取消其中一个，另外两个继续且结果不串线。

回滚点：保留 threadId 兼容查询，Job 字段先双写。

### 阶段 3：实现团队配置和默认 10 个预算

目标：把用户授权的子 Agent总数、并发、深度和角色落实到 Scheduler。

改造：

- `maxSubagents` 默认 10，按整棵 Job 树计数；
- `maxConcurrent` 默认 4；
- `maxDepth` 默认 3；
- 超额任务排队或拒绝并返回结构化原因；
- 多 Job公平调度，避免一个 Job占满全局并发池。

涉及文件：

- `src/agents/multi-agent-scheduler.ts`
- `src/agents/agent-run-store.ts`
- `src/runtime/json-file-runtime-persistence.ts`
- `src/app-server/handlers.ts`

验证：10 个预算、11 个拒绝、并发 4、深度 3、多 Job公平性。

回滚点：配置关闭时退回单 Agent。

### 阶段 4：实现共享数据板

目标：子 Agent可以复用 Job 内的确认成果，但不共享完整上下文。

改造：

- SharedBoardStore 的读、写、查询、可信度和 supersede；
- 新增受控内部 Tool：`read_shared_board`、`publish_shared_result`；
- 子 Agent启动时由 Context Builder 注入相关条目摘要；
- 实现 task fingerprint 去重；
- 实现 file claim 写入租约。

涉及文件：

- 新增 `src/agents/shared-board-store.ts`
- 新增 `src/tools/shared-board-tools.ts`
- `src/runtime/context-builder.ts`
- `src/tools/tool-registry.ts`
- `src/app-server/main.ts`

验证：第二个 Agent复用第一个 Agent的来源/文件索引；敏感字段被拒绝；重叠写入被排队。

回滚点：关闭 `shareBoard` 后恢复独立子上下文。

### 阶段 4A：引入 Task DAG 与 Evidence 验收门

目标：保留父子 Agent 归属树，同时让 Runtime 按真实依赖图调度，并且只凭可验证证据关闭任务。

改造：

- 新增 `AgentTask`，把稳定任务合同与一次性 `AgentRun` 分离；
- 新增 `AgentTaskEdge`，支持 `depends_on/blocks/produces/validates`；
- 创建边时执行环检测，Scheduler 只派发 hard dependency 已满足的 ready Task；
- 任一 Task 完成即进入 Review，不等待整批兄弟节点；
- 新增 `AgentEvidence`，记录来源、产物、diff、测试、截图和 Review；
- P0–P2 问题回原 Task 返工，保留旧 Run 和旧 Evidence；
- 归属树继续承担 UI、取消和 Return 路由，DAG 承担 fork/join 和运行顺序。

涉及文件：

- 新增 `src/agents/agent-task.ts`
- 新增 `src/agents/agent-task-store.ts`
- 新增 `src/agents/agent-task-graph.ts`
- 新增 `src/agents/agent-evidence-store.ts`
- `src/agents/multi-agent-scheduler.ts`
- `src/runtime/json-file-runtime-persistence.ts`

验证：依赖环拒绝、兄弟依赖、fork/join、先完成先验收、Review 返工、Evidence 追加写入和重启恢复。

回滚点：功能开关关闭时，保留单 Agent 与已有父子兼容路径，不读取 DAG 派发。

### 阶段 5：重构 Return 为 Outbox + Ack

目标：子结果绝不因超时或重启丢失，父 Agent只消费一次。

改造：

- 子完成后创建 `ready` Return；
- 移除 Scheduler 中过早的 `receiveReturn()`；
- Runtime Coordinator 投递并恢复父 Agent；
- 父 continuation 成功后再写 `consumed + receipt`；
- 瞬时失败重试，永久失败明确终态；
- 重启扫描 pending Return 并恢复。

涉及文件：

- 新增 `src/agents/agent-return-store.ts`
- 新增 `src/agents/agent-runtime-coordinator.ts`
- `src/agents/multi-agent-scheduler.ts`
- `src/tools/run-agent-tool.ts`
- `src/agent/agent-loop.ts`
- `src/runtime/json-file-runtime-persistence.ts`

验证：父 → 子 → 父、父恢复第一次失败后重试、重启窗口、重复 Return 去重。

回滚点：保留旧 snapshot receipt 兼容读取，不再用旧语义写新 receipt。

### 阶段 6：实现父子控制能力

目标：支持查看、追加指令、等待、停止、重试和关闭子线程。

建议内部能力：

```text
spawn_agent
send_input
wait_agent
stop_agent
retry_agent
close_agent
```

第一版可以保留 `run_agent` 作为兼容入口，内部映射到 `spawn + wait + return`。

涉及文件：

- `src/tools/run-agent-tool.ts`
- 新增 `src/tools/agent-control-tools.ts`
- `src/agents/multi-agent-scheduler.ts`
- `src/agent/events.ts`

验证：追加指令只到目标子 Agent；停止节点级联后代但不影响兄弟和其他 Job。

回滚点：UI 暂时隐藏高级控制时，自动编排仍可运行。

### 阶段 7：实现 Chat 级 Agent 下拉控制器

目标：在模型选择器旁，让用户为当前 Chat 配置 1–10 个子 Agent预算、并发、角色、模型路由、调度和权限模式。

涉及文件：

- `src/electron/desktop-types.ts`
- `src/electron/preload.cjs`
- `src/electron/main.cjs`
- `src/electron/desktop-controller.ts`
- `src/electron/renderer/App.tsx`
- `src/electron/renderer/styles.css`

验证：关闭/自动/手动状态、默认值、输入边界、按 Chat 持久化、Job 快照、角色模型和权限继承。

回滚点：控制器关闭时退化为单 Agent；多 Agent 安全默认值为 `10/4/3/least_privilege`。

### 阶段 8：重做当前 Job 的树形 UI

目标：只展示当前 Job 根节点及后代，子 Agent树形挂在父节点下。

改造：

- “Agent 协作树”更名为“Agent 执行树”；
- 按 `currentJobId/rootRunId` 查询；
- 历史 Job独立折叠；
- 显示 `已用/上限`、运行、完成、排队统计；
- 默认展示父子归属树，节点详情可展开依赖图和 Evidence；
- 支持把整棵执行树压缩为一行运行摘要；
- 节点支持查看线程、追加指令、停止、重试；
- Return 生命周期可视化。

涉及文件：

- `src/electron/renderer/App.tsx`
- `src/electron/renderer/desktop-reducer.ts`
- `src/electron/renderer/styles.css`
- `src/electron/desktop-controller.ts`
- `src/electron/desktop-types.ts`

验证：0 子 Agent、10 子 Agent、3 层嵌套、失败/重试、窄屏和折叠展示。

回滚点：旧树组件保留到新树快照测试通过。

### 阶段 8A：重做历史 Chat 侧栏管理

目标：对齐 Codex 式历史侧栏，支持整体收缩、时间分组折叠、重命名、单项删除和分组一键删除。

界面草图：

```text
历史记录                              [‹]

▼ 今天                               […]
  当前任务标题                        […]
  修复模型列表                        […]

▼ 昨天                               […]
  Multi-Agent 根因排查                […]

▶ 历史                               […]

单项 […]  → 重命名 / 删除
分组 […]  → 删除今天 / 删除昨天 / 删除全部历史记录
```

交互与数据规则：

- 整体侧栏可收缩；今天、昨天、历史三个分组可分别折叠；状态作为 UI 偏好持久化；
- 分组按本机时区与 `lastActivityAt` 计算，空分组隐藏，历史默认折叠并虚拟加载；
- 重命名使用行内输入，`Enter` 保存、`Esc` 取消，空名称拒绝；
- 单项删除和分组删除均采用软删除，UI 立即移除，回收站保留 7 天；
- 分组删除只做一次汇总确认，不逐条弹窗；确认内容显示记录数和运行中 Job 数量；
- 删除运行中的 Chat 会取消该 Chat 当前 Job 及其子 Agent，但不影响其他 Chat；
- 删除当前 Chat 后进入未持久化空白草稿，不自动创建新记录；
- 分组删除在用户确认时冻结目标 Chat id 列表，并使用 `batchDeleteId` 幂等执行，避免跨日、刷新和中断导致越界删除；
- 回收站恢复必须恢复 Chat、消息、历史 Job 树与原有标题，时间分组按恢复后的 `lastActivityAt` 重新计算。

建议接口：

```text
thread.rename(threadId, title)
thread.softDelete(threadId)
thread.batchSoftDelete(threadIds, batchDeleteId)
thread.restore(threadId)
thread.listTrash()
preferences.updateHistorySidebar(state)
```

涉及文件：

- `src/electron/desktop-types.ts`
- `src/electron/preload.cjs`
- `src/electron/main.cjs`
- `src/electron/desktop-controller.ts`
- `src/electron/renderer/App.tsx`
- `src/electron/renderer/desktop-reducer.ts`
- `src/electron/renderer/styles.css`
- `src/runtime/json-file-runtime-persistence.ts`

验证：整体收缩、三个分组折叠、跨日归组、重命名、单项删除、三个分组批量删除、运行中删除隔离、删除当前 Chat 不创建空记录、7 天内恢复和批量中断幂等。

回滚点：保留只读历史列表入口；关闭批量能力时仍可单项重命名和软删除。

### 阶段 9：超时、权限和资源治理

目标：复杂父子任务长期稳定运行。

改造：

- Provider、根 Agent、子 Agent、父恢复和 Job 总 deadline 分离；
- 父等待子 Agent时暂停活跃执行预算；
- 子 Agent继承父权限或按团队配置降为只读；
- Provider timeout、child failed、return delivery failed、parent resume failed 分类展示；
- 限制共享数据板大小并支持摘要压缩。

验证：45 秒搜索超时正确分类；父等待不耗尽恢复预算；权限弹窗显示具体 Agent。

回滚点：所有新策略有默认配置并可关闭。

### 阶段 10：真实闭环验收

目标：证明项目不是“有树 UI 的单 Agent”，而是真正可恢复的父子 Agent Runtime。

自动化：

- 类型检查；
- 全量单元测试；
- Electron 构建；
- 3 Chat × 每 Chat 10 子 Agent调度压力测试；
- 父 → 多子 → 父真实脚本化集成测试；
- 重启、取消、重试、重复 Return 和跨 Job 隔离测试。

页面验收：

1. 打开 Chat A，配置 10/4/3，发出可拆分任务。
2. 确认树中出现首脑和多个子节点。
3. 子节点运行时切换 Chat B 并发送另一任务。
4. 返回 Chat A，确认仍在后台运行。
5. 打开子 Agent详情，查看其独立线程和共享成果。
6. 停止一个子节点，确认兄弟节点和 Chat B 不受影响。
7. 等待子节点返回，确认首脑自动汇总，不询问是否继续。
8. 重启应用，确认 pending Return 可恢复且不重复消费。

## 11. 测试矩阵

| 场景 | 必须结果 |
|---|---|
| 简单任务 | 首脑直接完成，不为用满额度而创建子 Agent |
| 10 个独立子任务 | 最多创建 10 个，同时运行不超过 4 个 |
| 第 11 个子任务 | 结构化拒绝或等待首脑复用现有 Agent，不越权创建 |
| 子 Agent再委派 | 深度和全树总量同时受控 |
| 多 Chat 并行 | 上下文、Return、取消和 UI 不串线 |
| 共享事实 | 后启动 Agent可读取并引用，不重复搜索 |
| 冲突事实 | 不静默覆盖，由首脑裁决 |
| 重叠写文件 | 一个获得租约，另一个排队 |
| 子 Agent失败 | 父收到结构化失败并继续处理 |
| 父恢复超时 | Return 保留 ready，可自动重试 |
| 重启恢复 | Return 不丢失且只消费一次 |
| 用户停止子节点 | 只影响该节点及后代 |
| 用户取消 Job | 该 Job 全部后代终止，其他 Chat继续 |
| 历史运行 | 不混入当前 Agent 执行树 |
| 权限请求 | 显示请求权限的具体 Agent和 Tool |
| 历史侧栏收缩 | 整体宽侧栏变为窄图标栏，展开状态重启后恢复 |
| 单个 Chat 重命名 | 行内保存并持久化，不中断正在运行的 Job |
| 删除当前 Chat | 确认后只停止该 Job，进入空白草稿且不创建空历史 |
| 分组一键删除 | 今天、昨天、历史各自只删除确认快照中的目标 Chat |
| 批量删除中断 | 相同 `batchDeleteId` 恢复执行，不重复取消或跨组删除 |
| 回收站恢复 | 7 天内恢复 Chat、消息和 Job 树，按活动时间重新归组 |

## 12. 推荐施工优先级

不能直接从控制器和树 UI 开始。推荐顺序：

```text
P0：阶段 0–2
数据协议 → 主 Profile 生效 → Job 隔离

P1：阶段 3–5
10 人预算 → Task DAG/Evidence → 共享数据板 → Return Outbox/Ack

P2：阶段 6–8
父子控制 → Chat 级下拉控制器 → 归属树/依赖图 UI → 历史侧栏管理

P3：阶段 9–10
超时/权限治理 → 完整压力与恢复验收
```

完成 P1 后，核心父子协作能力才算成立；完成 P2 后，用户才能完整操作；完成 P3 后，才能宣布可作为稳定的多 Agent项目使用。

## 13. 预计修改范围

主要会涉及：

- `src/agents/`：Job、AgentRun、Scheduler、SharedBoard、Return、Coordinator；
- `src/agent/`：AgentLoop、事件、父恢复；
- `src/tools/`：Agent 控制和共享数据 Tool；
- `src/runtime/`：上下文注入、持久化和恢复；
- `src/app-server/`：Job/Profile/团队配置 RPC；
- `src/electron/`：协议、Controller、权限和 preload；
- `src/electron/renderer/`：Chat 级 Agent 下拉控制器、执行树、依赖详情和历史运行；
- `tests/`：单元、集成、持久化、Electron UI 和压力测试。

不应默认修改：

- 环境变量和密钥；
- 用户本机认证配置；
- 无关业务模块；
- Git 分支、提交或远端状态。

## 14. 最终完成定义

只有以下全部通过，才能宣布施工完成：

- 多 Chat 可以真正后台并行且互不阻塞。
- 每个 Job 只有一棵根 Agent执行树。
- 用户可配置最多 10 个子 Agent、并发、深度和角色。
- 子 Agent通过共享数据板复用成果，不复制完整上下文。
- 所有父子关系和 Return 都经过 Job 归属校验。
- Return 使用持久化 Outbox + Ack，支持失败重试和重启恢复。
- 调度使用无环依赖图，任一 ready Task 完成后立即验收并解锁下游。
- Task 只有在 Evidence 覆盖验收条件且独立 Review 通过后才能完成。
- 子 Agent返回后首脑自动续跑，不询问用户是否继续。
- 用户可查看、引导、停止和重试子 Agent。
- 树 UI 只显示当前 Job，历史运行不伪装成子 Agent。
- 历史侧栏可整体收缩，今天/昨天/历史可折叠，并支持 Chat 重命名和单项删除。
- 每个时间分组右侧有 `…`，可一次确认后批量软删除对应记录，且不误伤其他分组或其他 Chat 的运行任务。
- 权限、写入租约、超时和并发限制均有自动化测试。
- 真实页面完成“父 → 多子 → 父最终回答”验收。

## 15. 本计划边界

- 本轮只形成实施计划，没有修改任何业务代码。
- 没有执行 Git 操作。
- 没有修改依赖、配置、密钥或运行状态。
- 下一步需要用户确认施工范围后，才能从阶段 0 开始实施。
