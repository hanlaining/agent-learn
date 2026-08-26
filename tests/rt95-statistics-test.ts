import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  absoluteRateDifference,
  analyzeRawResults,
  holmBonferroni,
  median,
  pairedBinaryEffect,
  pairedBootstrapRateDifference,
  percentile95NearestRank,
  rateRatio,
  serializeStatisticsReport,
  validateRawResults,
  wilson95,
  zeroFailureUpper95,
} from "../research/rt95-closure/src/statistics.js";
import { analyzeRawResultsFile, parseAnalyzeCliArgs } from "../scripts/analyze-rt95-results.js";

function katRaw(): any {
  const pairs = [
    { seed: 11, faultWindowId: "FW-A" },
    { seed: 12, faultWindowId: "FW-A" },
    { seed: 11, faultWindowId: "FW-B" },
    { seed: 12, faultWindowId: "FW-B" },
  ];
  const baselineLatency = [10, 20, 30, 40];
  const comparatorLatency = [12, 22, 32, 42];
  const comparatorOutcome = ["success", "failure", "success", "failure"];
  return {
    schemaVersion: "rt95-raw-results-v1",
    experimentId: "EXP-KAT-001",
    baselineArmId: "ARM-BASELINE",
    records: [
      ...pairs.map((pair, index) => ({
        runId: `RUN-B-${index + 1}`,
        armId: "ARM-BASELINE",
        ...pair,
        outcome: "success",
        latencyMs: baselineLatency[index],
      })),
      ...pairs.map((pair, index) => ({
        runId: `RUN-C-${index + 1}`,
        armId: "ARM-NO-WAL",
        ...pair,
        outcome: comparatorOutcome[index],
        latencyMs: comparatorLatency[index],
      })),
    ],
  };
}

test("固定 KAT：Wilson 95%、零失败上界和绝对率差", () => {
  assert.deepEqual(wilson95(4, 4), {
    method: "wilson-score",
    confidenceLevel: 0.95,
    successes: 4,
    total: 4,
    estimate: 1,
    lower: 0.510109163545,
    upper: 1,
  });
  assert.deepEqual(wilson95(2, 4), {
    method: "wilson-score",
    confidenceLevel: 0.95,
    successes: 2,
    total: 4,
    estimate: 0.5,
    lower: 0.150038989152,
    upper: 0.849961010848,
  });
  assert.deepEqual(zeroFailureUpper95(4), {
    method: "exact-one-sided-zero-event",
    confidenceLevel: 0.95,
    failures: 0,
    total: 4,
    upper: 0.527129195498,
  });
  assert.equal(absoluteRateDifference(4, 4, 2, 4), 0.5);
});

test("固定 KAT：配对二元效应只输出描述性四格计数", () => {
  assert.deepEqual(
    pairedBinaryEffect(
      ["success", "success", "success", "success"],
      ["success", "failure", "success", "failure"],
    ),
    {
      method: "paired-binary-descriptive",
      totalPairs: 4,
      bothSuccess: 2,
      baselineOnlySuccess: 2,
      comparatorOnlySuccess: 0,
      bothFailure: 0,
      absoluteRateDifference: 0.5,
      discordantOddsRatio: null,
    },
  );
});

test("固定 KAT：确定性成对 bootstrap 输出描述性 95% percentile CI", () => {
  const result = pairedBootstrapRateDifference(
    ["success", "success", "failure", "success", "failure"],
    ["success", "failure", "success", "failure", "failure"],
    { seed: 123456, iterations: 1000 },
  );
  assert.deepEqual(result, {
    method: "paired-bootstrap-percentile",
    confidenceLevel: 0.95,
    descriptiveOnly: true,
    seed: 123456,
    iterations: 1000,
    estimate: 0.2,
    lower: -0.4,
    upper: 0.8,
  });
  assert.deepEqual(
    pairedBootstrapRateDifference(
      ["success", "success", "failure", "success", "failure"],
      ["success", "failure", "success", "failure", "failure"],
      { seed: 123456, iterations: 1000 },
    ),
    result,
  );
  assert.throws(() => pairedBootstrapRateDifference(["success"], ["failure"], { seed: 0, iterations: 100 }), /seed must be non-zero/u);
  assert.throws(() => pairedBootstrapRateDifference(["success"], ["failure"], { seed: 1, iterations: 99 }), /iterations must be between/u);
  assert.throws(() => pairedBootstrapRateDifference(["success"], [], { seed: 1, iterations: 100 }), /same positive length/u);
});

test("固定 KAT：rate ratio 明确处理 comparator 零率", () => {
  assert.deepEqual(rateRatio(4, 4, 2, 4), {
    method: "rate-ratio", baselineRate: 1, comparatorRate: 0.5, estimate: 2, status: "finite",
  });
  assert.deepEqual(rateRatio(0, 4, 2, 4), {
    method: "rate-ratio", baselineRate: 0, comparatorRate: 0.5, estimate: 0, status: "finite",
  });
  assert.deepEqual(rateRatio(4, 4, 0, 4), {
    method: "rate-ratio", baselineRate: 1, comparatorRate: 0, estimate: null, status: "positive-over-zero",
  });
  assert.deepEqual(rateRatio(0, 4, 0, 4), {
    method: "rate-ratio", baselineRate: 0, comparatorRate: 0, estimate: null, status: "undefined-both-zero",
  });
});

test("固定 KAT：Holm-Bonferroni 单调校正且拒绝非法 family", () => {
  assert.deepEqual(holmBonferroni([
    { id: "AN-B", pValue: 0.04 },
    { id: "AN-A", pValue: 0.01 },
    { id: "AN-C", pValue: 0.03 },
  ]), [
    { id: "AN-A", rawPValue: 0.01, adjustedPValue: 0.03 },
    { id: "AN-B", rawPValue: 0.04, adjustedPValue: 0.06 },
    { id: "AN-C", rawPValue: 0.03, adjustedPValue: 0.06 },
  ]);
  assert.throws(() => holmBonferroni([]), /cannot be empty/u);
  assert.throws(() => holmBonferroni([{ id: "AN-A", pValue: 1.1 }]), /probability/u);
  assert.throws(() => holmBonferroni([{ id: "AN-A", pValue: 0.1 }, { id: "AN-A", pValue: 0.2 }]), /duplicate Holm/u);
});

test("Median 与 P95 使用冻结定义", () => {
  assert.equal(median([40, 10, 30, 20]), 25);
  assert.equal(median([9, 1, 4]), 4);
  assert.equal(percentile95NearestRank([40, 10, 30, 20]), 40);
  assert.equal(percentile95NearestRank(Array.from({ length: 100 }, (_, index) => index + 1)), 95);
  assert.throws(() => median([]), /cannot be empty/u);
});

test("Raw KAT 生成确定性机器报告且不声称显著性", () => {
  const raw = katRaw();
  const report = analyzeRawResults(raw);
  assert.equal(report.rawQa.status, "passed");
  assert.deepEqual(report.rawQa, {
    status: "passed",
    recordCount: 8,
    armIds: ["ARM-BASELINE", "ARM-NO-WAL"],
    pairCount: 4,
  });
  assert.equal(report.methodology.significanceClaimed, false);
  assert.equal(report.arms[0]?.latencyMs.median, 25);
  assert.equal(report.arms[0]?.latencyMs.p95, 40);
  assert.equal(report.comparisons[0]?.absoluteRateDifference, 0.5);
  assert.equal(report.comparisons[0]?.paired.absoluteRateDifference, 0.5);
  assert.equal(report.comparisons[0]?.rateRatio.estimate, 2);
  assert.equal(report.comparisons[0]?.pairedBootstrap95.descriptiveOnly, true);
  assert.equal(report.comparisons[0]?.pairedBootstrap95.seed, 20260824);
  assert.deepEqual(report.multiplicity, {
    method: "holm-bonferroni",
    applied: false,
    significanceClaimed: false,
    adjustedPValues: [],
    reason: "Raw v1 contains no preregistered p-values; adjustment function is available but not auto-applied",
  });

  const reversed = structuredClone(raw);
  reversed.records.reverse();
  assert.equal(serializeStatisticsReport(analyzeRawResults(reversed)), serializeStatisticsReport(report));
});

test("Raw QA 拒绝重复 runId、重复 pair 和缺少必填字段", () => {
  const duplicateRun = katRaw();
  duplicateRun.records[1].runId = duplicateRun.records[0].runId;
  assert.throws(() => validateRawResults(duplicateRun), /duplicate runId/u);

  const duplicatePair = katRaw();
  duplicatePair.records[1].seed = duplicatePair.records[0].seed;
  assert.throws(() => validateRawResults(duplicatePair), /duplicate arm\/seed\/fault pair/u);

  for (const field of ["armId", "seed", "faultWindowId", "outcome"] as const) {
    const missing = katRaw();
    delete missing.records[0][field];
    assert.throws(() => validateRawResults(missing), /key mismatch/u, field);
  }
});

test("Raw QA 拒绝非配对 seed/fault plan、非法 outcome 和非有限 latency", () => {
  const nonPaired = katRaw();
  nonPaired.records[7].faultWindowId = "FW-EXTRA";
  assert.throws(() => validateRawResults(nonPaired), /non-paired seed\/fault plan/u);

  const badOutcome = katRaw();
  badOutcome.records[0].outcome = "unknown";
  assert.throws(() => validateRawResults(badOutcome), /must be success or failure/u);

  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
    const latency = katRaw();
    latency.records[0].latencyMs = value;
    assert.throws(() => validateRawResults(latency), /finite non-negative/u);
  }
});

test("CLI 只接受 Raw JSON 路径，不接受人工汇总参数", () => {
  assert.deepEqual(parseAnalyzeCliArgs(["--input", "raw.json"]), { inputPath: path.resolve("raw.json") });
  assert.throws(() => parseAnalyzeCliArgs(["--input", "raw.json", "--successes", "99"]), /only --input and --output/u);
  assert.throws(() => parseAnalyzeCliArgs([]), /missing --input/u);
});

test("CLI 文件入口从 Raw 生成与内存分析字节一致的 JSON", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "rt95-statistics-test-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const inputPath = path.join(directory, "raw.json");
  const outputPath = path.join(directory, "report.json");
  const raw = katRaw();
  await writeFile(inputPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  const serialized = await analyzeRawResultsFile({ inputPath, outputPath });
  assert.equal(serialized, serializeStatisticsReport(analyzeRawResults(raw)));
  assert.equal(JSON.parse(serialized).schemaVersion, "rt95-statistics-report-v1");
});
