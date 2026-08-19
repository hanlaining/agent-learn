import assert from "node:assert/strict";
import test from "node:test";
import {
  BENCHMARK_VERSION, DEFAULT_GATES, FAKE_PROVIDER_LABEL, buildLevels, parsePositiveNumber,
  renderMarkdownReport, runCapacityLevel, runCapacityStaircase,
} from "../../scripts/bench/runtime-capacity-harness.js";

test("capacity smoke covers Job/Task/Run/Return, Return storm, persistence and lease recovery", async () => {
  const result = await runCapacityLevel({ name: "S-smoke", tasks: 12, tasksPerJob: 4, concurrency: 3, fakeLatencyMs: 1 });
  assert.equal(result.provider, FAKE_PROVIDER_LABEL);
  assert.equal(result.counts.jobs, 3);
  assert.equal(result.counts.requestedTasks, 12);
  assert.equal(result.counts.completedTasks, 12);
  assert.equal(result.counts.failedTasks, 0);
  assert.equal(result.counts.returns, 12);
  assert.equal(result.counts.consumedReturns, 12);
  assert.equal(result.counts.duplicateReturns, 0);
  assert.equal(result.counts.lostReturns, 0);
  assert.equal(result.counts.recoveredExpiredLeases, 1);
  assert.ok(result.counts.runs >= 15);
  assert.ok(result.persistence.snapshotBytes > 0);
  assert.ok(result.returnStorm.throughputPerSecond > 0);
  assert.equal(result.successRate, 1);
  assert.ok(result.queueWaitMs.p95 >= 0);
  assert.ok(result.cpu.userMs >= 0);
  assert.deepEqual(result.errorCategories, {});
  assert.equal(result.classification, "stable");
  assert.equal(result.gate.passed, true);
});

test("staircase stops immediately when a correctness/stability gate fails", async () => {
  const report = await runCapacityStaircase({
    levels: buildLevels([4, 8], { tasksPerJob: 4, concurrency: 2, fakeLatencyMs: 0 }),
    gates: { ...DEFAULT_GATES, maxPeakRssMb: 0 },
    label: "forced-gate-test",
  });
  assert.equal(report.levels.length, 1);
  assert.equal(report.termination.reason, "gate_failed");
  assert.equal(report.levels[0]?.gate.passed, false);
  assert.equal(report.levels[0]?.classification, "terminal");
});

test("staircase enforces configured safe task ceiling before starting an oversized level", async () => {
  const report = await runCapacityStaircase({
    levels: buildLevels([4, 40], { tasksPerJob: 4, concurrency: 2, fakeLatencyMs: 0 }),
    safeTaskLimit: 10,
    label: "safe-limit-test",
  });
  assert.equal(report.levels.length, 1);
  assert.equal(report.termination.reason, "safe_limit_reached");
  assert.equal(report.termination.level, "S1");
});

test("bounded spike actively stops dispatching when the wall-clock gate expires", async () => {
  const result = await runCapacityLevel(
    { name: "S-timeout", tasks: 100, tasksPerJob: 10, concurrency: 2, fakeLatencyMs: 10 },
    { ...DEFAULT_GATES, maxDurationMs: 25 },
  );
  assert.ok(result.counts.startedTasks < result.counts.requestedTasks);
  assert.ok(result.counts.unstartedTasks > 0);
  assert.equal(result.gate.passed, false);
  assert.ok(result.gate.failures.some((item) => item.includes("wall-clock safety stop")));
});

test("markdown report explicitly labels Fake Provider and key capacity metrics", async () => {
  const report = await runCapacityStaircase({ levels: buildLevels([4], { tasksPerJob: 4, concurrency: 2, fakeLatencyMs: 0 }) });
  const markdown = renderMarkdownReport(report);
  assert.match(markdown, /NO NETWORK \/ NO PAID PROVIDER/);
  assert.match(markdown, /p50\/p95\/p99/);
  assert.match(markdown, /重复\/丢失 Return/);
  assert.match(markdown, /峰值 RSS/);
  assert.match(markdown, /steady-state\/soak \*\*未测试，不得外推\*\*/);
  assert.equal(report.benchmarkVersion, BENCHMARK_VERSION);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.workload.steadyStateTested, false);
  assert.equal(report.workload.soakTested, false);
  assert.match(report.environment.gitCommit, /^(?:[0-9a-f]{40}|unknown)$/);
  assert.ok(typeof report.environment.gitDirty === "boolean" || report.environment.gitDirty === "unknown");
});

test("CLI numeric parser rejects zero, negative, non-finite, fractional integers and partial numbers", () => {
  for (const value of ["0", "-1", "NaN", "Infinity", "20tasks", ""]) {
    assert.throws(() => parsePositiveNumber(value, "--test"), /finite positive/);
  }
  assert.throws(() => parsePositiveNumber("1.5", "--test", true), /positive integer/);
  assert.equal(parsePositiveNumber("2.5", "--test"), 2.5);
  assert.equal(parsePositiveNumber("32", "--test", true), 32);
});
