import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildTaskManifest,
  createRunRecord,
  defaultOutputDirectory,
  loadOfflineConfig,
  parseOfflineArgs,
  runOptionsFor,
  validateRunRecord,
  validateTaskManifest,
} from "../research/benchmarks/src/offline.js";
import { buildReport, verifyDeterministic, writeReport } from "../research/benchmarks/src/runner.js";

const options = parseOfflineArgs(process.argv.slice(2));
const config = await loadOfflineConfig(options.configPath);
const manifest = await buildTaskManifest(options.suite, config, options.seed);
validateTaskManifest(manifest);
const outputDirectory = options.outputDirectory ?? defaultOutputDirectory(manifest);

if (options.dryRun) {
  process.stdout.write(`${JSON.stringify({
    dryRun: true,
    suite: manifest.suite,
    seed: manifest.seed,
    config: config.name,
    taskCount: manifest.taskCount,
    executionCount: manifest.executionCount,
    outputDirectory,
    manifestValid: true,
  }, null, 2)}\n`);
} else {
  const runOptions = runOptionsFor(manifest);
  const startedAt = new Date();
  if (config.verifyDeterminism) await verifyDeterministic(runOptions);
  const report = await buildReport(runOptions);
  await writeReport(report, outputDirectory);
  const finishedAt = new Date();
  const record = createRunRecord({ suite: options.suite, config, manifest, report, startedAt, finishedAt });
  validateRunRecord(record, manifest, report);
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDirectory, "task-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    writeFile(path.join(outputDirectory, "run-record.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8"),
  ]);
  process.stdout.write(`${JSON.stringify({
    dryRun: false,
    runId: record.runId,
    suite: record.suite,
    seed: record.seed,
    config: record.configName,
    deterministicVerified: record.deterministicVerified,
    taskCount: record.taskCount,
    executionCount: record.executionCount,
    outputDirectory,
    artifacts: record.artifacts,
  }, null, 2)}\n`);
}
