import { parseArgs } from "node:util";
import { parsePositiveNumber } from "./runtime-capacity-harness.js";
import {
  runDurationCapacitySweep, writeDurationCapacityReport, type DurationCapacityMode,
} from "./runtime-duration-capacity-harness.js";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "short-soak" },
    "concurrency-levels": { type: "string", default: "4,8,16" },
    "duration-seconds": { type: "string", default: "30" },
    "window-seconds": { type: "string", default: "5" },
    "fake-latency-ms": { type: "string", default: "2" },
    "safe-task-limit": { type: "string", default: "5000" },
    label: { type: "string", default: "local-short-soak" },
    "max-p95-ms": { type: "string", default: "2000" },
    "max-rss-growth-mb": { type: "string", default: "256" },
    "max-rss-slope-mb-min": { type: "string", default: "512" },
    "max-event-loop-p95-ms": { type: "string", default: "250" },
    "min-throughput-ratio": { type: "string", default: "0.7" },
    "fail-on-gate": { type: "boolean", default: false },
  },
});

if (values.mode !== "steady" && values.mode !== "short-soak") throw new Error("--mode must be steady or short-soak");
const mode = values.mode as DurationCapacityMode;
const concurrencyLevels = values["concurrency-levels"].split(",").map((value) => parsePositiveNumber(value.trim(), "--concurrency-levels", true));
const durationMs = parsePositiveNumber(values["duration-seconds"], "--duration-seconds") * 1_000;
const windowMs = parsePositiveNumber(values["window-seconds"], "--window-seconds") * 1_000;
const fakeLatencyMs = parsePositiveNumber(values["fake-latency-ms"], "--fake-latency-ms");
const safeTaskLimit = parsePositiveNumber(values["safe-task-limit"], "--safe-task-limit", true);
const minSustainedThroughputRatio = parsePositiveNumber(values["min-throughput-ratio"], "--min-throughput-ratio");
if (minSustainedThroughputRatio > 1) throw new Error("--min-throughput-ratio must be <= 1");

const report = await runDurationCapacitySweep({
  mode, concurrencyLevels, durationMs, windowMs, fakeLatencyMs, safeTaskLimit, label: values.label,
  gates: {
    maxP95Ms: parsePositiveNumber(values["max-p95-ms"], "--max-p95-ms"),
    maxRssGrowthMb: parsePositiveNumber(values["max-rss-growth-mb"], "--max-rss-growth-mb"),
    maxRssSlopeMbPerMinute: parsePositiveNumber(values["max-rss-slope-mb-min"], "--max-rss-slope-mb-min"),
    maxEventLoopDelayP95Ms: parsePositiveNumber(values["max-event-loop-p95-ms"], "--max-event-loop-p95-ms"),
    minSustainedThroughputRatio,
  },
});
const paths = await writeDurationCapacityReport(report);
for (const level of report.levels) {
  process.stdout.write(`${level.name}: concurrency=${level.concurrency}, tasks=${level.counts.completedTasks}, ${level.throughputTasksPerSecond} task/s, p95=${level.latencyMs.p95}ms, ratio=${level.sustainedThroughputRatio}, RSS growth=${level.rss.growthMb}MB, ${level.classification}\n`);
}
process.stdout.write(`recommendedConcurrency=${report.verdict.recommendedConcurrency ?? "none"}, firstDegraded=${report.verdict.firstDegradedConcurrency ?? "none"}\nJSON=${paths.jsonPath}\nMarkdown=${paths.markdownPath}\n`);
if (values["fail-on-gate"] && report.levels.some((item) => !item.gate.passed)) process.exitCode = 1;
