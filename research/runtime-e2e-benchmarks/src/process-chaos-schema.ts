export const PROCESS_CHAOS_REPORT_SCHEMA_VERSION = "process-chaos-report-v1" as const;
export const PROCESS_CHAOS_EXPERIMENT_ID = "team-workflow-return-narrow-e3-v1" as const;
export const PROCESS_CHAOS_WINDOW_ID = "FW-RETURN-RESPONSE-LEASE" as const;
export const PROCESS_CHAOS_RETURN_PERSISTED_WINDOW_ID = "FW-RETURN-PERSISTED-CONSUME" as const;
export const PROCESS_CHAOS_FENCED_COMMIT_WINDOW_ID = "FW-LEASE-FENCED-COMMIT" as const;
export const PROCESS_CHAOS_MODEL_RESPONSE_COMMIT_WINDOW_ID = "FW-MODEL-RESPONSE-COMMIT" as const;
export const PROCESS_CHAOS_TOOL_EFFECT_RECEIPT_WINDOW_ID = "FW-TOOL-EFFECT-RECEIPT" as const;
export const PROCESS_CHAOS_WORKFLOW_STAGE_COMMIT_WINDOW_ID = "FW-WORKFLOW-STAGE-COMMIT" as const;
export const PROCESS_CHAOS_RECEIPT_COMMIT_WINDOW_ID = "FW-RECEIPT-COMMIT" as const;
export const PROCESS_CHAOS_PROOF_COMMIT_WINDOW_ID = "FW-PROOF-COMMIT" as const;
export type ProcessChaosRunnableWindowId =
  | typeof PROCESS_CHAOS_WINDOW_ID
  | typeof PROCESS_CHAOS_RETURN_PERSISTED_WINDOW_ID
  | typeof PROCESS_CHAOS_FENCED_COMMIT_WINDOW_ID
  | typeof PROCESS_CHAOS_MODEL_RESPONSE_COMMIT_WINDOW_ID
  | typeof PROCESS_CHAOS_TOOL_EFFECT_RECEIPT_WINDOW_ID
  | typeof PROCESS_CHAOS_WORKFLOW_STAGE_COMMIT_WINDOW_ID
  | typeof PROCESS_CHAOS_RECEIPT_COMMIT_WINDOW_ID
  | typeof PROCESS_CHAOS_PROOF_COMMIT_WINDOW_ID;
export const PROCESS_CHAOS_REPRO_COMMAND =
  `npm exec -- tsx research/runtime-e2e-benchmarks/src/process-chaos-cli.ts --window ${PROCESS_CHAOS_WINDOW_ID} --seed <seed> --output <directory>`;

export function processChaosReproCommand(seed: string): string {
  return `npm exec -- tsx research/runtime-e2e-benchmarks/src/process-chaos-cli.ts --window ${PROCESS_CHAOS_WINDOW_ID} --seed ${seed} --output <directory>`;
}

export function processChaosWindowReproCommand(windowId: ProcessChaosRunnableWindowId, seed: string): string {
  return `npm exec -- tsx research/runtime-e2e-benchmarks/src/process-chaos-cli.ts --window ${windowId} --seed ${seed} --output <directory>`;
}

export const PROCESS_CHAOS_BOUNDARY_REPORT_SCHEMA_VERSION = "process-chaos-boundary-report-v1" as const;

interface ProcessChaosBoundaryReportBase {
  schemaVersion: typeof PROCESS_CHAOS_BOUNDARY_REPORT_SCHEMA_VERSION;
  windowId: Exclude<ProcessChaosRunnableWindowId, typeof PROCESS_CHAOS_WINDOW_ID>;
  evidenceLevel: "local-narrow-E3-pilot";
  completeGate40: false;
  exactlyOnceClaimed: false;
  productionReadyClaimed: false;
  runStartedAt: string;
  runCompletedAt: string;
  environment: {
    platform: string;
    arch: string;
    node: string;
    osRelease: string;
    local: true;
    appServerProcess: "real-child-process";
    provider: { kind: "deterministic-loopback-fake"; realApiCalls: false; credentialsRead: false };
  };
  seed: string;
  productionEntry: "node --import tsx src/app-server/main.ts";
  reproCommand: string;
  statePath: "runtime-state.json";
  leasePath: "runtime-leases.json";
  rawReportPath: "process-chaos-boundary-report.json";
  pids: { originalOwner: number; successor: number; auditor: number | null };
  evidence:
    | ProcessChaosReturnBoundaryEvidence
    | ProcessChaosModelResponseEvidence
    | ProcessChaosWorkflowStageEvidence
    | ProcessChaosLocalEffectEvidence;
}

interface ProcessChaosReturnBoundaryEvidence {
    threadId: string;
    jobId: string;
    returnId: string;
    persistedReturnStatus: "ready";
    persistedReturnAttempts: 0;
    finalReturnStatus: "consumed";
    finalReturnAttempts: 1;
    finalJobStatus: "completed";
    finalDeliveryRequests: 1;
    returnGodCheckpointCount: 1;
    returnGodEvidenceCount: 1;
}

export interface ProcessChaosReturnPersistedReport extends ProcessChaosBoundaryReportBase {
  windowId: typeof PROCESS_CHAOS_RETURN_PERSISTED_WINDOW_ID;
  evidence: ProcessChaosReturnBoundaryEvidence;
  oracle: {
    id: "ORACLE-RETURN-CONSUME-V1";
    ownerKilledAtPersistedBoundary: true;
    successorReloadedPersistedReturn: true;
    returnConsumedOnce: true;
    parentAdvancedOnce: true;
    repeatedAdvanceChangedState: false;
  };
}

export interface ProcessChaosFencedCommitReport extends ProcessChaosBoundaryReportBase {
  windowId: typeof PROCESS_CHAOS_FENCED_COMMIT_WINDOW_ID;
  evidence: ProcessChaosReturnBoundaryEvidence;
  oracle: {
    id: "ORACLE-FENCING-V1";
    originalFencingToken: number;
    successorFencingToken: number;
    staleCommitRejected: true;
    staleCommitError: string;
    successorUniquelyCommitted: true;
    originalOwnerKilled: true;
    auditorReloadedAuthoritativeState: true;
  };
}

export interface ProcessChaosModelResponseCommitReport extends ProcessChaosBoundaryReportBase {
  windowId: typeof PROCESS_CHAOS_MODEL_RESPONSE_COMMIT_WINDOW_ID;
  evidence: ProcessChaosModelResponseEvidence;
  oracle: {
    id: "ORACLE-MODEL-WAL-V1";
    ownerKilledAfterResponsePersisted: true;
    successorReplayedPersistedResponse: true;
    providerRequestNotRepeated: true;
    assistantCommittedOnce: true;
  };
}

interface ProcessChaosModelResponseEvidence {
  threadId: string;
  turnId: string;
  invocationId: string;
  persistedInvocationStatus: "response_received";
  finalInvocationStatus: "committed";
  finalTurnStatus: "completed";
  providerRequestsBeforeKill: 1;
  finalProviderRequests: 1;
  assistantMessageCount: 1;
}

export interface ProcessChaosWorkflowStageCommitReport extends ProcessChaosBoundaryReportBase {
  windowId: typeof PROCESS_CHAOS_WORKFLOW_STAGE_COMMIT_WINDOW_ID;
  evidence: ProcessChaosWorkflowStageEvidence;
  oracle: {
    id: "ORACLE-WORKFLOW-COMMIT-V1";
    ownerKilledBeforeStageCommit: true;
    successorRecoveredPersistedModelResult: true;
    productModelInvocationNotRepeated: true;
    productStageCommittedOnce: true;
  };
}

interface ProcessChaosLocalEffectEvidence {
  helperPid: number;
  helperProcess: "real-child-process";
  helperLedgerPath: "effect-ledger.json";
  threadId: string;
  turnId: string;
  operationId: string;
  effectId: string;
  effectDigest: string;
  receiptId: string;
  receiptDigest: string;
  proofId: string;
  proofDigest: string;
  persistedToolStatus: "executing" | "result_received";
  finalToolStatus: "committed";
  effectApplyCount: 1;
  helperCreateRequests: 1;
  helperDuplicateCreateRequests: 0;
  proofVerificationRequests: 0 | 1;
  providerRequests: 2 | 3;
  toolInvocationCount: 1 | 2;
  targetToolResultCount: 1;
  assistantMessageCount: 1;
  finalTurnStatus: "completed";
}

export interface ProcessChaosToolEffectReceiptReport extends ProcessChaosBoundaryReportBase {
  windowId: typeof PROCESS_CHAOS_TOOL_EFFECT_RECEIPT_WINDOW_ID;
  evidence: ProcessChaosLocalEffectEvidence & {
    persistedToolStatus: "executing";
    proofVerificationRequests: 0;
    providerRequests: 2;
    toolInvocationCount: 1;
  };
  oracle: {
    id: "ORACLE-TOOL-OUTCOME-V1";
    ownerKilledAfterEffectBeforeToolReceipt: true;
    successorQueriedPersistedEffect: true;
    blindReplayAvoided: true;
    effectAppliedOnce: true;
    receiptRecovered: true;
  };
}

export interface ProcessChaosReceiptCommitReport extends ProcessChaosBoundaryReportBase {
  windowId: typeof PROCESS_CHAOS_RECEIPT_COMMIT_WINDOW_ID;
  evidence: ProcessChaosLocalEffectEvidence & {
    persistedToolStatus: "result_received";
    proofVerificationRequests: 0;
    providerRequests: 2;
    toolInvocationCount: 1;
  };
  oracle: {
    id: "ORACLE-RECEIPT-V1";
    ownerKilledAfterReceiptPersisted: true;
    successorBoundPersistedReceipt: true;
    toolResultCommittedOnce: true;
    effectAppliedOnce: true;
  };
}

export interface ProcessChaosProofCommitReport extends ProcessChaosBoundaryReportBase {
  windowId: typeof PROCESS_CHAOS_PROOF_COMMIT_WINDOW_ID;
  evidence: ProcessChaosLocalEffectEvidence & {
    persistedToolStatus: "result_received";
    proofVerificationRequests: 1;
    providerRequests: 3;
    toolInvocationCount: 2;
  };
  oracle: {
    id: "ORACLE-PROOF-V1";
    ownerKilledAfterProofVerified: true;
    successorBoundPersistedProof: true;
    proofDigestStable: true;
    proofToolResultCommittedOnce: true;
    effectAppliedOnce: true;
  };
}

interface ProcessChaosWorkflowStageEvidence {
  threadId: string;
  jobId: string;
  runId: string;
  stageId: "product";
  stageAttempt: 1;
  invocationId: string;
  persistedInvocationStatus: "committed";
  persistedCheckpointStatus: "running";
  finalInvocationStatus: "committed";
  finalCheckpointStatus: "completed";
  finalJobStatus: "completed";
  productInvocationCount: 1;
  productCheckpointCount: 1;
  productEvidenceCount: 1;
  productReturnCount: 1;
}

export type ProcessChaosBoundaryReport =
  | ProcessChaosReturnPersistedReport
  | ProcessChaosFencedCommitReport
  | ProcessChaosModelResponseCommitReport
  | ProcessChaosWorkflowStageCommitReport
  | ProcessChaosToolEffectReceiptReport
  | ProcessChaosReceiptCommitReport
  | ProcessChaosProofCommitReport;
export type ProcessChaosPilotReport = ProcessChaosReport | ProcessChaosBoundaryReport;

export function processChaosPilotWindowId(report: ProcessChaosPilotReport): ProcessChaosRunnableWindowId {
  return report.schemaVersion === PROCESS_CHAOS_REPORT_SCHEMA_VERSION ? PROCESS_CHAOS_WINDOW_ID : report.windowId;
}

export function validateProcessChaosPilotReport(value: unknown): asserts value is ProcessChaosPilotReport {
  if (isRecord(value) && value.schemaVersion === PROCESS_CHAOS_REPORT_SCHEMA_VERSION) {
    validateProcessChaosReport(value);
    return;
  }
  validateProcessChaosBoundaryReport(value);
}

export function validateProcessChaosBoundaryReport(value: unknown): asserts value is ProcessChaosBoundaryReport {
  const errors: string[] = [];
  if (!isRecord(value)) throw new Error("Process Chaos boundary report schema violation: root");
  if (!hasExactKeys(value, [
    "schemaVersion", "windowId", "evidenceLevel", "completeGate40", "exactlyOnceClaimed",
    "productionReadyClaimed", "runStartedAt", "runCompletedAt", "environment", "seed",
    "productionEntry", "reproCommand", "statePath", "leasePath", "rawReportPath", "pids", "oracle", "evidence",
  ])) errors.push("root-fields");
  const windowId = value.windowId;
  if (value.schemaVersion !== PROCESS_CHAOS_BOUNDARY_REPORT_SCHEMA_VERSION ||
    ![
      PROCESS_CHAOS_RETURN_PERSISTED_WINDOW_ID,
      PROCESS_CHAOS_FENCED_COMMIT_WINDOW_ID,
      PROCESS_CHAOS_MODEL_RESPONSE_COMMIT_WINDOW_ID,
      PROCESS_CHAOS_TOOL_EFFECT_RECEIPT_WINDOW_ID,
      PROCESS_CHAOS_WORKFLOW_STAGE_COMMIT_WINDOW_ID,
      PROCESS_CHAOS_RECEIPT_COMMIT_WINDOW_ID,
      PROCESS_CHAOS_PROOF_COMMIT_WINDOW_ID,
    ].includes(windowId as never)) errors.push("identity");
  if (value.evidenceLevel !== "local-narrow-E3-pilot" || value.completeGate40 !== false ||
    value.exactlyOnceClaimed !== false || value.productionReadyClaimed !== false) errors.push("claim-boundary");
  if (!validDate(value.runStartedAt) || !validDate(value.runCompletedAt) ||
    Date.parse(String(value.runCompletedAt)) < Date.parse(String(value.runStartedAt))) errors.push("timestamps");
  if (!validEnvironment(value.environment)) errors.push("environment");
  const validSeed = typeof value.seed === "string" && /^[a-zA-Z0-9._-]+$/u.test(value.seed);
  if (!validSeed || value.reproCommand !== processChaosWindowReproCommand(windowId as ProcessChaosRunnableWindowId, String(value.seed))) errors.push("reproCommand");
  if (value.productionEntry !== "node --import tsx src/app-server/main.ts" || value.statePath !== "runtime-state.json" ||
    value.leasePath !== "runtime-leases.json" || value.rawReportPath !== "process-chaos-boundary-report.json") errors.push("artifacts");
  if (!validBoundaryPids(value.pids)) errors.push("pids");
  if (windowId === PROCESS_CHAOS_RETURN_PERSISTED_WINDOW_ID) {
    if (!validBoundaryEvidence(value.evidence)) errors.push("evidence");
    if (!validReturnPersistedOracle(value.oracle)) errors.push("oracle");
  } else if (windowId === PROCESS_CHAOS_FENCED_COMMIT_WINDOW_ID) {
    if (!validBoundaryEvidence(value.evidence)) errors.push("evidence");
    if (!validFencingOracle(value.oracle)) errors.push("oracle");
  } else if (windowId === PROCESS_CHAOS_MODEL_RESPONSE_COMMIT_WINDOW_ID) {
    if (!validModelResponseEvidence(value.evidence)) errors.push("evidence");
    if (!validModelResponseOracle(value.oracle)) errors.push("oracle");
  } else if (windowId === PROCESS_CHAOS_WORKFLOW_STAGE_COMMIT_WINDOW_ID) {
    if (!validWorkflowStageEvidence(value.evidence)) errors.push("evidence");
    if (!validWorkflowStageOracle(value.oracle)) errors.push("oracle");
  } else if (windowId === PROCESS_CHAOS_TOOL_EFFECT_RECEIPT_WINDOW_ID) {
    if (!validLocalEffectEvidence(value.evidence, "executing", 0, 2, 1)) errors.push("evidence");
    if (!validToolEffectOracle(value.oracle)) errors.push("oracle");
  } else if (windowId === PROCESS_CHAOS_RECEIPT_COMMIT_WINDOW_ID) {
    if (!validLocalEffectEvidence(value.evidence, "result_received", 0, 2, 1)) errors.push("evidence");
    if (!validReceiptOracle(value.oracle)) errors.push("oracle");
  } else if (windowId === PROCESS_CHAOS_PROOF_COMMIT_WINDOW_ID) {
    if (!validLocalEffectEvidence(value.evidence, "result_received", 1, 3, 2)) errors.push("evidence");
    if (!validProofOracle(value.oracle)) errors.push("oracle");
  }
  if (errors.length > 0) throw new Error(`Process Chaos boundary report schema violation: ${errors.join(", ")}`);
}

export interface FakeProviderRequestCounts {
  prepare_requirement_plan: number;
  plan_confirmation: number;
  team_workflow: number;
  return_god: number;
}

export interface ProcessChaosWindow {
  name: "no-side-effect-after-turn-start" | "return-delivery-with-held-lease";
  evidenceRole: "persistence-reload-precondition" | "team-workflow-return-fault-window";
  countsTowardGate40: boolean;
  faultPoint: "turn-persisted-before-provider-request" | "return-response-received-with-job-lease-held";
  recoveryResult: "state-reloaded-without-provider-request" | "lease-wait-then-return-consumed";
  faultPointConfirmed: boolean;
  ownerKilled: boolean;
  publicRpcReloaded: boolean;
  rawJsonReloaded: boolean;
  leaseWaitObserved: boolean;
  recovered: boolean;
}

export interface ProcessChaosReport {
  schemaVersion: typeof PROCESS_CHAOS_REPORT_SCHEMA_VERSION;
  experiment: {
    id: typeof PROCESS_CHAOS_EXPERIMENT_ID;
    scope: "Team Workflow Return";
    evidenceLevel: "narrow-E3";
    formalFaultWindowCount: 1;
    gate40CompletedWindows: 1;
    gate40TotalWindows: 40;
    completeE3Matrix: false;
    completeGate40: false;
    exactlyOnceClaimed: false;
    productionReadyClaimed: false;
  };
  runStartedAt: string;
  runCompletedAt: string;
  environment: {
    platform: string;
    arch: string;
    node: string;
    osRelease: string;
    local: true;
    appServerProcess: "real-child-process";
    provider: {
      kind: "deterministic-loopback-fake";
      realApiCalls: false;
      credentialsRead: false;
    };
  };
  seed: string;
  productionEntry: string;
  reproCommand: string;
  statePath: "runtime-state.json";
  rawReportPath: "process-chaos-report.json";
  ownerPid: number;
  reloadPid: number;
  recoveryPid: number;
  pidChangedAfterReload: boolean;
  pidChangedAfterOwnerKill: boolean;
  pidTransitions: Array<{
    event: "reload-after-pre-provider-kill" | "recovery-after-return-window-kill";
    previousPid: number;
    successorPid: number;
    changed: boolean;
  }>;
  windows: ProcessChaosWindow[];
  evidence: {
    threadId: string;
    jobId: string;
    returnId: string;
    ownerLeaseId: string;
    ownerLeaseDeadline: string;
    providerRequests: number;
    providerRequestsByStage: FakeProviderRequestCounts;
    fakeProvider: {
      totalRequests: number;
      requestsByStage: FakeProviderRequestCounts;
      finalDeliveryRequestsBeforeKill: number;
      finalDeliveryRequestsAfterRecovery: number;
    };
    finalJobStatus: string;
    finalReturnStatus: string;
  };
}

export function validateProcessChaosReport(value: unknown): asserts value is ProcessChaosReport {
  const errors: string[] = [];
  if (!isRecord(value)) throw new Error("Process Chaos report schema violation: root");
  if (!hasExactKeys(value, [
    "schemaVersion", "experiment", "runStartedAt", "runCompletedAt", "environment", "seed",
    "productionEntry", "reproCommand", "statePath", "rawReportPath", "ownerPid", "reloadPid",
    "recoveryPid", "pidChangedAfterReload", "pidChangedAfterOwnerKill", "pidTransitions", "windows", "evidence",
  ])) errors.push("root-fields");

  if (value.schemaVersion !== PROCESS_CHAOS_REPORT_SCHEMA_VERSION) errors.push("schemaVersion");
  if (!validExperiment(value.experiment)) errors.push("experiment");
  if (!validDate(value.runStartedAt) || !validDate(value.runCompletedAt) ||
    (validDate(value.runStartedAt) && validDate(value.runCompletedAt) &&
      Date.parse(value.runCompletedAt) < Date.parse(value.runStartedAt))) errors.push("run-timestamps");
  if (!validEnvironment(value.environment)) errors.push("environment");
  const validSeed = typeof value.seed === "string" && /^[a-zA-Z0-9._-]+$/u.test(value.seed);
  if (!validSeed) errors.push("seed");
  if (value.productionEntry !== "node --import tsx src/app-server/main.ts") errors.push("productionEntry");
  if (!validSeed || value.reproCommand !== processChaosReproCommand(value.seed as string)) errors.push("reproCommand");
  if (value.statePath !== "runtime-state.json" || value.rawReportPath !== "process-chaos-report.json" ||
    ![value.statePath, value.rawReportPath].every(isSafeRelativePosixPath)) errors.push("artifact-paths");

  const pids = [value.ownerPid, value.reloadPid, value.recoveryPid];
  if (!pids.every(positiveInteger) || new Set(pids).size !== 3 ||
    value.pidChangedAfterReload !== true || value.pidChangedAfterOwnerKill !== true) errors.push("pid-change");
  if (!validPidTransitions(value.pidTransitions, pids as [number, number, number])) errors.push("pidTransitions");
  if (!validWindows(value.windows)) errors.push("windows");
  if (!validEvidence(value.evidence)) errors.push("evidence");

  if (errors.length > 0) {
    throw new Error(`Process Chaos report schema violation: ${errors.join(", ")}`);
  }
}

function validExperiment(value: unknown): boolean {
  return isRecord(value) &&
    hasExactKeys(value, [
      "id", "scope", "evidenceLevel", "formalFaultWindowCount", "gate40CompletedWindows",
      "gate40TotalWindows", "completeE3Matrix", "completeGate40", "exactlyOnceClaimed", "productionReadyClaimed",
    ]) &&
    value.id === PROCESS_CHAOS_EXPERIMENT_ID &&
    value.scope === "Team Workflow Return" &&
    value.evidenceLevel === "narrow-E3" &&
    value.formalFaultWindowCount === 1 &&
    value.gate40CompletedWindows === 1 &&
    value.gate40TotalWindows === 40 &&
    value.completeE3Matrix === false &&
    value.completeGate40 === false &&
    value.exactlyOnceClaimed === false &&
    value.productionReadyClaimed === false;
}

function validEnvironment(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ["platform", "arch", "node", "osRelease", "local", "appServerProcess", "provider"]) &&
    [value.platform, value.arch, value.node, value.osRelease].every(nonEmptyString) &&
    value.local === true && value.appServerProcess === "real-child-process" &&
    isRecord(value.provider) && hasExactKeys(value.provider, ["kind", "realApiCalls", "credentialsRead"]) &&
    value.provider.kind === "deterministic-loopback-fake" &&
    value.provider.realApiCalls === false && value.provider.credentialsRead === false;
}

function validPidTransitions(value: unknown, pids: [number, number, number]): boolean {
  if (!Array.isArray(value) || value.length !== 2 || value.some((item) => !isRecord(item))) return false;
  const [first, second] = value as Array<Record<string, unknown>>;
  return first !== undefined && second !== undefined &&
    hasExactKeys(first, ["event", "previousPid", "successorPid", "changed"]) &&
    hasExactKeys(second, ["event", "previousPid", "successorPid", "changed"]) &&
    first.event === "reload-after-pre-provider-kill" && first.previousPid === pids[0] &&
    first.successorPid === pids[1] && first.changed === true &&
    second?.event === "recovery-after-return-window-kill" && second.previousPid === pids[1] &&
    second.successorPid === pids[2] && second.changed === true;
}

function validWindows(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 2 || value.some((item) => !isRecord(item))) return false;
  const [precondition, formalWindow] = value as Array<Record<string, unknown>>;
  const commonPass = (item: Record<string, unknown>): boolean =>
    hasExactKeys(item, [
      "name", "evidenceRole", "countsTowardGate40", "faultPoint", "recoveryResult", "faultPointConfirmed",
      "ownerKilled", "publicRpcReloaded", "rawJsonReloaded", "leaseWaitObserved", "recovered",
    ]) && item.faultPointConfirmed === true && item.ownerKilled === true && item.publicRpcReloaded === true &&
    item.rawJsonReloaded === true && item.recovered === true;
  return precondition?.name === "no-side-effect-after-turn-start" &&
    precondition.evidenceRole === "persistence-reload-precondition" && precondition.countsTowardGate40 === false &&
    precondition.faultPoint === "turn-persisted-before-provider-request" &&
    precondition.recoveryResult === "state-reloaded-without-provider-request" &&
    precondition.leaseWaitObserved === false && commonPass(precondition) &&
    formalWindow?.name === "return-delivery-with-held-lease" &&
    formalWindow.evidenceRole === "team-workflow-return-fault-window" && formalWindow.countsTowardGate40 === true &&
    formalWindow.faultPoint === "return-response-received-with-job-lease-held" &&
    formalWindow.recoveryResult === "lease-wait-then-return-consumed" &&
    formalWindow.leaseWaitObserved === true && commonPass(formalWindow) &&
    value.filter((item) => isRecord(item) && item.countsTowardGate40 === true).length === 1;
}

function validEvidence(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, [
    "threadId", "jobId", "returnId", "ownerLeaseId", "ownerLeaseDeadline", "providerRequests",
    "providerRequestsByStage", "fakeProvider", "finalJobStatus", "finalReturnStatus",
  ]) || ![value.threadId, value.jobId, value.returnId, value.ownerLeaseId].every(nonEmptyString) ||
    !validDate(value.ownerLeaseDeadline) || !nonNegativeInteger(value.providerRequests) ||
    !validRequestCounts(value.providerRequestsByStage) || !isRecord(value.fakeProvider) ||
    !hasExactKeys(value.fakeProvider, [
      "totalRequests", "requestsByStage", "finalDeliveryRequestsBeforeKill", "finalDeliveryRequestsAfterRecovery",
    ]) ||
    !nonNegativeInteger(value.fakeProvider.totalRequests) || !validRequestCounts(value.fakeProvider.requestsByStage) ||
    !nonNegativeInteger(value.fakeProvider.finalDeliveryRequestsBeforeKill) ||
    !nonNegativeInteger(value.fakeProvider.finalDeliveryRequestsAfterRecovery) ||
    value.finalJobStatus !== "completed" || value.finalReturnStatus !== "consumed") return false;

  const legacyCounts = value.providerRequestsByStage as unknown as FakeProviderRequestCounts;
  const fakeCounts = value.fakeProvider.requestsByStage as unknown as FakeProviderRequestCounts;
  const total = Object.values(fakeCounts).reduce((sum, count) => sum + count, 0);
  return JSON.stringify(legacyCounts) === JSON.stringify(fakeCounts) &&
    value.providerRequests === total && value.fakeProvider.totalRequests === total &&
    value.fakeProvider.finalDeliveryRequestsBeforeKill === 1 &&
    value.fakeProvider.finalDeliveryRequestsAfterRecovery === 1 && fakeCounts.return_god === 1;
}

function validRequestCounts(value: unknown): boolean {
  const keys = ["prepare_requirement_plan", "plan_confirmation", "team_workflow", "return_god"];
  return isRecord(value) && hasExactKeys(value, keys) && keys.every((key) => nonNegativeInteger(value[key]));
}

function validBoundaryPids(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["originalOwner", "successor", "auditor"]) ||
    !positiveInteger(value.originalOwner) || !positiveInteger(value.successor) ||
    value.originalOwner === value.successor) return false;
  return value.auditor === null || (positiveInteger(value.auditor) &&
    value.auditor !== value.originalOwner && value.auditor !== value.successor);
}

function validBoundaryEvidence(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, [
    "threadId", "jobId", "returnId", "persistedReturnStatus", "persistedReturnAttempts",
    "finalReturnStatus", "finalReturnAttempts", "finalJobStatus", "finalDeliveryRequests",
    "returnGodCheckpointCount", "returnGodEvidenceCount",
  ]) && [value.threadId, value.jobId, value.returnId].every(nonEmptyString) &&
    value.persistedReturnStatus === "ready" && value.persistedReturnAttempts === 0 &&
    value.finalReturnStatus === "consumed" && value.finalReturnAttempts === 1 &&
    value.finalJobStatus === "completed" && value.finalDeliveryRequests === 1 &&
    value.returnGodCheckpointCount === 1 && value.returnGodEvidenceCount === 1;
}

function validModelResponseEvidence(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, [
    "threadId", "turnId", "invocationId", "persistedInvocationStatus", "finalInvocationStatus",
    "finalTurnStatus", "providerRequestsBeforeKill", "finalProviderRequests", "assistantMessageCount",
  ]) && [value.threadId, value.turnId, value.invocationId].every(nonEmptyString) &&
    value.persistedInvocationStatus === "response_received" && value.finalInvocationStatus === "committed" &&
    value.finalTurnStatus === "completed" && value.providerRequestsBeforeKill === 1 &&
    value.finalProviderRequests === 1 && value.assistantMessageCount === 1;
}

function validWorkflowStageEvidence(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, [
    "threadId", "jobId", "runId", "stageId", "stageAttempt", "invocationId",
    "persistedInvocationStatus", "persistedCheckpointStatus", "finalInvocationStatus",
    "finalCheckpointStatus", "finalJobStatus", "productInvocationCount", "productCheckpointCount",
    "productEvidenceCount", "productReturnCount",
  ]) && [value.threadId, value.jobId, value.runId, value.invocationId].every(nonEmptyString) &&
    value.stageId === "product" && value.stageAttempt === 1 &&
    value.persistedInvocationStatus === "committed" && value.persistedCheckpointStatus === "running" &&
    value.finalInvocationStatus === "committed" && value.finalCheckpointStatus === "completed" &&
    value.finalJobStatus === "completed" && value.productInvocationCount === 1 &&
    value.productCheckpointCount === 1 && value.productEvidenceCount === 1 && value.productReturnCount === 1;
}

function validLocalEffectEvidence(
  value: unknown,
  persistedToolStatus: "executing" | "result_received",
  proofVerificationRequests: 0 | 1,
  providerRequests: 2 | 3,
  toolInvocationCount: 1 | 2,
): boolean {
  return isRecord(value) && hasExactKeys(value, [
    "helperPid", "helperProcess", "helperLedgerPath", "threadId", "turnId", "operationId",
    "effectId", "effectDigest", "receiptId", "receiptDigest", "proofId", "proofDigest",
    "persistedToolStatus", "finalToolStatus", "effectApplyCount", "helperCreateRequests",
    "helperDuplicateCreateRequests", "proofVerificationRequests", "providerRequests",
    "toolInvocationCount", "targetToolResultCount", "assistantMessageCount", "finalTurnStatus",
  ]) && positiveInteger(value.helperPid) && value.helperProcess === "real-child-process" &&
    value.helperLedgerPath === "effect-ledger.json" &&
    [value.threadId, value.turnId, value.operationId, value.effectId, value.receiptId, value.proofId].every(nonEmptyString) &&
    stableSha256(value.effectDigest) && stableSha256(value.receiptDigest) && stableSha256(value.proofDigest) &&
    value.persistedToolStatus === persistedToolStatus && value.finalToolStatus === "committed" &&
    value.effectApplyCount === 1 && value.helperCreateRequests === 1 &&
    value.helperDuplicateCreateRequests === 0 && value.proofVerificationRequests === proofVerificationRequests &&
    value.providerRequests === providerRequests && value.toolInvocationCount === toolInvocationCount &&
    value.targetToolResultCount === 1 && value.assistantMessageCount === 1 && value.finalTurnStatus === "completed";
}

function validReturnPersistedOracle(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, [
    "id", "ownerKilledAtPersistedBoundary", "successorReloadedPersistedReturn", "returnConsumedOnce",
    "parentAdvancedOnce", "repeatedAdvanceChangedState",
  ]) && value.id === "ORACLE-RETURN-CONSUME-V1" && value.ownerKilledAtPersistedBoundary === true &&
    value.successorReloadedPersistedReturn === true && value.returnConsumedOnce === true &&
    value.parentAdvancedOnce === true && value.repeatedAdvanceChangedState === false;
}

function validFencingOracle(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, [
    "id", "originalFencingToken", "successorFencingToken", "staleCommitRejected", "staleCommitError",
    "successorUniquelyCommitted", "originalOwnerKilled", "auditorReloadedAuthoritativeState",
  ]) && value.id === "ORACLE-FENCING-V1" && positiveInteger(value.originalFencingToken) &&
    positiveInteger(value.successorFencingToken) && Number(value.successorFencingToken) > Number(value.originalFencingToken) &&
    value.staleCommitRejected === true && nonEmptyString(value.staleCommitError) &&
    /fencing token mismatch/u.test(value.staleCommitError) && value.successorUniquelyCommitted === true &&
    value.originalOwnerKilled === true && value.auditorReloadedAuthoritativeState === true;
}

function validModelResponseOracle(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, [
    "id", "ownerKilledAfterResponsePersisted", "successorReplayedPersistedResponse",
    "providerRequestNotRepeated", "assistantCommittedOnce",
  ]) && value.id === "ORACLE-MODEL-WAL-V1" && value.ownerKilledAfterResponsePersisted === true &&
    value.successorReplayedPersistedResponse === true && value.providerRequestNotRepeated === true &&
    value.assistantCommittedOnce === true;
}

function validWorkflowStageOracle(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, [
    "id", "ownerKilledBeforeStageCommit", "successorRecoveredPersistedModelResult",
    "productModelInvocationNotRepeated", "productStageCommittedOnce",
  ]) && value.id === "ORACLE-WORKFLOW-COMMIT-V1" && value.ownerKilledBeforeStageCommit === true &&
    value.successorRecoveredPersistedModelResult === true && value.productModelInvocationNotRepeated === true &&
    value.productStageCommittedOnce === true;
}

function validToolEffectOracle(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, [
    "id", "ownerKilledAfterEffectBeforeToolReceipt", "successorQueriedPersistedEffect",
    "blindReplayAvoided", "effectAppliedOnce", "receiptRecovered",
  ]) && value.id === "ORACLE-TOOL-OUTCOME-V1" &&
    value.ownerKilledAfterEffectBeforeToolReceipt === true && value.successorQueriedPersistedEffect === true &&
    value.blindReplayAvoided === true && value.effectAppliedOnce === true && value.receiptRecovered === true;
}

function validReceiptOracle(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, [
    "id", "ownerKilledAfterReceiptPersisted", "successorBoundPersistedReceipt",
    "toolResultCommittedOnce", "effectAppliedOnce",
  ]) && value.id === "ORACLE-RECEIPT-V1" && value.ownerKilledAfterReceiptPersisted === true &&
    value.successorBoundPersistedReceipt === true && value.toolResultCommittedOnce === true &&
    value.effectAppliedOnce === true;
}

function validProofOracle(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, [
    "id", "ownerKilledAfterProofVerified", "successorBoundPersistedProof", "proofDigestStable",
    "proofToolResultCommittedOnce", "effectAppliedOnce",
  ]) && value.id === "ORACLE-PROOF-V1" && value.ownerKilledAfterProofVerified === true &&
    value.successorBoundPersistedProof === true && value.proofDigestStable === true &&
    value.proofToolResultCommittedOnce === true && value.effectAppliedOnce === true;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareStrings);
  const wanted = [...expected].sort(compareStrings);
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function stableSha256(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isSafeRelativePosixPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/") ||
    value.includes("\\") || /^[a-zA-Z]:/u.test(value)) return false;
  return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
