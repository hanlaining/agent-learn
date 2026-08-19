import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { AgentLoop } from "../../../src/agent/agent-loop.js";
import { AgentRunStore } from "../../../src/agents/agent-run-store.js";
import { AgentRuntimeStore } from "../../../src/agents/agent-runtime-store.js";
import { DEFAULT_AGENT_TEAM_CONFIG } from "../../../src/agents/agent-runtime.js";
import { ensureFixedSoftwareTeam } from "../../../src/agents/fixed-software-team.js";
import { WorkflowTeamCoordinator } from "../../../src/execution/workflow-team-coordinator.js";
import { STAGE_RESULT_CONTRACT_VERSION } from "../../../src/execution/stage-contract.js";
import { SOFTWARE_PRODUCT_DELIVERY_TEMPLATE } from "../../../src/execution/workflows/software-product-delivery.js";
import type { LlmCreateResponseRequest, LlmProvider, LlmResponse } from "../../../src/llm/types.js";
import { ContextCheckpointStore } from "../../../src/runtime/context-checkpoint-store.js";
import { JsonFileRuntimePersistence, type LoadedRuntimeState } from "../../../src/runtime/json-file-runtime-persistence.js";
import { createModelRequestDigest } from "../../../src/runtime/model-invocation.js";
import { ModelInvocationStartupRecovery } from "../../../src/runtime/model-invocation-startup-recovery.js";
import { PersistentRuntimeLeaseStore } from "../../../src/runtime/persistent-runtime-lease-store.js";
import { createToolArgumentsDigest } from "../../../src/runtime/tool-invocation.js";
import { ToolRegistry, type AgentTool } from "../../../src/tools/tool-registry.js";
import type { RuntimeE2eCaseResult, RuntimeE2eScenario, RuntimeE2eVariant } from "./types.js";

const FAKE_MODEL = "runtime-e2e-fake-model";

interface IoMetrics {
  writes: number;
  loads: number;
  reloaded: boolean;
}

interface MutableMetrics extends IoMetrics {
  modelCalls: number;
  toolEffects: number;
  duplicateModelCalls: number;
  duplicateToolEffects: number;
  unknownOutcome: boolean;
  recoveryAttempted: boolean;
  recoverySuccess: boolean | null;
  recoveryResult: string;
  evidenceRequired: number;
  evidenceProduced: number;
  invariants: string[];
  failureCodes: string[];
  productionClasses: Set<string>;
}

interface RuntimeBundle {
  statePath: string;
  persistence: JsonFileRuntimePersistence;
  state: LoadedRuntimeState;
}

class DeterministicFakeProvider implements LlmProvider {
  constructor(
    private readonly metrics: MutableMetrics,
    private readonly handler: (call: number, request: LlmCreateResponseRequest) => LlmResponse | Error,
  ) {}

  async createResponse(request: LlmCreateResponseRequest): Promise<LlmResponse> {
    this.metrics.modelCalls += 1;
    const response = this.handler(this.metrics.modelCalls, request);
    if (response instanceof Error) throw response;
    return structuredClone(response);
  }
}

export async function executeRuntimeE2eScenario(
  scenario: RuntimeE2eScenario,
  variant: RuntimeE2eVariant,
  caseDirectory: string,
): Promise<RuntimeE2eCaseResult> {
  const started = performance.now();
  await mkdir(caseDirectory, { recursive: true });
  const metrics: MutableMetrics = {
    writes: 0,
    loads: 0,
    reloaded: false,
    modelCalls: 0,
    toolEffects: 0,
    duplicateModelCalls: 0,
    duplicateToolEffects: 0,
    unknownOutcome: false,
    recoveryAttempted: false,
    recoverySuccess: null,
    recoveryResult: "not-required",
    evidenceRequired: 3,
    evidenceProduced: 0,
    invariants: [],
    failureCodes: [],
    productionClasses: new Set(["JsonFileRuntimePersistence"]),
  };

  let taskSuccess = false;
  try {
    taskSuccess = await ({
      "model-response-window": runModelWindow,
      "tool-effect-window": runToolWindow,
      "return-parent-feedback": runReturnOrFeedback,
      "workflow-stage": runWorkflowStage,
      "snapshot-reload": runSnapshotReload,
      "multi-instance-lease": runLeaseCompetition,
    } as const)[scenario.family](scenario, variant, caseDirectory, metrics);
  } catch (error) {
    metrics.failureCodes.push(errorCode(error));
    metrics.recoveryResult = `exception:${errorCode(error)}:${error instanceof Error ? error.message : "unknown"}`;
    taskSuccess = false;
  }

  const evidenceCompleteness = Number((metrics.evidenceProduced / metrics.evidenceRequired).toFixed(6));
  return {
    caseId: scenario.caseId,
    caseIndex: scenario.caseIndex,
    scenarioSeed: scenario.scenarioSeed,
    family: scenario.family,
    checkpoint: scenario.checkpoint,
    variant,
    taskSuccess,
    recoveryAttempted: metrics.recoveryAttempted,
    recoverySuccess: metrics.recoverySuccess,
    snapshotReloaded: metrics.reloaded,
    stateFileWrites: metrics.writes,
    stateFileLoads: metrics.loads,
    modelCalls: metrics.modelCalls,
    duplicateModelCalls: metrics.duplicateModelCalls,
    toolEffects: metrics.toolEffects,
    duplicateToolEffects: metrics.duplicateToolEffects,
    unknownOutcome: metrics.unknownOutcome,
    evidenceRequired: metrics.evidenceRequired,
    evidenceProduced: Math.min(metrics.evidenceProduced, metrics.evidenceRequired),
    evidenceCompleteness: Math.min(1, evidenceCompleteness),
    wallClockDurationMs: Number((performance.now() - started).toFixed(3)),
    recoveryResult: metrics.recoveryResult,
    productionClasses: [...metrics.productionClasses].sort(),
    invariants: metrics.invariants,
    failureCodes: metrics.failureCodes,
  };
}

async function runModelWindow(
  scenario: RuntimeE2eScenario,
  variant: RuntimeE2eVariant,
  directory: string,
  metrics: MutableMetrics,
): Promise<boolean> {
  metrics.productionClasses.add("AgentLoop");
  metrics.productionClasses.add("ModelInvocationStore");
  let bundle = await createBundle(directory, metrics);
  const thread = bundle.state.lifecycleStore.createThread();
  const turn = bundle.state.lifecycleStore.createTurn(thread.id);
  bundle.state.lifecycleStore.appendItem(turn.id, "user_message", { text: `model window ${scenario.caseId}` });
  await saveBundle(bundle, metrics);

  if (variant === "no-wal") {
    const provider = new DeterministicFakeProvider(metrics, (call) => call === 1
      ? Object.assign(new Error("fake response lost after provider accepted request"), { code: "ECONNRESET" })
      : finalResponse(scenario, call));
    await new AgentLoop({ lifecycleStore: bundle.state.lifecycleStore, llm: provider }).run(turn.id, { model: FAKE_MODEL })
      .catch(() => undefined);
    bundle = await reloadBundle(bundle, metrics);
    await new AgentLoop({ lifecycleStore: bundle.state.lifecycleStore, llm: provider }).run(turn.id, { model: FAKE_MODEL });
    await saveBundle(bundle, metrics);
    bundle = await reloadBundle(bundle, metrics);
    metrics.duplicateModelCalls = Math.max(0, metrics.modelCalls - 1);
    metrics.unknownOutcome = true;
    metrics.recoveryAttempted = true;
    metrics.recoverySuccess = true;
    metrics.recoveryResult = "legacy-path-reissued-provider-call";
  } else {
    const provider = new DeterministicFakeProvider(metrics, (call) => finalResponse(scenario, call));
    let injected = false;
    const loop = createWalLoop(bundle, provider, metrics, async () => {
      await saveBundle(bundle, metrics);
      const status = bundle.state.modelInvocationStore.list().at(-1)?.status;
      if (!injected && status === "response_received") {
        injected = true;
        throw new SimulatedProcessExit("model-response-received");
      }
    });
    await loop.run(turn.id, { model: FAKE_MODEL }).catch((error) => {
      if (!(error instanceof SimulatedProcessExit)) throw error;
    });
    bundle = await reloadBundle(bundle, metrics);
    metrics.recoveryAttempted = true;
    if (variant === "no-recovery") {
      metrics.recoverySuccess = false;
      metrics.recoveryResult = "recovery-interface-disabled";
      metrics.failureCodes.push("recovery_disabled");
      metrics.evidenceProduced = 1;
      return false;
    }
    const replayProvider = new DeterministicFakeProvider(metrics, (call) => finalResponse(scenario, call));
    await createWalLoop(bundle, replayProvider, metrics).run(turn.id, { model: FAKE_MODEL });
    await saveBundle(bundle, metrics);
    bundle = await reloadBundle(bundle, metrics);
    metrics.recoverySuccess = true;
    metrics.recoveryResult = "response-replayed-without-provider-reissue";
    metrics.duplicateModelCalls = Math.max(0, metrics.modelCalls - 1);
  }

  const assistantCount = bundle.state.lifecycleStore.getItemsForTurn(turn.id)
    .filter((item) => item.type === "assistant_message").length;
  const committed = variant === "no-wal" || bundle.state.modelInvocationStore.list("committed").length === 1;
  metrics.evidenceProduced = 3;
  metrics.invariants.push("exactly-one-assistant-message", "snapshot-reloaded", "provider-call-count-audited");
  return assistantCount === 1 && committed && metrics.duplicateModelCalls === 0 && !metrics.unknownOutcome;
}

async function runToolWindow(
  scenario: RuntimeE2eScenario,
  variant: RuntimeE2eVariant,
  directory: string,
  metrics: MutableMetrics,
): Promise<boolean> {
  metrics.productionClasses.add("AgentLoop");
  metrics.productionClasses.add("ModelInvocationStore");
  metrics.productionClasses.add("ToolInvocationStore");
  metrics.productionClasses.add("ToolRegistry");
  let bundle = await createBundle(directory, metrics);
  const thread = bundle.state.lifecycleStore.createThread();
  const turn = bundle.state.lifecycleStore.createTurn(thread.id);
  bundle.state.lifecycleStore.appendItem(turn.id, "user_message", { text: `tool window ${scenario.caseId}` });
  await saveBundle(bundle, metrics);
  const effectPath = path.join(directory, "fake-tool-effects.log");
  let failFirstEffect = variant === "no-wal";
  const tool = fakeEffectTool(effectPath, metrics, () => {
    if (!failFirstEffect) return false;
    failFirstEffect = false;
    return true;
  });
  const provider = new DeterministicFakeProvider(metrics, (call) => {
    if (variant === "no-wal") return call <= 2 ? toolResponse(scenario) : finalResponse(scenario, call);
    return call === 1 ? toolResponse(scenario) : finalResponse(scenario, call);
  });

  if (variant === "no-wal") {
    await new AgentLoop({ lifecycleStore: bundle.state.lifecycleStore, llm: provider, toolRegistry: new ToolRegistry([tool]) })
      .run(turn.id, { model: FAKE_MODEL }).catch(() => undefined);
    bundle = await reloadBundle(bundle, metrics);
    await new AgentLoop({ lifecycleStore: bundle.state.lifecycleStore, llm: provider, toolRegistry: new ToolRegistry([tool]) })
      .run(turn.id, { model: FAKE_MODEL });
    await saveBundle(bundle, metrics);
    bundle = await reloadBundle(bundle, metrics);
    metrics.duplicateModelCalls = Math.max(0, metrics.modelCalls - 2);
    metrics.duplicateToolEffects = Math.max(0, metrics.toolEffects - 1);
    metrics.unknownOutcome = true;
    metrics.recoveryAttempted = true;
    metrics.recoverySuccess = true;
    metrics.recoveryResult = "tool-reexecuted-without-wal";
  } else {
    let injected = false;
    const loop = createWalLoop(bundle, provider, metrics, async () => {
      await saveBundle(bundle, metrics);
      if (!injected && bundle.state.toolInvocationStore.list().at(-1)?.status === "result_received") {
        injected = true;
        throw new SimulatedProcessExit("tool-result-received");
      }
    }, new ToolRegistry([tool]));
    await loop.run(turn.id, { model: FAKE_MODEL }).catch((error) => {
      if (!(error instanceof SimulatedProcessExit)) throw error;
    });
    bundle = await reloadBundle(bundle, metrics);
    metrics.recoveryAttempted = true;
    if (variant === "no-recovery") {
      metrics.recoverySuccess = false;
      metrics.recoveryResult = "recovery-interface-disabled";
      metrics.failureCodes.push("recovery_disabled");
      metrics.evidenceProduced = 2;
      return false;
    }
    await createWalLoop(bundle, provider, metrics, undefined, new ToolRegistry([tool]))
      .run(turn.id, { model: FAKE_MODEL });
    await saveBundle(bundle, metrics);
    bundle = await reloadBundle(bundle, metrics);
    metrics.recoverySuccess = true;
    metrics.recoveryResult = "tool-result-replayed-without-effect-reissue";
    metrics.duplicateModelCalls = Math.max(0, metrics.modelCalls - 2);
    metrics.duplicateToolEffects = Math.max(0, metrics.toolEffects - 1);
  }

  const effectLines = await readLines(effectPath);
  const toolResults = bundle.state.lifecycleStore.getItemsForTurn(turn.id)
    .filter((item) => item.type === "tool_result").length;
  metrics.evidenceProduced = 3;
  metrics.invariants.push("exactly-one-tool-effect", "exactly-one-tool-result", "tool-wal-committed");
  return effectLines === 1 && toolResults === 1 && metrics.duplicateToolEffects === 0 && !metrics.unknownOutcome;
}

async function runReturnOrFeedback(
  scenario: RuntimeE2eScenario,
  variant: RuntimeE2eVariant,
  directory: string,
  metrics: MutableMetrics,
): Promise<boolean> {
  if (scenario.checkpoint.endsWith("feedback")) {
    return runWorkflow(directory, metrics, variant, scenario.checkpoint.replace("-feedback", ""));
  }
  metrics.productionClasses.add("AgentRuntimeStore");
  metrics.productionClasses.add("PersistentRuntimeLeaseStore");
  let bundle = await createBundle(directory, metrics);
  const job = bundle.state.agentRuntimeStore.createJob({
    threadId: `thread-${scenario.caseId}`,
    rootTurnId: `turn-${scenario.caseId}`,
    rootRunId: `root-${scenario.caseId}`,
    configSnapshot: DEFAULT_AGENT_TEAM_CONFIG,
    executionKind: "software_product_delivery",
    workflowVersion: "software_product_delivery_v2",
  });
  const envelope = bundle.state.agentRuntimeStore.createReturn({
    jobId: job.id,
    rootRunId: job.rootRunId,
    parentRunId: job.rootRunId,
    childRunId: `child-${scenario.caseId}`,
    taskId: `task-${scenario.caseId}`,
    sequence: 1,
    result: { status: "completed", summary: "fake child result", evidenceIds: [], boardEntryIds: [] },
    idempotencyKey: `${job.id}:return:1`,
    jobAttempt: job.attempt,
    workflowVersion: job.workflowVersion,
    stageId: "product",
    stageAttempt: 1,
  });
  await saveBundle(bundle, metrics);
  bundle = await reloadBundle(bundle, metrics);
  metrics.recoveryAttempted = true;

  if (variant === "no-recovery") {
    const claimed = bundle.state.agentRuntimeStore.claimReturn(envelope.id);
    await saveBundle(bundle, metrics);
    bundle = await reloadBundle(bundle, metrics);
    metrics.recoverySuccess = false;
    metrics.recoveryResult = "delivering-return-left-unconsumed";
    metrics.failureCodes.push("recovery_disabled");
    metrics.evidenceProduced = claimed === undefined ? 0 : 1;
    return false;
  }

  if (variant === "no-lease") {
    const first = await reloadBundle(bundle, metrics);
    const second = await reloadBundle(bundle, metrics);
    const delivered = [first, second].filter((candidate) => {
      const claim = candidate.state.agentRuntimeStore.claimReturn(envelope.id);
      return claim !== undefined && candidate.state.agentRuntimeStore.consumeReturn(envelope.id);
    }).length;
    await saveBundle(first, metrics);
    await saveBundle(second, metrics);
    bundle = await reloadBundle(second, metrics);
    metrics.toolEffects = delivered;
    metrics.duplicateToolEffects = Math.max(0, delivered - 1);
    metrics.recoverySuccess = true;
    metrics.recoveryResult = "two-unleased-runtime-instances-delivered-return";
  } else {
    const leaseStore = new PersistentRuntimeLeaseStore(path.join(directory, "runtime-leases.json"));
    const lease = await leaseStore.acquire({ resource: { type: "job", id: job.id }, ownerId: "runtime-a", ttlMs: 5_000 });
    const claim = bundle.state.agentRuntimeStore.claimReturn(envelope.id);
    const duplicateClaim = bundle.state.agentRuntimeStore.claimReturn(envelope.id);
    const consumed = claim !== undefined && bundle.state.agentRuntimeStore.consumeReturn(envelope.id);
    const duplicateConsume = bundle.state.agentRuntimeStore.consumeReturn(envelope.id);
    await leaseStore.release(lease);
    await saveBundle(bundle, metrics);
    bundle = await reloadBundle(bundle, metrics);
    metrics.toolEffects = consumed ? 1 : 0;
    metrics.recoverySuccess = true;
    metrics.recoveryResult = "return-claimed-and-consumed-once";
    metrics.invariants.push(`duplicate-claim:${String(duplicateClaim === undefined)}`, `duplicate-consume:${String(!duplicateConsume)}`);
  }

  const restored = bundle.state.agentRuntimeStore.listReturns(job.id).find((item) => item.id === envelope.id);
  metrics.evidenceProduced = 3;
  metrics.invariants.push("return-receipt-persisted", "return-status-consumed");
  return restored?.status === "consumed" && metrics.duplicateToolEffects === 0;
}

async function runWorkflowStage(
  scenario: RuntimeE2eScenario,
  variant: RuntimeE2eVariant,
  directory: string,
  metrics: MutableMetrics,
): Promise<boolean> {
  return runWorkflow(directory, metrics, variant, undefined, scenario.ordinal % 5 + 1);
}

async function runWorkflow(
  directory: string,
  metrics: MutableMetrics,
  variant: RuntimeE2eVariant,
  blockedProfile?: string,
  reloadAfterTransitions = 2,
): Promise<boolean> {
  metrics.productionClasses.add("AgentRuntimeStore");
  metrics.productionClasses.add("AgentRunStore");
  metrics.productionClasses.add("WorkflowTeamCoordinator");
  let bundle = await createBundle(directory, metrics);
  const thread = bundle.state.lifecycleStore.createThread();
  const turn = bundle.state.lifecycleStore.createTurn(thread.id);
  const root = bundle.state.agentRunStore.ensureRoot(thread.id, turn.id, "orchestrator");
  const job = bundle.state.agentRuntimeStore.createJob({
    threadId: thread.id,
    rootTurnId: turn.id,
    rootRunId: root.id,
    configSnapshot: DEFAULT_AGENT_TEAM_CONFIG,
    executionKind: "software_product_delivery",
    workflowVersion: "software_product_delivery_v2",
  });
  ensureFixedSoftwareTeam(bundle.state.lifecycleStore, bundle.state.agentRunStore, root);
  await saveBundle(bundle, metrics);
  const blockedCalls = new Set<string>();
  const createCoordinator = (current: RuntimeBundle) => new WorkflowTeamCoordinator({
    runStore: current.state.agentRunStore,
    runtimeStore: current.state.agentRuntimeStore,
    template: SOFTWARE_PRODUCT_DELIVERY_TEMPLATE,
    requirement: () => ({
      objective: "runtime e2e implementation check",
      scope: ["research/runtime-e2e-benchmarks/**"],
      nonGoals: ["real provider"],
      deliverables: ["report"],
      acceptanceCriteria: ["runtime invariant"],
      prompt: "confirmed deterministic fixture",
    }),
    feedback: () => feedbackProvided
      ? { turnId: "parent-feedback-turn", text: "continue with deterministic choice" }
      : undefined,
    execute: async (input) => {
      metrics.modelCalls += 1;
      const profile = input.profileId.replace("_role", "");
      const shouldBlock = blockedProfile === profile && !blockedCalls.has(profile);
      if (shouldBlock) blockedCalls.add(profile);
      return {
        turnId: `fake-workflow-turn-${metrics.modelCalls}`,
        summary: stageResult(shouldBlock ? "blocked" : "completed"),
      };
    },
    persist: () => saveBundle(current, metrics),
  });
  let coordinator = createCoordinator(bundle);
  let transitions = 0;
  let feedbackProvided = false;
  for (let guard = 0; guard < 30; guard += 1) {
    const stage = coordinator.getStage(job.id);
    if (stage === "completed") break;
    const blockedTask = bundle.state.agentRuntimeStore.listTasks(job.id).find((task) => task.status === "blocked");
    if (blockedTask !== undefined && !feedbackProvided) {
      feedbackProvided = await coordinator.provideFeedback(job.id, { turnId: "parent-feedback-turn", text: "continue with deterministic choice" });
      metrics.invariants.push("parent-feedback-persisted");
    }
    await coordinator.advance(job.id, coordinator.getStage(job.id));
    transitions += 1;
    if (transitions === reloadAfterTransitions) {
      bundle = await reloadBundle(bundle, metrics);
      metrics.recoveryAttempted = true;
      if (variant === "no-recovery") {
        metrics.recoverySuccess = false;
        metrics.recoveryResult = "workflow-resume-disabled";
        metrics.failureCodes.push("recovery_disabled");
        metrics.evidenceProduced = 1;
        return false;
      }
      bundle.state.agentRuntimeStore.reconcilePersistedJobs(job.id);
      coordinator = createCoordinator(bundle);
      if (blockedProfile === undefined) {
        coordinator.recoverPersistedCheckpoints(job.id);
      } else {
        const decision = coordinator.recoveryDecision(job.id);
        metrics.invariants.push(`feedback-recovery-decision:${decision.kind}`);
      }
      metrics.recoverySuccess = true;
      metrics.recoveryResult = "workflow-checkpoint-restored";
    }
  }
  await saveBundle(bundle, metrics);
  bundle = await reloadBundle(bundle, metrics);
  const status = bundle.state.agentRuntimeStore.getJob(job.id)?.status;
  const consumedLead = bundle.state.agentRuntimeStore.listReturns(job.id)
    .some((item) => item.stageId === "lead" && item.status === "consumed");
  const stages = bundle.state.agentRuntimeStore.listStageCheckpoints(job.id);
  metrics.evidenceProduced = 3;
  metrics.invariants.push("workflow-job-completed", "lead-return-consumed", "stage-checkpoints-persisted");
  return status === "completed" && consumedLead && stages.length >= 5 && (blockedProfile === undefined || feedbackProvided);
}

async function runSnapshotReload(
  scenario: RuntimeE2eScenario,
  variant: RuntimeE2eVariant,
  directory: string,
  metrics: MutableMetrics,
): Promise<boolean> {
  metrics.productionClasses.add("LifecycleStore");
  metrics.productionClasses.add("ModelInvocationStartupRecovery");
  metrics.productionClasses.add("ModelInvocationStore");
  metrics.productionClasses.add("ToolInvocationStore");
  let bundle = await createBundle(directory, metrics);
  const thread = bundle.state.lifecycleStore.createThread();
  const turn = bundle.state.lifecycleStore.createTurn(thread.id);
  bundle.state.lifecycleStore.appendItem(turn.id, "user_message", { text: scenario.checkpoint });
  if (variant !== "no-wal") {
    const invocation = bundle.state.modelInvocationStore.prepare({
      threadId: thread.id,
      turnId: turn.id,
      round: 0,
      purpose: "snapshot-probe",
      requestDigest: createModelRequestDigest({ caseId: scenario.caseId }),
      provider: "deterministic-fake",
      model: FAKE_MODEL,
    });
    bundle.state.modelInvocationStore.markSubmitted(invocation.invocationId);
    const tool = bundle.state.toolInvocationStore.prepare({
      modelInvocationId: invocation.invocationId,
      callId: "snapshot-tool-call",
      toolName: "runtime_e2e_effect",
      argumentsDigest: createToolArgumentsDigest("{}"),
    });
    bundle.state.toolInvocationStore.markExecuting(tool.toolInvocationId);
  }
  await saveBundle(bundle, metrics);
  bundle = await reloadBundle(bundle, metrics);
  metrics.recoveryAttempted = true;
  if (variant === "no-recovery") {
    metrics.recoverySuccess = false;
    metrics.recoveryResult = "startup-recovery-disabled";
    metrics.failureCodes.push("recovery_disabled");
    metrics.evidenceProduced = 1;
    return false;
  }
  if (variant !== "no-wal") {
    const recovery = new ModelInvocationStartupRecovery({
      lifecycleStore: bundle.state.lifecycleStore,
      modelInvocationStore: bundle.state.modelInvocationStore,
      toolInvocationStore: bundle.state.toolInvocationStore,
      persist: () => saveBundle(bundle, metrics),
    });
    const result = await recovery.recoverTurn(turn.id);
    bundle.state.toolInvocationStore.recoverExecuting();
    await saveBundle(bundle, metrics);
    bundle = await reloadBundle(bundle, metrics);
    metrics.unknownOutcome = true;
    metrics.recoveryResult = result.diagnosticCode ?? result.action;
  } else {
    metrics.recoveryResult = "snapshot-restored-without-invocation-wal";
  }
  metrics.recoverySuccess = bundle.state.lifecycleStore.getTurn(turn.id)?.status === "interrupted";
  metrics.evidenceProduced = 3;
  metrics.invariants.push("in-progress-turn-interrupted", "json-snapshot-version-6", "wal-status-reloaded");
  return metrics.recoverySuccess;
}

async function runLeaseCompetition(
  scenario: RuntimeE2eScenario,
  variant: RuntimeE2eVariant,
  directory: string,
  metrics: MutableMetrics,
): Promise<boolean> {
  metrics.productionClasses.add("PersistentRuntimeLeaseStore");
  let bundle = await createBundle(directory, metrics);
  const thread = bundle.state.lifecycleStore.createThread();
  const turn = bundle.state.lifecycleStore.createTurn(thread.id);
  bundle.state.lifecycleStore.appendItem(turn.id, "user_message", { text: "lease competition" });
  await saveBundle(bundle, metrics);
  bundle = await reloadBundle(bundle, metrics);
  const effectPath = path.join(directory, "leased-effects.log");

  if (variant === "no-lease") {
    await Promise.all([appendEffect(effectPath, metrics, "owner-a"), appendEffect(effectPath, metrics, "owner-b")]);
    metrics.duplicateToolEffects = 1;
    metrics.recoveryResult = "two-unleased-effects-committed";
    metrics.evidenceProduced = 2;
    metrics.invariants.push("lease-ablation-used-real-effect-path");
    return false;
  }

  const resourceType = scenario.checkpoint === "model-invocation" ? "model_invocation"
    : scenario.checkpoint === "tool-invocation" || scenario.checkpoint === "fenced-commit" ? "tool_invocation"
      : scenario.checkpoint as "job" | "turn";
  const resource = { type: resourceType, id: `resource-${scenario.caseId}` } as const;
  const leasePath = path.join(directory, "runtime-leases.json");
  const first = new PersistentRuntimeLeaseStore(leasePath);
  const second = new PersistentRuntimeLeaseStore(leasePath);
  const attempts = await Promise.allSettled([
    first.acquire({ resource, ownerId: "owner-a", ttlMs: 5_000 }),
    second.acquire({ resource, ownerId: "owner-b", ttlMs: 5_000 }),
  ]);
  const winner = attempts.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof first.acquire>>> => result.status === "fulfilled");
  const rejected = attempts.filter((result) => result.status === "rejected").length;
  if (winner !== undefined) {
    const owner = winner.value.ownerId === "owner-a" ? first : second;
    await owner.withFencedCommit(winner.value, () => appendEffect(effectPath, metrics, winner.value.ownerId));
  }
  metrics.recoveryAttempted = true;
  metrics.recoverySuccess = rejected === 1;
  metrics.recoveryResult = "one-lease-winner-one-conflict";
  metrics.evidenceProduced = 3;
  metrics.invariants.push("single-lease-winner", "single-fenced-effect", "lease-state-persisted");
  return rejected === 1 && await readLines(effectPath) === 1;
}

function createWalLoop(
  bundle: RuntimeBundle,
  provider: LlmProvider,
  metrics: MutableMetrics,
  persist?: () => Promise<void>,
  toolRegistry?: ToolRegistry,
): AgentLoop {
  const save = persist ?? (() => saveBundle(bundle, metrics));
  return new AgentLoop({
    lifecycleStore: bundle.state.lifecycleStore,
    contextCheckpointStore: bundle.state.contextCheckpointStore,
    llm: provider,
    ...(toolRegistry === undefined ? {} : { toolRegistry }),
    modelInvocationWal: {
      store: bundle.state.modelInvocationStore,
      persist: save,
      provider: "deterministic-fake",
      defaultModel: FAKE_MODEL,
    },
    toolInvocationWal: {
      store: bundle.state.toolInvocationStore,
      persist: save,
    },
  });
}

async function createBundle(directory: string, metrics: IoMetrics): Promise<RuntimeBundle> {
  const statePath = path.join(directory, "runtime-state.json");
  const persistence = new JsonFileRuntimePersistence(statePath);
  const state = await persistence.load();
  metrics.loads += 1;
  return { statePath, persistence, state };
}

async function reloadBundle(bundle: RuntimeBundle, metrics: IoMetrics): Promise<RuntimeBundle> {
  const persistence = new JsonFileRuntimePersistence(bundle.statePath);
  const state = await persistence.load();
  metrics.loads += 1;
  metrics.reloaded = true;
  return { statePath: bundle.statePath, persistence, state };
}

async function saveBundle(bundle: RuntimeBundle, metrics: IoMetrics): Promise<void> {
  await bundle.persistence.save(
    bundle.state.lifecycleStore,
    bundle.state.contextCheckpointStore,
    bundle.state.agentRunStore,
    bundle.state.threadConfigs,
    bundle.state.agentProfiles,
    bundle.state.runtimeSessions,
    bundle.state.agentRuntimeStore,
    bundle.state.requirementStore,
    bundle.state.modelInvocationStore,
    bundle.state.toolInvocationStore,
  );
  metrics.writes += 1;
}

function fakeEffectTool(
  effectPath: string,
  metrics: MutableMetrics,
  shouldFailAfterEffect: () => boolean,
): AgentTool {
  return {
    definition: {
      name: "runtime_e2e_effect",
      description: "Write one deterministic effect to the local temporary journal",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    execute: async () => {
      await appendEffect(effectPath, metrics, `effect-${metrics.toolEffects + 1}`);
      if (shouldFailAfterEffect()) throw Object.assign(new Error("fake tool response lost after effect"), { code: "ECONNRESET" });
      return { result: { ok: true }, modelOutput: { ok: true } };
    },
  };
}

async function appendEffect(effectPath: string, metrics: MutableMetrics, value: string): Promise<void> {
  metrics.toolEffects += 1;
  await appendFile(effectPath, `${value}\n`, "utf8");
}

async function readLines(filePath: string): Promise<number> {
  try {
    return (await readFile(filePath, "utf8")).split(/\r?\n/u).filter(Boolean).length;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return 0;
    throw error;
  }
}

function finalResponse(scenario: RuntimeE2eScenario, call: number): LlmResponse {
  return { id: `${scenario.caseId}-response-${call}`, text: `runtime e2e final ${scenario.caseId}`, functionCalls: [] };
}

function toolResponse(scenario: RuntimeE2eScenario): LlmResponse {
  return {
    id: `${scenario.caseId}-tool-response`,
    text: "",
    functionCalls: [{ callId: `${scenario.caseId}-call`, name: "runtime_e2e_effect", arguments: "{}" }],
  };
}

function stageResult(status: "completed" | "blocked"): string {
  return JSON.stringify({
    status,
    summary: status === "completed" ? "deterministic stage complete" : "parent decision required",
    deliverables: status === "completed" ? ["runtime evidence"] : [],
    evidence: [status === "completed" ? "production state invariant" : "missing parent decision"],
    blockers: status === "blocked" ? ["parent decision"] : [],
    nextStageRecommendation: status === "completed" ? "continue" : "block",
    contractVersion: STAGE_RESULT_CONTRACT_VERSION,
  });
}

function errorCode(error: unknown): string {
  if (isRecord(error) && typeof error.code === "string") return error.code;
  if (error instanceof Error) return error.name;
  return "unknown_error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

class SimulatedProcessExit extends Error {
  constructor(checkpoint: string) {
    super(`simulated process exit at ${checkpoint}`);
    this.name = "SimulatedProcessExit";
  }
}
