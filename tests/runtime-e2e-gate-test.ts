import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { generateRuntimeE2eScenarios, loadRuntimeE2eFixture } from "../research/runtime-e2e-benchmarks/src/fixtures.js";
import {
  buildRuntimeE2eReport,
  deterministicProjection,
  writeRuntimeE2eReport,
} from "../research/runtime-e2e-benchmarks/src/runner.js";
import { validateRuntimeE2eReport } from "../research/runtime-e2e-benchmarks/src/schema.js";
import { RUNTIME_E2E_FAMILIES } from "../research/runtime-e2e-benchmarks/src/types.js";

let gate30: ReturnType<typeof buildRuntimeE2eReport> | undefined;
function gate30Report() {
  gate30 ??= buildRuntimeE2eReport({ gate: 30 });
  return gate30;
}

test("Runtime-E2E GATE-30 生成 30 条、六类生产机制各 5 条", async () => {
  const fixture = await loadRuntimeE2eFixture(30);
  const scenarios = generateRuntimeE2eScenarios(fixture);
  assert.equal(scenarios.length, 30);
  for (const family of RUNTIME_E2E_FAMILIES) {
    assert.equal(scenarios.filter((item) => item.family === family).length, 5);
  }
  assert.equal(new Set(scenarios.map((item) => item.caseId)).size, 30);
});

test("baseline 真实运行 30/30，并由生产状态不变量判定", async () => {
  const report = await gate30Report();
  validateRuntimeE2eReport(report);
  const baseline = report.cases.filter((item) => item.variant === "baseline");
  assert.equal(baseline.length, 30);
  assert.equal(baseline.every((item) => item.taskSuccess), true);
  assert.equal(baseline.every((item) => item.snapshotReloaded && item.stateFileWrites > 0 && item.stateFileLoads > 1), true);
  assert.equal(baseline.reduce((sum, item) => sum + item.duplicateModelCalls, 0), 0);
  assert.equal(baseline.reduce((sum, item) => sum + item.duplicateToolEffects, 0), 0);
  assert.equal(report.implementation.protocolSimulatorUsed, false);
  assert.equal(report.methodology.provider.realApiCalls, false);
  assert.equal(report.methodology.provider.credentialsRead, false);
});

test("消融连接真实机制：no-wal/no-recovery/no-lease 产生预期退化", async () => {
  const report = await gate30Report();
  const summaries = new Map(report.summaries.map((item) => [item.variant, item]));
  const baseline = summaries.get("baseline")!;
  const noWal = summaries.get("no-wal")!;
  const noRecovery = summaries.get("no-recovery")!;
  const noLease = summaries.get("no-lease")!;
  assert.ok(noWal.duplicateModelCalls > baseline.duplicateModelCalls);
  assert.ok(noWal.duplicateToolEffects > baseline.duplicateToolEffects);
  assert.ok(noRecovery.recoverySuccess.rate < baseline.recoverySuccess.rate);
  assert.ok(noLease.duplicateToolEffects > baseline.duplicateToolEffects);
  assert.ok(noWal.taskSuccess.rate < baseline.taskSuccess.rate);
  assert.ok(noRecovery.taskSuccess.rate < baseline.taskSuccess.rate);
  assert.ok(noLease.taskSuccess.rate < baseline.taskSuccess.rate);
});

test("固定 seed 的确定性结果复跑一致，同时保留真实墙钟字段", async () => {
  const options = { gate: 30 as const, variants: ["baseline" as const], caseId: "model-response-window-001" };
  const first = await buildRuntimeE2eReport(options);
  const second = await buildRuntimeE2eReport(options);
  assert.equal(deterministicProjection(first), deterministicProjection(second));
  assert.equal(first.cases[0]?.wallClockDurationMs !== undefined, true);
  assert.equal(first.summaries[0]?.wallClockMs.kind, "measured-local-wall-clock");
});

test("GATE-100 fixture 四分片不重不漏", async () => {
  const scenarios = generateRuntimeE2eScenarios(await loadRuntimeE2eFixture(100));
  const shards = Array.from({ length: 4 }, (_, shard) => scenarios
    .filter((item) => item.caseIndex % 4 === shard)
    .map((item) => item.caseIndex));
  const indexes = shards.flat();
  assert.equal(indexes.length, 100);
  assert.equal(new Set(indexes).size, 100);
  assert.deepEqual(indexes.toSorted((a, b) => a - b), Array.from({ length: 100 }, (_, index) => index));
});

test("schema 拒绝协议模拟器冒充、缺真实 JSON 证据和失败 baseline", async () => {
  const report = await buildRuntimeE2eReport({ gate: 30, variants: ["baseline"], caseId: "model-response-window-001" });
  const simulator = structuredClone(report) as unknown as Record<string, unknown>;
  (simulator.implementation as Record<string, unknown>).protocolSimulatorUsed = true;
  assert.throws(() => validateRuntimeE2eReport(simulator), /schema violation/);
  const noSnapshot = structuredClone(report);
  noSnapshot.cases[0]!.snapshotReloaded = false;
  assert.throws(() => validateRuntimeE2eReport(noSnapshot), /schema violation/);
  const fakePass = structuredClone(report);
  fakePass.cases[0]!.taskSuccess = false;
  assert.throws(() => validateRuntimeE2eReport(fakePass), /schema violation/);
});

test("失败用例写出 report/CSV 和可单条运行的最小 repro", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "runtime-e2e-output-test-"));
  try {
    const report = await buildRuntimeE2eReport({ gate: 30, variants: ["no-recovery"], caseId: "workflow-stage-001" });
    await writeRuntimeE2eReport(report, directory);
    for (const file of ["report.json", "summary.csv", "cases.csv", path.join("repro", "no-recovery-workflow-stage-001.json")]) {
      assert.ok((await readFile(path.join(directory, file), "utf8")).length > 0);
    }
    const repro = JSON.parse(await readFile(path.join(directory, "repro", "no-recovery-workflow-stage-001.json"), "utf8")) as { rerun: string };
    assert.match(repro.rerun, /--variant no-recovery --case workflow-stage-001/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
