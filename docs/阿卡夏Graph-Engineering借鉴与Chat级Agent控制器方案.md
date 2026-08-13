# 阿卡夏 Graph Engineering 借鉴与 Chat 级 Agent 控制器方案

日期：2026-08-12  
目标项目：`D:\练手\agent-learn`  
状态：线上研究与方案已完成，尚未修改业务代码

## 1. 线上事实源

本方案直接研究 GitHub 线上仓库，不依赖本机未完整检出的副本：

- 仓库：[lov-team/akasha-grimoire](https://github.com/lov-team/akasha-grimoire)
- 默认分支：`main`
- 本次核对提交：`7f1b2e547fcba642d5206cec4bbaeba5397599ad`
- 提交时间：2026-08-12T07:41:45Z
- 重点原文：
  - [`README.zh-CN.md`](https://github.com/lov-team/akasha-grimoire/blob/main/README.zh-CN.md)
  - [`agent-task-supervisor/SKILL.md`](https://github.com/lov-team/akasha-grimoire/blob/main/skills/agent-task-supervisor/SKILL.md)
  - [`production-model-routing.md`](https://github.com/lov-team/akasha-grimoire/blob/main/skills/agent-task-supervisor/references/production-model-routing.md)
  - [`github-issue-pipeline/SKILL.md`](https://github.com/lov-team/akasha-grimoire/blob/main/skills/github-issue-pipeline/SKILL.md)
  - [`github-state-contract.md`](https://github.com/lov-team/akasha-grimoire/blob/main/skills/github-issue-pipeline/references/github-state-contract.md)
  - [`content-pipeline/SKILL.md`](https://github.com/lov-team/akasha-grimoire/blob/main/skills/content-pipeline/SKILL.md)
  - [`package-contract.md`](https://github.com/lov-team/akasha-grimoire/blob/main/skills/content-pipeline/references/package-contract.md)
  - [`video-production/SKILL.md`](https://github.com/lov-team/akasha-grimoire/blob/main/skills/video-production/SKILL.md)
  - [`production-contract.md`](https://github.com/lov-team/akasha-grimoire/blob/main/skills/video-production/references/production-contract.md)

仓库许可证是“Apache License 2.0 + 附加商业条件”，不是未经修改的 Apache-2.0。本方案只借鉴架构思想和工程原则，不复制其 Skill 正文或实现文件。以后若直接复制、修改或分发仓库文件，必须单独核对许可证、NOTICE/署名、修改说明和商业支付使用条件。

## 2. 阿卡夏的核心设计

阿卡夏不是“多开几个聊天”，而是把协作组织成一张可恢复、可验收的工作图：

```text
Spec → Epic → Issue → Agent Task → Evidence
```

- `Spec`：根目标、边界、非目标、关键决策和总验收合同。
- `Epic`：可交付里程碑，对应任务子图。
- `Issue`：最小可执行节点，包含 owner、范围、依赖、输出和验证方式。
- `Agent Task`：某个 Issue 的一次执行实例，不是事实源。
- `Evidence`：diff、测试、产物、Review、远端状态等关闭节点的证据。

任务之间使用显式边：

- `depends_on`：当前节点必须等待目标节点完成。
- `blocks`：当前节点未完成会阻塞目标节点。
- `produces`：当前节点生产目标产物或数据。
- `validates`：当前节点独立验证目标节点。

只有硬依赖满足、写入范围不冲突、资源额度允许的节点才进入 `ready`。并行 worker 谁先完成就先验收谁，不让快任务等慢任务；worker 的自述不是完成证据，P0—P2 问题回到原 worker 返工。

内容和视频流水线进一步证明同一原则：先冻结合同，阶段门通过后才进入下游；每一阶段有稳定 ID、输入、输出、通过条件和可追溯产物；恢复时读取事实文件和最后状态，而不是重新依赖对话记忆。

## 3. 对当前 agent-learn 的映射

当前项目已有 `AgentProfile`、`run_agent`、`parentRunId`、全局并发、级联取消和基础树 UI，可以保留。但它仍属于“父 Agent 同步调用子 Tool”，不是完整 Graph Runtime：

| 当前实现 | 根因 | 需要补齐 |
|---|---|---|
| `run_agent()` 内等待 `execution.execute()` | 子任务绑在父 Tool 调用栈 | `spawn → event → return outbox → parent continuation` |
| Scheduler 内提前 `receiveReturn()` | “生成结果”被误当成“父已消费” | Return Outbox + Ack，父续跑成功后才 consumed |
| 只存 `parentRunId/childRunIds` | 不能表达兄弟依赖和 fork/join | 独立 `AgentTask` + `DependencyEdge` DAG |
| `maxChildrenPerRun` 按单父计数 | 递归可突破 Job 的 10 人上限 | `jobId` 级总预算、并发和深度联合约束 |
| `listForThread()` 汇入历史根 Turn | 历史 Job 与当前树无明确边界 | `jobId/rootRunId` 查询和历史 Job 折叠区 |
| orchestrator 仅作为保存的 Profile | 主 Turn 未真正注入 Profile 合同 | 主 Turn 创建时冻结实际 Profile/模型/权限 |
| 没有独立 Evidence | “子 Agent 说完成”即可返回 | Evidence Gate + Reviewer 节点 |
| 重启统一取消旧 Run | 没有失联/超时恢复合同 | lease、heartbeat、attempt、恢复状态机 |
| 无 Chat 级团队配置 | 所有 Chat 共用隐式默认值 | 模型选择器旁的 Agent 下拉控制器 |

结论：不推翻现有父子结构，而是在其下面增加 Job、Task Graph、Evidence 和 Return 协调层。

## 4. 双结构：用户看树，Runtime 跑图

归属树回答“谁向谁汇报”，用于 UI、权限继承、取消范围和 Return 路由：

```text
首脑 Agent
├─ 排查 Agent
│  └─ 审查 Agent
├─ 资料 Agent
├─ 编程 Agent
└─ 测试 Agent
```

依赖 DAG 回答“谁现在能运行”，用于调度、fork/join、阶段门和返工：

```text
排查 ──produces──▶ 根因
资料 ──produces──▶ 参考方案
根因 + 参考方案 ──depends_on──▶ 编程
编程 ──depends_on──▶ 测试
审查 ──validates──▶ 编程
测试 + 审查 ──depends_on──▶ 首脑最终汇总
```

同一 Task 在归属树中只有一个直接父节点，但在 DAG 中可以依赖多个节点，也可以被多个验证节点引用。界面默认展示树；展开“依赖关系”时再显示 DAG。

## 5. 核心数据合同

### 5.1 Chat 配置与 Job 冻结快照

```ts
interface ThreadAgentConfig {
  version: 1;
  mode: "off" | "auto" | "manual";
  maxSubagents: number;          // 默认 10，整个 Job 树总数
  maxConcurrent: number;         // 默认 4
  maxDepth: number;              // 默认 3，根节点为 0
  allowedProfiles: Array<
    "investigator" | "researcher" | "coder" | "tester" | "reviewer"
  >;
  scheduling: "dependency_graph" | "independent_only";
  permissionMode: "least_privilege" | "inherit_chat";
  shareBoard: boolean;
  independentReview: boolean;
  modelRouting: "inherit_chat" | "role_based";
  roleModels?: Partial<Record<string, {
    model: string;
    reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  }>>;
}

interface AgentJob {
  id: string;
  threadId: string;
  rootTurnId: string;
  rootRunId: string;
  configSnapshot: ThreadAgentConfig;
  status:
    | "queued" | "planning" | "running" | "waiting_dependencies"
    | "waiting_returns" | "reviewing" | "resuming"
    | "completed" | "partial" | "failed" | "cancelled";
  createdAt: string;
  completedAt?: string;
}
```

下拉框保存当前 Chat 的默认配置；发送消息时复制成 `configSnapshot`。运行中修改默认只影响下一个 Job，避免中途改变并发、角色或权限造成状态漂移。调整当前 Job 必须走“管理当前运行”并记录事件。

### 5.2 AgentTask：合同与执行分离

```ts
interface AgentTask {
  id: string;
  jobId: string;
  rootRunId: string;
  ownerRunId: string;
  parentTaskId?: string;
  profileId: string;
  title: string;
  objective: string;
  scope: {
    allowedPaths: string[];
    deniedPaths: string[];
    nonGoals: string[];
  };
  requiredOutputs: string[];
  acceptanceCriteria: string[];
  dependencyIds: string[];
  fileClaims: string[];
  attempt: number;
  maxAttempts: number;
  status:
    | "draft" | "blocked" | "ready" | "claimed" | "running"
    | "awaiting_evidence" | "reviewing" | "rework"
    | "completed" | "failed" | "cancelled" | "lost";
  createdAt: string;
  updatedAt: string;
}
```

`AgentTask` 是任务合同，`AgentRun` 是某次模型执行。一个 Task 重试或返工可以对应多个 Run，但不能覆盖旧 Run 和旧证据。

### 5.3 依赖边

```ts
interface AgentTaskEdge {
  id: string;
  jobId: string;
  fromTaskId: string;
  toTaskId: string;
  type: "depends_on" | "blocks" | "produces" | "validates";
  hard: boolean;
  artifactKey?: string;
  createdAt: string;
}
```

创建或修改边必须做环检测；形成环则拒绝且保持原图不变。`ready` 至少要求：所有 hard dependency 已完成、所需 artifact 可读、没有冲突 file claim、Job/全局并发有额度、Task 未取消。

### 5.4 Evidence

```ts
interface AgentEvidence {
  id: string;
  jobId: string;
  taskId: string;
  runId: string;
  kind:
    | "summary" | "source" | "artifact" | "diff"
    | "test" | "screenshot" | "review" | "remote_state";
  uri?: string;
  digest?: string;
  summary: string;
  producer: "worker" | "runtime" | "reviewer";
  verdict: "unverified" | "supported" | "passed" | "failed";
  createdAt: string;
}
```

Evidence 追加写入。新结论不能静默覆盖旧结论，只能通过新的取代关系或 Review 声明。Task 只有在验收条件均有 Evidence 覆盖、独立 Review 通过且 P0—P2 为零时才能 `completed`。

### 5.5 Return Outbox + Ack

```ts
interface AgentReturnEnvelope {
  id: string;
  jobId: string;
  parentRunId: string;
  childRunId: string;
  taskId: string;
  sequence: number;
  status: "ready" | "delivering" | "consumed" | "failed";
  result: {
    status: "completed" | "failed" | "cancelled" | "timed_out";
    summary: string;
    evidenceIds: string[];
    boardEntryIds: string[];
  };
  idempotencyKey: string;
  attempts: number;
  nextAttemptAt?: string;
  createdAt: string;
  consumedAt?: string;
}
```

正确语义：

```text
子 Run 终态
  → 持久化 Evidence
  → 创建 Return(ready)
  → 事件唤醒父 Coordinator
  → 原子认领 Return(delivering)
  → 注入父 continuation
  → 父 continuation 持久化成功
  → Return(consumed) + receipt
```

父续跑失败时 Return 回到 `ready` 并退避重试；幂等键防止重复消费。该过程不向用户询问“是否继续”，只有产品方向、敏感权限或不可逆动作才向用户请求决策。

## 6. 调度、恢复和共享

首脑先形成 Task 合同和边，再交给 Runtime 做环检测、额度、权限、写冲突和 ready 判定：

```text
规划图 → 校验 → ready 集合 → 公平派发
  → 任一 Task 完成即 Review
  → 通过：关闭节点并重新计算 ready
  → 不通过：原 Task 进入 rework，回原角色/原上下文
  → 根验收节点全部关闭后首脑自动汇总
```

这替代旧方案的固定 `wait_all`。join 节点仍等待自己的全部依赖，但整个批次没有全局 barrier。

并发与恢复规则：

- Job 子 Agent 总预算默认 10，根 Agent 不计入；每 Job 默认并发 4，全局另有限额。
- Scheduler 使用 Job 轮转或加权公平队列，不能让单个 Chat 占满全局槽位。
- 只读 Task 可并行；写 Task 需要不重叠的 file claim。
- 相同 `taskFingerprint` 不重复创建，优先复用已完成 Evidence。
- `providerDeadline`、`taskDeadline`、`returnDeadline`、`jobDeadline` 分开。
- 每次 claim 带 lease，心跳续租；过期标 `lost`，释放槽位/文件占用并按次数重派。
- 重启扫描 `ready/delivering/claimed/running`；Return 可重投，无有效 lease 的 Run 恢复，不再一律取消整树。

共享的不是完整上下文和隐藏推理，而是 confirmed facts、来源、artifact 路径/哈希、decision、test result、warning、file claim、子 Agent 精炼结论及 Evidence 引用。禁止共享密钥、Token、Cookie、环境变量、完整 Tool 日志、完整模型上下文和隐藏思维链。

## 7. Chat 级 Agent 控制器 UI

控制器紧挨模型列表，每个 Chat 独立保存：

```text
┌──────────────────────────────────────────────────────────────┐
│ [模型：GPT-5.6 Sol ▾] [Agent：自动 4/10 ▾] [推理：High ▾]  │
└──────────────────────────────────────────────────────────────┘
```

下拉面板：

```text
┌──────────────────── Agent 协作 ─────────────────────┐
│ ○ 关闭（单 Agent）                                 │
│ ● 自动编排                                         │
│ ○ 手动团队                                         │
│                                                    │
│ 最多子 Agent                              10       │
│ 同时运行                                   4       │
│ 最大层级                                   3       │
│                                                    │
│ 角色                                               │
│ ☑ 排查   ☑ 资料   ☑ 编程   ☑ 测试   ☑ 审查       │
│                                                    │
│ 调度                                               │
│ ● 依赖图自动调度                                   │
│ ○ 仅并行互不依赖的任务                             │
│                                                    │
│ 权限                                               │
│ ● 最小权限：默认只读，写 Agent 单独申请            │
│ ○ 继承当前 Chat 权限                               │
│                                                    │
│ ☑ 使用共享数据板                                   │
│ ☑ 完成后独立验收                                   │
│                                                    │
│ [角色与模型…]                         [管理团队…]   │
└────────────────────────────────────────────────────┘
```

紧凑态：`Agent：关闭`、`Agent：自动 4/10`、`Agent：手动 3 人`；运行时显示 `Agent：运行 3 · 排队 2`。

交互规则：

1. 新 Chat 只创建草稿视图，首次发送才持久化，解决“一点新 Chat 就产生空会话”。
2. Chat A 运行时仍可新建、切换和发送 Chat B；后台 Job 按 `threadId/jobId` 路由。
3. 模型、Agent、推理控件同级；窄屏折叠为图标并保留状态摘要。
4. 单击 Agent 按钮快速切模式；“管理团队”进入详细设置，不为每次 spawn 弹窗。
5. 运行树放在当前 Job 下，可压缩为一行；历史 Job 放独立折叠区。

```text
展开：
▼ Agent 执行 · 5/10              运行 2 · 排队 1
  ● 首脑 Agent                   等待结果
  ├─ ✓ 排查 Agent                已验收
  ├─ ● 编程 Agent                运行中
  ├─ ○ 测试 Agent                等待“编程”
  └─ ● 资料 Agent                运行中

收缩：
▶ Agent 执行 · 2 运行 · 1 排队 · 1 已验收
```

节点详情展示任务合同、直接父节点、依赖、模型/推理档、权限、状态、Evidence 和 Return 状态；默认不展示隐藏思维链。

### 7.1 历史 Chat 侧栏

历史记录采用“整体可收缩 + 时间分组可折叠 + 单项菜单 + 分组菜单”的结构：

```text
┌────────────── 历史记录 ──────────────┐
│ [‹ 收起侧栏]                         │
│                                      │
│ ▼ 今天                           […] │
│   当前任务标题                    […] │
│   修复模型列表                    […] │
│                                      │
│ ▼ 昨天                           […] │
│   Multi-Agent 根因排查            […] │
│                                      │
│ ▶ 历史                           […] │
│                                      │
│ [搜索历史记录]                       │
└──────────────────────────────────────┘

侧栏收缩后：

┌────┐
│ [›]│
│ ＋ │
│ 搜 │
└────┘
```

分组固定为：

- `今天`：按本机时区当天最后活动的 Chat；
- `昨天`：本机时区前一天最后活动的 Chat；
- `历史`：早于昨天的 Chat，默认折叠，可继续按月份虚拟加载；
- 空分组不展示；时间跨日时按 `lastActivityAt` 自动重新归组。

单个 Chat 行为：

```text
Chat 标题 […]
            ├─ 重命名
            └─ 删除
```

- 双击标题或选择“重命名”进入行内编辑；`Enter` 保存，`Esc` 取消，空名称不允许保存。
- 删除后当前 Chat 立即从侧栏消失；若删除的是当前 Chat，界面进入未持久化的新 Chat 草稿，而不是自动新建数据库记录。
- 正在运行的 Chat 删除前，确认框必须明确“会停止该 Chat 的当前 Job 和全部子 Agent”；确认后只取消这个 Job，不影响其他 Chat。

时间分组右侧 `…`：

```text
今天 […]  →  删除今天的全部记录
昨天 […]  →  删除昨天的全部记录
历史 […]  →  删除全部历史记录
```

- 分组删除只弹出一次汇总确认，显示 Chat 数量、运行中 Job 数量及操作范围。
- 确认后作为一个批量操作执行，不能逐条重复弹窗。
- 删除采用软删除：UI 立即移除，底层进入回收站并保留 7 天；超过期限再清理。这样实现“一键删除”的体验，同时保留误删恢复能力。
- 批量删除使用稳定的 `batchDeleteId` 保证幂等；应用中断后可继续，不会出现删一半、重复取消或跨分组误删。
- 搜索结果中的删除仍按 Chat id 执行，不能按当前筛选文字扩大范围。

整体收缩状态、今天/昨天/历史各自的展开状态都属于客户端 UI 偏好，不随 Chat 切换重置；窗口重启后恢复。

## 8. 权限与接口

- 权限按 `Chat → Job 快照 → Agent Profile → 具体 Tool` 求交集，子 Agent 不能放大权限。
- 排查、资料、审查默认只读；编程可申请工作区写；测试只允许测试产物目录写。
- 弹窗显示具体 Chat、Job、Agent、任务和 Tool。
- 相同 Job 内低风险、明确范围的授权可复用；敏感目录、外部发送、生产写入和不可逆动作仍逐次确认。
- 权限拒绝产生结构化 Evidence，首脑自动降级或汇总，不询问“要不要继续”。

建议接口：

```text
thread.getAgentConfig(threadId)
thread.updateAgentConfig(threadId, config)
job.list(threadId) / job.get(jobId) / job.cancel(jobId)
job.updateRuntimeLimits(jobId, patch)
task.list(jobId) / task.get(taskId)
task.sendInput(taskId, message) / task.stop(taskId) / task.retry(taskId)
evidence.list(taskId)
graph.get(jobId)
```

第一版可继续使用现有 JSON persistence，但必须有 schema version、原子替换或 append-only 日志、启动迁移和损坏隔离测试。

## 9. 分阶段施工顺序

### P0：正确边界

1. 主 Agent Profile 真正进入主 Turn。
2. 建立 `AgentJob`，修复多 Chat 独立后台执行与 UI 切换。
3. 保存 `ThreadAgentConfig`，发送时冻结 Job 快照。
4. 修复点击新 Chat 立即创建空记录。

### P1：Graph Runtime

5. 引入 `AgentTask` 合同和 Task/Run 分离。
6. 引入依赖边、环检测、ready 计算和 Job 公平调度。
7. 把 `run_agent` 兼容入口重构为异步 `spawn + event`。
8. 改成先完成先验收；join 只等待自身依赖。

### P2：可靠 Return 与共享成果

9. 实现 Evidence Store 与独立 Review Gate。
10. 实现 Shared Board、task fingerprint 和 file claim。
11. 实现 Return Outbox + Ack、自动父 continuation 和幂等重投。
12. 实现 lease、失联重派、超时分类和重启恢复。

### P3：用户控制与可视化

13. 在模型选择器旁加入每 Chat Agent 下拉框。
14. 实现角色/模型、并发、深度、权限和调度设置。
15. 树显示归属，依赖面板显示 DAG；支持压缩展示。
16. 支持查看、追加指令、停止、重试和当前 Job 显式调额。
17. 历史侧栏支持整体收缩、今天/昨天/历史分组折叠、Chat 重命名与单项删除。
18. 每个时间分组右侧提供 `…` 和一次确认的分组一键删除；实现软删除、恢复期和批量幂等。

### P4：稳定性与发布门

19. 多 Job 公平性、压力、超时、权限、迁移和恢复测试。
20. 真实页面完成 3 Chat × 每 Chat 10 子 Agent 压力验收。
21. 完成父 → 多子 → Review/返工 → 父自动最终回答闭环。
22. 核对 Evidence、未验证项和恢复路径后再声明完成。

## 10. 必测矩阵

| 场景 | 必须结果 |
|---|---|
| Chat A 流式输出时新建 Chat B | 可立即新建、发送、切换，A 后台继续 |
| 一个 Chat 关闭 Agent | 退化为单 Agent，不创建 Task Graph |
| 第 11 个子 Agent | 结构化拒绝或复用，不突破 Job 总预算 |
| 依赖环 | 创建边失败，图保持原状态 |
| 两个写 Agent 文件重叠 | 后者等待或重新分片 |
| 子 Task 先完成 | 立即 Review 并解锁下游，不等待整批 |
| P1 Review 问题 | 回原 Task/原角色返工，旧证据保留 |
| 父 continuation 失败 | Return 回 ready 自动重试，不问用户继续 |
| Runtime 重启 | Return、Task、lease 可恢复且不重复执行 |
| 权限拒绝 | 只影响具体 Agent/Tool，其他任务继续 |
| 修改 Chat 配置 | 影响下一个 Job，当前快照不漂移 |
| 取消一个 Job | 只级联该 Job，其他 Chat 不受影响 |
| 重命名 Chat | 行内保存并持久化，运行中的 Job 不受影响 |
| 删除当前 Chat | 当前 Job 按确认结果停止，页面进入空白草稿且不产生空记录 |
| 删除“今天”分组 | 只处理确认时快照内的今天记录，不误删新产生或跨日移动的 Chat |
| 批量删除中断 | 使用相同批次幂等恢复，不重复取消、不留下半删除状态 |
| 恢复误删 Chat | 7 天内恢复标题、消息、Job 树和历史分组归属 |

## 11. 不应照搬的部分

- 不把 GitHub Issue/PR 作为桌面客户端唯一事实源；先用本地 Job/Task/Event Store，GitHub 只做可选适配器。
- 不要求每个普通聊天都建立 Spec/Epic；桌面端内部可压缩为 `Job → Task → Evidence`，大型任务再展开完整层级。
- 不原样搬固定文件轮询；实时 Runtime 应以事件总线为主、持久 Outbox 扫描兜底。
- 不默认自动 commit、push、合并或关闭远端 Issue，这些仍受用户授权和项目规则控制。
- 不复制阿卡夏 Skill 文案或模板，避免不必要的许可证耦合。

## 12. 最终建议

采用“Chat 独立 Job + 归属树 + 调度 DAG + Evidence Gate + Return Outbox/Ack”。父子树满足用户直觉和可视化；DAG、合同和证据保证多 Agent 真正并行、可恢复、可验收。Chat 级控制器紧挨模型选择器，默认 `自动 4/10`、最大深度 3、最小权限、共享数据板和独立验收开启。

本轮只完成线上研究和文档设计，没有修改 `.ts`、`.tsx`、`.css`、依赖、配置、密钥或 Git 状态。
