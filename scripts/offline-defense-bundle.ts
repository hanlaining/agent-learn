import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  expectedDocumentTokens,
  parseEvidenceSnapshot,
  validateSnapshot,
  type EvidenceSnapshot,
} from "./verify-evidence-consistency.js";

export type OfflineDefenseFileRole =
  | "evidence-snapshot"
  | "presentation"
  | "presentation-inspection"
  | "script"
  | "q-and-a"
  | "screenshot"
  | "report";

export interface OfflineDefenseInput {
  role: OfflineDefenseFileRole;
  path: string;
}

export interface OfflineDefenseFile {
  role: OfflineDefenseFileRole;
  sourcePath: string;
  bundlePath: string;
  bytes: number;
  sha256: string;
}

export interface OfflineDefenseManifest {
  schemaVersion: "god-agent-offline-defense-bundle-v1";
  createdFromEvidenceAt: string;
  candidateRef: string;
  evidenceSnapshotSha256: string;
  claimBoundary: {
    rehearsalStatus: "NotRun" | "InProgress" | "Passed";
    formalVerified: number;
    liveCalls: number;
    releaseStatus: "READY" | "BLOCKED";
    productionStatus: "BLOCKED";
  };
  files: OfflineDefenseFile[];
}

export interface OfflineDefenseBundleOptions {
  workspaceRoot: string;
  outputDirectory: string;
  inputs?: readonly OfflineDefenseInput[];
}

export interface OfflineDefenseVerification {
  manifest: OfflineDefenseManifest;
  manifestSha256: string;
  verifiedFiles: number;
}

export const DEFAULT_OFFLINE_DEFENSE_INPUTS: readonly OfflineDefenseInput[] = [
  { role: "evidence-snapshot", path: "docs/evidence/current-evidence.json" },
  { role: "presentation", path: "docs/God-Agent-考研复试最小答辩展示包.pptx" },
  { role: "presentation-inspection", path: "docs/God-Agent-考研复试最小答辩展示包.pptx.inspect.ndjson" },
  { role: "script", path: "docs/DEMO-复试三分钟演示.md" },
  { role: "q-and-a", path: "docs/God-Agent-考研复试高频追问与回答.md" },
  { role: "screenshot", path: ".tmp/ppt-final-20260824-2/final-render/slide-1.png" },
  { role: "screenshot", path: ".tmp/ppt-final-20260824-2/final-render/slide-5.png" },
  { role: "screenshot", path: ".tmp/ppt-final-20260824-2/final-render/slide-7.png" },
  { role: "report", path: ".tmp/gate40-pilot-40/process-chaos-gate40-pilot-manifest.json" },
  { role: "report", path: ".tmp/release/bom.cdx.json" },
] as const;

const MANIFEST_NAME = "manifest.json";
const TEXT_ROLES = new Set<OfflineDefenseFileRole>([
  "evidence-snapshot",
  "presentation-inspection",
  "script",
  "q-and-a",
  "report",
]);
const AUTHORITATIVE_TEXT_ROLES = new Set<OfflineDefenseFileRole>([
  "presentation-inspection",
  "script",
  "q-and-a",
]);
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
] as const;
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = resolve(dirname(SCRIPT_PATH), "..");

export async function createOfflineDefenseBundle(
  options: OfflineDefenseBundleOptions,
): Promise<OfflineDefenseVerification> {
  const root = resolve(options.workspaceRoot);
  const outputRelative = normalizeRelativePath(options.outputDirectory, "output directory");
  const outputAbsolute = resolveInside(root, outputRelative);
  const inputs = normalizeInputs(options.inputs ?? DEFAULT_OFFLINE_DEFENSE_INPUTS);
  await assertDoesNotExist(outputAbsolute);

  const evidenceInput = inputs.find((item) => item.role === "evidence-snapshot");
  if (evidenceInput === undefined) throw new Error("Offline defense bundle requires one evidence snapshot");
  const evidenceBytes = await readSafeWorkspaceFile(root, evidenceInput.path);
  const snapshot = parseEvidenceSnapshot(evidenceBytes.toString("utf8"));
  validateSnapshot(snapshot);

  const parent = dirname(outputAbsolute);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(resolve(parent, ".offline-defense-staging-"));
  let published = false;
  try {
    const files: OfflineDefenseFile[] = [];
    for (const input of inputs) {
      const bytes = input.path === evidenceInput.path
        ? evidenceBytes
        : await readSafeWorkspaceFile(root, input.path);
      rejectSecrets(bytes, input.path, input.role);
      if (AUTHORITATIVE_TEXT_ROLES.has(input.role)) {
        assertCurrentEvidenceTokens(bytes.toString("utf8"), snapshot, input.path);
      }
      const bundlePath = `files/${input.path}`;
      const destination = resolveInside(staging, bundlePath);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(resolveInside(root, input.path), destination);
      files.push({
        role: input.role,
        sourcePath: input.path,
        bundlePath,
        bytes: bytes.length,
        sha256: digest(bytes),
      });
    }

    const evidenceFile = files.find((file) => file.role === "evidence-snapshot");
    if (evidenceFile === undefined) throw new Error("Evidence snapshot file is missing from bundle");
    const manifest: OfflineDefenseManifest = {
      schemaVersion: "god-agent-offline-defense-bundle-v1",
      createdFromEvidenceAt: snapshot.capturedAt,
      candidateRef: snapshot.candidate.baseline,
      evidenceSnapshotSha256: evidenceFile.sha256,
      claimBoundary: {
        rehearsalStatus: snapshot.rehearsal.status,
        formalVerified: snapshot.gate40.formalVerified,
        liveCalls: snapshot.provider.liveCalls,
        releaseStatus: snapshot.release.localStatus,
        productionStatus: snapshot.release.productionStatus,
      },
      files,
    };
    await writeFile(resolve(staging, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await verifyOfflineDefenseBundle({ ...options, inputs, outputDirectory: relative(root, staging).replaceAll("\\", "/") });
    await rename(staging, outputAbsolute);
    published = true;
    return verifyOfflineDefenseBundle({ ...options, inputs, outputDirectory: outputRelative });
  } finally {
    if (!published) await rm(staging, { recursive: true, force: true });
  }
}

export async function verifyOfflineDefenseBundle(
  options: OfflineDefenseBundleOptions,
): Promise<OfflineDefenseVerification> {
  const root = resolve(options.workspaceRoot);
  const outputRelative = normalizeRelativePath(options.outputDirectory, "output directory");
  const outputAbsolute = resolveInside(root, outputRelative);
  const manifestBytes = await readFile(resolveInside(outputAbsolute, MANIFEST_NAME));
  const manifest = parseManifest(manifestBytes.toString("utf8"));
  validateManifestShape(manifest);
  assertRequiredRoles(manifest.files);

  const evidenceFile = manifest.files.find((file) => file.role === "evidence-snapshot");
  if (evidenceFile === undefined) throw new Error("Offline defense manifest requires one evidence snapshot");
  const evidenceBundleBytes = await readFile(resolveInside(outputAbsolute, evidenceFile.bundlePath));
  const snapshot = parseEvidenceSnapshot(evidenceBundleBytes.toString("utf8"));
  validateSnapshot(snapshot);
  if (manifest.candidateRef !== snapshot.candidate.baseline
    || manifest.createdFromEvidenceAt !== snapshot.capturedAt
    || manifest.evidenceSnapshotSha256 !== digest(evidenceBundleBytes)) {
    throw new Error("Offline defense manifest is not bound to its evidence snapshot");
  }
  assertClaimBoundary(manifest, snapshot);

  const expectedFiles = new Set<string>([MANIFEST_NAME]);
  for (const file of manifest.files) {
    validateManifestFile(file);
    if (!expectedFiles.add(file.bundlePath)) throw new Error(`Duplicate bundle path: ${file.bundlePath}`);
    const sourceBytes = await readSafeWorkspaceFile(root, file.sourcePath);
    let bundleBytes: Buffer;
    try {
      bundleBytes = await readFile(resolveInside(outputAbsolute, file.bundlePath));
    } catch (error) {
      throw new Error(`Offline defense bundled file is missing: ${file.bundlePath}`, { cause: error });
    }
    const sourceDigest = digest(sourceBytes);
    if (sourceBytes.length !== file.bytes || bundleBytes.length !== file.bytes
      || sourceDigest !== file.sha256 || digest(bundleBytes) !== file.sha256) {
      throw new Error(`Offline defense digest or byte-size drift: ${file.sourcePath}`);
    }
    rejectSecrets(bundleBytes, file.bundlePath, file.role);
    if (AUTHORITATIVE_TEXT_ROLES.has(file.role)) {
      assertCurrentEvidenceTokens(bundleBytes.toString("utf8"), snapshot, file.bundlePath);
    }
  }

  const actualFiles = new Set(await listRelativeFiles(outputAbsolute));
  const missing = [...expectedFiles].filter((path) => !actualFiles.has(path));
  const extra = [...actualFiles].filter((path) => !expectedFiles.has(path));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`Offline defense file set drift; missing=${missing.join(",") || "none"}; extra=${extra.join(",") || "none"}`);
  }
  return { manifest, manifestSha256: digest(manifestBytes), verifiedFiles: manifest.files.length };
}

function normalizeInputs(inputs: readonly OfflineDefenseInput[]): OfflineDefenseInput[] {
  const result = inputs.map((input) => ({
    role: input.role,
    path: normalizeRelativePath(input.path, "input path"),
  }));
  const paths = new Set<string>();
  for (const input of result) {
    if (!isRole(input.role)) throw new Error(`Unknown offline defense role: ${String(input.role)}`);
    if (!paths.add(input.path)) throw new Error(`Duplicate offline defense input: ${input.path}`);
  }
  assertRequiredRoles(result.map((input) => ({ role: input.role })));
  return result.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

function parseManifest(text: string): OfflineDefenseManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Offline defense manifest is not valid JSON");
  }
  if (!isRecord(value)) throw new Error("Offline defense manifest must be an object");
  return value as unknown as OfflineDefenseManifest;
}

function validateManifestShape(manifest: OfflineDefenseManifest): void {
  assertExactKeys(manifest as unknown as Record<string, unknown>, [
    "schemaVersion", "createdFromEvidenceAt", "candidateRef", "evidenceSnapshotSha256", "claimBoundary", "files",
  ], "offline defense manifest");
  if (manifest.schemaVersion !== "god-agent-offline-defense-bundle-v1"
    || !nonBlank(manifest.createdFromEvidenceAt) || !Number.isFinite(Date.parse(manifest.createdFromEvidenceAt))
    || !nonBlank(manifest.candidateRef) || !/^[a-f0-9]{64}$/u.test(manifest.evidenceSnapshotSha256)
    || !Array.isArray(manifest.files)) {
    throw new Error("Offline defense manifest fields are invalid");
  }
  assertExactKeys(manifest.claimBoundary as unknown as Record<string, unknown>, [
    "rehearsalStatus", "formalVerified", "liveCalls", "releaseStatus", "productionStatus",
  ], "offline defense claim boundary");
}

function validateManifestFile(file: OfflineDefenseFile): void {
  assertExactKeys(file as unknown as Record<string, unknown>, ["role", "sourcePath", "bundlePath", "bytes", "sha256"], "offline defense file");
  if (!isRole(file.role)) throw new Error("Offline defense file role is invalid");
  const sourcePath = normalizeRelativePath(file.sourcePath, "manifest source path");
  const bundlePath = normalizeRelativePath(file.bundlePath, "manifest bundle path");
  if (sourcePath !== file.sourcePath || bundlePath !== file.bundlePath || bundlePath !== `files/${sourcePath}`) {
    throw new Error("Offline defense manifest paths are not canonical");
  }
  if (!Number.isInteger(file.bytes) || file.bytes < 1 || !/^[a-f0-9]{64}$/u.test(file.sha256)) {
    throw new Error("Offline defense file size or digest is invalid");
  }
}

function assertRequiredRoles(files: readonly { role: OfflineDefenseFileRole }[]): void {
  const counts = new Map<OfflineDefenseFileRole, number>();
  for (const file of files) counts.set(file.role, (counts.get(file.role) ?? 0) + 1);
  for (const role of ["evidence-snapshot", "presentation", "presentation-inspection", "script", "q-and-a"] as const) {
    if (counts.get(role) !== 1) throw new Error(`Offline defense bundle requires exactly one ${role}`);
  }
  for (const role of ["screenshot", "report"] as const) {
    if ((counts.get(role) ?? 0) < 1) throw new Error(`Offline defense bundle requires at least one ${role}`);
  }
}

function assertClaimBoundary(manifest: OfflineDefenseManifest, snapshot: EvidenceSnapshot): void {
  const expected = {
    rehearsalStatus: snapshot.rehearsal.status,
    formalVerified: snapshot.gate40.formalVerified,
    liveCalls: snapshot.provider.liveCalls,
    releaseStatus: snapshot.release.localStatus,
    productionStatus: snapshot.release.productionStatus,
  };
  if (JSON.stringify(manifest.claimBoundary) !== JSON.stringify(expected)) {
    throw new Error("Offline defense claim boundary drifted from evidence snapshot");
  }
}

async function readSafeWorkspaceFile(root: string, sourcePath: string): Promise<Buffer> {
  const normalized = normalizeRelativePath(sourcePath, "source path");
  const absolute = resolveInside(root, normalized);
  try {
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("not a regular file");
    const rootReal = await realpath(root);
    const sourceReal = await realpath(absolute);
    const physicalRelative = relative(rootReal, sourceReal);
    if (physicalRelative === "" || physicalRelative === ".." || physicalRelative.startsWith(`..${sep}`) || isAbsolute(physicalRelative)) {
      throw new Error("physical path escapes workspace");
    }
    return await readFile(absolute);
  } catch (error) {
    throw new Error(`Offline defense source is missing or unsafe: ${sourcePath}`, { cause: error });
  }
}

function assertCurrentEvidenceTokens(text: string, snapshot: EvidenceSnapshot, sourcePath: string): void {
  const normalized = normalizeEvidenceText(text);
  const missing = expectedDocumentTokens(snapshot).filter((token) => !normalized.includes(normalizeEvidenceText(token)));
  if (missing.length > 0) throw new Error(`Offline defense old-number drift in ${sourcePath}: missing ${missing.join(", ")}`);
}

function rejectSecrets(bytes: Buffer, sourcePath: string, role: OfflineDefenseFileRole): void {
  if (!TEXT_ROLES.has(role) && bytes.includes(0)) return;
  const text = bytes.toString("utf8");
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new Error(`Offline defense secret pattern detected in ${sourcePath}`);
  }
}

function normalizeEvidenceText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replaceAll(",", "").replaceAll("=", "").replaceAll("个", "").replace(/\s+/gu, "");
}

function normalizeRelativePath(value: string, label: string): string {
  if (!nonBlank(value) || isAbsolute(value)) throw new Error(`Offline defense ${label} must be workspace-relative`);
  const slash = value.replaceAll("\\", "/");
  const normalized = posix.normalize(slash);
  if (normalized !== slash || normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    throw new Error(`Offline defense ${label} is unsafe or non-canonical: ${value}`);
  }
  return normalized;
}

function resolveInside(root: string, relativePath: string): string {
  const absolute = resolve(root, relativePath);
  const rel = relative(root, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Offline defense path escapes root: ${relativePath}`);
  }
  return absolute;
}

async function assertDoesNotExist(target: string): Promise<void> {
  try {
    await stat(target);
  } catch {
    return;
  }
  throw new Error(`Offline defense output already exists: ${target}`);
}

async function listRelativeFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = resolve(current, entry.name);
    if (entry.isDirectory()) files.push(...await listRelativeFiles(root, absolute));
    else if (entry.isFile()) files.push(relative(root, absolute).replaceAll("\\", "/"));
    else throw new Error(`Offline defense bundle contains unsafe entry: ${entry.name}`);
  }
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains missing or unknown fields`);
  }
}

function isRole(value: unknown): value is OfflineDefenseFileRole {
  return typeof value === "string" && [
    "evidence-snapshot", "presentation", "presentation-inspection", "script", "q-and-a", "screenshot", "report",
  ].includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseCli(args: readonly string[]): { command: "create" | "verify"; outputDirectory: string } {
  const command = args[0];
  if (command !== "create" && command !== "verify") {
    throw new Error("Usage: npx --no-install tsx scripts/offline-defense-bundle.ts <create|verify> --output <workspace-relative-directory>");
  }
  const outputIndex = args.indexOf("--output");
  const outputDirectory = outputIndex < 0 ? undefined : args[outputIndex + 1];
  if (outputDirectory === undefined || args.length !== 3 || outputIndex !== 1) throw new Error("--output is required exactly once");
  return { command, outputDirectory };
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  const action = options.command === "create" ? createOfflineDefenseBundle : verifyOfflineDefenseBundle;
  const result = await action({ workspaceRoot: DEFAULT_ROOT, outputDirectory: options.outputDirectory });
  process.stdout.write(`${JSON.stringify({
    status: "VERIFIED",
    candidateRef: result.manifest.candidateRef,
    verifiedFiles: result.verifiedFiles,
    manifestSha256: result.manifestSha256,
    claimBoundary: result.manifest.claimBoundary,
  }, null, 2)}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_PATH) await main();
