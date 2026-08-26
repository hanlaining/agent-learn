import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPORT_SCHEMA_VERSION = "rt95-statistics-report-v1";
const MACHINE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

interface WilsonSummary {
  method: "wilson-score";
  confidenceLevel: 0.95;
  successes: number;
  total: number;
  estimate: number;
  lower: number;
  upper: number;
}

interface ArmSummary {
  armId: string;
  successes: number;
  failures: number;
  total: number;
  successRate: WilsonSummary;
  zeroFailureUpper95: null | {
    method: "exact-one-sided-zero-event";
    confidenceLevel: 0.95;
    failures: 0;
    total: number;
    upper: number;
  };
  latencyMs: { median: number; p95: number };
}

interface ComparisonSummary {
  baselineArmId: string;
  comparatorArmId: string;
  baselineSuccessRate: number;
  comparatorSuccessRate: number;
  absoluteRateDifference: number;
  rateRatio: {
    method: "rate-ratio";
    baselineRate: number;
    comparatorRate: number;
    estimate: number | null;
    status: "finite" | "positive-over-zero" | "undefined-both-zero";
  };
  paired: {
    method: "paired-binary-descriptive";
    totalPairs: number;
    bothSuccess: number;
    baselineOnlySuccess: number;
    comparatorOnlySuccess: number;
    bothFailure: number;
    absoluteRateDifference: number;
    discordantOddsRatio: number | null;
  };
  pairedBootstrap95: {
    method: "paired-bootstrap-percentile";
    confidenceLevel: 0.95;
    descriptiveOnly: true;
    seed: number;
    iterations: number;
    estimate: number;
    lower: number;
    upper: number;
  };
}

export interface Rt95StatisticsReportForPaper {
  schemaVersion: "rt95-statistics-report-v1";
  experimentId: string;
  baselineArmId: string;
  methodology: Record<string, unknown> & { significanceClaimed: false };
  rawQa: { status: "passed"; recordCount: number; armIds: string[]; pairCount: number };
  arms: ArmSummary[];
  comparisons: ComparisonSummary[];
  multiplicity: Record<string, unknown> & { significanceClaimed: false };
}

export interface PaperTableArtifacts {
  markdown: string;
  armsCsv: string;
  comparisonsCsv: string;
}

export interface RenderPaperTableOptions {
  inputPath: string;
  outputDirectory: string;
}

export interface PaperTableCliOptions extends RenderPaperTableOptions {}

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");

export function parsePaperTableCliArgs(args: readonly string[]): PaperTableCliOptions {
  let inputPath: string | undefined;
  let outputDirectory: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--input") {
      inputPath = args[++index];
      if (inputPath === undefined) throw new Error("--input requires a statistics report JSON path");
    } else if (argument === "--output-dir") {
      outputDirectory = args[++index];
      if (outputDirectory === undefined) throw new Error("--output-dir requires a directory path");
    } else {
      throw new Error(`unknown argument: ${argument ?? ""}; only --input and --output-dir are allowed`);
    }
  }
  if (inputPath === undefined) throw new Error("missing --input <statistics-report.json>");
  if (outputDirectory === undefined) throw new Error("missing --output-dir <workspace-relative-directory>");
  return { inputPath, outputDirectory };
}

export async function renderRt95PaperTables(
  workspaceRoot: string,
  options: RenderPaperTableOptions,
): Promise<PaperTableArtifacts> {
  const root = await realpath(path.resolve(workspaceRoot));
  const inputPath = await resolveContainedPath(root, options.inputPath, "input", true);
  const outputDirectory = await resolveContainedPath(root, options.outputDirectory, "output directory", false);
  const parsed = parseJson(await readFile(inputPath, "utf8"), "statistics report");
  const report = validateStatisticsReportForPaper(parsed);
  const artifacts = createPaperTableArtifacts(report);
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDirectory, "results.md"), artifacts.markdown, "utf8"),
    writeFile(path.join(outputDirectory, "arms.csv"), artifacts.armsCsv, "utf8"),
    writeFile(path.join(outputDirectory, "comparisons.csv"), artifacts.comparisonsCsv, "utf8"),
  ]);
  return artifacts;
}

export function createPaperTableArtifacts(reportValue: unknown): PaperTableArtifacts {
  const report = validateStatisticsReportForPaper(reportValue);
  const arms = [...report.arms].sort((left, right) => compare(left.armId, right.armId));
  const comparisons = [...report.comparisons].sort((left, right) =>
    compare(left.baselineArmId, right.baselineArmId) || compare(left.comparatorArmId, right.comparatorArmId));

  const armsCsv = csv([
    ["arm_id", "successes", "failures", "total", "success_rate", "wilson95_lower", "wilson95_upper", "zero_failure_upper95", "latency_median_ms", "latency_p95_ms"],
    ...arms.map((arm) => [
      arm.armId, arm.successes, arm.failures, arm.total, arm.successRate.estimate,
      arm.successRate.lower, arm.successRate.upper, arm.zeroFailureUpper95?.upper ?? "",
      arm.latencyMs.median, arm.latencyMs.p95,
    ]),
  ]);
  const comparisonsCsv = csv([
    [
      "baseline_arm_id", "comparator_arm_id", "baseline_success_rate", "comparator_success_rate",
      "absolute_rate_difference", "rate_ratio_estimate", "rate_ratio_status", "paired_total_pairs",
      "paired_baseline_only_success", "paired_comparator_only_success", "paired_absolute_rate_difference",
      "bootstrap95_estimate", "bootstrap95_lower", "bootstrap95_upper", "bootstrap_seed",
      "bootstrap_iterations", "descriptive_only",
    ],
    ...comparisons.map((item) => [
      item.baselineArmId, item.comparatorArmId, item.baselineSuccessRate, item.comparatorSuccessRate,
      item.absoluteRateDifference, item.rateRatio.estimate ?? "", item.rateRatio.status, item.paired.totalPairs,
      item.paired.baselineOnlySuccess, item.paired.comparatorOnlySuccess, item.paired.absoluteRateDifference,
      item.pairedBootstrap95.estimate, item.pairedBootstrap95.lower, item.pairedBootstrap95.upper,
      item.pairedBootstrap95.seed, item.pairedBootstrap95.iterations, item.pairedBootstrap95.descriptiveOnly,
    ]),
  ]);

  const armRows = arms.map((arm) =>
    `| ${markdownCell(arm.armId)} | ${arm.successes}/${arm.total} | ${percent(arm.successRate.estimate)} | `
    + `${interval(arm.successRate.lower, arm.successRate.upper)} | ${arm.zeroFailureUpper95 === null ? "—" : percent(arm.zeroFailureUpper95.upper)} | `
    + `${numberText(arm.latencyMs.median)} | ${numberText(arm.latencyMs.p95)} |`).join("\n");
  const comparisonRows = comparisons.map((item) =>
    `| ${markdownCell(item.baselineArmId)} | ${markdownCell(item.comparatorArmId)} | ${signedPercent(item.absoluteRateDifference)} | `
    + `${item.rateRatio.estimate === null ? `${item.rateRatio.status}（未定义有限值）` : numberText(item.rateRatio.estimate)} | `
    + `${signedPercent(item.paired.absoluteRateDifference)} | ${interval(item.pairedBootstrap95.lower, item.pairedBootstrap95.upper)} |`).join("\n");
  const markdown = [
    "# RT95 描述性结果表",
    "",
    `- 实验 ID：\`${report.experimentId}\``,
    `- 基线 arm：\`${report.baselineArmId}\``,
    `- Raw QA：passed；${report.rawQa.recordCount} 条记录，${report.rawQa.pairCount} 个配对窗口`,
    "- 结论边界：`significanceClaimed=false`。本表仅报告描述性估计与区间，不表示统计显著、因果优势或外部复现。",
    "",
    "## Arm 汇总",
    "",
    "| Arm | 成功数/样本数 | 成功率 | Wilson 95% CI | 零失败 95% 上界 | 延迟中位数 (ms) | 延迟 P95 (ms) |",
    "|---|---:|---:|---:|---:|---:|---:|",
    armRows,
    "",
    "## 配对比较",
    "",
    "差值方向固定为“基线减比较组”；bootstrap 区间是固定 seed 的描述性 percentile 区间。",
    "",
    "| 基线 | 比较组 | 绝对率差 | 率比 | 配对绝对率差 | 配对 bootstrap 95% CI |",
    "|---|---|---:|---:|---:|---:|",
    comparisonRows,
    "",
  ].join("\n");
  return { markdown, armsCsv, comparisonsCsv };
}

export function validateStatisticsReportForPaper(value: unknown): Rt95StatisticsReportForPaper {
  const root = object(value, "root");
  exactKeys(root, ["schemaVersion", "experimentId", "baselineArmId", "methodology", "rawQa", "arms", "comparisons", "multiplicity"], "root");
  constant(root.schemaVersion, REPORT_SCHEMA_VERSION, "schemaVersion");
  const experimentId = machineId(root.experimentId, "experimentId");
  const baselineArmId = machineId(root.baselineArmId, "baselineArmId");
  const methodology = validateMethodology(root.methodology);
  const rawQa = validateRawQa(root.rawQa);
  const arms = array(root.arms, "arms").map(validateArm);
  if (arms.length < 2) fail("arms must contain baseline and at least one comparator");
  unique(arms.map((arm) => arm.armId), "armId");
  const armMap = new Map(arms.map((arm) => [arm.armId, arm]));
  if (!armMap.has(baselineArmId)) fail("baselineArmId is missing from arms");
  const sortedArmIds = [...armMap.keys()].sort(compare);
  if (!same(rawQa.armIds, sortedArmIds)) fail("rawQa.armIds must exactly match sorted arm IDs");
  if (rawQa.recordCount !== rawQa.pairCount * arms.length) fail("rawQa.recordCount must equal pairCount multiplied by arm count");
  for (const arm of arms) if (arm.total !== rawQa.pairCount) fail(`${arm.armId}.total must equal rawQa.pairCount`);

  const comparisons = array(root.comparisons, "comparisons").map((item, index) =>
    validateComparison(item, index, baselineArmId, armMap, rawQa.pairCount));
  if (comparisons.length !== arms.length - 1) fail("comparisons must contain exactly one row for every non-baseline arm");
  unique(comparisons.map((item) => item.comparatorArmId), "comparatorArmId");
  const comparatorIds = comparisons.map((item) => item.comparatorArmId).sort(compare);
  if (!same(comparatorIds, sortedArmIds.filter((armId) => armId !== baselineArmId))) {
    fail("comparisons do not exactly cover all non-baseline arms");
  }
  const multiplicity = validateMultiplicity(root.multiplicity);
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    experimentId,
    baselineArmId,
    methodology,
    rawQa,
    arms,
    comparisons,
    multiplicity,
  };
}

function validateMethodology(value: unknown): Rt95StatisticsReportForPaper["methodology"] {
  const item = object(value, "methodology");
  const expected = {
    significanceClaimed: false,
    wilson95: "two-sided Wilson score interval with z=1.959963984540054",
    zeroFailure95: "one-sided exact upper bound 1 - 0.05^(1/n)",
    median: "sorted middle value; even n uses arithmetic mean of the two middle values",
    p95: "nearest-rank: sorted[ceil(0.95*n)-1]",
    pairedEffect: "baseline minus comparator on identical seed+faultWindow pairs; descriptive only",
    pairedBootstrap95: "deterministic paired percentile bootstrap with xorshift32-v1; descriptive only",
    rateRatio: "baseline success rate divided by comparator success rate; zero denominator is explicit",
    holmBonferroni: "implemented for preregistered p-value families; not applied because Raw v1 accepts no p-values",
  } as const;
  exactKeys(item, Object.keys(expected), "methodology");
  for (const [key, expectedValue] of Object.entries(expected)) constant(item[key], expectedValue, `methodology.${key}`);
  return item as Rt95StatisticsReportForPaper["methodology"];
}

function validateRawQa(value: unknown): Rt95StatisticsReportForPaper["rawQa"] {
  const item = object(value, "rawQa");
  exactKeys(item, ["status", "recordCount", "armIds", "pairCount"], "rawQa");
  constant(item.status, "passed", "rawQa.status");
  const armIds = array(item.armIds, "rawQa.armIds").map((armId, index) => machineId(armId, `rawQa.armIds[${index}]`));
  if (armIds.length < 2) fail("rawQa.armIds must contain at least two arms");
  unique(armIds, "rawQa.armIds");
  return { status: "passed", recordCount: positiveInteger(item.recordCount, "rawQa.recordCount"), armIds, pairCount: positiveInteger(item.pairCount, "rawQa.pairCount") };
}

function validateArm(value: unknown, index: number): ArmSummary {
  const label = `arms[${index}]`;
  const item = object(value, label);
  exactKeys(item, ["armId", "successes", "failures", "total", "successRate", "zeroFailureUpper95", "latencyMs"], label);
  const armId = machineId(item.armId, `${label}.armId`);
  const successes = integer(item.successes, `${label}.successes`);
  const failures = integer(item.failures, `${label}.failures`);
  const total = positiveInteger(item.total, `${label}.total`);
  if (successes + failures !== total) fail(`${label}: successes + failures must equal total`);
  const successRate = validateWilson(item.successRate, `${label}.successRate`);
  if (successRate.successes !== successes || successRate.total !== total || !approximately(successRate.estimate, successes / total)) {
    fail(`${label}.successRate is inconsistent with successes/total`);
  }
  const zeroFailureUpper95 = item.zeroFailureUpper95 === null ? null : validateZeroFailure(item.zeroFailureUpper95, `${label}.zeroFailureUpper95`);
  if ((failures === 0) !== (zeroFailureUpper95 !== null)) fail(`${label}.zeroFailureUpper95 must be present exactly when failures is zero`);
  if (zeroFailureUpper95 !== null && zeroFailureUpper95.total !== total) fail(`${label}.zeroFailureUpper95.total is inconsistent`);
  const latency = object(item.latencyMs, `${label}.latencyMs`);
  exactKeys(latency, ["median", "p95"], `${label}.latencyMs`);
  const median = nonNegativeFinite(latency.median, `${label}.latencyMs.median`);
  const p95 = nonNegativeFinite(latency.p95, `${label}.latencyMs.p95`);
  if (p95 < median) fail(`${label}.latencyMs.p95 must not be below median`);
  return { armId, successes, failures, total, successRate, zeroFailureUpper95, latencyMs: { median, p95 } };
}

function validateWilson(value: unknown, label: string): WilsonSummary {
  const item = object(value, label);
  exactKeys(item, ["method", "confidenceLevel", "successes", "total", "estimate", "lower", "upper"], label);
  constant(item.method, "wilson-score", `${label}.method`);
  constant(item.confidenceLevel, 0.95, `${label}.confidenceLevel`);
  const estimate = probability(item.estimate, `${label}.estimate`);
  const lower = probability(item.lower, `${label}.lower`);
  const upper = probability(item.upper, `${label}.upper`);
  if (lower > estimate || estimate > upper) fail(`${label} interval must contain estimate`);
  return { method: "wilson-score", confidenceLevel: 0.95, successes: integer(item.successes, `${label}.successes`), total: positiveInteger(item.total, `${label}.total`), estimate, lower, upper };
}

function validateZeroFailure(value: unknown, label: string): NonNullable<ArmSummary["zeroFailureUpper95"]> {
  const item = object(value, label);
  exactKeys(item, ["method", "confidenceLevel", "failures", "total", "upper"], label);
  constant(item.method, "exact-one-sided-zero-event", `${label}.method`);
  constant(item.confidenceLevel, 0.95, `${label}.confidenceLevel`);
  constant(item.failures, 0, `${label}.failures`);
  return { method: "exact-one-sided-zero-event", confidenceLevel: 0.95, failures: 0, total: positiveInteger(item.total, `${label}.total`), upper: probability(item.upper, `${label}.upper`) };
}

function validateComparison(
  value: unknown,
  index: number,
  baselineArmId: string,
  arms: ReadonlyMap<string, ArmSummary>,
  pairCount: number,
): ComparisonSummary {
  const label = `comparisons[${index}]`;
  const item = object(value, label);
  exactKeys(item, ["baselineArmId", "comparatorArmId", "baselineSuccessRate", "comparatorSuccessRate", "absoluteRateDifference", "rateRatio", "paired", "pairedBootstrap95"], label);
  constant(item.baselineArmId, baselineArmId, `${label}.baselineArmId`);
  const comparatorArmId = machineId(item.comparatorArmId, `${label}.comparatorArmId`);
  if (comparatorArmId === baselineArmId || !arms.has(comparatorArmId)) fail(`${label}.comparatorArmId must name a non-baseline arm`);
  const baseline = arms.get(baselineArmId)!;
  const comparator = arms.get(comparatorArmId)!;
  const baselineSuccessRate = probability(item.baselineSuccessRate, `${label}.baselineSuccessRate`);
  const comparatorSuccessRate = probability(item.comparatorSuccessRate, `${label}.comparatorSuccessRate`);
  const absoluteRateDifference = signedRate(item.absoluteRateDifference, `${label}.absoluteRateDifference`);
  if (!approximately(baselineSuccessRate, baseline.successRate.estimate)
      || !approximately(comparatorSuccessRate, comparator.successRate.estimate)
      || !approximately(absoluteRateDifference, baseline.successes / baseline.total - comparator.successes / comparator.total)) {
    fail(`${label} rates are inconsistent with arm summaries`);
  }
  const rateRatio = validateRateRatio(item.rateRatio, label, baselineSuccessRate, comparatorSuccessRate);
  const paired = validatePaired(item.paired, label, pairCount, absoluteRateDifference);
  const pairedBootstrap95 = validateBootstrap(item.pairedBootstrap95, label, absoluteRateDifference);
  return { baselineArmId, comparatorArmId, baselineSuccessRate, comparatorSuccessRate, absoluteRateDifference, rateRatio, paired, pairedBootstrap95 };
}

function validateRateRatio(value: unknown, parent: string, baselineRate: number, comparatorRate: number): ComparisonSummary["rateRatio"] {
  const label = `${parent}.rateRatio`;
  const item = object(value, label);
  exactKeys(item, ["method", "baselineRate", "comparatorRate", "estimate", "status"], label);
  constant(item.method, "rate-ratio", `${label}.method`);
  const storedBaseline = probability(item.baselineRate, `${label}.baselineRate`);
  const storedComparator = probability(item.comparatorRate, `${label}.comparatorRate`);
  if (!approximately(storedBaseline, baselineRate) || !approximately(storedComparator, comparatorRate)) fail(`${label} rates are inconsistent`);
  const expectedStatus = comparatorRate === 0 ? (baselineRate === 0 ? "undefined-both-zero" : "positive-over-zero") : "finite";
  constant(item.status, expectedStatus, `${label}.status`);
  if (expectedStatus !== "finite") {
    constant(item.estimate, null, `${label}.estimate`);
    return { method: "rate-ratio", baselineRate, comparatorRate, estimate: null, status: expectedStatus };
  }
  const estimate = nonNegativeFinite(item.estimate, `${label}.estimate`);
  if (!approximately(estimate, baselineRate / comparatorRate)) fail(`${label}.estimate is inconsistent`);
  return { method: "rate-ratio", baselineRate, comparatorRate, estimate, status: "finite" };
}

function validatePaired(value: unknown, parent: string, pairCount: number, expectedDifference: number): ComparisonSummary["paired"] {
  const label = `${parent}.paired`;
  const item = object(value, label);
  exactKeys(item, ["method", "totalPairs", "bothSuccess", "baselineOnlySuccess", "comparatorOnlySuccess", "bothFailure", "absoluteRateDifference", "discordantOddsRatio"], label);
  constant(item.method, "paired-binary-descriptive", `${label}.method`);
  const totalPairs = positiveInteger(item.totalPairs, `${label}.totalPairs`);
  const bothSuccess = integer(item.bothSuccess, `${label}.bothSuccess`);
  const baselineOnlySuccess = integer(item.baselineOnlySuccess, `${label}.baselineOnlySuccess`);
  const comparatorOnlySuccess = integer(item.comparatorOnlySuccess, `${label}.comparatorOnlySuccess`);
  const bothFailure = integer(item.bothFailure, `${label}.bothFailure`);
  if (totalPairs !== pairCount || bothSuccess + baselineOnlySuccess + comparatorOnlySuccess + bothFailure !== totalPairs) fail(`${label} pair counts are inconsistent`);
  const absoluteRateDifference = signedRate(item.absoluteRateDifference, `${label}.absoluteRateDifference`);
  if (!approximately(absoluteRateDifference, expectedDifference)) fail(`${label}.absoluteRateDifference is inconsistent`);
  const expectedOdds = comparatorOnlySuccess === 0 ? null : baselineOnlySuccess / comparatorOnlySuccess;
  const discordantOddsRatio = item.discordantOddsRatio === null ? null : nonNegativeFinite(item.discordantOddsRatio, `${label}.discordantOddsRatio`);
  if (expectedOdds === null ? discordantOddsRatio !== null : discordantOddsRatio === null || !approximately(discordantOddsRatio, expectedOdds)) fail(`${label}.discordantOddsRatio is inconsistent`);
  return { method: "paired-binary-descriptive", totalPairs, bothSuccess, baselineOnlySuccess, comparatorOnlySuccess, bothFailure, absoluteRateDifference, discordantOddsRatio };
}

function validateBootstrap(value: unknown, parent: string, expectedDifference: number): ComparisonSummary["pairedBootstrap95"] {
  const label = `${parent}.pairedBootstrap95`;
  const item = object(value, label);
  exactKeys(item, ["method", "confidenceLevel", "descriptiveOnly", "seed", "iterations", "estimate", "lower", "upper"], label);
  constant(item.method, "paired-bootstrap-percentile", `${label}.method`);
  constant(item.confidenceLevel, 0.95, `${label}.confidenceLevel`);
  constant(item.descriptiveOnly, true, `${label}.descriptiveOnly`);
  const estimate = signedRate(item.estimate, `${label}.estimate`);
  const lower = signedRate(item.lower, `${label}.lower`);
  const upper = signedRate(item.upper, `${label}.upper`);
  if (lower > upper || !approximately(estimate, expectedDifference)) fail(`${label} is inconsistent`);
  const seed = positiveInteger(item.seed, `${label}.seed`);
  if (seed > 0xffff_ffff) fail(`${label}.seed must be an unsigned 32-bit integer`);
  const iterations = positiveInteger(item.iterations, `${label}.iterations`);
  if (iterations < 100 || iterations > 1_000_000) fail(`${label}.iterations is outside [100,1000000]`);
  return { method: "paired-bootstrap-percentile", confidenceLevel: 0.95, descriptiveOnly: true, seed, iterations, estimate, lower, upper };
}

function validateMultiplicity(value: unknown): Rt95StatisticsReportForPaper["multiplicity"] {
  const item = object(value, "multiplicity");
  exactKeys(item, ["method", "applied", "significanceClaimed", "adjustedPValues", "reason"], "multiplicity");
  constant(item.method, "holm-bonferroni", "multiplicity.method");
  constant(item.applied, false, "multiplicity.applied");
  constant(item.significanceClaimed, false, "multiplicity.significanceClaimed");
  const adjusted = array(item.adjustedPValues, "multiplicity.adjustedPValues");
  if (adjusted.length !== 0) fail("multiplicity.adjustedPValues must be empty");
  constant(item.reason, "Raw v1 contains no preregistered p-values; adjustment function is available but not auto-applied", "multiplicity.reason");
  return item as Rt95StatisticsReportForPaper["multiplicity"];
}

async function resolveContainedPath(root: string, candidate: string, label: string, mustExist: boolean): Promise<string> {
  if (candidate.length === 0) fail(`${label} path cannot be empty`);
  const resolved = path.resolve(root, candidate);
  ensureContained(root, resolved, label);
  if (mustExist) {
    const actual = await realpath(resolved).catch(() => fail(`${label} path does not exist: ${candidate}`));
    ensureContained(root, actual, label);
    return actual;
  }
  let ancestor = resolved;
  while (true) {
    let exists = true;
    try {
      await stat(ancestor);
    } catch {
      exists = false;
    }
    if (exists) {
      const actualAncestor = await realpath(ancestor);
      ensureContained(root, actualAncestor, label);
      return path.join(actualAncestor, path.relative(ancestor, resolved));
    } else {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) fail(`${label} has no existing ancestor inside workspace`);
      ancestor = parent;
    }
  }
}

function ensureContained(root: string, target: string, label: string): void {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) fail(`${label} path escapes workspace: ${target}`);
}

function parseJson(text: string, label: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return fail(`${label} is not valid JSON`); }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(compare);
  const expected = [...keys].sort(compare);
  if (!same(actual, expected)) fail(`${label} key mismatch; expected [${expected.join(", ")}]`);
}

function machineId(value: unknown, label: string): string {
  if (typeof value !== "string" || !MACHINE_ID.test(value)) fail(`${label} must be a machine ID`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail(`${label} must be a non-negative safe integer`);
  return Number(value);
}

function positiveInteger(value: unknown, label: string): number {
  const result = integer(value, label);
  if (result === 0) fail(`${label} must be positive`);
  return result;
}

function nonNegativeFinite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail(`${label} must be a finite non-negative number`);
  return value;
}

function probability(value: unknown, label: string): number {
  const result = nonNegativeFinite(value, label);
  if (result > 1) fail(`${label} must be in [0,1]`);
  return result;
}

function signedRate(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < -1 || value > 1) fail(`${label} must be a finite number in [-1,1]`);
  return value;
}

function constant(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) fail(`${label} must equal ${JSON.stringify(expected)}`);
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) fail(`${label} contains duplicates`);
}

function same(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function approximately(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= 1e-11;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function csv(rows: ReadonlyArray<ReadonlyArray<string | number | boolean>>): string {
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function csvCell(value: string | number | boolean): string {
  const text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function markdownCell(value: string): string {
  return value.replaceAll("|", "\\|");
}

function percent(value: number): string {
  return `${numberText(value * 100)}%`;
}

function signedPercent(value: number): string {
  return `${value > 0 ? "+" : ""}${percent(value)}`;
}

function interval(lower: number, upper: number): string {
  return `[${percent(lower)}, ${percent(upper)}]`;
}

function numberText(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(10)));
}

function fail(message: string): never {
  throw new Error(message);
}

async function runCli(): Promise<void> {
  const options = parsePaperTableCliArgs(process.argv.slice(2));
  await renderRt95PaperTables(DEFAULT_ROOT, options);
  process.stdout.write(`RT95 paper tables written to ${options.outputDirectory.replaceAll("\\", "/")}\n`);
}

const invokedAsScript = process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  await runCli().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
