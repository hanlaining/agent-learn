import assert from "node:assert/strict";
import test from "node:test";

import type { FixedProductStage } from "../src/agents/fixed-software-team-coordinator.js";
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

const validResult = (summary: string) => JSON.stringify({
  status: "completed",
  summary,
  deliverables: ["artifact"],
  evidence: ["verified"],
  blockers: [],
  nextStageRecommendation: "continue",
  contractVersion: STAGE_RESULT_CONTRACT_VERSION,
});

test("resume不再no-op：可从初始Stage确定性推进到completed", async () => {
  const setup = createHarness(() => validResult("ok"));

  await setup.engine.resume(setup.jobId);

  assert.equal(setup.runtime.getJob(setup.jobId)?.status, "completed");
  assert.deepEqual(setup.calls.map((call) => call.profileId), [
    "product_role",
    "engineering_role",
    "quality_role",
    "software_team_lead",
    "orchestrator",
  ]);
  assert.equal(setup.runtime.listReturns(setup.jobId).every((item) => item.status === "consumed"), true);
});

test("engineering_ready自动恢复零付费，显式resume继续推进且不重复Product", async () => {
  const beforeRestart = createHarness(() => validResult("before restart"));
  await driveThroughProduct(beforeRestart);
  assert.equal(beforeRestart.coordinator.getStage(beforeRestart.jobId), "engineering_ready");

  const restored = restoreHarness(beforeRestart, () => validResult("after restart"));
  await restored.engine.recover(restored.jobId);

  assert.equal(restored.runtime.getJob(restored.jobId)?.status, "running");
  assert.equal(restored.calls.length, 0);

  await restored.engine.resume(restored.jobId);

  assert.equal(restored.runtime.getJob(restored.jobId)?.status, "completed");
  assert.equal(restored.calls.some((call) => call.profileId === "product_role"), false);
  assert.deepEqual(restored.calls.map((call) => call.profileId), [
    "engineering_role",
    "quality_role",
    "software_team_lead",
    "orchestrator",
  ]);
  assert.equal(restored.runtime.listStageCheckpoints(restored.jobId).filter((item) => item.stageId === "product").length, 1);
});

test("反馈已持久化但返工未开始时，启动recover不把旧Evidence当新attempt且零模型调用", async () => {
  let engineeringCalls = 0;
  const blocked = JSON.stringify({
    status: "blocked",
    summary: "need user feedback",
    deliverables: [],
    evidence: ["missing choice"],
    blockers: ["API compatibility choice"],
    nextStageRecommendation: "block",
    contractVersion: STAGE_RESULT_CONTRACT_VERSION,
  });
  const setup = createHarness((input) => input.profileId === "engineering_role" && ++engineeringCalls === 1
    ? blocked
    : validResult("ok"));
  await driveThroughProduct(setup);
  await setup.coordinator.advance(setup.jobId, "engineering_ready");
  await setup.coordinator.advance(setup.jobId, "engineering_return_ready");
  assert.equal(setup.runtime.listTasks(setup.jobId).find((item) => item.profileId === "engineering_role")?.status, "blocked");
  await setup.coordinator.provideFeedback(setup.jobId, { turnId: "feedback-turn", text: "keep v1 API" });

  const restored = restoreHarness(setup, () => validResult("must not execute during startup recover"));
  await restored.engine.recover(restored.jobId);

  assert.equal(restored.calls.length, 0);
  assert.equal(restored.runtime.listTasks(restored.jobId).find((item) => item.profileId === "engineering_role")?.status, "rework");
  assert.equal(restored.runtime.getJob(restored.jobId)?.status, "reviewing");
});

test("已完成Engineering Stage恢复时只验收持久化Return，不重复Worker模型调用", async () => {
  const beforeRestart = createHarness(() => validResult("before restart"));
  await driveThroughProduct(beforeRestart);
  assert.equal((await beforeRestart.coordinator.advance(beforeRestart.jobId, "engineering_ready")).stage, "engineering_return_ready");

  const restored = restoreHarness(beforeRestart, () => validResult("after restart"));
  await restored.engine.resume(restored.jobId);

  assert.equal(restored.runtime.getJob(restored.jobId)?.status, "completed");
  assert.equal(restored.calls.some((call) => call.profileId === "product_role" || call.profileId === "engineering_role"), false);
  assert.equal(restored.runtime.listStageCheckpoints(restored.jobId).filter((item) => item.stageId === "engineering").length, 1);
});

test("Quality Return已ready时恢复会继续Lead和最终交付，不重跑Quality", async () => {
  const beforeRestart = createHarness(() => validResult("before restart"));
  await driveToQualityReturn(beforeRestart);
  const qualityReturn = beforeRestart.runtime.listReturns(beforeRestart.jobId).find((item) => item.stageId === "quality");
  assert.equal(qualityReturn?.status, "ready");

  const restored = restoreHarness(beforeRestart, () => validResult("after restart"));
  await restored.engine.resume(restored.jobId);

  assert.equal(restored.runtime.getJob(restored.jobId)?.status, "completed");
  assert.equal(restored.calls.filter((call) => call.profileId === "quality_role").length, 0);
  assert.equal(restored.calls.filter((call) => call.profileId === "software_team_lead").length, 1);
  assert.equal(restored.calls.filter((call) => call.profileId === "orchestrator").length, 1);
  assert.equal(restored.runtime.listReturns(restored.jobId).find((item) => item.id === qualityReturn?.id)?.status, "consumed");
});

test("Lead Return已持久化但Quality未consume时恢复只补ack，不重复执行Lead", async () => {
  const beforeRestart = createHarness(() => validResult("before restart"));
  await driveToQualityReturn(beforeRestart);
  const qualityTask = beforeRestart.runtime.listTasks(beforeRestart.jobId).find((item) => item.profileId === "quality_role")!;
  const qualityReturn = beforeRestart.runtime.listReturns(beforeRestart.jobId).find((item) => item.stageId === "quality")!;
  const leadStage = beforeRestart.runtime.beginStage(beforeRestart.jobId, "lead", 2);
  beforeRestart.runtime.setStageStatus(leadStage.idempotencyKey, "validating");
  beforeRestart.runtime.createReturn({
    jobId: beforeRestart.jobId,
    rootRunId: beforeRestart.runtime.getJob(beforeRestart.jobId)!.rootRunId,
    parentRunId: beforeRestart.runtime.getJob(beforeRestart.jobId)!.rootRunId,
    childRunId: beforeRestart.runs.listForJob(beforeRestart.jobId).find((run) => run.agentProfileId === "software_team_lead")!.id,
    taskId: qualityTask.id,
    sequence: 4,
    result: {
      status: "completed",
      summary: validResult("durable lead result"),
      evidenceIds: [...qualityReturn.result.evidenceIds],
      boardEntryIds: [],
    },
    idempotencyKey: leadStage.idempotencyKey,
    jobAttempt: 1,
    workflowVersion: "software_product_delivery_v2",
    stageId: "lead",
    stageAttempt: 1,
  });
  beforeRestart.runtime.setStageStatus(leadStage.idempotencyKey, "completed");
  beforeRestart.runtime.setJobStatus(beforeRestart.jobId, "waiting_returns");

  const restored = restoreHarness(beforeRestart, () => validResult("after restart"));
  await restored.engine.resume(restored.jobId);

  assert.equal(restored.runtime.getJob(restored.jobId)?.status, "completed");
  assert.equal(restored.calls.filter((call) => call.profileId === "software_team_lead").length, 0);
  assert.equal(restored.calls.filter((call) => call.profileId === "orchestrator").length, 1);
  assert.equal(restored.runtime.listReturns(restored.jobId).find((item) => item.id === qualityReturn.id)?.status, "consumed");
  assert.equal(restored.runtime.listReturns(restored.jobId).filter((item) => item.stageId === "lead").length, 1);
});

test("return_god失败后可从ready Return重试并最终收口", async () => {
  let deliveryCalls = 0;
  const setup = createHarness((input) => {
    if (input.profileId === "orchestrator" && ++deliveryCalls === 1) return new Error("temporary final delivery timeout");
    return validResult("ok");
  });
  await driveToLeadReturn(setup);

  try {
    await setup.engine.resume(setup.jobId);
  } catch (error) {
    assert.match(error instanceof Error ? error.message : String(error), /temporary final delivery timeout/);
  }
  if (setup.runtime.getJob(setup.jobId)?.status !== "completed") await setup.engine.resume(setup.jobId);

  assert.equal(setup.runtime.getJob(setup.jobId)?.status, "completed");
  assert.equal(deliveryCalls, 2);
  assert.deepEqual(
    setup.runtime.listStageCheckpoints(setup.jobId).filter((item) => item.stageId === "return_god").map((item) => item.status),
    ["failed_retryable", "completed"],
  );
  assert.equal(setup.runtime.listReturns(setup.jobId).find((item) => item.stageId === "lead")?.status, "consumed");
});

test("Lead事实提交后Quality ack持久化失败，不回退consumed且不重复Lead模型", async () => {
  let armed = false;
  let persistCalls = 0;
  let failOnce = true;
  const setup = createHarness(() => validResult("ok"), async () => {
    if (!armed) return;
    persistCalls += 1;
    if (persistCalls === 2 && failOnce) {
      failOnce = false;
      throw new Error("quality ack persist failed");
    }
  });
  await driveToQualityReturn(setup);
  armed = true;

  await assert.rejects(
    () => setup.coordinator.advance(setup.jobId, "quality_return_ready"),
    /quality ack persist failed/,
  );

  assert.equal(setup.runtime.listReturns(setup.jobId).find((item) => item.stageId === "quality")?.status, "consumed");
  assert.equal(setup.runtime.listReturns(setup.jobId).filter((item) => item.stageId === "lead").length, 1);
  assert.equal(setup.calls.filter((call) => call.profileId === "software_team_lead").length, 1);

  await setup.engine.resume(setup.jobId);
  assert.equal(setup.runtime.getJob(setup.jobId)?.status, "completed");
  assert.equal(setup.calls.filter((call) => call.profileId === "software_team_lead").length, 1);
});

test("最终交付终态持久化失败，不回退Lead Return且恢复不重复Orchestrator模型", async () => {
  let armed = false;
  let persistCalls = 0;
  let failOnce = true;
  const setup = createHarness(() => validResult("ok"), async () => {
    if (!armed) return;
    persistCalls += 1;
    if (persistCalls === 2 && failOnce) {
      failOnce = false;
      throw new Error("terminal persist failed");
    }
  });
  await driveToLeadReturn(setup);
  armed = true;

  await assert.rejects(
    () => setup.coordinator.advance(setup.jobId, "lead_return_ready"),
    /terminal persist failed/,
  );

  assert.equal(setup.runtime.getJob(setup.jobId)?.status, "completed");
  assert.equal(setup.runtime.listReturns(setup.jobId).find((item) => item.stageId === "lead")?.status, "consumed");
  assert.equal(setup.calls.filter((call) => call.profileId === "orchestrator").length, 1);

  await setup.engine.resume(setup.jobId);
  assert.equal(setup.calls.filter((call) => call.profileId === "orchestrator").length, 1);
});

test("终态Job的resume/recover幂等，不再调用模型或改变终态", async () => {
  for (const status of ["completed", "failed", "cancelled"] as const) {
    const setup = createHarness(() => validResult("must not execute"));
    if (status === "completed") setup.runtime.setJobStatus(setup.jobId, "completed");
    else setup.runtime.failJob(setup.jobId, status, status === "failed" ? "runtime_recovery_failed" : "user_cancelled");
    const before = setup.runtime.exportSnapshot();

    await setup.engine.resume(setup.jobId);
    await setup.engine.recover(setup.jobId);
    await setup.engine.resume(setup.jobId);

    assert.equal(setup.calls.length, 0);
    assert.equal(setup.runtime.getJob(setup.jobId)?.status, status);
    assert.deepEqual(setup.runtime.exportSnapshot(), before);
  }
});

test("恢复循环在无状态进展时停止，并对持续变化但不终止的状态设置步数上限", async () => {
  const runtime = new AgentRuntimeStore();
  const job = runtime.createJob({
    threadId: "loop-thread",
    rootTurnId: "loop-turn",
    rootRunId: "loop-root",
    configSnapshot: DEFAULT_AGENT_TEAM_CONFIG,
    executionKind: "software_product_delivery",
    workflowVersion: "software_product_delivery_v2",
  });
  let noProgressCalls = 0;
  const noProgressCoordinator = {
    getStage: () => "engineering_ready" as FixedProductStage,
    recoveryDecision: () => ({ kind: "resume_stage" as const, stage: "engineering_ready" as FixedProductStage }),
    advance: async () => { noProgressCalls += 1; return { stage: "engineering_ready" as FixedProductStage, changed: false }; },
    recoverPersistedCheckpoints: () => 0,
  } as unknown as WorkflowTeamCoordinator;
  const noProgressEngine = new TeamWorkflowExecutionEngine(runtime, noProgressCoordinator, () => undefined);
  await noProgressEngine.resume(job.id);
  assert.equal(noProgressCalls, 1);

  let stage: FixedProductStage = "engineering_ready";
  let boundedCalls = 0;
  const endlessCoordinator = {
    getStage: () => stage,
    recoveryDecision: () => ({ kind: "resume_stage" as const, stage }),
    advance: async () => {
      boundedCalls += 1;
      stage = stage === "engineering_ready" ? "quality_ready" : "engineering_ready";
      return { stage, changed: true };
    },
    recoverPersistedCheckpoints: () => 0,
  } as unknown as WorkflowTeamCoordinator;
  const boundedEngine = new TeamWorkflowExecutionEngine(runtime, endlessCoordinator, () => undefined);
  await assert.rejects(() => boundedEngine.resume(job.id), /exceeded 32 transitions/);
  assert.equal(boundedCalls, 32);
});

test("V2团队Return不会进入动态父continuation，动态Job仍正常恢复", async () => {
  const runtime = new AgentRuntimeStore();
  const team = createPendingReturn(runtime, "team", "software_product_delivery", "software_product_delivery_v2");
  const dynamic = createPendingReturn(runtime, "dynamic", "software_change", "dynamic_v1");
  const deliveredJobs: string[] = [];
  const coordinator = new AgentRuntimeCoordinator({ store: runtime, retryDelayMs: () => 0 });

  await coordinator.recoverPendingReturns(async (job) => {
    deliveredJobs.push(job.id);
    return job.id;
  });

  assert.deepEqual(deliveredJobs, [dynamic.jobId]);
  assert.equal(runtime.listReturns(team.jobId)[0]?.status, "ready");
  assert.equal(runtime.listReturns(dynamic.jobId)[0]?.status, "consumed");
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

function restoreHarness(source: ReturnType<typeof createHarness>, result: (input: ExecutionInput) => string | Error) {
  const runtime = AgentRuntimeStore.fromSnapshot(source.runtime.exportSnapshot());
  const runs = AgentRunStore.fromSnapshot(source.runs.exportSnapshot());
  return assembleHarness(runtime, runs, source.jobId, result);
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
      objective: "resume regression",
      scope: ["src/**"],
      nonGoals: ["unrelated"],
      deliverables: ["code"],
      acceptanceCriteria: ["tests pass"],
      prompt: "confirmed requirement",
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
      return { turnId: `resume-model-turn-${calls.length}`, summary: output };
    },
    ...(persist === undefined ? {} : { persist }),
  });
  const engine = new TeamWorkflowExecutionEngine(runtime, coordinator, () => undefined);
  return { runtime, runs, coordinator, engine, jobId, calls };
}

async function driveThroughProduct(setup: ReturnType<typeof createHarness>) {
  assert.equal((await setup.coordinator.advance(setup.jobId, "ready_first_return")).stage, "first_return_ready");
  assert.equal((await setup.coordinator.advance(setup.jobId, "first_return_ready")).stage, "engineering_ready");
}

async function driveThroughEngineering(setup: ReturnType<typeof createHarness>) {
  await driveThroughProduct(setup);
  assert.equal((await setup.coordinator.advance(setup.jobId, "engineering_ready")).stage, "engineering_return_ready");
  assert.equal((await setup.coordinator.advance(setup.jobId, "engineering_return_ready")).stage, "quality_ready");
}

async function driveToQualityReturn(setup: ReturnType<typeof createHarness>) {
  await driveThroughEngineering(setup);
  assert.equal((await setup.coordinator.advance(setup.jobId, "quality_ready")).stage, "quality_return_ready");
}

async function driveToLeadReturn(setup: ReturnType<typeof createHarness>) {
  await driveToQualityReturn(setup);
  assert.equal((await setup.coordinator.advance(setup.jobId, "quality_return_ready")).stage, "lead_return_ready");
}

function createPendingReturn(
  runtime: AgentRuntimeStore,
  suffix: string,
  executionKind: "software_product_delivery" | "software_change",
  workflowVersion: string,
) {
  const rootRunId = `root-${suffix}`;
  const job = runtime.createJob({
    threadId: `thread-${suffix}`,
    rootTurnId: `turn-${suffix}`,
    rootRunId,
    configSnapshot: { ...DEFAULT_AGENT_TEAM_CONFIG, independentReview: false },
    executionKind,
    workflowVersion,
  });
  const task = runtime.createTask({
    jobId: job.id,
    rootRunId,
    ownerRunId: `child-${suffix}`,
    profileId: "tester",
    title: suffix,
    objective: suffix,
    scope: { allowedPaths: [], deniedPaths: [], nonGoals: [] },
    requiredOutputs: ["result"],
    acceptanceCriteria: ["complete"],
    fileClaims: [],
    maxAttempts: 1,
    status: "completed",
  });
  runtime.createReturn({
    jobId: job.id,
    rootRunId,
    parentRunId: rootRunId,
    childRunId: `child-${suffix}`,
    taskId: task.id,
    sequence: 1,
    result: { status: "completed", summary: suffix, evidenceIds: [], boardEntryIds: [] },
    idempotencyKey: `${job.id}:pending`,
    jobAttempt: 1,
    workflowVersion,
    ...(executionKind === "software_product_delivery" ? { stageId: "product", stageAttempt: 1, businessAttempt: 1 } : {}),
  });
  runtime.setJobStatus(job.id, "waiting_returns");
  return { jobId: job.id, taskId: task.id };
}
