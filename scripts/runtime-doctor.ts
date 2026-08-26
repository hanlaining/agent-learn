import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type RuntimeDoctorStatus = "pass" | "warn" | "fail";

export interface RuntimeDoctorCheck {
  id: "node" | "platform" | "files" | "dependencies" | "build" | "temp-write-cleanup" | "provider";
  status: RuntimeDoctorStatus;
  message: string;
  details: string[];
}

export interface RuntimeDoctorReport {
  schemaVersion: "god-agent-runtime-doctor-v1";
  ready: boolean;
  supportedRuntime: "node-20-win32";
  providerConfigured: boolean;
  checks: RuntimeDoctorCheck[];
  summary: { passed: number; warnings: number; failed: number };
}

export interface RuntimeDoctorOptions {
  rootDirectory?: string;
  nodeVersion?: string;
  platform?: NodeJS.Platform | string;
  environment?: object;
  tempDirectory?: string;
}

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const REQUIRED_FILES = [
  "package.json",
  "package-lock.json",
  "README.md",
  "LICENSE",
  "bin/god-agent.js",
] as const;
const REQUIRED_DEPENDENCIES = [
  "node_modules/electron/package.json",
  "node_modules/gpt-tokenizer/package.json",
  "node_modules/react/package.json",
  "node_modules/react-dom/package.json",
] as const;
const REQUIRED_BUILD_OUTPUTS = [
  "dist/electron-app/electron/main.cjs",
  "dist/electron-app/electron/renderer/index.html",
] as const;
const PROVIDER_VARIABLES = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"] as const;

export async function runRuntimeDoctor(options: RuntimeDoctorOptions = {}): Promise<RuntimeDoctorReport> {
  const root = path.resolve(options.rootDirectory ?? DEFAULT_ROOT);
  const environment = options.environment ?? process.env;
  const environmentNames = new Set(Object.getOwnPropertyNames(environment));
  const providerConfigured = environmentNames.has("OPENAI_API_KEY");
  const providerNames = PROVIDER_VARIABLES.filter((name) => environmentNames.has(name));
  const checks: RuntimeDoctorCheck[] = [
    checkNode(options.nodeVersion ?? process.versions.node),
    checkPlatform(options.platform ?? process.platform),
    await checkFiles(root, "files", REQUIRED_FILES),
    await checkFiles(root, "dependencies", REQUIRED_DEPENDENCIES),
    await checkFiles(root, "build", REQUIRED_BUILD_OUTPUTS),
    await checkTempWriteAndCleanup(options.tempDirectory ?? tmpdir()),
    {
      id: "provider",
      status: providerConfigured ? "pass" : "warn",
      message: providerConfigured
        ? "真实 Provider 配置名称已检测到；配置值未读取"
        : "未检测到 OPENAI_API_KEY；离线运行可用，真实 Provider 不可用",
      details: providerNames.map((name) => `${name}：名称存在（值未读取）`),
    },
  ];
  const summary = {
    passed: checks.filter((check) => check.status === "pass").length,
    warnings: checks.filter((check) => check.status === "warn").length,
    failed: checks.filter((check) => check.status === "fail").length,
  };
  return {
    schemaVersion: "god-agent-runtime-doctor-v1",
    ready: summary.failed === 0,
    supportedRuntime: "node-20-win32",
    providerConfigured,
    checks,
    summary,
  };
}

export function formatRuntimeDoctor(report: RuntimeDoctorReport): string {
  const lines = [
    "God-Agent Runtime Doctor",
    `生产运行前置条件：${report.ready ? "READY" : "BLOCKED"}`,
    `当前支持范围：${report.supportedRuntime}`,
  ];
  for (const check of report.checks) {
    lines.push(`[${check.status.toUpperCase()}] ${check.id}: ${check.message}`);
    for (const detail of check.details) lines.push(`  - ${detail}`);
  }
  lines.push(`汇总：${report.summary.passed} 通过，${report.summary.warnings} 警告，${report.summary.failed} 失败`);
  return `${lines.join("\n")}\n`;
}

function checkNode(version: string): RuntimeDoctorCheck {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(version);
  if (match === null) return fail("node", "无法识别 Node.js 版本；检查失败关闭", [version]);
  const major = Number(match[1]);
  return major === 20
    ? pass("node", `Node.js ${version} 位于已验证范围 >=20 <21`)
    : fail("node", `Node.js ${version} 超出已验证范围 >=20 <21`, []);
}

function checkPlatform(platform: string): RuntimeDoctorCheck {
  return platform === "win32"
    ? pass("platform", "Windows (win32) 位于当前支持范围")
    : fail("platform", `平台 ${platform} 尚未进入当前支持范围`, ["当前仅验证 win32"]);
}

async function checkFiles(
  root: string,
  id: "files" | "dependencies" | "build",
  relativePaths: readonly string[],
): Promise<RuntimeDoctorCheck> {
  const missing: string[] = [];
  for (const relativePath of relativePaths) {
    try {
      const info = await stat(path.join(root, ...relativePath.split("/")));
      if (!info.isFile()) missing.push(`${relativePath}（不是文件）`);
    } catch {
      missing.push(relativePath);
    }
  }
  if (missing.length > 0) return fail(id, `${label(id)}不完整`, missing);
  return pass(id, `${label(id)}完整`);
}

async function checkTempWriteAndCleanup(parentDirectory: string): Promise<RuntimeDoctorCheck> {
  let probeDirectory: string | undefined;
  try {
    const before = new Set(await readdir(parentDirectory));
    probeDirectory = await mkdtemp(path.join(parentDirectory, "god-agent-runtime-doctor-"));
    await writeFile(path.join(probeDirectory, "probe.txt"), "runtime-doctor-probe\n", "utf8");
    await rm(probeDirectory, { recursive: true });
    probeDirectory = undefined;
    const after = await readdir(parentDirectory);
    const unexpectedProbe = after.find((entry) => entry.startsWith("god-agent-runtime-doctor-") && !before.has(entry));
    if (unexpectedProbe !== undefined) {
      return fail("temp-write-cleanup", "临时目录写入成功但清理验证失败", [unexpectedProbe]);
    }
    return pass("temp-write-cleanup", "临时目录可写，探针已清理并复核");
  } catch (error) {
    return fail("temp-write-cleanup", "临时目录写入或清理失败", [safeError(error)]);
  } finally {
    if (probeDirectory !== undefined) {
      await rm(probeDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function label(id: "files" | "dependencies" | "build"): string {
  if (id === "files") return "关键仓库文件";
  if (id === "dependencies") return "运行依赖";
  return "Electron 构建产物";
}

function pass(id: RuntimeDoctorCheck["id"], message: string): RuntimeDoctorCheck {
  return { id, status: "pass", message, details: [] };
}

function fail(id: RuntimeDoctorCheck["id"], message: string, details: string[]): RuntimeDoctorCheck {
  return { id, status: "fail", message, details };
}

function safeError(error: unknown): string {
  if (!(error instanceof Error)) return "unknown error";
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  return code === undefined ? error.name : `${error.name} (${code})`;
}

function parseCliArgs(args: readonly string[]): { json: boolean } {
  let json = false;
  for (const arg of args) {
    if (arg === "--json") json = true;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write("Usage: npx --no-install tsx scripts/runtime-doctor.ts [--json]\n");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return { json };
}

async function main(): Promise<void> {
  const { json } = parseCliArgs(process.argv.slice(2));
  const report = await runRuntimeDoctor();
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : formatRuntimeDoctor(report));
  if (!report.ready) process.exitCode = 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === SCRIPT_PATH) await main();
