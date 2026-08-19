import {
  RUNTIME_E2E_FAMILIES,
  RUNTIME_E2E_VARIANTS,
  type RuntimeE2eCaseResult,
  type RuntimeE2eReport,
  type RuntimeE2eSummary,
} from "./types.js";

const REQUIRED_RUNTIME_CLASSES = [
  "AgentLoop",
  "AgentRuntimeStore",
  "JsonFileRuntimePersistence",
  "ModelInvocationStore",
  "PersistentRuntimeLeaseStore",
  "ToolInvocationStore",
  "WorkflowTeamCoordinator",
];

export function validateRuntimeE2eReport(value: unknown): asserts value is RuntimeE2eReport {
  const errors: string[] = [];
  if (!isRecord(value)) throw new Error("Runtime-E2E report schema violation: root");
  if (value.schemaVersion !== "runtime-e2e-report-v1") errors.push("schemaVersion");
  if (value.benchmark !== "Runtime-E2E-GATE-30" && value.benchmark !== "Runtime-E2E-GATE-100") errors.push("benchmark");
  if (!Number.isSafeInteger(value.fixtureSeed) || value.generatorVersion !== "runtime-e2e-generator-v1") errors.push("fixture");
  if (!validShard(value.shard)) errors.push("shard");
  if (!validVariants(value.variants)) errors.push("variants");
  if (typeof value.runStartedAt !== "string" || !Number.isFinite(Date.parse(value.runStartedAt))) errors.push("runStartedAt");
  if (!validImplementation(value.implementation)) errors.push("implementation");
  if (!validMethodology(value.methodology)) errors.push("methodology");
  if (!isRecord(value.environment) || value.environment.local !== true ||
    ![value.environment.platform, value.environment.arch, value.environment.node].every((item) => typeof item === "string" && item.length > 0)) errors.push("environment");
  if (!Array.isArray(value.cases) || value.cases.some((item) => !validCase(item))) errors.push("cases");
  if (!Array.isArray(value.summaries) || value.summaries.some((item) => !validSummary(item))) errors.push("summaries");
  if (Array.isArray(value.cases) && Array.isArray(value.variants)) {
    const identities = value.cases.filter(isRecord).map((item) => `${String(item.variant)}:${String(item.caseId)}`);
    if (new Set(identities).size !== identities.length) errors.push("duplicate-case-identity");
    if (value.cases.some((item) => isRecord(item) && item.variant === "baseline" && item.taskSuccess !== true)) errors.push("baseline-invariant-failure");
    if (value.cases.some((item) => isRecord(item) && item.snapshotReloaded !== true && item.variant === "baseline")) errors.push("baseline-without-snapshot-reload");
  }
  if (errors.length > 0) throw new Error(`Runtime-E2E report schema violation: ${errors.join(", ")}`);
}

function validImplementation(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.runtimeClasses)) return false;
  const runtimeClasses = value.runtimeClasses;
  return value.check === "production-runtime" &&
    value.persistence === "JsonFileRuntimePersistence" && value.protocolSimulatorUsed === false &&
    REQUIRED_RUNTIME_CLASSES.every((name) => runtimeClasses.includes(name));
}

function validMethodology(value: unknown): boolean {
  return isRecord(value) && isRecord(value.provider) && value.provider.kind === "deterministic-fake" &&
    value.provider.realApiCalls === false && value.provider.credentialsRead === false &&
    isRecord(value.tool) && value.tool.kind === "deterministic-fake" && value.tool.effects === "local-temporary-journal" &&
    value.latency === "measured local wall-clock; not production capacity" &&
    value.claims === "implementation correctness only; not real-provider or production-capacity evidence";
}

function validCase(value: unknown): value is RuntimeE2eCaseResult {
  if (!isRecord(value)) return false;
  return typeof value.caseId === "string" && value.caseId.length > 0 && Number.isSafeInteger(value.caseIndex) &&
    Number.isSafeInteger(value.scenarioSeed) && typeof value.family === "string" && RUNTIME_E2E_FAMILIES.includes(value.family as never) &&
    typeof value.checkpoint === "string" && typeof value.variant === "string" && RUNTIME_E2E_VARIANTS.includes(value.variant as never) &&
    typeof value.taskSuccess === "boolean" && typeof value.recoveryAttempted === "boolean" &&
    (typeof value.recoverySuccess === "boolean" || value.recoverySuccess === null) && typeof value.snapshotReloaded === "boolean" &&
    ["stateFileWrites", "stateFileLoads", "modelCalls", "duplicateModelCalls", "toolEffects", "duplicateToolEffects", "evidenceRequired", "evidenceProduced", "evidenceCompleteness", "wallClockDurationMs"]
      .every((key) => nonNegative(value[key])) && Number(value.stateFileWrites) >= 1 && Number(value.stateFileLoads) >= 1 &&
    typeof value.unknownOutcome === "boolean" && Number(value.evidenceProduced) <= Number(value.evidenceRequired) &&
    Number(value.evidenceCompleteness) >= 0 && Number(value.evidenceCompleteness) <= 1 && typeof value.recoveryResult === "string" &&
    Array.isArray(value.productionClasses) && value.productionClasses.includes("JsonFileRuntimePersistence") &&
    value.productionClasses.every((item) => typeof item === "string") && Array.isArray(value.invariants) && value.invariants.every((item) => typeof item === "string") &&
    Array.isArray(value.failureCodes) && value.failureCodes.every((item) => typeof item === "string") &&
    !("latencyMs" in value) && !("simulatedLatencyMs" in value) && !("protocolState" in value);
}

function validSummary(value: unknown): value is RuntimeE2eSummary {
  return isRecord(value) && typeof value.variant === "string" && RUNTIME_E2E_VARIANTS.includes(value.variant as never) &&
    Number.isSafeInteger(value.cases) && validRate(value.taskSuccess) && validRate(value.recoverySuccess) && validRate(value.unknownOutcome) &&
    nonNegative(value.duplicateModelCalls) && nonNegative(value.duplicateToolEffects) && nonNegative(value.evidenceCompleteness) && Number(value.evidenceCompleteness) <= 1 &&
    isRecord(value.wallClockMs) && value.wallClockMs.kind === "measured-local-wall-clock" &&
    nonNegative(value.wallClockMs.total) && nonNegative(value.wallClockMs.p50) && nonNegative(value.wallClockMs.p95);
}

function validRate(value: unknown): boolean {
  return isRecord(value) && nonNegative(value.count) && nonNegative(value.total) && nonNegative(value.rate) && Number(value.rate) <= 1;
}

function validShard(value: unknown): boolean {
  return isRecord(value) && Number.isSafeInteger(value.index) && Number.isSafeInteger(value.total) &&
    Number(value.total) >= 1 && Number(value.index) >= 1 && Number(value.index) <= Number(value.total);
}

function validVariants(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && RUNTIME_E2E_VARIANTS.includes(item as never)) &&
    new Set(value).size === value.length;
}

function nonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
