import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentLoop,
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
      "tool/started",
      "tool/completed",
      "model/started",
      "assistant/delta",
      "model/completed",
      "turn/completed",
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
