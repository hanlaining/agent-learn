import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";

import { JsonFileRuntimePersistence } from "../src/runtime/json-file-runtime-persistence.js";

export interface RuntimeStateRecoveryManifest {
  schemaVersion: "god-agent-runtime-state-recovery-v1";
  candidateRef: string;
  createdAt: string;
  sourcePath: string;
  snapshotVersion: 7;
  generation: number;
  bytes: number;
  sha256: string;
  claimBoundary: "private-local-state-backup-not-signed-not-production";
}

export interface RuntimeStateRestoreReceipt {
  schemaVersion: "god-agent-runtime-state-restore-receipt-v1";
  phase: "prepared" | "committed";
  mode: "restore" | "rollback";
  candidateRef: string;
  targetPath: string;
  previousGeneration: number | null;
  previousSha256: string | null;
  restoredGeneration: number;
  restoredSha256: string;
  manifestSha256: string;
  recordedAt: string;
}

export async function createRuntimeStateRecoveryBundle(options: {
  workspaceRoot: string;
  statePath: string;
  outputDirectory: string;
  candidateRef: string;
  createdAt: string;
}): Promise<RuntimeStateRecoveryManifest> {
  const root = await realpath(resolve(options.workspaceRoot));
  const sourcePath = normalizeRelative(options.statePath, "statePath");
  const outputDirectory = normalizeRelative(options.outputDirectory, "outputDirectory");
  requireNonBlank(options.candidateRef, "candidateRef");
  requireIso(options.createdAt, "createdAt");
  const sourceAbsolute = await requireRegularFileInside(root, sourcePath);
  const outputAbsolute = await prepareNewPathInside(
    root,
    resolveInside(root, outputDirectory),
    "outputDirectory",
  );
  await requireAbsent(outputAbsolute, "Recovery bundle output already exists");

  const bytes = await readFile(sourceAbsolute);
  const snapshot = await validateRuntimeSnapshotBytes(sourceAbsolute, bytes);
  const secondRead = await readFile(sourceAbsolute);
  if (digest(secondRead) !== digest(bytes)) throw new Error("Runtime state changed while creating the recovery bundle");

  const manifest: RuntimeStateRecoveryManifest = {
    schemaVersion: "god-agent-runtime-state-recovery-v1",
    candidateRef: options.candidateRef,
    createdAt: options.createdAt,
    sourcePath,
    snapshotVersion: 7,
    generation: snapshot.generation,
    bytes: bytes.byteLength,
    sha256: digest(bytes),
    claimBoundary: "private-local-state-backup-not-signed-not-production",
  };
  const staging = `${outputAbsolute}.staging-${process.pid}`;
  await requireAbsent(staging, "Recovery bundle staging path already exists");
  try {
    await mkdir(staging, { recursive: false });
    await writeFile(resolve(staging, "runtime-state.json"), bytes, { flag: "wx" });
    await writeFile(resolve(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(staging, outputAbsolute);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return manifest;
}

export async function verifyRuntimeStateRecoveryBundle(options: {
  workspaceRoot: string;
  bundleDirectory: string;
  expectedCandidateRef?: string;
}): Promise<{ manifest: RuntimeStateRecoveryManifest; manifestSha256: string }> {
  const root = await realpath(resolve(options.workspaceRoot));
  const bundleDirectory = normalizeRelative(options.bundleDirectory, "bundleDirectory");
  const bundleAbsolute = resolveInside(root, bundleDirectory);
  const entries = (await readdir(bundleAbsolute)).sort();
  if (entries.length !== 2 || entries[0] !== "manifest.json" || entries[1] !== "runtime-state.json") {
    throw new Error("Recovery bundle must contain exactly manifest.json and runtime-state.json");
  }
  const manifestPath = await requireRegularFileInside(root, `${bundleDirectory}/manifest.json`);
  const statePath = await requireRegularFileInside(root, `${bundleDirectory}/runtime-state.json`);
  const manifestBytes = await readFile(manifestPath);
  const manifest = parseManifest(manifestBytes.toString("utf8"));
  if (options.expectedCandidateRef !== undefined && manifest.candidateRef !== options.expectedCandidateRef) {
    throw new Error("Recovery bundle candidate does not match the requested candidate");
  }
  const stateBytes = await readFile(statePath);
  if (manifest.bytes !== stateBytes.byteLength || manifest.sha256 !== digest(stateBytes)) {
    throw new Error("Recovery bundle state digest or byte count drifted");
  }
  const snapshot = await validateRuntimeSnapshotBytes(statePath, stateBytes);
  if (snapshot.generation !== manifest.generation || manifest.snapshotVersion !== 7) {
    throw new Error("Recovery manifest does not match its runtime snapshot generation");
  }
  return { manifest, manifestSha256: digest(manifestBytes) };
}

export async function restoreRuntimeStateRecoveryBundle(options: {
  workspaceRoot: string;
  bundleDirectory: string;
  targetStatePath: string;
  expectedCandidateRef: string;
  recordedAt: string;
  mode: "restore" | "rollback";
  expectedCurrentSha256?: string;
}): Promise<RuntimeStateRestoreReceipt> {
  requireIso(options.recordedAt, "recordedAt");
  const root = await realpath(resolve(options.workspaceRoot));
  const targetPath = normalizeRelative(options.targetStatePath, "targetStatePath");
  const targetAbsolute = resolveInside(root, targetPath);
  const verified = await verifyRuntimeStateRecoveryBundle({
    workspaceRoot: root,
    bundleDirectory: options.bundleDirectory,
    expectedCandidateRef: options.expectedCandidateRef,
  });
  const bundleStatePath = resolveInside(root, `${normalizeRelative(options.bundleDirectory, "bundleDirectory")}/runtime-state.json`);
  const restoredBytes = await readFile(bundleStatePath);

  let previousGeneration: number | null = null;
  let previousSha256: string | null = null;
  try {
    const currentPath = await requireRegularFileInside(root, targetPath);
    const currentBytes = await readFile(currentPath);
    const current = await validateRuntimeSnapshotBytes(currentPath, currentBytes);
    previousGeneration = current.generation;
    previousSha256 = digest(currentBytes);
    if (options.mode !== "rollback") throw new Error("Restore refuses to overwrite an existing runtime state");
    if (!/^[a-f0-9]{64}$/u.test(options.expectedCurrentSha256 ?? "") || options.expectedCurrentSha256 !== previousSha256) {
      throw new Error("Rollback current-state digest does not match the caller precondition");
    }
    if (current.generation <= verified.manifest.generation) {
      throw new Error("Rollback requires a current generation newer than the backup generation");
    }
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    if (options.mode !== "restore") throw new Error("Rollback requires an existing runtime state");
  }

  const safeTargetAbsolute = await prepareNewPathInside(
    root,
    targetAbsolute,
    "targetStatePath",
  );
  const receiptDirectory = `${safeTargetAbsolute}.restore-receipts`;
  await mkdir(receiptDirectory, { recursive: true });
  const receiptId = `${options.recordedAt.replace(/[^0-9]/gu, "")}-${verified.manifest.sha256.slice(0, 16)}`;
  const baseReceipt = {
    schemaVersion: "god-agent-runtime-state-restore-receipt-v1" as const,
    mode: options.mode,
    candidateRef: options.expectedCandidateRef,
    targetPath,
    previousGeneration,
    previousSha256,
    restoredGeneration: verified.manifest.generation,
    restoredSha256: verified.manifest.sha256,
    manifestSha256: verified.manifestSha256,
    recordedAt: options.recordedAt,
  };
  const prepared: RuntimeStateRestoreReceipt = { ...baseReceipt, phase: "prepared" };
  const committed: RuntimeStateRestoreReceipt = { ...baseReceipt, phase: "committed" };
  await writeFile(resolve(receiptDirectory, `${receiptId}.prepared.json`), `${JSON.stringify(prepared, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  const temporary = resolve(dirname(safeTargetAbsolute), `.${basename(safeTargetAbsolute)}.restore-${process.pid}.tmp`);
  try {
    await writeFile(temporary, restoredBytes, { flag: "wx" });
    await validateRuntimeSnapshotBytes(temporary, restoredBytes);
    await rename(temporary, safeTargetAbsolute);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  const committedBytes = await readFile(safeTargetAbsolute);
  if (digest(committedBytes) !== verified.manifest.sha256) throw new Error("Restored runtime state failed post-commit verification");
  await writeFile(resolve(receiptDirectory, `${receiptId}.committed.json`), `${JSON.stringify(committed, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return committed;
}

async function validateRuntimeSnapshotBytes(path: string, bytes: Buffer): Promise<{ generation: number }> {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Runtime state backup is not valid JSON");
  }
  if (!isRecord(value) || value.version !== 7 || !Number.isInteger(value.generation) || (value.generation as number) < 0) {
    throw new Error("Runtime state backup is not a supported version 7 snapshot");
  }
  const loaded = await new JsonFileRuntimePersistence(path).load();
  if (!loaded.restored || loaded.generation !== value.generation) throw new Error("Runtime state backup failed authoritative restore validation");
  return { generation: value.generation as number };
}

function parseManifest(text: string): RuntimeStateRecoveryManifest {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Recovery manifest is not valid JSON"); }
  if (!isRecord(value)) throw new Error("Recovery manifest must be an object");
  assertExactKeys(value, ["schemaVersion", "candidateRef", "createdAt", "sourcePath", "snapshotVersion", "generation", "bytes", "sha256", "claimBoundary"]);
  if (value.schemaVersion !== "god-agent-runtime-state-recovery-v1"
    || value.snapshotVersion !== 7 || !Number.isInteger(value.generation) || (value.generation as number) < 0
    || !Number.isInteger(value.bytes) || (value.bytes as number) < 1
    || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.sha256)
    || value.claimBoundary !== "private-local-state-backup-not-signed-not-production"
    || typeof value.candidateRef !== "string" || value.candidateRef.trim().length === 0
    || typeof value.sourcePath !== "string" || normalizeRelative(value.sourcePath, "sourcePath") !== value.sourcePath
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new Error("Recovery manifest contains invalid fields");
  }
  return value as unknown as RuntimeStateRecoveryManifest;
}

async function requireRegularFileInside(root: string, path: string): Promise<string> {
  const absolute = resolveInside(root, path);
  const stat = await lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Recovery path is not a regular file: ${path}`);
  const physical = await realpath(absolute);
  const rel = relative(root, physical);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Recovery path escapes workspace: ${path}`);
  return physical;
}

async function prepareNewPathInside(root: string, target: string, label: string): Promise<string> {
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const physicalParent = await realpath(parent);
  const rel = relative(root, physicalParent);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Recovery ${label} parent escapes workspace`);
  }
  return resolve(physicalParent, basename(target));
}

function resolveInside(root: string, path: string): string {
  const absolute = resolve(root, ...path.split("/"));
  const rel = relative(root, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Recovery path escapes workspace: ${path}`);
  return absolute;
}

function normalizeRelative(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || isAbsolute(value) || value.includes("\\")) throw new Error(`${label} must be a normalized workspace-relative path`);
  const normalized = posix.normalize(value);
  if (normalized !== value || normalized === "." || normalized === ".." || normalized.startsWith("../")) throw new Error(`${label} must be a normalized workspace-relative path`);
  return normalized;
}

async function requireAbsent(path: string, message: string): Promise<void> {
  try { await lstat(path); throw new Error(message); } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
}

function requireNonBlank(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be non-empty`);
}

function requireIso(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO date-time`);
}

function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function hasCode(error: unknown, code: string): boolean { return isRecord(error) && error.code === code; }
function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error("Recovery manifest contains missing or unknown fields");
}
