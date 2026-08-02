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
import {
  ContextCompactor,
} from "../src/runtime/context-compactor.js";
import {
  ContextCheckpointStore,
} from "../src/runtime/context-checkpoint-store.js";
import {
  TokenBudget,
} from "../src/runtime/token-budget.js";
import {
  ToolRegistry,
  type AgentTool,
} from "../src/tools/tool-registry.js";

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
      "model/completed",
      "permission/requested",
      "permission/decided",
      "tool/started",
      "tool/completed",
      "model/started",
      "assistant/delta",
      "model/completed",
      "turn/completed",
    ],
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
      compactThresholdTokens: 15,
    }),
    contextCompactor: new ContextCompactor({
      llm,
      recentMessageTokens: 5,
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
      role: "assistant",
      text: "[Context checkpoint]\n旧对话摘要",
    },
    {
      role: "user",
      text: "丙",
    },
  ]);

  const compactionEvent = events.find(
    (event) => event.type === "context/compacted",
  );

  assert.deepEqual(compactionEvent, {
    type: "context/compacted",
    turnId: currentTurn.id,
    beforeTokens: 15,
    afterTokens: 20,
  });

  assert.deepEqual(
    checkpointStore.getLatest(thread.id)?.replacementMessages,
    [
      {
        role: "assistant",
        text: "[Context checkpoint]\n旧对话摘要",
      },
      {
        role: "user",
        text: "丙",
      },
    ],
  );
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
