import assert from "node:assert/strict";
import test from "node:test";
import { LifecycleStore } from "../src/runtime/lifecycle-store.js";
import { AgentRunStore } from "../src/agents/agent-run-store.js";
import { AgentRuntimeStore } from "../src/agents/agent-runtime-store.js";
import { DEFAULT_AGENT_TEAM_CONFIG } from "../src/agents/agent-runtime.js";
import { ensureFixedSoftwareTeam } from "../src/agents/fixed-software-team.js";
import { WorkflowTeamCoordinator, type WorkflowTeamCoordinatorOptions } from "../src/execution/workflow-team-coordinator.js";
import { SOFTWARE_PRODUCT_DELIVERY_TEMPLATE } from "../src/execution/workflows/software-product-delivery.js";
import { WorkflowTemplateRegistry } from "../src/execution/workflows/workflow-template.js";
import { parseStageResult, parseStageResultWithRepair } from "../src/execution/stage-result-parser.js";
import { STAGE_RESULT_CONTRACT_VERSION } from "../src/execution/stage-contract.js";
import { classifyRuntimeFailure } from "../src/observability/runtime-failure.js";
import { RuntimeMetricsLedger, sanitizeRuntimeDiagnostic } from "../src/observability/runtime-metrics.js";
import { DynamicAgentExecutionEngine } from "../src/execution/dynamic-agent-execution-engine.js";
import { TeamWorkflowExecutionEngine } from "../src/execution/team-workflow-execution-engine.js";
import { ExecutionEngineRouter } from "../src/execution/execution-engine-router.js";
import type { ExecutionEngine, ExecutionEngineSnapshot } from "../src/execution/execution-engine.js";

const validResult = (summary: string, overrides: Record<string, unknown> = {}) => JSON.stringify({
  status: "completed", summary, deliverables: ["artifact"], evidence: ["test passed"], blockers: [],
  nextStageRecommendation: "continue", contractVersion: STAGE_RESULT_CONTRACT_VERSION, ...overrides,
});

test("Runtime failure classification and diagnostics are deterministic and redact sensitive fields", () => {
  assert.equal(classifyRuntimeFailure(Object.assign(new Error("Too many requests"), { status: 429 })), "provider_rate_limited");
  assert.equal(classifyRuntimeFailure(Object.assign(new Error("deadline exceeded"), { name: "TimeoutError" })), "provider_timeout");
  assert.equal(classifyRuntimeFailure(new Error("ECONNRESET")), "provider_network_error");
  const sanitized = sanitizeRuntimeDiagnostic({ jobId: "job-1", apiKey: "secret", nested: { cookie: "x", summary: "Bearer abcdefghijkl" } });
  assert.deepEqual(sanitized, { jobId: "job-1", nested: { summary: "[REDACTED]" } });
});

test("Runtime failure 分类覆盖显式错误码、对象状态与安全兜底", () => {
  assert.equal(classifyRuntimeFailure(new RuntimeErrorForTest("return_delivery_failed")), "return_delivery_failed");
  assert.equal(classifyRuntimeFailure({ code: "provider_network_error" }), "provider_network_error");
  assert.equal(classifyRuntimeFailure({ code: "not-a-runtime-code" }), "tool_execution_failed");
  assert.equal(classifyRuntimeFailure(Object.assign(new Error("permission denied"), { status: 400 })), "tool_permission_denied");
  assert.equal(classifyRuntimeFailure(new Error("budget exhausted")), "tool_round_limit");
  assert.equal(classifyRuntimeFailure(new Error("empty model output")), "empty_model_output");
  assert.equal(classifyRuntimeFailure(new Error("checkpoint recovery failed")), "runtime_recovery_failed");
  assert.equal(classifyRuntimeFailure(new Error("ordinary tool error")), "tool_execution_failed");
});

test("RuntimeMetricsLedger 覆盖幂等 start、计数、finish、筛选与安全序列化", () => {
  const changes: unknown[] = [];
  const ledger = new RuntimeMetricsLedger((metric) => changes.push(metric));
  const base = { jobId: "job-metrics", jobAttempt: 1, workflowVersion: "v3", stageId: "lead", stageAttempt: 2, model: "model-a" };
  const first = ledger.start(base);
  assert.equal(first.retries, 1);
  assert.equal(first.modelCalls, 0);
  assert.equal(first.toolCalls, 0);
  assert.equal(ledger.start(base).startedAt, first.startedAt);
  ledger.increment(base, "modelCalls");
  ledger.increment(base, "toolCalls");
  ledger.increment({ ...base, stageId: "missing" }, "modelCalls");
  const finished = ledger.finish(base, { primaryFailureCode: "provider_timeout", terminalStates: { task: "failed" } });
  assert.equal(finished?.modelCalls, 1);
  assert.equal(finished?.toolCalls, 1);
  assert.equal(finished?.durationMs !== undefined, true);
  assert.equal(ledger.finish({ ...base, stageId: "missing" }), undefined);
  assert.equal(ledger.list().length, 1);
  assert.equal(ledger.list("other-job").length, 0);
  const serialized = ledger.serialize();
  assert.match(serialized, /job-metrics/u);
  assert.doesNotMatch(serialized, /apiKey|Bearer|secret/u);
  assert.equal(changes.length >= 4, true);
});

class RuntimeErrorForTest extends Error {
  readonly code = "return_delivery_failed";
}

test("StageResult strict schema rejects extra fields and performs at most one tools=[] repair", async () => {
  assert.equal(parseStageResult(validResult("ok")).summary, "ok");
  assert.throws(() => parseStageResult(validResult("bad", { extra: true })), /stage-result\.v1/);
  let repairs = 0;
  const repaired = await parseStageResultWithRepair("not-json", async () => { repairs += 1; return validResult("fixed"); });
  assert.equal(repaired.repaired, true); assert.equal(repaired.result.summary, "fixed"); assert.equal(repairs, 1);
  await assert.rejects(parseStageResultWithRepair("bad", async () => { repairs += 1; return "still bad"; }), /one tools=\[\] repair/);
  assert.equal(repairs, 2);
});

test("Workflow Template rejects DAG cycles and permission widening while retaining exact versions", () => {
  const registry = new WorkflowTemplateRegistry(); registry.register(SOFTWARE_PRODUCT_DELIVERY_TEMPLATE);
  assert.equal(registry.resolve("software_product_delivery", "v2").version, "v2");
  assert.throws(() => registry.requireForExecution("software_product_delivery", "software_product_delivery", "v2", ["read_file"]), /widens Job permissions/);
  const cyclic = structuredClone(SOFTWARE_PRODUCT_DELIVERY_TEMPLATE);
  cyclic.version = "cycle"; cyclic.stages[0]!.dependsOn = ["lead"];
  assert.throws(() => registry.register(cyclic), /cycle/);
});

test("Stage checkpoints persist idempotency, local retry, terminal cancel and evidence de-duplication", () => {
  const store = new AgentRuntimeStore(() => "2026-08-14T00:00:00.000Z");
  const job = store.createJob({ threadId: "thread", rootTurnId: "turn", rootRunId: "run", configSnapshot: DEFAULT_AGENT_TEAM_CONFIG,
    executionKind: "software_product_delivery", workflowVersion: "software_product_delivery_v2" });
  const task = store.createTask({ jobId: job.id, rootRunId: "run", ownerRunId: "worker", profileId: "coder", title: "t", objective: "o",
    scope: { allowedPaths: [], deniedPaths: [], nonGoals: [] }, requiredOutputs: [], acceptanceCriteria: [], fileClaims: [], maxAttempts: 2 });
  const first = store.beginStage(job.id, "engineering", 2); store.setStageStatus(first.idempotencyKey, "failed_retryable", "provider_timeout");
  const second = store.beginStage(job.id, "engineering", 2);
  assert.equal(second.stageAttempt, 2); assert.notEqual(second.idempotencyKey, first.idempotencyKey);
  const evidenceInput = { jobId: job.id, taskId: task.id, runId: "worker", kind: "artifact" as const, summary: "done", producer: "worker" as const,
    verdict: "supported" as const, idempotencyKey: `${second.idempotencyKey}:evidence` };
  assert.equal(store.addEvidence(evidenceInput).id, store.addEvidence(evidenceInput).id);
  const restored = AgentRuntimeStore.fromSnapshot(store.exportSnapshot());
  assert.equal(restored.listStageCheckpoints(job.id).length, 2);
  restored.cancelJob(job.id);
  assert.equal(restored.listStageCheckpoints(job.id).at(-1)?.status, "failed_terminal");
});

test("V2 normal team chain skips forced Product rework and completes in five model calls", async () => {
  const setup = createTeamHarness(() => validResult("ok"));
  assert.equal((await setup.coordinator.advance(setup.jobId, "ready_first_return")).stage, "first_return_ready");
  assert.equal((await setup.coordinator.advance(setup.jobId, "first_return_ready")).stage, "engineering_ready");
  assert.equal(setup.runtime.listTasks(setup.jobId).find((item) => item.profileId === "product_role")?.attempt, 1);
  assert.equal((await setup.coordinator.advance(setup.jobId, "engineering_ready")).stage, "engineering_return_ready");
  assert.equal((await setup.coordinator.advance(setup.jobId, "engineering_return_ready")).stage, "quality_ready");
  assert.equal((await setup.coordinator.advance(setup.jobId, "quality_ready")).stage, "quality_return_ready");
  assert.equal((await setup.coordinator.advance(setup.jobId, "quality_return_ready")).stage, "lead_return_ready");
  assert.equal((await setup.coordinator.advance(setup.jobId, "lead_return_ready")).stage, "completed");
  assert.equal(setup.calls.length, 5);
  assert.equal(setup.calls.filter((item) => item.profileId === "product_role").length, 1);
  assert.equal(setup.runtime.listReturns(setup.jobId).every((item) => item.status === "consumed"), true);
  assert.equal(setup.runtime.listTasks(setup.jobId).some((item) => ["queued", "running"].includes(item.status)), false);
  assert.equal(setup.runs.listForJob(setup.jobId).some((item) => ["queued", "running", "waiting_children", "resuming"].includes(item.status)), false);
});

test("TeamWorkflow start provisions and drives the durable workflow without manual stage advance", async () => {
  const setup = createTeamHarness(() => validResult("ok"));
  let provisions = 0;
  const engine = new TeamWorkflowExecutionEngine(setup.runtime, setup.coordinator, () => {
    provisions += 1;
  });
  const job = setup.runtime.getJob(setup.jobId)!;

  await engine.start({
    jobId: job.id,
    threadId: job.threadId,
    rootRunId: job.rootRunId,
    executionKind: job.executionKind,
    workflowVersion: job.workflowVersion,
  });
  await engine.start({
    jobId: job.id,
    threadId: job.threadId,
    rootRunId: job.rootRunId,
    executionKind: job.executionKind,
    workflowVersion: job.workflowVersion,
  });

  assert.equal(provisions, 2);
  assert.equal(setup.runtime.getJob(setup.jobId)?.status, "completed");
  assert.equal(setup.calls.length, 5);
  assert.equal(setup.calls.filter((item) => item.profileId === "orchestrator").length, 1);
});

test("Invalid JSON and failed format repair do not pollute Evidence, Board or Return and remain locally retryable", async () => {
  const setup = createTeamHarness(() => "not-json");
  await assert.rejects(setup.coordinator.advance(setup.jobId, "ready_first_return"), /one tools=\[\] repair/);
  assert.equal(setup.calls.length, 2);
  assert.equal(setup.calls[1]?.formatRepair, true);
  assert.deepEqual(setup.calls[1]?.allowedTools, []);
  assert.equal(setup.runtime.listTasks(setup.jobId).flatMap((task) => setup.runtime.listEvidence(task.id)).length, 0);
  assert.equal(setup.runtime.listBoard(setup.jobId).length, 0);
  assert.equal(setup.runtime.listReturns(setup.jobId).length, 0);
  assert.equal(setup.runtime.listStageCheckpoints(setup.jobId)[0]?.status, "failed_retryable");
});

test("V2 Product business failure reuses original Task and Thread for one bounded rework", async () => {
  let productCalls = 0;
  const setup = createTeamHarness((profileId) => profileId === "product_role" && ++productCalls === 1
    ? validResult("missing", { deliverables: [] }) : validResult("ok"));
  const productThread = setup.runs.listForJob(setup.jobId).find((item) => item.agentProfileId === "product_role")!.threadId;
  await setup.coordinator.advance(setup.jobId, "ready_first_return");
  assert.equal((await setup.coordinator.advance(setup.jobId, "first_return_ready")).stage, "rework");
  assert.equal((await setup.coordinator.advance(setup.jobId, "rework")).stage, "second_return_ready");
  assert.equal((await setup.coordinator.advance(setup.jobId, "second_return_ready")).stage, "engineering_ready");
  const productTasks = setup.runtime.listTasks(setup.jobId).filter((item) => item.profileId === "product_role");
  assert.equal(productTasks.length, 1); assert.equal(productTasks[0]?.attempt, 2);
  assert.equal(setup.runs.listForJob(setup.jobId).find((item) => item.agentProfileId === "product_role")?.threadId, productThread);
});

test("ExecutionEngineRouter uniquely routes dynamic and team kinds through one shared Runtime store", () => {
  const setup = createTeamHarness(() => validResult("ok"));
  const router = new ExecutionEngineRouter([
    new DynamicAgentExecutionEngine(setup.runtime),
    new TeamWorkflowExecutionEngine(setup.runtime, setup.coordinator, () => undefined),
  ]);
  assert.equal(router.route("analysis_only").id, "dynamic_agent");
  assert.equal(router.route("software_change").id, "dynamic_agent");
  assert.equal(router.route("software_product_delivery").id, "team_workflow");
});

test("ExecutionEngineRouter 对启动、反馈和 Snapshot 身份边界统一 fail closed", async () => {
  let starts = 0;
  let feedbacks = 0;
  let snapshot: ExecutionEngineSnapshot = { engine: "dynamic", jobId: "job-1", terminal: false };
  const dynamic: ExecutionEngine = {
    id: "dynamic",
    control: "engine",
    supports: (kind) => kind !== "software_product_delivery",
    start: async () => { starts += 1; return { output: "started" }; },
    resume: async () => ({}),
    cancel: async () => undefined,
    recover: async () => undefined,
    provideFeedback: async () => { feedbacks += 1; return true; },
    snapshot: () => snapshot,
  };
  const team: ExecutionEngine = {
    ...dynamic,
    id: "team",
    control: "workflow",
    supports: (kind) => kind === "software_product_delivery",
    snapshot: (jobId) => ({ engine: "team", jobId, stage: "product_design_ready", terminal: false }),
  };
  const router = new ExecutionEngineRouter([dynamic, team]);
  const context = {
    jobId: "job-1", threadId: "thread-1", rootRunId: "run-1",
    executionKind: "software_change" as const, workflowVersion: "dynamic_v1",
    drive: async () => ({}),
  };

  assert.deepEqual(await router.start(context), { output: "started" });
  assert.deepEqual(await router.start({
    jobId: "job-1", threadId: "thread-1", rootRunId: "run-1",
    executionKind: "software_change", workflowVersion: "dynamic_v1",
  }), { output: "started" });
  assert.equal(starts, 2);
  for (const malformed of [
    null,
    { ...context, jobId: " " },
    { ...context, threadId: "" },
    { ...context, rootRunId: "" },
    { ...context, executionKind: "unknown" },
    { ...context, workflowVersion: " " },
    { ...context, drive: "not-a-function" },
    { ...context, extra: true },
  ]) assert.throws(() => router.start(malformed as never), /Invalid execution context/u);
  assert.equal(starts, 2, "invalid contexts must not reach an engine");

  assert.equal(await router.provideFeedback("software_change", "job-1", { turnId: "turn-2", text: "continue" }), true);
  for (const malformed of [null, {}, { turnId: "", text: "continue" }, { turnId: "turn-2", text: " " },
    { turnId: "turn-2", text: "continue", extra: true }]) {
    assert.throws(() => router.provideFeedback("software_change", "job-1", malformed as never), /Invalid execution feedback/u);
  }
  assert.equal(feedbacks, 1, "invalid feedback must not reach an engine");

  assert.deepEqual(router.snapshot("software_change", "job-1"), snapshot);
  for (const malformed of [
    null,
    { engine: "wrong", jobId: "job-1" },
    { engine: "dynamic", jobId: "wrong" },
    { engine: "dynamic", jobId: "job-1", terminal: "false" },
    { engine: "dynamic", jobId: "job-1", phase: " " },
    { engine: "dynamic", jobId: "job-1", deadlineAt: "not-a-date" },
    { engine: "dynamic", jobId: "job-1", extra: true },
  ]) {
    snapshot = malformed as never;
    assert.throws(() => router.snapshot("software_change", "job-1"), /Invalid execution engine snapshot/u);
  }
});

test("V2 重启从已持久化 Lead 与最终交付证据续提交流程，绝不重跑模型", async () => {
  const setup = createTeamHarness(() => validResult("ok"));
  await setup.coordinator.advance(setup.jobId, "ready_first_return");
  await setup.coordinator.advance(setup.jobId, "first_return_ready");
  await setup.coordinator.advance(setup.jobId, "engineering_ready");
  await setup.coordinator.advance(setup.jobId, "engineering_return_ready");
  await setup.coordinator.advance(setup.jobId, "quality_ready");
  const qualityTask = setup.runtime.listTasks(setup.jobId).find((item) => item.profileId === "quality_role")!;
  const leadRun = setup.runs.listForJob(setup.jobId).find((item) => item.agentProfileId === "software_team_lead")!;
  const rootRun = setup.runs.listForJob(setup.jobId).find((item) => item.id === setup.runtime.getJob(setup.jobId)?.rootRunId)!;

  const lead = setup.runtime.beginStage(setup.jobId, "lead", 2);
  setup.runtime.addEvidence({ jobId: setup.jobId, taskId: qualityTask.id, runId: leadRun.id, kind: "review",
    summary: validResult("persisted lead"), producer: "reviewer", verdict: "passed",
    idempotencyKey: `${lead.idempotencyKey}:evidence`, jobAttempt: 1,
    workflowVersion: "software_product_delivery_v2", stageId: "lead", stageAttempt: lead.stageAttempt });
  assert.equal((await setup.coordinator.advance(setup.jobId, "quality_return_ready")).stage, "lead_return_ready");
  assert.equal(setup.calls.length, 3, "Product/Engineering/Quality 之外不得重跑 Lead 模型");

  const delivery = setup.runtime.beginStage(setup.jobId, "return_god", 2);
  setup.runtime.setStageStatus(delivery.idempotencyKey, "validating");
  setup.runtime.addEvidence({ jobId: setup.jobId, taskId: qualityTask.id, runId: rootRun.id, kind: "summary",
    summary: "persisted final answer", producer: "runtime", verdict: "supported",
    idempotencyKey: `${delivery.idempotencyKey}:evidence`, jobAttempt: 1,
    workflowVersion: "software_product_delivery_v2", stageId: "return_god", stageAttempt: delivery.stageAttempt });
  assert.equal((await setup.coordinator.advance(setup.jobId, "lead_return_ready")).stage, "completed");
  assert.equal(setup.calls.length, 3, "已有最终证据时不得再次调用 God 模型");
  assert.equal(setup.runs.get(rootRun.id)?.result?.summary, "persisted final answer");
});

test("V2 完成态 Checkpoint 缺少配套证据时 fail closed", async () => {
  const leadMissing = createTeamHarness(() => validResult("ok"));
  await leadMissing.coordinator.advance(leadMissing.jobId, "ready_first_return");
  await leadMissing.coordinator.advance(leadMissing.jobId, "first_return_ready");
  await leadMissing.coordinator.advance(leadMissing.jobId, "engineering_ready");
  await leadMissing.coordinator.advance(leadMissing.jobId, "engineering_return_ready");
  await leadMissing.coordinator.advance(leadMissing.jobId, "quality_ready");
  const leadCheckpoint = leadMissing.runtime.beginStage(leadMissing.jobId, "lead", 2);
  leadMissing.runtime.setStageStatus(leadCheckpoint.idempotencyKey, "validating");
  leadMissing.runtime.setStageStatus(leadCheckpoint.idempotencyKey, "completed");
  await assert.rejects(
    leadMissing.coordinator.advance(leadMissing.jobId, "quality_return_ready"),
    /Completed Lead stage has no recoverable evidence/,
  );
  assert.equal(leadMissing.runtime.getJob(leadMissing.jobId)?.status, "failed");

  const productMissing = createTeamHarness(() => validResult("ok"));
  const productRun = productMissing.runs.listForJob(productMissing.jobId).find((item) => item.agentProfileId === "product_role")!;
  const rootRunId = productMissing.runtime.getJob(productMissing.jobId)!.rootRunId;
  const task = productMissing.runtime.createTask({ jobId: productMissing.jobId, rootRunId, ownerRunId: productRun.id,
    profileId: "product_role", title: "product", objective: "product", scope: { allowedPaths: [], deniedPaths: [], nonGoals: [] },
    requiredOutputs: [], acceptanceCriteria: [], fileClaims: [], maxAttempts: 2, status: "ready" });
  productMissing.runs.setTaskId(productRun.id, task.id);
  const productCheckpoint = productMissing.runtime.beginStage(productMissing.jobId, "product", 2);
  productMissing.runtime.setStageStatus(productCheckpoint.idempotencyKey, "validating");
  productMissing.runtime.setStageStatus(productCheckpoint.idempotencyKey, "completed");
  await assert.rejects(
    productMissing.coordinator.advance(productMissing.jobId, "ready_first_return"),
    /Completed product stage has no recoverable evidence/,
  );
  assert.equal(productMissing.runtime.getTask(task.id)?.status, "failed");
});

test("V2 恢复模型响应在证据提交后确认 invocation，提交前钩子只执行一次", async () => {
  const commits: string[] = [];
  const before: string[] = [];
  const setup = createTeamHarness(() => validResult("fallback"), {
    recoverModelExecution: (input) => input.stageId === "product"
      ? { turnId: "recovered-turn", summary: validResult("recovered product"), invocationId: "invocation-product" }
      : undefined,
    commitRecoveredModelExecution: (invocationId, targetCommitKey) => commits.push(`${invocationId}:${targetCommitKey}`),
    beforeStageResultCommit: (input) => { before.push(`${input.stageId}:${input.stageAttempt}:${input.result.summary}`); },
  });

  assert.equal((await setup.coordinator.advance(setup.jobId, "ready_first_return")).stage, "first_return_ready");
  assert.deepEqual(before, ["product:1:recovered product"]);
  assert.equal(commits.length, 1);
  assert.match(commits[0]!, /^invocation-product:.*:evidence$/);
  assert.equal(setup.calls.length, 0);
});

test("V2 Lead 与 God 的已记录模型响应只补提交回执，不产生第二次调用", async () => {
  const commits: string[] = [];
  const setup = createTeamHarness(() => validResult("worker ok"), {
    recoverModelExecution: (input) => input.stageId === "lead"
      ? { turnId: "lead-recovered", summary: validResult("lead recovered"), invocationId: "inv-lead" }
      : input.stageId === "return_god"
        ? { turnId: "god-recovered", summary: "final recovered", invocationId: "inv-god" }
        : undefined,
    commitRecoveredModelExecution: (invocationId, targetCommitKey) => commits.push(`${invocationId}:${targetCommitKey}`),
  });
  const job = setup.runtime.getJob(setup.jobId)!;
  const engine = new TeamWorkflowExecutionEngine(setup.runtime, setup.coordinator, () => undefined);
  await engine.start({ jobId: job.id, threadId: job.threadId, rootRunId: job.rootRunId,
    executionKind: job.executionKind, workflowVersion: job.workflowVersion });
  assert.equal(setup.runtime.getJob(job.id)?.status, "completed");
  assert.equal(setup.calls.length, 3, "仅 Product、Engineering、Quality 是新调用");
  assert.deepEqual(commits.map((item) => item.split(":", 1)[0]), ["inv-lead", "inv-god"]);
});

test("V2 已存在 Worker Evidence 时直接重建 Return，模型工具计数不影响业务提交", async () => {
  const resumed = createTeamHarness(() => validResult("must not run"));
  const productRun = resumed.runs.listForJob(resumed.jobId).find((item) => item.agentProfileId === "product_role")!;
  const task = resumed.runtime.createTask({ jobId: resumed.jobId, rootRunId: resumed.runtime.getJob(resumed.jobId)!.rootRunId,
    ownerRunId: productRun.id, profileId: "product_role", title: "product", objective: "product",
    scope: { allowedPaths: [], deniedPaths: [], nonGoals: [] }, requiredOutputs: [], acceptanceCriteria: [], fileClaims: [], maxAttempts: 2, status: "ready" });
  resumed.runs.setTaskId(productRun.id, task.id);
  const checkpoint = resumed.runtime.beginStage(resumed.jobId, "product", 2);
  resumed.runtime.addEvidence({ jobId: resumed.jobId, taskId: task.id, runId: productRun.id, kind: "summary",
    summary: validResult("persisted worker"), producer: "worker", verdict: "supported",
    idempotencyKey: `${checkpoint.idempotencyKey}:evidence`, jobAttempt: 1,
    workflowVersion: "software_product_delivery_v2", stageId: "product", stageAttempt: checkpoint.stageAttempt });
  assert.equal((await resumed.coordinator.advance(resumed.jobId, "ready_first_return")).stage, "first_return_ready");
  assert.equal(resumed.calls.length, 0);

  const countedCalls: string[] = [];
  const counted = createTeamHarness(() => validResult("ok"), {
    execute: async (input) => {
      countedCalls.push(input.profileId);
      return { turnId: `counted-${countedCalls.length}`,
        summary: input.profileId === "orchestrator" ? "final counted" : validResult("ok"),
        toolCalls: input.profileId === "orchestrator" ? 2 : 0 };
    },
  });
  const countedJob = counted.runtime.getJob(counted.jobId)!;
  await new TeamWorkflowExecutionEngine(counted.runtime, counted.coordinator, () => undefined).start({
    jobId: countedJob.id, threadId: countedJob.threadId, rootRunId: countedJob.rootRunId,
    executionKind: countedJob.executionKind, workflowVersion: countedJob.workflowVersion,
  });
  assert.equal(counted.runtime.getJob(counted.jobId)?.status, "completed");
  assert.equal(countedCalls.at(-1), "orchestrator");
});

test("V2 blocked 任务仅在同一 Turn 的真实反馈可恢复，丢失反馈则拒绝续跑", async () => {
  const blocked = validResult("need decision", { status: "blocked", blockers: ["decision"], nextStageRecommendation: "block" });
  const setup = createTeamHarness(() => blocked);
  await setup.coordinator.advance(setup.jobId, "ready_first_return");
  await setup.coordinator.advance(setup.jobId, "first_return_ready");
  assert.deepEqual(setup.coordinator.recoveryDecision(setup.jobId), { kind: "wait", reason: "feedback" });
  assert.equal(await setup.coordinator.provideFeedback(setup.jobId, { turnId: "feedback-turn", text: "use option A" }), true);
  await assert.rejects(
    setup.coordinator.advance(setup.jobId, "rework"),
    /Persisted user feedback is unavailable/,
  );
});

test("V2 无模型恢复只接受已持久化 Lead 证据或可恢复调用", async () => {
  const setup = createTeamHarness(() => validResult("ok"));
  assert.equal(setup.coordinator.canAdvanceWithoutModel("missing-job", "quality_return_ready"), true);
  assert.equal(setup.coordinator.canAdvanceWithoutModel(setup.jobId, "quality_return_ready"), false);
  const task = setup.runtime.createTask({ jobId: setup.jobId, rootRunId: setup.runtime.getJob(setup.jobId)!.rootRunId,
    ownerRunId: "quality-owner", profileId: "quality_role", title: "quality", objective: "quality",
    scope: { allowedPaths: [], deniedPaths: [], nonGoals: [] }, requiredOutputs: [], acceptanceCriteria: [], fileClaims: [], maxAttempts: 2 });
  setup.runtime.createReturn({ jobId: setup.jobId, rootRunId: setup.runtime.getJob(setup.jobId)!.rootRunId,
    parentRunId: "root", childRunId: "lead", taskId: task.id, sequence: 4,
    result: { status: "completed", summary: validResult("lead"), evidenceIds: [], boardEntryIds: [] },
    idempotencyKey: "lead-ready", jobAttempt: 1, workflowVersion: "software_product_delivery_v2", stageId: "lead", stageAttempt: 1 });
  assert.equal(setup.coordinator.canAdvanceWithoutModel(setup.jobId, "quality_return_ready"), true);

  const recoverable = createTeamHarness(() => validResult("fallback"), {
    recoverModelExecution: (input) => input.stageId === "lead"
      ? { turnId: "lead-turn", summary: validResult("lead recovered"), invocationId: "lead-invocation" }
      : undefined,
  });
  recoverable.runtime.beginStage(recoverable.jobId, "lead", 2);
  assert.equal(recoverable.coordinator.canAdvanceWithoutModel(recoverable.jobId, "quality_return_ready"), true);

  const persisted = createTeamHarness(() => validResult("fallback"));
  const persistedTask = persisted.runtime.createTask({ jobId: persisted.jobId, rootRunId: persisted.runtime.getJob(persisted.jobId)!.rootRunId,
    ownerRunId: "quality", profileId: "quality_role", title: "quality", objective: "quality",
    scope: { allowedPaths: [], deniedPaths: [], nonGoals: [] }, requiredOutputs: [], acceptanceCriteria: [], fileClaims: [], maxAttempts: 2 });
  const persistedLead = persisted.runtime.beginStage(persisted.jobId, "lead", 2);
  persisted.runtime.setStageStatus(persistedLead.idempotencyKey, "validating");
  persisted.runtime.setStageStatus(persistedLead.idempotencyKey, "completed");
  persisted.runtime.addEvidence({ jobId: persisted.jobId, taskId: persistedTask.id, runId: "lead", kind: "review",
    summary: validResult("persisted lead"), producer: "reviewer", verdict: "passed",
    idempotencyKey: `${persistedLead.idempotencyKey}:evidence`, jobAttempt: 1,
    workflowVersion: "software_product_delivery_v2", stageId: "lead", stageAttempt: persistedLead.stageAttempt });
  assert.equal(persisted.coordinator.canAdvanceWithoutModel(persisted.jobId, "quality_return_ready"), true);
});

test("TeamWorkflow Engine 的取消、租约、版本与并发边界统一 fail closed", async () => {
  const setup = createTeamHarness(() => validResult("ok"));
  let persisted = 0;
  const engine = new TeamWorkflowExecutionEngine(setup.runtime, setup.coordinator, () => undefined,
    () => undefined, undefined, () => { persisted += 1; });
  await engine.cancel(setup.jobId);
  assert.equal(setup.runtime.getJob(setup.jobId)?.status, "cancelled");
  assert.equal(persisted, 1);
  assert.deepEqual(engine.snapshot("missing-job"), { engine: "team_workflow", jobId: "missing-job", stage: "completed", terminal: true });
  await assert.rejects(() => engine.requestEngineeringRework(setup.jobId, "task", "reason"), /requires a v3 Job/);

  const unsupportedRuntime = new AgentRuntimeStore();
  const unsupported = unsupportedRuntime.createJob({ threadId: "thread-u", rootTurnId: "turn-u", rootRunId: "run-u",
    configSnapshot: DEFAULT_AGENT_TEAM_CONFIG, executionKind: "analysis_only", workflowVersion: "dynamic_v1" });
  const unsupportedEngine = new TeamWorkflowExecutionEngine(unsupportedRuntime, setup.coordinator, () => undefined);
  await assert.rejects(() => unsupportedEngine.resume(unsupported.id), /version is unsupported/);

  const v3Runtime = new AgentRuntimeStore();
  const v3 = v3Runtime.createJob({ threadId: "thread-v3", rootTurnId: "turn-v3", rootRunId: "run-v3",
    configSnapshot: DEFAULT_AGENT_TEAM_CONFIG, executionKind: "software_product_delivery", workflowVersion: "software_product_delivery_v3" });
  const missingV3 = new TeamWorkflowExecutionEngine(v3Runtime, setup.coordinator, () => undefined);
  await assert.rejects(() => missingV3.resume(v3.id), /V3 Workflow coordinator is unavailable/);

  const waitingLease = { runWithJobLease: async () => ({ status: "waiting" as const }) };
  const waitingEngine = new TeamWorkflowExecutionEngine(setup.runtime, setup.coordinator, () => undefined,
    () => undefined, waitingLease as never);
  assert.equal(await waitingEngine.provideFeedback(setup.jobId, { turnId: "turn", text: "feedback" }), false);
  assert.deepEqual(await waitingEngine.advance(setup.jobId, "completed"), { stage: "completed", changed: false });
});

test("TeamWorkflow Engine 合并并发 drive，并对无进展与转换上限止损", async () => {
  const runtime = new AgentRuntimeStore();
  const job = runtime.createJob({ threadId: "thread-drive", rootTurnId: "turn-drive", rootRunId: "run-drive",
    configSnapshot: DEFAULT_AGENT_TEAM_CONFIG, executionKind: "software_product_delivery", workflowVersion: "software_product_delivery_v2" });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let advances = 0;
  const blockingCoordinator = {
    recoverPersistedCheckpoints: () => 0,
    recoveryDecision: () => ({ kind: "resume_stage" as const, stage: "ready_first_return" as const }),
    canAdvanceWithoutModel: () => true,
    getStage: () => "ready_first_return" as const,
    advance: async () => { advances += 1; await gate; return { stage: "ready_first_return" as const, changed: false }; },
  } as unknown as WorkflowTeamCoordinator;
  const engine = new TeamWorkflowExecutionEngine(runtime, blockingCoordinator, () => undefined);
  const first = engine.resume(job.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(engine.isActive(job.id), true);
  await engine.resume(job.id);
  assert.equal(advances, 1);
  release(); await first;
  assert.equal(engine.isActive(job.id), false);

  let stage: "ready_first_return" | "first_return_ready" = "ready_first_return";
  const loopingCoordinator = {
    recoverPersistedCheckpoints: () => 0,
    recoveryDecision: () => ({ kind: "resume_stage" as const, stage }),
    canAdvanceWithoutModel: () => true,
    getStage: () => stage,
    advance: async () => { stage = stage === "ready_first_return" ? "first_return_ready" : "ready_first_return"; return { stage, changed: true }; },
  } as unknown as WorkflowTeamCoordinator;
  const looping = new TeamWorkflowExecutionEngine(runtime, loopingCoordinator, () => undefined);
  await assert.rejects(() => looping.resume(job.id), /exceeded 32 transitions/);
});

function createTeamHarness(
  result: (profileId: string) => string,
  overrides: Partial<Omit<WorkflowTeamCoordinatorOptions, "runStore" | "runtimeStore" | "template" | "requirement">> = {},
) {
  const lifecycle = new LifecycleStore(); const thread = lifecycle.createThread(); const turn = lifecycle.createTurn(thread.id);
  const runs = new AgentRunStore(); const runtime = new AgentRuntimeStore();
  const root = runs.ensureRoot(thread.id, turn.id, "orchestrator");
  const job = runtime.createJob({ threadId: thread.id, rootTurnId: turn.id, rootRunId: root.id, configSnapshot: DEFAULT_AGENT_TEAM_CONFIG,
    executionKind: "software_product_delivery", workflowVersion: "software_product_delivery_v2" });
  ensureFixedSoftwareTeam(lifecycle, runs, root);
  const calls: Array<{ profileId: string; threadId: string; formatRepair: boolean; allowedTools: string[] }> = [];
  const defaultExecute: WorkflowTeamCoordinatorOptions["execute"] = async (input) => {
    calls.push(input);
    return { turnId: `turn-${calls.length}`, summary: input.profileId === "orchestrator" ? "final answer" : result(input.profileId) };
  };
  const coordinator = new WorkflowTeamCoordinator({ runStore: runs, runtimeStore: runtime, template: SOFTWARE_PRODUCT_DELIVERY_TEMPLATE,
    requirement: () => ({ objective: "generic feature", scope: ["src/**"], nonGoals: ["unrelated UI"], deliverables: ["code"], acceptanceCriteria: ["tests pass"], prompt: "confirmed requirement" }),
    ...overrides,
    execute: overrides.execute ?? defaultExecute,
  });
  return { lifecycle, runs, runtime, coordinator, jobId: job.id, calls };
}
