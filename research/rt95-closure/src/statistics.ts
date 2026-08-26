export const RT95_RAW_RESULTS_SCHEMA_VERSION = "rt95-raw-results-v1" as const;
export const RT95_STATISTICS_REPORT_SCHEMA_VERSION = "rt95-statistics-report-v1" as const;
export const NORMAL_95_TWO_SIDED_Z = 1.959963984540054;
export const DEFAULT_PAIRED_BOOTSTRAP_SEED = 20260824;
export const DEFAULT_PAIRED_BOOTSTRAP_ITERATIONS = 10_000;

export type BinaryOutcome = "success" | "failure";

export interface RawResultRecord {
  runId: string;
  armId: string;
  seed: number;
  faultWindowId: string;
  outcome: BinaryOutcome;
  latencyMs: number;
}

export interface Rt95RawResults {
  schemaVersion: typeof RT95_RAW_RESULTS_SCHEMA_VERSION;
  experimentId: string;
  baselineArmId: string;
  records: RawResultRecord[];
}

export interface WilsonInterval {
  method: "wilson-score";
  confidenceLevel: 0.95;
  successes: number;
  total: number;
  estimate: number;
  lower: number;
  upper: number;
}

export interface ZeroFailureUpperBound {
  method: "exact-one-sided-zero-event";
  confidenceLevel: 0.95;
  failures: 0;
  total: number;
  upper: number;
}

export interface PairedBinaryEffect {
  method: "paired-binary-descriptive";
  totalPairs: number;
  bothSuccess: number;
  baselineOnlySuccess: number;
  comparatorOnlySuccess: number;
  bothFailure: number;
  absoluteRateDifference: number;
  discordantOddsRatio: number | null;
}

export interface RateRatioResult {
  method: "rate-ratio";
  baselineRate: number;
  comparatorRate: number;
  estimate: number | null;
  status: "finite" | "positive-over-zero" | "undefined-both-zero";
}

export interface PairedBootstrapInterval {
  method: "paired-bootstrap-percentile";
  confidenceLevel: 0.95;
  descriptiveOnly: true;
  seed: number;
  iterations: number;
  estimate: number;
  lower: number;
  upper: number;
}

export interface HolmAdjustedValue {
  id: string;
  rawPValue: number;
  adjustedPValue: number;
}

export interface Rt95StatisticsReport {
  schemaVersion: typeof RT95_STATISTICS_REPORT_SCHEMA_VERSION;
  experimentId: string;
  baselineArmId: string;
  methodology: {
    significanceClaimed: false;
    wilson95: "two-sided Wilson score interval with z=1.959963984540054";
    zeroFailure95: "one-sided exact upper bound 1 - 0.05^(1/n)";
    median: "sorted middle value; even n uses arithmetic mean of the two middle values";
    p95: "nearest-rank: sorted[ceil(0.95*n)-1]";
    pairedEffect: "baseline minus comparator on identical seed+faultWindow pairs; descriptive only";
    pairedBootstrap95: "deterministic paired percentile bootstrap with xorshift32-v1; descriptive only";
    rateRatio: "baseline success rate divided by comparator success rate; zero denominator is explicit";
    holmBonferroni: "implemented for preregistered p-value families; not applied because Raw v1 accepts no p-values";
  };
  rawQa: {
    status: "passed";
    recordCount: number;
    armIds: string[];
    pairCount: number;
  };
  arms: Array<{
    armId: string;
    successes: number;
    failures: number;
    total: number;
    successRate: WilsonInterval;
    zeroFailureUpper95: ZeroFailureUpperBound | null;
    latencyMs: { median: number; p95: number };
  }>;
  comparisons: Array<{
    baselineArmId: string;
    comparatorArmId: string;
    baselineSuccessRate: number;
    comparatorSuccessRate: number;
    absoluteRateDifference: number;
    rateRatio: RateRatioResult;
    paired: PairedBinaryEffect;
    pairedBootstrap95: PairedBootstrapInterval;
  }>;
  multiplicity: {
    method: "holm-bonferroni";
    applied: false;
    significanceClaimed: false;
    adjustedPValues: [];
    reason: "Raw v1 contains no preregistered p-values; adjustment function is available but not auto-applied";
  };
}

type JsonObject = Record<string, unknown>;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const UINT32_MAX = 0xffff_ffff;

export function wilson95(successes: number, total: number): WilsonInterval {
  count(successes, "successes");
  positiveCount(total, "total");
  if (successes > total) fail("successes cannot exceed total");
  const estimate = successes / total;
  const z2 = NORMAL_95_TWO_SIDED_Z ** 2;
  const denominator = 1 + z2 / total;
  const center = (estimate + z2 / (2 * total)) / denominator;
  const margin = NORMAL_95_TWO_SIDED_Z * Math.sqrt((estimate * (1 - estimate) / total) + (z2 / (4 * total ** 2))) / denominator;
  return {
    method: "wilson-score",
    confidenceLevel: 0.95,
    successes,
    total,
    estimate: rounded(estimate),
    lower: rounded(Math.max(0, center - margin)),
    upper: rounded(Math.min(1, center + margin)),
  };
}

export function zeroFailureUpper95(total: number): ZeroFailureUpperBound {
  positiveCount(total, "total");
  return {
    method: "exact-one-sided-zero-event",
    confidenceLevel: 0.95,
    failures: 0,
    total,
    upper: rounded(1 - (0.05 ** (1 / total))),
  };
}

export function absoluteRateDifference(
  baselineSuccesses: number,
  baselineTotal: number,
  comparatorSuccesses: number,
  comparatorTotal: number,
): number {
  count(baselineSuccesses, "baselineSuccesses");
  positiveCount(baselineTotal, "baselineTotal");
  count(comparatorSuccesses, "comparatorSuccesses");
  positiveCount(comparatorTotal, "comparatorTotal");
  if (baselineSuccesses > baselineTotal || comparatorSuccesses > comparatorTotal) fail("successes cannot exceed total");
  return rounded((baselineSuccesses / baselineTotal) - (comparatorSuccesses / comparatorTotal));
}

export function rateRatio(
  baselineSuccesses: number,
  baselineTotal: number,
  comparatorSuccesses: number,
  comparatorTotal: number,
): RateRatioResult {
  count(baselineSuccesses, "baselineSuccesses");
  positiveCount(baselineTotal, "baselineTotal");
  count(comparatorSuccesses, "comparatorSuccesses");
  positiveCount(comparatorTotal, "comparatorTotal");
  if (baselineSuccesses > baselineTotal || comparatorSuccesses > comparatorTotal) fail("successes cannot exceed total");
  const rawBaselineRate = baselineSuccesses / baselineTotal;
  const rawComparatorRate = comparatorSuccesses / comparatorTotal;
  const baselineRate = rounded(rawBaselineRate);
  const comparatorRate = rounded(rawComparatorRate);
  if (comparatorSuccesses === 0) {
    return {
      method: "rate-ratio",
      baselineRate,
      comparatorRate,
      estimate: null,
      status: baselineSuccesses === 0 ? "undefined-both-zero" : "positive-over-zero",
    };
  }
  return {
    method: "rate-ratio",
    baselineRate,
    comparatorRate,
    estimate: rounded(rawBaselineRate / rawComparatorRate),
    status: "finite",
  };
}

export function pairedBinaryEffect(
  baseline: readonly BinaryOutcome[],
  comparator: readonly BinaryOutcome[],
): PairedBinaryEffect {
  if (baseline.length === 0 || baseline.length !== comparator.length) fail("paired outcomes must have the same positive length");
  let bothSuccess = 0;
  let baselineOnlySuccess = 0;
  let comparatorOnlySuccess = 0;
  let bothFailure = 0;
  for (let index = 0; index < baseline.length; index += 1) {
    const left = outcome(baseline[index], `baseline[${index}]`);
    const right = outcome(comparator[index], `comparator[${index}]`);
    if (left === "success" && right === "success") bothSuccess += 1;
    else if (left === "success") baselineOnlySuccess += 1;
    else if (right === "success") comparatorOnlySuccess += 1;
    else bothFailure += 1;
  }
  return {
    method: "paired-binary-descriptive",
    totalPairs: baseline.length,
    bothSuccess,
    baselineOnlySuccess,
    comparatorOnlySuccess,
    bothFailure,
    absoluteRateDifference: rounded((baselineOnlySuccess - comparatorOnlySuccess) / baseline.length),
    discordantOddsRatio: comparatorOnlySuccess === 0 ? null : rounded(baselineOnlySuccess / comparatorOnlySuccess),
  };
}

export function pairedBootstrapRateDifference(
  baseline: readonly BinaryOutcome[],
  comparator: readonly BinaryOutcome[],
  options: { seed?: number; iterations?: number } = {},
): PairedBootstrapInterval {
  if (baseline.length === 0 || baseline.length !== comparator.length) fail("paired outcomes must have the same positive length");
  const seed = options.seed ?? DEFAULT_PAIRED_BOOTSTRAP_SEED;
  const iterations = options.iterations ?? DEFAULT_PAIRED_BOOTSTRAP_ITERATIONS;
  uint32(seed, "bootstrap seed");
  if (seed === 0) fail("bootstrap seed must be non-zero for xorshift32-v1");
  positiveCount(iterations, "bootstrap iterations");
  if (iterations < 100 || iterations > 1_000_000) fail("bootstrap iterations must be between 100 and 1000000");
  const differences = baseline.map((value, index) => {
    const left = outcome(value, `baseline[${index}]`) === "success" ? 1 : 0;
    const right = outcome(comparator[index], `comparator[${index}]`) === "success" ? 1 : 0;
    return left - right;
  });
  const random = xorshift32(seed);
  const replicates = Array.from({ length: iterations }, () => {
    let sum = 0;
    for (let draw = 0; draw < differences.length; draw += 1) {
      const index = Math.floor((random() / 0x1_0000_0000) * differences.length);
      sum += differences[index]!;
    }
    return sum / differences.length;
  }).sort((left, right) => left - right);
  return {
    method: "paired-bootstrap-percentile",
    confidenceLevel: 0.95,
    descriptiveOnly: true,
    seed,
    iterations,
    estimate: rounded(differences.reduce((sum, value) => sum + value, 0) / differences.length),
    lower: rounded(nearestRank(replicates, 0.025)),
    upper: rounded(nearestRank(replicates, 0.975)),
  };
}

export function holmBonferroni(values: readonly { id: string; pValue: number }[]): HolmAdjustedValue[] {
  if (values.length === 0) fail("Holm family cannot be empty");
  const ids = new Set<string>();
  const ordered = values.map((value, index) => {
    const valueId = id(value.id, `Holm values[${index}].id`);
    if (ids.has(valueId)) fail(`duplicate Holm analysis ID: ${valueId}`);
    ids.add(valueId);
    return { id: valueId, pValue: probability(value.pValue, `Holm values[${index}].pValue`) };
  }).sort((left, right) => left.pValue - right.pValue || compareStrings(left.id, right.id));
  let runningMaximum = 0;
  const adjusted = ordered.map((value, index) => {
    runningMaximum = Math.max(runningMaximum, (ordered.length - index) * value.pValue);
    return {
      id: value.id,
      rawPValue: rounded(value.pValue),
      adjustedPValue: rounded(Math.min(1, runningMaximum)),
    };
  });
  return adjusted.sort((left, right) => compareStrings(left.id, right.id));
}

export function median(values: readonly number[]): number {
  const ordered = finiteValues(values, "median values");
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return rounded(ordered[middle]!);
  return rounded((ordered[middle - 1]! + ordered[middle]!) / 2);
}

export function percentile95NearestRank(values: readonly number[]): number {
  const ordered = finiteValues(values, "p95 values");
  return rounded(ordered[Math.ceil(0.95 * ordered.length) - 1]!);
}

export function validateRawResults(value: unknown): Rt95RawResults {
  const root = object(value, "root");
  exactKeys(root, ["schemaVersion", "experimentId", "baselineArmId", "records"], "root");
  equal(root.schemaVersion, RT95_RAW_RESULTS_SCHEMA_VERSION, "schemaVersion");
  const experimentId = id(root.experimentId, "experimentId");
  const baselineArmId = id(root.baselineArmId, "baselineArmId");
  const rawRecords = array(root.records, "records");
  if (rawRecords.length === 0) fail("records cannot be empty");
  const runIds = new Set<string>();
  const pairByArm = new Map<string, Map<string, RawResultRecord>>();
  const records = rawRecords.map((entry, index): RawResultRecord => {
    const record = object(entry, `records[${index}]`);
    exactKeys(record, ["runId", "armId", "seed", "faultWindowId", "outcome", "latencyMs"], `records[${index}]`);
    const runId = id(record.runId, `records[${index}].runId`);
    if (runIds.has(runId)) fail(`duplicate runId: ${runId}`);
    runIds.add(runId);
    const armId = id(record.armId, `records[${index}].armId`);
    const seed = uint32(record.seed, `records[${index}].seed`);
    const faultWindowId = id(record.faultWindowId, `records[${index}].faultWindowId`);
    const result = outcome(record.outcome, `records[${index}].outcome`);
    const latencyMs = finiteNonNegative(record.latencyMs, `records[${index}].latencyMs`);
    const pairKey = pairIdentity(seed, faultWindowId);
    const pairs = pairByArm.get(armId) ?? new Map<string, RawResultRecord>();
    if (pairs.has(pairKey)) fail(`duplicate arm/seed/fault pair: ${armId}/${pairKey}`);
    const normalized = { runId, armId, seed, faultWindowId, outcome: result, latencyMs };
    pairs.set(pairKey, normalized);
    pairByArm.set(armId, pairs);
    return normalized;
  });

  const armIds = [...pairByArm.keys()].sort(compareStrings);
  if (armIds.length < 2) fail("Raw QA requires baseline and at least one comparator arm");
  if (!pairByArm.has(baselineArmId)) fail(`baseline arm is missing: ${baselineArmId}`);
  const baselinePairs = pairByArm.get(baselineArmId)!;
  const expectedPairKeys = [...baselinePairs.keys()].sort(compareStrings);
  if (expectedPairKeys.length === 0) fail("baseline arm has no pairs");
  for (const armId of armIds) {
    const actual = [...pairByArm.get(armId)!.keys()].sort(compareStrings);
    if (JSON.stringify(actual) !== JSON.stringify(expectedPairKeys)) {
      const missing = expectedPairKeys.filter((key) => !actual.includes(key));
      const extra = actual.filter((key) => !expectedPairKeys.includes(key));
      fail(`non-paired seed/fault plan for ${armId}; missing=[${missing.join(",")}], extra=[${extra.join(",")}]`);
    }
  }
  return { schemaVersion: RT95_RAW_RESULTS_SCHEMA_VERSION, experimentId, baselineArmId, records };
}

export function analyzeRawResults(value: unknown): Rt95StatisticsReport {
  const raw = validateRawResults(value);
  const armIds = [...new Set(raw.records.map((record) => record.armId))].sort(compareStrings);
  const pairKeys = [...new Set(raw.records
    .filter((record) => record.armId === raw.baselineArmId)
    .map((record) => pairIdentity(record.seed, record.faultWindowId)))].sort(compareStrings);
  const recordsByArm = new Map(armIds.map((armId) => [
    armId,
    new Map(raw.records.filter((record) => record.armId === armId)
      .map((record) => [pairIdentity(record.seed, record.faultWindowId), record])),
  ]));
  const arms = armIds.map((armId) => {
    const records = pairKeys.map((key) => recordsByArm.get(armId)!.get(key)!);
    const successes = records.filter((record) => record.outcome === "success").length;
    const failures = records.length - successes;
    return {
      armId,
      successes,
      failures,
      total: records.length,
      successRate: wilson95(successes, records.length),
      zeroFailureUpper95: failures === 0 ? zeroFailureUpper95(records.length) : null,
      latencyMs: {
        median: median(records.map((record) => record.latencyMs)),
        p95: percentile95NearestRank(records.map((record) => record.latencyMs)),
      },
    };
  });
  const baselineSummary = arms.find((arm) => arm.armId === raw.baselineArmId)!;
  const baselineOutcomes = pairKeys.map((key) => recordsByArm.get(raw.baselineArmId)!.get(key)!.outcome);
  const comparisons = armIds.filter((armId) => armId !== raw.baselineArmId).map((comparatorArmId) => {
    const comparatorSummary = arms.find((arm) => arm.armId === comparatorArmId)!;
    const comparatorOutcomes = pairKeys.map((key) => recordsByArm.get(comparatorArmId)!.get(key)!.outcome);
    const difference = absoluteRateDifference(
      baselineSummary.successes,
      baselineSummary.total,
      comparatorSummary.successes,
      comparatorSummary.total,
    );
    return {
      baselineArmId: raw.baselineArmId,
      comparatorArmId,
      baselineSuccessRate: baselineSummary.successRate.estimate,
      comparatorSuccessRate: comparatorSummary.successRate.estimate,
      absoluteRateDifference: difference,
      rateRatio: rateRatio(
        baselineSummary.successes,
        baselineSummary.total,
        comparatorSummary.successes,
        comparatorSummary.total,
      ),
      paired: pairedBinaryEffect(baselineOutcomes, comparatorOutcomes),
      pairedBootstrap95: pairedBootstrapRateDifference(baselineOutcomes, comparatorOutcomes),
    };
  });
  return {
    schemaVersion: RT95_STATISTICS_REPORT_SCHEMA_VERSION,
    experimentId: raw.experimentId,
    baselineArmId: raw.baselineArmId,
    methodology: {
      significanceClaimed: false,
      wilson95: "two-sided Wilson score interval with z=1.959963984540054",
      zeroFailure95: "one-sided exact upper bound 1 - 0.05^(1/n)",
      median: "sorted middle value; even n uses arithmetic mean of the two middle values",
      p95: "nearest-rank: sorted[ceil(0.95*n)-1]",
      pairedEffect: "baseline minus comparator on identical seed+faultWindow pairs; descriptive only",
      pairedBootstrap95: "deterministic paired percentile bootstrap with xorshift32-v1; descriptive only",
      rateRatio: "baseline success rate divided by comparator success rate; zero denominator is explicit",
      holmBonferroni: "implemented for preregistered p-value families; not applied because Raw v1 accepts no p-values",
    },
    rawQa: { status: "passed", recordCount: raw.records.length, armIds, pairCount: pairKeys.length },
    arms,
    comparisons,
    multiplicity: {
      method: "holm-bonferroni",
      applied: false,
      significanceClaimed: false,
      adjustedPValues: [],
      reason: "Raw v1 contains no preregistered p-values; adjustment function is available but not auto-applied",
    },
  };
}

export function serializeStatisticsReport(report: Rt95StatisticsReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function pairIdentity(seed: number, faultWindowId: string): string {
  return `${String(seed).padStart(10, "0")}:${faultWindowId}`;
}

function finiteValues(values: readonly number[], label: string): number[] {
  if (values.length === 0) fail(`${label} cannot be empty`);
  const ordered = values.map((value, index) => finiteNonNegative(value, `${label}[${index}]`)).sort((left, right) => left - right);
  return ordered;
}

function nearestRank(values: readonly number[], quantile: number): number {
  return values[Math.max(0, Math.ceil(quantile * values.length) - 1)]!;
}

function xorshift32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

function outcome(value: unknown, label: string): BinaryOutcome {
  if (value !== "success" && value !== "failure") fail(`${label} must be success or failure`);
  return value;
}

function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) fail(`${label} must be a non-empty machine ID`);
  return value;
}

function uint32(value: unknown, label: string): number {
  const number = count(value, label);
  if (number > UINT32_MAX) fail(`${label} must be an unsigned 32-bit integer`);
  return number;
}

function count(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail(`${label} must be a non-negative safe integer`);
  return Number(value);
}

function positiveCount(value: unknown, label: string): number {
  const number = count(value, label);
  if (number === 0) fail(`${label} must be positive`);
  return number;
}

function finiteNonNegative(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail(`${label} must be a finite non-negative number`);
  return value;
}

function probability(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) fail(`${label} must be a finite probability in [0,1]`);
  return value;
}

function rounded(value: number): number {
  return Number(value.toFixed(12));
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
  const actual = Object.keys(value).sort(compareStrings);
  const wanted = [...expected].sort(compareStrings);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} key mismatch; expected [${wanted.join(",")}], got [${actual.join(",")}]`);
  }
}

function equal(actual: unknown, expected: unknown, label: string): void {
  if (!Object.is(actual, expected)) fail(`${label} must equal ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(message: string): never {
  throw new Error(`RT95 statistics validation failed: ${message}`);
}
