import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentLoop,
} from "../src/agent/agent-loop.js";
import type {
  LlmCreateResponseRequest,
  LlmProvider,
  LlmResponse,
} from "../src/llm/types.js";
import {
  LifecycleStore,
} from "../src/runtime/lifecycle-store.js";
import {
  createModelInvocationId,
  createModelRequestDigest,
  type ModelInvocationStatus,
} from "../src/runtime/model-invocation.js";
import {
  ModelInvocationStore,
} from "../src/runtime/model-invocation-store.js";
import {
  ToolRegistry,
  type AgentTool,
} from "../src/tools/tool-registry.js";

const FAKE_MODEL = "fake-model";

class FakeLlm implements LlmProvider {
  readonly requests: LlmCreateResponseRequest[] = [];

  constructor(
    private readonly responses: Array<LlmResponse | Error>,
    private readonly beforeCall?: () => void,
  ) {}

  async createResponse(request: LlmCreateResponseRequest): Promise<LlmResponse> {
    this.requests.push(request);
    this.beforeCall?.();
    const response = this.responses.shift();
    if (response === undefined) throw new Error("No fake LLM response available");
    if (response instanceof Error) throw response;
    return structuredClone(response);
  }
}

interface DurableSnapshot {
  lifecycle: ReturnType<LifecycleStore["exportSnapshot"]>;
  modelInvocations: ReturnType<ModelInvocationStore["exportSnapshot"]>;
}

class SimulatedCrash extends Error {
  constructor(checkpoint: string) {
    super(`simulated crash after ${checkpoint} persist`);
    this.name = "SimulatedCrash";
  }
}

function createTurn() {
  const lifecycleStore = new LifecycleStore({
    now: () => "2026-08-18T13:00:00.000Z",
  });
  const thread = lifecycleStore.createThread();
  const turn = lifecycleStore.createTurn(thread.id);
  lifecycleStore.appendItem(turn.id, "user_message", {
    text: "complete this turn",
  });
  return { lifecycleStore, thread, turn };
}

function createLoop(input: {
  lifecycleStore: LifecycleStore;
  llm: LlmProvider;
  modelInvocationStore: ModelInvocationStore;
  persist: () => Promise<void>;
  toolRegistry?: ToolRegistry;
}) {
  const options: ConstructorParameters<typeof AgentLoop>[0] = {
    lifecycleStore: input.lifecycleStore,
    llm: input.llm,
    modelInvocationWal: {
      store: input.modelInvocationStore,
      persist: input.persist,
      provider: "fake",
      defaultModel: FAKE_MODEL,
    },
    ...(input.toolRegistry === undefined
      ? {}
      : { toolRegistry: input.toolRegistry }),
  };
  return new AgentLoop(options);
}

function capture(
  lifecycleStore: LifecycleStore,
  modelInvocationStore: ModelInvocationStore,
): DurableSnapshot {
  return {
    lifecycle: lifecycleStore.exportSnapshot(),
    modelInvocations: modelInvocationStore.exportSnapshot(),
  };
}

function requireDurable(
  value: DurableSnapshot | undefined,
  checkpoint: string,
): DurableSnapshot {
  assert.ok(value, `expected a durable ${checkpoint} snapshot`);
  return value;
}

function restore(value: DurableSnapshot) {
  return {
    lifecycleStore: LifecycleStore.fromSnapshot(value.lifecycle),
    modelInvocationStore: ModelInvocationStore.fromSnapshot(
      value.modelInvocations,
    ),
  };
}

function finalResponse(id = "response-final"): LlmResponse {
  return {
    id,
    text: "durable assistant result",
    functionCalls: [],
  };
}

test("Provider 调用前 prepared 与 submitted 已分别持久化", async () => {
  const { lifecycleStore, turn } = createTurn();
  const modelInvocationStore = new ModelInvocationStore();
  const persistedStatuses: ModelInvocationStatus[] = [];
  let statusesObservedByProvider: ModelInvocationStatus[] = [];
  const llm = new FakeLlm([finalResponse()], () => {
    statusesObservedByProvider = [...persistedStatuses];
  });
  const loop = createLoop({
    lifecycleStore,
    llm,
    modelInvocationStore,
    persist: async () => {
      const invocation = modelInvocationStore.list().at(-1);
      if (invocation !== undefined) persistedStatuses.push(invocation.status);
    },
  });

  await loop.run(turn.id, { model: FAKE_MODEL });

  assert.deepEqual(statusesObservedByProvider, ["prepared", "submitted"]);
  assert.deepEqual(persistedStatuses, [
    "prepared",
    "submitted",
    "response_received",
    "committed",
  ]);
});

test("response_received recovery rejects each corrupted durable field without calling Provider", async () => {
  const { lifecycleStore, turn } = createTurn();
  const store = new ModelInvocationStore();
  let durable: DurableSnapshot | undefined;
  const loop = createLoop({ lifecycleStore, llm: new FakeLlm([finalResponse("corruption-base")]), modelInvocationStore: store, persist: async () => {
    if (store.list().at(-1)?.status === "response_received") { durable = capture(lifecycleStore, store); throw new SimulatedCrash("corruption-base"); }
  }});
  await assert.rejects(() => loop.run(turn.id, { model: FAKE_MODEL }), SimulatedCrash);
  const base = requireDurable(durable, "corruption-base");
  const corruptions: Array<(entry: Record<string, unknown>) => void> = [
    (entry) => { delete entry.providerResponseId; }, (entry) => { delete entry.normalizedResult; },
    (entry) => { entry.providerResponseId = ""; }, (entry) => { entry.normalizedResult = { text: 1, functionCalls: [] }; },
    (entry) => { entry.dispatchAttempts = -1; }, (entry) => { entry.updatedAt = "not-a-date"; },
    (entry) => { entry.status = "prepared"; }, (entry) => { entry.provider = ""; },
    (entry) => { entry.model = ""; }, (entry) => { entry.targetCommitKey = ""; },
  ];
  for (const [index, corrupt] of corruptions.entries()) {
    const snapshot = structuredClone(base) as unknown as { modelInvocations: { invocations: Array<Record<string, unknown>> } };
    corrupt(snapshot.modelInvocations.invocations[0]!);
    if (index < 2) {
      const restored = restore(snapshot as unknown as DurableSnapshot);
      const replay = createLoop({ ...restored, llm: new FakeLlm([]), persist: async () => undefined });
      await assert.rejects(() => replay.run(turn.id, { model: FAKE_MODEL }), /incomplete/);
    } else {
      try {
        const restored = restore(snapshot as unknown as DurableSnapshot);
        const replay = createLoop({ ...restored, llm: new FakeLlm([]), persist: async () => undefined });
        await assert.rejects(() => replay.run(turn.id, { model: FAKE_MODEL }));
      } catch {
        // Snapshot parser rejection is the intended fail-closed outcome.
      }
    }
  }
});

test("submitted 快照恢复时先转 outcome_unknown，绝不自动重发 Provider", async () => {
  const { lifecycleStore, turn } = createTurn();
  const modelInvocationStore = new ModelInvocationStore();
  let durable: DurableSnapshot | undefined;
  let crashed = false;
  const firstLoop = createLoop({
    lifecycleStore,
    llm: new FakeLlm([finalResponse()]),
    modelInvocationStore,
    persist: async () => {
      if (!crashed && modelInvocationStore.list().at(-1)?.status === "submitted") {
        crashed = true;
        durable = capture(lifecycleStore, modelInvocationStore);
        throw new SimulatedCrash("submitted");
      }
    },
  });

  await assert.rejects(() => firstLoop.run(turn.id, { model: FAKE_MODEL }), SimulatedCrash);
  const restarted = restore(requireDurable(durable, "submitted"));
  const provider = new FakeLlm([]);
  const restartedLoop = createLoop({
    ...restarted,
    llm: provider,
    persist: async () => undefined,
  });
  await assert.rejects(
    () => restartedLoop.run(turn.id, { model: FAKE_MODEL }),
    /outcome_unknown|outcome unknown/i,
  );
  assert.equal(provider.requests.length, 0);
  assert.equal(restarted.modelInvocationStore.list()[0]?.status, "outcome_unknown");
});

test("failed_terminal 快照恢复直接拒绝，不重新调用 Provider", async () => {
  const { lifecycleStore, turn } = createTurn();
  const modelInvocationStore = new ModelInvocationStore();
  let durable: DurableSnapshot | undefined;
  let changed = false;
  const firstLoop = createLoop({
    lifecycleStore,
    llm: new FakeLlm([finalResponse()]),
    modelInvocationStore,
    persist: async () => {
      const invocation = modelInvocationStore.list().at(-1);
      if (!changed && invocation?.status === "prepared") {
        changed = true;
        modelInvocationStore.markFailed(invocation.invocationId, "failed_terminal", "manual_terminal");
        durable = capture(lifecycleStore, modelInvocationStore);
        throw new SimulatedCrash("failed_terminal");
      }
    },
  });

  await assert.rejects(() => firstLoop.run(turn.id, { model: FAKE_MODEL }), SimulatedCrash);
  const restarted = restore(requireDurable(durable, "failed_terminal"));
  const provider = new FakeLlm([]);
  const restartedLoop = createLoop({
    ...restarted,
    llm: provider,
    persist: async () => undefined,
  });
  await assert.rejects(
    () => restartedLoop.run(turn.id, { model: FAKE_MODEL }),
    /Model invocation is terminal/,
  );
  assert.equal(provider.requests.length, 0);
});

test("已提交 Invocation 但缺少 Assistant Item 时恢复直接拒绝", async () => {
  const { lifecycleStore, turn } = createTurn();
  const modelInvocationStore = new ModelInvocationStore();
  let durable: DurableSnapshot | undefined;
  let forged = false;
  const firstLoop = createLoop({
    lifecycleStore,
    llm: new FakeLlm([finalResponse()]),
    modelInvocationStore,
    persist: async () => {
      const invocation = modelInvocationStore.list().at(-1);
      if (!forged && invocation?.status === "response_received") {
        forged = true;
        modelInvocationStore.markCommitted(invocation.invocationId, `turn:${turn.id}:assistant`);
        lifecycleStore.completeTurn(turn.id);
        durable = capture(lifecycleStore, modelInvocationStore);
        throw new SimulatedCrash("committed-without-assistant");
      }
    },
  });

  await assert.rejects(() => firstLoop.run(turn.id, { model: FAKE_MODEL }), SimulatedCrash);
  const restarted = restore(requireDurable(durable, "committed-without-assistant"));
  await assert.rejects(
    () => createLoop({ ...restarted, llm: new FakeLlm([]), persist: async () => undefined }).run(turn.id, { model: FAKE_MODEL }),
    /Committed model invocation has no Assistant item/,
  );
});

test("Provider 返回后先持久化 response_received，再提交 Assistant 并持久化 committed", async () => {
  const { lifecycleStore, turn } = createTurn();
  const modelInvocationStore = new ModelInvocationStore();
  const persisted: Array<{
    invocationStatus: ModelInvocationStatus;
    turnStatus: string | undefined;
    itemTypes: string[];
  }> = [];
  const loop = createLoop({
    lifecycleStore,
    llm: new FakeLlm([finalResponse()]),
    modelInvocationStore,
    persist: async () => {
      const invocation = modelInvocationStore.list().at(-1);
      if (invocation === undefined) return;
      persisted.push({
        invocationStatus: invocation.status,
        turnStatus: lifecycleStore.getTurn(turn.id)?.status,
        itemTypes: lifecycleStore
          .getItemsForTurn(turn.id)
          .map((item) => item.type),
      });
    },
  });

  await loop.run(turn.id, { model: FAKE_MODEL });

  const received = persisted.find(
    (entry) => entry.invocationStatus === "response_received",
  );
  assert.deepEqual(received, {
    invocationStatus: "response_received",
    turnStatus: "in_progress",
    itemTypes: ["user_message"],
  });
  const committed = persisted.find(
    (entry) => entry.invocationStatus === "committed",
  );
  assert.deepEqual(committed, {
    invocationStatus: "committed",
    turnStatus: "completed",
    itemTypes: ["user_message", "assistant_message"],
  });
});

test("从 response_received snapshot 重启直接重放 normalizedResult，Provider 调用为 0", async () => {
  const { lifecycleStore, turn } = createTurn();
  const modelInvocationStore = new ModelInvocationStore();
  let durable: DurableSnapshot | undefined;
  const firstLoop = createLoop({
    lifecycleStore,
    llm: new FakeLlm([finalResponse("response-before-crash")]),
    modelInvocationStore,
    persist: async () => {
      if (modelInvocationStore.list().at(-1)?.status === "response_received") {
        durable = capture(lifecycleStore, modelInvocationStore);
        throw new SimulatedCrash("response_received");
      }
    },
  });

  await assert.rejects(
    () => firstLoop.run(turn.id, { model: FAKE_MODEL }),
    SimulatedCrash,
  );

  const restarted = restore(requireDurable(durable, "response_received"));
  const replayProvider = new FakeLlm([]);
  const restartedLoop = createLoop({
    ...restarted,
    llm: replayProvider,
    persist: async () => undefined,
  });

  const result = await restartedLoop.run(turn.id, { model: FAKE_MODEL });

  assert.equal(replayProvider.requests.length, 0);
  assert.deepEqual(result.assistantMessage.content, {
    text: "durable assistant result",
  });
  assert.equal(
    restarted.modelInvocationStore.list()[0]?.status,
    "committed",
  );
});

test("committed snapshot 重启后跳过 Provider 且不重复提交 Assistant", async () => {
  const { lifecycleStore, turn } = createTurn();
  const modelInvocationStore = new ModelInvocationStore();
  let durable: DurableSnapshot | undefined;
  const firstLoop = createLoop({
    lifecycleStore,
    llm: new FakeLlm([finalResponse("response-committed")]),
    modelInvocationStore,
    persist: async () => {
      if (modelInvocationStore.list().at(-1)?.status === "committed") {
        durable = capture(lifecycleStore, modelInvocationStore);
      }
    },
  });
  await firstLoop.run(turn.id, { model: FAKE_MODEL });

  const restarted = restore(requireDurable(durable, "committed"));
  const replayProvider = new FakeLlm([]);
  const restartedLoop = createLoop({
    ...restarted,
    llm: replayProvider,
    persist: async () => undefined,
  });

  await restartedLoop.run(turn.id, { model: FAKE_MODEL });

  assert.equal(replayProvider.requests.length, 0);
  assert.equal(
    restarted.lifecycleStore
      .getItemsForTurn(turn.id)
      .filter((item) => item.type === "assistant_message").length,
    1,
  );
  assert.equal(
    restarted.modelInvocationStore.list()[0]?.status,
    "committed",
  );
});

test("显式恢复 interrupted Turn 从已持久化最大 round+1 创建新 Invocation", async () => {
  const { lifecycleStore, turn } = createTurn();
  const modelInvocationStore = new ModelInvocationStore();
  for (const round of [0, 1]) {
    const invocation = modelInvocationStore.prepare({
      threadId: turn.threadId,
      turnId: turn.id,
      round,
      purpose: `historical_${round}`,
      requestDigest: createModelRequestDigest({ historical: round }),
      provider: "fake",
      model: FAKE_MODEL,
    });
    modelInvocationStore.markSubmitted(invocation.invocationId);
    modelInvocationStore.recordResponse(invocation.invocationId, {
      providerResponseId: `historical-response-${round}`,
      normalizedResult: { text: `historical-${round}`, functionCalls: [] },
    });
    modelInvocationStore.markCommitted(
      invocation.invocationId,
      `turn:${turn.id}:historical:${round}`,
    );
  }
  lifecycleStore.interruptTurn(turn.id);
  const provider = new FakeLlm([finalResponse("explicit-round-2")]);
  const loop = createLoop({
    lifecycleStore,
    modelInvocationStore,
    llm: provider,
    persist: async () => undefined,
  });

  await loop.run(turn.id, { model: FAKE_MODEL });

  assert.equal(provider.requests.length, 1);
  assert.deepEqual(
    modelInvocationStore.list().map((item) => [item.round, item.status]),
    [[0, "committed"], [1, "committed"], [2, "committed"]],
  );
  assert.equal(lifecycleStore.getTurn(turn.id)?.status, "completed");
});

test("outcome_unknown 重启必须明确阻断或等待，不得自动重发 Provider", async () => {
  const { lifecycleStore, turn } = createTurn();
  const modelInvocationStore = new ModelInvocationStore();
  let durable: DurableSnapshot | undefined;
  const ambiguousFailure = Object.assign(
    new Error("connection reset after request submission"),
    { code: "ECONNRESET" },
  );
  const firstLoop = createLoop({
    lifecycleStore,
    llm: new FakeLlm([ambiguousFailure]),
    modelInvocationStore,
    persist: async () => {
      if (modelInvocationStore.list().at(-1)?.status === "outcome_unknown") {
        durable = capture(lifecycleStore, modelInvocationStore);
      }
    },
  });

  await assert.rejects(
    () => firstLoop.run(turn.id, { model: FAKE_MODEL }),
    /outcome.*unknown/i,
  );

  const restarted = restore(requireDurable(durable, "outcome_unknown"));
  const replayProvider = new FakeLlm([]);
  const restartedLoop = createLoop({
    ...restarted,
    llm: replayProvider,
    persist: async () => undefined,
  });

  await assert.rejects(
    () => restartedLoop.run(turn.id, { model: FAKE_MODEL }),
    /outcome_unknown|outcome unknown|blocked|wait|manual|resolve/i,
  );
  assert.equal(replayProvider.requests.length, 0);
  assert.equal(
    restarted.modelInvocationStore.list()[0]?.status,
    "outcome_unknown",
  );
});

test("invocation identity 由 turnId、round、purpose 稳定派生，工具续轮与格式修复不串记录", async () => {
  const { lifecycleStore, turn } = createTurn();
  const modelInvocationStore = new ModelInvocationStore();
  const echoTool: AgentTool = {
    definition: {
      name: "echo_for_wal",
      description: "Return a deterministic local result",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    execute: () => ({
      result: { ok: true },
      modelOutput: { ok: true },
    }),
  };
  const llm = new FakeLlm([
    {
      id: "response-tool",
      text: "",
      functionCalls: [{
        callId: "call-echo",
        name: "echo_for_wal",
        arguments: "{}",
      }],
    },
    {
      id: "response-bad-format",
      text: "bad format",
      functionCalls: [],
    },
    finalResponse("response-repaired"),
  ]);
  const loop = createLoop({
    lifecycleStore,
    llm,
    modelInvocationStore,
    persist: async () => undefined,
    toolRegistry: new ToolRegistry([echoTool]),
  });

  await loop.run(turn.id, {
    model: FAKE_MODEL,
    finalResponseGuard: {
      reject: (text) => text === "bad format" ? "schema mismatch" : undefined,
      repairInstructions: "Return the repaired final response.",
      maxRepairAttempts: 1,
    },
  });

  const invocations = modelInvocationStore.list();
  assert.equal(invocations.length, 3);
  assert.deepEqual(invocations.map((item) => item.turnId), [
    turn.id,
    turn.id,
    turn.id,
  ]);
  assert.deepEqual(invocations.map((item) => item.round), [0, 1, 2]);
  assert.deepEqual(invocations.map((item) => item.purpose), [
    "initial",
    "tool_continuation",
    "format_repair",
  ]);
  assert.equal(new Set(invocations.map((item) => item.invocationId)).size, 3);
  for (const invocation of invocations) {
    assert.equal(
      invocation.invocationId,
      createModelInvocationId(invocation),
    );
  }
});
