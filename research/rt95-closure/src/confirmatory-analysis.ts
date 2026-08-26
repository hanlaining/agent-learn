import { createHash } from "node:crypto";

import {
  holmBonferroni,
  validateRawResults,
  wilson95,
  type RawResultRecord,
  type Rt95RawResults,
} from "./statistics.js";

export const CONFIRMATORY_PLAN_SCHEMA_VERSION = "rt95-confirmatory-analysis-plan-v1" as const;
export const CONFIRMATORY_REPORT_SCHEMA_VERSION = "rt95-confirmatory-analysis-report-v1" as const;
export const CONFIRMATORY_PLAN_BOUNDARY = "draft-analysis-contract-only-not-frozen" as const;
export const CONFIRMATORY_REPORT_BOUNDARY = "pipeline-validation-only-not-formal-result" as const;

export interface ConfirmatoryAnalysisPlan {
  schemaVersion: typeof CONFIRMATORY_PLAN_SCHEMA_VERSION;
  claimBoundary: typeof CONFIRMATORY_PLAN_BOUNDARY;
  lifecycle: "draft";
  alpha: 0.05;
  confidenceLevel: 0.95;
  pairUnit: "seed+faultWindowId";
  test: "exact-mcnemar-two-sided";
  interval: "discordant-wilson-matched-odds-ratio";
  multiplicity: "holm-bonferroni";
  family: Array<{ analysisId: string; comparatorArmId: string }>;
}

export interface ConfirmatoryAnalysisReport {
  schemaVersion: typeof CONFIRMATORY_REPORT_SCHEMA_VERSION;
  claimBoundary: typeof CONFIRMATORY_REPORT_BOUNDARY;
  formalVerified: false;
  significanceClaimed: false;
  experimentId: string;
  baselineArmId: string;
  rawSha256: string;
  planSha256: string;
  methodology: {
    pairUnit: "seed+faultWindowId";
    test: "exact-mcnemar-two-sided";
    interval: "discordant-wilson-matched-odds-ratio";
    multiplicity: "holm-bonferroni";
    alpha: 0.05;
    confidenceLevel: 0.95;
  };
  analyses: Array<{
    analysisId: string;
    comparatorArmId: string;
    totalPairs: number;
    baselineOnlySuccess: number;
    comparatorOnlySuccess: number;
    discordantPairs: number;
    exactTwoSidedPValue: number;
    holmAdjustedPValue: number;
    rejectedUnderDraftPlan: boolean;
    discordantBaselineWinProbability95: {
      method: "wilson-score";
      estimate: number | null;
      lower: number | null;
      upper: number | null;
    };
    matchedOddsRatio95: {
      method: "wilson-transformed-matched-odds-ratio";
      estimate: number | null;
      lower: number | null;
      upper: number | null;
      status: "finite" | "positive-over-zero" | "zero-over-positive" | "no-discordance" | "upper-unbounded";
    };
  }>;
  multiplicity: {
    method: "holm-bonferroni";
    applied: true;
    familySize: number;
    alpha: 0.05;
  };
  conclusionBoundary: "Rejection flags are deterministic Draft-plan outputs only; formal claims require Frozen inputs, authentic Raw, and independent review.";
}

type JsonObject = Record<string, unknown>;

export function validateConfirmatoryAnalysisPlan(
  value: unknown,
  rawValue?: unknown,
): ConfirmatoryAnalysisPlan {
  const root = object(value, "confirmatory plan");
  exactKeys(root, ["schemaVersion", "claimBoundary", "lifecycle", "alpha", "confidenceLevel", "pairUnit", "test", "interval", "multiplicity", "family"], "confirmatory plan");
  equal(root.schemaVersion, CONFIRMATORY_PLAN_SCHEMA_VERSION, "plan.schemaVersion");
  equal(root.claimBoundary, CONFIRMATORY_PLAN_BOUNDARY, "plan.claimBoundary");
  equal(root.lifecycle, "draft", "plan.lifecycle");
  equal(root.alpha, 0.05, "plan.alpha");
  equal(root.confidenceLevel, 0.95, "plan.confidenceLevel");
  equal(root.pairUnit, "seed+faultWindowId", "plan.pairUnit");
  equal(root.test, "exact-mcnemar-two-sided", "plan.test");
  equal(root.interval, "discordant-wilson-matched-odds-ratio", "plan.interval");
  equal(root.multiplicity, "holm-bonferroni", "plan.multiplicity");
  const ids = new Set<string>();
  const comparators = new Set<string>();
  const family = array(root.family, "plan.family").map((item, index) => {
    const entry = object(item, `plan.family[${index}]`);
    exactKeys(entry, ["analysisId", "comparatorArmId"], `plan.family[${index}]`);
    const analysisId = machineId(entry.analysisId, `plan.family[${index}].analysisId`);
    const comparatorArmId = machineId(entry.comparatorArmId, `plan.family[${index}].comparatorArmId`);
    if (ids.has(analysisId)) fail(`duplicate analysisId: ${analysisId}`);
    if (comparators.has(comparatorArmId)) fail(`duplicate comparatorArmId: ${comparatorArmId}`);
    ids.add(analysisId);
    comparators.add(comparatorArmId);
    return { analysisId, comparatorArmId };
  }).sort((left, right) => compare(left.analysisId, right.analysisId));
  if (family.length === 0) fail("plan family cannot be empty");
  if (rawValue !== undefined) {
    const raw = validateRawResults(rawValue);
    const expectedComparators = [...new Set(raw.records.map((record) => record.armId))]
      .filter((armId) => armId !== raw.baselineArmId)
      .sort(compare);
    const actualComparators = family.map((entry) => entry.comparatorArmId).sort(compare);
    if (JSON.stringify(actualComparators) !== JSON.stringify(expectedComparators)) {
      fail("plan family must cover every Raw comparator exactly once");
    }
  }
  return { ...(value as ConfirmatoryAnalysisPlan), family };
}

export function exactMcNemarTwoSided(
  baselineOnlySuccess: number,
  comparatorOnlySuccess: number,
): number {
  nonNegativeInteger(baselineOnlySuccess, "baselineOnlySuccess");
  nonNegativeInteger(comparatorOnlySuccess, "comparatorOnlySuccess");
  const discordant = baselineOnlySuccess + comparatorOnlySuccess;
  if (discordant === 0) return 1;
  const tailEnd = Math.min(baselineOnlySuccess, comparatorOnlySuccess);
  let lowerTail = 0;
  for (let successes = 0; successes <= tailEnd; successes += 1) {
    lowerTail += Math.exp(logBinomialCoefficient(discordant, successes) - (discordant * Math.log(2)));
  }
  return rounded(Math.min(1, 2 * lowerTail));
}

export function analyzeConfirmatoryRaw(
  rawValue: unknown,
  planValue: unknown,
): ConfirmatoryAnalysisReport {
  const raw = validateRawResults(rawValue);
  const plan = validateConfirmatoryAnalysisPlan(planValue, raw);
  const byArm = groupByArmAndPair(raw);
  const baselinePairs = byArm.get(raw.baselineArmId)!;
  const unadjusted = plan.family.map((entry) => {
    const comparatorPairs = byArm.get(entry.comparatorArmId)!;
    let baselineOnlySuccess = 0;
    let comparatorOnlySuccess = 0;
    for (const [pair, baseline] of baselinePairs.entries()) {
      const comparator = comparatorPairs.get(pair)!;
      if (baseline.outcome === "success" && comparator.outcome === "failure") baselineOnlySuccess += 1;
      else if (baseline.outcome === "failure" && comparator.outcome === "success") comparatorOnlySuccess += 1;
    }
    return {
      entry,
      baselineOnlySuccess,
      comparatorOnlySuccess,
      pValue: exactMcNemarTwoSided(baselineOnlySuccess, comparatorOnlySuccess),
    };
  });
  const adjusted = new Map(
    holmBonferroni(unadjusted.map((item) => ({ id: item.entry.analysisId, pValue: item.pValue })))
      .map((item) => [item.id, item.adjustedPValue]),
  );
  const analyses = unadjusted.map((item) => {
    const discordantPairs = item.baselineOnlySuccess + item.comparatorOnlySuccess;
    const interval = discordantPairs === 0 ? null : wilson95(item.baselineOnlySuccess, discordantPairs);
    const adjustedPValue = adjusted.get(item.entry.analysisId)!;
    return {
      analysisId: item.entry.analysisId,
      comparatorArmId: item.entry.comparatorArmId,
      totalPairs: baselinePairs.size,
      baselineOnlySuccess: item.baselineOnlySuccess,
      comparatorOnlySuccess: item.comparatorOnlySuccess,
      discordantPairs,
      exactTwoSidedPValue: item.pValue,
      holmAdjustedPValue: adjustedPValue,
      rejectedUnderDraftPlan: adjustedPValue <= plan.alpha,
      discordantBaselineWinProbability95: {
        method: "wilson-score" as const,
        estimate: interval?.estimate ?? null,
        lower: interval?.lower ?? null,
        upper: interval?.upper ?? null,
      },
      matchedOddsRatio95: matchedOddsRatio(item.baselineOnlySuccess, item.comparatorOnlySuccess, interval),
    };
  });
  return {
    schemaVersion: CONFIRMATORY_REPORT_SCHEMA_VERSION,
    claimBoundary: CONFIRMATORY_REPORT_BOUNDARY,
    formalVerified: false,
    significanceClaimed: false,
    experimentId: raw.experimentId,
    baselineArmId: raw.baselineArmId,
    rawSha256: digestCanonical(raw),
    planSha256: digestCanonical(plan),
    methodology: {
      pairUnit: plan.pairUnit,
      test: plan.test,
      interval: plan.interval,
      multiplicity: plan.multiplicity,
      alpha: plan.alpha,
      confidenceLevel: plan.confidenceLevel,
    },
    analyses,
    multiplicity: { method: "holm-bonferroni", applied: true, familySize: analyses.length, alpha: plan.alpha },
    conclusionBoundary: "Rejection flags are deterministic Draft-plan outputs only; formal claims require Frozen inputs, authentic Raw, and independent review.",
  };
}

export function validateConfirmatoryAnalysisReport(
  value: unknown,
  rawValue: unknown,
  planValue: unknown,
): ConfirmatoryAnalysisReport {
  const expected = analyzeConfirmatoryRaw(rawValue, planValue);
  if (canonicalJson(value) !== canonicalJson(expected)) fail("confirmatory report does not deterministically match Raw and Draft plan");
  return value as ConfirmatoryAnalysisReport;
}

function matchedOddsRatio(
  baselineOnly: number,
  comparatorOnly: number,
  interval: ReturnType<typeof wilson95> | null,
): ConfirmatoryAnalysisReport["analyses"][number]["matchedOddsRatio95"] {
  if (interval === null) {
    return { method: "wilson-transformed-matched-odds-ratio", estimate: null, lower: null, upper: null, status: "no-discordance" };
  }
  const lower = odds(interval.lower);
  const upper = odds(interval.upper);
  if (comparatorOnly === 0) {
    return {
      method: "wilson-transformed-matched-odds-ratio",
      estimate: null,
      lower,
      upper,
      status: upper === null ? "upper-unbounded" : "positive-over-zero",
    };
  }
  if (baselineOnly === 0) {
    return { method: "wilson-transformed-matched-odds-ratio", estimate: 0, lower, upper, status: "zero-over-positive" };
  }
  return {
    method: "wilson-transformed-matched-odds-ratio",
    estimate: rounded(baselineOnly / comparatorOnly),
    lower,
    upper,
    status: upper === null ? "upper-unbounded" : "finite",
  };
}

function odds(probability: number): number | null {
  if (probability >= 1) return null;
  return rounded(probability / (1 - probability));
}

function groupByArmAndPair(raw: Rt95RawResults): Map<string, Map<string, RawResultRecord>> {
  const result = new Map<string, Map<string, RawResultRecord>>();
  for (const record of raw.records) {
    const arm = result.get(record.armId) ?? new Map<string, RawResultRecord>();
    arm.set(`${String(record.seed).padStart(10, "0")}:${record.faultWindowId}`, record);
    result.set(record.armId, arm);
  }
  return result;
}

function logBinomialCoefficient(total: number, successes: number): number {
  const count = Math.min(successes, total - successes);
  let result = 0;
  for (let index = 1; index <= count; index += 1) {
    result += Math.log(total - count + index) - Math.log(index);
  }
  return result;
}

function digestCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const record = value as JsonObject;
  return Object.fromEntries(Object.keys(record).sort(compare).map((key) => [key, sortKeys(record[key])]));
}

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value as JsonObject;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function exactKeys(value: JsonObject, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(compare);
  const wanted = [...expected].sort(compare);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail(`${label} key mismatch`);
}

function machineId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) fail(`${label} must be a machine ID`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail(`${label} must be a non-negative integer`);
  return Number(value);
}

function equal(actual: unknown, expected: unknown, label: string): void {
  if (!Object.is(actual, expected)) fail(`${label} must equal ${JSON.stringify(expected)}`);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function rounded(value: number): number {
  return Number(value.toFixed(12));
}

function fail(message: string): never {
  throw new Error(`RT95 confirmatory analysis validation failed: ${message}`);
}
