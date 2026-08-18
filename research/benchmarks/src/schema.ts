import {
  BENCHMARK_VARIANTS,
  SCENARIO_CATEGORIES,
  type BenchmarkReport,
  type BenchmarkSummary,
} from "./types.js";

export function validateBenchmarkReport(value: unknown): asserts value is BenchmarkReport {
  const errors: string[] = [];
  if (!isRecord(value)) throw new Error("Benchmark report schema violation: root must be an object");
  if (value.schemaVersion !== "gate-benchmark-result-v1") errors.push("schemaVersion");
  if (value.benchmark !== "GATE-30" && value.benchmark !== "GATE-100") errors.push("benchmark");
  if (!isInteger(value.fixtureSeed)) errors.push("fixtureSeed");
  if (value.generatorVersion !== "gate-generator-v1" || value.deterministic !== true) errors.push("generator/deterministic");
  if (!isRecord(value.shard) || !isInteger(value.shard.index) || !isInteger(value.shard.total)
    || Number(value.shard.index) < 1 || Number(value.shard.total) < Number(value.shard.index)) errors.push("shard");
  if (!Array.isArray(value.variants) || value.variants.some((item) => typeof item !== "string" || !BENCHMARK_VARIANTS.includes(item as never))) errors.push("variants");
  if (!isRecord(value.pricing) || value.pricing.currency !== "USD" || !isNumber(value.pricing.inputPerMillionTokens)
    || !isNumber(value.pricing.outputPerMillionTokens) || typeof value.pricing.note !== "string") errors.push("pricing");
  if (!isRecord(value.methodology) || value.methodology.provider !== "deterministic-mock") errors.push("methodology");
  if (!Array.isArray(value.summaries) || value.summaries.some((item) => !validSummary(item))) errors.push("summaries");
  if (!Array.isArray(value.cases) || value.cases.some((item) => !validCase(item))) errors.push("cases");
  if (errors.length > 0) throw new Error(`Benchmark report schema violation: ${errors.join(", ")}`);
}

function validSummary(value: unknown): value is BenchmarkSummary {
  if (!isRecord(value) || typeof value.variant !== "string" || !BENCHMARK_VARIANTS.includes(value.variant as never)) return false;
  return isInteger(value.cases)
    && validRate(value.taskSuccess)
    && validRate(value.recoverySuccess)
    && isNonNegative(value.duplicateModelCalls)
    && isNonNegative(value.duplicateToolEffects)
    && validRate(value.unknownOutcomeRate)
    && inUnitInterval(value.evidenceCompleteness)
    && isRecord(value.latencyMs) && value.latencyMs.kind === "deterministic-simulated"
    && isNonNegative(value.latencyMs.p50) && isNonNegative(value.latencyMs.p95)
    && isRecord(value.tokens) && isNonNegative(value.tokens.input) && isNonNegative(value.tokens.output) && isNonNegative(value.tokens.total)
    && isNonNegative(value.costEstimateUsd);
}

function validCase(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.caseId === "string"
    && isInteger(value.caseIndex)
    && isInteger(value.scenarioSeed)
    && typeof value.category === "string" && SCENARIO_CATEGORIES.includes(value.category as never)
    && typeof value.variant === "string" && BENCHMARK_VARIANTS.includes(value.variant as never)
    && typeof value.taskSuccess === "boolean"
    && typeof value.recoveryAttempted === "boolean"
    && (typeof value.recoverySuccess === "boolean" || value.recoverySuccess === null)
    && ["modelCalls", "duplicateModelCalls", "toolEffects", "duplicateToolEffects", "evidenceRequired", "evidenceProduced", "latencyMs", "inputTokens", "outputTokens", "costEstimateUsd"].every((key) => isNonNegative(value[key]))
    && typeof value.unknownOutcome === "boolean"
    && inUnitInterval(value.evidenceCompleteness)
    && Array.isArray(value.failureCodes) && value.failureCodes.every((item) => typeof item === "string")
    && Array.isArray(value.trace) && value.trace.every((item) => typeof item === "string");
}

function validRate(value: unknown): boolean {
  return isRecord(value) && isNonNegative(value.count) && isNonNegative(value.total) && inUnitInterval(value.rate);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
  return Number.isInteger(value);
}

function isNonNegative(value: unknown): value is number {
  return isNumber(value) && value >= 0;
}

function inUnitInterval(value: unknown): value is number {
  return isNumber(value) && value >= 0 && value <= 1;
}
