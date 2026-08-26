import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  analyzeRawResults,
  serializeStatisticsReport,
} from "../research/rt95-closure/src/statistics.js";

export interface AnalyzeCliOptions {
  inputPath: string;
  outputPath?: string;
}

export function parseAnalyzeCliArgs(args: readonly string[]): AnalyzeCliOptions {
  let inputPath: string | undefined;
  let outputPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--input") {
      inputPath = args[++index];
      if (inputPath === undefined) throw new Error("--input requires a Raw JSON file");
    } else if (argument === "--output") {
      outputPath = args[++index];
      if (outputPath === undefined) throw new Error("--output requires a JSON file");
    } else {
      throw new Error(`unknown argument: ${argument ?? ""}; only --input and --output are allowed`);
    }
  }
  if (inputPath === undefined) throw new Error("missing --input <raw-results.json>");
  return {
    inputPath: path.resolve(inputPath),
    ...(outputPath === undefined ? {} : { outputPath: path.resolve(outputPath) }),
  };
}

export async function analyzeRawResultsFile(options: AnalyzeCliOptions): Promise<string> {
  const parsed: unknown = JSON.parse(await readFile(options.inputPath, "utf8"));
  const serialized = serializeStatisticsReport(analyzeRawResults(parsed));
  if (options.outputPath !== undefined) await writeFile(options.outputPath, serialized, "utf8");
  return serialized;
}

async function runCli(): Promise<void> {
  const options = parseAnalyzeCliArgs(process.argv.slice(2));
  const serialized = await analyzeRawResultsFile(options);
  process.stdout.write(serialized);
}

const invokedAsScript = process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  await runCli().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}

