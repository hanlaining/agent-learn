# Electron：真实 Thinking 与 Activity 分层展示方案

> 方案日期：2026-08-05  
> 目标项目：`D:\练手\agent-learn`  
> 参考项目：`D:\练手\finance-agent`  
> 当前状态：只完成方案，不修改 Runtime 或 Electron 源码

## 一、要解决的问题

`finance-agent` 的界面把一组事件统一称为 `Reasoning`，但它实际展示的是经过人类文案转换的 Tool 执行轨迹，而不是模型公开的 Reasoning Summary。

我们的项目已经同时拥有两类不同数据：

```text
模型公开 Reasoning Summary SSE
  → 模型主动返回的公开推理摘要

Runtime Activity
  → Tool、MCP、Web Search、Permission、Compaction 等真实执行状态
```

如果把两者混成一个 `Reasoning` 数组，会产生三个问题：

1. 用户无法判断内容来自模型还是 Runtime；
2. Tool 行为容易被误解成模型思维链；
3. UI 为兼容不同事件不断增加字符串判断，最终难以测试和维护。

因此本方案的核心原则是：

```text
Thinking 只展示模型公开摘要
Activity 只展示 Runtime 真实动作
永远不展示或伪造隐藏思维链
```

## 二、参考项目做法与结论

参考源码：

- [`finance-agent/agent/orchestrator_adapter.py`](../../finance-agent/agent/orchestrator_adapter.py)：把 Tool Call 转换成用户友好的动作描述；
- [`finance-agent/frontend/src/components/ReasoningTrace.tsx`](../../finance-agent/frontend/src/components/ReasoningTrace.tsx)：步骤折叠、动画、慢请求提示、搜索分组和文档 Chip；
- [`finance-agent/frontend/src/hooks/useChat.ts`](../../finance-agent/frontend/src/hooks/useChat.ts)：接收 SSE 并累积 `ReasoningStep`；
- [`finance-agent/app/routers/chat.py`](../../finance-agent/app/routers/chat.py)：转发并持久化展示步骤。

值得借鉴：

- Tool 参数转换成用户能理解的动作；
- 搜索查询合并；
- 文件和来源 Chip；
- 20 秒慢请求提示；
- 历史步骤恢复；
- 新步骤进入动画；
- 相同动作去重。

不应照搬：

- 把 Tool Trace 命名为 Reasoning；
- 外层 `Show reasoning` 加内层折叠的双重开关；
- 完成后仍默认完全展开；
- `data: any`；
- 未知带 `message` 的事件全部进入 UI；
- 依赖英文字符串进行安全过滤；
- 缺少组件和事件映射测试。

## 三、推荐的信息架构

### 3.1 用户看到的三个区域

```text
Thinking
  模型公开 Reasoning Summary

Activity
  Runtime 的 Tool / Search / Permission 等动作

Answer
  Assistant 最终回答与 Sources
```

三者的来源必须稳定：

| UI 区域 | 数据来源 | 能否进入模型 Context |
|---|---|---|
| Thinking | `reasoning/summary_*` | 不因 UI 展示而额外进入 |
| Activity | Runtime `AgentEvent` | 不进入 |
| Answer | `assistant_message` | 后续 Turn 可以进入 |

### 3.2 推荐界面

运行中：

```text
┌────────────────────────────────────────────────────────┐
│ ◌ Thinking：检查问题并确定需要调用的工具            ▾ │
│   • 先读取确定性数据，再根据结果组织回答。              │
└────────────────────────────────────────────────────────┘

  🔍 正在搜索 “2026 年 MCP 最新规范”
  ✓  搜索完成
  ◌  正在调用 MCP：demo / echo

  Assistant › 正在生成回答…
```

完成后：

```text
┌────────────────────────────────────────────────────────┐
│ ✓ Thinking：检查问题并确定需要调用的工具            ▸ │
└────────────────────────────────────────────────────────┘

  ✓ 搜索 “2026 年 MCP 最新规范”
  ✓ MCP：demo / echo

  Assistant › 最终回答……
```

### 3.3 交互规则

- Thinking 只有一层折叠；
- 运行中默认展开，完成后自动折叠；
- 用户手动展开或折叠后，不再被自动状态覆盖；
- 折叠标题显示最新真实摘要标题，不能只显示笼统的 `Processing...`；
- 没收到公开摘要时显示 `Thinking…`，但不生成虚假正文；
- Activity 不再套一个第二层 `Reasoning` 折叠；
- 同一个 `callId` 的 started/completed 更新同一行，不生成两条重复记录；
- 超过 20 秒没有状态变化时显示“仍在处理，可随时取消”，不伪造进度；
- Answer 和 Sources 保持现有顺序。

## 四、强类型展示模型

Renderer 不直接接收任意 JSON 或原始 App Server 消息。Electron Main 必须先使用现有 `isAgentEvent` 校验，再转换成白名单 View Model。

推荐类型：

```ts
type TurnPresentationEvent =
  | {
      type: "thinking/part_started";
      turnId: string;
      round: number;
      summaryIndex: number;
    }
  | {
      type: "thinking/delta";
      turnId: string;
      round: number;
      summaryIndex: number;
      delta: string;
    }
  | {
      type: "thinking/completed";
      turnId: string;
      round: number;
    }
  | {
      type: "activity/upsert";
      turnId: string;
      activity: ActivityViewModel;
    }
  | {
      type: "turn/status";
      turnId: string;
      status: "running" | "completed" | "failed" | "cancelled" | "timed_out";
    };

interface ActivityViewModel {
  id: string;
  kind: "tool" | "mcp" | "search" | "permission" | "context";
  status: "pending" | "running" | "completed" | "denied" | "failed";
  label: string;
  detail?: string;
  startedAt?: string;
  completedAt?: string;
}
```

约束：

- 不使用 `any`；
- View Model 不携带原始 Tool Result；
- 不携带 Key、环境变量、完整命令、完整文件内容或 stderr；
- URL 必须继续限制为 `http:` / `https:`；
- 未知事件直接忽略并写 Main Process 诊断日志，不交给 Renderer 猜测。

## 五、现有 AgentEvent 映射

当前事件定义：[`src/agent/events.ts`](../src/agent/events.ts)

| 现有 AgentEvent | UI 映射 |
|---|---|
| `model/started` | Turn 进入 Thinking 状态；没有摘要时只显示 `Thinking…` |
| `reasoning/summary_part_added` | 使用当前 Model Round 创建对应 Summary Part |
| `reasoning/summary_delta` | 按 `round + summaryIndex` 追加公开摘要文本 |
| `reasoning/summary_completed` | 当前 Round 的 Thinking 完成，可自动折叠 |
| `web_search/started` | 创建 Search Activity |
| `web_search/searching` | Search Activity → running |
| `web_search/completed` | Search Activity → completed，并显示 query |
| `permission/requested` | 创建 Permission Activity，同时弹出审批 UI |
| `permission/decided` | Activity → completed / denied |
| `tool/started` | 创建 Tool Activity，按 `callId` 唯一定位 |
| `tool/completed` | 同一 Activity → completed |
| `context/compacted` | 产品模式显示轻量“已整理较早对话”；debug 显示 Token 数 |
| `assistant/delta` | Answer 流式追加 |
| `turn/completed` | Turn 完成，结束 Spinner |
| `turn/failed` | Turn 与未结束 Activity → failed |
| `turn/interrupted` | Turn → cancelled |
| `turn/timed_out` | Turn → timed_out |

`citation/url_added` 不进入 Activity，继续进入 Answer 下方 Sources。

当前 Summary Event 没有显式 `round`。第一版 Main Presenter 可以根据最近一次 `model/started.round` 顺序补齐；正式持久化前，推荐直接把 `round` 加入 Runtime Summary Event，避免不同 Model Round 都从 `summaryIndex=0` 开始时发生错误合并。

## 六、Tool Activity 的安全描述

当前 `tool/started` 只有 `toolName`，无法生成 `finance-agent` 那样具体又安全的动作描述。不能让 Renderer 读取完整 arguments 后自行拼文案。

推荐在 AgentTool 边界增加可选能力：

```ts
interface AgentTool {
  // 现有字段省略
  describeActivity?: (argumentsJson: string) => {
    label: string;
    detail?: string;
  };
}
```

Agent Loop 在可信 Runtime 内调用它，并把已经脱敏的描述加入 Tool Event：

```ts
{
  type: "tool/started",
  turnId,
  callId,
  toolName,
  activity: {
    label: "正在读取文件",
    detail: "docs/README.md",
  },
}
```

设计要求：

- `describeActivity` 和 `describePermission` 分开；
- Activity 文案用于解释“正在做什么”；
- Permission 文案用于解释“为什么需要批准”；
- 只抽取允许展示的字段，不直接返回原始 arguments；
- 解析失败时退回 `正在执行 <toolName>`；
- 文案由确定性代码生成，不让 LLM 自己编写。

推荐文案：

| Tool | Activity |
|---|---|
| `finance_monthly_summary` | `正在计算 2026-07 月度财务汇总` |
| `list_files` | `正在查看目录 docs` |
| `read_file` | `正在读取 docs/README.md` |
| `run_command` | `正在运行预注册检查：npm test` |
| `read_skill` | `正在读取 Skill：finance-analysis` |
| `mcp__demo__echo` | `正在通过 MCP demo 调用 echo` |

MCP 描述只使用配置中的 Server 名和 Tool 名，不展示启动命令、cwd 或任何环境信息。

## 七、状态管理方案

### 7.1 单向数据流

```text
App Server AgentEvent
→ Electron Main 校验
→ Main 转换为 TurnPresentationEvent
→ Preload 白名单 IPC
→ Renderer Reducer
→ ThinkingCard / ActivityTimeline / Answer
```

Renderer 不能直接持有 `JsonRpcConnection`。

### 7.2 Reducer 状态

```ts
interface TurnPresentationState {
  turnId: string;
  status: "idle" | "running" | "completed" | "failed" | "cancelled" | "timed_out";
  thinking: {
    activeRound: number;
    parts: Record<string, string>; // key = `${round}:${summaryIndex}`
    completed: boolean;
    userExpansionOverride?: "expanded" | "collapsed";
  };
  activities: ActivityViewModel[];
  answer: string;
}
```

Reducer 必须：

- 根据 `turnId` 隔离并发或排队消息；
- 根据 `round + summaryIndex` 合并摘要分段；
- 根据 Activity `id` 做 upsert；
- 忽略重复 completed；
- Turn 终态后拒绝迟到的 running 更新；
- 新 Turn 不覆盖旧 Turn 的展示数据。

## 八、历史恢复与持久化

当前项目会保存 Lifecycle 与 Context Checkpoint，但不会把 Reasoning Summary Event 独立持久化。因此：

```text
实时 Turn：可以看到 Thinking
重启并恢复旧 Thread：目前无法还原 Thinking
```

推荐新增独立的 `TurnPresentationStore`，而不是把 UI Trace 塞进 Context：

```text
RuntimePersistence
  ├─ LifecycleStore          事实与对话
  ├─ ContextCheckpointStore  模型 Context 窗口
  └─ TurnPresentationStore   公开摘要与脱敏 Activity
```

只持久化：

- 已完成的公开 Reasoning Summary；
- 脱敏后的 Activity View Model；
- Turn 展示终态；
- Sources 所需的安全元数据。

明确不持久化：

- 隐藏思维链；
- 原始 SSE 未知字段；
- 原始 Tool arguments；
- Tool 完整结果副本；
- Key、环境变量或 stderr。

`ContextBuilder` 不读取 `TurnPresentationStore`，防止展示轨迹污染模型上下文。

该能力建议放到 Electron 历史会话切片，不与第一个窗口握手切片同时实现。

## 九、组件设计

建议组件：

```text
TurnView
├─ ThinkingCard
│  ├─ ThinkingHeader
│  └─ PublicSummaryBody
├─ ActivityTimeline
│  └─ ActivityRow
├─ AssistantMessage
└─ SourcesList
```

### ThinkingCard

- 只接收 Public Summary；
- Markdown 只支持安全子集；
- 运行中显示 Spinner；
- 完成显示勾；
- 只有一个折叠按钮；
- 没摘要内容时不渲染空白详情区。

### ActivityTimeline

- 每个 `callId` 一行；
- Search、Tool、MCP、Permission 使用不同图标；
- running / completed / denied / failed 颜色不同；
- detail 默认单行截断；
- 后续可以给文件、URL、Citation 增加安全 Chip；
- 不显示 Step 数量来冒充推理深度。

## 十、建议文件

以下名称为实施建议，最终根据 Electron 技术栈确认：

```text
src/electron/shared/presentation-events.ts
  Main 与 Renderer 共享的白名单 View Model

src/electron/main/agent-event-presenter.ts
  校验 AgentEvent 并转换成展示事件

src/electron/renderer/state/turn-presentation-reducer.ts
  合并 Summary Delta、Activity 和 Turn 状态

src/electron/renderer/components/ThinkingCard.tsx
  真实公开摘要展示

src/electron/renderer/components/ActivityTimeline.tsx
  Runtime 动作列表

src/electron/renderer/components/ActivityRow.tsx
  单个动作状态

tests/electron/agent-event-presenter-test.ts
tests/electron/turn-presentation-reducer-test.ts
tests/electron/thinking-card-test.tsx
tests/electron/activity-timeline-test.tsx
```

可能修改：

```text
src/agent/events.ts
src/agent/agent-loop.ts
src/tools/tool-registry.ts
各具体 Tool Adapter
```

## 十一、分切片实施顺序

### 切片 1：展示事件 Contract 与 Reducer

目标：不做视觉，只证明事件能确定性转换和合并。

改动：

- 定义 `TurnPresentationEvent`；
- Main 侧白名单转换；
- Renderer Reducer；
- Summary 分段、Tool upsert、Turn 终态测试。

验收：

```text
AgentEvent 序列
→ 唯一确定的 TurnPresentationState
```

### 切片 2：ThinkingCard

目标：展示真实公开 Summary SSE。

验收：

- 流式 Delta 顺序正确；
- 运行中展开；
- 完成后自动折叠；
- 用户手动选择优先；
- 没有 Summary 时不伪造正文。

### 切片 3：ActivityTimeline

目标：展示真实 Tool/Search/Permission 状态。

验收：

- started/completed 更新同一行；
- MCP 与普通 Tool 可区分；
- 安全描述不包含秘密字段；
- 20 秒慢请求提示；
- 失败、取消、超时正确收口。

### 切片 4：安全 Activity 描述

目标：实现 `describeActivity`，替代仅显示 Tool 名称。

验收：

- 内置 Tool 文案确定性；
- MCP 只显示 Server/Tool 名；
- 非法 arguments 安全降级；
- 不向 Renderer 发送原始 arguments。

### 切片 5：历史恢复

目标：新增 `TurnPresentationStore`，恢复已完成摘要和动作。

验收：

- 重启后旧 Turn 展示一致；
- ContextBuilder 输入不发生变化；
- 不保存隐藏内容或秘密字段；
- 损坏 Snapshot 被拒绝。

一次只推进一个切片。Electron 01 最小窗口握手完成前，不应同时开始这些完整 UI 切片。

## 十二、测试方案

### 单元测试

- 多个 `summaryIndex` 正确组合；
- Delta 顺序稳定；
- 重复事件幂等；
- Tool started/completed 合并；
- Permission deny 状态；
- Turn failed 自动结束 Spinner；
- 未知事件不进入 Renderer；
- 非 HTTP(S) URL 被拒绝；
- Activity 文案不包含 Key、环境变量或完整命令。

### 组件测试

- Thinking 只有一个折叠开关；
- collapsed 标题显示最新真实标题；
- completed 后自动折叠；
- 手动展开不会再次自动关闭；
- Activity 行状态图标和文本正确；
- 长文本和大量 Activity 不破坏布局。

### 端到端测试

使用 Fake App Server 依次发送：

```text
model/started
reasoning/summary_part_added
reasoning/summary_delta
reasoning/summary_completed
web_search/started
web_search/completed
tool/started
tool/completed
assistant/delta
turn/completed
```

断言：

- Summary 只出现在 Thinking；
- Search/Tool 只出现在 Activity；
- Assistant 文本不混入 Thinking；
- 完成后 Spinner 消失；
- 没有双层折叠；
- 截图顺序与设计一致。

## 十三、最终验收标准

- [ ] UI 明确区分 Thinking、Activity、Answer；
- [ ] Thinking 内容只来自真实 Reasoning Summary SSE；
- [ ] Activity 内容只来自 Runtime 真实事件；
- [ ] 不显示或伪造隐藏思维链；
- [ ] 只有一层 Thinking 折叠；
- [ ] 运行中能看到最新真实摘要或动作；
- [ ] Tool started/completed 不重复占两行；
- [ ] Search Query 与 Sources 归属正确；
- [ ] Renderer 不接收原始 JSON-RPC、Tool arguments 或秘密数据；
- [ ] 全部事件经过强类型白名单；
- [ ] Cancel、Timeout、Failure 后状态正确收口；
- [ ] 原有 CLI 与 165 项测试不回归；
- [ ] 新增 Reducer、组件和 Electron 端到端测试通过。

## 十四、教训总结：怎样把 Agent 做成 Codex 式思考展示

### 教训 1：Codex 式体验首先是数据链路，不是 CSS

只做一个带 Spinner 的折叠框，不会自动得到 Codex 的思考展示。至少需要打通五层：

```text
模型请求参数
→ Provider SSE 捕获
→ Runtime 强类型事件
→ Client / Electron Bridge
→ UI 状态机与折叠展示
```

任意一层缺失，最终都只会剩下 `Thinking…` 占位文字。

### 教训 2：先把公开 Summary 请求回来，再讨论怎么展示

我们此前拿不到 Summary 的直接原因，是 Responses 请求缺少或没有完整透传相关参数，不是简单更换模型名称就能解决。

已经验证的请求形状包括：

```json
{
  "stream": true,
  "reasoning": {
    "effort": "high",
    "summary": "auto"
  },
  "include": [
    "reasoning.encrypted_content"
  ]
}
```

要点：

- `reasoning.summary` 决定请求公开摘要；
- `reasoning.effort` 必须按当前端点要求正确传递；
- 中转层不能删除、改名或覆盖 `reasoning`；
- `stream` 必须开启，才能实时收到 Summary Delta；
- `reasoning.encrypted_content` 不能展示给用户，它只服务于受支持的推理连续性；
- 排查时优先抓取最终发出的 Request Body 和原始 SSE Event，不要只看业务代码里“本来准备传什么”。

项目中的相关复盘：

- [`真实Reasoning-Summary未展示原因与验收计划.md`](./真实Reasoning-Summary未展示原因与验收计划.md)
- [`Summary-SSE捕获与Codex式展示-实施计划.md`](./Summary-SSE捕获与Codex式展示-实施计划.md)
- [`里程碑-从Summary缺失到联网搜索全链路打通-2026-08-03.md`](./里程碑-从Summary缺失到联网搜索全链路打通-2026-08-03.md)

### 教训 3：必须识别真实 Summary SSE 边界

不能只监听最终文本事件。Provider 至少要识别：

```text
response.reasoning_summary_part.added
response.reasoning_summary_text.delta
reasoning item 完成边界
response.completed
```

并转换为稳定的 Provider 无关事件：

```text
reasoning_summary_part_added
reasoning_summary_delta
reasoning_summary_completed
```

不能把 Summary Delta 拼进 Assistant 文本，否则会产生以下问题：

- 思考摘要和最终答案混在一起；
- UI 无法独立折叠；
- Summary 可能被当成历史 Assistant 回答进入下一个 Turn；
- Sources 和文本下标发生错位。

### 教训 4：模型公开摘要和 Runtime Activity 必须分开

Codex 式透明感并不只来自 Summary，还来自真实执行状态：

```text
Thinking
  → 模型公开摘要

Activity
  → Search / Tool / MCP / Permission / Compaction
```

`finance-agent` 的优点是 Tool Activity 文案很好，但它没有 Summary SSE。我们的实现应把两者组合，而不是用 Tool Log 替代 Summary。

判断标准：

- 没有 Summary SSE 时，只显示 `Thinking…`，不能编一段“模型正在分析”；
- 没有 Tool 调用时，不生成虚假 Activity；
- Tool Activity 必须由真实 started/completed 事件驱动；
- 人类友好文案只能改写“动作表达”，不能捏造模型结论。

### 教训 5：不要展示隐藏思维链

目标不是获取模型私有 Chain of Thought，而是展示：

```text
模型允许公开的 Reasoning Summary
+
Runtime 可以证明的真实动作
```

以下内容禁止进入 UI：

- 加密推理正文；
- Provider 私有内部字段；
- 未声明可公开的模型中间文本；
- Runtime 日志、stderr、堆栈；
- Tool 完整结果和秘密参数。

这既是安全边界，也使产品展示更稳定。

### 教训 6：Bridge 负责安全搬运，不负责制造思考

Electron 确实需要 Bridge，但 Bridge 的职责是：

```text
App Server AgentEvent
→ Main 校验
→ 转换为白名单 View Model
→ Preload contextBridge
→ Renderer
```

Bridge 不能：

- 根据等待时间自动编写“正在深入思考”；
- 把 App Server stderr 当 Reasoning；
- 把未知 JSON 原样发送给 Renderer；
- 把 Key、环境变量或 Tool 原始参数带进 IPC。

如果 Provider 没返回 Summary，Bridge 只能传递“当前无公开摘要”这一事实。

### 教训 7：多轮 Tool Loop 必须保留 Round 边界

同一个 Turn 可能发生：

```text
Model Round 0 Summary
→ Tool
→ Model Round 1 Summary
→ Tool
→ Model Round 2 Final Answer
```

每个 Round 的 `summaryIndex` 都可能从 0 开始。因此正确主键是：

```text
turnId + round + summaryIndex
```

只用 `turnId + summaryIndex`，实时 CLI 可能暂时看不出问题，但历史恢复、重放和乱序保护都会把不同 Round 的摘要混在一起。

### 教训 8：UI 必须是状态机，而不是字符串列表

Codex 式展示需要明确状态：

```text
idle
→ thinking
→ awaiting_permission
→ running_tool / searching
→ thinking
→ answering
→ completed / failed / cancelled / timed_out
```

UI 不应该通过判断文本是否包含 `Searching:` 或 `Generating response` 来推断状态。应根据强类型事件更新 Reducer。

同一个 Tool 的：

```text
tool/started
tool/completed
```

必须按 `callId` 更新同一行，而不是累计成两条日志。

### 教训 9：折叠行为决定它像不像 Codex

推荐交互：

```text
Model 开始
→ 显示 Thinking…

Summary Delta 到达
→ 标题显示最新真实摘要标题
→ 展开区流式追加公开摘要

Tool / Search 开始
→ Activity 显示当前动作

Summary 完成 / Answer 开始
→ Thinking 自动折叠成一行

用户手动展开
→ 尊重用户选择，不再自动关闭
```

需要避免：

- 双层 `Show reasoning`；
- 折叠后只显示永远不变的 `Processing...`；
- Turn 完成后仍占据大段页面；
- 用步骤数量暗示模型推理深度。

### 教训 10：历史展示要独立持久化，不能污染 Context

Thinking 与 Activity 是展示轨迹，不是下一轮模型必须读取的对话事实。

正确结构：

```text
LifecycleStore
  保存对话事实

ContextCheckpointStore
  保存模型窗口替换历史

TurnPresentationStore
  保存公开 Summary 和脱敏 Activity
```

`ContextBuilder` 不读取 `TurnPresentationStore`。否则 Tool 状态、搜索日志和 Summary 会被重复塞回模型，浪费 Token 并污染后续回答。

### 教训 11：必须分层测试真实返回结果

只测 UI 快照不足以证明 Summary 真正来自模型。至少要有四层证据：

```text
Provider 测试
  断言最终 Request Body 含 reasoning 参数
  断言原始 SSE Summary Event 被解析

Runtime 测试
  断言 Summary / Tool / Assistant Event 不混流

Bridge 测试
  断言未知和敏感字段不会进入 Renderer

UI 端到端测试
  断言 Thinking → Activity → Answer 的顺序和折叠效果
```

验收用例必须展示一份实际事件序列和最终 UI 文本，不能只报告 HTTP 200 或测试进程退出码。

### 教训 12：Codex-like 的最小完成定义

满足下面条件，才能称为“像 Codex 的思考过程展示”：

- 请求端确实请求公开 Reasoning Summary；
- 中转和 Provider 完整透传 Summary SSE；
- Summary、Activity、Answer 三条流严格分离；
- UI 实时显示真实摘要标题和动作；
- Tool/Search 生命周期可验证；
- 完成后折叠，用户可再次展开；
- Cancel、Timeout、Retry 后状态不会卡死；
- 历史恢复不把展示轨迹塞回 Context；
- 没有 Summary 时诚实降级；
- 不展示或伪造隐藏思维链。

一句话总结：

```text
Codex 式思考展示 = 公开 Summary SSE + 真实 Runtime Activity + 严格事件边界 + 状态机 UI
```

## 十五、最终方案结论

推荐保留 `finance-agent` 的用户体验优点，但不复制其事件语义：

```text
借鉴：动画、搜索分组、文档 Chip、慢请求提示、历史恢复

改进：
真实 Summary SSE → Thinking
真实 Runtime Event → Activity
单层折叠
强类型白名单
脱敏 Tool 描述
独立展示持久化
确定性测试
```

这样既能获得类似 Codex 的透明执行体验，也不会把 Tool Log 冒充模型思考过程。
