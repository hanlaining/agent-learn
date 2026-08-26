import { constants } from "node:fs";
import { access, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type DemoPreflightStatus = "pass" | "warn" | "fail";

export interface DemoPreflightCheck {
  id: "node" | "files" | "dependencies" | "electron-build" | "temp-write" | "provider";
  status: DemoPreflightStatus;
  message: string;
}

export interface DemoPreflightReport {
  schemaVersion: "god-agent-demo-preflight-v1";
  ready: boolean;
  offlineDemoReady: boolean;
  providerConfigured: boolean;
  checks: DemoPreflightCheck[];
  summary: {
    passed: number;
    warnings: number;
    failed: number;
  };
}

export interface DemoPreflightOptions {
  rootDirectory?: string;
  nodeVersion?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  tempDirectory?: string;
}

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const REQUIRED_FILES = [
  "package.json",
  "package-lock.json",
  "README.md",
  "bin/god-agent.js",
  "scripts/run-offline-benchmark.ts",
  "scripts/start-electron.mjs",
  "research/benchmarks/fixtures/gate-30.json",
] as const;
const REQUIRED_DEPENDENCIES = [
  "node_modules/tsx/package.json",
  "node_modules/typescript/package.json",
  "node_modules/electron/package.json",
] as const;
const ELECTRON_BUILD_FILES = [
  "dist/electron-app/electron/main.cjs",
  "dist/electron-app/electron/renderer/index.html",
] as const;

export async function runDemoPreflight(
  options: DemoPreflightOptions = {},
): Promise<DemoPreflightReport> {
  const rootDirectory = path.resolve(options.rootDirectory ?? DEFAULT_ROOT);
  const environment = options.environment ?? process.env;
  const checks: DemoPreflightCheck[] = [];

  checks.push(checkNodeVersion(options.nodeVersion ?? process.versions.node));
  checks.push(await checkPaths(rootDirectory, "files", REQUIRED_FILES, true));
  checks.push(await checkPaths(rootDirectory, "dependencies", REQUIRED_DEPENDENCIES, true));
  checks.push(await checkPaths(rootDirectory, "electron-build", ELECTRON_BUILD_FILES, false));
  checks.push(await checkWritableTemp(options.tempDirectory ?? tmpdir()));

  const providerConfigured = hasEnvironmentName(environment, "OPENAI_API_KEY");
  const providerDetails = ["OPENAI_BASE_URL", "OPENAI_MODEL"]
    .filter((name) => hasEnvironmentName(environment, name));
  checks.push({
    id: "provider",
    status: providerConfigured ? "pass" : "warn",
    message: providerConfigured
      ? `真实 Provider 的环境变量名已配置（值未读取、不会输出）${providerDetails.length === 0 ? "" : `；另检测到 ${providerDetails.join("、")} 变量名`}`
      : "未配置 OPENAI_API_KEY；离线 Demo 可继续，真实 Provider 轨道不可用",
  });

  const summary = {
    passed: checks.filter((item) => item.status === "pass").length,
    warnings: checks.filter((item) => item.status === "warn").length,
    failed: checks.filter((item) => item.status === "fail").length,
  };
  const ready = summary.failed === 0;
  return {
    schemaVersion: "god-agent-demo-preflight-v1",
    ready,
    offlineDemoReady: ready,
    providerConfigured,
    checks,
    summary,
  };
}

export function formatDemoPreflight(report: DemoPreflightReport): string {
  const marker: Record<DemoPreflightStatus, string> = {
    pass: "PASS",
    warn: "WARN",
    fail: "FAIL",
  };
  return [
    "God-Agent Demo Preflight",
    `离线演示：${report.offlineDemoReady ? "READY" : "NOT READY"}`,
    `真实 Provider：${report.providerConfigured ? "CONFIGURED（配置值未读取）" : "OPTIONAL / NOT CONFIGURED"}`,
    ...report.checks.map((item) => `[${marker[item.status]}] ${item.id}: ${item.message}`),
    `汇总：${report.summary.passed} 通过，${report.summary.warnings} 警告，${report.summary.failed} 失败`,
  ].join("\n");
}

function checkNodeVersion(version: string): DemoPreflightCheck {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) {
    return { id: "node", status: "fail", message: `无法识别 Node.js 版本格式：${version}` };
  }
  const major = Number(match[1]);
  return major >= 20
    ? { id: "node", status: "pass", message: `Node.js ${version}（满足演示基线 >= 20）` }
    : { id: "node", status: "fail", message: `Node.js ${version} 过旧；演示基线要求 >= 20` };
}

async function checkPaths(
  rootDirectory: string,
  id: "files" | "dependencies" | "electron-build",
  paths: readonly string[],
  required: boolean,
): Promise<DemoPreflightCheck> {
  const present = await Promise.all(paths.map(async (relativePath) => ({
    relativePath,
    exists: await pathExists(path.join(rootDirectory, relativePath)),
  })));
  const missing = present.filter((item) => !item.exists).map((item) => item.relativePath);
  if (missing.length === 0) {
    return {
      id,
      status: "pass",
      message: id === "electron-build"
        ? "Electron 演示构建已存在"
        : id === "dependencies"
          ? "本地 TypeScript、tsx 与 Electron 依赖已安装"
          : "关键仓库文件完整",
    };
  }
  return {
    id,
    status: required ? "fail" : "warn",
    message: required
      ? `缺少必需项：${missing.join("、")}`
      : `Electron 演示构建尚未就绪：${missing.join("、")}；可提前执行 npm run electron:build`,
  };
}

async function checkWritableTemp(tempDirectory: string): Promise<DemoPreflightCheck> {
  let probeDirectory: string | undefined;
  try {
    await access(tempDirectory, constants.W_OK);
    probeDirectory = await mkdtemp(path.join(tempDirectory, "god-agent-demo-preflight-"));
    await writeFile(path.join(probeDirectory, "probe.txt"), "offline-demo-write-probe\n", "utf8");
    return { id: "temp-write", status: "pass", message: "系统临时目录可写，验证文件已清理" };
  } catch {
    return { id: "temp-write", status: "fail", message: "系统临时目录不可写；离线报告与 Runtime 临时状态可能失败" };
  } finally {
    if (probeDirectory !== undefined) {
      await rm(probeDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function hasEnvironmentName(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(environment, name);
}

function parseCliArgs(args: readonly string[]): { json: boolean } {
  let json = false;
  for (const arg of args) {
    if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write("Usage: npx --no-install tsx scripts/demo-preflight.ts [--json]\n");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { json };
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const report = await runDemoPreflight();
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatDemoPreflight(report)}\n`);
  if (!report.ready) process.exitCode = 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  await main();
}
