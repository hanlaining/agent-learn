import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Fail-closed evidence gate for a distributable Windows release candidate.
 *
 * This gate verifies evidence supplied by a real build/signing/validation
 * pipeline. It never performs signing, installer execution, or Provider calls;
 * a passing result is only artifact evidence and is not production approval.
 */
export interface ReleaseArtifactManifest {
  schemaVersion: "god-agent-release-artifact-v1";
  candidateRef: string;
  createdAt: string;
  installerPath: string;
  installerSha256: string;
  signature: {
    status: "verified";
    format: "authenticode";
    evidencePath: string;
    certificateSubject: string;
    timestamped: true;
  };
  cleanMachine: {
    status: "passed";
    evidencePath: string;
    executorId: string;
    machineId: string;
  };
  upgradeRollback: {
    status: "passed";
    evidencePath: string;
    testedFrom: string;
    testedTo: string;
    rollbackVerified: true;
  };
  longStability: {
    status: "passed";
    evidencePath: string;
    durationSeconds: number;
    evidenceSha256: string;
  };
  claimBoundary: "artifact-evidence-only-not-provider-not-production-approval";
}

export interface ReleaseArtifactGateReport {
  status: "PASS" | "BLOCKED";
  candidateRef?: string;
  checks: Array<{ id: string; status: "pass" | "blocking"; details: string[] }>;
}

interface SignatureReceipt {
  schemaVersion: "god-agent-release-signature-v1";
  candidateRef: string;
  installerSha256: string;
  status: "verified";
  format: "authenticode";
  certificateSubject: string;
  timestamped: true;
  verificationTool: string;
}

interface CleanMachineReceipt {
  schemaVersion: "god-agent-clean-machine-v1";
  candidateRef: string;
  status: "passed";
  executorId: string;
  machineId: string;
  installPassed: true;
  startupPassed: true;
  uninstallPassed: true;
}

interface UpgradeRollbackReceipt {
  schemaVersion: "god-agent-upgrade-rollback-v1";
  candidateRef: string;
  status: "passed";
  testedFrom: string;
  testedTo: string;
  rollbackVerified: true;
  stateIntegrityVerified: true;
}

interface LongStabilityReceipt {
  schemaVersion: "god-agent-long-stability-v1";
  candidateRef: string;
  status: "passed";
  durationSeconds: number;
  failureCount: number;
  recoveryVerified: true;
}

export async function verifyReleaseArtifactEvidence(
  workspaceRoot: string,
  manifestPath = "dist/release/release-artifact.json",
): Promise<ReleaseArtifactGateReport> {
  const root = await realpathWorkspace(workspaceRoot);
  const checks: ReleaseArtifactGateReport["checks"] = [];
  let manifest: ReleaseArtifactManifest;
  try {
    const absoluteManifest = await requireRegularFileInside(root, manifestPath, "manifestPath");
    manifest = parseManifest(await readFile(absoluteManifest, "utf8"));
    checks.push({ id: "manifest", status: "pass", details: ["schema and claim boundary are valid"] });
  } catch (error) {
    checks.push({ id: "manifest", status: "blocking", details: [safeError(error)] });
    return { status: "BLOCKED", checks };
  }

  const candidate = manifest.candidateRef;
  const evidencePaths = [manifest.signature.evidencePath, manifest.cleanMachine.evidencePath, manifest.upgradeRollback.evidencePath, manifest.longStability.evidencePath];
  if (new Set(evidencePaths).size !== evidencePaths.length) {
    checks.push({ id: "evidence-path-uniqueness", status: "blocking", details: ["signature, clean-machine, upgrade-rollback and long-stability receipts must be distinct files"] });
  }
  const installerCheck = await verifyArtifactDigest(root, manifest);
  checks.push(installerCheck);
  const signatureReceipt = await readReceipt<SignatureReceipt>(root, "signature", manifest.signature.evidencePath, "god-agent-release-signature-v1");
  const cleanMachineReceipt = await readReceipt<CleanMachineReceipt>(root, "clean-machine", manifest.cleanMachine.evidencePath, "god-agent-clean-machine-v1");
  const upgradeRollbackReceipt = await readReceipt<UpgradeRollbackReceipt>(root, "upgrade-rollback", manifest.upgradeRollback.evidencePath, "god-agent-upgrade-rollback-v1");
  const longStabilityReceipt = await readReceipt<LongStabilityReceipt>(root, "long-stability", manifest.longStability.evidencePath, "god-agent-long-stability-v1");
  checks.push(...signatureReceipt.checks, ...cleanMachineReceipt.checks, ...upgradeRollbackReceipt.checks, ...longStabilityReceipt.checks);
  checks.push({
    id: "signature",
    status: manifest.signature.status === "verified" && manifest.signature.format === "authenticode" && manifest.signature.timestamped
      && signatureReceipt.value?.candidateRef === candidate
      && signatureReceipt.value.installerSha256 === manifest.installerSha256
      && signatureReceipt.value.certificateSubject === manifest.signature.certificateSubject
      && signatureReceipt.value.status === "verified"
      && signatureReceipt.value.format === "authenticode"
      && signatureReceipt.value.timestamped === true
      && nonBlank(signatureReceipt.value.verificationTool)
      ? "pass" : "blocking",
    details: manifest.signature.status === "verified" && manifest.signature.format === "authenticode" && manifest.signature.timestamped
      && signatureReceipt.value?.candidateRef === candidate
      && signatureReceipt.value.installerSha256 === manifest.installerSha256
      && signatureReceipt.value.certificateSubject === manifest.signature.certificateSubject
      ? ["timestamped Authenticode evidence declared"] : ["signed, timestamped Authenticode evidence is required"],
  });
  checks.push({
    id: "clean-machine",
    status: manifest.cleanMachine.status === "passed" && nonBlank(manifest.cleanMachine.executorId) && nonBlank(manifest.cleanMachine.machineId)
      && cleanMachineReceipt.value?.candidateRef === candidate
      && cleanMachineReceipt.value.executorId === manifest.cleanMachine.executorId
      && cleanMachineReceipt.value.machineId === manifest.cleanMachine.machineId
      && cleanMachineReceipt.value.status === "passed"
      && cleanMachineReceipt.value.installPassed === true
      && cleanMachineReceipt.value.startupPassed === true
      && cleanMachineReceipt.value.uninstallPassed === true
      ? "pass" : "blocking",
    details: manifest.cleanMachine.status === "passed" && nonBlank(manifest.cleanMachine.executorId) && nonBlank(manifest.cleanMachine.machineId)
      ? ["independent clean-machine execution identity recorded"] : ["independent clean-machine evidence is required"],
  });
  checks.push({
    id: "upgrade-rollback",
    status: manifest.upgradeRollback.status === "passed" && manifest.upgradeRollback.rollbackVerified && nonBlank(manifest.upgradeRollback.testedFrom) && nonBlank(manifest.upgradeRollback.testedTo)
      && upgradeRollbackReceipt.value?.candidateRef === candidate
      && upgradeRollbackReceipt.value.testedFrom === manifest.upgradeRollback.testedFrom
      && upgradeRollbackReceipt.value.testedTo === manifest.upgradeRollback.testedTo
      && upgradeRollbackReceipt.value.status === "passed"
      && upgradeRollbackReceipt.value.rollbackVerified === true
      && upgradeRollbackReceipt.value.stateIntegrityVerified === true
      ? "pass" : "blocking",
    details: manifest.upgradeRollback.status === "passed" && manifest.upgradeRollback.rollbackVerified
      ? [`upgrade ${manifest.upgradeRollback.testedFrom} → ${manifest.upgradeRollback.testedTo} and rollback verified`]
      : ["upgrade and rollback evidence is required"],
  });
  checks.push({
    id: "long-stability",
    status: manifest.longStability.status === "passed" && manifest.longStability.durationSeconds >= 3600 && /^[a-f0-9]{64}$/u.test(manifest.longStability.evidenceSha256)
      && longStabilityReceipt.value?.candidateRef === candidate
      && longStabilityReceipt.value.durationSeconds === manifest.longStability.durationSeconds
      && longStabilityReceipt.value.status === "passed"
      && longStabilityReceipt.value.failureCount === 0
      && longStabilityReceipt.value.recoveryVerified === true
      && longStabilityReceipt.sha256 === manifest.longStability.evidenceSha256
      ? "pass" : "blocking",
    details: manifest.longStability.status === "passed" && manifest.longStability.durationSeconds >= 3600
      ? [`long-stability evidence covers ${manifest.longStability.durationSeconds}s`] : ["at least 3600 seconds of hashed long-stability evidence is required"],
  });

  return { status: checks.some((check) => check.status === "blocking") ? "BLOCKED" : "PASS", candidateRef: candidate, checks };
}

export function formatReleaseArtifactGateReport(report: ReleaseArtifactGateReport): string {
  const lines = [`Release artifact evidence: ${report.status}`, "Scope: artifact evidence only; not proof of a live Provider or production approval."];
  if (report.candidateRef !== undefined) lines.push(`Candidate: ${report.candidateRef}`);
  for (const check of report.checks) {
    lines.push(`- [${check.status.toUpperCase()}] ${check.id}`);
    for (const detail of check.details) lines.push(`  - ${detail}`);
  }
  return `${lines.join("\n")}\n`;
}

function parseManifest(text: string): ReleaseArtifactManifest {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("release artifact manifest is not valid JSON"); }
  if (!isRecord(value)) throw new Error("release artifact manifest must be an object");
  if (value.schemaVersion !== "god-agent-release-artifact-v1"
    || typeof value.candidateRef !== "string" || !nonBlank(value.candidateRef)
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
    || typeof value.installerPath !== "string" || !normalizedRelative(value.installerPath)
    || typeof value.installerSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.installerSha256)
    || value.claimBoundary !== "artifact-evidence-only-not-provider-not-production-approval") {
    throw new Error("release artifact manifest has invalid top-level fields");
  }
  requireExactKeys(value, ["schemaVersion", "candidateRef", "createdAt", "installerPath", "installerSha256", "signature", "cleanMachine", "upgradeRollback", "longStability", "claimBoundary"]);
  const signature = requireRecord(value.signature, "signature");
  if (signature.status !== "verified" || signature.format !== "authenticode" || signature.timestamped !== true
    || typeof signature.evidencePath !== "string" || !normalizedRelative(signature.evidencePath)
    || typeof signature.certificateSubject !== "string" || !nonBlank(signature.certificateSubject)) {
    throw new Error("signed timestamped Authenticode evidence is incomplete");
  }
  const cleanMachine = requireRecord(value.cleanMachine, "cleanMachine");
  if (cleanMachine.status !== "passed" || typeof cleanMachine.evidencePath !== "string" || !normalizedRelative(cleanMachine.evidencePath)
    || typeof cleanMachine.executorId !== "string" || !nonBlank(cleanMachine.executorId)
    || typeof cleanMachine.machineId !== "string" || !nonBlank(cleanMachine.machineId)) throw new Error("clean-machine evidence is incomplete");
  const upgradeRollback = requireRecord(value.upgradeRollback, "upgradeRollback");
  if (upgradeRollback.status !== "passed" || upgradeRollback.rollbackVerified !== true
    || typeof upgradeRollback.evidencePath !== "string" || !normalizedRelative(upgradeRollback.evidencePath)
    || typeof upgradeRollback.testedFrom !== "string" || !nonBlank(upgradeRollback.testedFrom)
    || typeof upgradeRollback.testedTo !== "string" || !nonBlank(upgradeRollback.testedTo)) throw new Error("upgrade/rollback evidence is incomplete");
  const longStability = requireRecord(value.longStability, "longStability");
  if (longStability.status !== "passed" || typeof longStability.evidencePath !== "string" || !normalizedRelative(longStability.evidencePath)
    || typeof longStability.durationSeconds !== "number" || !Number.isFinite(longStability.durationSeconds)
    || typeof longStability.evidenceSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(longStability.evidenceSha256)) throw new Error("long-stability evidence is incomplete");
  return value as unknown as ReleaseArtifactManifest;
}

async function verifyArtifactDigest(root: string, manifest: ReleaseArtifactManifest): Promise<ReleaseArtifactGateReport["checks"][number]> {
  try {
    const path = await requireRegularFileInside(root, manifest.installerPath, "installerPath");
    const actual = sha256(await readFile(path));
    return actual === manifest.installerSha256
      ? { id: "installer-digest", status: "pass", details: ["installer SHA-256 matches manifest"] }
      : { id: "installer-digest", status: "blocking", details: ["installer SHA-256 does not match manifest"] };
  } catch (error) { return { id: "installer-digest", status: "blocking", details: [safeError(error)] }; }
}

async function readReceipt<T extends object>(
  root: string,
  id: string,
  path: string,
  schemaVersion: string,
): Promise<{ value?: T; sha256?: string; checks: ReleaseArtifactGateReport["checks"] }> {
  try {
    const absolute = await requireRegularFileInside(root, path, `${id} evidencePath`);
    const text = await readFile(absolute, "utf8");
    const value = JSON.parse(text) as unknown;
    if (!isRecord(value) || value.schemaVersion !== schemaVersion) throw new Error(`${id} receipt schema is invalid`);
    return { value: value as T, sha256: sha256(Buffer.from(text, "utf8")), checks: [{ id: `${id}-evidence`, status: "pass", details: ["receipt schema and regular-file boundary are valid"] }] };
  } catch (error) { return { checks: [{ id: `${id}-evidence`, status: "blocking", details: [safeError(error)] }] }; }
}

async function realpathWorkspace(path: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(resolve(path));
}

async function requireRegularFileInside(root: string, candidate: string, label: string): Promise<string> {
  if (!normalizedRelative(candidate)) throw new Error(`${label} must be a normalized workspace-relative path`);
  const absolute = resolve(root, candidate);
  const rel = relative(root, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${label} escapes workspace`);
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  return absolute;
}

function normalizedRelative(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0 || isAbsolute(value) || value.includes("\\")) return false;
  const normalized = posix.normalize(value);
  return normalized === value && value !== "." && value !== ".." && !value.startsWith("../");
}
function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}
function requireExactKeys(value: Record<string, unknown>, expected: string[]): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new Error("release artifact manifest contains unknown or missing fields");
  }
}
function nonBlank(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function sha256(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function safeError(error: unknown): string { return error instanceof Error ? error.message : "unknown release artifact evidence failure"; }

async function main(): Promise<void> {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const report = await verifyReleaseArtifactEvidence(root, process.argv[2] ?? "dist/release/release-artifact.json");
  process.stdout.write(formatReleaseArtifactGateReport(report));
  if (report.status !== "PASS") process.exitCode = 1;
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
