import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  listVersionControlCandidates,
  runSecurityScan,
  scanSecurityCandidates,
  type SecurityScanReport,
} from "./security-scan.js";
import { generateCycloneDxSbom } from "./generate-sbom.js";
import {
  evaluateNpmAuditReport,
  runAuthoritativeDependencyRiskGate,
  type DependencyRiskReport,
} from "./dependency-risk-gate.js";
import { verifyEvidenceConsistency } from "./verify-evidence-consistency.js";
import { verifyTestDiscovery } from "./verify-test-discovery.js";
import { verifyReleaseArtifactEvidence, type ReleaseArtifactGateReport } from "./release-artifact-gate.js";

export type ReadinessLevel = "pass" | "info" | "warning" | "blocking";

export interface ReadinessCheck {
  id: string;
  level: ReadinessLevel;
  summary: string;
  details: string[];
}

export interface ReleaseReadinessReport {
  status: "READY" | "CONDITIONAL" | "BLOCKED";
  checks: ReadinessCheck[];
  counts: Record<ReadinessLevel, number>;
}

export interface ReleaseReadinessOptions {
  candidatePaths?: readonly string[];
  dependencyAuditReport?: unknown;
}

interface PackageMetadata {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  license?: unknown;
  author?: unknown;
  repository?: unknown;
  main?: unknown;
  bin?: unknown;
  scripts?: Record<string, string>;
}

const REQUIRED_CI_COMMANDS = [
  "npm ci",
  "npm run check",
  "npm run test:discovery",
  "npm run test:evidence",
  "npm run evidence:verify",
  "npm test",
  "npm run test:coverage",
  "npm run security:scan",
  "npm run test:benchmarks",
  "npm run test:runtime-e2e",
  "npm run test:process-chaos",
  "npm run electron:build",
  "npm run doctor",
  "npm run sbom:generate",
  "npm run release:check",
] as const;

export async function evaluateReleaseReadiness(
  workspaceRoot: string,
  options: ReleaseReadinessOptions = {},
): Promise<ReleaseReadinessReport> {
  const root = resolve(workspaceRoot);
  const checks: ReadinessCheck[] = [];
  const packageText = await readOptional(resolve(root, "package.json"));
  const packageJson = parsePackageMetadata(packageText, checks);
  checks.push(...await checkPackageMetadata(root, packageJson));
  const dependencyRisk = options.dependencyAuditReport === undefined
    ? await runAuthoritativeDependencyRiskGate(root)
    : evaluateNpmAuditReport(options.dependencyAuditReport);
  checks.push(checkDependencyRisk(dependencyRisk));

  const readme = await readOptional(resolve(root, "README.md"));
  const license = await readOptional(resolve(root, "LICENSE"));
  const notice = await readOptional(resolve(root, "NOTICE"));
  checks.push(...checkReleaseDocuments(readme, license, notice, packageJson));

  const ci = await readOptional(resolve(root, ".github", "workflows", "ci.yml"));
  checks.push(checkCiGate(ci));
  checks.push(await checkTestDiscovery(root, packageJson, readme));
  checks.push(await checkElectronBuild(root, packageJson));
  const releaseArtifactReport = await verifyReleaseArtifactEvidence(root);
  checks.push(toReleaseArtifactReadinessCheck(releaseArtifactReport));
  checks.push(await checkReleaseSupplyChainEvidence(root, releaseArtifactReport.candidateRef));
  checks.push(checkProviderOfflineDefault(packageJson, ci, await readOptional(resolve(root, "src", "llm", "provider-capability-smoke.ts"))));

  const candidates = options.candidatePaths === undefined
    ? await listVersionControlCandidates(root)
    : [...options.candidatePaths];
  checks.push(checkSensitiveFileBlacklist(candidates));
  const securityReport = options.candidatePaths === undefined
    ? await runSecurityScan(root)
    : await scanSecurityCandidates(root, candidates);
  checks.push(checkSecurityReport(securityReport));

  return finalize(checks);
}

function toReleaseArtifactReadinessCheck(report: ReleaseArtifactGateReport): ReadinessCheck {
  if (report.status === "PASS") {
    return pass(
      "release-artifact-evidence",
      "Installer, timestamped signature, clean-machine, upgrade/rollback and long-stability receipts are internally consistent",
      ["artifact evidence only; this does not prove a live Provider or production approval"],
    );
  }
  const details = report.checks
    .filter((check) => check.status === "blocking")
    .flatMap((check) => check.details.map((detail) => `${check.id}: ${detail}`));
  return blocking(
    "release-artifact-evidence",
    "Required release artifact evidence is missing or failed closed",
    details.length > 0 ? details : ["dist/release/release-artifact.json is required"],
  );
}

/**
 * Verifies the candidate-bound SBOM, security scan and data-integrity receipts.
 * The gate only checks artifacts produced by an external build/validation run;
 * missing or malformed receipts remain BLOCKED and can never imply production approval.
 */
async function checkReleaseSupplyChainEvidence(root: string, artifactCandidateRef: string | undefined): Promise<ReadinessCheck> {
  const manifestPath = "dist/release/release-supply-chain.json";
  try {
    const manifestFile = await requireRegularReleaseFile(root, manifestPath, "supply-chain manifest");
    const manifest = parseSupplyChainManifest(await readFile(manifestFile, "utf8"));
    if (artifactCandidateRef === undefined || manifest.candidateRef !== artifactCandidateRef) {
      return blocking("release-supply-chain-evidence", "SBOM/security/data-integrity evidence is not bound to the release candidate", [
        `artifact candidate: ${artifactCandidateRef ?? "missing"}`,
        `supply-chain candidate: ${manifest.candidateRef}`,
      ]);
    }
    const checks: string[] = [];
    // Bind this index to the exact artifact manifest bytes, not merely to a
    // human-readable candidateRef. A replacement artifact must regenerate all
    // supply-chain receipts and the index.
    try {
      const artifactManifest = await requireRegularReleaseFile(root, "dist/release/release-artifact.json", "release artifact manifest");
      const actualArtifactSha256 = createHash("sha256").update(await readFile(artifactManifest)).digest("hex");
      if (actualArtifactSha256 !== manifest.releaseArtifactSha256) checks.push("release artifact manifest SHA-256 does not match supply-chain index");
    } catch (error) {
      checks.push(`release artifact manifest: ${safeError(error)}`);
    }
    const receiptPaths = [manifest.sbom.path, manifest.securityScan.path, manifest.dataIntegrity.path];
    if (new Set(receiptPaths).size !== receiptPaths.length) checks.push("SBOM, security and data-integrity evidence must be distinct files");
    const sbom = await verifySupplyEvidenceFile(root, manifest.sbom.path, manifest.sbom.sha256, "SBOM");
    checks.push(...sbom.errors);
    if (sbom.text !== undefined) {
      try {
        const value = JSON.parse(sbom.text) as Record<string, unknown>;
        const components = Array.isArray(value.components) ? value.components : undefined;
        if (value.bomFormat !== "CycloneDX" || value.specVersion !== "1.5" || components === undefined) {
          checks.push("SBOM must be CycloneDX 1.5 with a components array");
        } else if (components.length !== manifest.sbom.componentCount) {
          checks.push(`SBOM component count mismatch: expected ${manifest.sbom.componentCount}, got ${components.length}`);
        }
      } catch { checks.push("SBOM evidence is not valid JSON"); }
    }
    const security = await verifySupplyEvidenceFile(root, manifest.securityScan.path, manifest.securityScan.sha256, "security scan");
    checks.push(...security.errors);
    if (security.text !== undefined) {
      try {
        const value = JSON.parse(security.text) as Record<string, unknown>;
        const findings = Array.isArray(value.findings) ? value.findings : undefined;
        if (value.schemaVersion !== "god-agent-security-scan-v1" || value.candidateRef !== manifest.candidateRef || value.status !== "passed" || findings === undefined) {
          checks.push("security scan receipt must be a passed candidate-bound god-agent-security-scan-v1 report");
        } else if (findings.length !== 0 || manifest.securityScan.findingCount !== 0 || value.scannedFiles !== manifest.securityScan.scannedFiles) {
          checks.push("security scan receipt must report zero findings and match scannedFiles");
        }
      } catch { checks.push("security scan evidence is not valid JSON"); }
    }
    const integrity = await verifySupplyEvidenceFile(root, manifest.dataIntegrity.path, manifest.dataIntegrity.sha256, "data-integrity");
    checks.push(...integrity.errors);
    if (integrity.text !== undefined) {
      try {
        const value = JSON.parse(integrity.text) as Record<string, unknown>;
        if (value.schemaVersion !== "god-agent-data-integrity-v1" || value.candidateRef !== manifest.candidateRef || value.status !== "passed"
          || value.stateDigestVerified !== true || value.backupRestoreVerified !== true || value.noDataLoss !== true) {
          checks.push("data-integrity receipt must prove state digest, backup/restore and no-data-loss checks");
        }
      } catch { checks.push("data-integrity evidence is not valid JSON"); }
    }
    return checks.length === 0
      ? pass("release-supply-chain-evidence", "Candidate-bound SBOM, security scan and data-integrity evidence are complete", ["artifact evidence only; this does not prove a live Provider or production approval"])
      : blocking("release-supply-chain-evidence", "SBOM, security scan or data-integrity evidence is missing or failed closed", checks);
  } catch (error) {
    return blocking("release-supply-chain-evidence", "Candidate-bound SBOM, security scan and data-integrity evidence is required", [safeError(error)]);
  }
}

interface SupplyChainManifest {
  schemaVersion: "god-agent-release-supply-chain-v1";
  candidateRef: string;
  createdAt: string;
  releaseArtifactSha256: string;
  sbom: { path: string; sha256: string; format: "CycloneDX"; specVersion: "1.5"; componentCount: number };
  securityScan: { path: string; sha256: string; status: "passed"; scannedFiles: number; findingCount: 0 };
  dataIntegrity: { path: string; sha256: string; status: "passed"; stateDigestVerified: true; backupRestoreVerified: true; noDataLoss: true };
  claimBoundary: "supply-chain-evidence-only-not-production-approval";
}

function parseSupplyChainManifest(text: string): SupplyChainManifest {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("release supply-chain manifest is not valid JSON"); }
  if (!isRecord(value) || value.schemaVersion !== "god-agent-release-supply-chain-v1" || !nonBlank(value.candidateRef)
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
    || typeof value.releaseArtifactSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.releaseArtifactSha256)
    || value.claimBoundary !== "supply-chain-evidence-only-not-production-approval") throw new Error("release supply-chain manifest has invalid top-level fields");
  requireExactReleaseKeys(value, ["schemaVersion", "candidateRef", "createdAt", "releaseArtifactSha256", "sbom", "securityScan", "dataIntegrity", "claimBoundary"]);
  const sbom = requireRecord(value.sbom, "sbom");
  requireExactReleaseKeys(sbom, ["path", "sha256", "format", "specVersion", "componentCount"]);
  if (!validEvidenceRef(sbom) || sbom.format !== "CycloneDX" || sbom.specVersion !== "1.5" || typeof sbom.componentCount !== "number" || !Number.isInteger(sbom.componentCount) || sbom.componentCount < 0) throw new Error("SBOM evidence fields are incomplete");
  const securityScan = requireRecord(value.securityScan, "securityScan");
  requireExactReleaseKeys(securityScan, ["path", "sha256", "status", "scannedFiles", "findingCount"]);
  if (!validEvidenceRef(securityScan) || securityScan.status !== "passed" || typeof securityScan.scannedFiles !== "number" || !Number.isInteger(securityScan.scannedFiles) || securityScan.scannedFiles < 0 || securityScan.findingCount !== 0) throw new Error("security scan evidence fields are incomplete");
  const dataIntegrity = requireRecord(value.dataIntegrity, "dataIntegrity");
  requireExactReleaseKeys(dataIntegrity, ["path", "sha256", "status", "stateDigestVerified", "backupRestoreVerified", "noDataLoss"]);
  if (!validEvidenceRef(dataIntegrity) || dataIntegrity.status !== "passed" || dataIntegrity.stateDigestVerified !== true || dataIntegrity.backupRestoreVerified !== true || dataIntegrity.noDataLoss !== true) throw new Error("data-integrity evidence fields are incomplete");
  return value as unknown as SupplyChainManifest;
}

function validEvidenceRef(value: Record<string, unknown>): boolean {
  return typeof value.path === "string" && normalizedReleaseRelative(value.path) && typeof value.sha256 === "string" && /^[a-f0-9]{64}$/u.test(value.sha256);
}

async function verifySupplyEvidenceFile(root: string, path: string, expectedSha256: string, label: string): Promise<{ text?: string; errors: string[] }> {
  try {
    const absolute = await requireRegularReleaseFile(root, path, `${label} evidence`);
    const bytes = await readFile(absolute);
    const actual = createHash("sha256").update(bytes).digest("hex");
    return actual === expectedSha256 ? { text: bytes.toString("utf8"), errors: [] } : { errors: [`${label} evidence SHA-256 does not match manifest`] };
  } catch (error) { return { errors: [`${label}: ${safeError(error)}`] }; }
}

async function requireRegularReleaseFile(root: string, candidate: string, label: string): Promise<string> {
  if (!normalizedReleaseRelative(candidate)) throw new Error(`${label} must be a normalized workspace-relative path`);
  const absolute = resolve(root, candidate);
  const rel = relative(root, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${label} escapes workspace`);
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  return absolute;
}

function normalizedReleaseRelative(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0 || isAbsolute(value) || value.includes("\\")) return false;
  const normalized = posix.normalize(value);
  return normalized === value && value !== "." && value !== ".." && !value.startsWith("../");
}

function requireExactReleaseKeys(value: Record<string, unknown>, expected: string[]): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) throw new Error("release supply-chain manifest contains unknown or missing fields");
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function nonBlank(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

export function formatReleaseReadinessReport(report: ReleaseReadinessReport): string {
  const lines = [
    `Release readiness: ${report.status}`,
    "Scope: local structural checks only; not proof of a clean-machine install, signed artifact, live Provider, or production approval.",
    `Checks: ${report.counts.pass} pass, ${report.counts.info} info, ${report.counts.warning} warning, ${report.counts.blocking} blocking`,
  ];
  for (const check of report.checks) {
    lines.push(`- [${check.level.toUpperCase()}] ${check.id}: ${check.summary}`);
    for (const detail of check.details) lines.push(`  - ${detail}`);
  }
  return `${lines.join("\n")}\n`;
}

function parsePackageMetadata(text: string | undefined, checks: ReadinessCheck[]): PackageMetadata | undefined {
  if (text === undefined) {
    checks.push(blocking("package-readable", "package.json is missing", []));
    return undefined;
  }
  try {
    return JSON.parse(text) as PackageMetadata;
  } catch {
    checks.push(blocking("package-readable", "package.json is not valid JSON", []));
    return undefined;
  }
}

async function checkPackageMetadata(root: string, packageJson: PackageMetadata | undefined): Promise<ReadinessCheck[]> {
  if (packageJson === undefined) return [];
  const missing: string[] = [];
  if (typeof packageJson.name !== "string" || packageJson.name.trim().length === 0) missing.push("name");
  if (typeof packageJson.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(packageJson.version)) missing.push("valid semver version");
  if (typeof packageJson.description !== "string" || packageJson.description.trim().length < 20) missing.push("meaningful description");
  if (typeof packageJson.license !== "string" || packageJson.license.trim().length === 0 || packageJson.license === "UNLICENSED") missing.push("publishable license metadata");
  if (typeof packageJson.main !== "string" || packageJson.main.length === 0) missing.push("main");
  if (packageJson.bin === undefined) missing.push("bin");
  const checks: ReadinessCheck[] = [missing.length === 0
    ? pass("package-metadata", "Required package metadata is present", [])
    : blocking("package-metadata", "Required package metadata is incomplete", missing)];
  const optional: string[] = [];
  if (typeof packageJson.author !== "string" || packageJson.author.trim().length === 0) optional.push("author is empty");
  if (packageJson.repository === undefined) optional.push("repository metadata is absent");
  try {
    const sbom = await generateCycloneDxSbom(root);
    const missingLicenseEvidence = sbom.components
      .filter((component) => component.licenses === undefined)
      .map((component) => `${component.name}@${component.version}`);
    if (missingLicenseEvidence.length > 0) {
      optional.push(`${missingLicenseEvidence.length}/${sbom.components.length} locked components have no license evidence`);
    }
  } catch (error) {
    return [
      ...checks,
      blocking(
        "package-provenance",
        "Package/lockfile provenance is not reproducible",
        [safeError(error)],
      ),
    ];
  }
  checks.push(optional.length === 0
    ? pass("package-provenance", "Package metadata, lockfile and deterministic SBOM provenance are complete", [])
    : warning("package-provenance", "Package provenance metadata needs completion", optional));
  return checks;
}

function checkReleaseDocuments(
  readme: string | undefined,
  license: string | undefined,
  notice: string | undefined,
  packageJson: PackageMetadata | undefined,
): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [];
  if (readme === undefined) {
    checks.push(blocking("readme", "README.md is missing", []));
  } else {
    const missingSections = [
      !/Electron/u.test(readme) && "Electron capability",
      !/(?:Multi-Agent|多 Agent)/u.test(readme) && "multi-Agent capability",
      !/当前不应声称/u.test(readme) && "claim boundary",
    ].filter((item): item is string => typeof item === "string");
    checks.push(missingSections.length === 0
      ? pass("readme", "README describes the current product and claim boundary", [])
      : warning("readme", "README exists but release-facing sections are incomplete", missingSections));
  }
  const declaredLicense = typeof packageJson?.license === "string" ? packageJson.license : "unknown";
  checks.push(license === undefined
    ? blocking("license-file", `LICENSE is missing while package metadata declares ${declaredLicense}`, [])
    : pass("license-file", "LICENSE exists", []));
  checks.push(notice === undefined
    ? warning("notice-file", "NOTICE is absent; confirm attribution obligations before distribution", [])
    : pass("notice-file", "NOTICE exists", []));
  return checks;
}

function checkCiGate(ci: string | undefined): ReadinessCheck {
  if (ci === undefined) return blocking("ci-gate", "CI workflow is missing", []);
  const missing = REQUIRED_CI_COMMANDS.filter((command) => !ci.includes(command));
  if (missing.length > 0) return blocking("ci-gate", "CI omits required release gates", missing);
  return pass("ci-gate", "CI declares the required locked-install, test, reliability, and Electron gates", []);
}

async function checkTestDiscovery(
  root: string,
  packageJson: PackageMetadata | undefined,
  readme: string | undefined,
): Promise<ReadinessCheck> {
  if (packageJson?.scripts?.["test:discovery"] === undefined) {
    return blocking("test-discovery", "package scripts do not expose test:discovery", []);
  }
  const result = await verifyTestDiscovery(root);
  const details = [
    ...result.missingFromScripts.map((path) => `missing: ${path}`),
    ...result.staleScriptReferences.map((path) => `stale: ${path}`),
  ];
  const verificationBaseline = readme?.match(/## 当前验证基线(?<body>[\s\S]*?)(?=\n## |$)/u)?.groups?.body;
  const expectedDiscovery = `${result.discovered.length}/${result.discovered.length}`;
  if (verificationBaseline !== undefined && !verificationBaseline.includes(expectedDiscovery)) {
    details.push(`README current verification baseline must report test discovery ${expectedDiscovery}`);
  }
  if (await readOptional(resolve(root, "docs", "evidence", "current-evidence.json")) !== undefined) {
    try {
      await verifyEvidenceConsistency(root);
    } catch (error) {
      details.push(`evidence consistency: ${error instanceof Error ? error.message : "unknown verification failure"}`);
    }
  }
  return details.length === 0
    ? pass("test-discovery", `${result.discovered.length} formal test files are explicitly covered`, [])
    : blocking("test-discovery", "Formal tests are omitted or package scripts contain stale paths", details);
}

async function checkElectronBuild(root: string, packageJson: PackageMetadata | undefined): Promise<ReadinessCheck> {
  if (packageJson?.scripts?.["electron:build"] === undefined) {
    return blocking("electron-build", "electron:build package script is missing", []);
  }
  const required = [
    "dist/electron-app/electron/main.cjs",
    "dist/electron-app/electron/renderer/index.html",
  ];
  const missing: string[] = [];
  for (const path of required) {
    if (await readOptional(resolve(root, path)) === undefined) missing.push(path);
  }
  return missing.length === 0
    ? pass("electron-build", "Electron main and renderer build outputs exist", [])
    : blocking("electron-build", "Electron build outputs are missing; run the declared build gate", missing);
}

function checkProviderOfflineDefault(
  packageJson: PackageMetadata | undefined,
  ci: string | undefined,
  providerSource: string | undefined,
): ReadinessCheck {
  const details: string[] = [];
  const smokeCommand = packageJson?.scripts?.["provider:smoke"];
  if (smokeCommand === undefined) details.push("provider:smoke package script is missing");
  if (/PROVIDER_SMOKE_LIVE\s*(?:=|:)\s*["']?1/u.test(smokeCommand ?? "")) details.push("provider:smoke enables live mode by default");
  if (ci === undefined || !/PROVIDER_SMOKE_LIVE:\s*["']0["']/u.test(ci)) details.push("CI does not pin PROVIDER_SMOKE_LIVE to 0");
  if (providerSource === undefined || !/PROVIDER_SMOKE_LIVE\s*===\s*["']1["']/u.test(providerSource)) {
    details.push("Provider smoke source does not expose the explicit live opt-in check");
  }
  return details.length === 0
    ? pass("provider-offline-default", "Provider smoke and CI default to offline; live mode requires an explicit opt-in", [])
    : blocking("provider-offline-default", "Provider offline-by-default evidence is incomplete", details);
}

function checkSensitiveFileBlacklist(candidates: readonly string[]): ReadinessCheck {
  const sensitive = [...new Set(candidates.map((path) => path.replaceAll("\\", "/")))]
    .filter((path) => isSensitiveReleasePath(path))
    .sort();
  return sensitive.length === 0
    ? pass("sensitive-file-blacklist", "No sensitive local/config/state filename is a release candidate", [])
    : blocking("sensitive-file-blacklist", "Sensitive or local-state files are release candidates", sensitive);
}

function checkSecurityReport(report: SecurityScanReport): ReadinessCheck {
  const details = report.findings.map((item) => `${item.path}:${item.line} [${item.ruleId}]`);
  return report.status === "passed"
    ? pass("secret-scan", `No high-confidence credential found in ${report.scannedFiles} candidate text files`, [])
    : blocking("secret-scan", "High-confidence credential patterns were found", details);
}

function checkDependencyRisk(report: DependencyRiskReport): ReadinessCheck {
  if (!report.available) {
    return blocking(
      "dependency-risk",
      "Authoritative dependency audit is unavailable; risk gate fails closed",
      [`registry: ${report.registry}`, ...report.details],
    );
  }
  if (report.status === "passed") {
    return pass(
      "dependency-risk",
      "Authoritative npm audit reports 0 critical and 0 high vulnerabilities",
      [`registry: ${report.registry}`],
    );
  }
  return blocking(
    "dependency-risk",
    `Authoritative dependency risk gate is blocked: ${report.counts.critical} critical, ${report.counts.high} high`,
    [`registry: ${report.registry}`, ...report.details],
  );
}

function isSensitiveReleasePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  const name = normalized.split("/").at(-1)?.toLowerCase() ?? "";
  const isFrozenPublicLeaseArtifact = /^research\/artifacts\/v\d+\.\d+\/process-check\/runtime-leases\.json$/u.test(normalized);
  return /^\.env(?:\..*)?$/u.test(name)
    || /^(?:credentials?|secrets?|auth)(?:\..*)?$/u.test(name)
    || /^(?:runtime-state)\.json$/u.test(name)
    || (name === "runtime-leases.json" && !isFrozenPublicLeaseArtifact)
    || /\.(?:pem|key|p12|pfx)$/u.test(name)
    || /(?:^|[._-])local[._-]?(?:config|auth|secret)/u.test(name);
}

function finalize(checks: ReadinessCheck[]): ReleaseReadinessReport {
  const counts: Record<ReadinessLevel, number> = { pass: 0, info: 0, warning: 0, blocking: 0 };
  for (const check of checks) counts[check.level] += 1;
  const status = counts.blocking > 0 ? "BLOCKED" : counts.warning > 0 ? "CONDITIONAL" : "READY";
  return { status, checks, counts };
}

function pass(id: string, summary: string, details: string[]): ReadinessCheck {
  return { id, level: "pass", summary, details };
}

function warning(id: string, summary: string, details: string[]): ReadinessCheck {
  return { id, level: "warning", summary, details };
}

function blocking(id: string, summary: string, details: string[]): ReadinessCheck {
  return { id, level: "blocking", summary, details };
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    return undefined;
  }
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown package provenance verification failure";
}

async function main(): Promise<void> {
  const workspaceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const report = await evaluateReleaseReadiness(workspaceRoot);
  process.stdout.write(formatReleaseReadinessReport(report));
  if (report.status !== "READY") process.exitCode = 1;
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) await main();
