export const PROCESS_CHAOS_REPORT_SCHEMA_VERSION = "process-chaos-report-v1" as const;
export const PROCESS_CHAOS_EXPERIMENT_ID = "team-workflow-return-narrow-e3-v1" as const;
export const PROCESS_CHAOS_REPRO_COMMAND =
  "npm exec -- tsx research/runtime-e2e-benchmarks/src/process-chaos-cli.ts --seed <seed> --output <directory>";

export function processChaosReproCommand(seed: string): string {
  return `npm exec -- tsx research/runtime-e2e-benchmarks/src/process-chaos-cli.ts --seed ${seed} --output <directory>`;
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
