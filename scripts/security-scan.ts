import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MAX_TEXT_BYTES = 2 * 1024 * 1024;
const IGNORED_SEGMENTS = new Set([
  ".git",
  "node_modules",
  "dist",
  ".tmp",
  "coverage",
  ".agent-state",
  ".god-agent",
]);

interface SecretRule {
  id: string;
  description: string;
  pattern: RegExp;
  accept?: (match: RegExpExecArray) => boolean;
}

const SECRET_RULES: readonly SecretRule[] = [
  {
    id: "private-key-header",
    description: "Private key material header",
    pattern: /-{5}BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-{5}/gu,
  },
  {
    id: "bearer-credential",
    description: "Bearer credential with a high-confidence token length",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/gu,
  },
  {
    id: "openai-token",
    description: "OpenAI-style API token",
    pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/gu,
  },
  {
    id: "github-token",
    description: "GitHub personal or application token",
    pattern: /\bgh[pousr]_([A-Za-z0-9]{30,})\b/gu,
    accept: (match) => /[a-z]/u.test(match[1] ?? "") && /[A-Z]/u.test(match[1] ?? "") && /[0-9]/u.test(match[1] ?? ""),
  },
  {
    id: "slack-token",
    description: "Slack token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/gu,
  },
  {
    id: "aws-access-key",
    description: "AWS access key identifier",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
  },
  {
    id: "google-api-key",
    description: "Google API key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/gu,
  },
  {
    id: "generic-secret-assignment",
    description: "High-entropy credential assigned to a secret-bearing field",
    pattern: /\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|password)\s*[:=]\s*["']?([A-Za-z0-9._~+/=-]{24,})/giu,
    accept: (match) => isHighConfidenceCredential(match[1] ?? ""),
  },
] as const;

export interface SecurityFinding {
  path: string;
  ruleId: string;
  line: number;
  severity: "blocking";
}

export interface SecuritySkippedFile {
  path: string;
  reason: "binary" | "too_large" | "ignored" | "missing";
}

export interface SecurityScanReport {
  status: "passed" | "blocked";
  scannedFiles: number;
  candidateFiles: number;
  findings: SecurityFinding[];
  skippedFiles: SecuritySkippedFile[];
}

export class UnsafeCandidatePathError extends Error {
  constructor(path: string) {
    super(`Unsafe security-scan candidate path: ${sanitizePathForOutput(path)}`);
    this.name = "UnsafeCandidatePathError";
  }
}

export async function listVersionControlCandidates(workspaceRoot: string): Promise<string[]> {
  const root = resolve(workspaceRoot);
  const candidates: string[] = [];
  await collectFilesystemCandidates(root, "", candidates);
  return candidates.sort((left, right) => left.localeCompare(right, "en"));
}

export async function scanSecurityCandidates(
  workspaceRoot: string,
  candidates: readonly string[],
  maxTextBytes = DEFAULT_MAX_TEXT_BYTES,
): Promise<SecurityScanReport> {
  const root = resolve(workspaceRoot);
  const rootRealPath = await realpath(root);
  const findings: SecurityFinding[] = [];
  const skippedFiles: SecuritySkippedFile[] = [];
  let scannedFiles = 0;

  for (const rawCandidate of [...new Set(candidates.map(normalizePath))].sort()) {
    if (isIgnoredCandidate(rawCandidate)) {
      skippedFiles.push({ path: sanitizePathForOutput(rawCandidate), reason: "ignored" });
      continue;
    }
    const candidate = await resolveSafeCandidate(root, rootRealPath, rawCandidate);
    if (candidate === undefined) {
      skippedFiles.push({ path: sanitizePathForOutput(rawCandidate), reason: "missing" });
      continue;
    }
    const metadata = await stat(candidate.absolutePath);
    if (metadata.size > maxTextBytes) {
      skippedFiles.push({ path: candidate.displayPath, reason: "too_large" });
      continue;
    }
    const bytes = await readFile(candidate.absolutePath);
    const text = decodeText(bytes);
    if (text === undefined) {
      skippedFiles.push({ path: candidate.displayPath, reason: "binary" });
      continue;
    }
    scannedFiles += 1;
    findings.push(...scanText(candidate.displayPath, text));
  }

  findings.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line || left.ruleId.localeCompare(right.ruleId));
  return {
    status: findings.length === 0 ? "passed" : "blocked",
    scannedFiles,
    candidateFiles: new Set(candidates.map(normalizePath)).size,
    findings,
    skippedFiles,
  };
}

export async function runSecurityScan(workspaceRoot: string): Promise<SecurityScanReport> {
  return scanSecurityCandidates(workspaceRoot, await listVersionControlCandidates(workspaceRoot));
}

export function formatSecurityScanReport(report: SecurityScanReport): string {
  const lines = [
    `Security scan: ${report.status.toUpperCase()} (${report.scannedFiles}/${report.candidateFiles} candidate files scanned)`,
  ];
  for (const finding of report.findings) {
    lines.push(`- ${finding.path}:${finding.line} [${finding.ruleId}]`);
  }
  if (report.findings.length === 0) lines.push("- No high-confidence credential pattern found.");
  return `${lines.join("\n")}\n`;
}

function scanText(path: string, text: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    for (const rule of SECRET_RULES) {
      rule.pattern.lastIndex = 0;
      let match = rule.pattern.exec(line);
      while (match !== null) {
        if (rule.accept?.(match) ?? true) {
          findings.push({ path, ruleId: rule.id, line: index + 1, severity: "blocking" });
          break;
        }
        match = rule.pattern.exec(line);
      }
    }
  }
  return findings;
}

async function resolveSafeCandidate(
  root: string,
  rootRealPath: string,
  candidate: string,
): Promise<{ absolutePath: string; displayPath: string } | undefined> {
  if (candidate.length === 0 || isAbsolute(candidate) || candidate.split("/").includes("..")) {
    throw new UnsafeCandidatePathError(candidate);
  }
  const absolutePath = resolve(root, candidate);
  if (!isWithin(root, absolutePath)) throw new UnsafeCandidatePathError(candidate);
  let metadata;
  try {
    metadata = await lstat(absolutePath);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new UnsafeCandidatePathError(candidate);
  const candidateRealPath = await realpath(absolutePath);
  if (!isWithin(rootRealPath, candidateRealPath)) throw new UnsafeCandidatePathError(candidate);
  return { absolutePath, displayPath: sanitizePathForOutput(candidate) };
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function decodeText(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8192).includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function isIgnoredCandidate(path: string): boolean {
  const segments = normalizePath(path).split("/");
  if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) return true;
  return segments[0] === "reports" && segments[1] === "capacity";
}

async function collectFilesystemCandidates(
  root: string,
  relativeDirectory: string,
  candidates: string[],
): Promise<void> {
  const absoluteDirectory = relativeDirectory.length === 0 ? root : resolve(root, relativeDirectory);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const candidate = normalizePath(relativeDirectory.length === 0
      ? entry.name
      : `${relativeDirectory}/${entry.name}`);
    if (isIgnoredCandidate(candidate)) continue;
    if (entry.isDirectory()) {
      await collectFilesystemCandidates(root, candidate, candidates);
      continue;
    }
    // Include symbolic links and other non-directory entries. The scanner's
    // safe resolver rejects anything that is not a regular in-root file.
    candidates.push(candidate);
  }
}

function isHighConfidenceCredential(value: string): boolean {
  if (new Set(value).size < 10) return false;
  if (!/[0-9]/u.test(value)) return false;
  const classes = [/[a-z]/u, /[A-Z]/u, /[0-9]/u, /[^A-Za-z0-9]/u]
    .filter((pattern) => pattern.test(value)).length;
  return classes >= 3;
}

function sanitizePathForOutput(path: string): string {
  return normalizePath(path)
    .replace(/sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{12,}/giu, "[REDACTED-TOKEN]")
    .replace(/gh[pousr]_[A-Za-z0-9]{12,}/gu, "[REDACTED-TOKEN]");
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function main(): Promise<void> {
  const workspaceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const report = await runSecurityScan(workspaceRoot);
  process.stdout.write(formatSecurityScanReport(report));
  if (report.status === "blocked") process.exitCode = 1;
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) await main();
