import path from "node:path";
import { fileURLToPath } from "node:url";
import { BENCHMARK_VARIANTS, type BenchmarkVariant } from "./types.js";
import { buildReport, verifyDeterministic, writeReport } from "./runner.js";

interface CliOptions {
  gate: 30 | 100;
  shardIndex: number;
  shardTotal: number;
  variants?: BenchmarkVariant[];
  outputDirectory?: string;
  write: boolean;
  verify: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const runOptions = {
    gate: options.gate,
    shardIndex: options.shardIndex,
    shardTotal: options.shardTotal,
    ...(options.variants === undefined ? {} : { variants: options.variants }),
  };
  if (options.verify) await verifyDeterministic(runOptions);
  const report = await buildReport(runOptions);
  const benchmarkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const suffix = options.shardTotal === 1 ? "" : `-shard-${options.shardIndex}-of-${options.shardTotal}`;
  const outputDirectory = options.outputDirectory
    ?? path.join(benchmarkRoot, "results", `gate-${options.gate}-seed-${report.fixtureSeed}${suffix}`);
  if (options.write) await writeReport(report, outputDirectory);
  process.stdout.write(`${JSON.stringify({
    benchmark: report.benchmark,
    seed: report.fixtureSeed,
    shard: report.shard,
    deterministicVerified: options.verify,
    outputDirectory: options.write ? outputDirectory : null,
    summaries: report.summaries,
  }, null, 2)}\n`);
}

function parseArgs(args: string[]): CliOptions {
  let gate: 30 | 100 | undefined;
  let shardIndex = 1;
  let shardTotal = 1;
  let variants: BenchmarkVariant[] | undefined;
  let outputDirectory: string | undefined;
  let write = true;
  let verify = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--gate") {
      const value = args[++index];
      if (value !== "30" && value !== "100") throw new Error("--gate must be 30 or 100");
      gate = Number(value) as 30 | 100;
    } else if (arg === "--shard") {
      const value = args[++index] ?? "";
      const match = /^(\d+)\/(\d+)$/.exec(value);
      if (match === null) throw new Error("--shard must use INDEX/TOTAL, for example 2/4");
      shardIndex = Number(match[1]);
      shardTotal = Number(match[2]);
    } else if (arg === "--variant") {
      const value = args[++index] ?? "";
      const selected = value.split(",").filter((item): item is BenchmarkVariant => BENCHMARK_VARIANTS.includes(item as BenchmarkVariant));
      if (selected.length === 0 || selected.join(",") !== value) throw new Error(`--variant must contain: ${BENCHMARK_VARIANTS.join(",")}`);
      variants = selected;
    } else if (arg === "--out") {
      outputDirectory = args[++index];
      if (outputDirectory === undefined) throw new Error("--out requires a directory");
    } else if (arg === "--no-write") {
      write = false;
    } else if (arg === "--verify-determinism") {
      verify = true;
    } else {
      throw new Error(`Unknown argument: ${arg ?? ""}`);
    }
  }
  if (gate === undefined) throw new Error("Missing required --gate 30|100");
  return {
    gate, shardIndex, shardTotal, write, verify,
    ...(variants === undefined ? {} : { variants }),
    ...(outputDirectory === undefined ? {} : { outputDirectory }),
  };
}

await main();
