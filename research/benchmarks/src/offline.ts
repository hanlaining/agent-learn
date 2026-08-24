import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateScenarios, loadFixture } from "./fixtures.js";
import type { RunOptions } from "./runner.js";
import { BENCHMARK_VARIANTS, SCENARIO_CATEGORIES, type BenchmarkReport, type BenchmarkScenario, type BenchmarkVariant } from "./types.js";

const BENCHMARK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_OFFLINE_CONFIG = path.join(BENCHMARK_ROOT, "configs", "offline-default.json");

export type OfflineSuite = "gate30" | "gate100";

export interface OfflineBenchmarkConfig {
  schemaVersion: "offline-benchmark-config-v1";
  name: string;
  variants: BenchmarkVariant[];
  verifyDeterminism: boolean;
  shard: { index: number; total: number };
}

export interface OfflineCliOptions {
  suite: OfflineSuite;
  configPath: string;
  seed?: number;
  dryRun: boolean;
  outputDirectory?: string;
}

export interface TaskManifest {
  schemaVersion: "offline-benchmark-task-manifest-v1";
  suite: OfflineSuite;
  benchmark: "GATE-30" | "GATE-100";
  seed: number;
  generatorVersion: "gate-generator-v1";
  config: {
    name: string;
    variants: BenchmarkVariant[];
    shard: { index: number; total: number };
  };
  taskCount: number;
  executionCount: number;
  tasks: BenchmarkScenario[];
}

export interface RunRecord {
  schemaVersion: "offline-benchmark-run-record-v1";
  runId: string;
  status: "completed";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  suite: OfflineSuite;
  seed: number;
  configName: string;
  deterministicVerified: boolean;
  taskCount: number;
  executionCount: number;
  artifacts: {
    manifest: "task-manifest.json";
    report: "report.json";
    summary: "summary.csv";
    cases: "cases.csv";
  };
  summaries: BenchmarkReport["summaries"];
}

export function parseOfflineArgs(args: string[]): OfflineCliOptions {
  let suite: OfflineSuite | undefined;
  let configPath = DEFAULT_OFFLINE_CONFIG;
  let seed: number | undefined;
  let dryRun = false;
  let outputDirectory: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--suite") {
      const value = args[++index];
      if (value !== "gate30" && value !== "gate100") throw new Error("--suite must be gate30 or gate100");
      suite = value;
    } else if (arg === "--config") {
      const value = args[++index];
      if (value === undefined) throw new Error("--config requires a JSON file");
      configPath = path.resolve(value);
    } else if (arg === "--seed") {
      const value = args[++index];
      if (value === undefined || !/^\d+$/.test(value)) throw new Error("--seed must be an unsigned 32-bit integer");
      seed = Number(value);
      assertSeed(seed);
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--output") {
      const value = args[++index];
      if (value === undefined) throw new Error("--output requires a directory");
      outputDirectory = path.resolve(value);
    } else {
      throw new Error(`Unknown argument: ${arg ?? ""}`);
    }
  }
  if (suite === undefined) throw new Error("Missing required --suite gate30|gate100");
  return {
    suite,
    configPath,
    dryRun,
    ...(seed === undefined ? {} : { seed }),
    ...(outputDirectory === undefined ? {} : { outputDirectory }),
  };
}

export async function loadOfflineConfig(filename: string): Promise<OfflineBenchmarkConfig> {
  const value: unknown = JSON.parse(await readFile(filename, "utf8"));
  validateOfflineConfig(value);
  return value;
}

export function validateOfflineConfig(value: unknown): asserts value is OfflineBenchmarkConfig {
  if (!isRecord(value)) throw new Error("Offline benchmark config schema violation: root");
  const variants = value.variants;
  const shard = value.shard;
  const valid = value.schemaVersion === "offline-benchmark-config-v1"
    && typeof value.name === "string" && value.name.length > 0
    && Array.isArray(variants) && variants.length > 0
    && new Set(variants).size === variants.length
    && variants.every((item) => typeof item === "string" && BENCHMARK_VARIANTS.includes(item as BenchmarkVariant))
    && typeof value.verifyDeterminism === "boolean"
    && validShard(shard);
  if (!valid) throw new Error("Offline benchmark config schema violation");
}

export async function buildTaskManifest(
  suite: OfflineSuite,
  config: OfflineBenchmarkConfig,
  seedOverride?: number,
): Promise<TaskManifest> {
  const gate = gateForSuite(suite);
  const loadedFixture = await loadFixture(gate);
  const seed = seedOverride ?? loadedFixture.seed;
  assertSeed(seed);
  const fixture = { ...loadedFixture, seed };
  const tasks = generateScenarios(fixture)
    .filter((scenario) => scenario.caseIndex % config.shard.total === config.shard.index - 1);
  const manifest: TaskManifest = {
    schemaVersion: "offline-benchmark-task-manifest-v1",
    suite,
    benchmark: fixture.name,
    seed,
    generatorVersion: fixture.generatorVersion,
    config: {
      name: config.name,
      variants: [...config.variants],
      shard: { ...config.shard },
    },
    taskCount: tasks.length,
    executionCount: tasks.length * config.variants.length,
    tasks,
  };
  validateTaskManifest(manifest);
  return manifest;
}

export function validateTaskManifest(value: unknown): asserts value is TaskManifest {
  if (!isRecord(value) || !isRecord(value.config) || !Array.isArray(value.tasks)) {
    throw new Error("Task manifest schema violation: root");
  }
  const suiteGate = value.suite === "gate30" ? 30 : value.suite === "gate100" ? 100 : undefined;
  const variants = value.config.variants;
  const tasks = value.tasks;
  const valid = suiteGate !== undefined
    && value.schemaVersion === "offline-benchmark-task-manifest-v1"
    && value.benchmark === `GATE-${suiteGate}`
    && isSeed(value.seed)
    && value.generatorVersion === "gate-generator-v1"
    && typeof value.config.name === "string" && value.config.name.length > 0
    && Array.isArray(variants) && variants.length > 0
    && new Set(variants).size === variants.length
    && variants.every((item) => typeof item === "string" && BENCHMARK_VARIANTS.includes(item as BenchmarkVariant))
    && validShard(value.config.shard)
    && Number.isInteger(value.taskCount) && value.taskCount === tasks.length
    && Number.isInteger(value.executionCount) && value.executionCount === tasks.length * variants.length
    && tasks.every((task) => validManifestTask(task))
    && new Set(tasks.map((task) => isRecord(task) ? task.caseId : undefined)).size === tasks.length
    && new Set(tasks.map((task) => isRecord(task) ? task.caseIndex : undefined)).size === tasks.length;
  if (!valid) throw new Error("Task manifest schema violation");
}

export function createRunRecord(input: {
  suite: OfflineSuite;
  config: OfflineBenchmarkConfig;
  manifest: TaskManifest;
  report: BenchmarkReport;
  startedAt: Date;
  finishedAt: Date;
}): RunRecord {
  const record: RunRecord = {
    schemaVersion: "offline-benchmark-run-record-v1",
    runId: `${input.suite}-seed-${input.manifest.seed}-${input.startedAt.toISOString().replaceAll(/[-:.]/g, "")}`,
    status: "completed",
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    durationMs: Math.max(0, input.finishedAt.getTime() - input.startedAt.getTime()),
    suite: input.suite,
    seed: input.manifest.seed,
    configName: input.config.name,
    deterministicVerified: input.config.verifyDeterminism,
    taskCount: input.manifest.taskCount,
    executionCount: input.report.cases.length,
    artifacts: {
      manifest: "task-manifest.json",
      report: "report.json",
      summary: "summary.csv",
      cases: "cases.csv",
    },
    summaries: input.report.summaries,
  };
  validateRunRecord(record, input.manifest, input.report);
  return record;
}

export function validateRunRecord(value: unknown, manifest?: TaskManifest, report?: BenchmarkReport): asserts value is RunRecord {
  if (!isRecord(value) || !isRecord(value.artifacts) || !Array.isArray(value.summaries)) {
    throw new Error("Run record schema violation: root");
  }
  const valid = value.schemaVersion === "offline-benchmark-run-record-v1"
    && typeof value.runId === "string" && value.runId.length > 0
    && value.status === "completed"
    && validIsoDate(value.startedAt) && validIsoDate(value.finishedAt)
    && typeof value.durationMs === "number" && Number.isFinite(value.durationMs) && value.durationMs >= 0
    && (value.suite === "gate30" || value.suite === "gate100")
    && isSeed(value.seed)
    && typeof value.configName === "string" && value.configName.length > 0
    && typeof value.deterministicVerified === "boolean"
    && Number.isInteger(value.taskCount) && Number(value.taskCount) >= 0
    && Number.isInteger(value.executionCount) && Number(value.executionCount) >= 0
    && value.artifacts.manifest === "task-manifest.json"
    && value.artifacts.report === "report.json"
    && value.artifacts.summary === "summary.csv"
    && value.artifacts.cases === "cases.csv";
  const crossValid = (manifest === undefined || (
    value.suite === manifest.suite
    && value.seed === manifest.seed
    && value.configName === manifest.config.name
    && value.taskCount === manifest.taskCount
  )) && (report === undefined || (
    value.seed === report.fixtureSeed
    && value.executionCount === report.cases.length
    && value.summaries.length === report.summaries.length
  ));
  if (!valid || !crossValid) throw new Error("Run record schema violation");
}

export function runOptionsFor(manifest: TaskManifest): RunOptions {
  return {
    gate: gateForSuite(manifest.suite),
    seed: manifest.seed,
    shardIndex: manifest.config.shard.index,
    shardTotal: manifest.config.shard.total,
    variants: manifest.config.variants,
  };
}

export function defaultOutputDirectory(manifest: TaskManifest): string {
  const suffix = manifest.config.shard.total === 1
    ? ""
    : `-shard-${manifest.config.shard.index}-of-${manifest.config.shard.total}`;
  return path.join(BENCHMARK_ROOT, "results", `offline-${manifest.suite}-seed-${manifest.seed}${suffix}`);
}

function gateForSuite(suite: OfflineSuite): 30 | 100 {
  return suite === "gate30" ? 30 : 100;
}

function validManifestTask(value: unknown): value is BenchmarkScenario {
  if (!isRecord(value)) return false;
  return typeof value.caseId === "string"
    && Number.isInteger(value.caseIndex) && Number(value.caseIndex) >= 0
    && isSeed(value.seed)
    && typeof value.category === "string" && SCENARIO_CATEGORIES.includes(value.category as never)
    && (value.crashPoint === "none" || value.crashPoint === "after-model" || value.crashPoint === "after-tool" || value.crashPoint === "parent-waiting")
    && ["childCount", "duplicateDeliveries", "evidenceRequired", "inputTokensPerModelCall", "outputTokensPerModelCall", "baseLatencyMs"]
      .every((key) => Number.isInteger(value[key]) && Number(value[key]) >= 0)
    && typeof value.contended === "boolean"
    && typeof value.sideEffectful === "boolean";
}

function validShard(value: unknown): value is { index: number; total: number } {
  return isRecord(value)
    && Number.isInteger(value.index) && Number.isInteger(value.total)
    && Number(value.total) >= 1 && Number(value.index) >= 1 && Number(value.index) <= Number(value.total);
}

function validIsoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function assertSeed(seed: number): void {
  if (!isSeed(seed)) throw new Error(`Invalid seed ${seed}; expected an unsigned 32-bit integer`);
}

function isSeed(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 0xffff_ffff;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
