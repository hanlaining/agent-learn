import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const OFFICIAL_NPM_REGISTRY = "https://registry.npmjs.org/";

export interface DependencyRiskFinding {
  packageName: string;
  severity: "critical" | "high";
  advisoryUrls: string[];
  installedNodes: string[];
}

export interface DependencyRiskReport {
  schemaVersion: "god-agent-dependency-risk-v1";
  status: "passed" | "blocked";
  available: boolean;
  registry: typeof OFFICIAL_NPM_REGISTRY;
  counts: { critical: number; high: number };
  findings: DependencyRiskFinding[];
  details: string[];
}

export async function runAuthoritativeDependencyRiskGate(workspaceRoot: string): Promise<DependencyRiskReport> {
  const invocation = await resolveNpmInvocation();
  try {
    const { stdout } = await execFileAsync(
      invocation.executable,
      [...invocation.prefixArgs, "audit", "--json", `--registry=${OFFICIAL_NPM_REGISTRY}`],
      {
        cwd: path.resolve(workspaceRoot),
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 120_000,
        windowsHide: true,
      },
    );
    return evaluateNpmAuditReport(JSON.parse(String(stdout)));
  } catch (error) {
    const stdout = auditStdout(error);
    if (stdout !== undefined) {
      try {
        return evaluateNpmAuditReport(JSON.parse(stdout));
      } catch {
        return unavailable("Official npm audit returned invalid JSON");
      }
    }
    return unavailable(safeAuditError(error));
  }
}

export function evaluateNpmAuditReport(value: unknown): DependencyRiskReport {
  if (!isRecord(value)) return unavailable("Official npm audit report must be an object");
  if (!isRecord(value.metadata) || !isRecord(value.metadata.vulnerabilities)) {
    return unavailable("Official npm audit report is missing metadata.vulnerabilities");
  }
  const critical = requireCount(value.metadata.vulnerabilities.critical);
  const high = requireCount(value.metadata.vulnerabilities.high);
  if (critical === undefined || high === undefined) {
    return unavailable("Official npm audit severity counts are invalid");
  }
  const counts: { critical: number; high: number } = { critical, high };
  if (!isRecord(value.vulnerabilities)) {
    return unavailable("Official npm audit report is missing vulnerabilities");
  }
  const findings: DependencyRiskFinding[] = [];
  for (const [packageName, rawFinding] of Object.entries(value.vulnerabilities)) {
    if (!isRecord(rawFinding)) return unavailable(`Official npm audit finding is invalid: ${packageName}`);
    const severity = rawFinding.severity;
    if (severity !== "critical" && severity !== "high") continue;
    const advisoryUrls = Array.isArray(rawFinding.via)
      ? rawFinding.via
        .filter(isRecord)
        .map((item) => item.url)
        .filter((item): item is string => typeof item === "string" && /^https:\/\/(?:github\.com\/advisories\/|www\.npmjs\.com\/advisories\/)/u.test(item))
      : [];
    const installedNodes = Array.isArray(rawFinding.nodes)
      ? rawFinding.nodes.filter((item): item is string => typeof item === "string")
      : [];
    findings.push({
      packageName,
      severity,
      advisoryUrls: [...new Set(advisoryUrls)].sort(),
      installedNodes: [...new Set(installedNodes)].sort(),
    });
  }
  findings.sort((left, right) => left.packageName.localeCompare(right.packageName, "en"));
  const reportedBlocking = counts.critical + counts.high;
  if (reportedBlocking === 0 && findings.length === 0) {
    return {
      schemaVersion: "god-agent-dependency-risk-v1",
      status: "passed",
      available: true,
      registry: OFFICIAL_NPM_REGISTRY,
      counts,
      findings,
      details: [],
    };
  }
  if (reportedBlocking === 0 || findings.length === 0) {
    return unavailable("Official npm audit blocking counts and findings are inconsistent");
  }
  return {
    schemaVersion: "god-agent-dependency-risk-v1",
    status: "blocked",
    available: true,
    registry: OFFICIAL_NPM_REGISTRY,
    counts,
    findings,
    details: findings.map((finding) =>
      `${finding.packageName}: ${finding.severity}; ${finding.advisoryUrls.join(", ") || "advisory URL unavailable"}`),
  };
}

export function formatDependencyRiskReport(report: DependencyRiskReport): string {
  const lines = [
    `Dependency risk gate: ${report.status.toUpperCase()}`,
    `Registry: ${report.registry}`,
    report.available
      ? `Unresolved: ${report.counts.critical} critical, ${report.counts.high} high`
      : "Unresolved: unknown (authoritative audit unavailable)",
  ];
  for (const detail of report.details) lines.push(`- ${detail}`);
  return `${lines.join("\n")}\n`;
}

function unavailable(detail: string): DependencyRiskReport {
  return {
    schemaVersion: "god-agent-dependency-risk-v1",
    status: "blocked",
    available: false,
    registry: OFFICIAL_NPM_REGISTRY,
    counts: { critical: 0, high: 0 },
    findings: [],
    details: [`audit unavailable: ${detail}`],
  };
}

function auditStdout(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.stdout === "string" && error.stdout.trim().length > 0 ? error.stdout : undefined;
}

function safeAuditError(error: unknown): string {
  if (!(error instanceof Error)) return "unknown audit execution failure";
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  return code === undefined ? error.name : `${error.name} (${code})`;
}

function requireCount(value: unknown): number | undefined {
  return Number.isInteger(value) && typeof value === "number" && value >= 0 ? value : undefined;
}

async function resolveNpmInvocation(): Promise<{ executable: string; prefixArgs: string[] }> {
  if (process.platform !== "win32") return { executable: "npm", prefixArgs: [] };
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((item): item is string => typeof item === "string" && item.endsWith("npm-cli.js"));
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return { executable: process.execPath, prefixArgs: [candidate] };
    } catch {
      // Try the next deterministic npm CLI location.
    }
  }
  return { executable: "npm.cmd", prefixArgs: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function main(): Promise<void> {
  const workspaceRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const report = await runAuthoritativeDependencyRiskGate(workspaceRoot);
  process.stdout.write(formatDependencyRiskReport(report));
  if (report.status !== "passed") process.exitCode = 1;
}

const invokedPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) await main();
