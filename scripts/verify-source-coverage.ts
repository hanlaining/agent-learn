import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface CoverageRow {
  file: string;
  linePercent: number;
  branchPercent: number;
  functionPercent: number;
  uncoveredLines: string;
}

export interface CoverageThresholds {
  linePercent: number;
  loadedFilePercent: number;
}

export interface SourceCoverageSummary {
  schemaVersion: 1;
  nodeVersion: string;
  sourceScope: "src/**/*.ts";
  testFileCount: number;
  sourceFiles: {
    total: number;
    loaded: number;
    unloaded: string[];
    loadedPercent: number;
  };
  lines: {
    covered: number;
    total: number;
    percent: number;
  };
  loadedFileMeans: {
    linePercent: number;
    branchPercent: number;
    functionPercent: number;
  };
}

export interface CoverageGateResult {
  summary: SourceCoverageSummary;
  thresholds: CoverageThresholds;
  failures: string[];
  passed: boolean;
}

interface PackageJson {
  scripts?: Record<string, string>;
}

export interface ChildProcessResult {
  stdout: string;
  stderr: string;
}

// Measured twice on Node 20.19.0 from the 87-file main test collection on
// 2026-08-24: the lower sample was 90.7946% exact source lines and both loaded
// 93.2773% of source files. The thresholds lock a conservative floor without
// presenting the result as 95% coverage.
export const DEFAULT_THRESHOLDS: CoverageThresholds = {
  linePercent: 90.25,
  loadedFilePercent: 93,
};

const COVERAGE_START = "start of coverage report";
const COVERAGE_END = "end of coverage report";
const TEST_FILE_REFERENCE = /(?:^|\s)(tests[\\/][^\s"'&|;]+-test\.ts)(?=\s|$)/gu;

export function extractMainTestFiles(testCommand: string): string[] {
  const files = [...testCommand.matchAll(TEST_FILE_REFERENCE)].map((match) => normalizeSlashes(match[1] ?? ""));
  return [...new Set(files)];
}

export function parseCoverageReport(output: string): CoverageRow[] {
  const lines = output.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.includes(COVERAGE_START));
  const end = lines.findIndex((line, index) => index > start && line.includes(COVERAGE_END));
  if (start < 0 || end < 0) throw new Error("Node coverage report markers are missing");

  const rows: CoverageRow[] = [];
  for (const originalLine of lines.slice(start + 1, end)) {
    const line = originalLine.replace(/^\s*#\s?/u, "").trim();
    if (!line.includes("|") || line.startsWith("file ") || line.startsWith("-") || line.startsWith("all files")) continue;
    const columns = line.split("|").map((column) => column.trim());
    if (columns.length !== 5) throw new Error(`Malformed Node coverage row: ${line}`);
    const [file, lineValue, branchValue, functionValue, uncoveredLines] = columns;
    if (file === undefined || lineValue === undefined || branchValue === undefined || functionValue === undefined) {
      throw new Error(`Incomplete Node coverage row: ${line}`);
    }
    rows.push({
      file,
      linePercent: parsePercent(lineValue, "line", file),
      branchPercent: parsePercent(branchValue, "branch", file),
      functionPercent: parsePercent(functionValue, "function", file),
      uncoveredLines: uncoveredLines ?? "",
    });
  }
  if (rows.length === 0) throw new Error("Node coverage report contains no file rows");
  return rows;
}

export async function discoverSourceFiles(workspaceRoot: string): Promise<string[]> {
  return walkTypeScriptFiles(path.resolve(workspaceRoot, "src"), workspaceRoot);
}

export async function summarizeSourceCoverage(
  workspaceRoot: string,
  rows: CoverageRow[],
  testFileCount = 0,
): Promise<SourceCoverageSummary> {
  const sourceFiles = await discoverSourceFiles(workspaceRoot);
  if (sourceFiles.length === 0) throw new Error("No src/**/*.ts files were found");
  const sourceSet = new Set(sourceFiles.map(pathKey));
  const sourceRows = new Map<string, CoverageRow>();

  for (const row of rows) {
    const relativeFile = coveragePathToSourceFile(row.file, workspaceRoot);
    if (relativeFile === undefined || !sourceSet.has(pathKey(relativeFile))) continue;
    const key = pathKey(relativeFile);
    if (sourceRows.has(key)) throw new Error(`Duplicate source coverage row: ${relativeFile}`);
    sourceRows.set(key, row);
  }

  let totalLines = 0;
  let coveredLines = 0;
  const loadedRows: CoverageRow[] = [];
  const unloaded: string[] = [];
  for (const relativeFile of sourceFiles) {
    const content = await readFile(path.resolve(workspaceRoot, relativeFile), "utf8");
    const lineCount = physicalLineCount(content);
    totalLines += lineCount;
    const row = sourceRows.get(pathKey(relativeFile));
    if (row === undefined) {
      unloaded.push(relativeFile);
      continue;
    }
    const uncovered = parseUncoveredLineCount(row.uncoveredLines, lineCount, relativeFile);
    const calculatedPercent = percent(lineCount - uncovered, lineCount);
    if (Math.abs(calculatedPercent - row.linePercent) >= 0.011) {
      throw new Error(
        `Coverage line count disagrees with Node for ${relativeFile}: calculated ${calculatedPercent.toFixed(2)}%, reported ${row.linePercent.toFixed(2)}%`,
      );
    }
    coveredLines += lineCount - uncovered;
    loadedRows.push(row);
  }

  return {
    schemaVersion: 1,
    nodeVersion: process.version,
    sourceScope: "src/**/*.ts",
    testFileCount,
    sourceFiles: {
      total: sourceFiles.length,
      loaded: loadedRows.length,
      unloaded,
      loadedPercent: percent(loadedRows.length, sourceFiles.length),
    },
    lines: {
      covered: coveredLines,
      total: totalLines,
      percent: percent(coveredLines, totalLines),
    },
    loadedFileMeans: {
      linePercent: mean(loadedRows.map((row) => row.linePercent)),
      branchPercent: mean(loadedRows.map((row) => row.branchPercent)),
      functionPercent: mean(loadedRows.map((row) => row.functionPercent)),
    },
  };
}

export function evaluateCoverageGate(
  summary: SourceCoverageSummary,
  thresholds: CoverageThresholds,
): CoverageGateResult {
  validateThreshold(thresholds.linePercent, "linePercent");
  validateThreshold(thresholds.loadedFilePercent, "loadedFilePercent");
  const failures: string[] = [];
  if (summary.lines.percent < thresholds.linePercent) {
    failures.push(`source line coverage ${summary.lines.percent.toFixed(2)}% is below ${thresholds.linePercent.toFixed(2)}%`);
  }
  if (summary.sourceFiles.loadedPercent < thresholds.loadedFilePercent) {
    failures.push(
      `loaded source files ${summary.sourceFiles.loadedPercent.toFixed(2)}% is below ${thresholds.loadedFilePercent.toFixed(2)}%`,
    );
  }
  return { summary, thresholds, failures, passed: failures.length === 0 };
}

export async function runChildProcess(
  executable: string,
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ChildProcessResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, { cwd, env: environment, shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", rejectPromise);
    child.on("close", (code, signal) => {
      if (code !== 0) {
        const suffix = signal === null ? `exit code ${String(code)}` : `signal ${signal}`;
        const details = childFailureDetails(stdout, stderr);
        rejectPromise(new Error(`Coverage test subprocess failed with ${suffix}${details === "" ? "" : `:\n${details}`}`));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

export async function runSourceCoverageGate(
  workspaceRoot: string,
  thresholds: CoverageThresholds = DEFAULT_THRESHOLDS,
): Promise<CoverageGateResult> {
  const packageJson = JSON.parse(await readFile(path.resolve(workspaceRoot, "package.json"), "utf8")) as PackageJson;
  const testCommand = packageJson.scripts?.test;
  if (testCommand === undefined) throw new Error("package.json scripts.test is missing");
  const testFiles = extractMainTestFiles(testCommand);
  if (testFiles.length === 0) throw new Error("package.json scripts.test has no explicit *-test.ts files");
  for (const testFile of testFiles) await readFile(path.resolve(workspaceRoot, testFile));

  const result = await runChildProcess(
    process.execPath,
    ["--import", "tsx", "--test", "--experimental-test-coverage", ...testFiles],
    workspaceRoot,
  );
  const rows = parseCoverageReport(`${result.stdout}\n${result.stderr}`);
  const summary = await summarizeSourceCoverage(workspaceRoot, rows, testFiles.length);
  return evaluateCoverageGate(summary, thresholds);
}

function coveragePathToSourceFile(reportedPath: string, workspaceRoot: string): string | undefined {
  let absolutePath: string;
  try {
    absolutePath = reportedPath.startsWith("file:")
      ? fileURLToPath(reportedPath)
      : path.resolve(workspaceRoot, reportedPath.replaceAll("\\", path.sep));
  } catch {
    return undefined;
  }
  const relativeFile = normalizeSlashes(path.relative(workspaceRoot, absolutePath));
  if (relativeFile.startsWith("../") || path.isAbsolute(relativeFile)) return undefined;
  if (!relativeFile.startsWith("src/") || !relativeFile.endsWith(".ts")) return undefined;
  return relativeFile;
}

async function walkTypeScriptFiles(directory: string, workspaceRoot: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolutePath = path.resolve(directory, entry.name);
    if (entry.isDirectory()) return walkTypeScriptFiles(absolutePath, workspaceRoot);
    if (!entry.isFile() || !entry.name.endsWith(".ts")) return [];
    return [normalizeSlashes(path.relative(workspaceRoot, absolutePath))];
  }));
  return nested.flat().sort();
}

function parseUncoveredLineCount(specification: string, lineCount: number, file: string): number {
  if (specification.trim() === "") return 0;
  const uncovered = new Set<number>();
  for (const token of specification.trim().split(/[\s,]+/u)) {
    const match = /^(\d+)(?:-(\d+))?$/u.exec(token);
    if (match === null) throw new Error(`Invalid uncovered line token for ${file}: ${token}`);
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    if (start < 1 || end < start || end > lineCount) {
      throw new Error(`Uncovered line range is outside ${file}: ${token}`);
    }
    for (let line = start; line <= end; line += 1) uncovered.add(line);
  }
  return uncovered.size;
}

function physicalLineCount(content: string): number {
  if (content === "") return 0;
  const lines = content.split(/\r\n|\n|\r/u);
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
}

function parsePercent(value: string, metric: string, file: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(`Invalid ${metric} coverage for ${file}: ${value}`);
  }
  return parsed;
}

function validateThreshold(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error(`Invalid ${name} threshold: ${String(value)}`);
}

function percent(numerator: number, denominator: number): number {
  if (denominator === 0) return 100;
  return Number(((numerator / denominator) * 100).toFixed(4));
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4));
}

function normalizeSlashes(value: string): string {
  return value.replaceAll("\\", "/");
}

function pathKey(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function tail(value: string, maximumLength: number): string {
  const trimmed = value.trim();
  return trimmed.length <= maximumLength ? trimmed : trimmed.slice(-maximumLength);
}

function childFailureDetails(stdout: string, stderr: string): string {
  const lines = stdout.split(/\r?\n/u);
  const failureIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^not ok\s/u.test(line) || /^# fail\s/u.test(line))
    .map(({ index }) => index);
  const excerpts = failureIndexes.map((index) => lines.slice(index, index + 24).join("\n"));
  const combined = [...excerpts, stderr.trim()].filter((value) => value !== "").join("\n...\n");
  return combined === "" ? tail(stdout, 4_000) : tail(combined, 12_000);
}

async function main(): Promise<void> {
  const workspaceRoot = path.resolve(import.meta.dirname, "..");
  try {
    const result = await runSourceCoverageGate(workspaceRoot);
    process.stdout.write(`Source line coverage: ${result.summary.lines.percent.toFixed(2)}% (${result.summary.lines.covered}/${result.summary.lines.total})\n`);
    process.stdout.write(
      `Loaded source files: ${result.summary.sourceFiles.loadedPercent.toFixed(2)}% (${result.summary.sourceFiles.loaded}/${result.summary.sourceFiles.total})\n`,
    );
    process.stdout.write(`SOURCE_COVERAGE_SUMMARY=${JSON.stringify(result)}\n`);
    if (!result.passed) {
      process.stderr.write(`Coverage gate failed:\n${result.failures.map((failure) => `- ${failure}`).join("\n")}\n`);
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`Coverage gate error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) await main();
