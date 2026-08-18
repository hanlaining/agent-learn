import assert from "node:assert/strict";
import test from "node:test";
import { generateScenarios, loadFixture } from "../src/fixtures.js";
import { buildReport, serializeReport, verifyDeterministic } from "../src/runner.js";
import { validateBenchmarkReport } from "../src/schema.js";
import { SCENARIO_CATEGORIES } from "../src/types.js";

test("GATE-30 fixture 固定为 30 条且五类场景均衡", async () => {
  const fixture = await loadFixture(30);
  const scenarios = generateScenarios(fixture);
  assert.equal(scenarios.length, 30);
  for (const category of SCENARIO_CATEGORIES) {
    assert.equal(scenarios.filter((item) => item.category === category).length, 6);
  }
});

test("报告通过运行时 schema 校验并包含全部核心指标", async () => {
  const report = await buildReport({ gate: 30 });
  validateBenchmarkReport(report);
  assert.equal(report.cases.length, 120);
  assert.equal(report.summaries.length, 4);
  for (const summary of report.summaries) {
    assert.equal(typeof summary.taskSuccess.rate, "number");
    assert.equal(typeof summary.recoverySuccess.rate, "number");
    assert.equal(typeof summary.duplicateModelCalls, "number");
    assert.equal(typeof summary.duplicateToolEffects, "number");
    assert.equal(typeof summary.unknownOutcomeRate.rate, "number");
    assert.equal(typeof summary.evidenceCompleteness, "number");
    assert.equal(typeof summary.latencyMs.p50, "number");
    assert.equal(typeof summary.latencyMs.p95, "number");
    assert.equal(typeof summary.tokens.total, "number");
    assert.equal(typeof summary.costEstimateUsd, "number");
  }
});

test("同 fixture 和 seed 的复跑结果字节级一致", async () => {
  await verifyDeterministic({ gate: 30 });
  const first = serializeReport(await buildReport({ gate: 30 }));
  const second = serializeReport(await buildReport({ gate: 30 }));
  assert.equal(first, second);
});

test("GATE-100 四分片不重不漏", async () => {
  const reports = await Promise.all(Array.from({ length: 4 }, (_, index) =>
    buildReport({ gate: 100, shardIndex: index + 1, shardTotal: 4, variants: ["baseline"] })));
  const indexes = reports.flatMap((report) => report.cases.map((item) => item.caseIndex));
  assert.equal(indexes.length, 100);
  assert.equal(new Set(indexes).size, 100);
  assert.deepEqual([...indexes].sort((left, right) => left - right), Array.from({ length: 100 }, (_, index) => index));
});

test("消融方向性：WAL 抑制重放、恢复保障崩溃、lease 抑制副作用竞争", async () => {
  const report = await buildReport({ gate: 100 });
  const byVariant = new Map(report.summaries.map((item) => [item.variant, item]));
  const baseline = byVariant.get("baseline")!;
  const noWal = byVariant.get("no-wal")!;
  const noRecovery = byVariant.get("no-recovery")!;
  const noLease = byVariant.get("no-lease")!;
  assert.equal(baseline.duplicateModelCalls, 0);
  assert.equal(baseline.duplicateToolEffects, 0);
  assert.ok(noWal.duplicateModelCalls > baseline.duplicateModelCalls);
  assert.ok(noWal.unknownOutcomeRate.rate > baseline.unknownOutcomeRate.rate);
  assert.ok(noRecovery.recoverySuccess.rate < baseline.recoverySuccess.rate);
  assert.ok(noLease.duplicateToolEffects > baseline.duplicateToolEffects);
});

test("schema 拒绝缺少核心字段的伪报告", () => {
  assert.throws(() => validateBenchmarkReport({ schemaVersion: "gate-benchmark-result-v1" }), /schema violation/);
});
