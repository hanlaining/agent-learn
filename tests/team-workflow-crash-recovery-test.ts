import assert from "node:assert/strict";
import test from "node:test";

import { AgentRunStore } from "../src/agents/agent-run-store.js";
import { DEFAULT_AGENT_TEAM_CONFIG } from "../src/agents/agent-runtime.js";
import { AgentRuntimeCoordinator } from "../src/agents/agent-runtime-coordinator.js";
import { AgentRuntimeStore } from "../src/agents/agent-runtime-store.js";
import { ensureFixedSoftwareTeam } from "../src/agents/fixed-software-team.js";
import { TeamWorkflowExecutionEngine } from "../src/execution/team-workflow-execution-engine.js";
import { WorkflowTeamCoordinator } from "../src/execution/workflow-team-coordinator.js";
import { STAGE_RESULT_CONTRACT_VERSION } from "../src/execution/stage-contract.js";
import { SOFTWARE_PRODUCT_DELIVERY_TEMPLATE } from "../src/execution/workflows/software-product-delivery.js";
import { LifecycleStore } from "../src/runtime/lifecycle-store.js";

type ProfileId = "product_role" | "engineering_role" | "quality_role" | "software_team_lead" | "orchestrator";
type ExecutionInput = { profileId: ProfileId; attempt: number; formatRepair: boolean; allowedTools: string[] };
type Harness = ReturnType<typeof createHarness>;
type PersistedState = {
  runtime: ReturnType<AgentRuntimeStore["exportSnapshot"]>;
  runs: ReturnType<AgentRunStore["exportSnapshot"]>;
};

const validResult = (summary: string) => JSON.stringify({
  status: "completed",
  summary,
  deliverables: ["artifact"],
  evidence: ["verified"],
  blockers: [],
  nextStageRecommendation: "continue",
  contractVersion: STAGE_RESULT_CONTRACT_VERSION,
});

test("崩溃重启不得把 completed checkpoint 缺 Evidence 的持久化终态恢复为 completed", async () => {
  const beforeCrash = createHarness(() => validResult("must not execute"));
  const job = beforeCrash.runtime.getJob(beforeCrash.jobId)!;
  const qualityRun = beforeCrash.runs.listForJob(beforeCrash.jobId)
    .find((run) => run.agentProfileId === "quality_role")!;
  const leadRun = beforeCrash.runs.listForJob(beforeCrash.jobId)
    .find((run) => run.agentProfileId === "software_team_lead")!;
  const task = beforeCrash.runtime.createTask({
    jobId: job.id,
    rootRunId: job.rootRunId,
    ownerRunId: qualityRun.id,
    profileId: "quality_role",
    title: "persisted terminal task",
    objective: "validate persisted terminal contract",
    scope: { allowedPaths: [], deniedPaths: [], nonGoals: [] },
    requiredOutputs: ["evidence"],
    acceptanceCriteria: ["durable evidence exists"],
    fileClaims: [],
    maxAttempts: 1,
    status: "completed",
  });
  const checkpoints = new Map<string, ReturnType<AgentRuntimeStore["beginStage"]>>();
  for (const stageId of ["product", "engineering", "quality", "lead", "return_god"]) {
    const checkpoint = beforeCrash.runtime.beginStage(job.id, stageId, 2);
    beforeCrash.runtime.setStageStatus(checkpoint.idempotencyKey, "validating");
    beforeCrash.runtime.setStageStatus(checkpoint.idempotencyKey, "completed");
    checkpoints.set(stageId, checkpoint);
  }
  const leadCheckpoint = checkpoints.get("lead")!;
  const leadReturn = beforeCrash.runtime.createReturn({
    jobId: job.id,
    rootRunId: job.rootRunId,
    parentRunId: job.rootRunId,
    childRunId: leadRun.id,
    taskId: task.id,
    sequence: 4,
    result: { status: "completed", summary: validResult("lead"), evidenceIds: [], boardEntryIds: [] },
    idempotencyKey: leadCheckpoint.idempotencyKey,
    jobAttempt: job.attempt,
    workflowVersion: job.workflowVersion,
    stageId: "lead",
    stageAttempt: leadCheckpoint.stageAttempt,
  });
  assert.ok(beforeCrash.runtime.claimReturn(leadReturn.id));
  beforeCrash.runtime.consumeReturn(leadReturn.id);
  beforeCrash.runtime.setJobStatus(job.id, "completed");

  // 最后一次成功 persist；随后丢弃全部当前内存，只从该 snapshot 重启。
  const durable = persistSnapshot(beforeCrash);
  const restored = restoreHarness(durable, beforeCrash.jobId, () => validResult("must not execute"));

  await restored.engine.recover(restored.jobId);

  assert.equal(restored.runtime.getJob(restored.jobId)?.status, "failed");
  assert.equal(restored.runtime.getJob(restored.jobId)?.failureCode, "terminal_state_inconsistent");
  assert.equal(restored.calls.length, 0);
});

test("return_god completed 但 Evidence 缺失时崩溃恢复必须终止，不能回到无限重试", async () => {
  const beforeCrash = createHarness(() => validResult("before crash"));
  await driveToLeadReturn(beforeCrash);
  const finalCheckpoint = beforeCrash.runtime.beginStage(beforeCrash.jobId, "return_god", 2);
  beforeCrash.runtime.setStageStatus(finalCheckpoint.idempotencyKey, "validating");
  beforeCrash.runtime.setStageStatus(finalCheckpoint.idempotencyKey, "completed");

  // 持久化一个 completed checkpoint 已存在、但对应 Evidence 尚不存在的真实恢复输入。
  const durable = persistSnapshot(beforeCrash);
  const restored = restoreHarness(durable, beforeCrash.jobId, () => validResult("must not execute"));
  const errors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await restored.engine.resume(restored.jobId);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  const finalReturn = restored.runtime.listReturns(restored.jobId).find((item) => item.stageId === "lead")!;
  const restoredJob = restored.runtime.getJob(restored.jobId)!;

  assert.deepEqual({
    jobStatus: restoredJob.status,
    failureCode: restoredJob.failureCode,
    returnStatus: finalReturn.status,
    returnAttempts: finalReturn.attempts,
    modelCalls: restored.calls.length,
    errorCount: errors.length,
  }, {
    jobStatus: "failed",
    failureCode: "stage_contract_failed",
    returnStatus: "failed",
    returnAttempts: 1,
    modelCalls: 0,
    errorCount: 1,
  });
  assert.match(errors[0] ?? "", /Completed final delivery has no recoverable evidence/);
});

test("动态 Return claim 持久化后崩溃：启动只恢复 outbox，显式继续才调用父 continuation", async () => {
  const beforeCrash = new AgentRuntimeStore();
  const rootRunId = "dynamic-root";
  const childRunId = "dynamic-child";
  const job = beforeCrash.createJob({
    threadId: "dynamic-thread",
    rootTurnId: "dynamic-turn",
    rootRunId,
    configSnapshot: { ...DEFAULT_AGENT_TEAM_CONFIG, independentReview: false },
    executionKind: "software_change",
    workflowVersion: "dynamic_v1",
  });
  const task = beforeCrash.createTask({
    jobId: job.id,
    rootRunId,
    ownerRunId: childRunId,
    profileId: "tester",
    title: "dynamic crash recovery",
    objective: "deliver once",
    scope: { allowedPaths: [], deniedPaths: [], nonGoals: [] },
    requiredOutputs: ["result"],
    acceptanceCriteria: ["single continuation"],
    fileClaims: [],
    maxAttempts: 1,
    status: "completed",
  });
  const pending = beforeCrash.createReturn({
    jobId: job.id,
    rootRunId,
    parentRunId: rootRunId,
    childRunId,
    taskId: task.id,
    sequence: 1,
    result: { status: "completed", summary: "dynamic result", evidenceIds: [], boardEntryIds: [] },
    idempotencyKey: `${job.id}:dynamic-return`,
    jobAttempt: job.attempt,
    workflowVersion: job.workflowVersion,
  });
  beforeCrash.setJobStatus(job.id, "waiting_returns");
  assert.equal(beforeCrash.claimReturn(pending.id)?.status, "delivering");
  beforeCrash.setJobStatus(job.id, "resuming");

  // claim 已持久化但还没有 receipt。启动只把 outbox 恢复为 ready，不能猜测
  // 父模型 continuation 是否已经产生外部副作用。
  const restored = AgentRuntimeStore.fromSnapshot(beforeCrash.exportSnapshot());
  const coordinator = new AgentRuntimeCoordinator({ store: restored, retryDelayMs: () => 0 });
  const invocations: string[] = [];

  const startupFacts = restored.recoverInterruptedWork();
  assert.equal(invocations.length, 0);
  assert.equal(startupFacts.pendingReturns[0]?.id, pending.id);
  assert.equal(restored.listReturns(job.id).find((item) => item.id === pending.id)?.status, "ready");

  const result = await coordinator.continueParent(job.rootTurnId, [childRunId], async () => {
    invocations.push("explicit-user-continuation");
    return "user";
  });

  assert.equal(result, "user");
  assert.deepEqual(invocations, ["explicit-user-continuation"]);
  assert.equal(restored.listReturns(job.id).find((item) => item.id === pending.id)?.status, "consumed");
});

test("V2 Return claim 持久化后崩溃：启动确定性消费且不误终态、不调用模型", async () => {
  const beforeCrash = createHarness(() => validResult("durable V2 result"));
  await beforeCrash.coordinator.advance(beforeCrash.jobId, "ready_first_return");
  const productReturn = beforeCrash.runtime.listReturns(beforeCrash.jobId)
    .find((item) => item.stageId === "product");
  assert.ok(productReturn);
  assert.equal(beforeCrash.runtime.claimReturn(productReturn.id)?.status, "delivering");
  beforeCrash.runtime.setJobStatus(beforeCrash.jobId, "resuming");
  const durable = persistSnapshot(beforeCrash);

  const restored = restoreHarness(
    durable,
    beforeCrash.jobId,
    () => new Error("startup recovery must not call a model"),
  );
  assert.equal(restored.runtime.listReturns(restored.jobId)
    .find((item) => item.id === productReturn.id)?.status, "ready");

  await restored.engine.recover(restored.jobId);

  assert.equal(restored.calls.length, 0);
  assert.equal(restored.runtime.listReturns(restored.jobId)
    .find((item) => item.id === productReturn.id)?.status, "consumed");
  assert.equal(restored.coordinator.getStage(restored.jobId), "engineering_ready");
  assert.equal(restored.runtime.getJob(restored.jobId)?.status, "running");
});

test("模型返回后、首次 Evidence persist 前崩溃的真实语义是 at-least-once，重启会重调模型", async () => {
  let durable: PersistedState | undefined;
  let persistCalls = 0;
  let beforeCrash!: Harness;
  beforeCrash = createHarness(() => validResult("model returned before crash"), () => {
    persistCalls += 1;
    if (persistCalls === 1) {
      durable = persistSnapshot(beforeCrash);
      return;
    }
    throw new Error("simulated process crash before Evidence snapshot became durable");
  });

  await assert.rejects(() => beforeCrash.coordinator.advance(beforeCrash.jobId, "ready_first_return"));
  assert.equal(beforeCrash.calls.filter((call) => call.profileId === "product_role").length, 1);
  const lastSuccessfulPersist = requirePersisted(durable);
  assert.equal(lastSuccessfulPersist.runtime.evidence.length, 0);
  assert.equal(lastSuccessfulPersist.runtime.returns.length, 0);
  assert.deepEqual(lastSuccessfulPersist.runtime.stageCheckpoints?.map((item) => [item.stageId, item.status]), [
    ["product", "running"],
  ]);

  // 丢弃崩溃进程内已经拿到的模型结果，只从最后一次成功 persist 重建全部 Store。
  const restored = restoreHarness(lastSuccessfulPersist, beforeCrash.jobId, () => validResult("replayed after restart"));
  await restored.engine.resume(restored.jobId);

  const productCallsAfterRestart = restored.calls.filter((call) => call.profileId === "product_role").length;
  assert.equal(productCallsAfterRestart, 1);
  assert.equal(1 + productCallsAfterRestart, 2, "同一 Product Stage 的模型调用是 at-least-once，而不是 exactly-once");
  assert.equal(restored.runtime.getJob(restored.jobId)?.status, "completed");
});

function createHarness(
  result: (input: ExecutionInput) => string | Error,
  persist?: () => void | Promise<void>,
) {
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
  return assembleHarness(runtime, runs, job.id, result, persist);
}

function restoreHarness(
  persisted: PersistedState,
  jobId: string,
  result: (input: ExecutionInput) => string | Error,
) {
  return assembleHarness(
    AgentRuntimeStore.fromSnapshot(persisted.runtime),
    AgentRunStore.fromSnapshot(persisted.runs),
    jobId,
    result,
  );
}

function assembleHarness(
  runtime: AgentRuntimeStore,
  runs: AgentRunStore,
  jobId: string,
  result: (input: ExecutionInput) => string | Error,
  persist?: () => void | Promise<void>,
) {
  const calls: ExecutionInput[] = [];
  const coordinator = new WorkflowTeamCoordinator({
    runStore: runs,
    runtimeStore: runtime,
    template: SOFTWARE_PRODUCT_DELIVERY_TEMPLATE,
    requirement: () => ({
      objective: "crash recovery regression",
      scope: ["src/**"],
      nonGoals: ["unrelated"],
      deliverables: ["tests"],
      acceptanceCriteria: ["durable recovery"],
      prompt: "confirmed crash recovery requirement",
    }),
    execute: async (input) => {
      const recorded: ExecutionInput = {
        profileId: input.profileId,
        attempt: input.attempt,
        formatRepair: input.formatRepair,
        allowedTools: [...input.allowedTools],
      };
      calls.push(recorded);
      const output = result(recorded);
      if (output instanceof Error) throw output;
      return { turnId: `crash-model-turn-${calls.length}`, summary: output };
    },
    ...(persist === undefined ? {} : { persist }),
  });
  const engine = new TeamWorkflowExecutionEngine(runtime, coordinator, () => undefined);
  return { runtime, runs, coordinator, engine, jobId, calls };
}

function persistSnapshot(setup: Pick<Harness, "runtime" | "runs">): PersistedState {
  return {
    runtime: structuredClone(setup.runtime.exportSnapshot()),
    runs: structuredClone(setup.runs.exportSnapshot()),
  };
}

function requirePersisted(value: PersistedState | undefined): PersistedState {
  assert.ok(value, "expected at least one successful persist before the simulated crash");
  return value;
}

async function driveThroughProduct(setup: Harness) {
  assert.equal((await setup.coordinator.advance(setup.jobId, "ready_first_return")).stage, "first_return_ready");
  assert.equal((await setup.coordinator.advance(setup.jobId, "first_return_ready")).stage, "engineering_ready");
}

async function driveThroughEngineering(setup: Harness) {
  await driveThroughProduct(setup);
  assert.equal((await setup.coordinator.advance(setup.jobId, "engineering_ready")).stage, "engineering_return_ready");
  assert.equal((await setup.coordinator.advance(setup.jobId, "engineering_return_ready")).stage, "quality_ready");
}

async function driveToQualityReturn(setup: Harness) {
  await driveThroughEngineering(setup);
  assert.equal((await setup.coordinator.advance(setup.jobId, "quality_ready")).stage, "quality_return_ready");
}

async function driveToLeadReturn(setup: Harness) {
  await driveToQualityReturn(setup);
  assert.equal((await setup.coordinator.advance(setup.jobId, "quality_return_ready")).stage, "lead_return_ready");
}
