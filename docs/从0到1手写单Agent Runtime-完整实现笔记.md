# 从 0 到 1 手写单 Agent Runtime：完整实现笔记

> 项目：`god-agent`  
> 项目目录：`D:\练手\agent-learn`  
> 整理日期：2026-08-03  
> 技术栈：TypeScript、Node.js、JSON-RPC、JSONL、OpenAI Responses API  
> 当前基线：`npm run check` 通过，`npm test` 123/123 通过

## 一、我们最终做出了什么

我们没有使用 LangChain 隐藏 Agent 的核心过程，而是从最底层协议开始，手写了一个可以真实运行的单 Agent Runtime。

最终能力包括：

- JSON-RPC 消息模型和运行时校验。
- JSONL 流式分帧。
- Request ID 与 Promise 的关联。
- Client 和 App Server 双向请求。
- Thread、Turn、Item 生命周期。
- OpenAI Responses Provider 与 SSE 流式解析。
- 确定性金融 Tool。
- `Model → Tool → Model → Final Answer` Agent Loop。
- Runtime Event System。
- 跨 Turn Context Builder。
- Token Budget、语义 Compaction 和 Context Checkpoint。
- Tool Registry 与异步 Tool。
- App Server → CLI 反向 Permission 审批。
- Workspace 文件 Sandbox 和受控命令执行。
- Runtime JSON 原子持久化与重启恢复。
- Cancel、Timeout、Provider Retry。
- 产品化 `god-agent` CLI。

当前明确没有进入：

```text
Skill Loader
MCP Client
Electron
Multi-Agent
生产级容器 / 虚拟机 Sandbox
生产级金融执行
```

## 二、先看懂整体架构

```text
用户
  ↓
god-agent CLI
  ├─ 命令解析、消息队列、输出渲染
  ├─ Tool 审批
  └─ Ctrl+C / /cancel
  ↓ JSONL + 双向 JSON-RPC
App Server
  ├─ initialize / initialized
  ├─ thread/start、thread/list
  ├─ turn/start、turn/run、turn/cancel
  └─ Runtime 状态持久化
  ↓
Agent Loop
  ├─ ContextBuilder
  ├─ TokenBudget / ContextCompactor
  ├─ LLM Provider
  ├─ PermissionGate
  ├─ ToolRegistry
  └─ Event System
  ↓
Tool 与边界能力
  ├─ finance_monthly_summary
  ├─ list_files / read_file
  ├─ run_command
  ├─ WorkspaceSandbox
  └─ WorkspaceCommandRunner
```

一句话理解每一层：

| 层 | 负责什么 | 不负责什么 |
|---|---|---|
| Protocol | 消息长什么样、怎样传输 | 不处理业务 |
| Connection | 请求、响应和处理器怎样关联 | 不管理 Thread |
| App Server | 把 RPC 翻译成 Runtime 动作 | 不直接计算金额 |
| LifecycleStore | 保存 Thread、Turn、Item 事实 | 不决定模型看哪些消息 |
| Context | 构造本次模型真正看到的输入 | 不是完整事实库 |
| Agent Loop | 编排 Model、Permission、Tool 和终态 | 不实现具体 Tool 业务 |
| Tool | 做确定性业务或受控操作 | 不决定整个对话流程 |
| CLI | 用户交互和审批 | 不保存 Runtime 事实 |

## 三、三个最容易混淆的概念

### 1. LifecycleStore

`LifecycleStore` 是 Runtime 的事实源。

它保存：

```text
Thread
└─ Turn
   ├─ user_message
   ├─ tool_call
   ├─ tool_result
   └─ assistant_message
```

即使某些 Item 不再进入模型 Context，它们仍然保存在 LifecycleStore 中。

### 2. Message History

Message History 是从 Lifecycle Items 中派生出来的对话消息序列：

```ts
[
  { role: "user", text: "分析 7 月财务" },
  { role: "assistant", text: "7 月净现金流为……" },
  { role: "user", text: "刚才最大的支出是什么？" },
]
```

它不是新的事实源，只是对事实记录的一种投影。

### 3. Context

Context 是某一次模型请求真正收到的输入。

它可能等于完整 Message History，也可能已经经过：

```text
Token 估算
→ 触发 Compaction
→ 完整历史生成 Handoff Summary
→ 保留最近真实用户消息
→ 摘要作为最后一条 user 消息
→ 从 Checkpoint 继续追加
```

因此关系是：

```text
LifecycleStore（完整事实）
        ↓ 派生
Message History（对话视图）
        ↓ 预算、压缩、替换
Context（本次模型输入）
```

---

## 四、步骤 1：定义 JSON-RPC 消息

### 解决什么问题

CLI 和 App Server 是两个进程，它们需要一种统一的消息结构来表达：

- “请执行一个方法，并返回结果”。
- “通知你发生了一件事，不需要返回结果”。
- “请求成功了”。
- “请求失败了”。

### 功能

项目定义了四种消息：

```text
Request           有 id、有 method，需要 Response
Notification      无 id、有 method，不需要 Response
Success Response  有相同 id、有 result
Error Response    有相同 id、有 error
```

同时使用类型守卫校验进程外传入的 `unknown`，避免只相信 TypeScript 静态类型。

### 核心代码

```ts
export interface JsonRpcRequest<TParams = unknown> {
  id: JsonRpcId;
  method: string;
  params?: TParams;
}

export interface JsonRpcNotification<TParams = unknown> {
  method: string;
  params?: TParams;
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse;
```

运行时校验的关键不是判断“有哪些字段”，还要排除互相冲突的字段：

```ts
export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return (
    isObject(value) &&
    isJsonRpcId(value.id) &&
    typeof value.method === "string" &&
    !("result" in value) &&
    !("error" in value)
  );
}
```

### 核心文件与测试

- 源码：`src/protocol/json-rpc.ts`
- 测试：`tests/json-rpc-test.ts`

---

## 五、步骤 2：用 JSONL 给流分帧

### 解决什么问题

进程管道和网络传输只提供连续字节流，不保证一次 `data` 事件正好是一条 JSON：

```text
一次收到半条消息
一次收到三条消息
一条消息横跨多个 chunk
```

所以不能把每个 chunk 直接 `JSON.parse`。

### 功能

JSONL 规定“一行一条 JSON”：

```text
{"id":1,"method":"initialize"}\n
{"method":"initialized"}\n
```

`JsonlMessageBuffer` 持续缓存数据，只在遇到换行时取出完整消息。

### 核心代码

```ts
export class JsonlMessageBuffer {
  private buffer = "";

  push(chunk: string): JsonRpcMessage[] {
    this.buffer += chunk;
    const messages: JsonRpcMessage[] = [];

    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) break;

      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.trim().length > 0) {
        messages.push(decodeJsonRpcLine(line));
      }
    }

    return messages;
  }
}
```

### 核心文件与测试

- 源码：`src/protocol/jsonl.ts`
- 测试：`tests/jsonl-test.ts`

---

## 六、步骤 3：RequestMap 关联 Request 与 Response

### 解决什么问题

一个 Connection 可以同时发出多个请求。Response 到达时，必须根据 `id` 找到原来正在等待的 Promise。

### 功能

`RequestMap` 负责：

- 保存 `id → resolve/reject`。
- 收到成功响应时 resolve。
- 收到错误响应时 reject。
- 拒绝重复 ID。
- Connection 关闭时拒绝全部未完成请求。

### 核心代码

```ts
create(id: JsonRpcId): Promise<unknown> {
  if (this.pendingRequests.has(id)) {
    throw new Error(`Duplicate JSON-RPC id: ${id}`);
  }

  return new Promise((resolve, reject) => {
    this.pendingRequests.set(id, { resolve, reject });
  });
}

handleResponse(response: JsonRpcResponse): boolean {
  const pending = this.pendingRequests.get(response.id);
  if (pending === undefined) return false;

  this.pendingRequests.delete(response.id);
  "result" in response
    ? pending.resolve(response.result)
    : pending.reject(this.createRemoteError(response.error));
  return true;
}
```

### 核心文件与测试

- 源码：`src/protocol/request-map.ts`
- 测试：`tests/request-map-test.ts`

---

## 七、步骤 4：实现双向 Connection

### 解决什么问题

单向 Client → Server 不够。Tool 审批需要 App Server 主动向 CLI 提问：

```text
CLI → App Server：运行 Turn
App Server → CLI：是否允许执行 Tool？
CLI → App Server：allow / deny
```

因此连接两端都必须既能发 Request，也能注册 Request Handler。

### 功能

`JsonRpcConnection` 统一处理：

- `sendRequest()`。
- `sendNotification()`。
- `onRequest()`。
- `onNotification()`。
- JSONL chunk 接收。
- Request、Notification、Response 分流。
- 未知方法返回 `-32601`。

### 核心代码

```ts
sendRequest(method: string, params?: unknown): Promise<unknown> {
  const id = this.nextRequestId++;
  const request = { id, method, ...(params === undefined ? {} : { params }) };
  const resultPromise = this.requestMap.create(id);

  this.sendMessage(request);
  return resultPromise;
}

private async handleMessage(message: JsonRpcMessage): Promise<void> {
  if (isJsonRpcSuccessResponse(message) || isJsonRpcErrorResponse(message)) {
    this.requestMap.handleResponse(message);
  } else if (isJsonRpcRequest(message)) {
    await this.handleRequest(message);
  } else if (isJsonRpcNotification(message)) {
    await this.handleNotification(message);
  }
}
```

### 核心文件与测试

- 源码：`src/protocol/connection.ts`
- 测试：`tests/connection-test.ts`

关键测试直接证明 App Server 可以反向请求 Client 审批。

---

## 八、步骤 5：建立 App Server 协议入口

### 解决什么问题

Connection 只知道消息，不知道 Thread、Turn 或 Agent。需要一层把 RPC method 翻译为 Runtime 动作。

### 功能

App Server 当前注册：

```text
initialize
initialized
thread/start
thread/list
turn/start
turn/run
turn/cancel
finance/monthly-summary
```

握手完成前不能调用 Runtime 方法。App Server 的 `stdout` 只输出 JSONL，内部日志写入 `stderr`，避免污染协议流。

### 核心代码

```ts
connection.onRequest("turn/start", async (params) => {
  requireInitialized();
  const request = parseTurnStartParams(params);
  const turn = lifecycleStore.createTurn(request.threadId);
  const userMessage = lifecycleStore.appendItem(
    turn.id,
    "user_message",
    { text: request.input },
  );

  await saveState();
  events.emit({
    type: "turn/started",
    threadId: turn.threadId,
    turnId: turn.id,
  });

  return { turn, userMessage };
});
```

### 核心文件与测试

- 入口：`src/app-server/main.ts`
- Handler：`src/app-server/handlers.ts`
- 测试：`tests/app-server-handlers-test.ts`

---

## 九、步骤 6：建立 Thread、Turn、Item 生命周期

### 解决什么问题

聊天文本数组无法表达 Agent 的真实执行过程。我们需要知道：

- 哪些 Turn 属于同一个会话。
- 当前 Turn 是否正在运行。
- Tool 调用了什么。
- Turn 最终是成功、失败、取消还是超时。

### 功能

```text
Thread：持久会话容器
Turn：一次用户输入对应的一次 Agent 执行
Item：Turn 内产生的事实记录
```

Turn 状态：

```text
pending
in_progress
completed
failed
interrupted
timed_out
```

### 核心代码

```ts
appendItem(turnId: TurnId, type: ItemType, content: unknown): Item {
  const turn = this.requireTurn(turnId);

  if (turn.status !== "in_progress") {
    throw new LifecycleError(`Turn is not in progress: ${turnId}`);
  }

  const item: Item = {
    id: this.createId("item"),
    threadId: turn.threadId,
    turnId,
    type,
    content,
    createdAt: this.now(),
  };

  this.items.set(item.id, item);
  turn.itemIds.push(item.id);
  return item;
}
```

终态转换由 Store 统一控制，终态 Turn 不能继续追加 Item。

### 核心文件与测试

- 类型：`src/runtime/lifecycle.ts`
- Store：`src/runtime/lifecycle-store.ts`
- RPC DTO：`src/runtime/turn-start.ts`、`turn-run.ts`、`turn-cancel.ts`
- 测试：`tests/lifecycle-store-test.ts`

---

## 十、步骤 7：实现确定性金融 Tool

### 解决什么问题

LLM 不适合负责精确金额计算。真实验证中，模型曾把 `¥3,150.00` 错写成 `¥315.00`。

安全边界必须是：

```text
LLM：选择 Tool、提供参数、解释结果
TypeScript Tool：读取数据、计算金额、格式化金额
```

### 功能

`finance_monthly_summary` 支持：

- `YYYY-MM` 参数校验。
- 按月份和账户过滤。
- 只统计已入账流水。
- 汇总收入、支出、净现金流。
- 按分类汇总支出。
- 无数据月份返回零值。

金额统一使用最小货币单位“分”：

```text
收入：1,000,000 分 = ¥10,000.00
支出：  315,000 分 =  ¥3,150.00
净额：  685,000 分 =  ¥6,850.00
```

### 核心代码

```ts
for (const transaction of transactions) {
  if (!matchesRequest(transaction, request)) continue;
  validateTransactionAmount(transaction);

  if (transaction.kind === "income") {
    totalIncomeMinorUnits += transaction.amount.minorUnits;
  }

  if (transaction.kind === "expense") {
    totalExpenseMinorUnits += transaction.amount.minorUnits;
  }
}

return {
  totalIncome: createMoney(totalIncomeMinorUnits),
  totalExpense: createMoney(totalExpenseMinorUnits),
  netCashFlow: createMoney(totalIncomeMinorUnits - totalExpenseMinorUnits),
};
```

给模型的结果还增加了确定性 `display`，要求模型原样复制，不自行把“分”换算成“元”。

### 核心文件与测试

- 类型：`src/domains/finance/types.ts`
- 数据：`src/domains/finance/fixtures.ts`
- 计算：`src/domains/finance/summary.ts`
- Tool：`src/tools/finance-monthly-summary-tool.ts`
- 测试：`tests/finance-summary-test.ts`

---

## 十一、步骤 8：抽象 LLM Provider 并解析 SSE

### 解决什么问题

Agent Loop 不应该依赖 OpenAI HTTP 字段。它只应该知道：

```text
输入消息
可用 Tool 定义
最终文本
Function Call
公开的流式增量
```

### 功能

`LlmProvider` 隔离厂家协议，`OpenAiResponsesProvider` 负责：

- 把 Runtime 消息转成 Responses API input。
- 发送 Tool JSON Schema。
- 解析文本与 Function Call。
- 解析跨 chunk SSE。
- 回放 Tool Result。
- 兼容无状态中转端点。
- 传递 `AbortSignal`。
- 对临时网络错误、408、409、429、5xx 做有限重试。
- 对 401 等确定性错误不重试。

### 核心代码

```ts
export interface LlmProvider {
  createResponse(
    request: LlmCreateResponseRequest,
  ): Promise<LlmResponse>;
}

const response = await this.fetchWithRetry(
  `${this.baseUrl}/responses`,
  {
    method: "POST",
    headers: {
      authorization: `Bearer ${this.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  },
  request.signal,
);
```

SSE Reader 持续读取字节流，而不是等待整个 Response 完成：

```ts
while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  accumulator.push(
    decoder.decode(value, { stream: true }),
  );
}
```

### 核心文件与测试

- 抽象：`src/llm/types.ts`
- Provider：`src/llm/openai-responses.ts`
- 测试：`tests/openai-responses-test.ts`

测试使用 Fake Response，不依赖真实 Key。

---

## 十二、步骤 9：实现 Agent Loop

### 解决什么问题

一次 LLM 调用不等于 Agent。Agent 的关键是：模型可以选择 Tool，Runtime 执行 Tool，再把结果交回模型，直到得到最终答案。

### 功能

```text
Context
  ↓
Model round 0
  ├─ 没有 Function Call → 保存 assistant_message → completed
  └─ 有 Function Call
       ↓
     Permission
       ↓
     Tool Registry
       ↓
     保存 tool_call / tool_result
       ↓
     Model round 1
       ↓
     Final Answer
```

同时限制最大 Tool 轮数，防止模型无限循环。

### 核心代码

```ts
for (let round = 0; round <= this.maxToolRounds; round += 1) {
  if (response.functionCalls.length === 0) {
    const assistantMessage = this.lifecycleStore.appendItem(
      turnId,
      "assistant_message",
      { text: response.text },
    );
    const turn = this.lifecycleStore.completeTurn(turnId);
    return { turn, assistantMessage };
  }

  const toolOutputs = await this.executeFunctionCalls(
    turnId,
    response.functionCalls,
    signal,
  );

  response = await this.requestModel(turnId, round + 1, {
    input: toolOutputs,
    previousResponseId: response.id,
    tools: this.toolRegistry.getDefinitions(),
    signal,
  });
}
```

上面是便于理解的精简结构；当前真实实现把 Permission、Item 保存和 Event 发射显式写在循环中。

### 核心文件与测试

- 源码：`src/agent/agent-loop.ts`
- Scripted LLM：`tests/helpers/scripted-llm.ts`
- 测试：`tests/agent-loop-test.ts`

---

## 十三、步骤 10：建立 Event System

### 解决什么问题

模型和 Tool 可能运行数秒。CLI 不能一直没有反馈，也不能靠读取 Store 猜测执行状态。

### 功能

Runtime 发出真实事件：

```text
turn/started
model/started
context/compacted
reasoning/summary_delta
model/completed
permission/requested
permission/decided
tool/started
tool/completed
assistant/delta
turn/completed
turn/failed
turn/interrupted
turn/timed_out
```

事件只包含 Runtime 真实状态、模型公开的 reasoning summary 和 Assistant 文本增量，不展示或伪造隐藏思维链。

### 核心代码

```ts
export interface AgentEventSink {
  emit(event: AgentEvent): void;
}

this.events.emit({
  type: "tool/started",
  turnId,
  callId: functionCall.callId,
  toolName: functionCall.name,
});
```

App Server 把事件转成反向 JSON-RPC Notification：

```ts
connection.sendNotification("agent/event", event);
```

### 核心文件与测试

- 事件类型：`src/agent/events.ts`
- 推送组装：`src/app-server/main.ts`
- 渲染：`src/cli/main.ts`
- 测试：`tests/agent-events-test.ts`

---

## 十四、步骤 11：实现跨 Turn Context Builder

### 解决什么问题

同一个 Thread 能创建多个 Turn，不代表模型自动拥有记忆。

没有 Context Builder 时：

```text
Turn 1：分析 7 月财务
Turn 2：刚才最大的支出是什么？
```

第二个模型请求只看到 Turn 2，不知道“刚才”是什么。

### 功能

Context Builder：

- 找到当前 Turn 所属 Thread。
- 按 `thread.turnIds` 和 `turn.itemIds` 的确定性插入顺序读取历史。
- 只读取已完成 Turn。
- 第一版只投影 `user_message` 和 `assistant_message`。
- 跳过 failed、interrupted、timed_out Turn。
- 最后只追加一次当前 Turn 的 user message。
- 如果存在 Checkpoint，则从 Checkpoint 替换历史继续追加。

### 核心代码

```ts
for (const turnId of thread.turnIds) {
  const turn = this.requireTurn(turnId);

  if (turn.id === currentTurn.id) {
    messages.push(this.readCurrentUserMessage(turn));
    return messages;
  }

  if (turn.status !== "completed") continue;

  for (const item of this.lifecycleStore.getItemsForTurn(turn.id)) {
    const message = readHistoricalMessage(item);
    if (message !== undefined) messages.push(message);
  }
}
```

### 核心文件与测试

- 源码：`src/runtime/context-builder.ts`
- 测试：`tests/context-builder-test.ts`

---

## 十五、步骤 12：增加 Token Budget

### 解决什么问题

模型 Context Window 有上限。历史不能无限增长，也不能等到 API 返回 Context Window Exceeded 才处理。

### 功能

第一版 Token Budget 使用确定性近似算法：

- ASCII 大致按 4 个字符 1 Token。
- 中文等非 ASCII 大致按 1 个字符 1 Token。
- 每条 Message 增加固定结构开销。
- 达到阈值时返回 `shouldCompact: true`。

它只负责“测量和决策”，不负责删消息或写摘要。

### 核心代码

```ts
assess(messages: readonly LlmMessage[]): TokenBudgetAssessment {
  const estimatedTokens = estimateMessagesTokens(messages);

  return {
    estimatedTokens,
    remainingTokens: Math.max(
      0,
      this.maxContextTokens - estimatedTokens,
    ),
    shouldCompact:
      estimatedTokens >= this.compactThresholdTokens,
    maxContextTokens: this.maxContextTokens,
    compactThresholdTokens: this.compactThresholdTokens,
  };
}
```

### 核心文件与测试

- 源码：`src/runtime/token-budget.ts`
- 测试：`tests/token-budget-test.ts`

注意：这个估算器不是厂商 tokenizer，不能冒充精确计费结果。

---

## 十六、步骤 13：实现 Compaction 与 Checkpoint

### 解决什么问题

简单删除最旧消息会丢失长期目标和关键约束。Compaction 要把当前完整历史转换成“交给下一位模型继续工作的交接单”。

### 功能

```text
完整 Context
  ↓ Token 达到阈值
完整历史 + 合成压缩提示词 → 模型生成 Handoff Summary
真实 user 消息 → 从最新往前保留最多 20,000 Token
  ↓
最近真实 user 消息 + Codex 固定前缀 + Summary（最后一条 user 消息）
  ↓
记录 windowNumber 和 replacementMessages
```

关键安全规则：

- Compaction 不开放业务 Tool。
- 摘要模型返回 Function Call 时拒绝结果。
- 保留预算从最新真实用户消息向前装入，边界消息按 Token 截断。
- 再次压缩时根据固定前缀过滤旧摘要，避免摘要消息叠加。
- 新摘要必须作为替换历史最后一条 `user` 消息。
- 只有 Turn 成功完成后才安装 Checkpoint。
- 不删除 LifecycleStore 中的原始 Items。

### 核心代码

```ts
const response = await this.llm.createResponse({
  instructions:
    "Generate only the requested context checkpoint summary.",
  input: this.prepareSummaryInput(messages),
  tools: [],
  allowHostedTools: false,
  signal,
});

return [
  ...this.selectRetainedUserMessages(messages),
  {
    role: "user",
    text:
      `${CODEX_SUMMARY_PREFIX}\n` +
      response.text.trim(),
  },
];
```

完整算法、官方源码证据和逐步讲解见：`docs/Codex式Context-Compaction压缩算法-实现与源码导读.md`。

Checkpoint 使用窗口链记录替换历史：

```ts
const checkpoint: ContextCheckpoint = {
  id: this.createId(),
  threadId: input.threadId,
  throughTurnId: input.throughTurnId,
  windowNumber: checkpoints.length + 1,
  previousCheckpointId: previous?.id,
  replacementMessages: input.replacementMessages,
  beforeTokens: input.beforeTokens,
  afterTokens: input.afterTokens,
  createdAt: this.now(),
};
```

### 核心文件与测试

- 压缩：`src/runtime/context-compactor.ts`
- Checkpoint：`src/runtime/context-checkpoint-store.ts`
- 测试：`tests/context-compactor-test.ts`
- 测试：`tests/context-checkpoint-store-test.ts`

---

## 十七、步骤 14：用 Tool Registry 解耦 Agent Loop

### 解决什么问题

如果 Agent Loop 直接写：

```ts
if (toolName === "finance_monthly_summary") { ... }
```

每增加一个 Tool 都要修改 Agent 核心，最终会变成巨大的条件分支。

### 功能

Tool Registry 负责：

- 注册 Tool。
- 拒绝重名 Tool。
- 返回给模型的 Tool Definitions。
- 根据名称找到 Tool。
- 支持同步或异步执行。
- 把原始 `result` 与给模型看的 `modelOutput` 分开。
- 传递取消信号。

### 核心代码

```ts
async execute(
  name: string,
  argumentsJson: string,
  signal: AbortSignal,
): Promise<ToolRegistryExecution> {
  const tool = this.tools.get(name);
  if (tool === undefined) {
    throw new Error(`Unknown tool: ${name}`);
  }

  signal.throwIfAborted();
  const execution = await tool.execute(argumentsJson, { signal });
  signal.throwIfAborted();

  return {
    result: execution.result,
    output: JSON.stringify(execution.modelOutput),
  };
}
```

### 核心文件与测试

- Registry：`src/tools/tool-registry.ts`
- 金融适配器：`src/tools/finance-monthly-summary-tool.ts`
- 测试：`tests/tool-registry-test.ts`

---

## 十八、步骤 15：增加 Permission Runtime

### 解决什么问题

模型选择 Tool，不代表它自动获得执行权限。尤其是文件读取和命令执行，必须由用户明确批准。

### 功能

Permission 和 Tool 执行顺序：

```text
Model 返回 Function Call
  ↓
保存 tool_call
  ↓
App Server 反向请求 CLI：tool/request-permission
  ↓
用户输入 y/yes → allow
其他输入        → deny
  ↓
allow：执行 Tool
deny：不执行 Tool，把拒绝结果交回模型
```

### 核心代码

```ts
export interface PermissionGate {
  request(
    request: ToolPermissionRequest,
  ): Promise<ToolPermissionDecision>;
}

const response = await this.connection.sendRequest(
  "tool/request-permission",
  prompt,
);

return parseToolPermissionDecision(response);
```

CLI 采取安全默认值：

```ts
if (normalizedAnswer === "y" || normalizedAnswer === "yes") {
  return { decision: "allow" };
}

return { decision: "deny", reason: "user denied" };
```

### 核心文件与测试

- 抽象：`src/permissions/permission-gate.ts`
- RPC 适配：`src/permissions/json-rpc-permission-gate.ts`
- CLI Handler：`src/cli/permission-handler.ts`
- 测试：`tests/json-rpc-permission-gate-test.ts`
- 测试：`tests/cli-permission-handler-test.ts`

Permission 决定“能不能做”，Sandbox 决定“即使允许，最多能做到哪里”。两者不能互相替代。

---

## 十九、步骤 16：建立 Workspace Sandbox 和受控 Tool

### 解决什么问题

即使用户允许 `read_file`，也不能让模型读取 Workspace 外的任意文件；即使允许 `run_command`，也不能让模型拼接任意 Shell。

### 文件 Sandbox 功能

- 只接受相对路径。
- 使用 `resolve` 阻止 `..` 越界。
- 使用 `realpath` 阻止符号链接指向 Workspace 外。
- 限制文件大小。
- 拒绝包含 NUL 或无效 UTF-8 的二进制文件。
- 限制目录列表条数。
- 越界符号链接不会暴露外部目标信息。

### 文件 Sandbox 核心代码

```ts
const candidatePath = resolve(this.rootPath, requestedPath);
if (!isWithin(this.rootPath, candidatePath)) {
  throw new Error("Path escapes workspace");
}

const realCandidatePath = await realpath(candidatePath);
if (!isWithin(this.rootPath, realCandidatePath)) {
  throw new Error(
    "Path escapes workspace through symbolic link",
  );
}
```

`list_files` 和 `read_file` 不直接访问 `node:fs`，统一经过 `WorkspaceSandbox`。

### 命令 Sandbox 功能

`run_command` 不接受：

```text
executable
args
shell 字符串
重定向
管道
额外参数
```

模型只能从预注册配方中选择：

```text
check → npm run check
test  → npm test
```

Runner 还提供：

- 固定 `cwd`。
- 过滤后的环境变量。
- `shell: false`。
- 输出大小上限。
- 执行超时。
- AbortSignal 取消。
- 隐藏 Windows 子进程窗口。

### 命令 Sandbox 核心代码

```ts
const recipe = this.recipes[command];
if (recipe === undefined) {
  throw new Error(`Command recipe is not allowed: ${command}`);
}

const child = spawn(
  recipe.executable,
  [...recipe.arguments],
  {
    cwd: this.workspacePath,
    env: createFilteredEnvironment(),
    shell: false,
    windowsHide: true,
  },
);
```

### 核心文件与测试

- 文件边界：`src/sandbox/workspace-sandbox.ts`
- 文件 Tool：`src/tools/workspace-tools.ts`
- 命令边界：`src/sandbox/workspace-command-runner.ts`
- 命令 Tool：`src/tools/run-command-tool.ts`
- 测试：`tests/workspace-sandbox-test.ts`
- 测试：`tests/workspace-tools-test.ts`
- 测试：`tests/workspace-command-runner-test.ts`
- 测试：`tests/run-command-tool-test.ts`

当前 Sandbox 是教学级进程内边界，不等价于容器、虚拟机或操作系统隔离。

---

## 二十、步骤 17：实现 Runtime 原子持久化

### 解决什么问题

如果 Thread 和 Checkpoint 只存在内存中，退出 CLI 后所有历史都会消失。

直接覆盖 JSON 文件也不安全：进程可能在写到一半时崩溃，留下损坏快照。

### 功能

持久化文件同时保存：

```text
LifecycleSnapshot
ContextCheckpointSnapshot
```

写入流程：

```text
生成版本化 Snapshot
  ↓
写入同目录唯一临时文件
  ↓
rename 替换正式状态文件
```

并用 Promise Queue 串行化多个保存请求，避免写入竞态。

### 核心代码

```ts
const temporaryPath = join(
  stateDirectory,
  `.${basename(this.statePath)}.${process.pid}.${this.saveSequence}.tmp`,
);

await writeFile(temporaryPath, text, {
  encoding: "utf8",
  flag: "wx",
});
await rename(temporaryPath, this.statePath);
```

读取时会完整验证版本、Thread/Turn/Item 引用关系和 Checkpoint 窗口链；损坏文件直接拒绝，不静默丢数据。

### 核心文件与测试

- 持久化：`src/runtime/json-file-runtime-persistence.ts`
- Lifecycle Snapshot：`src/runtime/lifecycle-store.ts`
- Checkpoint Snapshot：`src/runtime/context-checkpoint-store.ts`
- 测试：`tests/json-file-runtime-persistence-test.ts`
- 测试：`tests/runtime-state-snapshot-test.ts`

---

## 二十一、步骤 18：Cancel、Timeout、Retry、Resume

### 1. Cancel

每个正在运行的 Turn 对应一个 `AbortController`：

```ts
const controller = new AbortController();
this.activeTurns.set(turnId, controller);

cancel(turnId: TurnId): boolean {
  const controller = this.activeTurns.get(turnId);
  if (controller === undefined) return false;

  controller.abort(new TurnCancelledError(turnId));
  return true;
}
```

同一个 `signal` 传递到：

```text
LLM fetch
Permission 等待
Tool Registry
WorkspaceCommandRunner
```

这样取消不是只改一个状态，而是真正中断正在等待的操作。

### 2. Timeout

Turn 总时限到达后，Runtime 使用同一取消通道：

```ts
const timeout = setTimeout(() => {
  controller.abort(
    new TurnTimeoutError(turnId, this.turnTimeoutMs),
  );
}, this.turnTimeoutMs);
```

取消和超时分别进入：

```text
interrupted
timed_out
```

### 3. Retry

Provider 只重试尚未产生 Tool 副作用的模型 HTTP 请求。

```ts
for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
  const response = await this.fetchImpl(url, { ...init, signal });

  if (
    !response.ok &&
    isRetryableStatus(response.status) &&
    attempt < this.maxRetries
  ) {
    await this.waitBeforeRetry(attempt, externalSignal);
    continue;
  }

  return response;
}
```

退避时间为有限指数退避：

```text
baseDelay × 2^attempt
```

Runtime 不自动重放已经执行过的 Tool，避免重复副作用。

### 4. Resume

这里的 Resume 是恢复 Thread，不是恢复模型中间字节。

进程重启后，旧的执行体已经不存在，因此遗留的 `in_progress` Turn 会被归一化为 `interrupted`：

```ts
recoverInProgressTurns(): Turn[] {
  for (const turn of this.turns.values()) {
    if (turn.status !== "in_progress") continue;

    turn.status = "interrupted";
    turn.completedAt = this.now();
    recovered.push(turn);
  }

  return recovered;
}
```

### 核心文件与测试

- Agent 取消/超时：`src/agent/agent-loop.ts`
- RPC：`src/runtime/turn-cancel.ts`
- Provider Retry：`src/llm/openai-responses.ts`
- 重启恢复：`src/runtime/lifecycle-store.ts`
- 测试：`tests/turn-cancel-test.ts`
- 测试：`tests/agent-loop-test.ts`
- 测试：`tests/openai-responses-test.ts`
- 测试：`tests/json-file-runtime-persistence-test.ts`

---

## 二十二、步骤 19：CLI 产品化

### 解决什么问题

早期 CLI 是 Runtime 调试 Harness，直接显示大量内部 ID 和日志。学习链路稳定后，需要一个默认简洁、必要时仍能完整调试的产品入口。

### 功能

默认交互：

```text
You › 分析 2026 年 7 月财务
Thinking…
Assistant › ……
```

支持命令：

```text
/help     查看帮助
/status   查看 Thread、Turn 和 Queue
/threads  列出持久化 Thread
/new      创建新 Thread
/cancel   取消当前 Turn
/exit     安全退出
```

启动参数：

```text
--debug
--help
--version
```

### FIFO 消息队列

单 Agent 同一时间只运行一个 Turn。运行期间继续输入的普通消息进入 FIFO：

```ts
enqueue(message: string): number {
  this.messages.push(message);
  return this.messages.length;
}

dequeue(): string | undefined {
  return this.messages.shift();
}
```

上一轮完成后，再按顺序启动下一轮，因此下一轮 Context 已经包含上一轮结果。

### 唯一 stdin 消费者

CLI 不能让主命令循环和 Permission Handler 同时读取 stdin，否则会出现输入竞争。

解决方法是只有 readline 主循环读取输入，再交给 `CliInputRouter`：

```ts
const routed = inputRouter.consumeLine(line);

if (routed.handled) {
  if (routed.cancelRequested && activeTurn !== undefined) {
    await requestTurnCancel(connection, activeTurn);
  }
  continue;
}
```

### Ctrl+C

```text
运行中 Ctrl+C → 拒绝挂起审批 → turn/cancel
空闲时 Ctrl+C → 安全退出
```

### 产品模式与调试模式

```ts
child.stderr.on("data", (chunk: string) => {
  if (options.debug) {
    process.stderr.write(chunk);
  }
});
```

内部日志没有删除，只在默认产品模式隐藏。

### 真正可执行入口

`package.json` 声明：

```json
{
  "name": "god-agent",
  "bin": {
    "god-agent": "bin/god-agent.js"
  }
}
```

`bin/god-agent.js` 使用 Node 启动 TypeScript CLI，并原样传递参数与退出码。

### 核心文件与测试

- 主入口：`src/cli/main.ts`
- 输入路由：`src/cli/input-router.ts`
- FIFO：`src/cli/message-queue.ts`
- Ctrl+C：`src/cli/interrupt-handler.ts`
- 参数：`src/cli/options.ts`
- 审批：`src/cli/permission-handler.ts`
- 可执行文件：`bin/god-agent.js`
- 端到端测试：`tests/cli-smoke-test.ts`
- 其余测试：`tests/cli-*-test.ts`

---

## 二十三、四条完整运行链路

### 1. 正常 Tool Calling

```text
用户输入
→ CLI turn/start
→ App Server 创建 Turn + user_message
→ CLI turn/run
→ ContextBuilder 构建消息
→ TokenBudget 检查
→ LLM 返回 finance_monthly_summary
→ Permission allow
→ Tool 用整数“分”计算
→ 保存 tool_call + tool_result
→ Tool Result 回放给 LLM
→ LLM 返回最终文本
→ 保存 assistant_message
→ Turn completed
→ 持久化 Runtime
```

### 2. Permission 拒绝

```text
LLM 请求 Tool
→ App Server 反向询问 CLI
→ 用户拒绝
→ Tool 不执行
→ 保存 denied tool_result
→ denied 结果交回 LLM
→ LLM 向用户解释未执行原因
```

### 3. Cancel

```text
Turn 正在等待 LLM / Permission / Tool
→ 用户输入 /cancel 或 Ctrl+C
→ CLI 调用 turn/cancel
→ AgentLoop.abort()
→ AbortSignal 传播到底层
→ 当前操作中断
→ Turn interrupted
→ 状态落盘
```

### 4. 重启恢复

```text
CLI 启动 App Server
→ 读取 Runtime JSON
→ 校验 Snapshot
→ 恢复 LifecycleStore + CheckpointStore
→ 遗留 in_progress → interrupted
→ CLI thread/list
→ 自动选择最近 active Thread
→ 后续 Turn 从历史 Context 继续
```

---

## 二十四、测试是怎样分层证明系统的

测试不是只看最终输出，而是逐层证明边界。

| 测试层 | 证明什么 |
|---|---|
| Protocol | 消息分类、JSONL 分帧、Request ID 关联 |
| Connection | 双向 Request、Notification、未知方法 |
| Lifecycle | 状态转换、关联关系、终态保护 |
| Finance | 金额和分类汇总由确定性代码产生 |
| Provider | SSE、Function Call、取消、重试 |
| Context | 跨 Turn 顺序、当前消息不重复、Checkpoint 续接 |
| Tool/Permission | Registry 解耦、拒绝时不执行 Tool |
| Sandbox | 路径越界、符号链接、容量、命令白名单 |
| Persistence | 原子写入、损坏拒绝、重启恢复 |
| Agent Loop | Model → Tool → Model、失败、取消、超时 |
| CLI Smoke | 真进程、假 HTTP 模型、FIFO、恢复、/cancel、安全退出 |

CLI Smoke Test 使用本机临时 HTTP 假模型和明确的测试占位 Key，不读取或使用真实 Key。

验证命令：

```powershell
cd D:\练手\agent-learn

npm run check
npm test
node bin/god-agent.js --help
node bin/god-agent.js --version
```

当前结果：

```text
TypeScript check  通过
Tests             123/123 通过
CLI help          通过
CLI version       god-agent 1.0.0
```

---

## 二十五、这套实现最重要的设计原则

### 1. 进程外数据永远是 unknown

JSON、RPC params、RPC result、LLM Response 都必须做运行时校验。

### 2. 事实与模型输入分离

LifecycleStore 保存完整事实；Context Builder 决定模型这一次看什么。

### 3. 金额不能交给 LLM 计算

金额由确定性 TypeScript Tool 计算和格式化，LLM 只选择和解释。

### 4. Permission 与 Sandbox 分层

```text
Permission：用户是否同意这次操作
Sandbox：即使同意，操作仍被限制在安全边界内
```

### 5. Registry 只做注册和分发

Tool Registry 不承担 Permission 或 Sandbox 职责，避免所有边界耦合成一个巨型组件。

### 6. Compaction 不删除事实

它只替换模型 Context，原始 Lifecycle Items 仍然保留。

### 7. Retry 不重放 Tool

Provider 可以重试尚未产生副作用的 HTTP 请求；Runtime 不自动重复执行 Tool。

### 8. Resume 不伪装成续跑中间字节

重启恢复 Thread 和结构化状态，但不会假装能从已经消失的 LLM 流中间继续。

### 9. 默认产品模式简洁，调试能力仍保留

`--debug` 是学习和排障入口，不需要为了产品化删除底层可观察性。

---

## 二十六、当前能力边界

### 已经适合学习和本地验证

- 理解 Codex-like 单 Agent Runtime 主链路。
- 验证跨 Turn Context 和 Compaction。
- 演示双向 RPC 审批。
- 在授权 Workspace 内读取文本和执行预注册检查。
- 观察取消、超时、重试和恢复。

### 还不能称为生产级

- Token 估算不是模型官方 tokenizer。
- Compaction 摘要仍是有损的。
- Sandbox 不是 OS 级隔离。
- JSON 文件不适合多进程并发写入。
- 没有 Tool 幂等键和副作用账本。
- 没有生产级审计日志、鉴权和租户隔离。
- 金融能力仅使用模拟数据，不能执行真实资金操作。

---

## 二十七、推荐复习顺序

第一遍只看调用链：

```text
CLI → Connection → App Server → Agent Loop → LLM / Tool
```

第二遍看状态：

```text
Thread → Turn → Item → Persistence
```

第三遍看上下文：

```text
LifecycleStore → ContextBuilder → TokenBudget
→ ContextCompactor → ContextCheckpointStore
```

第四遍看安全：

```text
ToolRegistry → PermissionGate → Sandbox → AbortSignal
```

第五遍从测试反推实现：

```text
先读测试期望
→ 再读对应核心类
→ 最后沿 App Server / Agent Loop 看集成
```

## 二十八、最终记忆

一个单 Agent Runtime 的核心不是“调用一次 LLM”，而是建立一套可验证的循环：

```text
接收用户输入
→ 保存生命周期事实
→ 构建受预算约束的 Context
→ 请求模型
→ 审批并安全执行 Tool
→ 保存 Tool 事实
→ 把结果交回模型
→ 流式输出最终答案
→ 进入明确终态
→ 原子保存并支持恢复
```

真正重要的不是代码量，而是每一层都有清晰职责和边界：

```text
协议不懂业务
Store 不决定 Context
模型不计算金额
Registry 不冒充 Permission
Permission 不冒充 Sandbox
Compaction 不删除事实
CLI 不成为 Runtime 事实源
```

做到这些之后，我们实现的才不是一个“套壳聊天脚本”，而是一个可以继续演进的单 Agent Runtime。
