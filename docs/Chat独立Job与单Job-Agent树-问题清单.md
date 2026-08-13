# Chat 独立 Job 与单 Job Agent 树：问题清单

日期：2026-08-12  
状态：问题已确认，尚未修改业务代码。  
关联文档：[根因分析](./Chat独立Job与单Job-Agent树-根因分析.md) · [解决方案](./Chat独立Job与单Job-Agent树-解决方案.md) · [总排查记录](./Multi-Agent-run_return根因排查与修复方案-2026-08-12.md)

## 1. 正确产品定义

产品需要同时支持两种不同层级的并行能力：

1. **多 Chat 并行**：每个 Chat 是彼此独立的 Job，可以同时运行、随时切换，互不阻塞。
2. **单 Job 内的父子 Agent**：一个 Chat 的根 Agent 可以按需创建子 Agent；子 Agent 仍属于当前 Job，并以树形挂在父节点下面。

不同 Chat 不是彼此协作的 Agent，也不能形成父子关系。

## 2. 当前问题

### 2.1 Chat、Turn、AgentRun 的展示关系混乱

当前“Agent 协作树”读取一个 Chat 下累计的全部 AgentRun。一个 Chat 中两次历史根 Turn 会被显示为 `2 runs`，容易被理解为当前有两个 Agent 在协作。

正确含义应当是：当前 Job 只有一个根 Agent；只有带 `parentRunId` 的节点才是子 Agent。

### 2.2 当前 Turn 与历史 Turn 混在同一棵树

历史根运行被放进当前执行树，导致：

- `2 runs` 与右侧 `0 Agents` 同时出现；
- 用户无法判断当前是否真的创建了子 Agent；
- 失败的历史根节点会干扰当前 Job 的状态理解。

### 2.3 多 Chat 独立 Job 的边界没有在数据和 UI 中表达清楚

用户需要在 Chat A 工作时创建、切换或继续 Chat B，两个 Job 应分别运行。当前命名和展示容易让人误以为所有 Chat 都属于一棵全局“协作树”。

### 2.4 主 Chat 选择的 Agent Profile 没有真正作用于执行

界面和线程配置保存了 `agentProfileId = orchestrator`，但主 Turn 执行时没有把该 Profile 的 instructions 传入 AgentLoop。因此主 Agent并不知道应该何时委派子 Agent，也不能稳定建立父子树。

### 2.5 截图中的失败被误认为 `run_return` 失败

截图对应 Turn 在约 45 秒时失败，持久化中没有子 Agent、没有 `childRunIds`、没有 return receipt。直接失败点是首轮模型/托管搜索请求超时，尚未进入 `run_agent → run_return`。

### 2.6 `run_return` 不能可靠恢复父 Agent

当前 return 只是 `run_agent` 的同步 Tool output；父 Agent是否恢复依赖同一 AgentLoop 的下一次模型请求，没有独立的待投递、确认和重试状态。

### 2.7 子 Agent 不能被准确地树形观察

当前事件只有通用的 `agent/run_updated`，没有 return ready、父恢复、return consumed 等阶段。即使未来真的创建了子 Agent，UI 也不能完整说明它挂在哪个父节点、是否已经返回、父节点是否成功继续。

## 3. 期望界面

```text
Agent 执行树

● 主 Agent · 正在汇总
├─ ● 排查 Agent · 已返回
│  └─ ● 验证 Agent · 已返回
└─ ● 测试 Agent · 运行中

当前 Job：1 个根 Agent · 3 个子 Agent
```

其他 Chat 的 Job 不出现在这棵树中。历史 Turn 应单独折叠，不参与当前 Agent 数量统计。

## 4. 问题验收口径

只有出现以下情况才能认为问题已消除：

- Chat A 与 Chat B 可以同时运行，切换不会取消、暂停或串改彼此状态。
- 每个 Chat 只展示自己当前 Job 的 Agent 树。
- 子 Agent 只能挂在同 Job 的父 Agent 下方。
- 没有子 Agent 时明确显示 `0 个子 Agent`，不能用历史根 Turn 生成 `2 runs`。
- 子 Agent返回后，父 Agent自动继续完成任务，不询问用户是否继续。

## 5. 本文档边界

- 只记录问题，没有修改代码。
- 不包含 Git 操作。
- 不涉及不同 Chat 之间共享上下文或跨 Chat Return。
