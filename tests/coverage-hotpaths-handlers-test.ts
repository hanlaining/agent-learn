import assert from "node:assert/strict";
import test from "node:test";

import { registerAppServerHandlers, type AppServerDependencies } from "../src/app-server/handlers.js";
import { EMPTY_RUNTIME_CAPABILITIES } from "../src/app-server/runtime-capabilities.js";
import { JsonRpcConnection } from "../src/protocol/connection.js";
import { RequirementStore } from "../src/requirements/requirement-store.js";
import { LifecycleStore } from "../src/runtime/lifecycle-store.js";
import type { OutcomeUnknownResolutionService } from "../src/runtime/outcome-unknown-resolution-service.js";

test("App Server public RPC boundaries cover lifecycle, configuration, workspace and finance branches", async () => {
  let saves = 0;
  const logs: string[] = [];
  const searched: string[] = [];
  const app = createApp({
    saveState: () => { saves += 1; },
    log: (message) => { logs.push(message); },
    requirementStore: new RequirementStore(() => "2026-08-24T00:00:00.000Z"),
    selectModel: (model) => ({
      ...EMPTY_RUNTIME_CAPABILITIES,
      llm: true,
      currentModel: model,
      models: [{ id: model, label: model }],
    }),
    workspaceSandbox: {
      searchFiles: async (query) => {
        searched.push(query);
        return { query, paths: ["src/index.ts"], truncated: false };
      },
      validateFilePath: async (path) => `validated/${path}`,
    },
    skillNames: ["finance-analysis"],
  });

  await assert.rejects(app.request("thread/list"), /initialize handshake/u);
  const initialized = await app.request("initialize", { client: "coverage" }) as { capabilities: { cancellation: boolean } };
  assert.equal(initialized.capabilities.cancellation, false);
  await app.notify("initialized");

  const started = await app.request("thread/start") as { id: string };
  assert.equal(typeof started.id, "string");
  assert.equal((await app.request("thread/list") as Array<{ id: string }>).some(({ id }) => id === started.id), true);
  assert.deepEqual(await app.request("thread/trash/list"), []);

  await assert.rejects(app.request("thread/rename", null), /Invalid thread rename/u);
  const renamed = await app.request("thread/rename", { threadId: started.id, title: "Renamed" }) as { title: string };
  assert.equal(renamed.title, "Renamed");

  await assert.rejects(app.request("thread/soft-delete", { threadIds: "bad", batchDeleteId: "batch" }), /Invalid thread soft delete/u);
  await app.request("thread/soft-delete", { threadIds: [started.id], batchDeleteId: "batch-1" });
  assert.equal((await app.request("thread/trash/list") as unknown[]).length, 1);
  assert.equal((await app.request("thread/delete-batch/list") as unknown[]).length, 1);
  await assert.rejects(app.request("thread/delete-batch/restore", {}), /Invalid batch restore/u);
  await app.request("thread/delete-batch/restore", { batchDeleteId: "batch-1" });

  await app.request("thread/soft-delete", { threadIds: [started.id], batchDeleteId: "batch-2" });
  await assert.rejects(app.request("thread/restore", {}), /Invalid thread restore/u);
  await app.request("thread/restore", { threadId: started.id });

  assert.deepEqual(await app.request("requirement/get", { threadId: started.id }), null);
  await assert.rejects(app.request("requirement/get", {}), /Invalid requirement request/u);
  await assert.rejects(app.request("requirement/confirm", {}), /Invalid requirement confirmation/u);

  await assert.rejects(app.request("workspace/search-files", { query: 1 }), /Invalid workspace file search/u);
  assert.deepEqual(await app.request("workspace/search-files", { query: "index" }), {
    query: "index", paths: ["src/index.ts"], truncated: false,
  });
  assert.deepEqual(searched, ["index"]);

  assert.deepEqual(await app.request("agent-run/list", {}), []);
  assert.deepEqual(await app.request("agent-run/list", { threadId: started.id }), []);

  await assert.rejects(app.request("thread/config/get", {}), /Invalid thread config request/u);
  assert.equal(await app.request("thread/config/get", { threadId: started.id }), null);
  await assert.rejects(app.request("thread/config/set", { threadId: started.id }), /Invalid thread config/u);
  const config = await app.request("thread/config/set", {
    threadId: started.id,
    model: "gpt-test",
    reasoningEffort: "high",
    agentProfileId: "orchestrator",
    agentTeam: { mode: "off", allowedProfiles: ["coder"] },
  }) as { model: string; agentTeam: { mode: string } };
  assert.equal(config.model, "gpt-test");
  assert.equal(config.agentTeam.mode, "off");
  assert.deepEqual(await app.request("thread/config/get", { threadId: started.id }), config);

  assert.deepEqual(await app.request("runtime-session/list", {}), []);
  assert.equal(await app.request("runtime-session/list", { threadId: started.id }), null);
  await assert.rejects(app.request("runtime-session/set", {}), /Invalid runtime session/u);
  await app.request("runtime-session/set", {
    threadId: started.id,
    turnState: "thinking",
    session: { turnId: "turn-runtime", status: "running", startedAt: "2026-08-24T00:00:00.000Z", items: [] },
  });
  assert.equal((await app.request("runtime-session/list", { threadId: started.id }) as { turnState: string }).turnState, "thinking");
  assert.equal((await app.request("runtime-session/list", {}) as unknown[]).length, 1);

  for (const params of [undefined, null, {}, { model: " " }]) {
    await assert.rejects(app.request("runtime/select-model", params), /Invalid model selection/u);
  }
  const selected = await app.request("runtime/select-model", { model: "gpt-selected" });
  assert.deepEqual(selected, {
    ...EMPTY_RUNTIME_CAPABILITIES,
    llm: true,
    currentModel: "gpt-selected",
    models: [{ id: "gpt-selected", label: "gpt-selected" }],
  });

  const summary = await app.request("finance/monthly-summary", { period: "2026-07" }) as { transactionCount: number };
  assert.equal(summary.transactionCount, 5);
  await assert.rejects(app.request("finance/monthly-summary", { period: "bad" }), /YYYY-MM/u);
  await assert.rejects(app.request("turn/cancel", { turnId: "none" }), /Agent runtime is unavailable/u);

  const startedTurn = await app.request("turn/start", {
    threadId: started.id,
    input: "inspect",
    mentions: [{ kind: "file", path: "src/index.ts" }, { kind: "file", path: "src/index.ts" }],
    explicitSkills: ["finance-analysis", "finance-analysis"],
  }) as { userMessage: { content: { modelText: string; mentions: unknown[]; explicitSkills: string[] } } };
  assert.match(startedTurn.userMessage.content.modelText, /validated\/src\/index\.ts/u);
  assert.match(startedTurn.userMessage.content.modelText, /finance-analysis/u);
  assert.equal(startedTurn.userMessage.content.mentions.length, 1);
  assert.deepEqual(startedTurn.userMessage.content.explicitSkills, ["finance-analysis"]);
  await assert.rejects(app.request("turn/start", {
    threadId: started.id, input: "inspect", mentions: [], explicitSkills: ["missing-skill"],
  }), /unavailable Skill/u);

  assert.equal(saves >= 8, true);
  assert.equal(logs.some((entry) => entry.includes("finance summary ready")), true);
});

test("thread/soft-delete 在运行中 Turn 上先取消执行，再持久化删除批次", async () => {
  const lifecycleStore = new LifecycleStore({ now: () => "2026-08-24T00:00:00.000Z" });
  const thread = lifecycleStore.createThread();
  const turn = lifecycleStore.createTurn(thread.id);
  lifecycleStore.appendItem(turn.id, "user_message", { text: "running task" });

  const calls: string[] = [];
  const app = createApp({
    lifecycleStore,
    saveState: () => { calls.push("save"); },
    cancelChildAgentRuns: (parentTurnId) => {
      calls.push(`children:${parentTurnId}`);
      return 2;
    },
    agentLoop: {
      run: async () => { throw new Error("not expected"); },
      cancel: (turnId) => { calls.push(`cancel:${turnId}`); return true; },
    },
    agentRuntimeStore: {
      cancelJob: (jobId: string) => { calls.push(`job:${jobId}`); },
    } as never,
  });
  await app.request("initialize", { client: "coverage-running-delete" });
  await app.notify("initialized");

  const result = await app.request("thread/soft-delete", {
    threadIds: [thread.id],
    batchDeleteId: "batch-running",
  }) as Array<{ id: string; status: string }>;

  assert.equal(result[0]?.id, thread.id);
  assert.deepEqual(calls, [
    `children:${turn.id}`,
    `cancel:${turn.id}`,
    `job:job-${turn.id}`,
    "save",
  ]);
  assert.equal(lifecycleStore.getThread(thread.id)?.deletedAt, "2026-08-24T00:00:00.000Z");
  assert.equal(lifecycleStore.getTurn(turn.id)?.status, "in_progress");
});

test("turn/start rejects file mentions when no workspace boundary is configured", async () => {
  const app = createApp();
  await app.notify("initialized");
  const thread = await app.request("thread/start") as { id: string };
  await assert.rejects(app.request("turn/start", {
    threadId: thread.id,
    input: "inspect",
    mentions: [{ kind: "file", path: "src/index.ts" }],
    explicitSkills: [],
  }), /Workspace file mentions are unavailable/u);
});

test("outcome-unknown RPC validates all resolution shapes before delegating", async () => {
  const resolved: unknown[] = [];
  let refreshes = 0;
  const service = {
    list: (_actor: unknown, threadId?: string) => [{ threadId }],
    resolve: (_actor: unknown, input: unknown) => {
      resolved.push(input);
      return input;
    },
  } as unknown as OutcomeUnknownResolutionService;
  const app = createApp({
    outcomeUnknownResolutionService: service,
    resolveOutcomeUnknownActor: () => ({ id: "operator", permissions: ["invocation:view", "invocation:resolve"] }),
    refreshOutcomeUnknownFromRuntime: () => { refreshes += 1; },
  });
  await app.notify("initialized");

  await assert.rejects(app.request("invocation/outcome-unknown/list", { extra: true }), /Invalid outcome-unknown list/u);
  assert.deepEqual(await app.request("invocation/outcome-unknown/list", { threadId: "chat" }), [{ threadId: "chat" }]);

  const base = { resolutionId: "resolution", expectedVersion: 1, idempotencyKey: "key" };
  const valid = [
    { ...base, resolution: { action: "confirm_not_executed_retry", reason: "verified" } },
    { ...base, resolution: { action: "confirm_not_executed_retry", reason: "verified", toolSideEffectConfirmed: true } },
    { ...base, resolution: { action: "record_external_result", reason: "observed", externalResult: { summary: "done", value: { ok: true } } } },
    { ...base, resolution: { action: "mark_manual_required", reason: "needs operator" } },
    { ...base, resolution: { action: "abandon", reason: "closed" } },
  ];
  for (const request of valid) assert.deepEqual(await app.request("invocation/outcome-unknown/resolve", request), request);

  const invalid = [
    null,
    { ...base, extra: true, resolution: { action: "abandon", reason: "x" } },
    { ...base, resolution: { action: "confirm_not_executed_retry", reason: "x", toolSideEffectConfirmed: "yes" } },
    { ...base, resolution: { action: "confirm_not_executed_retry", reason: "x", extra: true } },
    { ...base, resolution: { action: "record_external_result", reason: "x", externalResult: null } },
    { ...base, resolution: { action: "record_external_result", reason: "x", externalResult: { summary: 1, value: true } } },
    { ...base, resolution: { action: "mark_manual_required", reason: "x", extra: true } },
    { ...base, resolution: { action: "unknown", reason: "x" } },
  ];
  for (const request of invalid) await assert.rejects(app.request("invocation/outcome-unknown/resolve", request), /Invalid outcome-unknown/u);
  assert.equal(resolved.length, valid.length);
  assert.equal(refreshes, valid.length + invalid.length + 1);
});

test("outcome-unknown RPC reports unavailable service and operator explicitly", async () => {
  const withoutService = createApp();
  await withoutService.notify("initialized");
  assert.deepEqual(await withoutService.request("invocation/outcome-unknown/list", {}), []);
  await assert.rejects(withoutService.request("invocation/outcome-unknown/resolve", {}), /resolution is unavailable/u);

  const service = { list: () => [], resolve: () => ({}) } as unknown as OutcomeUnknownResolutionService;
  const withoutActor = createApp({ outcomeUnknownResolutionService: service });
  await withoutActor.notify("initialized");
  await assert.rejects(withoutActor.request("invocation/outcome-unknown/list", {}), /operator is unavailable/u);
  await assert.rejects(withoutActor.request("invocation/outcome-unknown/resolve", {}), /operator is unavailable/u);
});

test("requirement confirmation persists the exact reviewed revision", async () => {
  let saves = 0;
  const requirementStore = new RequirementStore(() => "2026-08-24T00:00:00.000Z");
  const planned = prepareRequirement(requirementStore, "thread-confirm");
  const app = createApp({ requirementStore, saveState: () => { saves += 1; } });
  await app.notify("initialized");

  const confirmed = await app.request("requirement/confirm", {
    requirementId: planned.id,
    revision: planned.revision,
    contentHash: planned.planArtifact.contentHash,
  }) as { status: string; confirmedRevision: number; confirmedContentHash: string };

  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.confirmedRevision, planned.revision);
  assert.equal(confirmed.confirmedContentHash, planned.planArtifact.contentHash);
  assert.equal(saves, 1);
});

test("design confirmation contains an asynchronous V3 resume failure", async () => {
  const lifecycleStore = new LifecycleStore({ now: () => "2026-08-24T00:00:00.000Z" });
  const thread = lifecycleStore.createThread();
  const requirementStore = new RequirementStore(() => "2026-08-24T00:00:00.000Z");
  const planned = prepareRequirement(requirementStore, thread.id, "software_product_delivery");
  requirementStore.confirm(planned.id, planned.revision, planned.planArtifact.contentHash);
  const designHash = "d".repeat(64);
  requirementStore.markDesignDraft(planned.id, planned.revision, {
    path: "design.md", contentHash: designHash, generatedAt: "2026-08-24T00:00:00.000Z",
  });
  requirementStore.attachJob(planned.id, "job-v3");

  let saves = 0;
  const failures: unknown[][] = [];
  const reboundTurns: string[] = [];
  const job = {
    id: "job-v3", threadId: thread.id, rootTurnId: "turn-root", rootRunId: "run-root", attempt: 1,
    status: "running", executionKind: "software_product_delivery", workflowVersion: "software_product_delivery_v3",
  };
  const app = createApp({
    lifecycleStore,
    requirementStore,
    saveState: () => { saves += 1; },
    agentRuntimeStore: {
      getJob: () => job,
      rebindJobTurn: (_jobId: string, turnId: string) => { reboundTurns.push(turnId); },
      failJob: (...args: unknown[]) => { failures.push(args); },
    } as unknown as NonNullable<AppServerDependencies["agentRuntimeStore"]>,
    agentRunStore: {
      rebindAttempt: () => undefined,
    } as unknown as NonNullable<AppServerDependencies["agentRunStore"]>,
    executionEngineRouter: {
      resume: async () => { throw new Error("resume failed"); },
    } as unknown as NonNullable<AppServerDependencies["executionEngineRouter"]>,
  });
  await app.notify("initialized");

  const confirmed = await app.request("requirement/design-confirm", {
    requirementId: planned.id, revision: planned.revision, contentHash: designHash,
  }) as { designStatus: string };
  await new Promise<void>((resolve) => { setImmediate(resolve); });

  assert.equal(confirmed.designStatus, "confirmed");
  assert.equal(reboundTurns.length, 1);
  assert.deepEqual(failures, [["job-v3", "failed", "async_resume_failed"]]);
  assert.equal(saves, 2);
});

test("V3 design feedback and engineering rework validate and delegate", async () => {
  const requirementStore = new RequirementStore(() => "2026-08-24T00:00:00.000Z");
  const planned = prepareRequirement(requirementStore, "thread-v3", "software_product_delivery");
  requirementStore.confirm(planned.id, planned.revision, planned.planArtifact.contentHash);
  requirementStore.attachJob(planned.id, "job-v3");
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const job = {
    id: "job-v3", threadId: "thread-v3", status: "reviewing", attempt: 1,
    executionKind: "software_product_delivery", workflowVersion: "software_product_delivery_v3",
  };
  const runtimeStore = {
    getJob: () => job,
    listJobs: () => [job],
  } as unknown as NonNullable<AppServerDependencies["agentRuntimeStore"]>;
  const router = {
    provideFeedback: async (...args: unknown[]) => { calls.push({ method: "feedback", args }); return true; },
    resume: async (...args: unknown[]) => { calls.push({ method: "resume", args }); },
    requestEngineeringRework: async (...args: unknown[]) => { calls.push({ method: "rework", args }); },
  } as unknown as NonNullable<AppServerDependencies["executionEngineRouter"]>;
  const app = createApp({ requirementStore, agentRuntimeStore: runtimeStore, executionEngineRouter: router });
  await app.notify("initialized");

  await assert.rejects(app.request("requirement/design-feedback", {
    requirementId: planned.id, feedback: "   ",
  }), /Invalid design feedback/u);
  await assert.rejects(app.request("agent/engineering-chat/rework", {
    threadId: "thread-v3", taskId: "task-1",
  }), /Invalid engineering Chat rework/u);
  const feedbackResult = await app.request("requirement/design-feedback", {
    requirementId: planned.id, feedback: "Move the primary action above the fold",
  }) as { id: string };
  const reworkResult = await app.request("agent/engineering-chat/rework", {
    threadId: "thread-v3", taskId: "task-1", reason: "Acceptance check failed",
  });

  assert.equal(feedbackResult.id, planned.id);
  assert.deepEqual(reworkResult, { jobId: "job-v3", taskId: "task-1" });
  assert.equal(calls[0]?.method, "feedback");
  assert.equal((calls[0]?.args[2] as { text: string }).text, "Move the primary action above the fold");
  assert.deepEqual(calls.slice(1), [
    { method: "resume", args: ["software_product_delivery", "job-v3"] },
    { method: "rework", args: ["software_product_delivery", "job-v3", "task-1", "Acceptance check failed"] },
  ]);
});

test("fixed-product advance distinguishes invalid, missing and delegated jobs", async () => {
  const unavailable = createApp();
  await unavailable.notify("initialized");
  await assert.rejects(unavailable.request("agent/fixed-product/advance", {
    threadId: "thread-v3", expectedStage: "engineering_ready",
  }), /Invalid fixed product advance request/u);

  const runtimeStore = {
    listJobs: (threadId: string) => threadId === "thread-v3" ? [{
      id: "job-v3", threadId, executionKind: "software_product_delivery", createdAt: "2026-08-24T00:00:00.000Z",
    }] : [],
  } as unknown as NonNullable<AppServerDependencies["agentRuntimeStore"]>;
  const advances: unknown[][] = [];
  const router = {
    advance: async (...args: unknown[]) => { advances.push(args); return { stage: "engineering_ready", changed: true }; },
  } as unknown as NonNullable<AppServerDependencies["executionEngineRouter"]>;
  const app = createApp({ agentRuntimeStore: runtimeStore, executionEngineRouter: router });
  await app.notify("initialized");

  await assert.rejects(app.request("agent/fixed-product/advance", {
    threadId: "missing", expectedStage: "engineering_ready",
  }), /Fixed product Job is unavailable/u);
  assert.deepEqual(await app.request("agent/fixed-product/advance", {
    threadId: "thread-v3", expectedStage: "engineering_ready",
  }), { stage: "engineering_ready", changed: true });
  assert.deepEqual(advances, [["software_product_delivery", "job-v3", "engineering_ready"]]);
});

interface AppHarness {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
}

function createApp(options: Partial<Omit<AppServerDependencies, "lifecycleStore">> & {
  lifecycleStore?: LifecycleStore;
} = {}): AppHarness {
  const clientToServer: string[] = [];
  const serverToClient: string[] = [];
  const client = new JsonRpcConnection((data) => { clientToServer.push(data); });
  const server = new JsonRpcConnection((data) => { serverToClient.push(data); });
  const { lifecycleStore = new LifecycleStore({ now: () => "2026-08-24T00:00:00.000Z" }), ...dependencies } = options;
  registerAppServerHandlers(server, { lifecycleStore, ...dependencies });

  return {
    async request(method, params) {
      const pending = client.sendRequest(method, params);
      await server.receive(clientToServer.shift()!);
      await client.receive(serverToClient.shift()!);
      return pending;
    },
    async notify(method, params) {
      client.sendNotification(method, params);
      await server.receive(clientToServer.shift()!);
    },
  };
}

function prepareRequirement(
  store: RequirementStore,
  threadId: string,
  executionKind: "software_change" | "software_product_delivery" = "software_change",
) {
  return store.prepare(threadId, {
    executionKind,
    title: "Coverage requirement",
    objective: "Exercise App Server behavior",
    scope: ["src/app-server"],
    nonGoals: [],
    constraints: ["tests only"],
    deliverables: ["coverage"],
    acceptanceCriteria: ["RPC delegates safely"],
    testCases: [{ id: "TC-COVERAGE", title: "RPC", kind: "integration", steps: ["request"], expected: "delegated" }],
    executionSteps: ["verify"],
  }, {
    path: "requirements/coverage.md",
    contentHash: "c".repeat(64),
    generatedAt: "2026-08-24T00:00:00.000Z",
  });
}
