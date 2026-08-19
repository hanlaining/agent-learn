import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { generateRuntimeE2eScenarios, loadRuntimeE2eFixture } from "../research/runtime-e2e-benchmarks/src/fixtures.js";
import { runProcessChaosHarness } from "../research/runtime-e2e-benchmarks/src/process-chaos-harness.js";
import {
  buildRuntimeE2eReport,
  deterministicProjection,
  writeRuntimeE2eReport,
} from "../research/runtime-e2e-benchmarks/src/runner.js";
import { validateRuntimeE2eReport } from "../research/runtime-e2e-benchmarks/src/schema.js";
import { RUNTIME_E2E_FAMILIES } from "../research/runtime-e2e-benchmarks/src/types.js";

let gate30: ReturnType<typeof buildRuntimeE2eReport> | undefined;
function gate30Report() {
  gate30 ??= buildRuntimeE2eReport({ gate: 30 });
  return gate30;
}

test("Runtime-E2E GATE-30 生成 30 条、六类生产机制各 5 条", async () => {
  const fixture = await loadRuntimeE2eFixture(30);
  const scenarios = generateRuntimeE2eScenarios(fixture);
  assert.equal(scenarios.length, 30);
  for (const family of RUNTIME_E2E_FAMILIES) {
    assert.equal(scenarios.filter((item) => item.family === family).length, 5);
  }
  assert.equal(new Set(scenarios.map((item) => item.caseId)).size, 30);
});

test("baseline 真实运行 30/30，并由生产状态不变量判定", async () => {
  const report = await gate30Report();
  validateRuntimeE2eReport(report);
  const baseline = report.cases.filter((item) => item.variant === "baseline");
  assert.equal(baseline.length, 30);
  assert.equal(baseline.every((item) => item.taskSuccess), true);
  assert.equal(baseline.every((item) => item.snapshotReloaded && item.stateFileWrites > 0 && item.stateFileLoads > 1), true);
  assert.equal(baseline.reduce((sum, item) => sum + item.duplicateModelCalls, 0), 0);
  assert.equal(baseline.reduce((sum, item) => sum + item.duplicateToolEffects, 0), 0);
  assert.equal(report.implementation.protocolSimulatorUsed, false);
  assert.equal(report.methodology.provider.realApiCalls, false);
  assert.equal(report.methodology.provider.credentialsRead, false);
});

test("消融连接真实机制：no-wal/no-recovery/no-lease 产生预期退化", async () => {
  const report = await gate30Report();
  const summaries = new Map(report.summaries.map((item) => [item.variant, item]));
  const baseline = summaries.get("baseline")!;
  const noWal = summaries.get("no-wal")!;
  const noRecovery = summaries.get("no-recovery")!;
  const noLease = summaries.get("no-lease")!;
  assert.ok(noWal.duplicateModelCalls > baseline.duplicateModelCalls);
  assert.ok(noWal.duplicateToolEffects > baseline.duplicateToolEffects);
  assert.ok(noRecovery.recoverySuccess.rate < baseline.recoverySuccess.rate);
  assert.ok(noLease.duplicateToolEffects > baseline.duplicateToolEffects);
  assert.ok(noWal.taskSuccess.rate < baseline.taskSuccess.rate);
  assert.ok(noRecovery.taskSuccess.rate < baseline.taskSuccess.rate);
  assert.ok(noLease.taskSuccess.rate < baseline.taskSuccess.rate);
});

test("固定 seed 的确定性结果复跑一致，同时保留真实墙钟字段", async () => {
  const options = { gate: 30 as const, variants: ["baseline" as const], caseId: "model-response-window-001" };
  const first = await buildRuntimeE2eReport(options);
  const second = await buildRuntimeE2eReport(options);
  assert.equal(deterministicProjection(first), deterministicProjection(second));
  assert.equal(first.cases[0]?.wallClockDurationMs !== undefined, true);
  assert.equal(first.summaries[0]?.wallClockMs.kind, "measured-local-wall-clock");
});

test("GATE-100 fixture 四分片不重不漏", async () => {
  const scenarios = generateRuntimeE2eScenarios(await loadRuntimeE2eFixture(100));
  const shards = Array.from({ length: 4 }, (_, shard) => scenarios
    .filter((item) => item.caseIndex % 4 === shard)
    .map((item) => item.caseIndex));
  const indexes = shards.flat();
  assert.equal(indexes.length, 100);
  assert.equal(new Set(indexes).size, 100);
  assert.deepEqual(indexes.toSorted((a, b) => a - b), Array.from({ length: 100 }, (_, index) => index));
});

test("schema 拒绝协议模拟器冒充、缺真实 JSON 证据和失败 baseline", async () => {
  const report = await buildRuntimeE2eReport({ gate: 30, variants: ["baseline"], caseId: "model-response-window-001" });
  const simulator = structuredClone(report) as unknown as Record<string, unknown>;
  (simulator.implementation as Record<string, unknown>).protocolSimulatorUsed = true;
  assert.throws(() => validateRuntimeE2eReport(simulator), /schema violation/);
  const noSnapshot = structuredClone(report);
  noSnapshot.cases[0]!.snapshotReloaded = false;
  assert.throws(() => validateRuntimeE2eReport(noSnapshot), /schema violation/);
  const fakePass = structuredClone(report);
  fakePass.cases[0]!.taskSuccess = false;
  assert.throws(() => validateRuntimeE2eReport(fakePass), /schema violation/);
});

test("失败用例写出 report/CSV 和可单条运行的最小 repro", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "runtime-e2e-output-test-"));
  try {
    const report = await buildRuntimeE2eReport({ gate: 30, variants: ["no-recovery"], caseId: "workflow-stage-001" });
    await writeRuntimeE2eReport(report, directory);
    for (const file of ["report.json", "summary.csv", "cases.csv", path.join("repro", "no-recovery-workflow-stage-001.json")]) {
      assert.ok((await readFile(path.join(directory, file), "utf8")).length > 0);
    }
    const repro = JSON.parse(await readFile(path.join(directory, "repro", "no-recovery-workflow-stage-001.json"), "utf8")) as { rerun: string };
    assert.match(repro.rerun, /--variant no-recovery --case workflow-stage-001/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("真实 App Server 子进程在无副作用与 Return 窗口强杀后可重启恢复", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "god-agent-process-chaos-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const report = await runProcessChaosHarness(directory, "gate40-seed-1");

  assert.equal(report.pidChangedAfterReload, true);
  assert.equal(report.pidChangedAfterOwnerKill, true);
  assert.equal(report.windows.length, 2);
  assert.ok(report.windows.every((window) => window.faultPointConfirmed && window.ownerKilled &&
    window.publicRpcReloaded && window.rawJsonReloaded && window.recovered));
  assert.equal(report.windows[1]?.leaseWaitObserved, true);
  assert.equal(report.evidence.finalJobStatus, "completed");
  assert.equal(report.evidence.finalReturnStatus, "consumed");
  assert.equal(report.evidence.providerRequestsByStage.return_god, 1);
  assert.deepEqual(JSON.parse(await readFile(report.rawReportPath, "utf8")), report);
});

test("Process Chaos timeout 在 resolve/reject/timeout 后均不遗留活动 timer", async () => {
  const harnessUrl = pathToFileURL(path.resolve(
    "research/runtime-e2e-benchmarks/src/process-chaos-harness.ts",
  )).href;
  const probe = [
    `import { withProcessChaosTimeout } from ${JSON.stringify(harnessUrl)};`,
    "await withProcessChaosTimeout(Promise.resolve('ok'), 30_000, 'resolve');",
    "const rejected = await withProcessChaosTimeout(Promise.reject(new Error('expected')), 30_000, 'reject').then(() => false, (error) => error.message === 'expected');",
    "if (!rejected) throw new Error('reject path was not preserved');",
    "const timedOut = await withProcessChaosTimeout(new Promise(() => undefined), 10, 'timeout').then(() => false, (error) => error.message === 'Timed out waiting for timeout');",
    "if (!timedOut) throw new Error('timeout path was not preserved');",
  ].join("\n");
  const startedAt = performance.now();
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", probe], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === undefined) resolve(); else reject(error);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("timeout probe retained a 30 second timer"));
    }, 5_000);
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => finish(code === 0 ? undefined : new Error(`timeout probe failed (${String(code)}): ${stderr}`)));
  });
  assert.ok(performance.now() - startedAt < 5_000);
});
