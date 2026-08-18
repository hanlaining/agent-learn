import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
import type {
  ModelInvocationStatus,
} from "../src/runtime/model-invocation.js";
import {
  ModelInvocationStore,
} from "../src/runtime/model-invocation-store.js";
import {
  ModelInvocationStartupRecovery,
} from "../src/runtime/model-invocation-startup-recovery.js";
import {
  ToolRegistry,
  type AgentTool,
} from "../src/tools/tool-registry.js";

const FAKE_MODEL = "fake-startup-model";

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

interface RuntimeSnapshot {
  lifecycle: ReturnType<LifecycleStore["exportSnapshot"]>;
  modelInvocations: ReturnType<ModelInvocationStore["exportSnapshot"]>;
}

function createTurn() {
  const lifecycleStore = new LifecycleStore({
    now: () => "2026-08-18T15:00:00.000Z",
  });
  const thread = lifecycleStore.createThread();
  const turn = lifecycleStore.createTurn(thread.id);
  lifecycleStore.appendItem(turn.id, "user_message", {
    text: "recover this durable turn",
  });
  return { lifecycleStore, turn };
}

function capture(
  lifecycleStore: LifecycleStore,
  modelInvocationStore: ModelInvocationStore,
): RuntimeSnapshot {
  return structuredClone({
    lifecycle: lifecycleStore.exportSnapshot(),
    modelInvocations: modelInvocationStore.exportSnapshot(),
  });
}

function restore(snapshot: RuntimeSnapshot) {
  return {
    lifecycleStore: LifecycleStore.fromSnapshot(
      structuredClone(snapshot.lifecycle),
    ),
    modelInvocationStore: ModelInvocationStore.fromSnapshot(
      structuredClone(snapshot.modelInvocations),
    ),
  };
}

function restoreForStartup(snapshot: RuntimeSnapshot) {
  const restored = restore(snapshot);
  const recoveredTurnIds = restored.lifecycleStore
    .recoverInProgressTurns()
    .map((turn) => turn.id);
  return { ...restored, recoveredTurnIds };
}

function createLoop(input: {
  lifecycleStore: LifecycleStore;
  modelInvocationStore: ModelInvocationStore;
  provider: LlmProvider;
  persist?: () => Promise<void>;
  toolRegistry?: ToolRegistry;
}) {
  return new AgentLoop({
    lifecycleStore: input.lifecycleStore,
    llm: input.provider,
    modelInvocationWal: {
      store: input.modelInvocationStore,
      persist: input.persist ?? (async () => undefined),
      provider: "fake",
      defaultModel: FAKE_MODEL,
    },
    ...(input.toolRegistry === undefined
      ? {}
      : { toolRegistry: input.toolRegistry }),
  });
}

function finalResponse(id = "response-final"): LlmResponse {
  return {
    id,
    text: "recovered durable assistant",
    functionCalls: [],
  };
}

async function crashAtStatus(
  targetStatus: Extract<
    ModelInvocationStatus,
    "submitted" | "response_received" | "committed"
  >,
): Promise<{
  snapshot: RuntimeSnapshot;
  turnId: string;
  provider: FakeProvider;
}> {
  const { lifecycleStore, turn } = createTurn();
  const modelInvocationStore = new ModelInvocationStore();
  let durable: RuntimeSnapshot | undefined;
  const provider = new FakeProvider([finalResponse("response-before-crash")]);
  const loop = createLoop({
    lifecycleStore,
    modelInvocationStore,
    provider,
    persist: async () => {
      if (
        durable === undefined &&
        modelInvocationStore.list().at(-1)?.status === targetStatus
      ) {
        durable = capture(lifecycleStore, modelInvocationStore);
        throw new SimulatedCrash(`${targetStatus} persist`);
      }
    },
  });

  await assert.rejects(
    () => loop.run(turn.id, { model: FAKE_MODEL }),
    SimulatedCrash,
  );
  assert.ok(durable, `expected ${targetStatus} to reach durable snapshot`);
  return { snapshot: durable, turnId: turn.id, provider };
}

test("恢复调度从 response_received snapshot 零 Provider 重放，并保持 Turn、Assistant、WAL 终态一致", async () => {
  const durable = await crashAtStatus("response_received");
  const restarted = restoreForStartup(durable.snapshot);
  const providerCallsBeforeRecovery = durable.provider.requests.length;
  const recovery = new ModelInvocationStartupRecovery({
    ...restarted,
    persist: async () => undefined,
  });

  const [result] = await recovery.recover(restarted.recoveredTurnIds);

  assert.equal(durable.provider.requests.length, providerCallsBeforeRecovery);
  assert.equal(result?.action, "replayed_response");
  assert.equal(
    restarted.lifecycleStore.getTurn(durable.turnId)?.status,
    "completed",
  );
  assert.deepEqual(
    restarted.lifecycleStore
      .getItemsForTurn(durable.turnId)
      .map((item) => item.type),
    ["user_message", "assistant_message"],
  );
  const invocation = restarted.modelInvocationStore.list()[0];
  assert.equal(invocation?.status, "committed");
  assert.equal(
    invocation?.targetCommitKey,
    `turn:${durable.turnId}:assistant`,
  );
});

test("恢复调度遇到 committed snapshot 直接跳过且不重复 Assistant", async () => {
  const durable = await crashAtStatus("committed");
  const restarted = restore(durable.snapshot);
  const providerCallsBeforeRecovery = durable.provider.requests.length;
  const recovery = new ModelInvocationStartupRecovery({
    ...restarted,
    persist: async () => undefined,
  });

  const result = await recovery.recoverTurn(durable.turnId);

  assert.equal(durable.provider.requests.length, providerCallsBeforeRecovery);
  assert.equal(result.action, "completed_turn");
  assert.equal(
    restarted.lifecycleStore
      .getItemsForTurn(durable.turnId)
      .filter((item) => item.type === "assistant_message").length,
    1,
  );
  assert.equal(
    restarted.modelInvocationStore.list()[0]?.status,
    "committed",
  );
});

test("恢复调度把 submitted 转为 outcome_unknown 并阻断重发", async () => {
  const durable = await crashAtStatus("submitted");
  const restarted = restoreForStartup(durable.snapshot);
  const providerCallsBeforeRecovery = durable.provider.requests.length;
  const recovery = new ModelInvocationStartupRecovery({
    ...restarted,
    persist: async () => undefined,
  });

  const [result] = await recovery.recover(restarted.recoveredTurnIds);

  assert.equal(durable.provider.requests.length, providerCallsBeforeRecovery);
  assert.deepEqual(result, {
    turnId: durable.turnId,
    action: "blocked",
    invocationId: restarted.modelInvocationStore.list()[0]?.invocationId,
    diagnosticCode: "submitted_outcome_unknown",
  });
  const invocation = restarted.modelInvocationStore.list()[0];
  assert.equal(invocation?.status, "outcome_unknown");
  assert.equal(
    invocation?.lastErrorCode,
    "startup_recovery_blocked_after_submit",
  );
});

test("同一 response_received Turn 的两个并发恢复只允许一个执行体提交", async () => {
  const durable = await crashAtStatus("response_received");
  const restarted = restoreForStartup(durable.snapshot);
  const providerCallsBeforeRecovery = durable.provider.requests.length;
  let releasePersist!: () => void;
  let enteredPersist!: () => void;
  const persistEntered = new Promise<void>((resolve) => {
    enteredPersist = resolve;
  });
  const persistGate = new Promise<void>((resolve) => {
    releasePersist = resolve;
  });
  let persistCalls = 0;
  const recovery = new ModelInvocationStartupRecovery({
    ...restarted,
    persist: async () => {
      persistCalls += 1;
      enteredPersist();
      await persistGate;
    },
  });

  const first = recovery.recoverTurn(durable.turnId);
  await persistEntered;
  const second = recovery.recoverTurn(durable.turnId);
  releasePersist();
  const results = await Promise.all([first, second]);

  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0]?.action, "replayed_response");
  assert.equal(persistCalls, 1);
  assert.equal(durable.provider.requests.length, providerCallsBeforeRecovery);
  assert.equal(
    restarted.lifecycleStore
      .getItemsForTurn(durable.turnId)
      .filter((item) => item.type === "assistant_message").length,
    1,
  );
  assert.equal(
    restarted.modelInvocationStore.list()[0]?.status,
    "committed",
  );
});

test("App 启动代码必须构造 ModelInvocation 恢复器并等待调度完成", async () => {
  const source = await readFile(
    new URL("../src/app-server/main.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /new\s+ModelInvocationStartupRecovery\s*\(/,
    "App startup does not construct the ModelInvocation recovery scheduler",
  );
  assert.match(
    source,
    /\.recover\(loadedRuntimeState\.recoveredTurnIds\)/,
  );
  assert.match(source, /await\s+startupRecoveryPromise/);
  assert.doesNotMatch(
    source,
    /continueTurn\s*:/,
    "App startup must never wire ModelInvocation recovery to AgentLoop.run",
  );
  assert.match(
    source,
    /new\s+OpenAiResponsesProvider\s*\(\s*\{[\s\S]*?maxRetries\s*:\s*0/,
    "App WAL provider must dispatch each submitted invocation only once",
  );
});

test("Tool 成功但 ToolResult 落盘前崩溃时启动恢复必须阻断，不能重放副作用", async () => {
  const { lifecycleStore, turn } = createTurn();
  const modelInvocationStore = new ModelInvocationStore();
  let durable: RuntimeSnapshot | undefined;
  let toolExecutions = 0;
  const tool: AgentTool = {
    definition: {
      name: "non_idempotent_tool",
      description: "A local tool with an observable side effect",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    execute: () => {
      toolExecutions += 1;
      if (toolExecutions === 1) {
        throw new SimulatedCrash("Tool side effect, before ToolResult persist");
      }
      return {
        result: { execution: toolExecutions },
        modelOutput: { execution: toolExecutions },
      };
    },
  };
  const registry = new ToolRegistry([tool]);
  const firstLoop = createLoop({
    lifecycleStore,
    modelInvocationStore,
    provider: new FakeProvider([{
      id: "response-tool-before-crash",
      text: "",
      functionCalls: [{
        callId: "call-non-idempotent",
        name: "non_idempotent_tool",
        arguments: "{}",
      }],
    }]),
    toolRegistry: registry,
    persist: async () => {
      if (
        durable === undefined &&
        modelInvocationStore.list()[0]?.status === "response_received"
      ) {
        durable = capture(lifecycleStore, modelInvocationStore);
      }
    },
  });

  await assert.rejects(
    () => firstLoop.run(turn.id, { model: FAKE_MODEL }),
  );
  assert.ok(durable, "expected the last successful snapshot before ToolResult");
  assert.equal(toolExecutions, 1);

  const restarted = restoreForStartup(durable);
  const recovery = new ModelInvocationStartupRecovery({
    ...restarted,
    persist: async () => undefined,
  });
  const [result] = await recovery.recover(restarted.recoveredTurnIds);

  assert.equal(toolExecutions, 1);
  assert.deepEqual(result, {
    turnId: turn.id,
    action: "blocked",
    invocationId: restarted.modelInvocationStore.list()[0]?.invocationId,
    diagnosticCode: "response_received_requires_tool_wal",
  });
  assert.equal(restarted.lifecycleStore.getTurn(turn.id)?.status, "interrupted");
  assert.equal(
    restarted.modelInvocationStore.list()[0]?.status,
    "response_received",
  );
  assert.equal(
    restarted.lifecycleStore
      .getItemsForTurn(turn.id)
      .filter((item) => item.type === "assistant_message").length,
    0,
  );
});
