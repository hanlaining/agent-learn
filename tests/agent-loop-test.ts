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

test("Agent Loop 在 run 开始时冻结 Tool 定义快照", async () => {
  const { store, turn } = createTurnWithUserMessage();
  let names = ["initial-skill"];
  const dynamicTool: AgentTool = {
    get definition() {
      return {
        name: "read_skill",
        description: "读取 Skill",
        parameters: {
          type: "object",
          properties: { name: { type: "string", enum: [...names] } },
          required: ["name"],
          additionalProperties: false,
        },
      };
    },
    requiresPermission: false,
    execute() {
      names = ["initial-skill", "new-skill"];
      return { result: {}, modelOutput: {} };
    },
  };
  const llm = new ScriptedLlmProvider([
    {
      id: "response-tool",
      text: "",
      functionCalls: [{
        callId: "read-1",
        name: "read_skill",
        arguments: '{"name":"initial-skill"}',
      }],
    },
    { id: "response-final", text: "完成", functionCalls: [] },
  ]);
  const loop = new AgentLoop({
    lifecycleStore: store,
    llm,
    toolRegistry: new ToolRegistry([dynamicTool]),
  });

  await loop.run(turn.id, { allowedSkills: ["initial-skill"] });

  assert.equal(llm.requests.length, 2);
  assert.deepEqual(llm.requests[0]?.tools, llm.requests[1]?.tools);
  assert.deepEqual(
    (llm.requests[1]?.tools[0]?.parameters as {
      properties: { name: { enum: string[] } };
    }).properties.name.enum,
    ["initial-skill"],
  );
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
