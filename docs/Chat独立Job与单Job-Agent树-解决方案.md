# Chat 独立 Job 与单 Job Agent 树：解决方案

日期：2026-08-12  
状态：方案已对齐，等待确认后施工。  
关联文档：[问题清单](./Chat独立Job与单Job-Agent树-问题清单.md) · [根因分析](./Chat独立Job与单Job-Agent树-根因分析.md) · [总排查记录](./Multi-Agent-run_return根因排查与修复方案-2026-08-12.md)

## 1. 目标架构

```text
Runtime
├─ Job A / Chat A
│  └─ 根 Agent A
│     ├─ 子 Agent A1
│     │  └─ 子 Agent A1.1
│     └─ 子 Agent A2
└─ Job B / Chat B
   └─ 根 Agent B
      └─ 子 Agent B1
```

规则：

- Chat 是独立 Job，可以并行运行和随时切换。
- 每个 Job 只有一棵当前 Agent 执行树。
- 子 Agent必须属于当前 Job，并挂在直接父节点下面。
- 不同 Job 之间没有父子关系、上下文共享或 Return 传递。
- 全局只共享并发上限、模型连接等基础资源。

## 2. 建立明确的 Job 标识

建议把当前 Turn 的根运行定义为一个 Job，并在所有 Agent 节点和 Return 中携带：

```ts
interface AgentRun {
  id: string;
  jobId: string;
  rootRunId: string;
  parentRunId?: string;
  threadId: string;
  turnId: string;
  // ...
}
```

约束：

- 根节点：`id === rootRunId`，没有 `parentRunId`；
- 子节点：`jobId`、`rootRunId` 必须与父节点一致；
- Scheduler 创建子节点前必须校验父节点属于同一 Job；
- Return 投递前再次校验 `jobId + parentRunId`，防止跨 Chat 串线。

## 3. 每个 Chat 使用独立执行上下文

逻辑上每个 Chat/Job 必须拥有独立的：

- 上下文与消息历史；
- 根 Agent执行状态；
- AbortController / 取消链；
- 父子 Agent树；
- Return Outbox；
- 超时和重试状态；
- RuntimeSession 展示状态。

实现上可以共享同一个 AgentLoop 类和 Provider 实例，但不能共享 Job 的可变执行状态。切换 Chat 只改变当前视图，不能取消后台 Job。

## 4. 打通主 Agent Profile

主 Turn 启动时：

1. 从线程配置读取 `agentProfileId`；
2. 使用 AgentRegistry 校验 Profile；
3. 将 `profile.instructions` 注入主 AgentLoop；
4. 应用 Profile 的 allowedTools、allowedSkills、默认模型和推理强度；
5. 保留用户显式模型选择与 Profile 默认值的清晰优先级。

orchestrator 指令必须明确：

- 任务简单时可由根 Agent直接完成；
- 可拆分任务时使用 `run_agent`；
- 多个独立子任务可以并行委派；
- 子 Agent返回后自动继续汇总；
- 不询问用户“是否继续”；
- 子 Agent失败时由父 Agent决定重试、降级或利用已有结果完成回答。

## 5. 使用树形 AgentRun 数据模型

查询当前执行树时，不再使用“该 Chat 的全部历史运行”，而是：

```text
activeThreadId
  → currentTurnId / currentJobId
  → rootRunId
  → 递归查询所有 childRunIds
```

Renderer 按 `parentRunId` 递归展示：

```text
● 主 Agent · 自动续跑
├─ ● 排查 Agent · 已返回
│  └─ ● 验证 Agent · 已返回
└─ ● 测试 Agent · 运行中
```

当前统计应显示：

```text
1 个根 Agent · 3 个子 Agent · 1 个运行中
```

历史 Turn 放到独立的折叠区，例如“历史运行 2 次”，不得混进当前树。

## 6. 将 `run_return` 改为 Outbox + Ack

新增持久化 Return 实体：

```ts
interface AgentReturn {
  id: string;
  jobId: string;
  rootRunId: string;
  childRunId: string;
  parentRunId: string;
  parentTurnId: string;
  sequence: number;
  status: "ready" | "delivering" | "consumed" | "failed";
  payload: AgentRunResult;
  attempts: number;
  createdAt: string;
  consumedAt?: string;
}
```

流程：

```text
子 Agent完成
  → 写入 Return(status=ready)
  → 通知当前 Job 的父 Agent有结果待处理
  → 父 Agent进入 resuming
  → Runtime 投递 Return
  → 父模型成功完成 continuation
  → Return 标为 consumed
  → 最后写入幂等 receipt
```

父 continuation 失败时：

- 瞬时错误：恢复为 `ready`，自动重试；
- 永久错误：标为 `failed`，父节点进入 `failed_after_return`；
- 进程退出：重启后扫描 `ready/delivering` 并幂等重投；
- 重复 Return：使用 `jobId + childRunId` 去重。

## 7. 多个子 Agent 的汇总规则

父模型一次创建多个子 Agent时允许真正并行，但 Return 输入必须确定性排序：

1. 优先使用父模型原始 function call 顺序；
2. 若缺少原始顺序，使用持久化 sequence；
3. 不按网络完成先后随机拼接。

父节点可配置：

- `wait_all`：等待全部子节点终态后统一恢复；
- `resume_each`：每个 Return到达后增量恢复；

第一版建议使用 `wait_all`，状态更简单、结果更稳定。

## 8. 分离运行预算

建议区分：

- 单次 Provider 请求超时；
- 根 Agent活跃模型时间；
- 每个子 Agent独立执行时间；
- 父 Agent恢复请求时间；
- Job 总 deadline。

父 Agent等待子节点时暂停活跃执行计时。托管联网搜索超时时，应记录 `provider_timeout`，不能被展示成 `run_return` 或子 Agent失败。

## 9. 增加可观察事件

Runtime 建议增加：

```text
job/started
job/completed
agent/child_created
agent/return_ready
agent/return_delivering
agent/return_consumed
agent/return_retrying
agent/parent_resuming
agent/parent_resumed
agent/parent_failed_after_return
```

UI 对应显示安全状态，不暴露敏感错误详情。

## 10. 分阶段施工顺序

### 阶段 A：修正 UI 与查询口径

- 当前树只查询 currentJobId/rootRunId；
- 历史运行独立折叠；
- “协作树”改为“Agent 执行树”；
- 统计根 Agent、子 Agent和运行中数量。

### 阶段 B：打通主 Profile

- `turn/run` 解析 `agentProfileId`；
- 注入 orchestrator instructions；
- 应用 Tool/Skill 白名单；
- 验证简单任务不强制委派、可拆任务稳定委派。

### 阶段 C：补齐 Job 隔离字段

- 引入 jobId/rootRunId；
- 校验所有父子节点归属；
- 取消、超时、重试按 Job 隔离。

### 阶段 D：实现 Return Outbox

- 子完成后写 ready；
- 父消费后才 Ack；
- 支持幂等重投和重启恢复。

### 阶段 E：隔离预算与错误分类

- Provider、根 Agent、子 Agent和恢复分别计时；
- UI 区分联网超时、子失败、Return 投递失败和父恢复失败。

### 阶段 F：完整集成验收

- 多 Chat 并行；
- 单 Job 多层父子树；
- 父自动续跑；
- 重启恢复；
- 取消隔离；
- 重复 Return 去重。

## 11. 验收标准

1. Chat A 运行时可以创建或切换 Chat B，两个 Job 同时继续。
2. 取消 Chat A 不影响 Chat B。
3. 每个 Chat 的当前页面只显示自己的当前 Agent 树。
4. 子 Agent严格树形挂在直接父节点下面，支持至少三层深度。
5. 不存在跨 Job 的 `parentRunId` 或 Return。
6. 子 Agent返回后父 Agent自动继续，不向用户询问是否继续。
7. 父恢复失败后 Return 不丢失，可按策略自动重试。
8. 重启发生在子完成和父确认之间时，Return 可恢复且只消费一次。
9. `2 runs` 不再被用于表示 Agent 数；历史运行与当前子 Agent数量分开。
10. 联网搜索 45 秒超时被正确显示为 Provider 超时。
11. 多 Chat 共用全局并发上限，但上下文、状态、取消和结果互不干扰。
12. 完整父 → 子 → 父集成测试通过后，才能宣布 `run_return` 完成。

## 12. 本次未执行事项

- 未修改任何业务代码。
- 未变更配置、依赖或数据库。
- 未执行 Git 操作。
- 未启动施工或测试。
