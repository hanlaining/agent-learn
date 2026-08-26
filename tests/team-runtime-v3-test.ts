import assert from "node:assert/strict";
import test from "node:test";

import { AgentRunStore } from "../src/agents/agent-run-store.js";
import { AgentRuntimeStore } from "../src/agents/agent-runtime-store.js";
import { DEFAULT_AGENT_TEAM_CONFIG, type AgentTask } from "../src/agents/agent-runtime.js";
import { ensureFixedSoftwareTeam } from "../src/agents/fixed-software-team.js";
import { LifecycleStore } from "../src/runtime/lifecycle-store.js";
import { STAGE_RESULT_CONTRACT_VERSION } from "../src/execution/stage-contract.js";
import {
  assertDisjointEngineeringClaims,
  taskBoundaries,
  V3ProductDeliveryCoordinator,
  V3_ENGINEERING_PROFILES,
  type V3ProductDeliveryCoordinatorOptions,
  type V3RequirementContext,
} from "../src/execution/v3-product-delivery-coordinator.js";
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

test("v3 recoveryDecision 与 canAdvanceWithoutModel 对缺失、反馈和阶段完成状态 fail closed", async () => {
  const missing = createV3Harness({ designConfirmed: () => false, execute: async (profileId) => validResult(profileId) });
  assert.deepEqual(missing.coordinator.recoveryDecision("missing-job"), { kind: "terminal", status: "failed" });
  assert.equal(missing.coordinator.canAdvanceWithoutModel(missing.jobId, "design_confirmation"), false);
  await missing.coordinator.advance(missing.jobId, "product_design_ready");
  await missing.coordinator.advance(missing.jobId, "mock_preview_ready");
  assert.equal(missing.coordinator.getStage(missing.jobId), "design_confirmation");
  assert.deepEqual(missing.coordinator.recoveryDecision(missing.jobId), { kind: "wait", reason: "feedback" });

  const resumed = createV3Harness({ designConfirmed: () => true, execute: async (profileId) => validResult(profileId) });
  assert.equal(resumed.coordinator.canAdvanceWithoutModel(resumed.jobId, "design_confirmation"), true);
  assert.equal(resumed.coordinator.canAdvanceWithoutModel(resumed.jobId, "lead_return_ready"), true);
  assert.equal(resumed.coordinator.canAdvanceWithoutModel(resumed.jobId, "engineering_fanout_ready"), false);
  await resumed.coordinator.advance(resumed.jobId, "product_design_ready");
  await resumed.coordinator.advance(resumed.jobId, "mock_preview_ready");
  await resumed.coordinator.advance(resumed.jobId, "engineering_fanout");
  const task = resumed.runtime.listTasks(resumed.jobId).find((item) => item.profileId === "frontend_engineering")!;
  resumed.runtime.setTaskStatus(task.id, "failed");
  assert.deepEqual(resumed.coordinator.recoveryDecision(resumed.jobId), { kind: "wait", reason: "feedback" });
});

test("v3 recoveryDecision 覆盖 active 与全部终态，返工入口拒绝越权/终态/运行中 Task", async () => {
  const setup = createV3Harness({ designConfirmed: () => true, execute: async (profileId) => validResult(profileId) });
  assert.deepEqual(setup.coordinator.recoveryDecision("missing-v3-job"), { kind: "terminal", status: "failed" });
  for (const status of ["completed", "failed", "partial", "cancelled"] as const) {
    setup.runtime.setJobStatus(setup.jobId, status);
    assert.deepEqual(setup.coordinator.recoveryDecision(setup.jobId), { kind: "terminal", status });
  }
  setup.runtime.setJobStatus(setup.jobId, "running");
  const frontend = setup.runtime.createTask({
    jobId: setup.jobId, rootRunId: setup.root.id, ownerRunId: setup.root.id,
    profileId: "frontend_engineering", title: "frontend", objective: "frontend",
    scope: { allowedPaths: ["src/electron"], deniedPaths: [], nonGoals: [] },
    requiredOutputs: [], acceptanceCriteria: [], fileClaims: ["src/electron"], maxAttempts: 2, status: "running",
  });
  await assert.rejects(() => setup.coordinator.requestEngineeringRework(setup.jobId, "missing-task", "x"), /Task is unavailable/u);
  await assert.rejects(() => setup.coordinator.requestEngineeringRework("missing-job", frontend.id, "x"), /Task is unavailable/u);
  await assert.rejects(() => setup.coordinator.requestEngineeringRework(setup.jobId, frontend.id, "x"), /still running/u);
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

  const shared = { id: "task-a", profileId: "frontend_engineering", fileClaims: ["./src/shared/**"] } as AgentTask;
  assert.doesNotThrow(() => assertDisjointEngineeringClaims([shared, { ...shared, fileClaims: ["src/shared/module"] }]));
  assert.throws(() => assertDisjointEngineeringClaims([
    shared,
    { ...shared, id: "task-b", profileId: "backend_engineering", fileClaims: ["src/shared/module"] },
  ]), /file claims overlap/u);
});

test("v3 设计反馈重用原 Task 进入第二 attempt，并在达到上限后失败关闭", async () => {
  const revisions: string[] = [];
  const setup = createV3Harness({
    designConfirmed: () => false,
    execute: async (profileId) => validResult(profileId),
    requestDesignRevision: (_jobId, feedback) => { revisions.push(feedback); },
  });
  assert.equal(await setup.coordinator.provideFeedback(setup.jobId, { turnId: "early", text: "too early" }), false);
  await setup.coordinator.advance(setup.jobId, "product_design_ready");
  await setup.coordinator.advance(setup.jobId, "mock_preview_ready");
  assert.equal(await setup.coordinator.provideFeedback(setup.jobId, { turnId: "feedback", text: "把空状态写清楚" }), true);
  assert.deepEqual(revisions, ["把空状态写清楚"]);
  assert.equal(setup.coordinator.getStage(setup.jobId), "product_design_ready");
  assert.deepEqual(setup.runtime.listTasks(setup.jobId).filter((task) => ["product_design", "mock_preview"].includes(task.profileId))
    .map((task) => [task.profileId, task.attempt, task.status]), [
    ["product_design", 2, "rework"],
    ["mock_preview", 2, "rework"],
  ]);
  await setup.coordinator.advance(setup.jobId, "product_design_ready");
  await setup.coordinator.advance(setup.jobId, "mock_preview_ready");
  await assert.rejects(() => setup.coordinator.provideFeedback(setup.jobId, { turnId: "again", text: "third draft" }), /retry limit/u);
});

test("v3 非结构化输出只修复一次，执行异常按两次上限收敛 failed", async () => {
  let productCalls = 0;
  const repaired = createV3Harness({ designConfirmed: () => false, execute: async (profileId) => {
    if (profileId === "product_design" && productCalls++ === 0) return "not-json";
    return validResult(profileId);
  } });
  assert.equal((await repaired.coordinator.advance(repaired.jobId, "product_design_ready")).stage, "mock_preview_ready");
  assert.equal(productCalls, 2);
  assert.equal(repaired.runtime.listStageCheckpoints(repaired.jobId)[0]?.status, "completed");

  let failures = 0;
  const crashed = createV3Harness({
    designConfirmed: () => false,
    execute: async () => { throw new Error("provider crashed"); },
    onFailed: () => { failures += 1; },
  });
  await assert.rejects(() => crashed.coordinator.advance(crashed.jobId, "product_design_ready"), /provider crashed/u);
  assert.equal(crashed.runtime.listTasks(crashed.jobId)[0]?.status, "rework");
  await assert.rejects(() => crashed.coordinator.advance(crashed.jobId, "product_design_ready"), /provider crashed/u);
  assert.equal(crashed.runtime.getJob(crashed.jobId)?.status, "failed");
  assert.equal(crashed.runtime.listStageCheckpoints(crashed.jobId).at(-1)?.status, "failed_terminal");
  assert.equal(failures, 1);
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

test("v3 下游 revalidation 对运行中、终态失败和阶段重试上限 fail closed", async () => {
  const cases = [
    { label: "running", mutate: (checkpoint: { status: string }) => { checkpoint.status = "running"; }, pattern: /Downstream validation is still running: integration_review/u },
    { label: "validating", mutate: (checkpoint: { status: string }) => { checkpoint.status = "validating"; }, pattern: /Downstream validation is still running: integration_review/u },
    { label: "failed_terminal", mutate: (checkpoint: { status: string }) => { checkpoint.status = "failed_terminal"; }, pattern: /Downstream revalidation retry limit reached: integration_review/u },
    { label: "stage_attempt_limit", mutate: (checkpoint: { status: string; stageAttempt: number }) => { checkpoint.status = "completed"; checkpoint.stageAttempt = 2; }, pattern: /Downstream revalidation retry limit reached: integration_review/u },
  ] as const;
  for (const item of cases) {
    const setup = await completeV3ForRework();
    const restored = restoreV3WithMutation(setup, (snapshot) => {
      const checkpoint = (snapshot.stageCheckpoints ?? []).find((value) => value.stageId === "integration_review");
      assert.ok(checkpoint, item.label);
      item.mutate(checkpoint);
    });
    const frontend = restored.runtime.listTasks(setup.jobId).find((task) => task.profileId === "frontend_engineering")!;
    await assert.rejects(() => restored.coordinator.requestEngineeringRework(setup.jobId, frontend.id, item.label), item.pattern);
    assert.equal(restored.runtime.getTask(frontend.id)?.attempt, 1, `${item.label} 不得先推进原 Task`);
  }
});

test("v3 下游 revalidation 拒绝缺失 Task 与达到最大 attempt 的 Task", async () => {
  const completed = await completeV3ForRework();
  const missing = restoreV3WithMutation(completed, (snapshot) => {
    snapshot.tasks = snapshot.tasks.filter((task) => task.profileId !== "quality_role");
  });
  const frontendMissing = missing.runtime.listTasks(completed.jobId).find((task) => task.profileId === "frontend_engineering")!;
  await assert.rejects(() => missing.coordinator.requestEngineeringRework(completed.jobId, frontendMissing.id, "missing downstream"), /Downstream revalidation Task unavailable: quality_role/u);

  const exhausted = restoreV3WithMutation(completed, (snapshot) => {
    const task = snapshot.tasks.find((value) => value.profileId === "software_team_lead");
    assert.ok(task);
    task.attempt = task.maxAttempts;
  });
  const frontendExhausted = exhausted.runtime.listTasks(completed.jobId).find((task) => task.profileId === "frontend_engineering")!;
  await assert.rejects(() => exhausted.coordinator.requestEngineeringRework(completed.jobId, frontendExhausted.id, "exhausted downstream"), /Downstream revalidation retry limit reached: software_team_lead/u);
  assert.equal(exhausted.runtime.getTask(frontendExhausted.id)?.attempt, 1);
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
  const setup = createV3Harness({
    designConfirmed: () => true,
    execute: async (profileId) => validResult(`${profileId} ok`),
    artifacts: {
      requirementPlanPath: "D:/plans/requirement.md",
      requirementPlanHash: "requirement-hash",
      designPath: "D:/plans/design.md",
      designHash: "design-hash",
      mockPath: "D:/plans/mock.html",
    },
  });
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
  assert.match(setup.prompts.join("\n"), /D:\/plans\/requirement\.md[\s\S]*requirement-hash[\s\S]*D:\/plans\/design\.md[\s\S]*design-hash[\s\S]*D:\/plans\/mock\.html/u);
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
  artifacts?: V3RequirementContext["artifacts"];
  requestDesignRevision?: (jobId: string, feedback: string) => void | Promise<void>;
  onFailed?: (jobId: string) => void;
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
  const prompts: string[] = [];
  const options: V3ProductDeliveryCoordinatorOptions = { runStore: runs, runtimeStore: runtime, template: SOFTWARE_PRODUCT_DELIVERY_V3_TEMPLATE,
    requirement: () => ({ objective: "产品 Idea", scope: ["src/electron", "src/app-server", "tests"], nonGoals: ["越界修改"], deliverables: ["产品"], acceptanceCriteria: ["符合设计"], prompt: "confirmed requirement",
      ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts }) }),
    designConfirmed: input.designConfirmed,
    writeDesignArtifact: async () => ({ path: "D:/plans/design.md", contentHash: "a".repeat(64), generatedAt: "2026-08-24T00:00:00.000Z", mockPreview: "D:/plans/mock.html" }),
    markDesignDraft: () => undefined,
    requestDesignRevision: input.requestDesignRevision ?? (() => undefined),
    ...(input.onFailed === undefined ? {} : { onFailed: input.onFailed }),
    execute: async ({ profileId, prompt }) => {
      prompts.push(prompt);
      return {
      turnId: `v3-turn-${++turnSequence}`,
      summary: await input.execute(profileId),
      toolReceipts: input.receipts?.(profileId) ?? (profileId === "frontend_engineering" || profileId === "backend_engineering"
        ? [{ name: "write_file", ok: true }]
        : profileId === "integration_quality" || profileId === "quality_role"
          ? [{ name: "run_command", ok: true, exitCode: 0 }]
          : []),
      };
    },
  };
  const coordinator = new V3ProductDeliveryCoordinator(options);
  return { lifecycle, runs, runtime, root, jobId: job.id, coordinator, prompts, options };
}

async function completeV3ForRework() {
  const setup = createV3Harness({ designConfirmed: () => true, execute: async (profileId) => validResult(profileId) });
  for (const stage of ["product_design_ready", "mock_preview_ready", "engineering_fanout", "engineering_fanout_ready", "integration_review", "quality_review", "lead_acceptance", "lead_return_ready"] as const) {
    await setup.coordinator.advance(setup.jobId, stage);
  }
  assert.equal(setup.runtime.getJob(setup.jobId)?.status, "completed");
  return setup;
}

function restoreV3WithMutation(setup: ReturnType<typeof createV3Harness>, mutate: (snapshot: ReturnType<AgentRuntimeStore["exportSnapshot"]>) => void) {
  const snapshot = setup.runtime.exportSnapshot();
  mutate(snapshot);
  const runtime = AgentRuntimeStore.fromSnapshot(snapshot);
  const coordinator = new V3ProductDeliveryCoordinator({ ...setup.options, runtimeStore: runtime });
  return { runtime, coordinator };
}
