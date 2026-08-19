import { parseArgs } from "node:util";
import { buildLevels, parsePositiveNumber, runCapacityStaircase, writeCapacityReport } from "./runtime-capacity-harness.js";

const { values } = parseArgs({
  options: {
    levels: { type: "string", default: "20,100,500,1000" },
    label: { type: "string", default: "local-staircase" },
    concurrency: { type: "string" },
    "fake-latency-ms": { type: "string", default: "2" },
    "safe-task-limit": { type: "string", default: "5000" },
    "continue-on-failure": { type: "boolean", default: false },
    "max-p95-ms": { type: "string", default: "10000" },
    "max-duration-ms": { type: "string", default: "30000" },
    "max-rss-mb": { type: "string", default: "1024" },
  },
});

const taskCounts = values.levels.split(",").map((value) => parsePositiveNumber(value.trim(), "--levels", true));
const concurrency = values.concurrency === undefined ? undefined : parsePositiveNumber(values.concurrency, "--concurrency", true);
const fakeLatencyMs = parsePositiveNumber(values["fake-latency-ms"], "--fake-latency-ms");
const safeTaskLimit = parsePositiveNumber(values["safe-task-limit"], "--safe-task-limit", true);
const maxP95Ms = parsePositiveNumber(values["max-p95-ms"], "--max-p95-ms");
const maxDurationMs = parsePositiveNumber(values["max-duration-ms"], "--max-duration-ms");
const maxPeakRssMb = parsePositiveNumber(values["max-rss-mb"], "--max-rss-mb");
const report = await runCapacityStaircase({
  levels: buildLevels(taskCounts, { ...(concurrency === undefined ? {} : { concurrency }), fakeLatencyMs }),
  label: values.label,
  safeTaskLimit,
  stopOnFailure: !values["continue-on-failure"],
  gates: {
    maxP95Ms,
    maxDurationMs,
    maxPeakRssMb,
  },
});
const paths = await writeCapacityReport(report);
for (const level of report.levels) {
  process.stdout.write(`${level.level.name}: ${level.level.tasks} tasks, ${level.throughputTasksPerSecond} task/s, p95=${level.latencyMs.p95}ms, RSS=${level.peakRssMb}MB, ${level.classification}, ${level.gate.passed ? "PASS" : "FAIL"}\n`);
}
process.stdout.write(`termination=${report.termination.reason} level=${report.termination.level}\nJSON=${paths.jsonPath}\nMarkdown=${paths.markdownPath}\n`);
if (report.termination.reason === "gate_failed") process.exitCode = 1;
