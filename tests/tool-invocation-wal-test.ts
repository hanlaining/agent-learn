import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoop } from "../src/agent/agent-loop.js";
import type {
  LlmCreateResponseRequest,
  LlmProvider,
  LlmResponse,
} from "../src/llm/types.js";
import { LifecycleStore } from "../src/runtime/lifecycle-store.js";
import { ModelInvocationStore } from "../src/runtime/model-invocation-store.js";
import {
  createToolArgumentsDigest,
  createToolInvocationId,
  type ToolInvocationIdentity,
  type ToolInvocationSnapshot,
  type ToolInvocationStatus,
} from "../src/runtime/tool-invocation.js";
import {
  ToolInvocationStore,
} from "../src/runtime/tool-invocation-store.js";
import {
  ToolRegistry,
  type AgentTool,
} from "../src/tools/tool-registry.js";

const FAKE_MODEL = "fake-tool-wal-model";

class FakeProvider implements LlmProvider {
  readonly requests: LlmCreateResponseRequest[] = [];

  constructor(private readonly responses: Array<LlmResponse | Error>) {}

  async createResponse(request: LlmCreateResponseRequest): Promise<LlmResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (response === undefined) throw new Error("Unexpected fake Provider call");
    if (response instanceof Error) throw response;
    return structuredClone(response);
  }
}

class SimulatedCrash extends Error {
  constructor(checkpoint: string) {
    super(`simulated process crash after ${checkpoint}`);
    this.name = "SimulatedCrash";
  }
}

interface DurableSnapshot {
  lifecycle: ReturnType<LifecycleStore["exportSnapshot"]>;
  modelInvocations: ReturnType<ModelInvocationStore["exportSnapshot"]>;
  toolInvocations: ToolInvocationSnapshot;
}

function createTurn() {
  const lifecycleStore = new LifecycleStore({
    now: () => "2026-08-18T17:00:00.000Z",
  });
  const thread = lifecycleStore.createThread();
  const turn = lifecycleStore.createTurn(thread.id);
  lifecycleStore.appendItem(turn.id, "user_message", {
    text: "execute the durable tool",
  });
  return { lifecycleStore, turn };
}

function createLoop(input: {
  lifecycleStore: LifecycleStore;
  modelInvocationStore: ModelInvocationStore;
  toolInvocationStore: ToolInvocationStore;
  provider: LlmProvider;
  persist: () => Promise<void>;
  toolRegistry: ToolRegistry;
}) {
  const options: ConstructorParameters<typeof AgentLoop>[0] = {
    lifecycleStore: input.lifecycleStore,
    llm: input.provider,
    toolRegistry: input.toolRegistry,
    modelInvocationWal: {
      store: input.modelInvocationStore,
      persist: input.persist,
      provider: "fake",
      defaultModel: FAKE_MODEL,
    },
    toolInvocationWal: {
      store: input.toolInvocationStore,
      persist: input.persist,
    },
  };
  return new AgentLoop(options);
}

function capture(
  lifecycleStore: LifecycleStore,
  modelInvocationStore: ModelInvocationStore,
  toolInvocationStore: ToolInvocationStore,
): DurableSnapshot {
  return structuredClone({
    lifecycle: lifecycleStore.exportSnapshot(),
    modelInvocations: modelInvocationStore.exportSnapshot(),
    toolInvocations: toolInvocationStore.exportSnapshot(),
  });
}

function restore(snapshot: DurableSnapshot) {
  return {
    lifecycleStore: LifecycleStore.fromSnapshot(snapshot.lifecycle),
    modelInvocationStore: ModelInvocationStore.fromSnapshot(
      snapshot.modelInvocations,
    ),
    toolInvocationStore: ToolInvocationStore.fromSnapshot(
      snapshot.toolInvocations,
    ),
  };
}

function toolCallResponse(): LlmResponse {
  return {
    id: "response-tool-call",
    text: "",
    functionCalls: [{
      callId: "call-durable-tool",
      name: "durable_tool",
      arguments: '{"path":"README.md","value":1}',
    }],
  };
}

function finalResponse(): LlmResponse {
  return {
    id: "response-after-tool",
    text: "durable tool completed",
    functionCalls: [],
  };
}

function createTool(onExecute: () => void): AgentTool {
  return {
    definition: {
      name: "durable_tool",
      description: "A fake local tool for WAL tests",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: true,
      },
    },
    execute: () => {
      onExecute();
      return {
        result: { ok: true, value: 1 },
        modelOutput: { ok: true },
      };
    },
  };
}

function baseIdentity(argumentsDigest: string): ToolInvocationIdentity {
  return {
    modelInvocationId: "model-invocation-stable",
    callId: "call-stable",
    toolName: "durable_tool",
    argumentsDigest,
  };
}

test("toolInvocationId 稳定来自 modelInvocationId、callId、toolName、argumentsDigest", async () => {
  const leftArguments = { value: 1, path: "README.md" };
  const rightArguments = { path: "README.md", value: 1 };
  const leftDigest = createToolArgumentsDigest(leftArguments);
  const rightDigest = createToolArgumentsDigest(rightArguments);
  assert.equal(leftDigest, rightDigest);
  assert.match(leftDigest, /^sha256:[a-f0-9]{64}$/);

  const left = baseIdentity(leftDigest);
  const reordered = {
    argumentsDigest: rightDigest,
    toolName: left.toolName,
    callId: left.callId,
    modelInvocationId: left.modelInvocationId,
  };
  assert.equal(
    createToolInvocationId(left),
    createToolInvocationId(reordered),
  );
  assert.match(
    createToolInvocationId(left),
    /^tool-invocation-[a-f0-9]{32}$/,
  );
});

test("ToolInvocationStore 主路径、重复 prepare 与重复 commit 均保持幂等", async () => {
  const store = new ToolInvocationStore(
    () => "2026-08-18T17:00:00.000Z",
  );
  const input = baseIdentity(
    createToolArgumentsDigest({ path: "README.md", value: 1 }),
  );
  const prepared = store.prepare(input);
  assert.equal(prepared.status, "prepared");
  assert.deepEqual(store.prepare(input), prepared);
  assert.equal(store.list().length, 1);
  assert.equal(store.markExecuting(prepared.toolInvocationId).status, "executing");
  assert.equal(store.recordResult(prepared.toolInvocationId, {
    result: { ok: true },
    output: '{"ok":true}',
  }).status, "result_received");
  const committed = store.markCommitted(
    prepared.toolInvocationId,
    "turn:turn-1:tool:call-stable",
  );
  const snapshot = store.exportSnapshot();
  assert.equal(committed.status, "committed");
  assert.deepEqual(
    store.markCommitted(
      prepared.toolInvocationId,
      "turn:turn-1:tool:call-stable",
    ),
    committed,
  );
  assert.deepEqual(store.exportSnapshot(), snapshot);
});

test("ToolInvocation snapshot 不持久化 authorization、apiKey 或秘密值", async () => {
  const store = new ToolInvocationStore();
  const unsafeInput = {
    ...baseIdentity(createToolArgumentsDigest({ path: "README.md" })),
    authorization: "Bearer tool-secret",
    apiKey: "sk-tool-secret",
  } as Parameters<ToolInvocationStore["prepare"]>[0];
  store.prepare(unsafeInput);
  const serialized = JSON.stringify(store.exportSnapshot());
  assert.doesNotMatch(serialized, /authorization|apiKey/i);
  assert.doesNotMatch(serialized, /tool-secret/);
});

test("执行前 prepared/executing 已持久化，结果先以 result_received 持久化再写 Lifecycle ToolResult", async () => {
  const { lifecycleStore, turn } = createTurn();
  const modelInvocationStore = new ModelInvocationStore();
  const toolInvocationStore = new ToolInvocationStore();
  const persistedStatuses: ToolInvocationStatus[] = [];
  const persistedLifecycle: Array<{
    status: ToolInvocationStatus;
    itemTypes: string[];
  }> = [];
  let statusesObservedByTool: ToolInvocationStatus[] = [];
  const registry = new ToolRegistry([createTool(() => {
    statusesObservedByTool = [...persistedStatuses];
  })]);
  const loop = createLoop({
    lifecycleStore,
    modelInvocationStore,
    toolInvocationStore,
    provider: new FakeProvider([toolCallResponse(), finalResponse()]),
    toolRegistry: registry,
    persist: async () => {
      const invocation = toolInvocationStore.list().at(-1);
      if (invocation === undefined) return;
      persistedStatuses.push(invocation.status);
      persistedLifecycle.push({
        status: invocation.status,
        itemTypes: lifecycleStore
          .getItemsForTurn(turn.id)
          .map((item) => item.type),
      });
    },
  });

  await loop.run(turn.id, { model: FAKE_MODEL });

  assert.deepEqual(statusesObservedByTool.slice(-2), ["prepared", "executing"]);
  const received = persistedLifecycle.find(
    (entry) => entry.status === "result_received",
  );
  assert.ok(received);
  assert.equal(received.itemTypes.includes("tool_result"), false);
  const committed = persistedLifecycle.find(
    (entry) => entry.status === "committed",
  );
  assert.ok(committed?.itemTypes.includes("tool_result"));
});

test("result_received snapshot 重启零 Tool 调用重放，committed snapshot 同样跳过", async () => {
  for (const checkpoint of ["result_received", "committed"] as const) {
    const { lifecycleStore, turn } = createTurn();
    const modelInvocationStore = new ModelInvocationStore();
    const toolInvocationStore = new ToolInvocationStore();
    let durable: DurableSnapshot | undefined;
    let toolCalls = 0;
    const firstLoop = createLoop({
      lifecycleStore,
      modelInvocationStore,
      toolInvocationStore,
      provider: new FakeProvider([toolCallResponse(), finalResponse()]),
      toolRegistry: new ToolRegistry([createTool(() => { toolCalls += 1; })]),
      persist: async () => {
        if (
          durable === undefined &&
          toolInvocationStore.list().at(-1)?.status === checkpoint
        ) {
          durable = capture(
            lifecycleStore,
            modelInvocationStore,
            toolInvocationStore,
          );
          throw new SimulatedCrash(`${checkpoint} persist`);
        }
      },
    });
    await assert.rejects(
      () => firstLoop.run(turn.id, { model: FAKE_MODEL }),
      SimulatedCrash,
    );
    assert.ok(durable, `expected durable ${checkpoint} snapshot`);
    assert.equal(toolCalls, 1);

    const restarted = restore(durable);
    const restartedLoop = createLoop({
      ...restarted,
      provider: new FakeProvider([finalResponse()]),
      toolRegistry: new ToolRegistry([createTool(() => { toolCalls += 1; })]),
      persist: async () => undefined,
    });
    await restartedLoop.run(turn.id, { model: FAKE_MODEL });

    assert.equal(toolCalls, 1, `${checkpoint} replay re-executed Tool`);
    assert.equal(
      restarted.lifecycleStore
        .getItemsForTurn(turn.id)
        .filter((item) => item.type === "tool_result").length,
      1,
    );
    assert.equal(
      restarted.toolInvocationStore.list()[0]?.status,
      "committed",
    );
  }
});

test("executing 与 outcome_unknown snapshot 重启必须明确阻断且禁止重执行", async () => {
  for (const checkpoint of ["executing", "outcome_unknown"] as const) {
    const { lifecycleStore, turn } = createTurn();
    const modelInvocationStore = new ModelInvocationStore();
    const toolInvocationStore = new ToolInvocationStore();
    let durable: DurableSnapshot | undefined;
    let toolCalls = 0;
    const loop = createLoop({
      lifecycleStore,
      modelInvocationStore,
      toolInvocationStore,
      provider: new FakeProvider([toolCallResponse()]),
      toolRegistry: new ToolRegistry([createTool(() => { toolCalls += 1; })]),
      persist: async () => {
        const invocation = toolInvocationStore.list().at(-1);
        if (durable !== undefined || invocation?.status !== "executing") return;
        if (checkpoint === "outcome_unknown") {
          toolInvocationStore.markOutcomeUnknown(
            invocation.toolInvocationId,
            "process_recovered_during_tool_execution",
          );
        }
        durable = capture(
          lifecycleStore,
          modelInvocationStore,
          toolInvocationStore,
        );
        throw new SimulatedCrash(`${checkpoint} persist`);
      },
    });
    await assert.rejects(
      () => loop.run(turn.id, { model: FAKE_MODEL }),
      SimulatedCrash,
    );
    assert.ok(durable, `expected durable ${checkpoint} snapshot`);

    const restarted = restore(durable);
    const restartedLoop = createLoop({
      ...restarted,
      provider: new FakeProvider([]),
      toolRegistry: new ToolRegistry([createTool(() => { toolCalls += 1; })]),
      persist: async () => undefined,
    });
    await assert.rejects(
      () => restartedLoop.run(turn.id, { model: FAKE_MODEL }),
      /tool.*outcome_unknown|outcome unknown|blocked|explicit|manual|resolve/i,
    );
    assert.equal(toolCalls, 0);
    assert.equal(
      restarted.toolInvocationStore.list()[0]?.status,
      "outcome_unknown",
    );
  }
});

test("同一 result_received snapshot 的两个并发恢复只执行一次", async () => {
  const { lifecycleStore, turn } = createTurn();
  const modelInvocationStore = new ModelInvocationStore();
  const toolInvocationStore = new ToolInvocationStore();
  let durable: DurableSnapshot | undefined;
  let toolCalls = 0;
  const firstLoop = createLoop({
    lifecycleStore,
    modelInvocationStore,
    toolInvocationStore,
    provider: new FakeProvider([toolCallResponse()]),
    toolRegistry: new ToolRegistry([createTool(() => { toolCalls += 1; })]),
    persist: async () => {
      if (
        durable === undefined &&
        toolInvocationStore.list()[0]?.status === "result_received"
      ) {
        durable = capture(lifecycleStore, modelInvocationStore, toolInvocationStore);
        throw new SimulatedCrash("result_received persist");
      }
    },
  });
  await assert.rejects(
    () => firstLoop.run(turn.id, { model: FAKE_MODEL }),
    SimulatedCrash,
  );
  assert.ok(durable, "expected durable result_received snapshot");

  const restarted = restore(durable);
  const provider = new FakeProvider([finalResponse()]);
  const restartedLoop = createLoop({
    ...restarted,
    provider,
    toolRegistry: new ToolRegistry([createTool(() => { toolCalls += 1; })]),
    persist: async () => undefined,
  });
  const results = await Promise.allSettled([
    restartedLoop.run(turn.id, { model: FAKE_MODEL }),
    restartedLoop.run(turn.id, { model: FAKE_MODEL }),
  ]);

  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.filter((result) => result.status === "rejected").length,
    1,
  );
  assert.equal(toolCalls, 1);
  assert.equal(
    restarted.lifecycleStore
      .getItemsForTurn(turn.id)
      .filter((item) => item.type === "tool_result").length,
    1,
  );
});
