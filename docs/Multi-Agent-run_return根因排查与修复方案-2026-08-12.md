# Multi-Agent `run_return` 根因排查与修复方案

日期：2026-08-12  
范围：只排查 `run_agent → run_return → 父 Agent 恢复` 链路，不修改业务代码。  
结论状态：根因已定位，等待确认后分阶段施工。

## 0. 架构边界澄清

本文中的“父 Agent / 子 Agent”只描述**单个 Chat（单个 Job）内部**的执行关系，不表示不同 Chat 之间存在协作或父子关系。

正确模型是：

```text
Chat A / Job A（独立上下文、独立生命周期）
└─ 根 Agent
   ├─ 子 Agent A1
   │  └─ 子 Agent A1.1
   └─ 子 Agent A2

Chat B / Job B（与 Chat A 并行且彼此独立）
└─ 根 Agent
   └─ 子 Agent B1
```

必须遵守以下边界：

- 每个 Chat 是一个独立 Job，可以与其他 Chat 同时运行和切换。
- 每个 Job 拥有独立的根 AgentLoop、上下文、取消状态、超时、Return 队列和最终结果。
- `parentRunId` 只允许指向同一 Job 内的父节点。
- `run_return` 只允许从子节点返回给同一 Job 内的直接父节点。
- 不同 Chat 之间不共享上下文、父子关系或 Return，只共享全局并发额度等基础资源。
- UI 展示的是当前 Job 的“Agent 执行树”；子 Agent 必须树形挂在父 Agent 下方，历史 Job/Turn 不得混入当前树。

本次拆分文档：

- [问题清单](./Chat独立Job与单Job-Agent树-问题清单.md)
- [根因分析](./Chat独立Job与单Job-Agent树-根因分析.md)
- [解决方案](./Chat独立Job与单Job-Agent树-解决方案.md)

## 1. 用户可见现象

本次截图中的任务在完成规划和联网搜索后显示：

- `请求未能完成`
- `Agent 执行失败，请重试`
- Agent 协作树显示 `2 runs`
- 右侧显示 `当前 Turn · 失败 · 0 Agents`

这组信息容易被理解为“子 Agent 已经完成，但 `run_return` 没有让父 Agent 自动继续”。运行状态证明，本次失败实际没有进入子 Agent 和 `run_return` 链路。

## 2. 证据

### 2.1 本次失败准确落在 45 秒请求超时边界

持久化状态中，同一时间段的两个真实失败 Turn 分别耗时：

| Turn | 状态 | 耗时 |
|---|---|---:|
| `turn-58` | `failed` | 45,026 ms |
| `turn-60` | `failed` | 45,011 ms |

模型 Provider 的默认单次 HTTP 请求超时是 45,000 ms：

- `src/llm/openai-responses.ts`：`this.timeoutMs = options.timeoutMs ?? 45_000`

截图对应会话的 RuntimeSession 也只存在第 0 轮规划、推理摘要、文本增量和托管搜索活动，随后搜索活动失败，没有第 1 轮 Tool continuation。

因此，本次截图的直接失败点是：**首轮模型/托管搜索请求在 45 秒边界被中止**。

### 2.2 本次没有创建任何子 Agent

持久化的 AgentRun 结构如下：

- `turn-58`：只有根运行 `agent-run-3`，`childRunIds = []`
- `turn-60`：只有根运行 `agent-run-4`，`childRunIds = []`
- 全局 `returnReceipts = []`

如果模型调用过 `run_agent`，Scheduler 会先创建子 AgentRun，并把其 ID 写入根运行的 `childRunIds`；成功或失败返回时还会写入 return receipt。本次两类证据都不存在。

所以可以确认：**截图所示执行没有发生 `run_agent`，自然也没有发生 `run_return`。**

### 2.3 `2 runs` 是当前 Chat 的历史根 Turn 数，不是两个协作 Agent

界面把 `listAgentRuns(threadId)` 返回的全部历史运行直接交给协作树，并显示：

```text
runs.length + " runs"
```

本次对应 Chat 内恰好有两个根运行：一个历史成功 Turn 和一个本次失败 Turn；两者都没有子节点。因此截图中的 `2 runs` 表示“该 Chat 累计两个根运行记录”，不是“主 Agent + 子 Agent”。

这是一个 UI 语义误导，会掩盖实际没有委派的事实。

### 2.4 主 Chat 选择了 `orchestrator`，但编排指令没有进入真实执行

线程配置中已保存：

```text
agentProfileId = orchestrator
```

但当前调用链只传递：

```text
DesktopController.runTurn
  → model
  → reasoningEffort
  → handlers turn/run
  → AgentLoop.run(model, reasoningEffort)
```

`turn/run` 没有读取线程配置里的 `agentProfileId`，也没有从 AgentRegistry 解析 Profile，更没有把 `orchestrator.instructions` 传给主 AgentLoop。

只有 Scheduler 创建的子 Agent 才会显式传入 `profile.instructions`。这意味着界面上的“主 Agent / orchestrator”目前主要是配置展示，不会可靠改变主 Turn 的编排行为。

结果是：即使 `run_agent` 已注册到 ToolRegistry，主模型也没有得到明确的委派策略，是否调用完全依赖模型临场选择。联网搜索任务更容易直接使用 Provider 托管搜索，而不会创建子 Agent。

### 2.5 当前 `run_return` 不是独立的可恢复协议

当前实现流程是：

```text
父模型发出 run_agent function call
  → run_agent 同步等待子 Agent 全部执行完成
  → Scheduler 把父运行标成 resuming
  → Scheduler 立即写入 receiveReturn receipt
  → run_agent 返回一个 type=run_return 的普通 Tool output
  → AgentLoop 再次请求父模型
```

这里没有单独注册的 `run_return` Tool，也没有 Runtime 级的恢复任务。所谓 return 只是 `run_agent` 的一次函数输出，父 Agent 的“恢复”只是同一个同步 AgentLoop 自然进入下一轮请求。

这可以在理想路径工作，但不具备可靠的暂停、投递、确认和重试语义。

### 2.6 return receipt 写入时机错误

Scheduler 在子 Agent 刚完成后就调用：

```text
receiveReturn(result)
```

此时父模型还没有接收到、更没有成功消费 Tool output。若后续父模型请求超时、网络失败、进程退出或输入校验失败，receipt 已经存在，恢复时会把该结果误认为“已处理”，无法可靠重投。

当前 receipt 的真实含义是“子结果已生成”，代码却把它当成“父 Agent 已接收”。这是 `run_return` 的核心语义缺陷。

### 2.7 父子执行共享同步等待和总 Turn 预算

父 `run_agent` Tool 调用会同步等待子 Agent；子 Agent 又使用同一个 AgentLoop 实例发起完整执行。父 Turn 的 120 秒总计时器不会因为等待子 Agent而暂停。

因此，即使子 Agent成功返回，也可能已经消耗父 Turn 大部分时间，父模型最后一次汇总请求会在剩余预算内失败。当前没有“父执行预算”和“子执行预算”的隔离。

本次截图不是该问题触发——它在 45 秒首轮请求处就失败了——但这会成为真实 `run_return` 流程的不稳定来源。

### 2.8 缺少可观测的 return 生命周期

当前只有通用的 `agent/run_updated`，没有以下事件或持久状态：

- return 已生成
- return 等待投递
- 父 Agent 正在恢复
- return 已被父 Agent 消费
- 父 Agent 在消费后失败
- return 正在重试

因此 UI 无法区分“子任务完成”“结果正在返回”“父 Agent 已恢复”“父 Agent 恢复失败”。发生异常时只能统一显示 `Agent 执行失败，请重试`。

### 2.9 自动化测试验证了组件，不等于验证真实闭环

现有 Scheduler 测试直接调用 `scheduler.runAgent()`，验证了：

- 并发上限
- 子运行创建
- 结果返回
- receipt 去重

但它没有验证完整链路：

```text
父模型调用 run_agent
  → 子模型完成
  → return 投递
  → 父模型消费
  → 父模型输出最终回答
```

现有持久化测试还把“receipt 已存在”当成恢复成功标准，没有覆盖“子完成后、父确认前崩溃”的关键窗口。因此之前的通过只能证明 Scheduler 单元行为可运行，不能证明真实 `run_return` 已完成。

## 3. 根因结论

### 3.1 截图这次失败的直接根因

**首轮模型的托管联网搜索请求达到 Provider 的 45 秒请求超时；执行尚未调用 `run_agent`，因此不是一次 return 后恢复失败。**

### 3.2 没有触发多 Agent 的主要根因

**主 Chat 的 `agentProfileId = orchestrator` 没有接入 `turn/run` 执行参数，主 Agent 没有获得 orchestrator 编排指令。** `run_agent` 虽然在工具表中，但没有稳定的委派决策入口。

### 3.3 `run_return` 机制本身的核心根因

**当前实现把 `run_return` 当成同步 `run_agent` Tool output，而不是一个持久化、可确认、可重试的返回协议；并且在父 Agent 消费前过早提交 receipt。**

### 3.4 加重误判的 UI 根因

**协作树按 Chat 累计显示历史根运行，`N runs` 没有区分当前 Turn、历史 Turn和子 Agent，导致用户把两个历史根运行误认为两个协作 Agent。**

## 4. 推荐解决方案

### 4.1 先打通主 Agent Profile

主 Turn 启动时应从线程配置读取 `agentProfileId`，由 AgentRegistry 校验并解析 Profile，再把以下内容传给 AgentLoop：

- Profile instructions
- Profile 默认模型与用户显式模型的优先级规则
- reasoning effort
- allowedTools
- allowedSkills

主 Agent instruction 应明确：

- 哪些任务需要委派
- 可以一次并行发出多个 `run_agent`
- 子 Agent 返回后自动继续，不询问用户是否继续
- 子 Agent 失败时由父 Agent决定降级、重试或整合已有结果

### 4.2 把 return 改为持久化 Outbox + Ack 协议

建议新增独立实体：

```ts
interface AgentReturn {
  id: string;
  childRunId: string;
  parentRunId: string;
  parentTurnId: string;
  status: "ready" | "delivering" | "consumed" | "failed";
  payload: AgentRunResult;
  attempts: number;
  createdAt: string;
  consumedAt?: string;
}
```

正确语义应为：

```text
子 Agent 完成
  → 持久化 AgentReturn(status=ready)
  → 父 Agent 进入 waiting_return/resuming
  → Runtime 投递 return 并恢复父 Agent
  → 父模型成功消费并完成一次 continuation
  → AgentReturn 标为 consumed
  → 此时才提交幂等 receipt
```

若父 continuation 瞬时失败，Return 保持 `ready` 或回到 `ready`，按幂等键重试；不能提前写成已消费。

### 4.3 把父恢复变成显式 Runtime 动作

不要把恢复完全寄托在同步 Tool 调用栈中。建议 Scheduler 只负责子任务调度，Runtime Coordinator 负责：

- 挂起父 Turn
- 收集一个或多个已就绪 Return
- 按确定顺序组成 continuation 输入
- 恢复父 Agent
- 成功后确认消费
- 失败后分类重试或进入明确终态

多个子 Agent 并行返回时，建议按父模型原始 function call 顺序或稳定 sequence 排序，不按网络完成先后随机拼接。

### 4.4 分离超时预算

至少拆成：

- 单次 Provider 请求超时
- 父 Agent 活跃执行预算
- 子 Agent 独立执行预算
- 父 Agent 恢复请求预算
- 整个任务可选的总 deadline

父 Agent 等待子 Agent 时不应继续消耗“活跃模型执行预算”。托管搜索请求应有清晰的超时事件，并允许有限重试或降级到可恢复错误。

### 4.5 增加真实 return 事件

建议增加：

```text
agent/return_ready
agent/return_delivering
agent/return_consumed
agent/return_retrying
agent/parent_resuming
agent/parent_resumed
agent/parent_failed_after_return
```

Renderer 只显示安全摘要，但 Runtime 日志和状态码应保留可诊断分类，例如 `provider_timeout`、`return_delivery_failed`、`parent_resume_failed`。

### 4.6 修正协作树口径

默认只展示当前 Turn 的根运行及后代；历史 Turn 可放在折叠的“历史运行”中。计数应明确区分：

```text
当前 Turn：1 主 Agent · 0 子 Agent
历史：1 次运行
```

不能继续用未经说明的全量 `runs.length` 表示多 Agent 数量。

## 5. 推荐实施顺序

### 阶段 A：修正观测口径和错误分类

目标：先让界面和日志能够准确回答“有没有创建子 Agent、失败在哪一层”。

1. 当前 Turn 与历史运行分组。
2. 增加 Provider timeout 和 parent resume 的安全错误码。
3. 增加 return 生命周期事件定义。

回滚点：仅事件和展示口径，不改变调度行为。

### 阶段 B：打通主 Agent Profile

目标：让用户选中的 orchestrator 真正作用于主 Turn。

1. `turn/run` 读取线程 Profile。
2. 注入 instructions、Tool/Skill 白名单和模型配置。
3. 增加“需要委派”和“不需要委派”两组决策测试。

回滚点：可恢复为默认 Agent instructions，不涉及 Return 数据迁移。

### 阶段 C：建立 AgentReturn Outbox

目标：先持久化“待投递结果”，不再提前确认消费。

1. 增加 AgentReturn Store 和快照版本迁移。
2. 子完成时写 `ready`。
3. 移除子完成时的 receipt 提交。
4. 增加幂等键和确定性排序。

回滚点：保留旧快照兼容读取；新字段可忽略但不能丢失原 AgentRun。

### 阶段 D：显式父恢复与 Ack

目标：父 Agent 自动消费 return 并完成最终回答，不询问用户是否继续。

1. Runtime Coordinator 投递 pending Return。
2. 父 continuation 成功后提交 `consumed + receipt`。
3. 瞬时失败自动重试，永久失败进入 `failed_after_return`。
4. 取消时级联终止子运行和未消费 Return。

### 阶段 E：隔离预算并补齐真实集成测试

目标：验证真实 Provider 形状和故障恢复，而不只是 Scheduler 单元测试。

1. 分离父、子、恢复和 HTTP 超时预算。
2. 使用脚本化 LLM 完整模拟父 → 子 → 父三段响应。
3. 再做可控的真实 Provider smoke test。

## 6. 必须补充的验收用例

1. 父模型调用一个 `run_agent`，子成功，父自动继续并输出最终回答。
2. 父模型一次调用多个 `run_agent`，并行完成后按稳定顺序汇总。
3. 子 Agent 失败，父 Agent仍收到结构化失败并自行给出可用回答。
4. return 已 ready、父尚未消费时进程退出；重启后自动重投。
5. 父 continuation 第一次超时，Return 不丢失，重试成功后只消费一次。
6. 重复投递同一个 return，父 Agent只消费一次。
7. 父 Agent等待子 Agent时，父活跃预算不继续消耗。
8. 父 Agent在子执行期间取消，全部后代和待投递 Return 进入正确终态。
9. 多 Chat 并行，各自 Return 不串线，且全局并发上限有效。
10. 当前 Turn 没有子 Agent时，UI 明确显示 `0 子 Agent`，不能用历史根运行制造 `2 runs` 假象。
11. Provider 托管搜索达到超时时，UI 显示安全的“联网请求超时”，而不是暗示 return 失败。
12. orchestrator Profile 选择后，真实主请求中包含其编排约束；切换其他 Profile 后行为相应变化。

## 7. 完成标准

只有同时满足以下条件，才能宣布 `run_return` 完成：

- 主 Profile 真正进入执行链路，而非只保存配置。
- 子结果先持久化为 pending/ready，父成功消费后才写 receipt。
- 父恢复是显式、可观测、可重试的 Runtime 动作。
- 重启、超时、重复投递和取消场景都不会丢 Return 或重复消费。
- UI 能准确区分当前根 Agent、当前子 Agent、历史运行和恢复状态。
- 完整父 → 子 → 父集成测试通过，而不仅是 Scheduler 单测通过。
- 真实页面验证中，子 Agent 返回后父 Agent自动完成任务，不出现“是否继续”的询问。

## 8. 本次未执行事项

- 未修改任何 `.ts`、`.tsx`、`.css`、`.cjs` 或配置文件。
- 未启动修复施工。
- 未执行 Git 操作。
- 未输出环境变量、API Key、Token 或原始敏感错误响应。
