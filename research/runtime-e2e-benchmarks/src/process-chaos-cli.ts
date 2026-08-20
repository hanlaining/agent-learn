import path from "node:path";
import { pathToFileURL } from "node:url";

import { runProcessChaosHarness } from "./process-chaos-harness.js";
import {
  PROCESS_CHAOS_REPRO_COMMAND,
  validateProcessChaosReport,
} from "./process-chaos-schema.js";

interface ProcessChaosCliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

export async function runProcessChaosCli(
  arguments_: string[],
  io: ProcessChaosCliIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  let options: { seed: string; output: string } | undefined;
  try {
    options = parseArguments(arguments_);
    const report = await runProcessChaosHarness(path.resolve(options.output), options.seed);
    validateProcessChaosReport(report);
    io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    io.stderr.write([
      "[process-chaos] FAIL",
      `error: ${errorMessage(error)}`,
      "scope: Team Workflow Return narrow E3 (1/40); not complete E3, GATE-40, exactly-once, or production readiness",
      `reproduce: ${options === undefined ? PROCESS_CHAOS_REPRO_COMMAND : exactPowerShellReproCommand(options)}`,
      `template: ${PROCESS_CHAOS_REPRO_COMMAND}`,
      "",
    ].join("\n"));
    return 1;
  }
}

export function parseArguments(arguments_: string[]): { seed: string; output: string } {
  let seed: string | undefined;
  let output: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    if (arguments_[index] === "--seed") seed = arguments_[++index];
    else if (arguments_[index] === "--output") output = arguments_[++index];
    else throw new Error(`Unknown process-chaos option: ${arguments_[index]}`);
  }
  if (seed === undefined || output === undefined || seed.length === 0 || output.length === 0) {
    throw new Error("Usage: process-chaos-cli.ts --seed <seed> --output <directory>");
  }
  return { seed, output };
}

function exactPowerShellReproCommand(options: { seed: string; output: string }): string {
  return [
    "npm exec -- tsx research/runtime-e2e-benchmarks/src/process-chaos-cli.ts",
    `--seed ${quotePowerShell(options.seed)}`,
    `--output ${quotePowerShell(path.resolve(options.output))}`,
  ].join(" ");
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  process.exitCode = await runProcessChaosCli(process.argv.slice(2));
}
