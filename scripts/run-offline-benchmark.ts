import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BENCHMARK_VARIANTS, type BenchmarkVariant } from "../research/benchmarks/src/types.js";
import { buildReport, writeReport } from "../research/benchmarks/src/runner.js";
import type { BenchmarkReport } from "../research/benchmarks/src/types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = path.join(ROOT, "research", "benchmarks", "task-manifest.json");
const DEFAULT_CONFIGS = [...BENCHMARK_VARIANTS];

interface TaskManifest {
  schemaVersion: "offline-task-manifest-v1";
  suite: string;
  benchmark: "GATE-30";
  fixture: string;
  defaultSeed: number;
  taskCount: number;
  configs: BenchmarkVariant[];
  tasks: Array<{ taskId: string; caseIndex: number; category: string }>;
}

interface CliOptions {
  suite: "gate30";
  configs: BenchmarkVariant[];
  seed?: number;
  dryRun: boolean;
  output?: string;
}

interface RunRecord {
  schemaVersion: "offline-run-record-v1";
  runId: string;
  suite: string;
  benchmark: "GATE-30";
  seed: number;
  configs: BenchmarkVariant[];
  dryRun: boolean;
  taskManifest: string;
  startedAt: string;
  completedAt: string;
  reportPath: string | null;
  summaries: BenchmarkReport["summaries"];
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const manifest = await loadManifest();
  const seed = options.seed ?? manifest.defaultSeed;
  const startedAt = new Date().toISOString();
  const outputDirectory = options.output === undefined
    ? path.join(ROOT, "research", "benchmarks", "results", `offline-${options.suite}-seed-${seed}`)
    : path.resolve(options.output);
  const runId = `${options.suite}-${seed}-${options.configs.join("-")}-${Date.now()}`;

  if (options.dryRun) {
    const record = makeRunRecord(runId, manifest, seed, options.configs, true, startedAt, new Date().toISOString(), null, []);
    process.stdout.write(`${JSON.stringify({ plan: record, outputDirectory }, null, 2)}\n`);
    return;
  }

  const report = await buildReport({ gate: 30, seed, variants: options.configs });
  if (report.cases.length !== manifest.taskCount * options.configs.length) {
    throw new Error(`Task manifest expects ${manifest.taskCount} tasks per config, got ${report.cases.length}`);
  }
  await writeReport(report, outputDirectory);
  const completedAt = new Date().toISOString();
  const reportPath = path.join(outputDirectory, "report.json");
  const record = makeRunRecord(runId, manifest, seed, options.configs, false, startedAt, completedAt, reportPath, report.summaries);
  await writeFile(path.join(outputDirectory, "run-record.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ run: record, outputDirectory }, null, 2)}\n`);
}

function makeRunRecord(
  runId: string,
  manifest: TaskManifest,
  seed: number,
  configs: BenchmarkVariant[],
  dryRun: boolean,
  startedAt: string,
  completedAt: string,
  reportPath: string | null,
  summaries: BenchmarkReport["summaries"],
): RunRecord {
  return {
    schemaVersion: "offline-run-record-v1",
    runId,
    suite: manifest.suite,
    benchmark: manifest.benchmark,
    seed,
    configs,
    dryRun,
    taskManifest: path.relative(ROOT, MANIFEST_PATH).replaceAll(path.sep, "/"),
    startedAt,
    completedAt,
    reportPath,
    summaries,
  };
}

async function loadManifest(): Promise<TaskManifest> {
  const value: unknown = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid offline task manifest");
  const manifest = value as Partial<TaskManifest>;
  if (manifest.schemaVersion !== "offline-task-manifest-v1" || manifest.suite !== "gate30" || manifest.benchmark !== "GATE-30") {
    throw new Error("Unsupported offline task manifest");
  }
  const taskCount = manifest.taskCount;
  if (!Number.isInteger(manifest.defaultSeed) || typeof taskCount !== "number" || !Number.isInteger(taskCount) || taskCount < 1) {
    throw new Error("Offline task manifest has invalid seed or task count");
  }
  if (!Array.isArray(manifest.configs) || manifest.configs.length === 0 || manifest.configs.some((item) => !BENCHMARK_VARIANTS.includes(item as BenchmarkVariant))) {
    throw new Error("Offline task manifest has invalid configs");
  }
  if (!Array.isArray(manifest.tasks) || manifest.tasks.length !== taskCount) {
    throw new Error("Offline task manifest task count mismatch");
  }
  return manifest as TaskManifest;
}

function parseArgs(args: string[]): CliOptions {
  let suite: "gate30" = "gate30";
  let configs: BenchmarkVariant[] = DEFAULT_CONFIGS;
  let seed: number | undefined;
  let dryRun = false;
  let output: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--suite") {
      const value = args[++index];
      if (value !== "gate30") throw new Error("--suite currently supports gate30");
      suite = value;
    } else if (arg === "--config") {
      const value = args[++index] ?? "";
      configs = parseConfigs(value);
    } else if (arg === "--seed") {
      const value = args[++index] ?? "";
      if (!/^\d+$/.test(value)) throw new Error("--seed must be a non-negative integer");
      seed = Number(value);
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--output") {
      output = args[++index];
      if (output === undefined || output.length === 0) throw new Error("--output requires a directory");
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg ?? ""}`);
    }
  }
  return {
    suite,
    configs,
    dryRun,
    ...(seed === undefined ? {} : { seed }),
    ...(output === undefined ? {} : { output }),
  };
}

function parseConfigs(value: string): BenchmarkVariant[] {
  if (value === "all") return [...DEFAULT_CONFIGS];
  const selected = value.split(",").filter((item): item is BenchmarkVariant => BENCHMARK_VARIANTS.includes(item as BenchmarkVariant));
  if (selected.length === 0 || selected.length !== value.split(",").length || new Set(selected).size !== selected.length) {
    throw new Error(`--config must contain unique values from: ${BENCHMARK_VARIANTS.join(",")}`);
  }
  return selected;
}

function printUsage(): void {
  process.stdout.write([
    "Usage: npm run benchmark:offline -- [options]",
    "  --suite gate30                 Offline suite (default: gate30)",
    "  --config all|baseline,...      Configurations to run (default: all)",
    "  --seed INTEGER                 Override the manifest seed",
    "  --dry-run                      Print the run plan without writing a report",
    "  --output DIRECTORY             Report output directory",
  ].join("\n") + "\n");
}

await main();
