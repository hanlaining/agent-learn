import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runScenario } from "./engine.js";
import { generateScenarios, loadFixture } from "./fixtures.js";
import { validateBenchmarkReport } from "./schema.js";
import { summarize } from "./stats.js";
import type { BenchmarkReport, BenchmarkVariant } from "./types.js";

export interface RunOptions {
  gate: 30 | 100;
  shardIndex?: number;
  shardTotal?: number;
  variants?: BenchmarkVariant[];
}

export async function buildReport(options: RunOptions): Promise<BenchmarkReport> {
  const fixture = await loadFixture(options.gate);
  const shard = normalizeShard(options.shardIndex ?? 1, options.shardTotal ?? 1);
  const variants = options.variants ?? fixture.variants;
  const scenarios = generateScenarios(fixture)
    .filter((scenario) => scenario.caseIndex % shard.total === shard.index - 1);
  const cases = variants.flatMap((variant) =>
    scenarios.map((scenario) => runScenario(scenario, variant, fixture.pricing)));
  const report: BenchmarkReport = {
    schemaVersion: "gate-benchmark-result-v1",
    benchmark: fixture.name,
    fixtureSeed: fixture.seed,
    generatorVersion: fixture.generatorVersion,
    deterministic: true,
    shard,
    variants,
    pricing: fixture.pricing,
    methodology: {
      provider: "deterministic-mock",
      latency: "logical simulated milliseconds; not wall-clock production latency",
      cost: "token count multiplied by fixture-pinned comparison rates; not a provider bill",
    },
    summaries: variants.map((variant) => summarize(variant, cases.filter((item) => item.variant === variant))),
    cases,
  };
  validateBenchmarkReport(report);
  return report;
}

export function serializeReport(report: BenchmarkReport): string {
  validateBenchmarkReport(report);
  return `${JSON.stringify(report, null, 2)}\n`;
}

export async function verifyDeterministic(options: RunOptions): Promise<void> {
  const first = serializeReport(await buildReport(options));
  const second = serializeReport(await buildReport(options));
  if (first !== second) throw new Error("Determinism verification failed: repeated reports differ");
}

export async function writeReport(report: BenchmarkReport, outputDirectory: string): Promise<void> {
  validateBenchmarkReport(report);
  await mkdir(outputDirectory, { recursive: true });
  const reproDirectory = path.join(outputDirectory, "repro");
  await mkdir(reproDirectory, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDirectory, "report.json"), serializeReport(report), "utf8"),
    writeFile(path.join(outputDirectory, "summary.csv"), summaryCsv(report), "utf8"),
    writeFile(path.join(outputDirectory, "cases.csv"), casesCsv(report), "utf8"),
  ]);
  const failures = report.cases.filter((item) => !item.taskSuccess);
  await Promise.all(failures.map((item) => writeFile(
    path.join(reproDirectory, `${item.variant}-${item.caseId}.json`),
    `${JSON.stringify({
      schemaVersion: "gate-repro-v1",
      benchmark: report.benchmark,
      fixtureSeed: report.fixtureSeed,
      shard: report.shard,
      variant: item.variant,
      caseId: item.caseId,
      caseIndex: item.caseIndex,
      result: item,
      rerun: `npm run benchmark:gate${report.benchmark === "GATE-30" ? "30" : "100"} -- --variant ${item.variant}`,
    }, null, 2)}\n`,
    "utf8",
  )));
}

function normalizeShard(index: number, total: number): { index: number; total: number } {
  if (!Number.isInteger(index) || !Number.isInteger(total) || total < 1 || index < 1 || index > total) {
    throw new Error(`Invalid shard ${index}/${total}; expected 1 <= index <= total`);
  }
  return { index, total };
}

function summaryCsv(report: BenchmarkReport): string {
  const header = [
    "benchmark", "seed", "shard", "variant", "cases", "taskSuccess", "recoverySuccess",
    "duplicateModelCalls", "duplicateToolEffects", "unknownOutcomeRate", "evidenceCompleteness",
    "p50LatencyMs", "p95LatencyMs", "inputTokens", "outputTokens", "totalTokens", "costEstimateUsd",
  ];
  const rows = report.summaries.map((item) => [
    report.benchmark, report.fixtureSeed, `${report.shard.index}/${report.shard.total}`, item.variant, item.cases,
    item.taskSuccess.rate, item.recoverySuccess.rate, item.duplicateModelCalls, item.duplicateToolEffects,
    item.unknownOutcomeRate.rate, item.evidenceCompleteness, item.latencyMs.p50, item.latencyMs.p95,
    item.tokens.input, item.tokens.output, item.tokens.total, item.costEstimateUsd,
  ]);
  return toCsv(header, rows);
}

function casesCsv(report: BenchmarkReport): string {
  const header = [
    "benchmark", "seed", "shard", "caseId", "caseIndex", "category", "variant", "taskSuccess",
    "recoveryAttempted", "recoverySuccess", "modelCalls", "duplicateModelCalls", "toolEffects",
    "duplicateToolEffects", "unknownOutcome", "evidenceRequired", "evidenceProduced",
    "evidenceCompleteness", "latencyMs", "inputTokens", "outputTokens", "costEstimateUsd", "failureCodes",
  ];
  const rows = report.cases.map((item) => [
    report.benchmark, report.fixtureSeed, `${report.shard.index}/${report.shard.total}`, item.caseId, item.caseIndex,
    item.category, item.variant, item.taskSuccess, item.recoveryAttempted, item.recoverySuccess ?? "",
    item.modelCalls, item.duplicateModelCalls, item.toolEffects, item.duplicateToolEffects, item.unknownOutcome,
    item.evidenceRequired, item.evidenceProduced, item.evidenceCompleteness, item.latencyMs, item.inputTokens,
    item.outputTokens, item.costEstimateUsd, item.failureCodes.join("|"),
  ]);
  return toCsv(header, rows);
}

function toCsv(header: string[], rows: Array<Array<string | number | boolean>>): string {
  return `${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function csvCell(value: string | number | boolean): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
