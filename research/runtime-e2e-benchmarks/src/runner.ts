import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { generateRuntimeE2eScenarios, loadRuntimeE2eFixture } from "./fixtures.js";
import { executeRuntimeE2eScenario } from "./harness.js";
import { validateRuntimeE2eReport } from "./schema.js";
import { summarizeRuntimeE2e } from "./stats.js";
import {
  RUNTIME_E2E_VARIANTS,
  type RuntimeE2eCaseResult,
  type RuntimeE2eReport,
  type RuntimeE2eVariant,
} from "./types.js";

export interface RuntimeE2eRunOptions {
  gate: 30 | 100;
  shardIndex?: number;
  shardTotal?: number;
  variants?: RuntimeE2eVariant[];
  caseId?: string;
}

export async function buildRuntimeE2eReport(options: RuntimeE2eRunOptions): Promise<RuntimeE2eReport> {
  const fixture = await loadRuntimeE2eFixture(options.gate);
  const shard = normalizeShard(options.shardIndex ?? 1, options.shardTotal ?? 1);
  const variants = options.variants ?? fixture.variants;
  const scenarios = generateRuntimeE2eScenarios(fixture)
    .filter((scenario) => scenario.caseIndex % shard.total === shard.index - 1)
    .filter((scenario) => options.caseId === undefined || scenario.caseId === options.caseId);
  if (options.caseId !== undefined && scenarios.length === 0) throw new Error(`Runtime-E2E case not found in shard: ${options.caseId}`);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "god-agent-runtime-e2e-"));
  const cases: RuntimeE2eCaseResult[] = [];
  try {
    for (const variant of variants) {
      for (const scenario of scenarios) {
        cases.push(await executeRuntimeE2eScenario(
          scenario,
          variant,
          path.join(temporaryRoot, `${variant}-${scenario.caseId}`),
        ));
      }
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  const report: RuntimeE2eReport = {
    schemaVersion: "runtime-e2e-report-v1",
    benchmark: fixture.name,
    fixtureSeed: fixture.seed,
    generatorVersion: fixture.generatorVersion,
    shard,
    variants,
    runStartedAt: new Date().toISOString(),
    implementation: {
      check: "production-runtime",
      persistence: "JsonFileRuntimePersistence",
      runtimeClasses: [
        "AgentLoop", "AgentRunStore", "AgentRuntimeStore", "JsonFileRuntimePersistence",
        "ModelInvocationStartupRecovery", "ModelInvocationStore", "PersistentRuntimeLeaseStore",
        "ToolInvocationStore", "WorkflowTeamCoordinator",
      ],
      protocolSimulatorUsed: false,
    },
    methodology: {
      provider: { kind: "deterministic-fake", realApiCalls: false, credentialsRead: false },
      tool: { kind: "deterministic-fake", effects: "local-temporary-journal" },
      latency: "measured local wall-clock; not production capacity",
      claims: "implementation correctness only; not real-provider or production-capacity evidence",
    },
    environment: { platform: process.platform, arch: process.arch, node: process.version, local: true },
    summaries: variants.map((variant) => summarizeRuntimeE2e(variant, cases.filter((item) => item.variant === variant))),
    cases,
  };
  validateRuntimeE2eReport(report);
  return report;
}

export async function verifyRuntimeE2eDeterminism(options: RuntimeE2eRunOptions): Promise<void> {
  const first = deterministicProjection(await buildRuntimeE2eReport(options));
  const second = deterministicProjection(await buildRuntimeE2eReport(options));
  if (first !== second) throw new Error("Runtime-E2E determinism verification failed");
}

export function serializeRuntimeE2eReport(report: RuntimeE2eReport): string {
  validateRuntimeE2eReport(report);
  return `${JSON.stringify(report, null, 2)}\n`;
}

export async function writeRuntimeE2eReport(report: RuntimeE2eReport, outputDirectory: string): Promise<void> {
  validateRuntimeE2eReport(report);
  await mkdir(path.join(outputDirectory, "repro"), { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDirectory, "report.json"), serializeRuntimeE2eReport(report), "utf8"),
    writeFile(path.join(outputDirectory, "summary.csv"), summaryCsv(report), "utf8"),
    writeFile(path.join(outputDirectory, "cases.csv"), casesCsv(report), "utf8"),
  ]);
  await Promise.all(report.cases.filter((item) => !item.taskSuccess).map((item) => writeFile(
    path.join(outputDirectory, "repro", `${item.variant}-${item.caseId}.json`),
    `${JSON.stringify({
      schemaVersion: "runtime-e2e-repro-v1",
      benchmark: report.benchmark,
      fixtureSeed: report.fixtureSeed,
      variant: item.variant,
      caseId: item.caseId,
      checkpoint: item.checkpoint,
      observed: item,
      rerun: `npm run benchmark:runtime-e2e:gate${report.benchmark.endsWith("30") ? "30" : "100"} -- --variant ${item.variant} --case ${item.caseId}`,
    }, null, 2)}\n`,
    "utf8",
  )));
}

export function deterministicProjection(report: RuntimeE2eReport): string {
  return JSON.stringify({
    benchmark: report.benchmark,
    seed: report.fixtureSeed,
    shard: report.shard,
    variants: report.variants,
    summaries: report.summaries.map(({ wallClockMs: _wallClockMs, ...summary }) => summary),
    cases: report.cases.map(({ wallClockDurationMs: _wallClockDurationMs, ...item }) => item),
  });
}

function normalizeShard(index: number, total: number): { index: number; total: number } {
  if (!Number.isInteger(index) || !Number.isInteger(total) || total < 1 || index < 1 || index > total) {
    throw new Error(`Invalid Runtime-E2E shard ${index}/${total}`);
  }
  return { index, total };
}

function summaryCsv(report: RuntimeE2eReport): string {
  const header = ["benchmark", "seed", "shard", "variant", "cases", "taskSuccess", "recoverySuccess", "duplicateModelCalls", "duplicateToolEffects", "unknownOutcome", "evidenceCompleteness", "wallClockTotalMs", "p50Ms", "p95Ms"];
  const rows = report.summaries.map((item) => [report.benchmark, report.fixtureSeed, `${report.shard.index}/${report.shard.total}`, item.variant, item.cases, item.taskSuccess.rate, item.recoverySuccess.rate, item.duplicateModelCalls, item.duplicateToolEffects, item.unknownOutcome.rate, item.evidenceCompleteness, item.wallClockMs.total, item.wallClockMs.p50, item.wallClockMs.p95]);
  return toCsv(header, rows);
}

function casesCsv(report: RuntimeE2eReport): string {
  const header = ["benchmark", "seed", "shard", "caseId", "caseIndex", "family", "checkpoint", "variant", "taskSuccess", "recoveryAttempted", "recoverySuccess", "snapshotReloaded", "stateFileWrites", "stateFileLoads", "modelCalls", "duplicateModelCalls", "toolEffects", "duplicateToolEffects", "unknownOutcome", "evidenceCompleteness", "recoveryResult", "wallClockDurationMs", "failureCodes"];
  const rows = report.cases.map((item) => [report.benchmark, report.fixtureSeed, `${report.shard.index}/${report.shard.total}`, item.caseId, item.caseIndex, item.family, item.checkpoint, item.variant, item.taskSuccess, item.recoveryAttempted, item.recoverySuccess ?? "", item.snapshotReloaded, item.stateFileWrites, item.stateFileLoads, item.modelCalls, item.duplicateModelCalls, item.toolEffects, item.duplicateToolEffects, item.unknownOutcome, item.evidenceCompleteness, item.recoveryResult, item.wallClockDurationMs, item.failureCodes.join("|")]);
  return toCsv(header, rows);
}

function toCsv(header: string[], rows: Array<Array<string | number | boolean>>): string {
  return `${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function csvCell(value: string | number | boolean): string {
  const text = String(value);
  return /[",\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export { RUNTIME_E2E_VARIANTS };
