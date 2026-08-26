import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  runProcessChaosGate40CaseHarness,
  runProcessChaosHarness,
  runProcessChaosEffectHelperSecurityProbe,
  runProcessChaosInvalidControlDirectoryProbe,
} from "../src/process-chaos-harness.js";
import { parseArguments as parseProcessChaosArguments } from "../src/process-chaos-cli.js";
import {
  PROCESS_CHAOS_GATE40_SEEDS,
  PROCESS_CHAOS_GATE40_WINDOWS,
  createProcessChaosGate40Manifest,
  processChaosGate40CaseId,
  runProcessChaosGate40Pilot,
  validateProcessChaosGate40Manifest,
} from "../src/process-chaos-gate40.js";
import {
  PROCESS_CHAOS_REPORT_SCHEMA_VERSION,
  PROCESS_CHAOS_FENCED_COMMIT_WINDOW_ID,
  PROCESS_CHAOS_MODEL_RESPONSE_COMMIT_WINDOW_ID,
  PROCESS_CHAOS_PROOF_COMMIT_WINDOW_ID,
  PROCESS_CHAOS_RECEIPT_COMMIT_WINDOW_ID,
  PROCESS_CHAOS_REPRO_COMMAND,
  PROCESS_CHAOS_RETURN_PERSISTED_WINDOW_ID,
  PROCESS_CHAOS_TOOL_EFFECT_RECEIPT_WINDOW_ID,
  PROCESS_CHAOS_WORKFLOW_STAGE_COMMIT_WINDOW_ID,
  PROCESS_CHAOS_WINDOW_ID,
  processChaosReproCommand,
  validateProcessChaosBoundaryReport,
  validateProcessChaosReport,
} from "../src/process-chaos-schema.js";
import { createProcessChaosLocalEffectTool } from "../../../src/tools/process-chaos-local-effect-tool.js";

test("Team Workflow Return 窄范围 E3 报告通过运行时校验和 JSON Schema", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "god-agent-process-chaos-gate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const seed = "rra-02-seed-1";
  const caseDirectory = path.join(directory, `process-chaos-${seed}`);
  const report = await runProcessChaosHarness(directory, seed);
  validateProcessChaosReport(report);

  const jsonSchema = JSON.parse(await readFile(
    path.resolve("research/runtime-e2e-benchmarks/schema/process-chaos-report.schema.json"),
    "utf8",
  )) as Record<string, unknown>;
  assert.deepEqual(collectJsonSchemaErrors(report, jsonSchema, jsonSchema), []);
  assert.equal(report.schemaVersion, PROCESS_CHAOS_REPORT_SCHEMA_VERSION);
  assert.equal(report.reproCommand, processChaosReproCommand(seed));
  assert.equal(report.statePath, "runtime-state.json");
  assert.equal(report.rawReportPath, "process-chaos-report.json");
  assert.deepEqual(report.experiment, {
    id: "team-workflow-return-narrow-e3-v1",
    scope: "Team Workflow Return",
    evidenceLevel: "narrow-E3",
    formalFaultWindowCount: 1,
    gate40CompletedWindows: 1,
    gate40TotalWindows: 40,
    completeE3Matrix: false,
    completeGate40: false,
    exactlyOnceClaimed: false,
    productionReadyClaimed: false,
  });
  assert.equal(report.windows.filter((item) => item.countsTowardGate40).length, 1);
  assert.equal(report.environment.provider.realApiCalls, false);
  assert.equal(report.environment.provider.credentialsRead, false);
  assert.equal(report.evidence.fakeProvider.finalDeliveryRequestsBeforeKill, 1);
  assert.equal(report.evidence.fakeProvider.finalDeliveryRequestsAfterRecovery, 1);
  assert.equal(
    Object.values(report.evidence.fakeProvider.requestsByStage).reduce((sum, count) => sum + count, 0),
    report.evidence.fakeProvider.totalRequests,
  );
  assert.equal(report.pidTransitions.every((item) => item.changed), true);
  assert.equal(report.pidTransitions.every((item) => !isProcessAlive(item.previousPid) && !isProcessAlive(item.successorPid)), true);
  await assert.rejects(access(path.join(caseDirectory, ".transient")));
  await access(path.join(caseDirectory, report.statePath));
  assert.deepEqual(JSON.parse(await readFile(path.join(caseDirectory, report.rawReportPath), "utf8")), report);

  const overclaim = structuredClone(report);
  overclaim.experiment.completeGate40 = true as false;
  assert.throws(() => validateProcessChaosReport(overclaim), /schema violation: experiment/u);
  const falseProviderCount = structuredClone(report);
  falseProviderCount.evidence.fakeProvider.totalRequests += 1;
  assert.throws(() => validateProcessChaosReport(falseProviderCount), /schema violation: evidence/u);

  const extraFieldMutations: Array<(value: Record<string, unknown>) => void> = [
    (value) => { value.unexpected = true; },
    (value) => { (value.experiment as Record<string, unknown>).unexpected = true; },
    (value) => {
      const environment = value.environment as Record<string, unknown>;
      (environment.provider as Record<string, unknown>).unexpected = true;
    },
    (value) => { (value.environment as Record<string, unknown>).unexpected = true; },
    (value) => {
      const transitions = value.pidTransitions as Array<Record<string, unknown>>;
      transitions[0]!.unexpected = true;
    },
    (value) => {
      const windows = value.windows as Array<Record<string, unknown>>;
      windows[1]!.unexpected = true;
    },
    (value) => {
      const evidence = value.evidence as Record<string, unknown>;
      (evidence.fakeProvider as Record<string, unknown>).unexpected = true;
    },
    (value) => { (value.evidence as Record<string, unknown>).unexpected = true; },
    (value) => {
      const evidence = value.evidence as Record<string, unknown>;
      (evidence.providerRequestsByStage as Record<string, unknown>).unexpected = 1;
    },
  ];
  for (const mutate of extraFieldMutations) {
    const invalid = structuredClone(report) as unknown as Record<string, unknown>;
    mutate(invalid);
    assert.throws(() => validateProcessChaosReport(invalid), /schema violation/u);
    assert.notDeepEqual(collectJsonSchemaErrors(invalid, jsonSchema, jsonSchema), []);
  }

  const unsafePaths = [
    { field: "statePath", value: path.resolve(caseDirectory, "runtime-state.json") },
    { field: "rawReportPath", value: "../process-chaos-report.json" },
    { field: "rawReportPath", value: "nested\\process-chaos-report.json" },
  ] as const;
  for (const unsafe of unsafePaths) {
    const invalid = structuredClone(report) as unknown as Record<string, unknown>;
    invalid[unsafe.field] = unsafe.value;
    assert.throws(() => validateProcessChaosReport(invalid), /schema violation: artifact-paths/u);
    assert.notDeepEqual(collectJsonSchemaErrors(invalid, jsonSchema, jsonSchema), []);
  }
});

test("Process Chaos CLI 失败返回非零并输出稳定复现命令", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "god-agent-process-chaos-cli-"));
  try {
    const result = await runChild([
      "--import", "tsx",
      "research/runtime-e2e-benchmarks/src/process-chaos-cli.ts",
      "--window", PROCESS_CHAOS_WINDOW_ID,
      "--seed", "unsafe seed",
      "--output", directory,
    ]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^\[process-chaos\] FAIL$/mu);
    assert.match(result.stderr, /Team Workflow Return local narrow E3 pilot/u);
    assert.match(result.stderr, /not complete E3, GATE-40, exactly-once, or production readiness/u);
    assert.match(result.stderr, /reproduce: npm exec -- tsx research\/runtime-e2e-benchmarks\/src\/process-chaos-cli\.ts/u);
    assert.match(result.stderr, new RegExp(escapeRegExp(`template: ${PROCESS_CHAOS_REPRO_COMMAND}`), "u"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Process Chaos CLI 严格接受八个已接线窗口且拒绝未知窗口", () => {
  for (const windowId of [
    PROCESS_CHAOS_MODEL_RESPONSE_COMMIT_WINDOW_ID,
    PROCESS_CHAOS_TOOL_EFFECT_RECEIPT_WINDOW_ID,
    PROCESS_CHAOS_WINDOW_ID,
    PROCESS_CHAOS_RETURN_PERSISTED_WINDOW_ID,
    PROCESS_CHAOS_FENCED_COMMIT_WINDOW_ID,
    PROCESS_CHAOS_WORKFLOW_STAGE_COMMIT_WINDOW_ID,
    PROCESS_CHAOS_RECEIPT_COMMIT_WINDOW_ID,
    PROCESS_CHAOS_PROOF_COMMIT_WINDOW_ID,
  ] as const) {
    assert.equal(parseProcessChaosArguments([
      "--window", windowId, "--seed", "cli-window", "--output", ".tmp/process-chaos-cli",
    ]).window, windowId);
  }
  assert.throws(() => parseProcessChaosArguments([
    "--window", "FW-UNKNOWN", "--seed", "blocked", "--output", ".tmp/process-chaos-cli",
  ]), /Usage:/u);
});

test("GATE-40 候选矩阵严格覆盖 8×5 且不重不漏，并 fail-closed 保持 NotVerified", async () => {
  const manifest = createProcessChaosGate40Manifest();
  validateProcessChaosGate40Manifest(manifest);
  assert.equal(manifest.cases.length, 40);
  assert.equal(new Set(manifest.cases.map((item) => item.caseId)).size, 40);
  assert.equal(new Set(manifest.cases.map((item) => `${item.windowId}/${item.seed}`)).size, 40);
  assert.deepEqual(
    manifest.cases.map((item) => item.caseId),
    PROCESS_CHAOS_GATE40_WINDOWS.flatMap((window) =>
      PROCESS_CHAOS_GATE40_SEEDS.map((seed) => processChaosGate40CaseId(window.id, seed))),
  );
  for (const window of PROCESS_CHAOS_GATE40_WINDOWS) {
    assert.deepEqual(
      manifest.cases.filter((item) => item.windowId === window.id).map((item) => item.seed),
      [...PROCESS_CHAOS_GATE40_SEEDS],
    );
  }
  assert.equal(manifest.cases.filter((item) => item.status === "not-run").length, 40);
  assert.equal(manifest.cases.filter((item) => item.status === "blocked").length, 0);
  assert.equal(manifest.formallyVerifiedCaseCount, 0);
  assert.equal(manifest.completeGate40, false);

  const jsonSchema = JSON.parse(await readFile(
    path.resolve("research/runtime-e2e-benchmarks/schema/process-chaos-gate40-manifest.schema.json"),
    "utf8",
  )) as Record<string, unknown>;
  assert.deepEqual(collectJsonSchemaErrors(manifest, jsonSchema, jsonSchema), []);

  const overclaim = structuredClone(manifest);
  overclaim.completeGate40 = true as false;
  assert.throws(() => validateProcessChaosGate40Manifest(overclaim), /claim-boundary/u);
  assert.notDeepEqual(collectJsonSchemaErrors(overclaim, jsonSchema, jsonSchema), []);

  const duplicate = structuredClone(manifest);
  duplicate.cases[1] = structuredClone(duplicate.cases[0]!);
  assert.throws(() => validateProcessChaosGate40Manifest(duplicate), /duplicate|identity|coverage/u);

  const missing = structuredClone(manifest) as unknown as Record<string, unknown>;
  delete missing.independentReview;
  assert.throws(() => validateProcessChaosGate40Manifest(missing), /root-fields/u);
  assert.notDeepEqual(collectJsonSchemaErrors(missing, jsonSchema, jsonSchema), []);
});

test("GATE-40 pilot 失败保留每个 runnable case 的最小复现报告，不把失败或 blocked 计为 Verified", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "god-agent-process-chaos-gate40-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const manifest = await runProcessChaosGate40Pilot(directory, async (_output, seed) => {
    throw new Error(`injected harness infrastructure failure for ${seed}`);
  });
  assert.equal(manifest.localPassedCaseCount, 0);
  assert.equal(manifest.localFailedCaseCount, 40);
  assert.equal(manifest.blockedCaseCount, 0);
  assert.equal(manifest.formallyVerifiedCaseCount, 0);
  assert.equal(manifest.completeGate40, false);
  for (const item of manifest.cases.filter((candidate) => candidate.status === "failed-local-pilot")) {
    assert.equal(item.oracleSatisfied, false);
    assert.ok(item.failureReportPath !== null);
    const failure = JSON.parse(await readFile(path.join(directory, item.failureReportPath), "utf8")) as Record<string, unknown>;
    assert.equal(failure.caseId, item.caseId);
    assert.equal(failure.windowId, item.windowId);
    assert.equal(failure.seed, item.seed);
    assert.equal(failure.oracleId, item.oracleId);
    assert.equal(failure.reproCommand, item.reproCommand);
    assert.match(String(failure.error), /injected harness infrastructure failure/u);
  }
  assert.deepEqual(
    JSON.parse(await readFile(path.join(directory, "process-chaos-gate40-pilot-manifest.json"), "utf8")),
    manifest,
  );
});

for (const windowId of [PROCESS_CHAOS_RETURN_PERSISTED_WINDOW_ID, PROCESS_CHAOS_FENCED_COMMIT_WINDOW_ID] as const) {
  test(`${windowId} 使用真实 App Server 子进程满足专用 Oracle`, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), `god-agent-${windowId.toLowerCase()}-`));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const seed = windowId === PROCESS_CHAOS_RETURN_PERSISTED_WINDOW_ID ? "w04-pilot" : "w05-pilot";
    const report = await runProcessChaosGate40CaseHarness(directory, seed, windowId);
    assert.equal(report.schemaVersion, "process-chaos-boundary-report-v1");
    validateProcessChaosBoundaryReport(report);
    const boundarySchema = JSON.parse(await readFile(
      path.resolve("research/runtime-e2e-benchmarks/schema/process-chaos-boundary-report.schema.json"),
      "utf8",
    )) as Record<string, unknown>;
    assert.deepEqual(collectJsonSchemaErrors(report, boundarySchema, boundarySchema), []);
    assert.equal(report.windowId, windowId);
    assert.equal(report.evidence.finalReturnAttempts, 1);
    assert.equal(report.evidence.finalDeliveryRequests, 1);
    assert.equal(report.evidence.returnGodCheckpointCount, 1);
    assert.equal(report.evidence.returnGodEvidenceCount, 1);
    assert.equal(isProcessAlive(report.pids.originalOwner), false);
    if (report.windowId === PROCESS_CHAOS_RETURN_PERSISTED_WINDOW_ID) {
      assert.equal(report.oracle.returnConsumedOnce, true);
      assert.equal(report.oracle.parentAdvancedOnce, true);
      assert.equal(report.oracle.repeatedAdvanceChangedState, false);
    } else {
      assert.ok(report.oracle.successorFencingToken > report.oracle.originalFencingToken);
      assert.match(report.oracle.staleCommitError, /fencing token mismatch/u);
      assert.equal(report.oracle.successorUniquelyCommitted, true);
      assert.equal(report.oracle.auditorReloadedAuthoritativeState, true);
    }
    const overclaim = structuredClone(report) as unknown as Record<string, unknown>;
    overclaim.completeGate40 = true;
    assert.throws(() => validateProcessChaosBoundaryReport(overclaim), /claim-boundary/u);
    assert.notDeepEqual(collectJsonSchemaErrors(overclaim, boundarySchema, boundarySchema), []);
    const unexpected = structuredClone(report) as unknown as Record<string, unknown>;
    unexpected.unexpected = true;
    assert.throws(() => validateProcessChaosBoundaryReport(unexpected), /root-fields/u);
    assert.notDeepEqual(collectJsonSchemaErrors(unexpected, boundarySchema, boundarySchema), []);
    const caseDirectory = path.join(directory, windowId, `process-chaos-${seed}`);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(caseDirectory, report.rawReportPath), "utf8")),
      report,
    );
    await assert.rejects(access(path.join(caseDirectory, ".transient")));
  });
}

for (const windowId of [
  PROCESS_CHAOS_MODEL_RESPONSE_COMMIT_WINDOW_ID,
  PROCESS_CHAOS_WORKFLOW_STAGE_COMMIT_WINDOW_ID,
] as const) {
  test(`${windowId} 使用真实 App Server 子进程恢复持久化结果且不重复提交`, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), `god-agent-${windowId.toLowerCase()}-`));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const seed = windowId === PROCESS_CHAOS_MODEL_RESPONSE_COMMIT_WINDOW_ID ? "w01-pilot" : "w06-pilot";
    const report = await runProcessChaosGate40CaseHarness(directory, seed, windowId);
    assert.equal(report.schemaVersion, "process-chaos-boundary-report-v1");
    validateProcessChaosBoundaryReport(report);
    const boundarySchema = JSON.parse(await readFile(
      path.resolve("research/runtime-e2e-benchmarks/schema/process-chaos-boundary-report.schema.json"),
      "utf8",
    )) as Record<string, unknown>;
    assert.deepEqual(collectJsonSchemaErrors(report, boundarySchema, boundarySchema), []);
    assert.equal(report.windowId, windowId);
    assert.equal(isProcessAlive(report.pids.originalOwner), false);
    assert.notEqual(report.pids.originalOwner, report.pids.successor);
    if (report.windowId === PROCESS_CHAOS_MODEL_RESPONSE_COMMIT_WINDOW_ID) {
      assert.equal(report.evidence.providerRequestsBeforeKill, 1);
      assert.equal(report.evidence.finalProviderRequests, 1);
      assert.equal(report.evidence.assistantMessageCount, 1);
      assert.equal(report.oracle.providerRequestNotRepeated, true);
      assert.equal(report.oracle.assistantCommittedOnce, true);
    } else {
      assert.equal(report.evidence.stageId, "product");
      assert.equal(report.evidence.productInvocationCount, 1);
      assert.equal(report.evidence.productCheckpointCount, 1);
      assert.equal(report.evidence.productEvidenceCount, 1);
      assert.equal(report.evidence.productReturnCount, 1);
      assert.equal(report.oracle.productModelInvocationNotRepeated, true);
      assert.equal(report.oracle.productStageCommittedOnce, true);
    }
    const falseOracle = structuredClone(report) as unknown as Record<string, unknown>;
    const oracle = falseOracle.oracle as Record<string, unknown>;
    const booleanKey = Object.keys(oracle).find((key) => key !== "id" && oracle[key] === true);
    assert.ok(booleanKey !== undefined);
    oracle[booleanKey] = false;
    assert.throws(() => validateProcessChaosBoundaryReport(falseOracle), /oracle/u);
    assert.notDeepEqual(collectJsonSchemaErrors(falseOracle, boundarySchema, boundarySchema), []);
    const unexpectedEvidence = structuredClone(report) as unknown as Record<string, unknown>;
    (unexpectedEvidence.evidence as Record<string, unknown>).unexpected = true;
    assert.throws(() => validateProcessChaosBoundaryReport(unexpectedEvidence), /evidence/u);
    assert.notDeepEqual(collectJsonSchemaErrors(unexpectedEvidence, boundarySchema, boundarySchema), []);
  });
}

for (const windowId of [
  PROCESS_CHAOS_TOOL_EFFECT_RECEIPT_WINDOW_ID,
  PROCESS_CHAOS_RECEIPT_COMMIT_WINDOW_ID,
  PROCESS_CHAOS_PROOF_COMMIT_WINDOW_ID,
] as const) {
  test(`${windowId} 使用独立 helper 子进程恢复文件副作用且只绑定一次`, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), `god-agent-${windowId.toLowerCase()}-`));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const seed = windowId === PROCESS_CHAOS_TOOL_EFFECT_RECEIPT_WINDOW_ID ? "w02-pilot" :
      windowId === PROCESS_CHAOS_RECEIPT_COMMIT_WINDOW_ID ? "w07-pilot" : "w08-pilot";
    const report = await runProcessChaosGate40CaseHarness(directory, seed, windowId);
    assert.equal(report.schemaVersion, "process-chaos-boundary-report-v1");
    validateProcessChaosBoundaryReport(report);
    const boundarySchema = JSON.parse(await readFile(
      path.resolve("research/runtime-e2e-benchmarks/schema/process-chaos-boundary-report.schema.json"),
      "utf8",
    )) as Record<string, unknown>;
    assert.deepEqual(collectJsonSchemaErrors(report, boundarySchema, boundarySchema), []);
    assert.equal(report.windowId, windowId);
    assert.equal(report.evidence.helperProcess, "real-child-process");
    assert.equal(report.evidence.effectApplyCount, 1);
    assert.equal(report.evidence.helperCreateRequests, 1);
    assert.equal(report.evidence.helperDuplicateCreateRequests, 0);
    assert.equal(report.evidence.targetToolResultCount, 1);
    assert.equal(report.evidence.assistantMessageCount, 1);
    assert.equal(isProcessAlive(report.evidence.helperPid), false);
    assert.equal(isProcessAlive(report.pids.originalOwner), false);
    assert.equal(isProcessAlive(report.pids.successor), false);
    if (report.windowId === PROCESS_CHAOS_TOOL_EFFECT_RECEIPT_WINDOW_ID) {
      assert.equal(report.evidence.persistedToolStatus, "executing");
      assert.equal(report.oracle.blindReplayAvoided, true);
      assert.equal(report.oracle.receiptRecovered, true);
    } else if (report.windowId === PROCESS_CHAOS_RECEIPT_COMMIT_WINDOW_ID) {
      assert.equal(report.evidence.persistedToolStatus, "result_received");
      assert.equal(report.oracle.successorBoundPersistedReceipt, true);
    } else {
      assert.equal(report.evidence.proofVerificationRequests, 1);
      assert.equal(report.evidence.toolInvocationCount, 2);
      assert.equal(report.oracle.proofDigestStable, true);
    }
    const invalid = structuredClone(report) as unknown as Record<string, unknown>;
    (invalid.evidence as Record<string, unknown>).effectApplyCount = 2;
    assert.throws(() => validateProcessChaosBoundaryReport(invalid), /evidence/u);
    assert.notDeepEqual(collectJsonSchemaErrors(invalid, boundarySchema, boundarySchema), []);
    const falseOracle = structuredClone(report) as unknown as Record<string, unknown>;
    const oracle = falseOracle.oracle as Record<string, unknown>;
    const key = Object.keys(oracle).find((candidate) => candidate !== "id" && oracle[candidate] === true);
    assert.ok(key !== undefined);
    oracle[key] = false;
    assert.throws(() => validateProcessChaosBoundaryReport(falseOracle), /oracle/u);
    assert.notDeepEqual(collectJsonSchemaErrors(falseOracle, boundarySchema, boundarySchema), []);
  });
}

test("独立 effect helper 的重复调用、重启稳定性、冲突与篡改 Proof 均 fail-closed", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "god-agent-effect-helper-security-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await runProcessChaosEffectHelperSecurityProbe(directory, "helper-security");
  assert.equal(result.stableAfterRestart, true);
  assert.equal(result.duplicateReturnedSameEffect, true);
  assert.equal(result.conflictingPayloadRejected, true);
  assert.equal(result.validProofAccepted, true);
  assert.equal(result.tamperedProofRejected, true);
  assert.equal(result.finalEffectApplyCount, 1);
  assert.equal(result.helperPids.every((pid) => !isProcessAlive(pid)), true);
});

test("实验 Tool 对非 loopback URL、相对实验目录和缺失配置 fail-closed", () => {
  assert.throws(() => createProcessChaosLocalEffectTool({
    helperBaseUrl: "https://example.com:443",
    experimentDirectory: path.resolve(".tmp/effect-tool"),
  }), /loopback/u);
  assert.throws(() => createProcessChaosLocalEffectTool({
    helperBaseUrl: "http://127.0.0.1:12345",
    experimentDirectory: "relative-effect-tool",
  }), /absolute/u);
  assert.throws(() => createProcessChaosLocalEffectTool({
    helperBaseUrl: "http://localhost:12345",
    experimentDirectory: path.resolve(".tmp/effect-tool"),
  }), /loopback/u);
});

test("W01/W06 test-only fault injector 对相对控制目录 fail-closed", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "god-agent-process-chaos-invalid-control-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const failure = await runProcessChaosInvalidControlDirectoryProbe(directory, "invalid-control-pilot");
  assert.match(failure, /Process Chaos test-only control directory must be absolute/u);
});

async function runChild(arguments_: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, arguments_, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { code, stdout, stderr };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function collectJsonSchemaErrors(
  value: unknown,
  schema: Record<string, unknown>,
  root: Record<string, unknown>,
  location = "$",
): string[] {
  if (typeof schema.$ref === "string") {
    const target = resolveLocalRef(root, schema.$ref);
    return target === undefined ? [`${location}: unresolved ${schema.$ref}`] : collectJsonSchemaErrors(value, target, root, location);
  }
  const errors: string[] = [];
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((candidate) => isRecord(candidate) &&
      collectJsonSchemaErrors(value, candidate, root, location).length === 0).length;
    if (matches !== 1) errors.push(`${location}: oneOf`);
  }
  if (Array.isArray(schema.allOf)) {
    for (const candidate of schema.allOf) {
      if (isRecord(candidate)) errors.push(...collectJsonSchemaErrors(value, candidate, root, location));
    }
  }
  if (isRecord(schema.if) && isRecord(schema.then) &&
    collectJsonSchemaErrors(value, schema.if, root, location).length === 0) {
    errors.push(...collectJsonSchemaErrors(value, schema.then, root, location));
  }
  if ("const" in schema && !deepEqual(value, schema.const)) errors.push(`${location}: const`);
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => deepEqual(value, item))) errors.push(`${location}: enum`);
  if (typeof schema.type === "string" && !matchesType(value, schema.type)) errors.push(`${location}: type`);
  if (errors.length > 0) return errors;

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) errors.push(`${location}: minLength`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) errors.push(`${location}: pattern`);
    if (schema.format === "date-time" && !Number.isFinite(Date.parse(value))) errors.push(`${location}: date-time`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${location}: minimum`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${location}: maximum`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${location}: minItems`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(`${location}: maxItems`);
    if (isRecord(schema.items)) {
      value.forEach((item, index) => errors.push(...collectJsonSchemaErrors(item, schema.items as Record<string, unknown>, root, `${location}[${index}]`)));
    }
    if (isRecord(schema.contains)) {
      const matches = value.filter((item, index) => collectJsonSchemaErrors(item, schema.contains as Record<string, unknown>, root, `${location}[${index}]`).length === 0).length;
      if (typeof schema.minContains === "number" && matches < schema.minContains) errors.push(`${location}: minContains`);
      if (typeof schema.maxContains === "number" && matches > schema.maxContains) errors.push(`${location}: maxContains`);
    }
  }
  if (isRecord(value)) {
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
    for (const key of required) if (!(key in value)) errors.push(`${location}.${key}: required`);
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [key, item] of Object.entries(value)) {
      const propertySchema = properties[key];
      if (isRecord(propertySchema)) errors.push(...collectJsonSchemaErrors(item, propertySchema, root, `${location}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${location}.${key}: additionalProperty`);
    }
  }
  return errors;
}

function resolveLocalRef(root: Record<string, unknown>, reference: string): Record<string, unknown> | undefined {
  if (!reference.startsWith("#/")) return undefined;
  let current: unknown = root;
  for (const segment of reference.slice(2).split("/")) {
    if (!isRecord(current)) return undefined;
    current = current[segment.replaceAll("~1", "/").replaceAll("~0", "~")];
  }
  return isRecord(current) ? current : undefined;
}

function matchesType(value: unknown, type: string): boolean {
  if (type === "object") return isRecord(value);
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return Number.isSafeInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  return true;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
