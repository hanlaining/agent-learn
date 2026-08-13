# Chat 独立 Job 与单 Job Agent 树：根因分析

日期：2026-08-12  
状态：根因已定位，尚未修改业务代码。  
关联文档：[问题清单](./Chat独立Job与单Job-Agent树-问题清单.md) · [解决方案](./Chat独立Job与单Job-Agent树-解决方案.md) · [总排查记录](./Multi-Agent-run_return根因排查与修复方案-2026-08-12.md)

## 1. 架构关系被混用了

当前实现中存在四种对象：

```text
Chat / Thread
└─ Turn
   └─ AgentRun
      └─ Child AgentRun
```

正确语义应为：

- Chat/Thread：用户可切换的独立 Job 容器；
- Turn：该 Chat 中的一次用户任务；
- 根 AgentRun：当前 Turn 的根执行节点；
- 子 AgentRun：根节点或其他子节点委派出的后代节点。

当前 UI 却把一个 Chat 下多个历史 Turn 的根 AgentRun 合并展示，并用总数 `runs.length` 标记为 `N runs`。这把“历史任务数量”错误表达成了“当前协作 Agent 数量”。

## 2. 当前树缺少 Job/Turn 过滤

AgentRunStore 的 `listForThread(threadId)` 会返回该线程的所有根运行及其后代。Renderer 随后：

1. 将全部无 `parentRunId` 的运行当作根节点；
2. 将全部运行数量显示为 `runs.length`；
3. 不按当前 `turnId` 或当前根 `runId` 过滤。

因此同一 Chat 的两次历史 Turn 会自然形成两个并列根节点。这不是父子树，而是历史森林。

## 3. 主 Agent Profile 只保存、未执行

配置层已经持久化：

```text
model
reasoningEffort
agentProfileId
```

但实际 `DesktopController.runTurn` 只传递 `model` 和 `reasoningEffort`；`turn/run` 也只把这两个字段传给 AgentLoop。

`agentProfileId` 没有经过 AgentRegistry 解析，`orchestrator.instructions` 没有进入主请求。只有被 Scheduler 创建的子 Agent才会接收到 `profile.instructions`。

所以主 Agent Profile 目前是展示配置，不是完整的运行配置。这是模型没有稳定调用 `run_agent` 的直接设计原因。

## 4. 截图失败发生在委派之前

本地持久化证据显示：

| Turn | 耗时 | 子节点 | Return receipt |
|---|---:|---:|---:|
| `turn-58` | 45,026 ms | 0 | 0 |
| `turn-60` | 45,011 ms | 0 | 0 |

Provider 默认请求超时为 45,000 ms。RuntimeSession 只记录第 0 轮规划、推理摘要和托管搜索，之后请求失败，没有 Tool continuation。

因此截图中的直接调用链是：

```text
根 Agent 首轮请求
  → 托管联网搜索
  → 45 秒请求超时
  → 根 Turn 失败
```

而不是：

```text
根 Agent
  → run_agent
  → 子 Agent
  → run_return
  → 父恢复失败
```

## 5. `run_return` 只有同步函数输出，没有协议状态

当前实现中没有独立注册的 `run_return` Tool。流程是：

```text
父模型调用 run_agent
  → run_agent 同步等待子 Agent
  → 返回 type=run_return 的 Tool output
  → AgentLoop 发起下一轮父模型请求
```

这是一条同步调用栈，而不是可以跨进程恢复的 Return 协议。它没有记录：

- Return 是否已生成；
- Return 是否等待投递；
- Return 是否正在投递；
- 父 Agent是否成功消费；
- 失败后是否需要重试。

## 6. receipt 在错误的时间提交

Scheduler 在子 Agent刚完成时立即执行 `receiveReturn(result)`，但父模型此时还没有成功消费该输出。

这造成语义错位：

```text
当前 receipt = 子结果已经生成
正确 receipt = 父 Agent已经成功消费
```

如果父 continuation 超时或进程在中间退出，持久化状态可能已经认为 return 被处理，结果却从未进入父 Agent。

## 7. 父子预算没有隔离

父 Agent同步等待子 Agent时，父 Turn 的总计时器仍在运行。子任务越复杂，父 Agent用于最终汇总的剩余预算越少。

即使子 Agent成功完成，父 continuation 仍可能因为剩余时间不足而失败。这不是截图中的直接触发点，但属于现有 return 设计的高风险根因。

## 8. 多 Chat 的独立性只做到部分状态隔离

当前已有按线程保存配置和 RuntimeSession 的基础，也允许多个 DesktopController 运行状态按 threadId 保存。但真正完整的 Job 隔离还需要明确保证：

- 每个 Job 有自己的根运行标识；
- Return 必须带有 jobId/rootRunId 并校验归属；
- 取消、超时和重试只影响目标 Job；
- AgentRun 树按当前 Job 查询，而不是按 Chat 累计查询；
- 全局 Scheduler 只共享并发额度，不共享业务执行状态。

## 9. 根因结论

### 9.1 概念根因

把“多 Chat 并行 Job”和“单 Job 内父子 Agent”放进了同一个协作树口径，没有明确两者的隔离边界。

### 9.2 执行根因

主 Agent Profile 没有进入 `turn/run`，导致 orchestrator 的委派规则没有生效。

### 9.3 Return 根因

`run_return` 是同步 Tool output，不具备持久化 Outbox、消费确认和失败重投机制；receipt 又在父消费前提前提交。

### 9.4 UI 根因

当前按 Chat 累计展示全部 AgentRun，不按当前 Job/Turn 过滤，并用 `runs.length` 表示数量，制造了 `2 runs` 等误导信息。

### 9.5 截图直接故障

首轮托管联网请求触发 45 秒 Provider 超时，尚未创建子 Agent，与 return 恢复链路无关。

## 10. 本文档边界

- 只记录已确认根因。
- 未修改业务代码。
- 未执行 Git 操作。
- 未输出密钥、Token 或敏感原始错误。
