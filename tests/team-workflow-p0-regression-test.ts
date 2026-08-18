import assert from "node:assert/strict";
import test from "node:test";

import { AgentRunStore } from "../src/agents/agent-run-store.js";
import { DEFAULT_AGENT_TEAM_CONFIG } from "../src/agents/agent-runtime.js";
import { AgentRuntimeStore } from "../src/agents/agent-runtime-store.js";
import { ensureFixedSoftwareTeam } from "../src/agents/fixed-software-team.js";
import { WorkflowTeamCoordinator } from "../src/execution/workflow-team-coordinator.js";
import { STAGE_RESULT_CONTRACT_VERSION } from "../src/execution/stage-contract.js";
import { SOFTWARE_PRODUCT_DELIVERY_TEMPLATE } from "../src/execution/workflows/software-product-delivery.js";
import { LifecycleStore } from "../src/runtime/lifecycle-store.js";

type ProfileId = "product_role" | "engineering_role" | "quality_role" | "software_team_lead" | "orchestrator";
type ExecutionInput = {
  profileId: ProfileId;
  attempt: number;
  formatRepair: boolean;
  allowedTools: string[];
};

const stageResult = (summary: string, overrides: Record<string, unknown> = {}) => JSON.stringify({
  status: "completed",
  summary,
  deliverables: ["artifact"],
  evidence: ["verified evidence"],
  blockers: [],
  nextStageRecommendation: "continue",
  contractVersion: STAGE_RESULT_CONTRACT_VERSION,
  ...overrides,
});

test("P0-1 Product完成后重载不能把尚未执行Engineering/Quality的Job误判completed", async () => {
  const setup = createHarness(() => stageResult("valid"));
  await driveThroughProduct(setup);
  assert.equal(setup.coordinator.getStage(setup.jobId), "engineering_ready");

  const restoredRuntime = AgentRuntimeStore.fromSnapshot(setup.runtime.exportSnapshot());
  const restoredRuns = AgentRunStore.fromSnapshot(setup.runs.exportSnapshot());
  restoredRuntime.reconcilePersistedJobs();
  const restoredCoordinator = createCoordinator(restoredRuntime, restoredRuns, () => stageResult("after reload"));

  assert.notEqual(restoredRuntime.getJob(setup.jobId)?.status, "completed");
  assert.equal(restoredCoordinator.getStage(setup.jobId), "engineering_ready");
  assert.equal(restoredRuntime.listTasks(setup.jobId).some((task) => task.profileId === "engineering_role"), false);
  assert.equal(restoredRuntime.listTasks(setup.jobId).some((task) => task.profileId === "quality_role"), false);
});

test("P0-3 Lead首次执行抛错后Quality Return恢复ready，重试无需重跑Quality", async () => {
  let leadCalls = 0;
  const setup = createHarness((input) => {
    if (input.profileId === "software_team_lead" && ++leadCalls === 1) return new Error("lead provider timeout");
    return stageResult("valid");
  });
  await driveToQualityReturn(setup);

  await assert.rejects(
    setup.coordinator.advance(setup.jobId, "quality_return_ready"),
    /lead provider timeout/,
  );
  const qualityReturnAfterFailure = setup.runtime.listReturns(setup.jobId).find((item) => item.stageId === "quality");
  assert.equal(qualityReturnAfterFailure?.status, "ready");
  assert.equal(setup.coordinator.getStage(setup.jobId), "quality_return_ready");

  assert.equal((await setup.coordinator.advance(setup.jobId, "quality_return_ready")).stage, "lead_return_ready");
  assert.equal(leadCalls, 2);
  assert.equal(setup.calls.filter((call) => call.profileId === "quality_role").length, 1);
  assert.equal(setup.runtime.listStageCheckpoints(setup.jobId).filter((checkpoint) => checkpoint.stageId === "lead").length, 2);
});

test("P0-4 final delivery连续两次失败后明确关闭Job、Return和活动Run", async () => {
  const setup = createHarness((input) => input.profileId === "orchestrator"
    ? new Error("final delivery network error")
    : stageResult("valid"));
  await driveToLeadReturn(setup);

  await assert.rejects(
    setup.coordinator.advance(setup.jobId, "lead_return_ready"),
    /final delivery network error/,
  );
  assert.equal(setup.runtime.getJob(setup.jobId)?.status, "waiting_returns");
  assert.equal(setup.runtime.listStageCheckpoints(setup.jobId).filter((checkpoint) => checkpoint.stageId === "return_god").at(-1)?.status, "failed_retryable");

  await assert.rejects(
    setup.coordinator.advance(setup.jobId, "lead_return_ready"),
    /final delivery network error/,
  );
  assert.equal(setup.runtime.listStageCheckpoints(setup.jobId).filter((checkpoint) => checkpoint.stageId === "return_god").at(-1)?.status, "failed_terminal");
  assert.equal(setup.runtime.getJob(setup.jobId)?.status, "failed");
  assert.equal(setup.runtime.listReturns(setup.jobId).some((item) => item.status === "ready" || item.status === "delivering"), false);
  assert.equal(setup.runs.listForJob(setup.jobId).some((run) =>
    ["queued", "running", "waiting_children", "resuming"].includes(run.status)), false);
});

test("P0-5 Engineering业务不合格最多验收两次，之后终止而非无限循环", async () => {
  const setup = createHarness((input) => input.profileId === "engineering_role"
    ? stageResult("engineering lacks evidence", { evidence: [], nextStageRecommendation: "retry" })
    : stageResult("valid"));
  await driveThroughProduct(setup);
  assert.equal((await setup.coordinator.advance(setup.jobId, "engineering_ready")).stage, "engineering_return_ready");

  assert.equal((await setup.coordinator.advance(setup.jobId, "engineering_return_ready")).stage, "engineering_ready");
  const taskAfterFirstReview = setup.runtime.listTasks(setup.jobId).find((task) => task.profileId === "engineering_role");
  const firstReturn = setup.runtime.listReturns(setup.jobId).find((item) =>
    item.stageId === "engineering" && item.businessAttempt === 1);
  assert.equal(taskAfterFirstReview?.status, "rework");
  assert.equal(firstReturn?.status, "consumed");

  // 第二个业务 Attempt 必须真实重跑 Worker，而不是重复 claim 第一个 Return。
  assert.equal((await setup.coordinator.advance(setup.jobId, "engineering_ready")).stage, "engineering_return_ready");
  const taskAfterSecondRun = setup.runtime.listTasks(setup.jobId).find((task) => task.profileId === "engineering_role");
  const secondReturn = setup.runtime.listReturns(setup.jobId).find((item) =>
    item.stageId === "engineering" && item.businessAttempt === 2);
  assert.equal(taskAfterSecondRun?.attempt, 2);
  assert.equal(setup.calls.filter((call) => call.profileId === "engineering_role").length, 2);
  assert.notEqual(secondReturn?.id, firstReturn?.id);
  assert.equal((await setup.coordinator.advance(setup.jobId, "engineering_return_ready")).stage, "completed");

  assert.equal(setup.runtime.getJob(setup.jobId)?.status, "failed");
  assert.notEqual(setup.coordinator.getStage(setup.jobId), "engineering_return_ready");
  assert.equal(secondReturn === undefined ? undefined : setup.runtime.listReturns(setup.jobId).find((item) => item.id === secondReturn.id)?.status, "failed");
});

test("P0-5 Quality业务不合格最多验收两次，之后终止而非无限循环", async () => {
  const setup = createHarness((input) => input.profileId === "quality_role"
    ? stageResult("quality found blockers", { blockers: ["tests failed"], nextStageRecommendation: "retry" })
    : stageResult("valid"));
  await driveThroughEngineering(setup);
  assert.equal((await setup.coordinator.advance(setup.jobId, "quality_ready")).stage, "quality_return_ready");

  assert.equal((await setup.coordinator.advance(setup.jobId, "quality_return_ready")).stage, "quality_ready");
  const taskAfterFirstReview = setup.runtime.listTasks(setup.jobId).find((task) => task.profileId === "quality_role");
  const firstReturn = setup.runtime.listReturns(setup.jobId).find((item) =>
    item.stageId === "quality" && item.businessAttempt === 1);
  assert.equal(taskAfterFirstReview?.status, "rework");
  assert.equal(firstReturn?.status, "consumed");

  // 与 Engineering 相同：第二次验收必须对应第二次真实 Worker Stage。
  assert.equal((await setup.coordinator.advance(setup.jobId, "quality_ready")).stage, "quality_return_ready");
  const taskAfterSecondRun = setup.runtime.listTasks(setup.jobId).find((task) => task.profileId === "quality_role");
  const secondReturn = setup.runtime.listReturns(setup.jobId).find((item) =>
    item.stageId === "quality" && item.businessAttempt === 2);
  assert.equal(taskAfterSecondRun?.attempt, 2);
  assert.equal(setup.calls.filter((call) => call.profileId === "quality_role").length, 2);
  assert.notEqual(secondReturn?.id, firstReturn?.id);
  assert.equal((await setup.coordinator.advance(setup.jobId, "quality_return_ready")).stage, "completed");

  assert.equal(setup.runtime.getJob(setup.jobId)?.status, "failed");
  assert.notEqual(setup.coordinator.getStage(setup.jobId), "quality_return_ready");
  assert.equal(secondReturn === undefined ? undefined : setup.runtime.listReturns(setup.jobId).find((item) => item.id === secondReturn.id)?.status, "failed");
});

test("P0-6 Lead返回blocked或failed时不得创建成功最终交付", async () => {
  for (const leadStatus of ["blocked", "failed"] as const) {
    const setup = createHarness((input) => input.profileId === "software_team_lead"
      ? stageResult(`lead ${leadStatus}`, {
          status: leadStatus,
          blockers: [`lead ${leadStatus}`],
          nextStageRecommendation: leadStatus === "blocked" ? "block" : "retry",
        })
      : stageResult("valid"));
    await driveToQualityReturn(setup);

    await assert.rejects(
      setup.coordinator.advance(setup.jobId, "quality_return_ready"),
      /Lead business acceptance failed/,
    );
    assert.equal(setup.runtime.getJob(setup.jobId)?.status, "waiting_returns");
    assert.equal(setup.coordinator.getStage(setup.jobId), "quality_return_ready");
    assert.equal(setup.runtime.listStageCheckpoints(setup.jobId).filter((item) => item.stageId === "lead").at(-1)?.status, "failed_retryable");
    assert.equal(setup.runtime.listReturns(setup.jobId).some((item) => item.stageId === "lead"), false);
    assert.equal(setup.calls.filter((call) => call.profileId === "orchestrator").length, 0);

    await assert.rejects(
      setup.coordinator.advance(setup.jobId, "quality_return_ready"),
      /Lead business acceptance failed/,
    );
    assert.equal(setup.runtime.getJob(setup.jobId)?.status, "failed");
    assert.equal(setup.runtime.listStageCheckpoints(setup.jobId).filter((item) => item.stageId === "lead").at(-1)?.status, "failed_terminal");
    assert.equal(setup.calls.filter((call) => call.profileId === "software_team_lead").length, 2);
    assert.equal(setup.calls.filter((call) => call.profileId === "orchestrator").length, 0);
    assert.equal(setup.runtime.listReturns(setup.jobId).some((item) => item.stageId === "lead"), false);
  }
});

function createHarness(result: (input: ExecutionInput) => string | Error) {
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
  const calls: ExecutionInput[] = [];
  const coordinator = new WorkflowTeamCoordinator({
    runStore: runs,
    runtimeStore: runtime,
    template: SOFTWARE_PRODUCT_DELIVERY_TEMPLATE,
    requirement: requirementContext,
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
      return { turnId: `model-turn-${calls.length}`, summary: output };
    },
  });
  return { lifecycle, runs, runtime, coordinator, jobId: job.id, calls };
}

function createCoordinator(runtime: AgentRuntimeStore, runs: AgentRunStore, result: (input: ExecutionInput) => string | Error) {
  return new WorkflowTeamCoordinator({
    runStore: runs,
    runtimeStore: runtime,
    template: SOFTWARE_PRODUCT_DELIVERY_TEMPLATE,
    requirement: requirementContext,
    execute: async (input) => {
      const recorded: ExecutionInput = {
        profileId: input.profileId,
        attempt: input.attempt,
        formatRepair: input.formatRepair,
        allowedTools: [...input.allowedTools],
      };
      const output = result(recorded);
      if (output instanceof Error) throw output;
      return { turnId: `restored-${input.profileId}-${input.attempt}`, summary: output };
    },
  });
}

function requirementContext() {
  return {
    objective: "P0 workflow regression",
    scope: ["src/**"],
    nonGoals: ["unrelated changes"],
    deliverables: ["code"],
    acceptanceCriteria: ["tests pass"],
    prompt: "confirmed requirement",
  };
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
