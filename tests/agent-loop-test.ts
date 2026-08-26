import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentLoop,
  TurnCancelledError,
  TurnTimeoutError,
} from "../src/agent/agent-loop.js";
import {
  LifecycleStore,
} from "../src/runtime/lifecycle-store.js";
import {
  ScriptedLlmProvider,
} from "./helpers/scripted-llm.js";
import type {
  AgentEvent,
} from "../src/agent/events.js";
import type { ExecutionLeaseCoordinator } from "../src/runtime/execution-lease-coordinator.js";
import { ModelInvocationStore } from "../src/runtime/model-invocation-store.js";
import { ToolInvocationStore } from "../src/runtime/tool-invocation-store.js";
import type {
  LlmCreateResponseRequest,
} from "../src/llm/types.js";
import {
  CODEX_SUMMARY_PREFIX,
  ContextCompactor,
} from "../src/runtime/context-compactor.js";
import {
  ContextCheckpointStore,
} from "../src/runtime/context-checkpoint-store.js";
import {
  InputItemBudgetExceededError,
  ItemBudget,
} from "../src/runtime/item-budget.js";
import {
  TokenBudget,
} from "../src/runtime/token-budget.js";
import type {
  TokenCounter,
} from "../src/runtime/token-counter.js";
import {
  ToolRegistry,
  type AgentTool,
} from "../src/tools/tool-registry.js";

const ONE_TOKEN_PER_MESSAGE_COUNTER: TokenCounter = {
  countText: () => 1,
  countMessages: (messages) => messages.length,
};

function createTurnWithUserMessage() {
  const store = new LifecycleStore({
    now: () => "2026-08-01T09:00:00.000Z",
  });

  const thread = store.createThread();
  const turn = store.createTurn(thread.id);

  store.appendItem(
    turn.id,
    "user_message",
    {
      text: "分析 2026 年 7 月的财务情况",
    },
  );

  return {
    store,
    turn,
  };
}

test("Agent Loop 完成 Model → Tool → Model", async () => {
  const { store, turn } = createTurnWithUserMessage();

  const llm = new ScriptedLlmProvider([
    {
      id: "response-tool-call",
      text: "",
      functionCalls: [
        {
          callId: "call-finance-1",
          name: "finance_monthly_summary",
          arguments: '{"period":"2026-07"}',
        },
      ],
    },
    {
      id: "response-final",
      text:
        "7 月净现金流为 6850 元，整体保持正向。",
      functionCalls: [],
    },
  ]);
  const events: AgentEvent[] = [];

  const agentLoop = new AgentLoop({
    lifecycleStore: store,
    llm,
    events: {
      emit: (event) => events.push(event),
    },
  });

  const result = await agentLoop.run(turn.id);

  assert.equal(result.turn.status, "completed");
  assert.equal(
    result.assistantMessage.type,
    "assistant_message",
  );
  assert.deepEqual(result.assistantMessage.content, {
    text: "7 月净现金流为 6850 元，整体保持正向。",
  });

  const items = store.getItemsForTurn(turn.id);

  assert.deepEqual(
    items.map((item) => item.type),
    [
      "user_message",
      "tool_call",
      "tool_result",
      "assistant_message",
    ],
  );

  assert.equal(llm.requests.length, 2);
  for (const request of llm.requests) {
    assert.match(
      request.instructions,
      /准备检查什么.*这一步要确认什么/s,
    );
    assert.match(
      request.instructions,
      /目前发现.*已经锁定根因/s,
    );
    assert.match(
      request.instructions,
      /边界、反例或回归验证/s,
    );
    assert.match(
      request.instructions,
      /不要输出 Chain-of-Thought.*原始 Tool 参数.*Key/s,
    );
    assert.match(
      request.instructions,
      /不要为了展示过程而编造发现、证据或根因/s,
    );
  }
  assert.equal(
    llm.requests[1]?.previousResponseId,
    "response-tool-call",
  );

  const secondInput = llm.requests[1]?.input;
  assert.ok(Array.isArray(secondInput));
  assert.match(secondInput[0]?.output ?? "", /685000/);
  assert.match(
    secondInput[0]?.output ?? "",
    /"display":"¥3,150\.00"/,
  );
  assert.match(
    secondInput[0]?.output ?? "",
    /"display":"¥6,850\.00"/,
  );

  assert.deepEqual(
    events.map((event) => event.type),
    [
      "model/started",
      "model/output_text_completed",
      "model/completed",
      "permission/requested",
      "permission/decided",
      "tool/started",
      "tool/completed",
      "model/started",
      "model/output_text_delta",
      "model/output_text_completed",
      "model/completed",
      "turn/completed",
    ],
  );

  const publicOutputs = events.filter(
    (event) => event.type === "model/output_text_completed",
  );
  assert.deepEqual(publicOutputs, [
    {
      type: "model/output_text_completed",
      turnId: turn.id,
      round: 0,
      classification: "commentary",
      text: "正在检查相关实现……",
    },
    {
      type: "model/output_text_completed",
      turnId: turn.id,
      round: 1,
      classification: "assistant",
      text: "7 月净现金流为 6850 元，整体保持正向。",
    },
  ]);
  const fallback = publicOutputs[0];
  assert.equal(fallback?.type, "model/output_text_completed");
  if (fallback?.type === "model/output_text_completed") {
    assert.doesNotMatch(
      fallback.text,
      /根因|已经确认|参数|result|period|finance_monthly_summary/i,
    );
  }
});

test("Tool 前公开排查文本归类为 Commentary，最终回答只归类一次", async () => {
  const { store, turn } = createTurnWithUserMessage();
  const llm = new ScriptedLlmProvider([
    {
      id: "response-public-investigation",
      text: "我先检查确定性账本汇总，确认 7 月收入、支出和净现金流。",
      functionCalls: [
        {
          callId: "call-public-investigation",
          name: "finance_monthly_summary",
          arguments: '{"period":"2026-07"}',
        },
      ],
    },
    {
      id: "response-public-final",
      text: "结论：7 月净现金流保持正向。",
      functionCalls: [],
    },
  ]);
  const events: AgentEvent[] = [];
  const agentLoop = new AgentLoop({
    lifecycleStore: store,
    llm,
    events: { emit: (event) => events.push(event) },
  });

  const result = await agentLoop.run(turn.id);
  const publicOutputs = events.filter(
    (event) => event.type === "model/output_text_completed",
  );

  assert.deepEqual(publicOutputs, [
    {
      type: "model/output_text_completed",
      turnId: turn.id,
      round: 0,
      classification: "commentary",
      text: "我先检查确定性账本汇总，确认 7 月收入、支出和净现金流。",
    },
    {
      type: "model/output_text_completed",
      turnId: turn.id,
      round: 1,
      classification: "assistant",
      text: "结论：7 月净现金流保持正向。",
    },
  ]);
  assert.equal(
    publicOutputs.filter((event) =>
      event.type === "model/output_text_completed" &&
      event.classification === "assistant"
    ).length,
    1,
  );
  assert.deepEqual(result.assistantMessage.content, {
    text: "结论：7 月净现金流保持正向。",
  });
});

test("Agent Loop 按顺序转发公开推理摘要事件", async () => {
  const { store, turn } = createTurnWithUserMessage();
  const events: AgentEvent[] = [];
  const llm = {
    async createResponse(request: LlmCreateResponseRequest) {
      request.onEvent?.({
        type: "reasoning_summary_part_added",
        summaryIndex: 0,
      });
      request.onEvent?.({
        type: "reasoning_summary_delta",
        summaryIndex: 0,
        delta: "**检查账本**\n\n先取得确定性金额。",
      });
      request.onEvent?.({
        type: "reasoning_summary_completed",
      });
      request.onEvent?.({
        type: "web_search_started",
        callId: "ws-1",
      });
      request.onEvent?.({
        type: "web_search_searching",
        callId: "ws-1",
      });
      request.onEvent?.({
        type: "web_search_completed",
        callId: "ws-1",
        query: "OpenAI Responses API",
      });
      request.onEvent?.({
        type: "output_text_delta",
        delta: "分析完成。",
      });
      request.onEvent?.({
        type: "url_citation_added",
        title: "OpenAI Developers",
        url: "https://developers.openai.com/",
        startIndex: 0,
        endIndex: 5,
      });

      return {
        id: "response-reasoning",
        text: "分析完成。",
        functionCalls: [],
      };
    },
  };
  const agentLoop = new AgentLoop({
    lifecycleStore: store,
    llm,
    events: {
      emit: (event) => events.push(event),
    },
  });

  await agentLoop.run(turn.id);

  assert.deepEqual(
    events
      .filter((event) =>
        event.type.startsWith("reasoning/") ||
        event.type.startsWith("web_search/") ||
        event.type.startsWith("citation/") ||
        event.type === "model/output_text_delta" ||
        event.type === "model/output_text_completed",
      )
      .map((event) => event.type),
    [
      "reasoning/summary_part_added",
      "reasoning/summary_delta",
      "reasoning/summary_completed",
      "web_search/started",
      "web_search/searching",
      "web_search/completed",
      "model/output_text_delta",
      "citation/url_added",
      "model/output_text_completed",
    ],
  );

  assert.deepEqual(
    events.find(
      (event) => event.type === "reasoning/summary_delta",
    ),
    {
      type: "reasoning/summary_delta",
      turnId: turn.id,
      round: 0,
      summaryIndex: 0,
      delta: "**检查账本**\n\n先取得确定性金额。",
    },
  );
});

test("Agent Loop 通过 Registry 执行注入的非金融 Tool", async () => {
  const { store, turn } = createTurnWithUserMessage();
  const echoTool: AgentTool = {
    definition: {
      name: "echo",
      description: "测试回显",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
        },
        required: ["text"],
      },
    },
    async execute(argumentsJson) {
      const input = JSON.parse(argumentsJson) as {
        text: string;
      };

      // 文件与命令 Tool 都是异步 I/O；此处锁定 Agent Loop 会等待执行完成。
      await Promise.resolve();

      return {
        result: { echoed: input.text },
        modelOutput: { safeEcho: input.text },
      };
    },
  };
  const llm = new ScriptedLlmProvider([
    {
      id: "response-echo-call",
      text: "",
      functionCalls: [
        {
          callId: "call-echo-1",
          name: "echo",
          arguments: '{"text":"hello"}',
        },
      ],
    },
    {
      id: "response-echo-final",
      text: "echo 完成",
      functionCalls: [],
    },
  ]);
  const agentLoop = new AgentLoop({
    lifecycleStore: store,
    llm,
    toolRegistry: new ToolRegistry([echoTool]),
  });

  await agentLoop.run(turn.id);

  assert.deepEqual(llm.requests[0]?.tools, [
    echoTool.definition,
  ]);

  const items = store.getItemsForTurn(turn.id);
  assert.deepEqual(items[2]?.content, {
    callId: "call-echo-1",
    name: "echo",
    result: {
      echoed: "hello",
    },
  });

  const toolOutput = llm.requests[1]?.input;
  assert.ok(Array.isArray(toolOutput));
  assert.equal(
    toolOutput[0]?.output,
    '{"safeEcho":"hello"}',
  );
});

test("预授权只读 Tool 不触发 PermissionGate", async () => {
  const { store, turn } = createTurnWithUserMessage();
  const llm = new ScriptedLlmProvider([
    {
      id: "response-read-skill",
      text: "",
      functionCalls: [
        {
          callId: "call-read-skill",
          name: "read_skill",
          arguments: '{"name":"finance-analysis"}',
        },
      ],
    },
    {
      id: "response-after-skill",
      text: "已按 Skill 执行",
      functionCalls: [],
    },
  ]);
  const registry = new ToolRegistry([
    {
      requiresPermission: false,
      riskLevel: "read",
      definition: {
        name: "read_skill",
        description: "读取 Skill",
        parameters: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
      execute: () => ({
        result: { instructions: "说明" },
        modelOutput: { instructions: "说明" },
      }),
    },
  ]);
  const agentLoop = new AgentLoop({
    lifecycleStore: store,
    llm,
    toolRegistry: registry,
    additionalInstructions:
      "可用 Skills：finance-analysis；需要时先调用 read_skill。",
    permissionGate: {
      request: () => {
        throw new Error("PermissionGate must not be called");
      },
    },
  });

  const result = await agentLoop.run(turn.id);

  assert.deepEqual(result.assistantMessage.content, {
    text: "已按 Skill 执行",
  });
  assert.match(
    llm.requests[0]?.instructions ?? "",
    /finance-analysis.*read_skill/,
  );
});

test("Permission 拒绝时不执行 Tool 并把拒绝结果交回模型", async () => {
  const { store, turn } = createTurnWithUserMessage();
  let executionCount = 0;
  const protectedTool: AgentTool = {
    definition: {
      name: "protected_tool",
      description: "需要审批的测试工具",
      parameters: { type: "object" },
    },
    execute() {
      executionCount += 1;
      return {
        result: { shouldNotExist: true },
        modelOutput: { shouldNotExist: true },
      };
    },
  };
  const llm = new ScriptedLlmProvider([
    {
      id: "response-protected-call",
      text: "",
      functionCalls: [
        {
          callId: "call-protected-1",
          name: "protected_tool",
          arguments: "{}",
        },
      ],
    },
    {
      id: "response-after-denial",
      text: "用户拒绝了工具执行。",
      functionCalls: [],
    },
  ]);
  const events: AgentEvent[] = [];
  const agentLoop = new AgentLoop({
    lifecycleStore: store,
    llm,
    toolRegistry: new ToolRegistry([protectedTool]),
    permissionGate: {
      request: async () => ({
        decision: "deny",
        reason: "user denied",
      }),
    },
    events: {
      emit: (event) => events.push(event),
    },
  });

  const result = await agentLoop.run(turn.id);

  assert.equal(executionCount, 0);
  assert.equal(result.turn.status, "completed");

  const items = store.getItemsForTurn(turn.id);
  assert.deepEqual(items[2]?.content, {
    callId: "call-protected-1",
    name: "protected_tool",
    result: {
      status: "denied",
      reason: "user denied",
    },
  });

  const continuationInput = llm.requests[1]?.input;
  assert.ok(Array.isArray(continuationInput));
  assert.equal(
    continuationInput[0]?.output,
    '{"status":"denied","reason":"user denied"}',
  );
  assert.deepEqual(
    events
      .filter((event) => event.type.startsWith("permission/"))
      .map((event) => event.type),
    ["permission/requested", "permission/decided"],
  );
});

test("第二个 Turn 的模型请求包含已完成对话历史", async () => {
  const store = new LifecycleStore({
    now: () => "2026-08-02T09:00:00.000Z",
  });
  const thread = store.createThread();

  const firstTurn = store.createTurn(thread.id);
  store.appendItem(firstTurn.id, "user_message", {
    text: "分析 2026 年 7 月财务",
  });

  const llm = new ScriptedLlmProvider([
    {
      id: "response-first-turn",
      text: "净现金流为 ¥6,850.00",
      functionCalls: [],
    },
    {
      id: "response-second-turn",
      text: "最大支出是住房 ¥3,000.00",
      functionCalls: [],
    },
  ]);
  const agentLoop = new AgentLoop({
    lifecycleStore: store,
    llm,
  });

  await agentLoop.run(firstTurn.id);

  const secondTurn = store.createTurn(thread.id);
  store.appendItem(secondTurn.id, "user_message", {
    text: "刚才最大的支出是什么？",
  });

  await agentLoop.run(secondTurn.id);

  assert.deepEqual(llm.requests[1]?.input, [
    {
      role: "user",
      text: "分析 2026 年 7 月财务",
    },
    {
      role: "assistant",
      text: "净现金流为 ¥6,850.00",
    },
    {
      role: "user",
      text: "刚才最大的支出是什么？",
    },
  ]);
});

test("达到 Token 阈值时先压缩再请求业务模型", async () => {
  const oneTokenPerMessageCounter: TokenCounter = {
    countText: () => 1,
    countMessages: (messages) => messages.length,
  };
  const store = new LifecycleStore({
    now: () => "2026-08-02T09:00:00.000Z",
  });
  const thread = store.createThread();
  const previousTurn = store.createTurn(thread.id);
  store.appendItem(previousTurn.id, "user_message", {
    text: "甲",
  });
  store.appendItem(previousTurn.id, "assistant_message", {
    text: "乙",
  });
  store.completeTurn(previousTurn.id);

  const currentTurn = store.createTurn(thread.id);
  store.appendItem(currentTurn.id, "user_message", {
    text: "丙",
  });

  const llm = new ScriptedLlmProvider([
    {
      id: "response-checkpoint",
      text: "旧对话摘要",
      functionCalls: [],
    },
    {
      id: "response-final-after-compaction",
      text: "压缩后继续回答",
      functionCalls: [],
    },
  ]);
  const events: AgentEvent[] = [];
  const checkpointStore = new ContextCheckpointStore();
  const agentLoop = new AgentLoop({
    lifecycleStore: store,
    llm,
    tokenBudget: new TokenBudget({
      maxContextTokens: 20,
      compactThresholdTokens: 3,
      tokenCounter: oneTokenPerMessageCounter,
    }),
    contextCompactor: new ContextCompactor({
      llm,
      retainedUserMessageTokens: 1,
      tokenCounter: oneTokenPerMessageCounter,
    }),
    contextCheckpointStore: checkpointStore,
    events: {
      emit: (event) => events.push(event),
    },
  });

  await agentLoop.run(currentTurn.id);

  assert.equal(llm.requests.length, 2);
  assert.deepEqual(llm.requests[1]?.input, [
    {
      role: "user",
      text: "丙",
    },
    {
      role: "user",
      text:
        "Another language model started to solve this problem " +
        "and produced a summary of its thinking process. You also " +
        "have access to the state of the tools that were used by " +
        "that language model. Use this to build on the work that " +
        "has already been done and avoid duplicating work. Here is " +
        "the summary produced by the other language model, use the " +
        "information in this summary to assist with your own " +
        "analysis:\n旧对话摘要",
    },
  ]);

  const compactionEvent = events.find(
    (event) => event.type === "context/compacted",
  );

  assert.deepEqual(compactionEvent, {
    type: "context/compacted",
    turnId: currentTurn.id,
    beforeTokens: 3,
    afterTokens: 2,
  });

  assert.deepEqual(
    checkpointStore.getLatest(thread.id)?.replacementMessages,
    [
      {
        role: "user",
        text: "丙",
      },
      {
        role: "user",
        text:
          "Another language model started to solve this problem " +
          "and produced a summary of its thinking process. You also " +
          "have access to the state of the tools that were used by " +
          "that language model. Use this to build on the work that " +
          "has already been done and avoid duplicating work. Here is " +
          "the summary produced by the other language model, use the " +
          "information in this summary to assist with your own " +
          "analysis:\n旧对话摘要",
      },
    ],
  );
});

test("达到 Item 阈值且 Token 未达阈值时仍先压缩", async () => {
  const oneTokenPerMessageCounter: TokenCounter = {
    countText: () => 1,
    countMessages: (messages) => messages.length,
  };
  const store = new LifecycleStore();
  const thread = store.createThread();
  const previousTurn = store.createTurn(thread.id);
  store.appendItem(previousTurn.id, "user_message", {
    text: "旧问题",
  });
  store.appendItem(previousTurn.id, "assistant_message", {
    text: "旧回答",
  });
  store.completeTurn(previousTurn.id);
  const currentTurn = store.createTurn(thread.id);
  store.appendItem(currentTurn.id, "user_message", {
    text: "当前目标",
  });

  const llm = new ScriptedLlmProvider([
    {
      id: "response-item-checkpoint",
      text: "Item 预算摘要",
      functionCalls: [],
    },
    {
      id: "response-after-item-compaction",
      text: "压缩后完成",
      functionCalls: [],
    },
  ]);
  const agentLoop = new AgentLoop({
    lifecycleStore: store,
    llm,
    tokenBudget: new TokenBudget({
      maxContextTokens: 100,
      compactThresholdTokens: 90,
      tokenCounter: oneTokenPerMessageCounter,
    }),
    itemBudget: new ItemBudget({
      maxInputItems: 8,
      compactThresholdItems: 3,
      functionOutputItemCost: 2,
    }),
    contextCompactor: new ContextCompactor({
      llm,
      retainedUserMessageTokens: 1,
      tokenCounter: oneTokenPerMessageCounter,
    }),
  });

  const result = await agentLoop.run(currentTurn.id);

  assert.equal(result.turn.status, "completed");
  assert.equal(llm.requests.length, 2);
  assert.deepEqual(llm.requests[1]?.input, [
    { role: "user", text: "当前目标" },
    {
      role: "user",
      text: `${CODEX_SUMMARY_PREFIX}\nItem 预算摘要`,
    },
  ]);
});

test("启用 Model WAL 时压缩请求也会持久化并提交", async () => {
  const counter: TokenCounter = {
    countText: () => 1,
    countMessages: (messages) => messages.length,
  };
  const store = new LifecycleStore();
  const thread = store.createThread();
  const previous = store.createTurn(thread.id);
  store.appendItem(previous.id, "user_message", { text: "历史问题" });
  store.appendItem(previous.id, "assistant_message", { text: "历史回答" });
  store.completeTurn(previous.id);
  const turn = store.createTurn(thread.id);
  store.appendItem(turn.id, "user_message", { text: "当前问题" });
  const llm = new ScriptedLlmProvider([
    { id: "wal-compaction", text: "WAL 摘要", functionCalls: [] },
    { id: "wal-final", text: "压缩后完成", functionCalls: [] },
  ]);
  const modelStore = new ModelInvocationStore();
  let persistCount = 0;
  const loop = new AgentLoop({
    lifecycleStore: store,
    llm,
    tokenBudget: new TokenBudget({
      maxContextTokens: 20,
      compactThresholdTokens: 1,
      tokenCounter: counter,
    }),
    contextCompactor: new ContextCompactor({
      llm,
      retainedUserMessageTokens: 1,
      tokenCounter: counter,
    }),
    modelInvocationWal: {
      store: modelStore,
      persist: async () => { persistCount += 1; },
      provider: "test-provider",
      defaultModel: "test-model",
    },
  });

  const result = await loop.run(turn.id);
  assert.equal(result.turn.status, "completed");
  assert.equal(llm.requests.length, 2);
  assert.equal(modelStore.list("committed").length, 2);
  assert.ok(modelStore.list("committed").some((item) => item.purpose === "compaction"));
  assert.ok(persistCount >= 6);
});

test("Model WAL 恢复遇到缺失响应事实时拒绝继续伪造回答", async () => {
  const first = createTurnWithUserMessage();
  const firstLlm = new ScriptedLlmProvider([
    { id: "captured-response", text: "暂存回答", functionCalls: [] },
  ]);
  const firstModelStore = new ModelInvocationStore();
  let lifecycleSnapshot: ReturnType<LifecycleStore["exportSnapshot"]> | undefined;
  let modelSnapshot: ReturnType<ModelInvocationStore["exportSnapshot"]> | undefined;
  const firstLoop = new AgentLoop({
    lifecycleStore: first.store,
    llm: firstLlm,
    modelInvocationWal: {
      store: firstModelStore,
      persist: async () => undefined,
      provider: "test-provider",
      defaultModel: "test-model",
    },
    afterModelResponsePersisted: () => {
      lifecycleSnapshot = first.store.exportSnapshot();
      modelSnapshot = firstModelStore.exportSnapshot();
    },
  });
  await firstLoop.run(first.turn.id);
  assert.ok(lifecycleSnapshot);
  assert.ok(modelSnapshot);
  const malformed = structuredClone(modelSnapshot);
  const invocation = malformed.invocations[0];
  assert.ok(invocation);
  delete invocation.providerResponseId;
  delete invocation.normalizedResult;

  const restoredStore = LifecycleStore.fromSnapshot(lifecycleSnapshot);
  const restoredModelStore = ModelInvocationStore.fromSnapshot(malformed);
  const replayLoop = new AgentLoop({
    lifecycleStore: restoredStore,
    llm: new ScriptedLlmProvider([]),
    modelInvocationWal: {
      store: restoredModelStore,
      persist: async () => undefined,
      provider: "test-provider",
      defaultModel: "test-model",
    },
  });
  await assert.rejects(
    () => replayLoop.run(first.turn.id),
    /Model invocation response is incomplete/u,
  );
  assert.equal(restoredStore.getTurn(first.turn.id)?.status, "failed");
});

test("Tool WAL 恢复遇到不完整结果时 fail closed 且不重复执行副作用", async () => {
  const first = createTurnWithUserMessage();
  let executions = 0;
  const tool: AgentTool = {
    requiresPermission: false,
    definition: {
      name: "durable_side_effect",
      description: "持久化副作用",
      parameters: { type: "object" },
    },
    execute: () => {
      executions += 1;
      return { result: { ok: true }, modelOutput: { ok: true } };
    },
  };
  const modelStore = new ModelInvocationStore();
  const toolStore = new ToolInvocationStore();
  let lifecycleSnapshot: ReturnType<LifecycleStore["exportSnapshot"]> | undefined;
  let modelSnapshot: ReturnType<ModelInvocationStore["exportSnapshot"]> | undefined;
  let toolSnapshot: ReturnType<ToolInvocationStore["exportSnapshot"]> | undefined;
  const firstLoop = new AgentLoop({
    lifecycleStore: first.store,
    llm: new ScriptedLlmProvider([
      {
        id: "tool-wal-call",
        text: "",
        functionCalls: [{
          callId: "durable-call",
          name: "durable_side_effect",
          arguments: "{}",
        }],
      },
      { id: "tool-wal-final", text: "副作用完成", functionCalls: [] },
    ]),
    toolRegistry: new ToolRegistry([tool]),
    modelInvocationWal: {
      store: modelStore,
      persist: async () => undefined,
      provider: "test-provider",
      defaultModel: "test-model",
    },
    toolInvocationWal: {
      store: toolStore,
      persist: async () => undefined,
    },
    afterToolResultPersisted: () => {
      lifecycleSnapshot = first.store.exportSnapshot();
      modelSnapshot = modelStore.exportSnapshot();
      toolSnapshot = toolStore.exportSnapshot();
    },
  });
  await firstLoop.run(first.turn.id);
  assert.equal(executions, 1);
  assert.ok(lifecycleSnapshot);
  assert.ok(modelSnapshot);
  assert.ok(toolSnapshot);

  const restoredStore = LifecycleStore.fromSnapshot(lifecycleSnapshot);
  const restoredModelStore = ModelInvocationStore.fromSnapshot(modelSnapshot);
  const restoredToolStore = ToolInvocationStore.fromSnapshot(toolSnapshot);
  const invocationMap = (restoredToolStore as unknown as {
    invocations: Map<string, { output?: string; result?: unknown }>;
  }).invocations;
  const corruptedInvocation = [...invocationMap.values()][0];
  assert.ok(corruptedInvocation);
  delete corruptedInvocation.output;
  delete corruptedInvocation.result;

  const replayLoop = new AgentLoop({
    lifecycleStore: restoredStore,
    llm: new ScriptedLlmProvider([]),
    toolRegistry: new ToolRegistry([tool]),
    modelInvocationWal: {
      store: restoredModelStore,
      persist: async () => undefined,
      provider: "test-provider",
      defaultModel: "test-model",
    },
    toolInvocationWal: {
      store: restoredToolStore,
      persist: async () => undefined,
    },
  });
  await assert.rejects(
    () => replayLoop.run(first.turn.id),
    /Tool invocation result is incomplete/u,
  );
  assert.equal(executions, 1);
  assert.equal(restoredStore.getTurn(first.turn.id)?.status, "failed");
});

test("Tool 结果持久化后 Turn 已失活时不发布迟到结果也不请求续轮", async () => {
  const { store, turn } = createTurnWithUserMessage();
  let executions = 0;
  const modelStore = new ModelInvocationStore();
  const toolStore = new ToolInvocationStore();
  const llm = new ScriptedLlmProvider([
    {
      id: "late-tool-call",
      text: "",
      functionCalls: [{
        callId: "late-call",
        name: "late_result_tool",
        arguments: "{}",
      }],
    },
  ]);
  const loop = new AgentLoop({
    lifecycleStore: store,
    llm,
    toolRegistry: new ToolRegistry([{
      requiresPermission: false,
      definition: {
        name: "late_result_tool",
        description: "迟到结果工具",
        parameters: { type: "object" },
      },
      execute: () => {
        executions += 1;
        return { result: { late: true }, modelOutput: { late: true } };
      },
    }]),
    modelInvocationWal: {
      store: modelStore,
      persist: async () => undefined,
      provider: "test-provider",
      defaultModel: "test-model",
    },
    toolInvocationWal: {
      store: toolStore,
      persist: async () => undefined,
    },
    afterToolResultPersisted: () => {
      store.failTurn(turn.id);
    },
  });

  await assert.rejects(
    () => loop.run(turn.id),
    /Turn is no longer active/u,
  );
  assert.equal(executions, 1);
  assert.equal(llm.requests.length, 1);
  assert.deepEqual(
    store.getItemsForTurn(turn.id).map((item) => item.type),
    ["user_message", "tool_call"],
  );
  assert.equal(toolStore.list("result_received").length, 1);
  assert.equal(store.getTurn(turn.id)?.status, "failed");
});

test("压缩后的替换历史仍超硬上限时不请求业务模型", async () => {
  const store = new LifecycleStore();
  const thread = store.createThread();
  const turn = store.createTurn(thread.id);
  store.appendItem(turn.id, "user_message", {
    text: "必须保留的当前目标",
  });
  const llm = new ScriptedLlmProvider([
    {
      id: "response-too-large-checkpoint",
      text: "压缩摘要",
      functionCalls: [],
    },
  ]);
  const agentLoop = new AgentLoop({
    lifecycleStore: store,
    llm,
    itemBudget: new ItemBudget({
      maxInputItems: 1,
      compactThresholdItems: 1,
      functionOutputItemCost: 2,
    }),
    contextCompactor: new ContextCompactor({
      llm,
      retainedUserMessageTokens: 1,
      tokenCounter: ONE_TOKEN_PER_MESSAGE_COUNTER,
    }),
  });

  await assert.rejects(
    () => agentLoop.run(turn.id),
    InputItemBudgetExceededError,
  );
  assert.equal(llm.requests.length, 1);
  assert.equal(store.getTurn(turn.id)?.status, "failed");
});

test("65 个无状态 Function Calls 在任何 Tool 执行前失败", async () => {
  const { store, turn } = createTurnWithUserMessage();
  let executionCount = 0;
  let permissionCount = 0;
  const tool: AgentTool = {
    definition: {
      name: "budget_boundary_tool",
      description: "Item Budget 边界工具",
      parameters: { type: "object" },
    },
    execute() {
      executionCount += 1;
      return {
        result: { ok: true },
        modelOutput: { ok: true },
      };
    },
  };
  const llm = new ScriptedLlmProvider([
    {
      id: "response-65-tool-calls",
      text: "",
      functionCalls: Array.from(
        { length: 65 },
        (_, index) => ({
          callId: `call-over-limit-${index}`,
          name: tool.definition.name,
          arguments: `{"index":${index}}`,
        }),
      ),
    },
  ]);
  const agentLoop = new AgentLoop({
    lifecycleStore: store,
    llm,
    toolRegistry: new ToolRegistry([tool]),
    permissionGate: {
      request: async () => {
        permissionCount += 1;
        return { decision: "allow" };
      },
    },
  });

  await assert.rejects(
    () => agentLoop.run(turn.id),
    (error: unknown) => {
      assert.ok(error instanceof InputItemBudgetExceededError);
      assert.equal(error.estimatedItems, 130);
      assert.equal(error.maxInputItems, 128);
      return true;
    },
  );
  assert.equal(executionCount, 0);
  assert.equal(permissionCount, 0);
  assert.equal(llm.requests.length, 1);
  assert.deepEqual(
    store.getItemsForTurn(turn.id).map((item) => item.type),
    ["user_message"],
  );
});

test("64 个无状态 Function Calls 可执行且最新 Tool Result 不丢失", async () => {
  const { store, turn } = createTurnWithUserMessage();
  let executionCount = 0;
  const tool: AgentTool = {
    requiresPermission: false,
    definition: {
      name: "safe_boundary_tool",
      description: "无副作用边界工具",
      parameters: { type: "object" },
    },
    execute(argumentsJson) {
      executionCount += 1;
      const input = JSON.parse(argumentsJson) as {
        index: number;
      };
      return {
        result: { fullResultIndex: input.index },
        modelOutput: { modelResultIndex: input.index },
      };
    },
  };
  const llm = new ScriptedLlmProvider([
    {
      id: "response-64-tool-calls",
      text: "",
      functionCalls: Array.from(
        { length: 64 },
        (_, index) => ({
          callId: `call-at-limit-${index}`,
          name: tool.definition.name,
          arguments: `{"index":${index}}`,
        }),
      ),
    },
    {
      id: "response-after-64-tools",
      text: "边界内完成",
      functionCalls: [],
    },
  ]);
  const agentLoop = new AgentLoop({
    lifecycleStore: store,
    llm,
    toolRegistry: new ToolRegistry([tool]),
  });

  const result = await agentLoop.run(turn.id);

  assert.equal(result.turn.status, "completed");
  assert.equal(executionCount, 64);
  const continuationInput = llm.requests[1]?.input;
  assert.ok(Array.isArray(continuationInput));
  assert.equal(continuationInput.length, 64);
  assert.equal(
    continuationInput.at(-1)?.output,
    '{"modelResultIndex":63}',
  );
  const lifecycleItems = store.getItemsForTurn(turn.id);
  assert.deepEqual(lifecycleItems.at(-2)?.content, {
    callId: "call-at-limit-63",
    name: tool.definition.name,
    result: { fullResultIndex: 63 },
  });
});

test("LLM 失败时 Turn 进入 failed", async () => {
  const { store, turn } = createTurnWithUserMessage();

  const failingLlm = {
    async createResponse(): Promise<never> {
      throw new Error("simulated LLM failure");
    },
  };

  const agentLoop = new AgentLoop({
    lifecycleStore: store,
    llm: failingLlm,
  });

  await assert.rejects(
    () => agentLoop.run(turn.id),
    /simulated LLM failure/,
  );

  assert.equal(
    store.getTurn(turn.id)?.status,
    "failed",
  );
});

test("Agent Loop 在 Job Lease waiting 时 fail closed 且不触发模型", async () => {
  const { store, turn } = createTurnWithUserMessage();
  const llm = new ScriptedLlmProvider([{ id: "must-not-dispatch", text: "unexpected", functionCalls: [] }]);
  const executionLeases = {
    runWithJobLease: async () => ({ status: "waiting" as const }),
  } as unknown as ExecutionLeaseCoordinator;
  const loop = new AgentLoop({
    lifecycleStore: store,
    llm,
    executionLeases,
    resolveExecutionContext: () => ({ jobId: "job-waiting" }),
  });
  await assert.rejects(() => loop.run(turn.id), /waiting for its active execution owner/u);
  assert.equal(llm.requests.length, 0);
  assert.equal(store.getTurn(turn.id)?.status, "in_progress");
});

test("Permission 等待期间取消会中止挂起审批并收敛 Turn", async () => {
  const { store, turn } = createTurnWithUserMessage();
  let requested!: () => void;
  const permissionRequested = new Promise<void>((resolve) => { requested = resolve; });
  const llm = new ScriptedLlmProvider([{
    id: "response-permission-pending",
    text: "",
    functionCalls: [{ callId: "call-permission-pending", name: "protected_tool", arguments: "{}" }],
  }]);
  const agentLoop = new AgentLoop({
    lifecycleStore: store,
    llm,
    toolRegistry: new ToolRegistry([{
      definition: { name: "protected_tool", description: "审批工具", parameters: { type: "object" } },
      execute: () => ({ result: { ok: true }, modelOutput: { ok: true } }),
    }]),
    permissionGate: {
      request: async () => {
        requested();
        await new Promise<void>(() => undefined);
        return { decision: "allow" as const };
      },
    },
  });

  const running = agentLoop.run(turn.id);
  await permissionRequested;
  assert.equal(agentLoop.cancel(turn.id), true);
  await assert.rejects(running, (error: unknown) => error instanceof TurnCancelledError);
  assert.equal(store.getTurn(turn.id)?.status, "interrupted");
});

test("Permission 已完成时 waitForAbortable 清理监听器并继续执行 Tool", async () => {
  const { store, turn } = createTurnWithUserMessage();
  const llm = new ScriptedLlmProvider([
    { id: "response-permission-allow", text: "", functionCalls: [{ callId: "call-permission-allow", name: "protected_tool", arguments: "{}" }] },
    { id: "response-permission-final", text: "已执行", functionCalls: [] },
  ]);
  const agentLoop = new AgentLoop({
    lifecycleStore: store,
    llm,
    toolRegistry: new ToolRegistry([{
      definition: { name: "protected_tool", description: "审批工具", parameters: { type: "object" } },
      execute: () => ({ result: { ok: true }, modelOutput: { ok: true } }),
    }]),
    permissionGate: { request: async () => ({ decision: "allow" as const }) },
  });
  const result = await agentLoop.run(turn.id);
  assert.equal(result.turn.status, "completed");
  assert.deepEqual(result.assistantMessage.content, { text: "已执行" });
});

test("Permission Provider 拒绝时 waitForAbortable 清理监听器并让 Turn 失败", async () => {
  const { store, turn } = createTurnWithUserMessage();
  const llm = new ScriptedLlmProvider([{
    id: "response-permission-error",
    text: "",
    functionCalls: [{ callId: "call-permission-error", name: "protected_tool", arguments: "{}" }],
  }]);
  const agentLoop = new AgentLoop({
    lifecycleStore: store,
    llm,
    toolRegistry: new ToolRegistry([{
      definition: { name: "protected_tool", description: "审批工具", parameters: { type: "object" } },
      execute: () => ({ result: { ok: true }, modelOutput: { ok: true } }),
    }]),
    permissionGate: { request: async () => { throw new Error("permission transport failed"); } },
  });
  await assert.rejects(agentLoop.run(turn.id), /permission transport failed/);
  assert.equal(store.getTurn(turn.id)?.status, "failed");
});

test("Provider 自己抛出 AbortError 但没有 Runtime 取消信号时仍进入 failed", async () => {
  const { store, turn } = createTurnWithUserMessage();
  const events: AgentEvent[] = [];
  const providerAbort = new Error("provider transport aborted");
  providerAbort.name = "AbortError";
  const abortingLlm = {
    async createResponse(): Promise<never> {
      throw providerAbort;
    },
  };

  const agentLoop = new AgentLoop({
    lifecycleStore: store,
    llm: abortingLlm,
    events: { emit: (event) => events.push(event) },
  });

  await assert.rejects(
    () => agentLoop.run(turn.id),
    (error: unknown) => error === providerAbort,
  );

  assert.equal(store.getTurn(turn.id)?.status, "failed");
  const lastEvent = events.at(-1);
  assert.equal(lastEvent?.type, "turn/failed");
  assert.equal(lastEvent?.type === "turn/failed" ? lastEvent.message : undefined,
    "provider transport aborted");
});

test("非 Error Provider 拒绝值不会伪装成 interrupted", async () => {
  const { store, turn } = createTurnWithUserMessage();
  const events: AgentEvent[] = [];
  const rejectingLlm = {
    async createResponse(): Promise<never> {
      throw "transport rejected";
    },
  };

  const agentLoop = new AgentLoop({
    lifecycleStore: store,
    llm: rejectingLlm,
    events: { emit: (event) => events.push(event) },
  });

  await assert.rejects(() => agentLoop.run(turn.id), (error: unknown) => error === "transport rejected");

  assert.equal(store.getTurn(turn.id)?.status, "failed");
  const lastEvent = events.at(-1);
  assert.equal(lastEvent?.type, "turn/failed");
  assert.equal(lastEvent?.type === "turn/failed" ? lastEvent.message : undefined,
    "Unknown agent error");
});

test("取消正在等待 LLM 的 Turn 并进入 interrupted", async () => {
  const { store, turn } = createTurnWithUserMessage();
  let notifyStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  const events: AgentEvent[] = [];
  const waitingLlm = {
    createResponse(request: {
      signal?: AbortSignal;
    }): Promise<never> {
      notifyStarted?.();

      return new Promise((_, reject) => {
        request.signal?.addEventListener(
          "abort",
          () => reject(request.signal?.reason),
          { once: true },
        );
      });
    },
  };
  const agentLoop = new AgentLoop({
    lifecycleStore: store,
    llm: waitingLlm,
    events: {
      emit: (event) => events.push(event),
    },
  });

  const runPromise = agentLoop.run(turn.id);
  await started;

  assert.equal(agentLoop.cancel(turn.id), true);
  await assert.rejects(
    runPromise,
    (error: unknown) =>
      error instanceof TurnCancelledError,
  );

  assert.equal(store.getTurn(turn.id)?.status, "interrupted");
  assert.equal(agentLoop.cancel(turn.id), false);
  assert.equal(events.at(-1)?.type, "turn/interrupted");
});

test("运行中的 Turn 拒绝重复 run，取消后再次 run 会先恢复 interrupted 状态", async () => {
  const { store, turn } = createTurnWithUserMessage();
  let calls = 0;
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
  const llm = {
    createResponse(request: { signal?: AbortSignal }): Promise<{ id: string; text: string; functionCalls: [] }> {
      calls += 1;
      if (calls === 1) {
        notifyStarted();
        return new Promise((_, reject) => {
          request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
        });
      }
      return Promise.resolve({ id: "response-after-resume", text: "恢复后完成", functionCalls: [] });
    },
  };
  const agentLoop = new AgentLoop({ lifecycleStore: store, llm });

  const firstRun = agentLoop.run(turn.id);
  await started;
  await assert.rejects(agentLoop.run(turn.id), /Turn is already running/u);
  assert.equal(agentLoop.cancel(turn.id), true);
  await assert.rejects(firstRun, (error: unknown) => error instanceof TurnCancelledError);
  assert.equal(store.getTurn(turn.id)?.status, "interrupted");

  const resumed = await agentLoop.run(turn.id);
  assert.equal(resumed.turn.status, "completed");
  assert.deepEqual(resumed.assistantMessage.content, { text: "恢复后完成" });
  assert.equal(calls, 2);
});

test("Turn 总时限到达时中断 LLM 并进入 timed_out", async () => {
  const { store, turn } = createTurnWithUserMessage();
  const events: AgentEvent[] = [];
  const waitingLlm = {
    createResponse(request: {
      signal?: AbortSignal;
    }): Promise<never> {
      return new Promise((_, reject) => {
        request.signal?.addEventListener(
          "abort",
          () => reject(request.signal?.reason),
          { once: true },
        );
      });
    },
  };
  const agentLoop = new AgentLoop({
    lifecycleStore: store,
    llm: waitingLlm,
    turnTimeoutMs: 10,
    events: {
      emit: (event) => events.push(event),
    },
  });

  await assert.rejects(
    () => agentLoop.run(turn.id),
    (error: unknown) => error instanceof TurnTimeoutError,
  );

  assert.equal(store.getTurn(turn.id)?.status, "timed_out");
  assert.equal(events.at(-1)?.type, "turn/timed_out");
});

test("Agent Loop 构造期拒绝非法时限与孤立 Tool WAL", () => {
  const { store } = createTurnWithUserMessage();
  const llm = new ScriptedLlmProvider([]);
  assert.throws(() => new AgentLoop({ lifecycleStore: store, llm, turnTimeoutMs: 0 }),
    /turnTimeoutMs must be a positive integer/);
  assert.throws(() => new AgentLoop({
    lifecycleStore: store,
    llm,
    toolInvocationWal: { store: {}, persist: () => undefined } as never,
  }), /Tool invocation WAL requires model invocation WAL/);
});

test("Agent Loop 在执行前拒绝越权 Tool 与非法 Skill 参数", async () => {
  const tool: AgentTool = {
    requiresPermission: false,
    definition: { name: "read_skill", description: "read", parameters: { type: "object" } },
    execute: () => ({ result: { ok: true }, modelOutput: { ok: true } }),
  };
  for (const scenario of [
    { allowedTools: [] as string[], allowedSkills: ["*"] as string[], arguments: '{"name":"safe"}', message: /Tool is not allowed/ },
    { allowedTools: ["read_skill"], allowedSkills: ["safe"], arguments: "not-json", message: /Skill is not allowed/ },
  ]) {
    const { store, turn } = createTurnWithUserMessage();
    const loop = new AgentLoop({ lifecycleStore: store,
      llm: new ScriptedLlmProvider([{ id: "response-denied-tool", text: "", functionCalls: [
        { callId: "call-denied", name: "read_skill", arguments: scenario.arguments },
      ] }]), toolRegistry: new ToolRegistry([tool]) });
    await assert.rejects(() => loop.run(turn.id, {
      allowedTools: scenario.allowedTools,
      allowedSkills: scenario.allowedSkills,
    }), scenario.message);
    assert.deepEqual(store.getItemsForTurn(turn.id).map((item) => item.type), ["user_message"]);
  }
});

test("Agent Loop 对最终回答执行拒绝后修复，并限制重复修复次数", async () => {
  const first = createTurnWithUserMessage();
  const repairing = new ScriptedLlmProvider([
    { id: "bad", text: "未通过格式检查", functionCalls: [] },
    { id: "good", text: "符合格式的最终答案", functionCalls: [] },
  ]);
  const loop = new AgentLoop({ lifecycleStore: first.store, llm: repairing });
  const result = await loop.run(first.turn.id, {
    finalResponseGuard: {
      reject: (text) => text.includes("未通过") ? "必须给出结构化结论" : undefined,
      repairInstructions: "请按结构化格式重写。",
    },
  });
  assert.equal(result.turn.status, "completed");
  assert.equal(repairing.requests.length, 2);
  assert.match(repairing.requests[1]?.instructions ?? "", /结构化格式/);

  const second = createTurnWithUserMessage();
  const alwaysBad = new ScriptedLlmProvider([
    { id: "bad-1", text: "未通过 1", functionCalls: [] },
    { id: "bad-2", text: "未通过 2", functionCalls: [] },
  ]);
  const strictLoop = new AgentLoop({ lifecycleStore: second.store, llm: alwaysBad });
  await assert.rejects(
    () => strictLoop.run(second.turn.id, {
      finalResponseGuard: { reject: () => "永远拒绝", repairInstructions: "重试", maxRepairAttempts: 1 },
    }),
    /repeatedly returned an invalid final response/,
  );
  assert.equal(second.store.getTurn(second.turn.id)?.status, "failed");
});

test("Agent Loop 在工具轮次耗尽后只做无工具最终化", async () => {
  const { store, turn } = createTurnWithUserMessage();
  const llm = new ScriptedLlmProvider([
    { id: "tool-limit", text: "", functionCalls: [{ callId: "call-limit", name: "unknown_tool", arguments: "{}" }] },
    { id: "finalized", text: "工具轮次已安全收口", functionCalls: [] },
  ]);
  const loop = new AgentLoop({ lifecycleStore: store, llm, maxToolRounds: 0 });
  const result = await loop.run(turn.id);
  assert.equal(result.turn.status, "completed");
  assert.deepEqual(store.getItemsForTurn(turn.id).map((item) => item.type), ["user_message", "tool_call", "tool_result", "assistant_message"]);
  assert.equal(llm.requests[1]?.tools?.length, 0);
  assert.match(JSON.stringify(store.getItemsForTurn(turn.id).at(2)?.content), /tool_round_limit/);
});

test("Agent Loop 拒绝空最终回答并拒绝同一 Turn 并发运行", async () => {
  const empty = createTurnWithUserMessage();
  const emptyLoop = new AgentLoop({ lifecycleStore: empty.store, llm: new ScriptedLlmProvider([{ id: "empty", text: "", functionCalls: [] }]) });
  await assert.rejects(() => emptyLoop.run(empty.turn.id), /no final assistant text/);
  assert.equal(empty.store.getTurn(empty.turn.id)?.status, "failed");

  const concurrent = createTurnWithUserMessage();
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const waiting = { createResponse: async () => { await pending; return { id: "done", text: "完成", functionCalls: [] }; } };
  const concurrentLoop = new AgentLoop({ lifecycleStore: concurrent.store, llm: waiting });
  const firstRun = concurrentLoop.run(concurrent.turn.id);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => concurrentLoop.run(concurrent.turn.id), /already running/);
  release?.();
  await firstRun;
});

test("Agent Loop 识别 run_return Tool 输出并通过 continuation 传递子 Run", async () => {
  const { store, turn } = createTurnWithUserMessage();
  const returned: string[][] = [];
  const returnTool: AgentTool = {
    requiresPermission: false,
    definition: { name: "return_tool", description: "return", parameters: { type: "object" } },
    execute: () => ({ result: { type: "run_return", runId: "child-run-1" }, modelOutput: { type: "run_return", runId: "child-run-1" } }),
  };
  const llm = new ScriptedLlmProvider([
    { id: "delegate", text: "", functionCalls: [{ callId: "call-return", name: "return_tool", arguments: "{}" }] },
    { id: "final", text: "父 Agent 已收到子结果", functionCalls: [] },
  ]);
  const loop = new AgentLoop({
    lifecycleStore: store,
    llm,
    toolRegistry: new ToolRegistry([returnTool]),
    continueAfterAgentReturns: async (_turnId, childRunIds, continuation) => {
      returned.push(childRunIds);
      return continuation();
    },
  });
  const result = await loop.run(turn.id);
  assert.equal(result.turn.status, "completed");
  assert.deepEqual(returned, [["child-run-1"]]);
});

test("Agent Loop recovery matrix rejects stale work and preserves late-response facts", async () => {
  await assert.rejects(
    () => new AgentLoop({ lifecycleStore: new LifecycleStore(), llm: new ScriptedLlmProvider([]) }).run("missing-turn"),
    /Turn is unavailable|not found/i,
  );

  const replay = createTurnWithUserMessage();
  const replayProvider = new ScriptedLlmProvider([{ id: "replay", text: "一次完成", functionCalls: [] }]);
  const replayLoop = new AgentLoop({ lifecycleStore: replay.store, llm: replayProvider });
  const first = await replayLoop.run(replay.turn.id);
  assert.equal(first.turn.status, "completed");
  await assert.rejects(() => replayLoop.run(replay.turn.id), /Current Turn is not in progress/);
  assert.equal(replayProvider.requests.length, 1);

  const cancelled = createTurnWithUserMessage();
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const cancelledLoop = new AgentLoop({ lifecycleStore: cancelled.store, llm: {
    createResponse: async (request) => {
      await pending;
      if (request.signal?.aborted) throw request.signal.reason;
      return { id: "cancelled-late", text: "late", functionCalls: [] };
    },
  } });
  const running = cancelledLoop.run(cancelled.turn.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelledLoop.cancel(cancelled.turn.id), true);
  release?.();
  await assert.rejects(running, /cancel|interrupt/i);
  assert.equal(cancelled.store.getTurn(cancelled.turn.id)?.status, "interrupted");
  assert.equal(cancelledLoop.cancel(cancelled.turn.id), false);

  const resumed = createTurnWithUserMessage();
  const resumeLoop = new AgentLoop({ lifecycleStore: resumed.store, llm: new ScriptedLlmProvider([{ id: "resume", text: "恢复完成", functionCalls: [] }]) });
  resumed.store.interruptTurn(resumed.turn.id);
  const resumedResult = await resumeLoop.run(resumed.turn.id);
  assert.equal(resumedResult.turn.status, "completed");

  const timed = createTurnWithUserMessage();
  const timedLoop = new AgentLoop({ lifecycleStore: timed.store, turnTimeoutMs: 5, llm: {
    createResponse: async (request) => new Promise((_resolve, reject) => {
      request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
    }),
  } });
  await assert.rejects(() => timedLoop.run(timed.turn.id), TurnTimeoutError);
  assert.equal(timed.store.getTurn(timed.turn.id)?.status, "timed_out");

  const empty = createTurnWithUserMessage();
  const emptyLoop = new AgentLoop({ lifecycleStore: empty.store, llm: new ScriptedLlmProvider([{ id: "empty-recovery", text: "", functionCalls: [] }]) });
  await assert.rejects(() => emptyLoop.run(empty.turn.id), /no final assistant text/);
  assert.equal(empty.store.getTurn(empty.turn.id)?.status, "failed");

  const unknownTool = createTurnWithUserMessage();
  const unknownLoop = new AgentLoop({ lifecycleStore: unknownTool.store, llm: new ScriptedLlmProvider([
    { id: "unknown-call", text: "", functionCalls: [{ callId: "unknown", name: "missing_tool", arguments: "{}" }] },
  ]) });
  await assert.rejects(() => unknownLoop.run(unknownTool.turn.id), /Unknown tool/);
  assert.equal(unknownTool.store.getTurn(unknownTool.turn.id)?.status, "failed");

  assert.throws(() => new AgentLoop({ lifecycleStore: new LifecycleStore(), llm: new ScriptedLlmProvider([]), turnTimeoutMs: 0 }), /turnTimeoutMs/);
  assert.throws(() => new AgentLoop({ lifecycleStore: new LifecycleStore(), llm: new ScriptedLlmProvider([]), turnTimeoutMs: 1.5 }), /turnTimeoutMs/);
  assert.throws(() => new AgentLoop({ lifecycleStore: new LifecycleStore(), llm: new ScriptedLlmProvider([]), toolInvocationWal: {} as never }), /requires model invocation WAL/);
});
