import assert from "node:assert/strict";
import test from "node:test";
import { LifecycleStore } from "../src/runtime/lifecycle-store.js";
import { AgentRunStore } from "../src/agents/agent-run-store.js";
import { AgentRuntimeStore } from "../src/agents/agent-runtime-store.js";
import { DEFAULT_AGENT_TEAM_CONFIG } from "../src/agents/agent-runtime.js";
import { ensureFixedSoftwareTeam } from "../src/agents/fixed-software-team.js";
import { WorkflowTeamCoordinator } from "../src/execution/workflow-team-coordinator.js";
import { SOFTWARE_PRODUCT_DELIVERY_TEMPLATE } from "../src/execution/workflows/software-product-delivery.js";
import { WorkflowTemplateRegistry } from "../src/execution/workflows/workflow-template.js";
import { parseStageResult, parseStageResultWithRepair } from "../src/execution/stage-result-parser.js";
import { STAGE_RESULT_CONTRACT_VERSION } from "../src/execution/stage-contract.js";
import { classifyRuntimeFailure } from "../src/observability/runtime-failure.js";
import { sanitizeRuntimeDiagnostic } from "../src/observability/runtime-metrics.js";
import { DynamicAgentExecutionEngine } from "../src/execution/dynamic-agent-execution-engine.js";
import { TeamWorkflowExecutionEngine } from "../src/execution/team-workflow-execution-engine.js";
import { ExecutionEngineRouter } from "../src/execution/execution-engine-router.js";

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

function createTeamHarness(result: (profileId: string) => string) {
  const lifecycle = new LifecycleStore(); const thread = lifecycle.createThread(); const turn = lifecycle.createTurn(thread.id);
  const runs = new AgentRunStore(); const runtime = new AgentRuntimeStore();
  const root = runs.ensureRoot(thread.id, turn.id, "orchestrator");
  const job = runtime.createJob({ threadId: thread.id, rootTurnId: turn.id, rootRunId: root.id, configSnapshot: DEFAULT_AGENT_TEAM_CONFIG,
    executionKind: "software_product_delivery", workflowVersion: "software_product_delivery_v2" });
  ensureFixedSoftwareTeam(lifecycle, runs, root);
  const calls: Array<{ profileId: string; threadId: string; formatRepair: boolean; allowedTools: string[] }> = [];
  const coordinator = new WorkflowTeamCoordinator({ runStore: runs, runtimeStore: runtime, template: SOFTWARE_PRODUCT_DELIVERY_TEMPLATE,
    requirement: () => ({ objective: "generic feature", scope: ["src/**"], nonGoals: ["unrelated UI"], deliverables: ["code"], acceptanceCriteria: ["tests pass"], prompt: "confirmed requirement" }),
    execute: async (input) => { calls.push(input); return { turnId: `turn-${calls.length}`, summary: input.profileId === "orchestrator" ? "final answer" : result(input.profileId) }; },
  });
  return { lifecycle, runs, runtime, coordinator, jobId: job.id, calls };
}
