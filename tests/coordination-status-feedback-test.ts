import assert from "node:assert/strict";
import test from "node:test";

import { failureOriginForCode, safeFailureMessage } from "../src/agents/agent-presentation.js";
import { AgentRunStore } from "../src/agents/agent-run-store.js";
import { AgentRuntimeStore } from "../src/agents/agent-runtime-store.js";
import { DEFAULT_AGENT_TEAM_CONFIG } from "../src/agents/agent-runtime.js";
import { ensureFixedSoftwareTeam } from "../src/agents/fixed-software-team.js";
import { WorkflowTeamCoordinator } from "../src/execution/workflow-team-coordinator.js";
import { SOFTWARE_PRODUCT_DELIVERY_TEMPLATE } from "../src/execution/workflows/software-product-delivery.js";
import { STAGE_RESULT_CONTRACT_VERSION } from "../src/execution/stage-contract.js";
import { getAgentPresentation } from "../src/electron/renderer/runtime-ui.js";
import { LifecycleStore } from "../src/runtime/lifecycle-store.js";

const stageResult = (status: "completed" | "failed" | "blocked", summary: string) => JSON.stringify({
  status,
  summary,
  deliverables: status === "completed" ? ["artifact"] : [],
  evidence: status === "completed" ? ["verified"] : [],
  blockers: status === "completed" ? [] : [summary],
  nextStageRecommendation: status === "blocked" ? "block" : status === "failed" ? "retry" : "continue",
  contractVersion: STAGE_RESULT_CONTRACT_VERSION,
});

test("旧 AgentRunSnapshot 未包含协作字段时仍可恢复", () => {
  const restored = AgentRunStore.fromSnapshot({
    version: 2,
    sequence: 1,
    returnReceipts: [],
    runs: [{
      id: "agent-run-1", jobId: "job-1", rootRunId: "agent-run-1", attempt: 1,
      threadId: "thread-1", turnId: "turn-1", agentProfileId: "orchestrator",
      childRunIds: [], status: "completed", task: "legacy", depth: 0,
      createdAt: "2026-08-19T00:00:00.000Z",
    }],
  });
  assert.equal(restored.get("agent-run-1")?.coordinationStatus, undefined);
  assert.equal(restored.get("agent-run-1")?.attentionLevel, undefined);
});

test("Product 真正业务失败只标红责任节点，未执行下游保持橙色 upstream_blocked", async () => {
  const setup = createHarness(async () => stageResult("failed", "product contract rejected"));
  await driveProductTwice(setup);

  assert.equal(setup.runtime.getJob(setup.jobId)?.status, "failed");
  const product = run(setup, "product_role");
  assert.equal(product.status, "failed");
  assert.equal(product.attentionLevel, "error");
  assert.equal(product.failureOrigin, "contract");
  assert.equal(product.result?.safeError, "阶段输出仍需补充或调整");

  for (const profile of ["engineering_role", "quality_role"] as const) {
    const downstream = run(setup, profile);
    assert.equal(downstream.status, "cancelled");
    assert.equal(downstream.coordinationStatus, "upstream_blocked");
    assert.equal(downstream.attentionLevel, "feedback");
    assert.equal(downstream.failureOrigin, "dependency");
  }
  for (const profile of ["software_team_lead", "orchestrator"]) {
    const ancestor = run(setup, profile);
    assert.equal(ancestor.status, "cancelled");
    assert.equal(ancestor.coordinationStatus, "skipped");
    assert.equal(ancestor.attentionLevel, "neutral");
  }
  const terminalRuns = setup.runs.listForJob(setup.jobId);
  assert.equal(terminalRuns.some((item) => ["queued", "running", "waiting_children", "resuming"].includes(item.status)), false);
  assert.deepEqual(terminalRuns.filter((item) => item.attentionLevel === "error").map((item) => item.id), [product.id]);
  assert.equal(setup.runtime.listTasks(setup.jobId).find((item) => item.profileId === "product_role")?.status, "failed");
});

test("Product blocked 后 Root/Lead 保持活动，并在同 Job/同 Thread 恢复完成", async () => {
  let productCalls = 0;
  const setup = createHarness(async (profileId) => profileId === "product_role" && ++productCalls === 1
    ? stageResult("blocked", "missing parent decision")
    : stageResult("completed", "valid"));
  const originalThread = run(setup, "product_role").threadId;
  assert.equal((await setup.coordinator.advance(setup.jobId, "ready_first_return")).stage, "first_return_ready");
  assert.equal((await setup.coordinator.advance(setup.jobId, "first_return_ready")).stage, "rework");

  assert.equal(setup.runtime.getJob(setup.jobId)?.status, "reviewing");
  const product = run(setup, "product_role");
  assert.equal(product.status, "resuming");
  assert.equal(product.coordinationStatus, "feedback_required");
  assert.equal(product.attentionLevel, "feedback");
  assert.equal(product.failureOrigin, undefined);
  assert.equal(setup.runtime.listTasks(setup.jobId).find((item) => item.profileId === "product_role")?.status, "blocked");
  assertSupervisorsActive(setup);
  assertDownstreamBlocked(setup, ["engineering_role", "quality_role"]);

  const resumed = restoreHarness(setup, async () => stageResult("completed", "valid after parent steer"));
  assert.deepEqual(resumed.coordinator.recoveryDecision(resumed.jobId), { kind: "wait", reason: "feedback" });
  assert.equal((await resumed.coordinator.advance(resumed.jobId, "rework")).stage, "second_return_ready");
  assert.equal((await resumed.coordinator.advance(resumed.jobId, "second_return_ready")).stage, "engineering_ready");
  await finishFromEngineering(resumed);
  assert.equal(resumed.runtime.getJob(resumed.jobId)?.status, "completed");
  assert.equal(run(resumed, "product_role").threadId, originalThread);
  assert.equal(resumed.runs.listForJob(resumed.jobId).some((item) => item.status === "failed"), false);
});

test("Engineering blocked 后只标记 Quality 上游阻塞，并在同 Job/同 Thread 恢复完成", async () => {
  let engineeringCalls = 0;
  const setup = createHarness(async (profileId) => profileId === "engineering_role" && ++engineeringCalls === 1
    ? stageResult("blocked", "missing implementation decision")
    : stageResult("completed", "valid"));
  const originalThread = run(setup, "engineering_role").threadId;
  assert.equal((await setup.coordinator.advance(setup.jobId, "ready_first_return")).stage, "first_return_ready");
  assert.equal((await setup.coordinator.advance(setup.jobId, "first_return_ready")).stage, "engineering_ready");
  assert.equal((await setup.coordinator.advance(setup.jobId, "engineering_ready")).stage, "engineering_return_ready");
  assert.equal((await setup.coordinator.advance(setup.jobId, "engineering_return_ready")).stage, "engineering_ready");

  assert.equal(setup.runtime.getJob(setup.jobId)?.status, "reviewing");
  assert.equal(run(setup, "engineering_role").coordinationStatus, "feedback_required");
  assert.equal(run(setup, "engineering_role").status, "resuming");
  assertSupervisorsActive(setup);
  assertDownstreamBlocked(setup, ["quality_role"]);

  assert.equal((await setup.coordinator.advance(setup.jobId, "engineering_ready")).stage, "engineering_return_ready");
  assert.equal((await setup.coordinator.advance(setup.jobId, "engineering_return_ready")).stage, "quality_ready");
  assert.equal((await setup.coordinator.advance(setup.jobId, "quality_ready")).stage, "quality_return_ready");
  assert.equal((await setup.coordinator.advance(setup.jobId, "quality_return_ready")).stage, "lead_return_ready");
  assert.equal((await setup.coordinator.advance(setup.jobId, "lead_return_ready")).stage, "completed");
  assert.equal(setup.runtime.getJob(setup.jobId)?.status, "completed");
  assert.equal(run(setup, "engineering_role").threadId, originalThread);
  assert.equal(setup.runs.listForJob(setup.jobId).some((item) => item.status === "failed"), false);
});

test("Quality blocked 后祖先保持活动，并在同 Job/同 Thread 恢复完成", async () => {
  let qualityCalls = 0;
  const setup = createHarness(async (profileId) => profileId === "quality_role" && ++qualityCalls === 1
    ? stageResult("blocked", "missing quality decision")
    : stageResult("completed", "valid"));
  const originalThread = run(setup, "quality_role").threadId;
  await driveThroughEngineering(setup);
  assert.equal((await setup.coordinator.advance(setup.jobId, "quality_ready")).stage, "quality_return_ready");
  assert.equal((await setup.coordinator.advance(setup.jobId, "quality_return_ready")).stage, "quality_ready");

  assert.equal(setup.runtime.getJob(setup.jobId)?.status, "reviewing");
  assert.equal(run(setup, "quality_role").status, "resuming");
  assert.equal(run(setup, "quality_role").coordinationStatus, "feedback_required");
  assertSupervisorsActive(setup);

  assert.equal((await setup.coordinator.advance(setup.jobId, "quality_ready")).stage, "quality_return_ready");
  assert.equal((await setup.coordinator.advance(setup.jobId, "quality_return_ready")).stage, "lead_return_ready");
  assert.equal((await setup.coordinator.advance(setup.jobId, "lead_return_ready")).stage, "completed");
  assert.equal(setup.runtime.getJob(setup.jobId)?.status, "completed");
  assert.equal(run(setup, "quality_role").threadId, originalThread);
});

test("真实 Provider 故障标红责任节点并保留 failureOrigin，内部错误码转换为安全文案", async () => {
  const providerError = Object.assign(new Error("Too many requests"), { status: 429 });
  const setup = createHarness(async () => { throw providerError; });

  await assert.rejects(setup.coordinator.advance(setup.jobId, "ready_first_return"), /Too many requests/);
  assert.equal(run(setup, "product_role").attentionLevel, "feedback");
  assert.equal(run(setup, "product_role").coordinationStatus, "feedback_required");
  await assert.rejects(setup.coordinator.advance(setup.jobId, "ready_first_return"), /Too many requests/);

  const product = run(setup, "product_role");
  assert.equal(setup.runtime.getJob(setup.jobId)?.status, "failed");
  assert.equal(product.attentionLevel, "error");
  assert.equal(product.failureOrigin, "provider");
  assert.equal(product.result?.safeError, "模型服务当前繁忙，请稍后重试");
  assert.equal(failureOriginForCode("tool_execution_failed"), "tool");
  assert.equal(safeFailureMessage("stage_retry_exhausted"), "阶段输出仍需补充或调整");
});

test("Renderer 统一 presentation 映射：等待灰、反馈橙、真实错误红", () => {
  const base = {
    id: "run", jobId: "job", rootRunId: "root", attempt: 1,
    threadId: "thread", turnId: "turn", agentProfileId: "quality_role",
    status: "queued" as const, task: "quality", depth: 2,
  };
  assert.deepEqual(getAgentPresentation({ ...base, coordinationStatus: "waiting_assignment" }), {
    label: "等待负责人分派", attention: "neutral",
  });
  assert.equal(getAgentPresentation({ ...base, coordinationStatus: "upstream_blocked" }).attention, "feedback");
  assert.equal(getAgentPresentation({ ...base, status: "failed", safeError: "stage_retry_exhausted" }).message, "阶段输出仍需补充或调整");
  assert.equal(getAgentPresentation({ ...base, status: "failed", failureOrigin: "tool" }).attention, "error");
});

function createHarness(execute: (profileId: string) => Promise<string>) {
  const lifecycle = new LifecycleStore();
  const thread = lifecycle.createThread();
  const turn = lifecycle.createTurn(thread.id);
  const runs = new AgentRunStore();
  const runtime = new AgentRuntimeStore();
  const root = runs.ensureRoot(thread.id, turn.id, "orchestrator");
  const job = runtime.createJob({
    threadId: thread.id, rootTurnId: turn.id, rootRunId: root.id,
    configSnapshot: DEFAULT_AGENT_TEAM_CONFIG,
    executionKind: "software_product_delivery", workflowVersion: "software_product_delivery_v2",
  });
  ensureFixedSoftwareTeam(lifecycle, runs, root);
  let modelTurn = 0;
  const coordinator = new WorkflowTeamCoordinator({
    runStore: runs,
    runtimeStore: runtime,
    template: SOFTWARE_PRODUCT_DELIVERY_TEMPLATE,
    requirement: () => ({
      objective: "coordination status regression", scope: ["src/**"], nonGoals: [],
      deliverables: ["code"], acceptanceCriteria: ["tests pass"], prompt: "confirmed",
    }),
    execute: async (input) => ({ turnId: `model-turn-${++modelTurn}`, summary: await execute(input.profileId) }),
  });
  return { runs, runtime, coordinator, jobId: job.id };
}

function restoreHarness(setup: ReturnType<typeof createHarness>, execute: (profileId: string) => Promise<string>) {
  const runs = AgentRunStore.fromSnapshot(setup.runs.exportSnapshot());
  const runtime = AgentRuntimeStore.fromSnapshot(setup.runtime.exportSnapshot());
  let modelTurn = 0;
  const coordinator = new WorkflowTeamCoordinator({
    runStore: runs,
    runtimeStore: runtime,
    template: SOFTWARE_PRODUCT_DELIVERY_TEMPLATE,
    requirement: () => ({
      objective: "coordination status regression", scope: ["src/**"], nonGoals: [],
      deliverables: ["code"], acceptanceCriteria: ["tests pass"], prompt: "confirmed",
    }),
    execute: async (input) => ({ turnId: `restored-turn-${++modelTurn}`, summary: await execute(input.profileId) }),
  });
  return { runs, runtime, coordinator, jobId: setup.jobId };
}

async function driveProductTwice(setup: ReturnType<typeof createHarness>) {
  assert.equal((await setup.coordinator.advance(setup.jobId, "ready_first_return")).stage, "first_return_ready");
  assert.equal((await setup.coordinator.advance(setup.jobId, "first_return_ready")).stage, "rework");
  assert.equal((await setup.coordinator.advance(setup.jobId, "rework")).stage, "second_return_ready");
  assert.equal((await setup.coordinator.advance(setup.jobId, "second_return_ready")).stage, "completed");
}

async function driveThroughEngineering(setup: ReturnType<typeof createHarness>) {
  assert.equal((await setup.coordinator.advance(setup.jobId, "ready_first_return")).stage, "first_return_ready");
  assert.equal((await setup.coordinator.advance(setup.jobId, "first_return_ready")).stage, "engineering_ready");
  assert.equal((await setup.coordinator.advance(setup.jobId, "engineering_ready")).stage, "engineering_return_ready");
  assert.equal((await setup.coordinator.advance(setup.jobId, "engineering_return_ready")).stage, "quality_ready");
}

async function finishFromEngineering(setup: ReturnType<typeof createHarness>) {
  assert.equal((await setup.coordinator.advance(setup.jobId, "engineering_ready")).stage, "engineering_return_ready");
  assert.equal((await setup.coordinator.advance(setup.jobId, "engineering_return_ready")).stage, "quality_ready");
  assert.equal((await setup.coordinator.advance(setup.jobId, "quality_ready")).stage, "quality_return_ready");
  assert.equal((await setup.coordinator.advance(setup.jobId, "quality_return_ready")).stage, "lead_return_ready");
  assert.equal((await setup.coordinator.advance(setup.jobId, "lead_return_ready")).stage, "completed");
}

function assertSupervisorsActive(setup: ReturnType<typeof createHarness>) {
  for (const profile of ["orchestrator", "software_team_lead"]) {
    const supervisor = run(setup, profile);
    assert.equal(supervisor.status, "waiting_children");
    assert.equal(supervisor.coordinationStatus, "waiting_children");
    assert.equal(supervisor.attentionLevel, "active");
  }
}

function assertDownstreamBlocked(setup: ReturnType<typeof createHarness>, profiles: string[]) {
  for (const profile of profiles) {
    const downstream = run(setup, profile);
    assert.equal(downstream.status, "queued");
    assert.equal(downstream.coordinationStatus, "upstream_blocked");
    assert.equal(downstream.attentionLevel, "feedback");
  }
}

function run(setup: ReturnType<typeof createHarness>, profileId: string) {
  const found = setup.runs.listForJob(setup.jobId).find((item) => item.agentProfileId === profileId);
  assert.ok(found, `${profileId} run should exist`);
  return found;
}
