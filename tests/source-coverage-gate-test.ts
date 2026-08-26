import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  evaluateCoverageGate,
  extractMainTestFiles,
  parseCoverageReport,
  runChildProcess,
  summarizeSourceCoverage,
  type SourceCoverageSummary,
} from "../scripts/verify-source-coverage.js";

test("extracts the explicit package.json main test collection without shell execution", () => {
  const command = "tsx --test tests/a-test.ts tests/nested/b-test.ts tests/a-test.ts";
  assert.deepEqual(extractMainTestFiles(command), ["tests/a-test.ts", "tests/nested/b-test.ts"]);
});

test("parses Node 20 coverage rows and ignores the aggregate row", () => {
  const rows = parseCoverageReport(coverageReport([
    "src\\a.ts | 50.00 | 75.00 | 80.00 | 2",
    "tests\\a-test.ts | 100.00 | 100.00 | 100.00 | ",
    "all files | 75.00 | 87.50 | 90.00 |",
  ]));
  assert.deepEqual(rows, [
    { file: "src\\a.ts", linePercent: 50, branchPercent: 75, functionPercent: 80, uncoveredLines: "2" },
    { file: "tests\\a-test.ts", linePercent: 100, branchPercent: 100, functionPercent: 100, uncoveredLines: "" },
  ]);
  assert.throws(() => parseCoverageReport("TAP version 13\n1..0\n"), /markers are missing/u);
});

test("includes only repo src/**/*.ts and counts unreported source files as zero", async () => {
  const root = await createWorkspace();
  const rows = parseCoverageReport(coverageReport([
    "src\\a.ts | 50.00 | 75.00 | 80.00 | 2",
    "tests\\a-test.ts | 100.00 | 100.00 | 100.00 | ",
    "scripts\\helper.ts | 100.00 | 100.00 | 100.00 | ",
    "research\\analysis.ts | 100.00 | 100.00 | 100.00 | ",
    "src-fake\\outside.ts | 100.00 | 100.00 | 100.00 | ",
  ]));
  const summary = await summarizeSourceCoverage(root, rows, 2);
  assert.equal(summary.sourceFiles.total, 2);
  assert.equal(summary.sourceFiles.loaded, 1);
  assert.deepEqual(summary.sourceFiles.unloaded, ["src/nested/b.ts"]);
  assert.equal(summary.sourceFiles.loadedPercent, 50);
  assert.deepEqual(summary.lines, { covered: 1, total: 4, percent: 25 });
  assert.deepEqual(summary.loadedFileMeans, { linePercent: 50, branchPercent: 75, functionPercent: 80 });
});

test("fails closed when either the exact line or loaded-file threshold regresses", () => {
  const summary = sampleSummary();
  const passing = evaluateCoverageGate(summary, { linePercent: 25, loadedFilePercent: 50 });
  assert.equal(passing.passed, true);
  const failing = evaluateCoverageGate(summary, { linePercent: 25.01, loadedFilePercent: 50.01 });
  assert.equal(failing.passed, false);
  assert.equal(failing.failures.length, 2);
  assert.match(failing.failures[0] ?? "", /source line coverage/u);
  assert.match(failing.failures[1] ?? "", /loaded source files/u);
});

test("propagates a non-zero coverage test subprocess exit as a gate error", async () => {
  await assert.rejects(
    runChildProcess(process.execPath, ["-e", "process.stderr.write('fixture failure'); process.exit(7)"], process.cwd()),
    /exit code 7[\s\S]*fixture failure/u,
  );
});

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "god-agent-source-coverage-"));
  await mkdir(path.join(root, "src", "nested"), { recursive: true });
  await writeFile(path.join(root, "src", "a.ts"), "first\nsecond\n", "utf8");
  await writeFile(path.join(root, "src", "nested", "b.ts"), "first\nsecond\n", "utf8");
  return root;
}

function coverageReport(rows: string[]): string {
  return [
    "TAP version 13",
    "# start of coverage report",
    "# ----------------------------------------------------------------",
    "# file | line % | branch % | funcs % | uncovered lines",
    "# ----------------------------------------------------------------",
    ...rows.map((row) => `# ${row}`),
    "# ----------------------------------------------------------------",
    "# end of coverage report",
  ].join("\n");
}

function sampleSummary(): SourceCoverageSummary {
  return {
    schemaVersion: 1,
    nodeVersion: process.version,
    sourceScope: "src/**/*.ts",
    testFileCount: 2,
    sourceFiles: { total: 2, loaded: 1, unloaded: ["src/nested/b.ts"], loadedPercent: 50 },
    lines: { covered: 1, total: 4, percent: 25 },
    loadedFileMeans: { linePercent: 50, branchPercent: 75, functionPercent: 80 },
  };
}
