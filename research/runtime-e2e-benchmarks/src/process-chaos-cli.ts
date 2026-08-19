import path from "node:path";

import { runProcessChaosHarness } from "./process-chaos-harness.js";

const options = parseArguments(process.argv.slice(2));
const report = await runProcessChaosHarness(path.resolve(options.output), options.seed);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

function parseArguments(arguments_: string[]): { seed: string; output: string } {
  let seed: string | undefined;
  let output: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    if (arguments_[index] === "--seed") seed = arguments_[++index];
    else if (arguments_[index] === "--output") output = arguments_[++index];
    else throw new Error(`Unknown process-chaos option: ${arguments_[index]}`);
  }
  if (seed === undefined || output === undefined) {
    throw new Error("Usage: process-chaos-cli.ts --seed <seed> --output <directory>");
  }
  return { seed, output };
}
