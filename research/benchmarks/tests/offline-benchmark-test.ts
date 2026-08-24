import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildTaskManifest,
  createRunRecord,
  loadOfflineConfig,
  parseOfflineArgs,
  runOptionsFor,
  validateOfflineConfig,
  validateRunRecord,
  validateTaskManifest,
  DEFAULT_OFFLINE_CONFIG,
} from "../src/offline.js";
import { buildReport, writeReport } from "../src/runner.js";

test("统一入口解析 suite、config、seed、dry-run 和 output", () => {
  const options = parseOfflineArgs([
    "--suite", "gate30", "--config", "research/benchmarks/configs/offline-default.json",
    "--seed", "42", "--dry-run", "--output", "tmp/benchmark",
  ]);
  assert.equal(options.suite, "gate30");
  assert.equal(options.seed, 42);
  assert.equal(options.dryRun, true);
  assert.equal(path.isAbsolute(options.configPath), true);
  assert.equal(path.isAbsolute(options.outputDirectory!), true);
  assert.throws(() => parseOfflineArgs(["--suite", "unknown"]), /--suite/);
  assert.throws(() => parseOfflineArgs(["--suite", "gate30", "--seed", "-1"]), /--seed/);
});

test("默认配置与 GATE-30 manifest 通过校验并固定为 30 个任务", async () => {
  const config = await loadOfflineConfig(DEFAULT_OFFLINE_CONFIG);
  const manifest = await buildTaskManifest("gate30", config, 42);
  validateTaskManifest(manifest);
  assert.equal(manifest.seed, 42);
  assert.equal(manifest.taskCount, 30);
  assert.equal(manifest.executionCount, 120);
  assert.equal(new Set(manifest.tasks.map((item) => item.caseId)).size, 30);
});

test("配置、manifest 与 run-record 校验器拒绝不完整输入", () => {
  assert.throws(() => validateOfflineConfig({ schemaVersion: "offline-benchmark-config-v1" }), /schema violation/);
  assert.throws(() => validateTaskManifest({ schemaVersion: "offline-benchmark-task-manifest-v1" }), /schema violation/);
  assert.throws(() => validateRunRecord({ schemaVersion: "offline-benchmark-run-record-v1" }), /schema violation/);
});

test("seed 覆盖贯穿 manifest、report 和 run-record，产物可落盘", async () => {
  const config = await loadOfflineConfig(DEFAULT_OFFLINE_CONFIG);
  const manifest = await buildTaskManifest("gate30", config, 7);
  const report = await buildReport(runOptionsFor(manifest));
  const startedAt = new Date("2026-08-24T00:00:00.000Z");
  const finishedAt = new Date("2026-08-24T00:00:00.025Z");
  const record = createRunRecord({ suite: "gate30", config, manifest, report, startedAt, finishedAt });
  validateRunRecord(record, manifest, report);
  assert.equal(report.fixtureSeed, 7);
  assert.equal(record.seed, 7);
  assert.equal(record.executionCount, 120);
  assert.equal(record.durationMs, 25);

  const output = await mkdtemp(path.join(tmpdir(), "god-agent-offline-benchmark-"));
  try {
    await writeReport(report, output);
    const persisted: unknown = JSON.parse(await readFile(path.join(output, "report.json"), "utf8"));
    assert.equal((persisted as { fixtureSeed: number }).fixtureSeed, 7);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
