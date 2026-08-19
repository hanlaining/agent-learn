import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_DURATION_GATES, renderDurationMarkdownReport, runDurationCapacityLevel, runDurationCapacitySweep,
} from "../../scripts/bench/runtime-duration-capacity-harness.js";

test("duration mode stops on deadline, keeps bounded in-flight and drains every Return", async () => {
  const result = await runDurationCapacityLevel({
    name: "D-smoke", mode: "steady", concurrency: 2, durationMs: 350, windowMs: 100,
    fakeLatencyMs: 2, safeTaskLimit: 200,
  });
  assert.equal(result.stopReason, "duration_elapsed");
  assert.ok(result.actualRunDurationMs >= 300);
  assert.ok(result.counts.startedTasks <= 200);
  assert.equal(result.counts.failedTasks, 0);
  assert.equal(result.counts.duplicateReturns, 0);
  assert.equal(result.counts.lostReturns, 0);
  assert.equal(result.counts.pendingReturnsAfterDrain, 0);
  assert.equal(result.counts.consumedReturns, result.counts.completedTasks);
  assert.equal(result.drain.complete, true);
  assert.equal(result.recovery.expiredLeaseProbeRecovered, true);
  assert.equal(result.successRate, 1);
  assert.ok(result.queueWaitMs.p95 >= 0);
  assert.ok(result.cpu.userMs >= 0);
  assert.deepEqual(result.errorCategories, {});
  assert.ok(result.windows.length >= 3);
});

test("duration mode stops safely at task ceiling and still drains", async () => {
  const result = await runDurationCapacityLevel({
    name: "D-limit", mode: "short-soak", concurrency: 3, durationMs: 5_000, windowMs: 100,
    fakeLatencyMs: 1, safeTaskLimit: 12,
  });
  assert.equal(result.stopReason, "safe_task_limit");
  assert.equal(result.counts.startedTasks, 12);
  assert.equal(result.drain.complete, true);
  assert.equal(result.counts.pendingReturnsAfterDrain, 0);
});

test("duration gate reports terminal when latency gate is exceeded", async () => {
  const result = await runDurationCapacityLevel({
    name: "D-gate", mode: "steady", concurrency: 1, durationMs: 120, windowMs: 50,
    fakeLatencyMs: 5, safeTaskLimit: 20,
    gates: { ...DEFAULT_DURATION_GATES, maxP95Ms: 0.01 },
  });
  assert.equal(result.gate.passed, false);
  assert.equal(result.classification, "terminal");
  assert.ok(result.gate.failures.some((item) => item.startsWith("p95 ")));
  assert.equal(result.drain.complete, true);
});

test("duration report contains 5-second-style windows, RSS trend and long-term disclaimer", async () => {
  const report = await runDurationCapacitySweep({
    mode: "short-soak", concurrencyLevels: [1], durationMs: 150, windowMs: 50,
    fakeLatencyMs: 2, safeTaskLimit: 50, label: "report-smoke",
  });
  const markdown = renderDurationMarkdownReport(report);
  assert.equal(report.workload.boundedInFlight, true);
  assert.equal(report.workload.longTermSoakTested, false);
  assert.match(markdown, /5 秒窗口/);
  assert.match(markdown, /long-term soak \*\*未测试\*/);
  assert.match(markdown, /RSS 增长\/斜率/);
});
