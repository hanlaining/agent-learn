import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { runProcessChaosGate40CaseHarness } from "./process-chaos-harness.js";
import {
  PROCESS_CHAOS_FENCED_COMMIT_WINDOW_ID,
  PROCESS_CHAOS_MODEL_RESPONSE_COMMIT_WINDOW_ID,
  PROCESS_CHAOS_PROOF_COMMIT_WINDOW_ID,
  PROCESS_CHAOS_RECEIPT_COMMIT_WINDOW_ID,
  PROCESS_CHAOS_RETURN_PERSISTED_WINDOW_ID,
  PROCESS_CHAOS_TOOL_EFFECT_RECEIPT_WINDOW_ID,
  PROCESS_CHAOS_WORKFLOW_STAGE_COMMIT_WINDOW_ID,
  PROCESS_CHAOS_WINDOW_ID,
  processChaosPilotWindowId,
  validateProcessChaosPilotReport,
  type ProcessChaosPilotReport,
  type ProcessChaosRunnableWindowId,
} from "./process-chaos-schema.js";

export const PROCESS_CHAOS_GATE40_MANIFEST_VERSION = "process-chaos-gate40-pilot-v1" as const;
export const PROCESS_CHAOS_GATE40_ID = "EXP-RT95-032" as const;
export const PROCESS_CHAOS_SUPPORTED_WINDOW_ID = PROCESS_CHAOS_WINDOW_ID;

/**
 * These IDs are a candidate decomposition of D11 RT95-603/604, not a frozen
 * preregistration. The repository's only preregistration is still Draft and
 * lists four windows rather than the eight required by EXP-RT95-032.
 */
export const PROCESS_CHAOS_GATE40_WINDOWS = [
  { id: PROCESS_CHAOS_MODEL_RESPONSE_COMMIT_WINDOW_ID, oracleId: "ORACLE-MODEL-WAL-V1", implementation: "runnable" },
  { id: PROCESS_CHAOS_TOOL_EFFECT_RECEIPT_WINDOW_ID, oracleId: "ORACLE-TOOL-OUTCOME-V1", implementation: "runnable" },
  { id: PROCESS_CHAOS_SUPPORTED_WINDOW_ID, oracleId: "ORACLE-RETURN-LEASE-V1", implementation: "runnable" },
  { id: PROCESS_CHAOS_RETURN_PERSISTED_WINDOW_ID, oracleId: "ORACLE-RETURN-CONSUME-V1", implementation: "runnable" },
  { id: PROCESS_CHAOS_FENCED_COMMIT_WINDOW_ID, oracleId: "ORACLE-FENCING-V1", implementation: "runnable" },
  { id: PROCESS_CHAOS_WORKFLOW_STAGE_COMMIT_WINDOW_ID, oracleId: "ORACLE-WORKFLOW-COMMIT-V1", implementation: "runnable" },
  { id: PROCESS_CHAOS_RECEIPT_COMMIT_WINDOW_ID, oracleId: "ORACLE-RECEIPT-V1", implementation: "runnable" },
  { id: PROCESS_CHAOS_PROOF_COMMIT_WINDOW_ID, oracleId: "ORACLE-PROOF-V1", implementation: "runnable" },
] as const;

export const PROCESS_CHAOS_GATE40_SEEDS = [
  "469816031",
  "3443330994",
  "4121183031",
  "3314624278",
  "3472974415",
] as const;

type Gate40Window = (typeof PROCESS_CHAOS_GATE40_WINDOWS)[number];
export type Gate40WindowId = Gate40Window["id"];
export type Gate40CaseStatus = "not-run" | "blocked" | "passed-local-pilot" | "failed-local-pilot";

export interface ProcessChaosGate40Case {
  caseId: string;
  windowId: Gate40WindowId;
  seed: string;
  oracleId: string;
  reproCommand: string;
  status: Gate40CaseStatus;
  oracleSatisfied: boolean | null;
  rawCasePath: string | null;
  rawReportPath: string | null;
  failureReportPath: string | null;
  blockedReason: string | null;
}

export interface ProcessChaosGate40Manifest {
  schemaVersion: typeof PROCESS_CHAOS_GATE40_MANIFEST_VERSION;
  gateId: typeof PROCESS_CHAOS_GATE40_ID;
  lifecycle: "candidate-not-frozen";
  preregistration: {
    path: "research/rt95-closure/preregistration.draft.example.json";
    observedStatus: "draft";
    frozenDigest: null;
    eightWindowListFrozen: false;
  };
  claimBoundary: "local-pilot-only-not-gate40";
  plannedCaseCount: 40;
  runnableCaseCount: 40;
  localPassedCaseCount: number;
  localFailedCaseCount: number;
  blockedCaseCount: 0;
  formallyVerifiedCaseCount: 0;
  completeGate40: false;
  independentReview: "NotReviewed";
  cases: ProcessChaosGate40Case[];
}

type CaseExecutor = (
  outputDirectory: string,
  seed: string,
  windowId: ProcessChaosRunnableWindowId,
) => Promise<ProcessChaosPilotReport>;

export function processChaosGate40CaseId(windowId: Gate40WindowId, seed: string): string {
  const windowIndex = PROCESS_CHAOS_GATE40_WINDOWS.findIndex((item) => item.id === windowId);
  const seedIndex = PROCESS_CHAOS_GATE40_SEEDS.findIndex((item) => item === seed);
  if (windowIndex < 0 || seedIndex < 0) throw new Error(`Unknown GATE-40 tuple: ${windowId}/${seed}`);
  return `G40-W${String(windowIndex + 1).padStart(2, "0")}-S${String(seedIndex + 1).padStart(2, "0")}`;
}

export function processChaosGate40ReproCommand(windowId: Gate40WindowId, seed: string): string {
  return [
    "npm exec -- tsx research/runtime-e2e-benchmarks/src/process-chaos-cli.ts",
    `--window ${windowId}`,
    `--seed ${seed}`,
    "--output <directory>",
  ].join(" ");
}

export function createProcessChaosGate40Manifest(): ProcessChaosGate40Manifest {
  const cases = PROCESS_CHAOS_GATE40_WINDOWS.flatMap((window) =>
    PROCESS_CHAOS_GATE40_SEEDS.map<ProcessChaosGate40Case>((seed) => {
      const runnable = window.implementation === "runnable";
      return {
        caseId: processChaosGate40CaseId(window.id, seed),
        windowId: window.id,
        seed,
        oracleId: window.oracleId,
        reproCommand: processChaosGate40ReproCommand(window.id, seed),
        status: runnable ? "not-run" : "blocked",
        oracleSatisfied: null,
        rawCasePath: null,
        rawReportPath: null,
        failureReportPath: null,
        blockedReason: runnable ? null : "No production App Server fault injector/oracle is wired for this candidate window.",
      };
    }),
  );
  const manifest: ProcessChaosGate40Manifest = {
    schemaVersion: PROCESS_CHAOS_GATE40_MANIFEST_VERSION,
    gateId: PROCESS_CHAOS_GATE40_ID,
    lifecycle: "candidate-not-frozen",
    preregistration: {
      path: "research/rt95-closure/preregistration.draft.example.json",
      observedStatus: "draft",
      frozenDigest: null,
      eightWindowListFrozen: false,
    },
    claimBoundary: "local-pilot-only-not-gate40",
    plannedCaseCount: 40,
    runnableCaseCount: runnableGate40CaseCount(),
    localPassedCaseCount: 0,
    localFailedCaseCount: 0,
    blockedCaseCount: blockedGate40CaseCount(),
    formallyVerifiedCaseCount: 0,
    completeGate40: false,
    independentReview: "NotReviewed",
    cases,
  };
  validateProcessChaosGate40Manifest(manifest);
  return manifest;
}

export async function runProcessChaosGate40Pilot(
  outputDirectory: string,
  executeCase: CaseExecutor = runProcessChaosGate40CaseHarness,
): Promise<ProcessChaosGate40Manifest> {
  const resolvedOutput = path.resolve(outputDirectory);
  await mkdir(resolvedOutput, { recursive: true });
  const manifest = createProcessChaosGate40Manifest();
  for (const item of manifest.cases.filter((candidate) => candidate.status === "not-run")) {
    const rawCasePath = `${item.windowId}/process-chaos-${item.seed}`;
    item.rawCasePath = rawCasePath;
    try {
      const report = await executeCase(resolvedOutput, item.seed, item.windowId as ProcessChaosRunnableWindowId);
      validateProcessChaosPilotReport(report);
      assert.equal(report.seed, item.seed);
      assert.equal(processChaosPilotWindowId(report), item.windowId);
      item.status = "passed-local-pilot";
      item.oracleSatisfied = true;
      item.rawReportPath = `${rawCasePath}/${report.schemaVersion === "process-chaos-report-v1"
        ? "process-chaos-report.json" : "process-chaos-boundary-report.json"}`;
    } catch (error) {
      item.status = "failed-local-pilot";
      item.oracleSatisfied = false;
      item.failureReportPath = `process-chaos-gate40-failures/${item.caseId}.json`;
      const failure = {
        schemaVersion: "process-chaos-gate40-failure-v1",
        caseId: item.caseId,
        windowId: item.windowId,
        seed: item.seed,
        oracleId: item.oracleId,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        reproCommand: item.reproCommand,
        rawCasePath,
      };
      await mkdir(path.join(resolvedOutput, "process-chaos-gate40-failures"), { recursive: true });
      await writeFile(path.join(resolvedOutput, item.failureReportPath), `${JSON.stringify(failure, null, 2)}\n`, "utf8");
    }
  }
  manifest.localPassedCaseCount = manifest.cases.filter((item) => item.status === "passed-local-pilot").length;
  manifest.localFailedCaseCount = manifest.cases.filter((item) => item.status === "failed-local-pilot").length;
  validateProcessChaosGate40Manifest(manifest);
  await writeFile(
    path.join(resolvedOutput, "process-chaos-gate40-pilot-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}

export function validateProcessChaosGate40Manifest(value: unknown): asserts value is ProcessChaosGate40Manifest {
  const errors: string[] = [];
  if (!isRecord(value)) throw new Error("Process Chaos GATE-40 manifest violation: root");
  if (!hasExactKeys(value, [
    "schemaVersion", "gateId", "lifecycle", "preregistration", "claimBoundary", "plannedCaseCount",
    "runnableCaseCount", "localPassedCaseCount", "localFailedCaseCount", "blockedCaseCount",
    "formallyVerifiedCaseCount", "completeGate40", "independentReview", "cases",
  ])) errors.push("root-fields");
  if (value.schemaVersion !== PROCESS_CHAOS_GATE40_MANIFEST_VERSION || value.gateId !== PROCESS_CHAOS_GATE40_ID) errors.push("identity");
  if (value.lifecycle !== "candidate-not-frozen" || value.claimBoundary !== "local-pilot-only-not-gate40" ||
    value.completeGate40 !== false || value.formallyVerifiedCaseCount !== 0 || value.independentReview !== "NotReviewed") errors.push("claim-boundary");
  if (!validPreregistration(value.preregistration)) errors.push("preregistration");
  if (!Array.isArray(value.cases) || value.cases.length !== 40) errors.push("case-count");
  else validateCases(value.cases, errors);
  const expectedRunnable = runnableGate40CaseCount();
  const expectedBlocked = blockedGate40CaseCount();
  if (value.plannedCaseCount !== 40 || value.runnableCaseCount !== expectedRunnable ||
    value.blockedCaseCount !== expectedBlocked ||
    !nonNegativeInteger(value.localPassedCaseCount) || !nonNegativeInteger(value.localFailedCaseCount)) errors.push("counts");
  if (Array.isArray(value.cases)) {
    const passed = value.cases.filter((item) => isRecord(item) && item.status === "passed-local-pilot").length;
    const failed = value.cases.filter((item) => isRecord(item) && item.status === "failed-local-pilot").length;
    const blocked = value.cases.filter((item) => isRecord(item) && item.status === "blocked").length;
    if (value.localPassedCaseCount !== passed || value.localFailedCaseCount !== failed ||
      blocked !== expectedBlocked || passed + failed > expectedRunnable) errors.push("derived-counts");
  }
  if (errors.length > 0) throw new Error(`Process Chaos GATE-40 manifest violation: ${errors.join(", ")}`);
}

function runnableGate40CaseCount(): 40 {
  return PROCESS_CHAOS_GATE40_WINDOWS.filter((item) => item.implementation === "runnable").length *
    PROCESS_CHAOS_GATE40_SEEDS.length as 40;
}

function blockedGate40CaseCount(): 0 {
  return PROCESS_CHAOS_GATE40_WINDOWS.filter((item) => String(item.implementation) === "blocked").length *
    PROCESS_CHAOS_GATE40_SEEDS.length as 0;
}

function validateCases(value: unknown[], errors: string[]): void {
  const expected = PROCESS_CHAOS_GATE40_WINDOWS.flatMap((window) =>
    PROCESS_CHAOS_GATE40_SEEDS.map((seed) => ({ window, seed })));
  const identities = new Set<string>();
  value.forEach((candidate, index) => {
    const expectedCase = expected[index];
    if (!isRecord(candidate) || expectedCase === undefined || !hasExactKeys(candidate, [
      "caseId", "windowId", "seed", "oracleId", "reproCommand", "status", "oracleSatisfied",
      "rawCasePath", "rawReportPath", "failureReportPath", "blockedReason",
    ])) {
      errors.push(`case-${index}`);
      return;
    }
    const { window, seed } = expectedCase;
    const identity = `${candidate.windowId}/${candidate.seed}`;
    if (identities.has(identity)) errors.push(`case-${index}-duplicate`);
    identities.add(identity);
    if (candidate.windowId !== window.id || candidate.seed !== seed || candidate.oracleId !== window.oracleId ||
      candidate.caseId !== processChaosGate40CaseId(window.id, seed) ||
      candidate.reproCommand !== processChaosGate40ReproCommand(window.id, seed)) errors.push(`case-${index}-identity`);
    const status = candidate.status;
    if (String(window.implementation) === "blocked") {
      if (status !== "blocked" || candidate.oracleSatisfied !== null || candidate.rawCasePath !== null ||
        candidate.rawReportPath !== null || candidate.failureReportPath !== null || !nonEmptyString(candidate.blockedReason)) errors.push(`case-${index}-blocked`);
      return;
    }
    if (candidate.blockedReason !== null || !["not-run", "passed-local-pilot", "failed-local-pilot"].includes(String(status))) {
      errors.push(`case-${index}-runnable`);
      return;
    }
    if (status === "not-run" && [candidate.oracleSatisfied, candidate.rawCasePath, candidate.rawReportPath, candidate.failureReportPath].some((item) => item !== null)) errors.push(`case-${index}-not-run`);
    if (status === "passed-local-pilot" && (candidate.oracleSatisfied !== true || !safePath(candidate.rawCasePath) ||
      !safePath(candidate.rawReportPath) || candidate.failureReportPath !== null)) errors.push(`case-${index}-passed`);
    if (status === "failed-local-pilot" && (candidate.oracleSatisfied !== false || !safePath(candidate.rawCasePath) ||
      candidate.rawReportPath !== null || !safePath(candidate.failureReportPath))) errors.push(`case-${index}-failed`);
  });
  if (identities.size !== 40) errors.push("case-coverage");
}

function validPreregistration(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ["path", "observedStatus", "frozenDigest", "eightWindowListFrozen"]) &&
    value.path === "research/rt95-closure/preregistration.draft.example.json" && value.observedStatus === "draft" &&
    value.frozenDigest === null && value.eightWindowListFrozen === false;
}

function safePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.startsWith("/") && !value.includes("\\") &&
    !/^[a-zA-Z]:/u.test(value) && value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseCli(arguments_: string[]): { output: string } {
  if (arguments_.length !== 2 || arguments_[0] !== "--output" || !nonEmptyString(arguments_[1])) {
    throw new Error("Usage: process-chaos-gate40.ts --output <directory>");
  }
  return { output: arguments_[1] };
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  try {
    const options = parseCli(process.argv.slice(2));
    const manifest = await runProcessChaosGate40Pilot(options.output);
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`[process-chaos-gate40-pilot] FAIL ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
