import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  analyzeRawResults,
  serializeStatisticsReport,
  validateRawResults,
  type RawResultRecord,
  type Rt95RawResults,
} from "../research/rt95-closure/src/statistics.js";
import {
  computePreregistrationDigest,
  validateRt95Preregistration,
} from "./validate-rt95-preregistration.js";
import { createPaperTableArtifacts } from "./render-rt95-paper-tables.js";

export const RT95_PAPER_EVIDENCE_MANIFEST_VERSION = "rt95-paper-evidence-bundle-v1" as const;
export const RT95_PAPER_EVIDENCE_CLAIM_BOUNDARY =
  "local-analysis-bundle-not-formal-not-external" as const;

const MANIFEST_NAME = "artifact-manifest.json";
const ARTIFACT_NAMES = [
  "preregistration.frozen.json",
  "raw-results.json",
  "statistics-report.json",
  "results.md",
  "arms.csv",
  "comparisons.csv",
  "raw-index.csv",
  "failure-records.csv",
] as const;
const BUNDLE_FILE_NAMES = [...ARTIFACT_NAMES, MANIFEST_NAME].sort(compare);
const MACHINE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

type ArtifactName = typeof ARTIFACT_NAMES[number];

export interface Rt95PaperEvidenceManifest {
  schemaVersion: typeof RT95_PAPER_EVIDENCE_MANIFEST_VERSION;
  claimBoundary: typeof RT95_PAPER_EVIDENCE_CLAIM_BOUNDARY;
  experimentId: string;
  preregistration: {
    lifecycle: "frozen";
    payloadSha256: string;
    sourceSha256: string;
  };
  raw: {
    sourceSha256: string;
    recordCount: number;
    successCount: number;
    failureCount: number;
    armIds: string[];
    pairsPerArm: number;
    exactFrozenPlanCoverage: true;
    allOutcomesIndexed: true;
    failureRecordsRetained: true;
  };
  analysis: {
    significanceClaimed: false;
    fairnessReviewStatus: "NotReviewed";
    externalBaselineArmCount: number;
  };
  artifacts: Array<{
    path: ArtifactName;
    bytes: number;
    sha256: string;
  }>;
}

export type Rt95PaperEvidenceCliOptions =
  | { mode: "build"; preregistrationPath: string; rawPath: string; outputDirectory: string }
  | { mode: "verify"; outputDirectory: string };

export function parseRt95PaperEvidenceCliArgs(args: readonly string[]): Rt95PaperEvidenceCliOptions {
  let preregistrationPath: string | undefined;
  let rawPath: string | undefined;
  let outputDirectory: string | undefined;
  let verifyDirectory: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--preregistration") preregistrationPath = requiredValue(args, ++index, argument);
    else if (argument === "--raw") rawPath = requiredValue(args, ++index, argument);
    else if (argument === "--output-dir") outputDirectory = requiredValue(args, ++index, argument);
    else if (argument === "--verify-bundle") verifyDirectory = requiredValue(args, ++index, argument);
    else fail(`unknown argument: ${argument ?? ""}`);
  }
  if (verifyDirectory !== undefined) {
    if (preregistrationPath !== undefined || rawPath !== undefined || outputDirectory !== undefined) {
      fail("--verify-bundle cannot be combined with build arguments");
    }
    return { mode: "verify", outputDirectory: verifyDirectory };
  }
  if (preregistrationPath === undefined || rawPath === undefined || outputDirectory === undefined) {
    fail("build requires --preregistration, --raw and --output-dir");
  }
  return { mode: "build", preregistrationPath, rawPath, outputDirectory };
}

export async function buildRt95PaperEvidenceBundle(
  workspaceRoot: string,
  options: { preregistrationPath: string; rawPath: string; outputDirectory: string },
): Promise<Rt95PaperEvidenceManifest> {
  const root = await realpath(workspaceRoot);
  const preregistrationFile = await existingWorkspaceFile(root, options.preregistrationPath, "preregistration");
  const rawFile = await existingWorkspaceFile(root, options.rawPath, "Raw results");
  const output = await newWorkspaceDirectory(root, options.outputDirectory, "output directory");

  const preregistrationText = await readFile(preregistrationFile, "utf8");
  const rawText = await readFile(rawFile, "utf8");
  const preregistration = validateRt95Preregistration(parseJson(preregistrationText, "preregistration"));
  if (preregistration.lifecycle.status !== "frozen" || preregistration.lifecycle.frozenAt === null) {
    fail("paper evidence bundle requires a frozen preregistration");
  }
  const payloadSha256 = stringValue(preregistration.integrity.payloadSha256, "preregistration payloadSha256");
  if (!SHA256.test(payloadSha256) || computePreregistrationDigest(preregistration) !== payloadSha256) {
    fail("preregistration payload digest mismatch");
  }

  const raw = validateRawResults(parseJson(rawText, "Raw results"));
  const plan = extractFrozenPlan(preregistration);
  validateExactFrozenCoverage(raw, plan);
  const report = analyzeRawResults(raw);
  const tables = createPaperTableArtifacts(report);
  const rawIndex = renderRawIndex(raw.records);
  const failures = renderFailureRecords(raw.records);

  const artifactContents: Record<ArtifactName, string> = {
    "preregistration.frozen.json": preregistrationText,
    "raw-results.json": rawText,
    "statistics-report.json": serializeStatisticsReport(report),
    "results.md": tables.markdown,
    "arms.csv": tables.armsCsv,
    "comparisons.csv": tables.comparisonsCsv,
    "raw-index.csv": rawIndex,
    "failure-records.csv": failures,
  };
  const failureCount = raw.records.filter((record) => record.outcome === "failure").length;
  const manifest: Rt95PaperEvidenceManifest = {
    schemaVersion: RT95_PAPER_EVIDENCE_MANIFEST_VERSION,
    claimBoundary: RT95_PAPER_EVIDENCE_CLAIM_BOUNDARY,
    experimentId: raw.experimentId,
    preregistration: {
      lifecycle: "frozen",
      payloadSha256,
      sourceSha256: sha256(preregistrationText),
    },
    raw: {
      sourceSha256: sha256(rawText),
      recordCount: raw.records.length,
      successCount: raw.records.length - failureCount,
      failureCount,
      armIds: [...plan.armIds],
      pairsPerArm: plan.pairKeys.length,
      exactFrozenPlanCoverage: true,
      allOutcomesIndexed: true,
      failureRecordsRetained: true,
    },
    analysis: {
      significanceClaimed: false,
      fairnessReviewStatus: "NotReviewed",
      externalBaselineArmCount: plan.externalBaselineArmCount,
    },
    artifacts: ARTIFACT_NAMES.map((artifactPath) => ({
      path: artifactPath,
      bytes: Buffer.byteLength(artifactContents[artifactPath], "utf8"),
      sha256: sha256(artifactContents[artifactPath]),
    })),
  };
  validateRt95PaperEvidenceManifest(manifest);

  await createNewDirectory(root, output);
  for (const artifactPath of ARTIFACT_NAMES) {
    await writeFile(path.join(output, artifactPath), artifactContents[artifactPath], { encoding: "utf8", flag: "wx" });
  }
  await writeFile(path.join(output, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await verifyRt95PaperEvidenceBundle(root, path.relative(root, output));
  return manifest;
}

export async function verifyRt95PaperEvidenceBundle(
  workspaceRoot: string,
  outputDirectory: string,
): Promise<Rt95PaperEvidenceManifest> {
  const root = await realpath(workspaceRoot);
  const directory = await existingWorkspaceDirectory(root, outputDirectory, "bundle directory");
  const entries = (await readdir(directory, { withFileTypes: true }))
    .map((entry) => {
      if (!entry.isFile()) fail(`bundle contains non-file entry: ${entry.name}`);
      return entry.name;
    })
    .sort(compare);
  if (!same(entries, BUNDLE_FILE_NAMES)) {
    fail(`bundle file set mismatch; expected [${BUNDLE_FILE_NAMES.join(", ")}]`);
  }

  const manifest = validateRt95PaperEvidenceManifest(parseJson(
    await readFile(path.join(directory, MANIFEST_NAME), "utf8"),
    "artifact manifest",
  ));
  const contents = new Map<string, string>();
  for (const artifact of manifest.artifacts) {
    const content = await readFile(path.join(directory, artifact.path), "utf8");
    if (Buffer.byteLength(content, "utf8") !== artifact.bytes || sha256(content) !== artifact.sha256) {
      fail(`artifact digest mismatch: ${artifact.path}`);
    }
    contents.set(artifact.path, content);
  }

  const preregistrationText = requiredContent(contents, "preregistration.frozen.json");
  const rawText = requiredContent(contents, "raw-results.json");
  const preregistration = validateRt95Preregistration(parseJson(preregistrationText, "bundled preregistration"));
  if (preregistration.lifecycle.status !== "frozen") fail("bundled preregistration is not frozen");
  const digest = stringValue(preregistration.integrity.payloadSha256, "bundled preregistration payloadSha256");
  if (digest !== manifest.preregistration.payloadSha256 || computePreregistrationDigest(preregistration) !== digest) {
    fail("bundled preregistration digest mismatch");
  }
  if (sha256(preregistrationText) !== manifest.preregistration.sourceSha256) fail("preregistration source digest mismatch");
  if (sha256(rawText) !== manifest.raw.sourceSha256) fail("Raw source digest mismatch");

  const raw = validateRawResults(parseJson(rawText, "bundled Raw results"));
  const plan = extractFrozenPlan(preregistration);
  validateExactFrozenCoverage(raw, plan);
  const report = analyzeRawResults(raw);
  const tables = createPaperTableArtifacts(report);
  const expected = new Map<ArtifactName, string>([
    ["statistics-report.json", serializeStatisticsReport(report)],
    ["results.md", tables.markdown],
    ["arms.csv", tables.armsCsv],
    ["comparisons.csv", tables.comparisonsCsv],
    ["raw-index.csv", renderRawIndex(raw.records)],
    ["failure-records.csv", renderFailureRecords(raw.records)],
  ]);
  for (const [artifactPath, expectedContent] of expected) {
    if (requiredContent(contents, artifactPath) !== expectedContent) fail(`derived artifact mismatch: ${artifactPath}`);
  }
  const failureCount = raw.records.filter((record) => record.outcome === "failure").length;
  if (manifest.experimentId !== raw.experimentId ||
    manifest.raw.recordCount !== raw.records.length ||
    manifest.raw.successCount !== raw.records.length - failureCount ||
    manifest.raw.failureCount !== failureCount ||
    manifest.raw.pairsPerArm !== plan.pairKeys.length ||
    !same(manifest.raw.armIds, plan.armIds) ||
    manifest.analysis.externalBaselineArmCount !== plan.externalBaselineArmCount) {
    fail("manifest summary mismatch");
  }
  return manifest;
}

export function validateRt95PaperEvidenceManifest(value: unknown): Rt95PaperEvidenceManifest {
  const root = record(value, "manifest");
  exactKeys(root, ["schemaVersion", "claimBoundary", "experimentId", "preregistration", "raw", "analysis", "artifacts"], "manifest");
  constant(root.schemaVersion, RT95_PAPER_EVIDENCE_MANIFEST_VERSION, "manifest.schemaVersion");
  constant(root.claimBoundary, RT95_PAPER_EVIDENCE_CLAIM_BOUNDARY, "manifest.claimBoundary");
  machineId(root.experimentId, "manifest.experimentId");

  const preregistration = record(root.preregistration, "manifest.preregistration");
  exactKeys(preregistration, ["lifecycle", "payloadSha256", "sourceSha256"], "manifest.preregistration");
  constant(preregistration.lifecycle, "frozen", "manifest.preregistration.lifecycle");
  sha256Value(preregistration.payloadSha256, "manifest.preregistration.payloadSha256");
  sha256Value(preregistration.sourceSha256, "manifest.preregistration.sourceSha256");

  const raw = record(root.raw, "manifest.raw");
  exactKeys(raw, [
    "sourceSha256", "recordCount", "successCount", "failureCount", "armIds", "pairsPerArm",
    "exactFrozenPlanCoverage", "allOutcomesIndexed", "failureRecordsRetained",
  ], "manifest.raw");
  sha256Value(raw.sourceSha256, "manifest.raw.sourceSha256");
  const recordCount = positiveInteger(raw.recordCount, "manifest.raw.recordCount");
  const successCount = nonNegativeInteger(raw.successCount, "manifest.raw.successCount");
  const failureCount = nonNegativeInteger(raw.failureCount, "manifest.raw.failureCount");
  if (successCount + failureCount !== recordCount) fail("manifest Raw count arithmetic mismatch");
  const armIds = stringArray(raw.armIds, "manifest.raw.armIds");
  if (armIds.length < 2 || new Set(armIds).size !== armIds.length || !same(armIds, [...armIds].sort(compare))) {
    fail("manifest.raw.armIds must be unique stable order with at least two arms");
  }
  armIds.forEach((id, index) => machineId(id, `manifest.raw.armIds[${index}]`));
  positiveInteger(raw.pairsPerArm, "manifest.raw.pairsPerArm");
  constant(raw.exactFrozenPlanCoverage, true, "manifest.raw.exactFrozenPlanCoverage");
  constant(raw.allOutcomesIndexed, true, "manifest.raw.allOutcomesIndexed");
  constant(raw.failureRecordsRetained, true, "manifest.raw.failureRecordsRetained");

  const analysis = record(root.analysis, "manifest.analysis");
  exactKeys(analysis, ["significanceClaimed", "fairnessReviewStatus", "externalBaselineArmCount"], "manifest.analysis");
  constant(analysis.significanceClaimed, false, "manifest.analysis.significanceClaimed");
  constant(analysis.fairnessReviewStatus, "NotReviewed", "manifest.analysis.fairnessReviewStatus");
  nonNegativeInteger(analysis.externalBaselineArmCount, "manifest.analysis.externalBaselineArmCount");

  const artifacts = array(root.artifacts, "manifest.artifacts").map((entry, index) => {
    const artifact = record(entry, `manifest.artifacts[${index}]`);
    exactKeys(artifact, ["path", "bytes", "sha256"], `manifest.artifacts[${index}]`);
    if (!ARTIFACT_NAMES.includes(artifact.path as ArtifactName)) fail(`unknown manifest artifact path: ${String(artifact.path)}`);
    return {
      path: artifact.path as ArtifactName,
      bytes: positiveInteger(artifact.bytes, `manifest.artifacts[${index}].bytes`),
      sha256: sha256Value(artifact.sha256, `manifest.artifacts[${index}].sha256`),
    };
  });
  if (!same(artifacts.map((artifact) => artifact.path), [...ARTIFACT_NAMES])) {
    fail("manifest artifacts must contain every fixed artifact exactly once in canonical order");
  }
  return value as Rt95PaperEvidenceManifest;
}

interface FrozenPlan {
  experimentId: string;
  baselineArmId: string;
  armIds: string[];
  pairKeys: string[];
  externalBaselineArmCount: number;
}

function extractFrozenPlan(preregistration: Record<string, unknown>): FrozenPlan {
  const faultPlan = record(preregistration.faultPlan, "preregistration.faultPlan");
  constant(faultPlan.windowSetLifecycle, "frozen", "preregistration.faultPlan.windowSetLifecycle");
  const experimentId = machineId(faultPlan.gateId, "preregistration.faultPlan.gateId");
  const windows = array(faultPlan.windows, "preregistration.faultPlan.windows")
    .map((item, index) => machineId(record(item, `windows[${index}]`).id, `windows[${index}].id`));
  const seedPlan = record(preregistration.seedPlan, "preregistration.seedPlan");
  const seeds = array(seedPlan.seeds, "preregistration.seedPlan.seeds")
    .map((seed, index) => uint32(seed, `seeds[${index}]`));
  const arms = record(preregistration.arms, "preregistration.arms");
  const baselineArmId = machineId(record(arms.baseline, "arms.baseline").id, "arms.baseline.id");
  const ablations = array(arms.ablations, "arms.ablations")
    .map((item, index) => machineId(record(item, `arms.ablations[${index}]`).id, `arms.ablations[${index}].id`));
  const external = array(arms.externalBaselines, "arms.externalBaselines")
    .map((item, index) => machineId(record(item, `arms.externalBaselines[${index}]`).id, `arms.externalBaselines[${index}].id`));
  const armIds = [baselineArmId, ...ablations, ...external].sort(compare);
  return {
    experimentId,
    baselineArmId,
    armIds,
    pairKeys: windows.flatMap((windowId) => seeds.map((seed) => pairKey(seed, windowId))).sort(compare),
    externalBaselineArmCount: external.length,
  };
}

function validateExactFrozenCoverage(raw: Rt95RawResults, plan: FrozenPlan): void {
  if (raw.experimentId !== plan.experimentId) fail(`Raw experimentId must equal frozen gateId ${plan.experimentId}`);
  if (raw.baselineArmId !== plan.baselineArmId) fail(`Raw baselineArmId must equal frozen baseline ${plan.baselineArmId}`);
  const actualArmIds = [...new Set(raw.records.map((record) => record.armId))].sort(compare);
  if (!same(actualArmIds, plan.armIds)) {
    fail(`Raw arm coverage mismatch; expected [${plan.armIds.join(", ")}]`);
  }
  for (const armId of plan.armIds) {
    const actualPairs = raw.records.filter((record) => record.armId === armId)
      .map((record) => pairKey(record.seed, record.faultWindowId)).sort(compare);
    if (!same(actualPairs, plan.pairKeys)) fail(`Raw pair coverage does not match frozen plan for ${armId}`);
  }
}

function renderRawIndex(records: readonly RawResultRecord[]): string {
  const rows: Array<Array<string | number>> = [["run_id", "arm_id", "seed", "fault_window_id", "outcome", "latency_ms"]];
  for (const record of stableRecords(records)) {
    rows.push([record.runId, record.armId, record.seed, record.faultWindowId, record.outcome, record.latencyMs]);
  }
  return csv(rows);
}

function renderFailureRecords(records: readonly RawResultRecord[]): string {
  const rows: Array<Array<string | number>> = [["run_id", "arm_id", "seed", "fault_window_id", "outcome", "latency_ms"]];
  for (const record of stableRecords(records).filter((record) => record.outcome === "failure")) {
    rows.push([record.runId, record.armId, record.seed, record.faultWindowId, record.outcome, record.latencyMs]);
  }
  return csv(rows);
}

function stableRecords(records: readonly RawResultRecord[]): RawResultRecord[] {
  return [...records].sort((left, right) =>
    compare(left.armId, right.armId) || compare(left.faultWindowId, right.faultWindowId) ||
    left.seed - right.seed || compare(left.runId, right.runId));
}

async function existingWorkspaceFile(root: string, candidate: string, label: string): Promise<string> {
  const resolved = await existingWorkspacePath(root, candidate, label);
  if (!(await stat(resolved)).isFile()) fail(`${label} must be a file`);
  return resolved;
}

async function existingWorkspaceDirectory(root: string, candidate: string, label: string): Promise<string> {
  const resolved = await existingWorkspacePath(root, candidate, label);
  if (!(await stat(resolved)).isDirectory()) fail(`${label} must be a directory`);
  return resolved;
}

async function existingWorkspacePath(root: string, candidate: string, label: string): Promise<string> {
  const lexical = workspaceRelative(root, candidate, label);
  const resolved = await realpath(lexical);
  ensureContained(root, resolved, label);
  return resolved;
}

async function newWorkspaceDirectory(root: string, candidate: string, label: string): Promise<string> {
  const resolved = workspaceRelative(root, candidate, label);
  let ancestor = path.dirname(resolved);
  while (true) {
    try {
      const actualAncestor = await realpath(ancestor);
      ensureContained(root, actualAncestor, label);
      return resolved;
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) fail(`${label} has no existing ancestor inside workspace`);
      ancestor = parent;
    }
  }
}

async function createNewDirectory(root: string, directory: string): Promise<void> {
  await mkdir(path.dirname(directory), { recursive: true });
  const actualParent = await realpath(path.dirname(directory));
  ensureContained(root, actualParent, "output parent");
  try {
    await mkdir(directory, { recursive: false });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("output directory already exists; evidence bundles are never overwritten");
    throw error;
  }
}

function workspaceRelative(root: string, candidate: string, label: string): string {
  if (candidate.length === 0 || path.isAbsolute(candidate)) fail(`${label} must be workspace-relative`);
  const resolved = path.resolve(root, candidate);
  ensureContained(root, resolved, label);
  return resolved;
}

function ensureContained(root: string, target: string, label: string): void {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) fail(`${label} path escapes workspace`);
}

function pairKey(seed: number, faultWindowId: string): string {
  return `${faultWindowId}\u0000${seed}`;
}

function requiredContent(contents: ReadonlyMap<string, string>, artifactPath: ArtifactName): string {
  const content = contents.get(artifactPath);
  if (content === undefined) fail(`missing artifact content: ${artifactPath}`);
  return content;
}

function requiredValue(args: readonly string[], index: number, argument: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) fail(`${argument} requires a value`);
  return value;
}

function parseJson(text: string, label: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return fail(`${label} is not valid JSON`); }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  return array(value, label).map((item, index) => stringValue(item, `${label}[${index}]`));
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function machineId(value: unknown, label: string): string {
  const result = stringValue(value, label);
  if (!MACHINE_ID.test(result)) fail(`${label} must be a machine ID`);
  return result;
}

function sha256Value(value: unknown, label: string): string {
  const result = stringValue(value, label);
  if (!SHA256.test(result)) fail(`${label} must be a SHA-256 digest`);
  return result;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail(`${label} must be a non-negative safe integer`);
  return Number(value);
}

function positiveInteger(value: unknown, label: string): number {
  const result = nonNegativeInteger(value, label);
  if (result === 0) fail(`${label} must be positive`);
  return result;
}

function uint32(value: unknown, label: string): number {
  const result = nonNegativeInteger(value, label);
  if (result > 0xffff_ffff) fail(`${label} must be uint32`);
  return result;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(compare);
  const keys = [...expected].sort(compare);
  if (!same(actual, keys)) fail(`${label} key mismatch; expected [${keys.join(", ")}]`);
}

function constant(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) fail(`${label} must equal ${JSON.stringify(expected)}`);
}

function same(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function csv(rows: ReadonlyArray<ReadonlyArray<string | number>>): string {
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function fail(message: string): never {
  throw new Error(message);
}

async function runCli(): Promise<void> {
  const options = parseRt95PaperEvidenceCliArgs(process.argv.slice(2));
  if (options.mode === "verify") {
    const manifest = await verifyRt95PaperEvidenceBundle(process.cwd(), options.outputDirectory);
    process.stdout.write(`${JSON.stringify({ verified: true, experimentId: manifest.experimentId, claimBoundary: manifest.claimBoundary })}\n`);
  } else {
    const manifest = await buildRt95PaperEvidenceBundle(process.cwd(), options);
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  }
}

const invokedAsScript = process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  await runCli().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
