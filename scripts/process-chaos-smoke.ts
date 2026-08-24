import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  runProcessChaosHarness,
  withProcessChaosTimeout,
  type ProcessChaosReport,
} from "../research/runtime-e2e-benchmarks/src/process-chaos-harness.js";

const DEFAULT_SEED = "process-chaos-smoke";
const DEFAULT_TIMEOUT_MS = 120_000;

export interface ProcessChaosSmokeOptions {
  seed: string;
  outputDirectory: string;
  timeoutMs: number;
  dryRun: boolean;
}

export interface ProcessChaosSmokeResult {
  schemaVersion: 1;
  benchmark: "process-chaos-smoke";
  status: "passed" | "failed" | "dry-run";
  seed: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  outputDirectory: string;
  reportPath?: string;
  reportSha256?: string;
  provider: {
    kind: "deterministic-fake-responses";
    liveCalls: false;
    credentialsRead: false;
  };
  assertions: {
    twoOwnerPidsObserved: boolean;
    heldLeaseObservedBeforeKill: boolean;
    leaseWaitObservedAfterRestart: boolean;
    finalJobCompleted: boolean;
    finalReturnConsumed: boolean;
    noDuplicateFinalProviderRequest: boolean;
    allFaultWindowsRecovered: boolean;
  };
  windows: ProcessChaosReport["windows"];
  evidence?: ProcessChaosReport["evidence"];
  error?: string;
}

export function parseProcessChaosSmokeArgs(args: readonly string[], cwd = process.cwd()): ProcessChaosSmokeOptions {
  let seed = DEFAULT_SEED;
  let outputDirectory = path.resolve(cwd, "research/runtime-e2e-benchmarks/results", `process-chaos-${seed}`);
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let dryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--seed") {
      seed = requireValue(args, ++index, "--seed");
      if (!/^[a-zA-Z0-9._-]+$/u.test(seed)) throw new Error("--seed must contain only letters, numbers, dot, underscore, or hyphen");
      if (outputDirectory.endsWith(`process-chaos-${DEFAULT_SEED}`)) {
        outputDirectory = path.resolve(cwd, "research/runtime-e2e-benchmarks/results", `process-chaos-${seed}`);
      }
    } else if (arg === "--out") {
      outputDirectory = path.resolve(cwd, requireValue(args, ++index, "--out"));
    } else if (arg === "--timeout-ms") {
      timeoutMs = Number(requireValue(args, ++index, "--timeout-ms"));
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) throw new Error("--timeout-ms must be an integer >= 1000");
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error("HELP");
    } else {
      throw new Error(`Unknown process-chaos-smoke argument: ${arg ?? ""}`);
    }
  }

  return { seed, outputDirectory, timeoutMs, dryRun };
}

export function buildDryRunResult(options: ProcessChaosSmokeOptions, now = new Date()): ProcessChaosSmokeResult {
  const timestamp = now.toISOString();
  return {
    schemaVersion: 1,
    benchmark: "process-chaos-smoke",
    status: "dry-run",
    seed: options.seed,
    startedAt: timestamp,
    finishedAt: timestamp,
    durationMs: 0,
    outputDirectory: options.outputDirectory,
    provider: { kind: "deterministic-fake-responses", liveCalls: false, credentialsRead: false },
    assertions: emptyAssertions(),
    windows: [],
  };
}

export async function runProcessChaosSmoke(options: ProcessChaosSmokeOptions): Promise<ProcessChaosSmokeResult> {
  const startedAt = new Date();
  await mkdir(options.outputDirectory, { recursive: true });
  if (options.dryRun) {
    const result = buildDryRunResult(options, startedAt);
    await writeResult(options.outputDirectory, result);
    return result;
  }

  try {
    const report = await withProcessChaosTimeout(
      runProcessChaosHarness(options.outputDirectory, options.seed),
      options.timeoutMs,
      `process-chaos smoke (${options.timeoutMs}ms timeout)`,
    );
    const assertions = evaluateAssertions(report);
    if (Object.values(assertions).some((value) => !value)) {
      throw new Error(`Process Chaos invariant failed: ${JSON.stringify(assertions)}`);
    }
    const reportBytes = await readFile(report.rawReportPath);
    const result: ProcessChaosSmokeResult = {
      schemaVersion: 1,
      benchmark: "process-chaos-smoke",
      status: "passed",
      seed: options.seed,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      outputDirectory: options.outputDirectory,
      reportPath: report.rawReportPath,
      reportSha256: createHash("sha256").update(reportBytes).digest("hex"),
      provider: { kind: "deterministic-fake-responses", liveCalls: false, credentialsRead: false },
      assertions,
      windows: report.windows,
      evidence: report.evidence,
    };
    await writeResult(options.outputDirectory, result);
    return result;
  } catch (error) {
    const result: ProcessChaosSmokeResult = {
      schemaVersion: 1,
      benchmark: "process-chaos-smoke",
      status: "failed",
      seed: options.seed,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      outputDirectory: options.outputDirectory,
      provider: { kind: "deterministic-fake-responses", liveCalls: false, credentialsRead: false },
      assertions: emptyAssertions(),
      windows: [],
      error: error instanceof Error ? error.message : String(error),
    };
    await writeResult(options.outputDirectory, result);
    throw error;
  }
}

function evaluateAssertions(report: ProcessChaosReport): ProcessChaosSmokeResult["assertions"] {
  const second = report.windows[1];
  return {
    twoOwnerPidsObserved: report.pidChangedAfterReload && report.pidChangedAfterOwnerKill,
    heldLeaseObservedBeforeKill: second?.faultPointConfirmed === true,
    leaseWaitObservedAfterRestart: second?.leaseWaitObserved === true,
    finalJobCompleted: report.evidence.finalJobStatus === "completed",
    finalReturnConsumed: report.evidence.finalReturnStatus === "consumed",
    noDuplicateFinalProviderRequest: report.evidence.providerRequestsByStage.return_god === 1,
    allFaultWindowsRecovered: report.windows.length === 2 && report.windows.every((window) => window.recovered && window.ownerKilled && window.publicRpcReloaded && window.rawJsonReloaded),
  };
}

function emptyAssertions(): ProcessChaosSmokeResult["assertions"] {
  return {
    twoOwnerPidsObserved: false,
    heldLeaseObservedBeforeKill: false,
    leaseWaitObservedAfterRestart: false,
    finalJobCompleted: false,
    finalReturnConsumed: false,
    noDuplicateFinalProviderRequest: false,
    allFaultWindowsRecovered: false,
  };
}

async function writeResult(outputDirectory: string, result: ProcessChaosSmokeResult): Promise<void> {
  await writeFile(path.join(outputDirectory, "smoke-result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

function requireValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function usage(): string {
  return [
    "Usage: npm run process-chaos:smoke -- [options]",
    "  --dry-run             validate arguments and print the audit contract without spawning a Provider/App Server",
    `  --seed <safe-id>      deterministic case id (default: ${DEFAULT_SEED})`,
    "  --out <directory>     output directory for report JSON and smoke-result.json",
    `  --timeout-ms <ms>     bounded wall-clock timeout (default: ${DEFAULT_TIMEOUT_MS})`,
  ].join("\n");
}

async function main(): Promise<void> {
  try {
    const options = parseProcessChaosSmokeArgs(process.argv.slice(2));
    const result = await runProcessChaosSmoke(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    if (error instanceof Error && error.message === "HELP") {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
