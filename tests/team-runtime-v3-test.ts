import assert from "node:assert/strict";
import test from "node:test";

import { AgentRunStore } from "../src/agents/agent-run-store.js";
import { AgentRuntimeStore } from "../src/agents/agent-runtime-store.js";
import { DEFAULT_AGENT_TEAM_CONFIG } from "../src/agents/agent-runtime.js";
import { ensureFixedSoftwareTeam } from "../src/agents/fixed-software-team.js";
import { LifecycleStore } from "../src/runtime/lifecycle-store.js";
import { STAGE_RESULT_CONTRACT_VERSION } from "../src/execution/stage-contract.js";
import { taskBoundaries, V3ProductDeliveryCoordinator, V3_ENGINEERING_PROFILES } from "../src/execution/v3-product-delivery-coordinator.js";
import { SOFTWARE_PRODUCT_DELIVERY_V3_TEMPLATE } from "../src/execution/workflows/software-product-delivery.js";

const validResult = (summary: string) => JSON.stringify({
  status: "completed", summary, deliverables: [`${summary} artifact`], evidence: [`${summary} evidence`], blockers: [],
  nextStageRecommendation: "continue", contractVersion: STAGE_RESULT_CONTRACT_VERSION,
});

test("v3 在设计确认前硬停，确认后恰好并行启动三个工程 Chat 并 fan-in", async () => {
  let designConfirmed = false;
  let releaseEngineering!: () => void;
  const engineeringGate = new Promise<void>((resolve) => { releaseEngineering = resolve; });
  let allStarted!: () => void;
  const allEngineeringStarted = new Promise<void>((resolve) => { allStarted = resolve; });
  const activeEngineering = new Set<string>();
  const setup = createV3Harness({
    designConfirmed: () => designConfirmed,
    execute: async (profileId) => {
      if (V3_ENGINEERING_PROFILES.includes(profileId as typeof V3_ENGINEERING_PROFILES[number])) {
        activeEngineering.add(profileId);
        if (activeEngineering.size === 3) allStarted();
        await engineeringGate;
      }
      return validResult(profileId);
    },
  });

  assert.equal((await setup.coordinator.advance(setup.jobId, "product_design_ready")).stage, "mock_preview_ready");
  assert.equal((await setup.coordinator.advance(setup.jobId, "mock_preview_ready")).stage, "design_confirmation");
  assert.equal(setup.runtime.listTasks(setup.jobId).some((task) => V3_ENGINEERING_PROFILES.includes(task.profileId as typeof V3_ENGINEERING_PROFILES[number])), false);
  assert.equal(setup.coordinator.recoveryDecision(setup.jobId).kind, "wait");

  const frontendRun = setup.runs.listForJob(setup.jobId).find((run) => run.agentProfileId === "frontend_engineering")!;
  setup.runtime.createTask({ jobId: setup.jobId, rootRunId: setup.root.id, ownerRunId: frontendRun.id,
    profileId: "frontend_engineering", title: "forged", objective: "forged", scope: { allowedPaths: ["src/electron"], deniedPaths: [], nonGoals: [] },
    requiredOutputs: [], acceptanceCriteria: [], fileClaims: ["src/electron"], maxAttempts: 2, status: "ready" });
  assert.equal(setup.coordinator.getStage(setup.jobId), "design_confirmation");

  designConfirmed = true;
  const fanout = setup.coordinator.advance(setup.jobId, "engineering_fanout");
  await allEngineeringStarted;
  assert.equal(activeEngineering.size, 3, "三个工程 Chat 必须在任意一个结束前全部进入执行");
  releaseEngineering();
  assert.equal((await fanout).stage, "engineering_fanout_ready");
  assert.deepEqual(V3_ENGINEERING_PROFILES.map((profile) => setup.runtime.listTasks(setup.jobId).find((task) => task.profileId === profile)?.status), ["completed", "completed", "completed"]);
});

test("v3 单 Chat 返工只重跑原 Task，不重复运行另外两个成功 Chat", async () => {
  const callCount = new Map<string, number>();
  const setup = createV3Harness({ designConfirmed: () => true, execute: async (profileId) => {
    callCount.set(profileId, (callCount.get(profileId) ?? 0) + 1);
    return validResult(profileId);
  } });
  await setup.coordinator.advance(setup.jobId, "product_design_ready");
  await setup.coordinator.advance(setup.jobId, "mock_preview_ready");
  await setup.coordinator.advance(setup.jobId, "engineering_fanout");
  const frontend = setup.runtime.listTasks(setup.jobId).find((task) => task.profileId === "frontend_engineering")!;
  await setup.coordinator.requestEngineeringRework(setup.jobId, frontend.id, "只修前端视觉回归");
  await setup.coordinator.advance(setup.jobId, "engineering_fanout");
  assert.equal(callCount.get("frontend_engineering"), 2);
  assert.equal(callCount.get("backend_engineering"), 1);
  assert.equal(callCount.get("integration_quality"), 1);
  assert.equal(setup.runtime.getTask(frontend.id)?.attempt, 2);
});

test("v3 完整交付后单 Chat 返工会重新联调、独立测试、负责人验收和 Return God", async () => {
  const callCount = new Map<string, number>();
  const setup = createV3Harness({ designConfirmed: () => true, execute: async (profileId) => {
    callCount.set(profileId, (callCount.get(profileId) ?? 0) + 1);
    return validResult(profileId);
  } });
  for (const stage of ["product_design_ready", "mock_preview_ready", "engineering_fanout", "engineering_fanout_ready", "integration_review", "quality_review", "lead_acceptance", "lead_return_ready"] as const) {
    await setup.coordinator.advance(setup.jobId, stage);
  }
  assert.equal(setup.runtime.getJob(setup.jobId)?.status, "completed");
  const frontend = setup.runtime.listTasks(setup.jobId).find((task) => task.profileId === "frontend_engineering")!;
  await setup.coordinator.requestEngineeringRework(setup.jobId, frontend.id, "最终交付后只返工前端");
  assert.equal(setup.coordinator.getStage(setup.jobId), "engineering_fanout");
  for (const stage of ["engineering_fanout", "engineering_fanout_ready", "integration_review", "quality_review", "lead_acceptance", "lead_return_ready"] as const) {
    await setup.coordinator.advance(setup.jobId, stage);
  }
  assert.equal(setup.runtime.getJob(setup.jobId)?.status, "completed");
  assert.equal(callCount.get("frontend_engineering"), 2);
  assert.equal(callCount.get("backend_engineering"), 1);
  assert.equal(callCount.get("integration_quality"), 1);
  assert.equal(callCount.get("quality_role"), 2);
  assert.equal(callCount.get("orchestrator"), 2);
  for (const stageId of ["integration_review", "quality_review", "lead_acceptance", "return_god"]) {
    assert.equal(setup.runtime.listStageCheckpoints(setup.jobId).filter((item) => item.stageId === stageId).at(-1)?.stageAttempt, 2);
  }
  assert.equal(setup.runtime.listReturns(setup.jobId).filter((item) => item.stageId === "return_god" && item.status === "consumed").length, 2);
});

test("v3 前端、后端与联调文件声明互不重叠", () => {
  const scope = ["src/electron", "src/app-server", "tests"];
  const frontend = taskBoundaries("frontend_engineering", scope);
  const backend = taskBoundaries("backend_engineering", scope);
  const integration = taskBoundaries("integration_quality", scope);
  assert.deepEqual(frontend.allow, ["src/electron"]);
  assert.deepEqual(backend.allow, ["src/app-server"]);
  assert.deepEqual(integration.allow, ["tests"]);
  assert.equal(integration.deny.includes("src/electron"), true);
  assert.equal(integration.deny.includes("src/app-server"), true);
});

test("v3 工程 Chat 第二次结构化业务失败后保留 failed 终态", async () => {
  const failedResult = JSON.stringify({
    status: "failed", summary: "frontend failed", deliverables: [], evidence: ["failure evidence"], blockers: ["cannot continue"],
    nextStageRecommendation: "block", contractVersion: STAGE_RESULT_CONTRACT_VERSION,
  });
  const setup = createV3Harness({ designConfirmed: () => true, execute: async (profileId) =>
    profileId === "frontend_engineering" ? failedResult : validResult(profileId) });
  await setup.coordinator.advance(setup.jobId, "product_design_ready");
  await setup.coordinator.advance(setup.jobId, "mock_preview_ready");
  await setup.coordinator.advance(setup.jobId, "engineering_fanout");
  assert.equal(setup.runtime.getJob(setup.jobId)?.status, "reviewing");
  const frontend = setup.runtime.listTasks(setup.jobId).find((task) => task.profileId === "frontend_engineering")!;
  assert.equal(frontend.status, "rework");
  await setup.coordinator.advance(setup.jobId, "engineering_fanout");
  assert.equal(setup.runtime.getJob(setup.jobId)?.status, "failed");
  assert.equal(setup.coordinator.recoveryDecision(setup.jobId).kind, "terminal");
});

test("v3 不接受模型自报测试通过，工程与质量阶段必须有真实 Tool receipt", async () => {
  const setup = createV3Harness({
    designConfirmed: () => true,
    execute: async (profileId) => validResult(profileId),
    receipts: () => [],
  });
  await setup.coordinator.advance(setup.jobId, "product_design_ready");
  await setup.coordinator.advance(setup.jobId, "mock_preview_ready");
  await setup.coordinator.advance(setup.jobId, "engineering_fanout");
  assert.equal(setup.runtime.getJob(setup.jobId)?.status, "reviewing");
  assert.deepEqual(V3_ENGINEERING_PROFILES.map((profile) =>
    setup.runtime.listTasks(setup.jobId).find((task) => task.profileId === profile)?.status),
  ["rework", "rework", "rework"]);
  await assert.rejects(() => setup.coordinator.advance(setup.jobId, "engineering_fanout"), /requires a successful/);
  assert.equal(setup.runtime.getJob(setup.jobId)?.status, "failed");
});

test("v3 三 Chat Return 后依次完成负责人联调、独立测试、最终验收与 God 交付", async () => {
  const setup = createV3Harness({ designConfirmed: () => true, execute: async (profileId) => validResult(`${profileId} ok`) });
  await setup.coordinator.advance(setup.jobId, "product_design_ready");
  await setup.coordinator.advance(setup.jobId, "mock_preview_ready");
  await setup.coordinator.advance(setup.jobId, "engineering_fanout");
  assert.equal((await setup.coordinator.advance(setup.jobId, "engineering_fanout_ready")).stage, "integration_review");
  assert.equal((await setup.coordinator.advance(setup.jobId, "integration_review")).stage, "quality_review");
  assert.equal((await setup.coordinator.advance(setup.jobId, "quality_review")).stage, "lead_acceptance");
  assert.equal((await setup.coordinator.advance(setup.jobId, "lead_acceptance")).stage, "lead_return_ready");
  assert.equal((await setup.coordinator.advance(setup.jobId, "lead_return_ready")).stage, "completed");
  assert.equal(setup.runtime.getJob(setup.jobId)?.status, "completed");
  assert.equal(setup.runtime.listReturns(setup.jobId).filter((item) => item.stageId === "return_god" && item.status === "consumed").length, 1);
  assert.equal(setup.runtime.listStageCheckpoints(setup.jobId).filter((item) => item.status === "completed").length, 9);
});

test("v3 设计等待快照重启后恢复同一 Job，并且不重跑产品原稿与 Mock", async () => {
  const original = createV3Harness({ designConfirmed: () => false, execute: async (profileId) => validResult(profileId) });
  await original.coordinator.advance(original.jobId, "product_design_ready");
  await original.coordinator.advance(original.jobId, "mock_preview_ready");
  assert.equal(original.coordinator.getStage(original.jobId), "design_confirmation");

  const runs = AgentRunStore.fromSnapshot(original.runs.exportSnapshot());
  const runtime = AgentRuntimeStore.fromSnapshot(original.runtime.exportSnapshot());
  const resumedProfiles: string[] = [];
  let turnSequence = 100;
  const coordinator = new V3ProductDeliveryCoordinator({
    runStore: runs,
    runtimeStore: runtime,
    template: SOFTWARE_PRODUCT_DELIVERY_V3_TEMPLATE,
    requirement: () => ({ objective: "产品 Idea", scope: ["src/electron", "src/app-server", "tests"],
      nonGoals: [], deliverables: ["产品"], acceptanceCriteria: ["符合设计"], prompt: "confirmed requirement" }),
    designConfirmed: () => true,
    writeDesignArtifact: async () => ({ path: "D:/plans/design.md", contentHash: "a".repeat(64), generatedAt: "2026-08-24T00:00:00.000Z", mockPreview: "D:/plans/mock.html" }),
    markDesignDraft: () => undefined,
    requestDesignRevision: () => undefined,
    execute: async ({ profileId }) => {
      resumedProfiles.push(profileId);
      return { turnId: `v3-turn-${++turnSequence}`, summary: validResult(profileId),
        toolReceipts: profileId === "frontend_engineering" || profileId === "backend_engineering"
          ? [{ name: "write_file", ok: true }]
          : profileId === "integration_quality" ? [{ name: "run_command", ok: true, exitCode: 0 }] : [] };
    },
  });
  assert.equal(coordinator.getStage(original.jobId), "engineering_fanout");
  await coordinator.advance(original.jobId, "engineering_fanout");
  assert.deepEqual(resumedProfiles.sort(), [...V3_ENGINEERING_PROFILES].sort());
  assert.equal(runtime.listJobs().length, 1);
});

function createV3Harness(input: {
  designConfirmed: () => boolean;
  execute: (profileId: string) => Promise<string>;
  receipts?: (profileId: string) => Array<{ name: string; ok: boolean; exitCode?: number }>;
}) {
  const lifecycle = new LifecycleStore();
  const thread = lifecycle.createThread();
  const turn = lifecycle.createTurn(thread.id);
  const runs = new AgentRunStore();
  const runtime = new AgentRuntimeStore();
  const root = runs.ensureRoot(thread.id, turn.id, "orchestrator", "job-requirement-1-v1");
  const job = runtime.createJob({ threadId: thread.id, rootTurnId: turn.id, rootRunId: root.id,
    configSnapshot: { ...DEFAULT_AGENT_TEAM_CONFIG, independentReview: false }, executionKind: "software_product_delivery",
    workflowVersion: "software_product_delivery_v3", requirementId: "requirement-1", requirementRevision: 1 });
  ensureFixedSoftwareTeam(lifecycle, runs, root, job.workflowVersion);
  let turnSequence = 0;
  const coordinator = new V3ProductDeliveryCoordinator({ runStore: runs, runtimeStore: runtime, template: SOFTWARE_PRODUCT_DELIVERY_V3_TEMPLATE,
    requirement: () => ({ objective: "产品 Idea", scope: ["src/electron", "src/app-server", "tests"], nonGoals: ["越界修改"], deliverables: ["产品"], acceptanceCriteria: ["符合设计"], prompt: "confirmed requirement" }),
    designConfirmed: input.designConfirmed,
    writeDesignArtifact: async () => ({ path: "D:/plans/design.md", contentHash: "a".repeat(64), generatedAt: "2026-08-24T00:00:00.000Z", mockPreview: "D:/plans/mock.html" }),
    markDesignDraft: () => undefined,
    requestDesignRevision: () => undefined,
    execute: async ({ profileId }) => ({
      turnId: `v3-turn-${++turnSequence}`,
      summary: await input.execute(profileId),
      toolReceipts: input.receipts?.(profileId) ?? (profileId === "frontend_engineering" || profileId === "backend_engineering"
        ? [{ name: "write_file", ok: true }]
        : profileId === "integration_quality" || profileId === "quality_role"
          ? [{ name: "run_command", ok: true, exitCode: 0 }]
          : []),
    }),
  });
  return { lifecycle, runs, runtime, root, jobId: job.id, coordinator };
}
