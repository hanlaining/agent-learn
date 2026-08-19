import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { AgentRegistry } from "../../src/agents/agent-registry.js";
import { AgentRunStore } from "../../src/agents/agent-run-store.js";
import { AgentRuntimeStore } from "../../src/agents/agent-runtime-store.js";
import { MultiAgentScheduler } from "../../src/agents/multi-agent-scheduler.js";
import type { AgentTeamConfig } from "../../src/agents/agent-runtime.js";
import {
  BENCHMARK_VERSION, FAKE_PROVIDER_LABEL, bytesToMb, environmentFingerprint, latencyStats, round,
} from "./runtime-capacity-harness.js";

export type DurationCapacityMode = "steady" | "short-soak";

export interface DurationCapacityGates {
  maxErrorRate: number;
  maxLostReturns: number;
  maxDuplicateReturns: number;
  maxP95Ms: number;
  maxPeakRssMb: number;
  maxRssGrowthMb: number;
  maxRssSlopeMbPerMinute: number;
  maxEventLoopDelayP95Ms: number;
  minSustainedThroughputRatio: number;
}

export interface DurationWindowMetric {
  index: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  completedTasks: number;
  errors: number;
  throughputTasksPerSecond: number;
  latencyP95Ms: number;
  rssStartMb: number;
  rssEndMb: number;
  rssPeakMb: number;
}

export interface DurationCapacityLevelResult {
  name: string;
  mode: DurationCapacityMode;
  concurrency: number;
  targetDurationMs: number;
  actualRunDurationMs: number;
  fakeLatencyMs: number;
  safeTaskLimit: number;
  stopReason: "duration_elapsed" | "safe_task_limit";
  counts: {
    jobs: number; startedTasks: number; completedTasks: number; failedTasks: number;
    returns: number; consumedReturns: number; pendingReturnsAfterDrain: number;
    duplicateReturns: number; lostReturns: number;
  };
  throughputTasksPerSecond: number;
  successRate: number;
  latencyMs: { p50: number; p95: number; p99: number; max: number };
  queueWaitMs: { p50: number; p95: number; p99: number; max: number };
  errorRate: number;
  errorCategories: Record<string, number>;
  cpu: { userMs: number; systemMs: number; utilizationPercent: number };
  rss: { startMb: number; endMb: number; peakMb: number; growthMb: number; slopeMbPerMinute: number };
  eventLoopDelayMs: { p95: number; max: number; mean: number };
  windows: DurationWindowMetric[];
  sustainedThroughputRatio: number;
  drain: { durationMs: number; complete: boolean };
  recovery: { expiredLeaseProbeRecovered: boolean };
  classification: "stable" | "degraded" | "terminal";
  gate: { passed: boolean; failures: string[] };
  errors: string[];
}

export interface DurationCapacityReport {
  schemaVersion: 1;
  benchmark: "god-agent-runtime-duration-capacity";
  benchmarkVersion: typeof BENCHMARK_VERSION;
  disclaimer: string;
  workload: { model: "fixed-concurrency-duration"; mode: DurationCapacityMode; boundedInFlight: true; longTermSoakTested: false };
  label: string;
  startedAt: string;
  completedAt: string;
  environment: ReturnType<typeof environmentFingerprint>;
  gates: DurationCapacityGates;
  levels: DurationCapacityLevelResult[];
  verdict: { recommendedConcurrency?: number; firstDegradedConcurrency?: number; longTermCapacityKnown: false };
}

export const DEFAULT_DURATION_GATES: DurationCapacityGates = {
  maxErrorRate: 0,
  maxLostReturns: 0,
  maxDuplicateReturns: 0,
  maxP95Ms: 2_000,
  maxPeakRssMb: 1_024,
  maxRssGrowthMb: 256,
  maxRssSlopeMbPerMinute: 512,
  maxEventLoopDelayP95Ms: 250,
  minSustainedThroughputRatio: 0.7,
};

export async function runDurationCapacitySweep(input: {
  mode: DurationCapacityMode;
  concurrencyLevels: number[];
  durationMs: number;
  windowMs?: number;
  fakeLatencyMs?: number;
  safeTaskLimit?: number;
  gates?: Partial<DurationCapacityGates>;
  label?: string;
}): Promise<DurationCapacityReport> {
  const startedAt = new Date().toISOString();
  const gates = { ...DEFAULT_DURATION_GATES, ...input.gates };
  assertDurationInput(input.concurrencyLevels, input.durationMs, input.windowMs ?? 5_000, input.fakeLatencyMs ?? 2, input.safeTaskLimit ?? 10_000);
  const levels: DurationCapacityLevelResult[] = [];
  for (let index = 0; index < input.concurrencyLevels.length; index += 1) {
    levels.push(await runDurationCapacityLevel({
      name: `D${index}`,
      mode: input.mode,
      concurrency: input.concurrencyLevels[index]!,
      durationMs: input.durationMs,
      windowMs: input.windowMs ?? 5_000,
      fakeLatencyMs: input.fakeLatencyMs ?? 2,
      safeTaskLimit: input.safeTaskLimit ?? 10_000,
      gates,
    }));
  }
  const stable = levels.filter((item) => item.classification === "stable");
  const firstDegraded = levels.find((item) => item.classification !== "stable");
  return {
    schemaVersion: 1,
    benchmark: "god-agent-runtime-duration-capacity",
    benchmarkVersion: BENCHMARK_VERSION,
    disclaimer: `${FAKE_PROVIDER_LABEL}; bounded fixed-concurrency ${input.mode}; this is a short local run, not a long-term soak or provider-capacity result.`,
    workload: { model: "fixed-concurrency-duration", mode: input.mode, boundedInFlight: true, longTermSoakTested: false },
    label: input.label ?? `${input.mode}-local`,
    startedAt,
    completedAt: new Date().toISOString(),
    environment: environmentFingerprint(),
    gates,
    levels,
    verdict: {
      ...(stable.at(-1) === undefined ? {} : { recommendedConcurrency: stable.at(-1)!.concurrency }),
      ...(firstDegraded === undefined ? {} : { firstDegradedConcurrency: firstDegraded.concurrency }),
      longTermCapacityKnown: false,
    },
  };
}

export async function runDurationCapacityLevel(input: {
  name: string;
  mode: DurationCapacityMode;
  concurrency: number;
  durationMs: number;
  windowMs: number;
  fakeLatencyMs: number;
  safeTaskLimit: number;
  gates?: DurationCapacityGates;
}): Promise<DurationCapacityLevelResult> {
  const gates = input.gates ?? DEFAULT_DURATION_GATES;
  assertDurationInput([input.concurrency], input.durationMs, input.windowMs, input.fakeLatencyMs, input.safeTaskLimit);
  const runStore = new AgentRunStore();
  const runtimeStore = new AgentRuntimeStore();
  const registry = new AgentRegistry();
  const config: AgentTeamConfig = {
    version: 1, mode: "auto", maxSubagents: 10, maxConcurrent: Math.min(10, input.concurrency), maxDepth: 3,
    allowedProfiles: ["investigator", "researcher", "coder", "tester", "reviewer"], scheduling: "independent_only",
    accessMode: "read_only", permissionMode: "least_privilege", shareBoard: false, independentReview: false,
    modelRouting: "inherit_chat", allowedTools: [], allowedSkills: [],
  };
  let executionSequence = 0;
  const requestedAtByTask = new Map<string, number>();
  const queueWaits: number[] = [];
  const scheduler = new MultiAgentScheduler({
    registry, store: runStore, runtimeStore, maxConcurrentRuns: input.concurrency,
    resolveParent: (turnId) => ({ threadId: `thread-${turnId}`, teamConfig: config }),
    prepare: (_profile, task) => ({
      threadId: `duration-fake-thread-${++executionSequence}`,
      turnId: `duration-fake-turn-${executionSequence}`,
      execute: async () => {
        const requestedAt = requestedAtByTask.get(task);
        if (requestedAt !== undefined) queueWaits.push(performance.now() - requestedAt);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, input.fakeLatencyMs));
        return `FAKE_DURATION_RESULT:${task}`;
      },
    }),
  });

  const started = performance.now();
  const initialCpu = process.cpuUsage();
  const deadline = started + input.durationMs;
  const rssStart = process.memoryUsage().rss;
  const memorySamples: Array<{ atMs: number; rss: number }> = [{ atMs: 0, rss: rssStart }];
  const completions: Array<{ atMs: number; latencyMs: number; failed: boolean }> = [];
  const errors: string[] = [];
  let nextTask = 0;
  let stopReason: DurationCapacityLevelResult["stopReason"] = "duration_elapsed";
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  eventLoop.enable();
  const memoryTimer = setInterval(() => {
    memorySamples.push({ atMs: performance.now() - started, rss: process.memoryUsage().rss });
  }, Math.min(1_000, Math.max(50, Math.floor(input.windowMs / 5))));
  memoryTimer.unref();

  const worker = async () => {
    while (performance.now() < deadline) {
      const index = nextTask;
      if (index >= input.safeTaskLimit) { stopReason = "safe_task_limit"; return; }
      nextTask += 1;
      const taskStarted = performance.now();
      const taskName = `duration-capacity-task-${index}`;
      requestedAtByTask.set(taskName, taskStarted);
      let failed = false;
      try {
        const result = await scheduler.runAgent({
          parentTurnId: `duration-parent-${Math.floor(index / 10)}`,
          profileId: "tester",
          task: taskName,
        });
        failed = result.status !== "completed";
        if (failed) errors.push(result.safeError ?? result.summary);
      } catch (error) {
        failed = true;
        errors.push(error instanceof Error ? error.message : String(error));
      } finally {
        completions.push({ atMs: performance.now() - started, latencyMs: performance.now() - taskStarted, failed });
      }
    }
  };
  await Promise.all(Array.from({ length: input.concurrency }, worker));
  const actualRunDurationMs = performance.now() - started;
  clearInterval(memoryTimer);
  memorySamples.push({ atMs: actualRunDurationMs, rss: process.memoryUsage().rss });
  eventLoop.disable();

  const completedTasks = completions.filter((item) => !item.failed).length;
  const failedTasks = completions.length - completedTasks;
  const returnsBeforeDrain = runtimeStore.listReturns();
  const drainStarted = performance.now();
  for (const item of returnsBeforeDrain) {
    runtimeStore.createReturn({
      jobId: item.jobId, rootRunId: item.rootRunId, parentRunId: item.parentRunId,
      childRunId: item.childRunId, taskId: item.taskId, sequence: item.sequence,
      result: item.result, idempotencyKey: item.idempotencyKey,
    });
  }
  const afterReplay = runtimeStore.listReturns();
  const uniqueReturnKeys = new Set(afterReplay.map((item) => item.idempotencyKey));
  const duplicateReturns = afterReplay.length - uniqueReturnKeys.size;
  const lostReturns = Math.max(0, completions.length - uniqueReturnKeys.size);
  for (const item of afterReplay) {
    const claimed = runtimeStore.claimReturn(item.id);
    if (claimed !== undefined) runtimeStore.consumeReturn(claimed.id);
  }
  const pendingReturnsAfterDrain = runtimeStore.listReturns().filter((item) => item.status === "ready" || item.status === "delivering").length;
  const consumedReturns = runtimeStore.exportSnapshot().returnReceipts.length;
  const drainDurationMs = performance.now() - drainStarted;
  const recoveryJob = runtimeStore.listJobs()[0];
  let expiredLeaseProbeRecovered = false;
  if (recoveryJob !== undefined) {
    const probe = runtimeStore.createTask({
      jobId: recoveryJob.id, rootRunId: recoveryJob.rootRunId, ownerRunId: "duration-recovery-owner", profileId: "tester",
      title: "duration lease recovery probe", objective: "verify recovery after soak", scope: { allowedPaths: [], deniedPaths: [], nonGoals: [] },
      requiredOutputs: [], acceptanceCriteria: [], fileClaims: [], maxAttempts: 1, status: "ready",
    });
    runtimeStore.claimTask(probe.id, "duration-recovery-owner", 1);
    expiredLeaseProbeRecovered = runtimeStore.recoverExpiredLeases("9999-12-31T23:59:59.999Z").some((item) => item.id === probe.id);
  }

  const windows = buildWindows(completions, memorySamples, actualRunDurationMs, input.windowMs);
  const completeWindows = windows.filter((item) => item.durationMs >= input.windowMs * 0.9);
  const sustainedThroughputRatio = throughputRatio(completeWindows);
  const latencies = completions.map((item) => item.latencyMs);
  const latency = latencyStats(latencies);
  const queueWait = latencyStats(queueWaits);
  const rssEnd = memorySamples.at(-1)?.rss ?? rssStart;
  const rssPeak = Math.max(...memorySamples.map((item) => item.rss));
  const rssGrowthMb = bytesToMb(rssEnd - rssStart);
  const rssSlopeMbPerMinute = calculateRssSlopeMbPerMinute(memorySamples);
  const eventLoopDelay = {
    p95: round(eventLoop.percentile(95) / 1e6),
    max: round(eventLoop.max / 1e6),
    mean: round(eventLoop.mean / 1e6),
  };
  const errorRate = completions.length === 0 ? 1 : failedTasks / completions.length;
  const failures = [
    ...(errorRate > gates.maxErrorRate ? [`errorRate ${round(errorRate)} > ${gates.maxErrorRate}`] : []),
    ...(lostReturns > gates.maxLostReturns ? [`lostReturns ${lostReturns} > ${gates.maxLostReturns}`] : []),
    ...(duplicateReturns > gates.maxDuplicateReturns ? [`duplicateReturns ${duplicateReturns} > ${gates.maxDuplicateReturns}`] : []),
    ...(pendingReturnsAfterDrain > 0 ? [`pendingReturnsAfterDrain ${pendingReturnsAfterDrain} > 0`] : []),
    ...(consumedReturns !== completions.length ? [`consumedReturns ${consumedReturns} != finishedTasks ${completions.length}`] : []),
    ...(!expiredLeaseProbeRecovered ? ["expired lease recovery probe failed"] : []),
    ...(latency.p95 > gates.maxP95Ms ? [`p95 ${latency.p95}ms > ${gates.maxP95Ms}ms`] : []),
    ...(bytesToMb(rssPeak) > gates.maxPeakRssMb ? [`peakRss ${round(bytesToMb(rssPeak))}MB > ${gates.maxPeakRssMb}MB`] : []),
    ...(rssGrowthMb > gates.maxRssGrowthMb ? [`rssGrowth ${round(rssGrowthMb)}MB > ${gates.maxRssGrowthMb}MB`] : []),
    ...(rssSlopeMbPerMinute > gates.maxRssSlopeMbPerMinute ? [`rssSlope ${round(rssSlopeMbPerMinute)}MB/min > ${gates.maxRssSlopeMbPerMinute}MB/min`] : []),
    ...(eventLoopDelay.p95 > gates.maxEventLoopDelayP95Ms ? [`eventLoopP95 ${eventLoopDelay.p95}ms > ${gates.maxEventLoopDelayP95Ms}ms`] : []),
    ...(completeWindows.length >= 2 && sustainedThroughputRatio < gates.minSustainedThroughputRatio
      ? [`sustainedThroughputRatio ${round(sustainedThroughputRatio)} < ${gates.minSustainedThroughputRatio}`] : []),
  ];
  const nearDegradation = sustainedThroughputRatio < Math.min(0.85, gates.minSustainedThroughputRatio + 0.15)
    || latency.p95 > gates.maxP95Ms * 0.7
    || rssGrowthMb > gates.maxRssGrowthMb * 0.7;
  const cpuUsage = process.cpuUsage(initialCpu);
  const totalWallMs = performance.now() - started;
  return {
    name: input.name, mode: input.mode, concurrency: input.concurrency,
    targetDurationMs: input.durationMs, actualRunDurationMs: round(actualRunDurationMs), fakeLatencyMs: input.fakeLatencyMs,
    safeTaskLimit: input.safeTaskLimit, stopReason,
    counts: { jobs: Math.ceil(completions.length / 10), startedTasks: completions.length, completedTasks, failedTasks,
      returns: returnsBeforeDrain.length, consumedReturns, pendingReturnsAfterDrain, duplicateReturns, lostReturns },
    throughputTasksPerSecond: round((completedTasks * 1_000) / Math.max(actualRunDurationMs, 0.001)),
    successRate: round(completedTasks / Math.max(completions.length, 1)), latencyMs: latency, queueWaitMs: queueWait,
    errorRate: round(errorRate), errorCategories: classifyErrors(errors),
    cpu: { userMs: round(cpuUsage.user / 1_000), systemMs: round(cpuUsage.system / 1_000),
      utilizationPercent: round(((cpuUsage.user + cpuUsage.system) / 1_000 / Math.max(totalWallMs, 0.001)) * 100) },
    rss: { startMb: round(bytesToMb(rssStart)), endMb: round(bytesToMb(rssEnd)), peakMb: round(bytesToMb(rssPeak)),
      growthMb: round(rssGrowthMb), slopeMbPerMinute: round(rssSlopeMbPerMinute) },
    eventLoopDelayMs: eventLoopDelay, windows, sustainedThroughputRatio: round(sustainedThroughputRatio),
    drain: { durationMs: round(drainDurationMs), complete: pendingReturnsAfterDrain === 0 && consumedReturns === completions.length },
    recovery: { expiredLeaseProbeRecovered },
    classification: failures.length > 0 ? "terminal" : nearDegradation ? "degraded" : "stable",
    gate: { passed: failures.length === 0, failures }, errors: errors.slice(0, 20),
  };
}

export async function writeDurationCapacityReport(report: DurationCapacityReport, outputDirectory = resolve("reports/capacity")): Promise<{ jsonPath: string; markdownPath: string }> {
  await mkdir(outputDirectory, { recursive: true });
  const stamp = report.startedAt.replaceAll(":", "-").replaceAll(".", "-");
  const base = `${stamp}-${sanitize(report.label)}`;
  const jsonPath = join(outputDirectory, `${base}.json`);
  const markdownPath = join(outputDirectory, `${base}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderDurationMarkdownReport(report), "utf8");
  return { jsonPath, markdownPath };
}

export function renderDurationMarkdownReport(report: DurationCapacityReport): string {
  const rows = report.levels.map((item) => `| ${item.name} | ${item.concurrency} | ${item.actualRunDurationMs} | ${item.counts.completedTasks} | ${item.throughputTasksPerSecond} | ${item.latencyMs.p95} | ${item.queueWaitMs.p95} | ${item.successRate} | ${item.sustainedThroughputRatio} | ${item.rss.growthMb}/${item.rss.slopeMbPerMinute} | ${item.cpu.utilizationPercent} | ${item.eventLoopDelayMs.p95} | ${item.counts.duplicateReturns}/${item.counts.lostReturns}/${item.counts.pendingReturnsAfterDrain} | ${item.classification} |`).join("\n");
  const windowSections = report.levels.map((level) => `### ${level.name} / concurrency ${level.concurrency}\n\n| Window | Task/s | p95 ms | errors | RSS start/end/peak MB |\n|---:|---:|---:|---:|---:|\n${level.windows.map((window) => `| ${window.index} | ${window.throughputTasksPerSecond} | ${window.latencyP95Ms} | ${window.errors} | ${window.rssStartMb}/${window.rssEndMb}/${window.rssPeakMb} |`).join("\n")}`).join("\n\n");
  return `# God-Agent Runtime Duration Capacity Report\n\n- 标签：${report.label}\n- 模式：${report.workload.mode}（固定并发、有界 in-flight）\n- Benchmark：${report.benchmark} v${report.benchmarkVersion} / schema v${report.schemaVersion}\n- Git：${report.environment.gitCommit}（dirty=${report.environment.gitDirty}）\n- Provider：${FAKE_PROVIDER_LABEL}\n- 限制：这是短时本机运行，long-term soak **未测试**，不得外推为长期容量或真实 Provider 容量。\n- 建议持续并发：${report.verdict.recommendedConcurrency ?? "无通过档"}\n- 首个退化并发：${report.verdict.firstDegradedConcurrency ?? "本轮未发现"}\n\n| 档位 | 并发 | 实际 ms | 完成 Task | Task/s | 延迟 p95 | 排队 p95 | 成功率 | 尾/头吞吐比 | RSS 增长/斜率 MB/min | CPU % | Event loop p95 | 重复/丢失/未drain | 分类 |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|\n${rows}\n\n## 5 秒窗口\n\n${windowSections}\n\n## 门禁\n\n\`\`\`json\n${JSON.stringify(report.gates, null, 2)}\n\`\`\`\n`;
}

function buildWindows(completions: Array<{ atMs: number; latencyMs: number; failed: boolean }>, samples: Array<{ atMs: number; rss: number }>, totalMs: number, windowMs: number): DurationWindowMetric[] {
  const count = Math.max(1, Math.ceil(totalMs / windowMs));
  return Array.from({ length: count }, (_, index) => {
    const startMs = index * windowMs;
    const endMs = Math.min(totalMs, (index + 1) * windowMs);
    const durationMs = Math.max(1, endMs - startMs);
    const items = completions.filter((item) => item.atMs >= startMs && item.atMs < (index + 1) * windowMs);
    const rssItems = samples.filter((item) => item.atMs >= startMs && item.atMs <= endMs);
    const prior = [...samples].reverse().find((item) => item.atMs <= startMs) ?? samples[0]!;
    const final = rssItems.at(-1) ?? prior;
    return {
      index, startMs: round(startMs), endMs: round(endMs), durationMs: round(durationMs),
      completedTasks: items.filter((item) => !item.failed).length, errors: items.filter((item) => item.failed).length,
      throughputTasksPerSecond: round((items.filter((item) => !item.failed).length * 1_000) / durationMs),
      latencyP95Ms: latencyStats(items.map((item) => item.latencyMs)).p95,
      rssStartMb: round(bytesToMb(prior.rss)), rssEndMb: round(bytesToMb(final.rss)),
      rssPeakMb: round(bytesToMb(Math.max(prior.rss, ...rssItems.map((item) => item.rss)))),
    };
  });
}

function throughputRatio(windows: DurationWindowMetric[]): number {
  if (windows.length < 2) return 1;
  const count = Math.min(2, Math.floor(windows.length / 2));
  const head = average(windows.slice(0, count).map((item) => item.throughputTasksPerSecond));
  const tail = average(windows.slice(-count).map((item) => item.throughputTasksPerSecond));
  return head <= 0 ? (tail <= 0 ? 1 : Number.POSITIVE_INFINITY) : tail / head;
}

function calculateRssSlopeMbPerMinute(samples: Array<{ atMs: number; rss: number }>): number {
  if (samples.length < 2) return 0;
  const xs = samples.map((item) => item.atMs / 60_000);
  const ys = samples.map((item) => bytesToMb(item.rss));
  const xMean = average(xs); const yMean = average(ys);
  const denominator = xs.reduce((sum, x) => sum + (x - xMean) ** 2, 0);
  if (denominator === 0) return 0;
  return xs.reduce((sum, x, index) => sum + (x - xMean) * (ys[index]! - yMean), 0) / denominator;
}

function average(values: number[]): number { return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length; }
function classifyErrors(errors: string[]): Record<string, number> {
  const categories: Record<string, number> = {};
  for (const error of errors) {
    const category = /budget/i.test(error) ? "budget" : /timeout|timed out/i.test(error) ? "timeout"
      : /provider/i.test(error) ? "provider" : /return/i.test(error) ? "return" : "runtime";
    categories[category] = (categories[category] ?? 0) + 1;
  }
  return categories;
}
function sanitize(value: string): string { return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "duration"; }
function assertDurationInput(concurrencyLevels: number[], durationMs: number, windowMs: number, fakeLatencyMs: number, safeTaskLimit: number): void {
  if (concurrencyLevels.length === 0 || concurrencyLevels.some((value) => !Number.isInteger(value) || value < 1 || value > 128)) throw new Error("concurrency must contain integers from 1 to 128");
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error("durationMs must be finite and positive");
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error("windowMs must be finite and positive");
  if (!Number.isFinite(fakeLatencyMs) || fakeLatencyMs <= 0) throw new Error("fakeLatencyMs must be finite and positive");
  if (!Number.isInteger(safeTaskLimit) || safeTaskLimit < 1) throw new Error("safeTaskLimit must be a positive integer");
}
