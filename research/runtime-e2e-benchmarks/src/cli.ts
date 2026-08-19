import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildRuntimeE2eReport,
  RUNTIME_E2E_VARIANTS,
  verifyRuntimeE2eDeterminism,
  writeRuntimeE2eReport,
  type RuntimeE2eRunOptions,
} from "./runner.js";
import type { RuntimeE2eVariant } from "./types.js";

interface CliOptions extends RuntimeE2eRunOptions {
  outputDirectory?: string;
  write: boolean;
  verify: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const runOptions: RuntimeE2eRunOptions = {
    gate: options.gate,
    shardIndex: options.shardIndex ?? 1,
    shardTotal: options.shardTotal ?? 1,
    ...(options.variants === undefined ? {} : { variants: options.variants }),
    ...(options.caseId === undefined ? {} : { caseId: options.caseId }),
  };
  if (options.verify) await verifyRuntimeE2eDeterminism(runOptions);
  const report = await buildRuntimeE2eReport(runOptions);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const suffix = report.shard.total === 1 ? "" : `-shard-${report.shard.index}-of-${report.shard.total}`;
  const outputDirectory = options.outputDirectory ?? path.join(root, "results", `gate-${options.gate}-seed-${report.fixtureSeed}${suffix}`);
  if (options.write) await writeRuntimeE2eReport(report, outputDirectory);
  process.stdout.write(`${JSON.stringify({
    benchmark: report.benchmark,
    fixtureSeed: report.fixtureSeed,
    shard: report.shard,
    deterministicOutcomesVerified: options.verify,
    provider: report.methodology.provider,
    persistence: report.implementation.persistence,
    outputDirectory: options.write ? outputDirectory : null,
    summaries: report.summaries,
  }, null, 2)}\n`);
}

function parseArgs(args: string[]): CliOptions {
  let gate: 30 | 100 | undefined;
  let shardIndex = 1;
  let shardTotal = 1;
  let variants: RuntimeE2eVariant[] | undefined;
  let caseId: string | undefined;
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
      const match = /^(\d+)\/(\d+)$/u.exec(args[++index] ?? "");
      if (match === null) throw new Error("--shard must be INDEX/TOTAL");
      shardIndex = Number(match[1]);
      shardTotal = Number(match[2]);
    } else if (arg === "--variant") {
      const value = args[++index] ?? "";
      const selected = value.split(",").filter((item): item is RuntimeE2eVariant => RUNTIME_E2E_VARIANTS.includes(item as RuntimeE2eVariant));
      if (selected.length === 0 || selected.join(",") !== value) throw new Error(`--variant must contain: ${RUNTIME_E2E_VARIANTS.join(",")}`);
      variants = selected;
    } else if (arg === "--case") {
      caseId = args[++index];
      if (caseId === undefined || caseId.length === 0) throw new Error("--case requires a case id");
    } else if (arg === "--out") {
      outputDirectory = args[++index];
      if (outputDirectory === undefined) throw new Error("--out requires a directory");
    } else if (arg === "--no-write") write = false;
    else if (arg === "--verify-determinism") verify = true;
    else throw new Error(`Unknown Runtime-E2E argument: ${arg ?? ""}`);
  }
  if (gate === undefined) throw new Error("Missing --gate 30|100");
  return { gate, shardIndex, shardTotal, write, verify,
    ...(variants === undefined ? {} : { variants }),
    ...(caseId === undefined ? {} : { caseId }),
    ...(outputDirectory === undefined ? {} : { outputDirectory }) };
}

await main();
