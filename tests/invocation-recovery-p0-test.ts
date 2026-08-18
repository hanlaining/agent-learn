import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoop } from "../src/agent/agent-loop.js";
import { AgentRunStore } from "../src/agents/agent-run-store.js";
import { AgentRuntimeCoordinator } from "../src/agents/agent-runtime-coordinator.js";
import { AgentRuntimeStore } from "../src/agents/agent-runtime-store.js";
import { DEFAULT_AGENT_TEAM_CONFIG } from "../src/agents/agent-runtime.js";
import { ensureFixedSoftwareTeam } from "../src/agents/fixed-software-team.js";
import { TeamWorkflowExecutionEngine } from "../src/execution/team-workflow-execution-engine.js";
import { WorkflowTeamCoordinator } from "../src/execution/workflow-team-coordinator.js";
import { STAGE_RESULT_CONTRACT_VERSION } from "../src/execution/stage-contract.js";
import { SOFTWARE_PRODUCT_DELIVERY_TEMPLATE } from "../src/execution/workflows/software-product-delivery.js";
import { LifecycleStore } from "../src/runtime/lifecycle-store.js";
import { createModelRequestDigest } from "../src/runtime/model-invocation.js";
import { ModelInvocationStartupRecovery } from "../src/runtime/model-invocation-startup-recovery.js";
import { ModelInvocationStore } from "../src/runtime/model-invocation-store.js";
import { createToolArgumentsDigest } from "../src/runtime/tool-invocation.js";
import { ToolInvocationStore } from "../src/runtime/tool-invocation-store.js";
import { ScriptedLlmProvider } from "./helpers/scripted-llm.js";

const validStageResult = JSON.stringify({
  status: "completed",
  summary: "durable stage result",
  deliverables: ["artifact"],
  evidence: ["verified"],
  blockers: [],
  nextStageRecommendation: "continue",
  contractVersion: STAGE_RESULT_CONTRACT_VERSION,
});

test("P0: compaction response_received 启动恢复零 Provider，显式 run 才续跑", async () => {
  const lifecycle = interruptedTurn("compaction");
  const store = responseReceivedInvocation(lifecycle.turn.id, "compaction", "handoff summary");
  const provider = new ScriptedLlmProvider([{
    id: "explicit-final",
    text: "explicit resume completed",
    functionCalls: [],
  }]);
  const recovery = new ModelInvocationStartupRecovery({
    lifecycleStore: lifecycle.store,
    modelInvocationStore: store,
    persist: async () => undefined,
  });

  const result = await recovery.recoverTurn(lifecycle.turn.id);

  assert.equal(result.action, "blocked");
  assert.equal(result.diagnosticCode, "explicit_resume_required");
  assert.equal(provider.requests.length, 0);
  assert.equal(lifecycle.store.getItemsForTurn(lifecycle.turn.id)
    .some((item) => item.type === "assistant_message"), false);
  assert.equal(lifecycle.store.getTurn(lifecycle.turn.id)?.status, "interrupted");

  const loop = new AgentLoop({
    lifecycleStore: lifecycle.store,
    llm: provider,
    modelInvocationWal: {
      store,
      persist: async () => undefined,
      provider: "test",
      defaultModel: "test-model",
    },
  });
  await loop.run(lifecycle.turn.id, { model: "test-model" });
  assert.equal(provider.requests.length, 1);
  assert.equal(lifecycle.store.getTurn(lifecycle.turn.id)?.status, "completed");
});

test("P0: 非最终 committed Model Invocation 启动保持 interrupted 等待显式恢复", async () => {
  const lifecycle = interruptedTurn("committed-nonfinal");
  const store = responseReceivedInvocation(lifecycle.turn.id, "tool_continuation", "candidate");
  const invocation = store.list()[0]!;
  store.markCommitted(invocation.invocationId, `turn:${lifecycle.turn.id}:tool-round:0`);
  const recovery = new ModelInvocationStartupRecovery({
    lifecycleStore: lifecycle.store,
    modelInvocationStore: store,
    persist: async () => undefined,
  });

  const result = await recovery.recoverTurn(lifecycle.turn.id);

  assert.equal(result.action, "blocked");
  assert.equal(result.diagnosticCode, "explicit_resume_required");
  assert.equal(lifecycle.store.getTurn(lifecycle.turn.id)?.status, "interrupted");
});

test("P0: Tool WAL 结果完整仍不得在启动阶段触发下一轮 Provider", async () => {
  const lifecycle = interruptedTurn("tool-backed");
  const functionCall = {
    callId: "call-durable",
    name: "durable_tool",
    arguments: JSON.stringify({ path: "README.md" }),
  };
  const store = responseReceivedInvocation(
    lifecycle.turn.id,
    "initial",
    "",
    [functionCall],
  );
  const invocation = store.list()[0]!;
  const toolStore = new ToolInvocationStore();
  const toolInvocation = toolStore.prepare({
    modelInvocationId: invocation.invocationId,
    callId: functionCall.callId,
    toolName: functionCall.name,
    argumentsDigest: createToolArgumentsDigest(functionCall.arguments),
  });
  toolStore.markExecuting(toolInvocation.toolInvocationId);
  toolStore.recordResult(toolInvocation.toolInvocationId, {
    result: { ok: true },
    output: JSON.stringify({ ok: true }),
  });
  const recovery = new ModelInvocationStartupRecovery({
    lifecycleStore: lifecycle.store,
    modelInvocationStore: store,
    toolInvocationStore: toolStore,
    persist: async () => undefined,
  });

  const result = await recovery.recoverTurn(lifecycle.turn.id);

  assert.equal(result.action, "blocked");
  assert.equal(result.diagnosticCode, "explicit_resume_required");
  assert.equal(lifecycle.store.getTurn(lifecycle.turn.id)?.status, "interrupted");
  assert.equal(toolStore.get(toolInvocation.toolInvocationId)?.status, "result_received");
});

test("P0: Workflow 首次调用写入 lineage，response_received 可零付费补 Evidence", async () => {
  const lineageLifecycle = new LifecycleStore();
  const lineageThread = lineageLifecycle.createThread();
  const lineageTurn = lineageLifecycle.createTurn(lineageThread.id);
  lineageLifecycle.appendItem(lineageTurn.id, "user_message", { text: "stage" });
  const invocationStore = new ModelInvocationStore();
  const loop = new AgentLoop({
    lifecycleStore: lineageLifecycle,
    llm: new ScriptedLlmProvider([{ id: "stage-response", text: validStageResult, functionCalls: [] }]),
    modelInvocationWal: {
      store: invocationStore,
      persist: async () => undefined,
      provider: "test",
      defaultModel: "test-model",
    },
  });
  await loop.run(lineageTurn.id, {
    model: "test-model",
    invocationContext: {
      jobId: "job-lineage",
      jobAttempt: 2,
      workflowVersion: "software_product_delivery_v2",
      stageId: "product",
      stageAttempt: 1,
    },
  });
  const durableInvocation = invocationStore.list()[0]!;
  assert.deepEqual({
    jobId: durableInvocation.jobId,
    jobAttempt: durableInvocation.jobAttempt,
    workflowVersion: durableInvocation.workflowVersion,
    stageId: durableInvocation.stageId,
    stageAttempt: durableInvocation.stageAttempt,
  }, {
    jobId: "job-lineage",
    jobAttempt: 2,
    workflowVersion: "software_product_delivery_v2",
    stageId: "product",
    stageAttempt: 1,
  });

  const lifecycle = new LifecycleStore();
  const thread = lifecycle.createThread();
  const turn = lifecycle.createTurn(thread.id);
  const runs = new AgentRunStore();
  const runtime = new AgentRuntimeStore();
  const root = runs.ensureRoot(thread.id, turn.id, "orchestrator");
  const job = runtime.createJob({
    threadId: thread.id,
    rootTurnId: turn.id,
    rootRunId: root.id,
    configSnapshot: DEFAULT_AGENT_TEAM_CONFIG,
    executionKind: "software_product_delivery",
    workflowVersion: "software_product_delivery_v2",
  });
  ensureFixedSoftwareTeam(lifecycle, runs, root);
  runtime.beginStage(job.id, "product", 2);
  let paidCalls = 0;
  let committedTarget: string | undefined;
  const coordinator = new WorkflowTeamCoordinator({
    runStore: runs,
    runtimeStore: runtime,
    template: SOFTWARE_PRODUCT_DELIVERY_TEMPLATE,
    requirement: () => ({
      objective: "recover product",
      scope: ["src/**"],
      nonGoals: [],
      deliverables: ["artifact"],
      acceptanceCriteria: ["verified"],
      prompt: "confirmed",
    }),
    execute: async () => {
      paidCalls += 1;
      return { turnId: "paid-turn", summary: validStageResult };
    },
    recoverModelExecution: (input) => input.jobId === job.id && input.stageId === "product"
      ? { turnId: "durable-product-turn", summary: validStageResult, invocationId: "durable-product-invocation" }
      : undefined,
    commitRecoveredModelExecution: (_invocationId, targetCommitKey) => {
      committedTarget = targetCommitKey;
    },
  });
  const engine = new TeamWorkflowExecutionEngine(runtime, coordinator, () => undefined);

  await engine.recover(job.id);

  assert.equal(paidCalls, 0);
  assert.equal(runtime.listStageCheckpoints(job.id)
    .find((item) => item.stageId === "product")?.status, "completed");
  assert.equal(runtime.listTasks(job.id).flatMap((task) => runtime.listEvidence(task.id))
    .some((item) => item.stageId === "product"), true);
  assert.match(committedTarget ?? "", /:evidence$/);
});

test("P0: Return consume 后第二次 persist 失败不得回退 consumed", async () => {
  const runtime = new AgentRuntimeStore();
  const job = runtime.createJob({
    threadId: "parent-thread",
    rootTurnId: "parent-turn",
    rootRunId: "parent-run",
    configSnapshot: { ...DEFAULT_AGENT_TEAM_CONFIG, independentReview: false },
  });
  const task = runtime.createTask({
    jobId: job.id,
    rootRunId: job.rootRunId,
    ownerRunId: "child-run",
    profileId: "tester",
    title: "child",
    objective: "return",
    scope: { allowedPaths: [], deniedPaths: [], nonGoals: [] },
    requiredOutputs: ["result"],
    acceptanceCriteria: ["done"],
    fileClaims: [],
    maxAttempts: 1,
    status: "completed",
  });
  const envelope = runtime.createReturn({
    jobId: job.id,
    rootRunId: job.rootRunId,
    parentRunId: job.rootRunId,
    childRunId: "child-run",
    taskId: task.id,
    sequence: 1,
    result: { status: "completed", summary: "done", evidenceIds: [], boardEntryIds: [] },
    idempotencyKey: `${job.id}:child`,
  });
  runtime.setJobStatus(job.id, "waiting_returns");
  let persistCalls = 0;
  let continuationCalls = 0;
  const coordinator = new AgentRuntimeCoordinator({
    store: runtime,
    retryDelayMs: () => 0,
    persist: async () => {
      persistCalls += 1;
      if (persistCalls === 3) throw new Error("receipt persist failed");
    },
  });

  await assert.rejects(
    coordinator.continueParent("parent-turn", ["child-run"], async () => {
      continuationCalls += 1;
      return "continued";
    }),
    /receipt persist failed/,
  );

  assert.equal(continuationCalls, 1);
  assert.equal(runtime.listReturns(job.id).find((item) => item.id === envelope.id)?.status, "consumed");
});

function interruptedTurn(suffix: string) {
  const store = new LifecycleStore();
  const thread = store.createThread();
  const turn = store.createTurn(thread.id);
  store.appendItem(turn.id, "user_message", { text: suffix });
  store.interruptTurn(turn.id);
  return { store, turn };
}

function responseReceivedInvocation(
  turnId: string,
  purpose: string,
  text: string,
  functionCalls: Array<{ callId: string; name: string; arguments: string }> = [],
) {
  const store = new ModelInvocationStore();
  const prepared = store.prepare({
    threadId: `thread-${turnId}`,
    turnId,
    round: 0,
    purpose,
    requestDigest: createModelRequestDigest({ purpose }),
    provider: "test",
    model: "test-model",
  });
  store.markSubmitted(prepared.invocationId);
  store.recordResponse(prepared.invocationId, {
    providerResponseId: `response-${purpose}`,
    normalizedResult: { text, functionCalls },
  });
  return store;
}
