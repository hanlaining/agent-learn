import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { arch, cpus, freemem, hostname, platform, release, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { AgentRegistry } from "../../src/agents/agent-registry.js";
import { AgentRunStore } from "../../src/agents/agent-run-store.js";
import { AgentRuntimeStore } from "../../src/agents/agent-runtime-store.js";
import { MultiAgentScheduler } from "../../src/agents/multi-agent-scheduler.js";
import type { AgentTeamConfig } from "../../src/agents/agent-runtime.js";

export const FAKE_PROVIDER_LABEL = "deterministic-local-fake-provider (NO NETWORK / NO PAID PROVIDER)";
export const BENCHMARK_VERSION = "1.0.0";

export interface CapacityLevel {
  name: string;
  tasks: number;
  tasksPerJob: number;
  concurrency: number;
  fakeLatencyMs: number;
}

export interface CapacityGates {
  maxErrorRate: number;
  maxLostReturns: number;
  maxDuplicateReturns: number;
  maxP95Ms: number;
  maxDurationMs: number;
  maxPeakRssMb: number;
}

export interface CapacityLevelResult {
  level: CapacityLevel;
  provider: typeof FAKE_PROVIDER_LABEL;
  startedAt: string;
  durationMs: number;
  throughputTasksPerSecond: number;
  successRate: number;
  latencyMs: { p50: number; p95: number; p99: number; max: number };
  queueWaitMs: { p50: number; p95: number; p99: number; max: number };
  counts: {
    jobs: number; requestedTasks: number; startedTasks: number; completedTasks: number; failedTasks: number; unstartedTasks: number;
    runs: number; returns: number; consumedReturns: number; duplicateReturns: number; lostReturns: number;
    recoveredExpiredLeases: number;
  };
  errorRate: number;
  errorCategories: Record<string, number>;
  cpu: { userMs: number; systemMs: number; utilizationPercent: number };
  peakRssMb: number;
  rssDeltaMb: number;
  persistence: { snapshotBytes: number; serializeMs: number; restoreMs: number };
  returnStorm: { durationMs: number; throughputPerSecond: number };
  classification: "stable" | "degraded" | "terminal";
  gate: { passed: boolean; failures: string[] };
  errors: string[];
}

export interface CapacityReport {
  schemaVersion: 1;
  benchmark: "god-agent-runtime-capacity";
  benchmarkVersion: typeof BENCHMARK_VERSION;
  disclaimer: string;
  workload: { model: "bounded-spike"; steadyStateTested: false; soakTested: false };
  label: string;
  startedAt: string;
  completedAt: string;
  environment: ReturnType<typeof environmentFingerprint>;
  gates: CapacityGates;
  levels: CapacityLevelResult[];
  termination: { reason: "gate_failed" | "safe_limit_reached" | "completed_requested_levels"; level: string; details: string };
}

export const DEFAULT_GATES: CapacityGates = {
  maxErrorRate: 0,
  maxLostReturns: 0,
  maxDuplicateReturns: 0,
  maxP95Ms: 10_000,
  maxDurationMs: 30_000,
  maxPeakRssMb: 1_024,
};

export function buildLevels(taskCounts: number[], options: Partial<Pick<CapacityLevel, "tasksPerJob" | "concurrency" | "fakeLatencyMs">> = {}): CapacityLevel[] {
  return taskCounts.map((tasks, index) => ({
    name: `S${index}`,
    tasks,
    tasksPerJob: Math.min(10, options.tasksPerJob ?? 10),
    concurrency: Math.max(1, options.concurrency ?? Math.min(32, Math.max(4, Math.ceil(tasks / 10)))),
    fakeLatencyMs: Math.max(0, options.fakeLatencyMs ?? 2),
  }));
}

export async function runCapacityStaircase(input: {
  levels: CapacityLevel[];
  gates?: Partial<CapacityGates>;
  label?: string;
  stopOnFailure?: boolean;
  safeTaskLimit?: number;
}): Promise<CapacityReport> {
  const startedAt = new Date().toISOString();
  const gates = { ...DEFAULT_GATES, ...input.gates };
  const safeTaskLimit = input.safeTaskLimit ?? 5_000;
  const results: CapacityLevelResult[] = [];
  let termination: CapacityReport["termination"] = {
    reason: "completed_requested_levels", level: "none", details: "All requested levels completed",
  };
  for (const level of input.levels) {
    if (level.tasks > safeTaskLimit) {
      termination = { reason: "safe_limit_reached", level: level.name, details: `Requested ${level.tasks} tasks exceeds safe limit ${safeTaskLimit}` };
      break;
    }
    const result = await runCapacityLevel(level, gates);
    const previousBestThroughput = Math.max(0, ...results.map((item) => item.throughputTasksPerSecond));
    result.classification = !result.gate.passed
      ? "terminal"
      : previousBestThroughput > 0 && result.throughputTasksPerSecond < previousBestThroughput * 0.7
        ? "degraded"
        : result.latencyMs.p95 > gates.maxP95Ms * 0.5
          ? "degraded"
          : "stable";
    results.push(result);
    termination = { reason: "completed_requested_levels", level: level.name, details: "Level completed" };
    if (!result.gate.passed && input.stopOnFailure !== false) {
      termination = { reason: "gate_failed", level: level.name, details: result.gate.failures.join("; ") };
      break;
    }
    if (level.tasks === safeTaskLimit) {
      termination = { reason: "safe_limit_reached", level: level.name, details: `Reached configured safe limit ${safeTaskLimit}` };
      break;
    }
  }
  return {
    schemaVersion: 1,
    benchmark: "god-agent-runtime-capacity",
    benchmarkVersion: BENCHMARK_VERSION,
    disclaimer: `${FAKE_PROVIDER_LABEL}; bounded spike only; steady-state/soak NOT TESTED; results measure local Runtime orchestration/storage, not model-provider capacity.`,
    workload: { model: "bounded-spike", steadyStateTested: false, soakTested: false },
    label: input.label ?? "local",
    startedAt,
    completedAt: new Date().toISOString(),
    environment: environmentFingerprint(),
    gates,
    levels: results,
    termination,
  };
}

export async function runCapacityLevel(level: CapacityLevel, gates: CapacityGates = DEFAULT_GATES): Promise<CapacityLevelResult> {
  assertLevel(level);
  const startedAt = new Date().toISOString();
  const initialRss = process.memoryUsage().rss;
  const initialCpu = process.cpuUsage();
  let peakRss = initialRss;
  const memorySampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 5);
  memorySampler.unref();
  const runStore = new AgentRunStore();
  const runtimeStore = new AgentRuntimeStore();
  const registry = new AgentRegistry();
  const jobCount = Math.ceil(level.tasks / level.tasksPerJob);
  const configs = new Map<string, AgentTeamConfig>();
  for (let job = 0; job < jobCount; job += 1) {
    configs.set(`parent-${job}`, {
      version: 1, mode: "auto", maxSubagents: level.tasksPerJob, maxConcurrent: Math.min(10, level.concurrency), maxDepth: 3,
      allowedProfiles: ["investigator", "researcher", "coder", "tester", "reviewer"], scheduling: "independent_only",
      accessMode: "read_only", permissionMode: "least_privilege", shareBoard: false, independentReview: false,
      modelRouting: "inherit_chat", allowedTools: [], allowedSkills: [],
    });
  }
  let sequence = 0;
  const requestedAtByTask = new Map<string, number>();
  const queueWaits: number[] = [];
  const scheduler = new MultiAgentScheduler({
    registry, store: runStore, runtimeStore, maxConcurrentRuns: level.concurrency,
    resolveParent: (turnId) => {
      const teamConfig = configs.get(turnId);
      return { threadId: `thread-${turnId}`, ...(teamConfig === undefined ? {} : { teamConfig }) };
    },
    prepare: (_profile, task) => ({
      threadId: `fake-thread-${++sequence}`,
      turnId: `fake-turn-${sequence}`,
      execute: async () => {
        const requestedAt = requestedAtByTask.get(task);
        if (requestedAt !== undefined) queueWaits.push(performance.now() - requestedAt);
        if (level.fakeLatencyMs > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, level.fakeLatencyMs));
        return `FAKE_RESULT:${task}`;
      },
    }),
  });
  const errors: string[] = [];
  const latencies: number[] = [];
  const started = performance.now();
  const execution = await runBounded(level.tasks, level.concurrency, async (index) => {
    const callStarted = performance.now();
    const taskName = `capacity-task-${index}`;
    requestedAtByTask.set(taskName, callStarted);
    try {
      return await scheduler.runAgent({
        parentTurnId: `parent-${Math.floor(index / level.tasksPerJob)}`,
        profileId: "tester",
        task: taskName,
      });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      return undefined;
    } finally {
      latencies.push(performance.now() - callStarted);
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }
  }, () => performance.now() - started >= gates.maxDurationMs);
  const callResults = execution.results;
  const durationMs = performance.now() - started;
  const completedTasks = callResults.filter((item) => item?.status === "completed").length;
  const failedTasks = execution.started - completedTasks;
  const unstartedTasks = level.tasks - execution.started;
  const returns = runtimeStore.listReturns();
  const stormStarted = performance.now();
  // Replay every publication once: this is the duplicate Return storm. The
  // outbox must collapse it by idempotency key without growing.
  for (const item of returns) {
    runtimeStore.createReturn({
      jobId: item.jobId, rootRunId: item.rootRunId, parentRunId: item.parentRunId,
      childRunId: item.childRunId, taskId: item.taskId, sequence: item.sequence,
      result: item.result, idempotencyKey: item.idempotencyKey,
      ...(item.jobAttempt === undefined ? {} : { jobAttempt: item.jobAttempt }),
      ...(item.workflowVersion === undefined ? {} : { workflowVersion: item.workflowVersion }),
      ...(item.stageId === undefined ? {} : { stageId: item.stageId }),
      ...(item.stageAttempt === undefined ? {} : { stageAttempt: item.stageAttempt }),
      ...(item.businessAttempt === undefined ? {} : { businessAttempt: item.businessAttempt }),
    });
  }
  const returnsAfterDuplicateStorm = runtimeStore.listReturns();
  const uniqueReturnKeys = new Set(returnsAfterDuplicateStorm.map((item) => item.idempotencyKey));
  const lostReturns = Math.max(0, completedTasks - uniqueReturnKeys.size);
  const duplicateReturns = returnsAfterDuplicateStorm.length - uniqueReturnKeys.size;

  await Promise.all(returnsAfterDuplicateStorm.map(async (item) => {
    const claimed = runtimeStore.claimReturn(item.id);
    if (claimed !== undefined) runtimeStore.consumeReturn(claimed.id);
    await Promise.resolve();
  }));
  const returnStormDurationMs = performance.now() - stormStarted;
  const consumedReturns = runtimeStore.exportSnapshot().returnReceipts.length;

  // Exercise persistence/restart reconstruction under the same object volume.
  const serializeStarted = performance.now();
  const serialized = JSON.stringify(runtimeStore.exportSnapshot());
  const serializeMs = performance.now() - serializeStarted;
  const restoreStarted = performance.now();
  const restored = AgentRuntimeStore.fromSnapshot(JSON.parse(serialized) as ReturnType<AgentRuntimeStore["exportSnapshot"]>);
  const restoreMs = performance.now() - restoreStarted;

  // Exercise lease-recovery pressure without changing production behavior.
  const recoveryJob = restored.listJobs()[0];
  let recoveredExpiredLeases = 0;
  if (recoveryJob !== undefined) {
    const recoveryTask = restored.createTask({
      jobId: recoveryJob.id, rootRunId: recoveryJob.rootRunId, ownerRunId: "recovery-owner", profileId: "tester",
      title: "lease recovery probe", objective: "capacity recovery probe", scope: { allowedPaths: [], deniedPaths: [], nonGoals: [] },
      requiredOutputs: [], acceptanceCriteria: [], fileClaims: [], maxAttempts: 1, status: "ready",
    });
    restored.claimTask(recoveryTask.id, "recovery-owner", 1);
    recoveredExpiredLeases = restored.recoverExpiredLeases("9999-12-31T23:59:59.999Z").length;
  }
  clearInterval(memorySampler);
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  const errorRate = failedTasks / level.tasks;
  const stats = latencyStats(latencies);
  const queueStats = latencyStats(queueWaits);
  const peakRssMb = bytesToMb(peakRss);
  const failures = [
    ...(errorRate > gates.maxErrorRate ? [`errorRate ${errorRate} > ${gates.maxErrorRate}`] : []),
    ...(lostReturns > gates.maxLostReturns ? [`lostReturns ${lostReturns} > ${gates.maxLostReturns}`] : []),
    ...(duplicateReturns > gates.maxDuplicateReturns ? [`duplicateReturns ${duplicateReturns} > ${gates.maxDuplicateReturns}`] : []),
    ...(stats.p95 > gates.maxP95Ms ? [`p95 ${stats.p95.toFixed(2)}ms > ${gates.maxP95Ms}ms`] : []),
    ...(durationMs > gates.maxDurationMs ? [`duration ${durationMs.toFixed(2)}ms > ${gates.maxDurationMs}ms`] : []),
    ...(unstartedTasks > 0 ? [`wall-clock safety stop left ${unstartedTasks} tasks unstarted`] : []),
    ...(peakRssMb > gates.maxPeakRssMb ? [`peakRss ${peakRssMb.toFixed(2)}MB > ${gates.maxPeakRssMb}MB`] : []),
    ...(consumedReturns !== completedTasks ? [`consumedReturns ${consumedReturns} != completedTasks ${completedTasks}`] : []),
    ...(recoveredExpiredLeases !== 1 ? [`recoveredExpiredLeases ${recoveredExpiredLeases} != 1`] : []),
  ];
  const cpuUsage = process.cpuUsage(initialCpu);
  const totalWallMs = performance.now() - started;
  return {
    level, provider: FAKE_PROVIDER_LABEL, startedAt, durationMs: round(durationMs),
    throughputTasksPerSecond: round((completedTasks * 1_000) / Math.max(durationMs, 0.001)),
    successRate: round(completedTasks / Math.max(execution.started, 1)), latencyMs: stats, queueWaitMs: queueStats,
    counts: { jobs: Math.ceil(execution.started / level.tasksPerJob), requestedTasks: level.tasks, startedTasks: execution.started,
      completedTasks, failedTasks, unstartedTasks, runs: runStore.list().length,
      returns: returns.length, consumedReturns, duplicateReturns, lostReturns, recoveredExpiredLeases },
    errorRate: round(errorRate), errorCategories: classifyErrors(errors),
    cpu: { userMs: round(cpuUsage.user / 1_000), systemMs: round(cpuUsage.system / 1_000),
      utilizationPercent: round(((cpuUsage.user + cpuUsage.system) / 1_000 / Math.max(totalWallMs, 0.001)) * 100) },
    peakRssMb: round(peakRssMb), rssDeltaMb: round(bytesToMb(peakRss - initialRss)),
    persistence: { snapshotBytes: Buffer.byteLength(serialized), serializeMs: round(serializeMs), restoreMs: round(restoreMs) },
    returnStorm: { durationMs: round(returnStormDurationMs), throughputPerSecond: round((returnsAfterDuplicateStorm.length * 1_000) / Math.max(returnStormDurationMs, 0.001)) },
    classification: failures.length === 0 ? "stable" : "terminal",
    gate: { passed: failures.length === 0, failures }, errors: errors.slice(0, 20),
  };
}

export async function writeCapacityReport(report: CapacityReport, outputDirectory = resolve("reports/capacity")): Promise<{ jsonPath: string; markdownPath: string }> {
  await mkdir(outputDirectory, { recursive: true });
  const stamp = report.startedAt.replaceAll(":", "-").replaceAll(".", "-");
  const base = `${stamp}-${sanitize(report.label)}`;
  const jsonPath = join(outputDirectory, `${base}.json`);
  const markdownPath = join(outputDirectory, `${base}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderMarkdownReport(report), "utf8");
  return { jsonPath, markdownPath };
}

export function renderMarkdownReport(report: CapacityReport): string {
  const rows = report.levels.map((item) => `| ${item.level.name} | ${item.level.tasks}/${item.counts.startedTasks} | ${item.level.concurrency} | ${item.throughputTasksPerSecond} | ${item.latencyMs.p50}/${item.latencyMs.p95}/${item.latencyMs.p99} | ${item.queueWaitMs.p50}/${item.queueWaitMs.p95}/${item.queueWaitMs.p99} | ${item.successRate} | ${item.cpu.utilizationPercent} | ${item.counts.duplicateReturns}/${item.counts.lostReturns} | ${item.peakRssMb} | ${item.classification} |`).join("\n");
  return `# God-Agent Runtime 容量报告\n\n- 标签：${report.label}\n- 时间：${report.startedAt}\n- 基准：${report.benchmark} v${report.benchmarkVersion} / schema v${report.schemaVersion}\n- Git commit：${report.environment.gitCommit}（dirty=${report.environment.gitDirty}）\n- Provider：${FAKE_PROVIDER_LABEL}\n- 负载模型：有界瞬时 Spike；in-flight 不超过档位并发；steady-state/soak **未测试，不得外推**。\n- 说明：仅测本机 Runtime 编排与存储容量，不代表真实模型 Provider 容量。\n- 终止：${report.termination.reason} @ ${report.termination.level}（${report.termination.details}）\n- 环境：${report.environment.platform} ${report.environment.release} / ${report.environment.arch} / Node ${report.environment.node} / ${report.environment.cpuCount} CPU / ${report.environment.totalMemoryMb} MB RAM\n\n| 档位 | 请求/启动 Task | 并发 | Task/s | 延迟 p50/p95/p99 ms | 排队 p50/p95/p99 ms | 成功率 | CPU % | 重复/丢失 Return | 峰值 RSS MB | 分类 |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|\n${rows}\n\n## 门禁\n\n\`\`\`json\n${JSON.stringify(report.gates, null, 2)}\n\`\`\`\n`;
}

async function runBounded<T>(total: number, concurrency: number, task: (index: number) => Promise<T>, shouldStop: () => boolean = () => false): Promise<{ results: T[]; started: number }> {
  const results = new Array<T>(total);
  let nextIndex = 0;
  let started = 0;
  const workers = Array.from({ length: Math.min(total, concurrency) }, async () => {
    while (true) {
      if (shouldStop()) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= total) return;
      started += 1;
      results[index] = await task(index);
    }
  });
  await Promise.all(workers);
  return { results, started };
}

export function environmentFingerprint() {
  const cpu = cpus();
  const git = resolveGitState();
  return {
    hostname: hostname(), platform: platform(), release: release(), arch: arch(), node: process.version,
    gitCommit: git.commit, gitDirty: git.dirty,
    cpuModel: cpu[0]?.model ?? "unknown", cpuCount: cpu.length,
    totalMemoryMb: round(bytesToMb(totalmem())), freeMemoryMbAtReport: round(bytesToMb(freemem())),
  };
}

export function parsePositiveNumber(value: string, name: string, integer = false): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || (integer && !Number.isInteger(parsed))) {
    throw new Error(`${name} must be a finite positive ${integer ? "integer" : "number"}`);
  }
  return parsed;
}

function resolveGitState(): { commit: string; dirty: boolean | "unknown" } {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "unknown";
    const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0;
    return { commit, dirty };
  } catch {
    return { commit: "unknown", dirty: "unknown" };
  }
}

export function latencyStats(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99), max: round(sorted.at(-1) ?? 0) };
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  return round(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0);
}
export function round(value: number): number { return Math.round(value * 100) / 100; }
export function bytesToMb(value: number): number { return value / 1024 / 1024; }
function sanitize(value: string): string { return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "local"; }
function classifyErrors(errors: string[]): Record<string, number> {
  const categories: Record<string, number> = {};
  for (const error of errors) {
    const category = /budget/i.test(error) ? "budget" : /timeout|timed out/i.test(error) ? "timeout"
      : /provider/i.test(error) ? "provider" : /return/i.test(error) ? "return" : "runtime";
    categories[category] = (categories[category] ?? 0) + 1;
  }
  return categories;
}
function assertLevel(level: CapacityLevel): void {
  if (!Number.isInteger(level.tasks) || level.tasks < 1) throw new Error("tasks must be a positive integer");
  if (!Number.isInteger(level.tasksPerJob) || level.tasksPerJob < 1 || level.tasksPerJob > 10) throw new Error("tasksPerJob must be between 1 and 10");
  if (!Number.isInteger(level.concurrency) || level.concurrency < 1) throw new Error("concurrency must be a positive integer");
  if (!Number.isFinite(level.fakeLatencyMs) || level.fakeLatencyMs < 0) throw new Error("fakeLatencyMs must be a finite non-negative number");
}
