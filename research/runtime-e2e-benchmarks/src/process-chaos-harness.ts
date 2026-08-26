import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { release as osRelease } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { AppServerClient } from "../../../src/electron/app-server-client.js";
import { STAGE_RESULT_CONTRACT_VERSION } from "../../../src/execution/stage-contract.js";
import {
  PROCESS_CHAOS_BOUNDARY_REPORT_SCHEMA_VERSION,
  PROCESS_CHAOS_EXPERIMENT_ID,
  PROCESS_CHAOS_FENCED_COMMIT_WINDOW_ID,
  PROCESS_CHAOS_MODEL_RESPONSE_COMMIT_WINDOW_ID,
  PROCESS_CHAOS_PROOF_COMMIT_WINDOW_ID,
  PROCESS_CHAOS_RECEIPT_COMMIT_WINDOW_ID,
  PROCESS_CHAOS_REPORT_SCHEMA_VERSION,
  PROCESS_CHAOS_RETURN_PERSISTED_WINDOW_ID,
  PROCESS_CHAOS_TOOL_EFFECT_RECEIPT_WINDOW_ID,
  PROCESS_CHAOS_WORKFLOW_STAGE_COMMIT_WINDOW_ID,
  PROCESS_CHAOS_WINDOW_ID,
  processChaosPilotWindowId,
  processChaosReproCommand,
  processChaosWindowReproCommand,
  validateProcessChaosBoundaryReport,
  validateProcessChaosReport,
  type FakeProviderRequestCounts,
  type ProcessChaosBoundaryReport,
  type ProcessChaosPilotReport,
  type ProcessChaosRunnableWindowId,
  type ProcessChaosReport,
} from "./process-chaos-schema.js";

const LEASE_TTL_MS = 120_000;
const FINAL_DELIVERY_RESPONSE_TIMEOUT_MS = 30_000;
const PERSISTED_FAULT_POINT_TIMEOUT_MS = 45_000;
const SNAPSHOT_FALLBACK_POLL_MS = 250;
export type { ProcessChaosReport } from "./process-chaos-schema.js";

interface RuntimeSnapshot {
  version: number;
  lifecycle: {
    threads: Array<{ id: string }>;
    turns: Array<{ id: string; threadId: string; status: string }>;
    items: Array<{ id: string; turnId: string; type: string; content: unknown }>;
  };
  agentRuntime: {
    jobs: Array<{ id: string; threadId: string; status: string }>;
    returns: Array<{ id: string; jobId: string; childRunId: string; status: string; stageId?: string; stageAttempt?: number; attempts: number }>;
    stageCheckpoints?: Array<{ jobId: string; stageId: string; stageAttempt: number; status: string; idempotencyKey: string }>;
    evidence: Array<{ jobId: string; stageId?: string; idempotencyKey: string }>;
  };
  modelInvocations: {
    invocations: Array<{
      invocationId: string;
      threadId: string;
      turnId: string;
      status: string;
      jobId?: string;
      runId?: string;
      stageId?: string;
      stageAttempt?: number;
    }>;
  };
  toolInvocations: {
    invocations: Array<{
      toolInvocationId: string;
      modelInvocationId: string;
      callId: string;
      toolName: string;
      status: string;
      executionAttempts: number;
      result?: unknown;
    }>;
  };
}

interface LeaseSnapshot {
  version: number;
  entries: Array<{
    resourceType: string;
    resourceId: string;
    leaseVersion: number;
    fencingToken: number;
    ownerId?: string;
    expiresAt?: string;
  }>;
}

export async function runProcessChaosHarness(outputDirectory: string, seed: string): Promise<ProcessChaosReport> {
  assert.match(seed, /^[a-zA-Z0-9._-]+$/u, "seed must be filesystem-safe");
  const runStartedAt = new Date().toISOString();
  const caseDirectory = await prepareCaseDirectory(outputDirectory, seed);
  const stateFilePath = path.join(caseDirectory, "runtime-state.json");
  const leasePath = path.join(caseDirectory, "runtime-leases.json");
  const reportFilePath = path.join(caseDirectory, "process-chaos-report.json");
  const transientPath = path.join(caseDirectory, ".transient");
  const clockPath = path.join(transientPath, "clock-offset-ms.txt");
  const workspacePath = path.join(transientPath, "workspace");
  const plansPath = path.join(transientPath, "plans");
  const clients: AppServerClient[] = [];
  let provider: FakeResponsesServer | undefined;
  let operationError: unknown;

  try {
    await mkdir(transientPath, { recursive: true });
    await Promise.all([
      mkdir(workspacePath, { recursive: true }),
      mkdir(plansPath, { recursive: true }),
      writeFile(clockPath, "0\n", "utf8"),
    ]);
    provider = await FakeResponsesServer.start(seed);
    const activeProvider = provider;
    const createClient = () => {
      const client = new AppServerClient({
        command: process.execPath,
        args: [
          "--import", "tsx",
          "--import", pathToFileURL(path.resolve("research/runtime-e2e-benchmarks/src/process-chaos-clock.ts")).href,
          "src/app-server/main.ts",
        ],
        cwd: process.cwd(),
        env: createHarnessEnvironment({ statePath: stateFilePath, clockPath, workspacePath, plansPath, baseUrl: activeProvider.baseUrl }),
        // A hard kill can leave a real Runtime state-lock claim. Production waits
        // 30 seconds before proving the owning process dead and removing it.
        handshakeTimeoutMs: 60_000,
        shutdownTimeoutMs: 2_000,
      });
      clients.push(client);
      return client;
    };

    const owner = createClient();
    assert.equal((await owner.start()).state, "connected");
    const ownerPid = requirePid(owner);
    const thread = await owner.startThread();
    const stagedTurn = await owner.startTurn(thread.id, `seed=${seed}: persisted before any provider call`);
    const providerRequestsBeforeFirstKill = activeProvider.requestCount;
    assert.equal(providerRequestsBeforeFirstKill, 0);
    const beforeFirstKill = await readRuntimeSnapshot(stateFilePath);
    assert.ok(beforeFirstKill.lifecycle.turns.some((item) => item.id === stagedTurn.turn.id));
    await forceKill(ownerPid);

    const reload = createClient();
    assert.equal((await reload.start()).state, "connected");
    const reloadPid = requirePid(reload);
    assert.notEqual(reloadPid, ownerPid);
    const publicHistory = await reload.readThreadHistory(thread.id);
    const afterReload = await readRuntimeSnapshot(stateFilePath);
    assert.equal(publicHistory.messages[0]?.text, `seed=${seed}: persisted before any provider call`);
    assert.ok(afterReload.lifecycle.turns.some((item) => item.id === stagedTurn.turn.id));

    const planTurn = await reload.startTurn(thread.id, `seed=${seed}: prepare deterministic delivery plan`);
    await reload.runTurn(planTurn.turn.id);
    const requirement = await reload.getRequirement(thread.id);
    assert.ok(requirement !== undefined);
    await reload.confirmRequirement(requirement.id, requirement.revision, requirement.planArtifact.contentHash);

    const executionTurn = await reload.startTurn(thread.id, `seed=${seed}: execute confirmed plan`);
    // Register the persisted-state observer before execution. On Windows the
    // Runtime replaces the snapshot atomically, so starting after the provider
    // request can miss the first useful rename and then repeatedly parse a
    // multi-megabyte snapshot while the child is trying to persist the fault
    // point itself.
    const persistedFaultPoint = waitForRuntimeSnapshot(stateFilePath, (snapshot) =>
      snapshot.agentRuntime.returns.some((item) => item.stageId === "lead" && item.status === "delivering") &&
      snapshot.modelInvocations.invocations.some((item) => item.stageId === "return_god" && item.status === "response_received"));
    const execution = reload.runTurn(executionTurn.turn.id);
    const atReturnWindow = await Promise.race([
      Promise.all([activeProvider.waitForFinalDeliveryResponse(), persistedFaultPoint]).then(([, snapshot]) => snapshot),
      execution.then(
        () => Promise.reject(new Error("Execution completed before the Return fault point was observed")),
        (error: unknown) => Promise.reject(error),
      ),
    ]);
    const job = atReturnWindow.agentRuntime.jobs.find((item) => item.threadId === thread.id);
    assert.ok(job !== undefined);
    const returnEnvelope = atReturnWindow.agentRuntime.returns.find((item) => item.jobId === job.id && item.stageId === "lead");
    assert.ok(returnEnvelope !== undefined);
    const leaseAtKill = await readLeaseSnapshot(leasePath);
    const heldLease = leaseAtKill.entries.find((item) => item.resourceType === "job" && item.resourceId === job.id);
    if (heldLease?.ownerId === undefined || heldLease.expiresAt === undefined) {
      throw new Error("Return fault point has no persisted owner Lease");
    }
    assert.ok(heldLease.ownerId.includes(String(reloadPid)));
    const finalDeliveryRequestsBeforeKill = activeProvider.requestCountsByStage().return_god;
    assert.equal(finalDeliveryRequestsBeforeKill, 1);
    await forceKill(reloadPid);
    await assert.rejects(execution);

    const recovery = createClient();
    assert.equal((await recovery.start()).state, "connected");
    const recoveryPid = requirePid(recovery);
    assert.notEqual(recoveryPid, reloadPid);
    const recoveredRpc = asAgentRuntime(await recovery.getAgentRuntime(thread.id));
    const recoveredRaw = await readRuntimeSnapshot(stateFilePath);
    const recoveredReturn = recoveredRpc.returns.find((item) => item.id === returnEnvelope.id);
    assert.equal(recoveredReturn?.status, "ready");
    assert.equal(recoveredRaw.agentRuntime.returns.find((item) => item.id === returnEnvelope.id)?.status, "ready");

    const waiting = asAdvanceResult(await recovery.advanceFixedProduct(thread.id, "lead_return_ready"));
    assert.deepEqual(waiting, { stage: "lead_return_ready", changed: false });
    assert.equal(asAgentRuntime(await recovery.getAgentRuntime(thread.id)).job?.status, "waiting_returns");

    await writeFile(clockPath, `${LEASE_TTL_MS + 1_000}\n`, "utf8");
    const advanced = asAdvanceResult(await recovery.advanceFixedProduct(thread.id, "lead_return_ready"));
    assert.equal(advanced.changed, true);
    assert.equal(advanced.stage, "completed");
    const finalRpc = asAgentRuntime(await recovery.getAgentRuntime(thread.id));
    const finalRaw = await readRuntimeSnapshot(stateFilePath);
    const finalRawJob = finalRaw.agentRuntime.jobs.find((item) => item.id === job.id);
    const finalRawReturn = finalRaw.agentRuntime.returns.find((item) => item.id === returnEnvelope.id);
    assert.equal(finalRpc.job?.status, "completed");
    assert.equal(finalRpc.returns.find((item) => item.id === returnEnvelope.id)?.status, "consumed");
    assert.equal(finalRawJob?.status, "completed");
    assert.equal(finalRawReturn?.status, "consumed");
    const providerRequestsByStage = activeProvider.requestCountsByStage();
    assert.equal(providerRequestsByStage.return_god, 1);

    const report: ProcessChaosReport = {
      schemaVersion: PROCESS_CHAOS_REPORT_SCHEMA_VERSION,
      experiment: {
        id: PROCESS_CHAOS_EXPERIMENT_ID,
        scope: "Team Workflow Return",
        evidenceLevel: "narrow-E3",
        formalFaultWindowCount: 1,
        gate40CompletedWindows: 1,
        gate40TotalWindows: 40,
        completeE3Matrix: false,
        completeGate40: false,
        exactlyOnceClaimed: false,
        productionReadyClaimed: false,
      },
      runStartedAt,
      runCompletedAt: new Date().toISOString(),
      environment: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        osRelease: osRelease(),
        local: true,
        appServerProcess: "real-child-process",
        provider: {
          kind: "deterministic-loopback-fake",
          realApiCalls: false,
          credentialsRead: false,
        },
      },
      seed,
      productionEntry: "node --import tsx src/app-server/main.ts",
      reproCommand: processChaosReproCommand(seed),
      statePath: "runtime-state.json",
      rawReportPath: "process-chaos-report.json",
      ownerPid,
      reloadPid,
      recoveryPid,
      pidChangedAfterReload: ownerPid !== reloadPid,
      pidChangedAfterOwnerKill: reloadPid !== recoveryPid,
      pidTransitions: [
        {
          event: "reload-after-pre-provider-kill",
          previousPid: ownerPid,
          successorPid: reloadPid,
          changed: ownerPid !== reloadPid,
        },
        {
          event: "recovery-after-return-window-kill",
          previousPid: reloadPid,
          successorPid: recoveryPid,
          changed: reloadPid !== recoveryPid,
        },
      ],
      windows: [
        {
          name: "no-side-effect-after-turn-start",
          evidenceRole: "persistence-reload-precondition",
          countsTowardGate40: false,
          faultPoint: "turn-persisted-before-provider-request",
          recoveryResult: "state-reloaded-without-provider-request",
          faultPointConfirmed: providerRequestsBeforeFirstKill === 0 && beforeFirstKill.lifecycle.turns.some((item) => item.id === stagedTurn.turn.id),
          ownerKilled: true,
          publicRpcReloaded: publicHistory.messages.some((item) => item.text.includes(seed)),
          rawJsonReloaded: afterReload.lifecycle.turns.some((item) => item.id === stagedTurn.turn.id),
          leaseWaitObserved: false,
          recovered: true,
        },
        {
          name: "return-delivery-with-held-lease",
          evidenceRole: "team-workflow-return-fault-window",
          countsTowardGate40: true,
          faultPoint: "return-response-received-with-job-lease-held",
          recoveryResult: "lease-wait-then-return-consumed",
          faultPointConfirmed: returnEnvelope.status === "delivering" && heldLease.ownerId !== undefined,
          ownerKilled: true,
          publicRpcReloaded: recoveredReturn?.status === "ready",
          rawJsonReloaded: recoveredRaw.agentRuntime.returns.some((item) => item.id === returnEnvelope.id && item.status === "ready"),
          leaseWaitObserved: waiting.changed === false && waiting.stage === "lead_return_ready",
          recovered: finalRpc.job?.status === "completed" && finalRawJob?.status === "completed",
        },
      ],
      evidence: {
        threadId: thread.id,
        jobId: job.id,
        returnId: returnEnvelope.id,
        ownerLeaseId: heldLease.ownerId!,
        ownerLeaseDeadline: heldLease.expiresAt,
        providerRequests: activeProvider.requestCount,
        providerRequestsByStage,
        fakeProvider: {
          totalRequests: activeProvider.requestCount,
          requestsByStage: providerRequestsByStage,
          finalDeliveryRequestsBeforeKill,
          finalDeliveryRequestsAfterRecovery: providerRequestsByStage.return_god,
        },
        finalJobStatus: finalRawJob!.status,
        finalReturnStatus: finalRawReturn!.status,
      },
    };
    validateProcessChaosReport(report);
    await writeFile(reportFilePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return report;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const cleanupErrors = await cleanupHarnessResources(clients, provider, transientPath);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        operationError === undefined ? cleanupErrors : [operationError, ...cleanupErrors],
        "Process Chaos cleanup failed",
      );
    }
  }
}

export async function runProcessChaosGate40CaseHarness(
  outputDirectory: string,
  seed: string,
  windowId: ProcessChaosRunnableWindowId,
): Promise<ProcessChaosPilotReport> {
  const windowDirectory = path.join(path.resolve(outputDirectory), windowId);
  if (path.dirname(windowDirectory) !== path.resolve(outputDirectory)) {
    throw new Error("Process Chaos window output escaped its requested directory");
  }
  const report = windowId === PROCESS_CHAOS_WINDOW_ID
    ? await runProcessChaosHarness(windowDirectory, seed)
    : windowId === PROCESS_CHAOS_MODEL_RESPONSE_COMMIT_WINDOW_ID
      ? await runModelResponseBoundaryHarness(windowDirectory, seed)
      : windowId === PROCESS_CHAOS_WORKFLOW_STAGE_COMMIT_WINDOW_ID
        ? await runWorkflowStageBoundaryHarness(windowDirectory, seed)
        : [
            PROCESS_CHAOS_TOOL_EFFECT_RECEIPT_WINDOW_ID,
            PROCESS_CHAOS_RECEIPT_COMMIT_WINDOW_ID,
            PROCESS_CHAOS_PROOF_COMMIT_WINDOW_ID,
          ].includes(windowId as never)
          ? await runLocalEffectBoundaryHarness(windowDirectory, seed, windowId as
              | typeof PROCESS_CHAOS_TOOL_EFFECT_RECEIPT_WINDOW_ID
              | typeof PROCESS_CHAOS_RECEIPT_COMMIT_WINDOW_ID
              | typeof PROCESS_CHAOS_PROOF_COMMIT_WINDOW_ID)
        : await runReturnBoundaryHarness(windowDirectory, seed, windowId as
            | typeof PROCESS_CHAOS_RETURN_PERSISTED_WINDOW_ID
            | typeof PROCESS_CHAOS_FENCED_COMMIT_WINDOW_ID);
  assert.equal(processChaosPilotWindowId(report), windowId);
  return report;
}

export async function runProcessChaosInvalidControlDirectoryProbe(
  outputDirectory: string,
  seed: string,
): Promise<string> {
  assert.match(seed, /^[a-zA-Z0-9._-]+$/u, "seed must be filesystem-safe");
  const caseDirectory = await prepareCaseDirectory(outputDirectory, seed);
  const stateFilePath = path.join(caseDirectory, "runtime-state.json");
  const transientPath = path.join(caseDirectory, ".transient");
  const clockPath = path.join(transientPath, "clock-offset-ms.txt");
  const workspacePath = path.join(transientPath, "workspace");
  const plansPath = path.join(transientPath, "plans");
  const clients: AppServerClient[] = [];
  let provider: FakeResponsesServer | undefined;
  let operationError: unknown;
  try {
    await mkdir(transientPath, { recursive: true });
    await Promise.all([
      mkdir(workspacePath, { recursive: true }),
      mkdir(plansPath, { recursive: true }),
      writeFile(clockPath, "0\n", "utf8"),
    ]);
    provider = await FakeResponsesServer.start(seed);
    const client = createProcessChaosClient({
      stateFilePath,
      clockPath,
      workspacePath,
      plansPath,
      baseUrl: provider.baseUrl,
      faultWindow: PROCESS_CHAOS_MODEL_RESPONSE_COMMIT_WINDOW_ID,
      controlPath: "relative-process-chaos-control",
      faultRole: "original-owner",
    });
    clients.push(client);
    assert.equal((await client.start()).state, "connected");
    const thread = await client.startThread();
    await client.setThreadConfig(thread.id, {
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      agentProfileId: "engineering_role",
    });
    const turn = await client.startTurn(thread.id, `seed=${seed}: invalid control directory must fail closed`);
    let failure = "";
    try {
      await client.runTurn(turn.turn.id);
      assert.fail("Relative Process Chaos control directory unexpectedly executed");
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    assert.match(failure, /Process Chaos test-only control directory must be absolute/u);
    return failure;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const cleanupErrors = await cleanupHarnessResources(clients, provider, transientPath);
    if (cleanupErrors.length > 0) throw new AggregateError(
      operationError === undefined ? cleanupErrors : [operationError, ...cleanupErrors],
      "Process Chaos invalid-control probe cleanup failed",
    );
  }
}

export async function runProcessChaosEffectHelperSecurityProbe(
  outputDirectory: string,
  seed: string,
): Promise<{
  helperPids: [number, number];
  stableAfterRestart: true;
  duplicateReturnedSameEffect: true;
  conflictingPayloadRejected: true;
  validProofAccepted: true;
  tamperedProofRejected: true;
  finalEffectApplyCount: 1;
}> {
  const caseDirectory = await prepareCaseDirectory(outputDirectory, seed);
  const ledgerPath = path.join(caseDirectory, "effect-ledger.json");
  const operationId = `${seed}-security-probe`;
  const payload = `payload-${seed}`;
  const helpers: EffectHelperProcess[] = [];
  try {
    const first = await EffectHelperProcess.start(ledgerPath);
    helpers.push(first);
    const firstRecord = await postEffect(first.baseUrl, operationId, payload);
    const duplicate = await postEffect(first.baseUrl, operationId, payload);
    const conflict = await fetch(`${first.baseUrl}/effects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operationId, payload: `${payload}-conflict` }),
    });
    assert.equal(conflict.status, 409);
    const validProofAccepted = await first.verifyProof(operationId, firstRecord.proof);
    const tamperedProofRejected = !await first.verifyProof(operationId, {
      ...firstRecord.proof,
      proofDigest: `sha256:${"0".repeat(64)}`,
    });
    const firstPid = first.pid;
    await first.close();
    const second = await EffectHelperProcess.start(ledgerPath);
    helpers.push(second);
    const restored = await second.audit();
    const restoredRecord = restored.effects.find((item) => item.operationId === operationId);
    assert.ok(restoredRecord !== undefined);
    assert.deepEqual(duplicate, firstRecord);
    assert.equal(validProofAccepted, true);
    assert.equal(tamperedProofRejected, true);
    assert.deepEqual(restoredRecord, firstRecord);
    assert.equal(restoredRecord.effectApplyCount, 1);
    return {
      helperPids: [firstPid, second.pid],
      stableAfterRestart: true,
      duplicateReturnedSameEffect: true,
      conflictingPayloadRejected: true,
      validProofAccepted: true,
      tamperedProofRejected: true,
      finalEffectApplyCount: 1,
    };
  } finally {
    await Promise.allSettled(helpers.map((helper) => helper.close()));
  }
}

async function runLocalEffectBoundaryHarness(
  outputDirectory: string,
  seed: string,
  windowId:
    | typeof PROCESS_CHAOS_TOOL_EFFECT_RECEIPT_WINDOW_ID
    | typeof PROCESS_CHAOS_RECEIPT_COMMIT_WINDOW_ID
    | typeof PROCESS_CHAOS_PROOF_COMMIT_WINDOW_ID,
): Promise<ProcessChaosBoundaryReport> {
  assert.match(seed, /^[a-zA-Z0-9._-]+$/u, "seed must be filesystem-safe");
  const runStartedAt = new Date().toISOString();
  const caseDirectory = await prepareCaseDirectory(outputDirectory, seed);
  const stateFilePath = path.join(caseDirectory, "runtime-state.json");
  const ledgerPath = path.join(caseDirectory, "effect-ledger.json");
  const reportFilePath = path.join(caseDirectory, "process-chaos-boundary-report.json");
  const transientPath = path.join(caseDirectory, ".transient");
  const clockPath = path.join(transientPath, "clock-offset-ms.txt");
  const workspacePath = path.join(transientPath, "workspace");
  const plansPath = path.join(transientPath, "plans");
  const controlPath = path.join(transientPath, "fault-control");
  const clients: AppServerClient[] = [];
  const helpers: EffectHelperProcess[] = [];
  let provider: FakeResponsesServer | undefined;
  let operationError: unknown;
  try {
    await mkdir(transientPath, { recursive: true });
    await Promise.all([
      mkdir(workspacePath, { recursive: true }),
      mkdir(plansPath, { recursive: true }),
      mkdir(controlPath, { recursive: true }),
      writeFile(clockPath, "0\n", "utf8"),
    ]);
    const helper = await EffectHelperProcess.start(ledgerPath);
    helpers.push(helper);
    provider = await FakeResponsesServer.start(seed);
    const activeProvider = provider;
    const createClient = (injectFault: boolean) => {
      const client = createProcessChaosClient({
        stateFilePath,
        clockPath,
        workspacePath,
        plansPath,
        baseUrl: activeProvider.baseUrl,
        effectHelperBaseUrl: helper.baseUrl,
        experimentDirectory: caseDirectory,
        ...(injectFault ? { faultWindow: windowId, controlPath, faultRole: "original-owner" as const } : {}),
      });
      clients.push(client);
      return client;
    };

    const owner = createClient(true);
    assert.equal((await owner.start()).state, "connected");
    const ownerPid = requirePid(owner);
    const thread = await owner.startThread();
    const turn = await owner.startTurn(thread.id, `local-effect-window:${windowId};seed=${seed}`);
    const execution = owner.runTurn(turn.turn.id);
    const faultPoint = await waitForJsonFile(path.join(controlPath, "fault-point.json"));
    assert.equal(faultPoint.windowId, windowId);
    assert.equal(faultPoint.pid, ownerPid);
    assert.equal(faultPoint.operationId, `${seed}-${windowId.toLowerCase()}`);
    const expectedPersistedStatus = windowId === PROCESS_CHAOS_TOOL_EFFECT_RECEIPT_WINDOW_ID
      ? "executing"
      : "result_received";
    assert.equal(faultPoint.toolInvocationStatus, expectedPersistedStatus);
    const targetToolInvocationId = String(faultPoint.toolInvocationId);
    const persisted = await readRuntimeSnapshot(stateFilePath);
    assert.equal(persisted.toolInvocations.invocations.find((item) =>
      item.toolInvocationId === targetToolInvocationId)?.status, expectedPersistedStatus);
    const ledgerAtKill = await helper.audit();
    assert.equal(ledgerAtKill.effects.length, 1);
    assert.equal(ledgerAtKill.effects[0]?.effectApplyCount, 1);
    assert.equal(ledgerAtKill.audit.createRequests, 1);
    assert.equal(ledgerAtKill.audit.duplicateCreateRequests, 0);
    await forceKill(ownerPid);
    await assert.rejects(execution);

    const successor = createClient(false);
    assert.equal((await successor.start()).state, "connected");
    const successorPid = requirePid(successor);
    assert.notEqual(successorPid, ownerPid);
    await successor.runTurn(turn.turn.id);
    const final = await readRuntimeSnapshot(stateFilePath);
    const finalHistory = await successor.readThreadHistory(thread.id);
    const ledger = await helper.audit();
    const operation = ledger.effects[0]!;
    const experimentInvocations = final.toolInvocations.invocations.filter((item) =>
      item.toolName === "process_chaos_local_effect");
    const targetInvocation = experimentInvocations.find((item) => item.toolInvocationId === targetToolInvocationId);
    const targetToolResultCount = final.lifecycle.items.filter((item) =>
      item.turnId === turn.turn.id && item.type === "tool_result" && isRecord(item.content) &&
      item.content.callId === targetInvocation?.callId).length;
    const assistantMessageCount = final.lifecycle.items.filter((item) =>
      item.turnId === turn.turn.id && item.type === "assistant_message").length;
    const expectedToolInvocationCount = windowId === PROCESS_CHAOS_PROOF_COMMIT_WINDOW_ID ? 2 : 1;
    const expectedProviderRequests = windowId === PROCESS_CHAOS_PROOF_COMMIT_WINDOW_ID ? 3 : 2;
    const expectedProofVerifications = windowId === PROCESS_CHAOS_PROOF_COMMIT_WINDOW_ID ? 1 : 0;
    assert.equal(final.lifecycle.turns.find((item) => item.id === turn.turn.id)?.status, "completed");
    assert.equal(experimentInvocations.length, expectedToolInvocationCount);
    assert.equal(experimentInvocations.every((item) => item.status === "committed"), true);
    assert.equal(targetInvocation?.executionAttempts, 1);
    assert.equal(targetToolResultCount, 1);
    assert.equal(assistantMessageCount, 1);
    assert.equal(finalHistory.messages.filter((item) => item.role === "assistant").length, 1);
    assert.equal(activeProvider.requestCount, expectedProviderRequests);
    assert.equal(ledger.effects.length, 1);
    assert.equal(operation.effectApplyCount, 1);
    assert.equal(ledger.audit.createRequests, 1);
    assert.equal(ledger.audit.duplicateCreateRequests, 0);
    assert.equal(ledger.audit.proofVerificationRequests, expectedProofVerifications);
    const evidence = {
      helperPid: helper.pid,
      helperProcess: "real-child-process" as const,
      helperLedgerPath: "effect-ledger.json" as const,
      threadId: thread.id,
      turnId: turn.turn.id,
      operationId: operation.operationId,
      effectId: operation.effectId,
      effectDigest: operation.effectDigest,
      receiptId: operation.receipt.receiptId,
      receiptDigest: operation.receipt.receiptDigest,
      proofId: operation.proof.proofId,
      proofDigest: operation.proof.proofDigest,
      persistedToolStatus: expectedPersistedStatus,
      finalToolStatus: "committed" as const,
      effectApplyCount: 1 as const,
      helperCreateRequests: 1 as const,
      helperDuplicateCreateRequests: 0 as const,
      proofVerificationRequests: expectedProofVerifications,
      providerRequests: expectedProviderRequests,
      toolInvocationCount: expectedToolInvocationCount,
      targetToolResultCount: 1 as const,
      assistantMessageCount: 1 as const,
      finalTurnStatus: "completed" as const,
    };
    const base = boundaryReportBase(windowId, seed, runStartedAt, ownerPid, successorPid);
    const report: ProcessChaosBoundaryReport = windowId === PROCESS_CHAOS_TOOL_EFFECT_RECEIPT_WINDOW_ID
      ? { ...base, windowId, evidence: { ...evidence, persistedToolStatus: "executing", proofVerificationRequests: 0,
          providerRequests: 2, toolInvocationCount: 1 }, oracle: {
          id: "ORACLE-TOOL-OUTCOME-V1", ownerKilledAfterEffectBeforeToolReceipt: true,
          successorQueriedPersistedEffect: true, blindReplayAvoided: true, effectAppliedOnce: true,
          receiptRecovered: true,
        } }
      : windowId === PROCESS_CHAOS_RECEIPT_COMMIT_WINDOW_ID
        ? { ...base, windowId, evidence: { ...evidence, persistedToolStatus: "result_received", proofVerificationRequests: 0,
            providerRequests: 2, toolInvocationCount: 1 }, oracle: {
            id: "ORACLE-RECEIPT-V1", ownerKilledAfterReceiptPersisted: true,
            successorBoundPersistedReceipt: true, toolResultCommittedOnce: true, effectAppliedOnce: true,
          } }
        : { ...base, windowId, evidence: { ...evidence, persistedToolStatus: "result_received", proofVerificationRequests: 1,
            providerRequests: 3, toolInvocationCount: 2 }, oracle: {
            id: "ORACLE-PROOF-V1", ownerKilledAfterProofVerified: true, successorBoundPersistedProof: true,
            proofDigestStable: true, proofToolResultCommittedOnce: true, effectAppliedOnce: true,
          } };
    validateProcessChaosBoundaryReport(report);
    await writeFile(reportFilePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return report;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const cleanupErrors = await cleanupHarnessResources(clients, provider, transientPath, helpers);
    if (cleanupErrors.length > 0) throw new AggregateError(
      operationError === undefined ? cleanupErrors : [operationError, ...cleanupErrors],
      "Process Chaos local-effect cleanup failed",
    );
  }
}

async function runModelResponseBoundaryHarness(
  outputDirectory: string,
  seed: string,
): Promise<ProcessChaosBoundaryReport> {
  assert.match(seed, /^[a-zA-Z0-9._-]+$/u, "seed must be filesystem-safe");
  const runStartedAt = new Date().toISOString();
  const caseDirectory = await prepareCaseDirectory(outputDirectory, seed);
  const stateFilePath = path.join(caseDirectory, "runtime-state.json");
  const reportFilePath = path.join(caseDirectory, "process-chaos-boundary-report.json");
  const transientPath = path.join(caseDirectory, ".transient");
  const clockPath = path.join(transientPath, "clock-offset-ms.txt");
  const workspacePath = path.join(transientPath, "workspace");
  const plansPath = path.join(transientPath, "plans");
  const controlPath = path.join(transientPath, "fault-control");
  const clients: AppServerClient[] = [];
  let provider: FakeResponsesServer | undefined;
  let operationError: unknown;
  try {
    await mkdir(transientPath, { recursive: true });
    await Promise.all([
      mkdir(workspacePath, { recursive: true }),
      mkdir(plansPath, { recursive: true }),
      mkdir(controlPath, { recursive: true }),
      writeFile(clockPath, "0\n", "utf8"),
    ]);
    provider = await FakeResponsesServer.start(seed);
    const activeProvider = provider;
    const createClient = (injectFault: boolean) => {
      const client = createProcessChaosClient({
        stateFilePath, clockPath, workspacePath, plansPath, baseUrl: activeProvider.baseUrl,
        ...(injectFault ? {
          faultWindow: PROCESS_CHAOS_MODEL_RESPONSE_COMMIT_WINDOW_ID,
          controlPath,
          faultRole: "original-owner" as const,
        } : {}),
      });
      clients.push(client);
      return client;
    };

    const owner = createClient(true);
    assert.equal((await owner.start()).state, "connected");
    const ownerPid = requirePid(owner);
    const thread = await owner.startThread();
    await owner.setThreadConfig(thread.id, {
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      agentProfileId: "engineering_role",
    });
    const turn = await owner.startTurn(thread.id, `seed=${seed}: recover one persisted model response`);
    const execution = owner.runTurn(turn.turn.id);
    const faultPoint = await waitForJsonFile(path.join(controlPath, "fault-point.json"));
    assert.equal(faultPoint.windowId, PROCESS_CHAOS_MODEL_RESPONSE_COMMIT_WINDOW_ID);
    assert.equal(faultPoint.pid, ownerPid);
    assert.equal(faultPoint.turnId, turn.turn.id);
    assert.equal(faultPoint.invocationStatus, "response_received");
    const invocationId = String(faultPoint.invocationId);
    const persisted = await readRuntimeSnapshot(stateFilePath);
    assert.equal(persisted.modelInvocations.invocations.find((item) => item.invocationId === invocationId)?.status,
      "response_received");
    assert.equal(persisted.lifecycle.items.filter((item) =>
      item.turnId === turn.turn.id && item.type === "assistant_message").length, 0);
    const providerRequestsBeforeKill = activeProvider.requestCount;
    assert.equal(providerRequestsBeforeKill, 1);
    await forceKill(ownerPid);
    await assert.rejects(execution);

    const successor = createClient(false);
    assert.equal((await successor.start()).state, "connected");
    const successorPid = requirePid(successor);
    assert.notEqual(successorPid, ownerPid);
    const finalHistory = await successor.readThreadHistory(thread.id);
    const final = await readRuntimeSnapshot(stateFilePath);
    const finalInvocation = final.modelInvocations.invocations.find((item) => item.invocationId === invocationId);
    const assistantMessageCount = final.lifecycle.items.filter((item) =>
      item.turnId === turn.turn.id && item.type === "assistant_message").length;
    assert.equal(final.lifecycle.turns.find((item) => item.id === turn.turn.id)?.status, "completed");
    assert.equal(finalInvocation?.status, "committed");
    assert.equal(assistantMessageCount, 1);
    assert.equal(finalHistory.messages.filter((item) => item.role === "assistant").length, 1);
    assert.equal(activeProvider.requestCount, 1);

    const report: ProcessChaosBoundaryReport = {
      ...boundaryReportBase(PROCESS_CHAOS_MODEL_RESPONSE_COMMIT_WINDOW_ID, seed, runStartedAt,
        ownerPid, successorPid),
      windowId: PROCESS_CHAOS_MODEL_RESPONSE_COMMIT_WINDOW_ID,
      oracle: {
        id: "ORACLE-MODEL-WAL-V1",
        ownerKilledAfterResponsePersisted: true,
        successorReplayedPersistedResponse: true,
        providerRequestNotRepeated: true,
        assistantCommittedOnce: true,
      },
      evidence: {
        threadId: thread.id,
        turnId: turn.turn.id,
        invocationId,
        persistedInvocationStatus: "response_received",
        finalInvocationStatus: "committed",
        finalTurnStatus: "completed",
        providerRequestsBeforeKill: 1,
        finalProviderRequests: 1,
        assistantMessageCount: 1,
      },
    };
    validateProcessChaosBoundaryReport(report);
    await writeFile(reportFilePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return report;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const cleanupErrors = await cleanupHarnessResources(clients, provider, transientPath);
    if (cleanupErrors.length > 0) throw new AggregateError(
      operationError === undefined ? cleanupErrors : [operationError, ...cleanupErrors],
      "Process Chaos model-response cleanup failed",
    );
  }
}

async function runWorkflowStageBoundaryHarness(
  outputDirectory: string,
  seed: string,
): Promise<ProcessChaosBoundaryReport> {
  assert.match(seed, /^[a-zA-Z0-9._-]+$/u, "seed must be filesystem-safe");
  const runStartedAt = new Date().toISOString();
  const caseDirectory = await prepareCaseDirectory(outputDirectory, seed);
  const stateFilePath = path.join(caseDirectory, "runtime-state.json");
  const reportFilePath = path.join(caseDirectory, "process-chaos-boundary-report.json");
  const transientPath = path.join(caseDirectory, ".transient");
  const clockPath = path.join(transientPath, "clock-offset-ms.txt");
  const workspacePath = path.join(transientPath, "workspace");
  const plansPath = path.join(transientPath, "plans");
  const controlPath = path.join(transientPath, "fault-control");
  const clients: AppServerClient[] = [];
  let provider: FakeResponsesServer | undefined;
  let operationError: unknown;
  try {
    await mkdir(transientPath, { recursive: true });
    await Promise.all([
      mkdir(workspacePath, { recursive: true }),
      mkdir(plansPath, { recursive: true }),
      mkdir(controlPath, { recursive: true }),
      writeFile(clockPath, "0\n", "utf8"),
    ]);
    provider = await FakeResponsesServer.start(seed);
    const activeProvider = provider;
    const createClient = (injectFault: boolean) => {
      const client = createProcessChaosClient({
        stateFilePath, clockPath, workspacePath, plansPath, baseUrl: activeProvider.baseUrl,
        ...(injectFault ? {
          faultWindow: PROCESS_CHAOS_WORKFLOW_STAGE_COMMIT_WINDOW_ID,
          controlPath,
          faultRole: "original-owner" as const,
        } : {}),
      });
      clients.push(client);
      return client;
    };

    const owner = createClient(true);
    assert.equal((await owner.start()).state, "connected");
    const ownerPid = requirePid(owner);
    const thread = await owner.startThread();
    const planTurn = await owner.startTurn(thread.id, `seed=${seed}: prepare workflow-stage boundary`);
    await owner.runTurn(planTurn.turn.id);
    const requirement = await owner.getRequirement(thread.id);
    assert.ok(requirement !== undefined);
    await owner.confirmRequirement(requirement.id, requirement.revision, requirement.planArtifact.contentHash);
    const executionTurn = await owner.startTurn(thread.id, `seed=${seed}: execute workflow-stage boundary`);
    const execution = owner.runTurn(executionTurn.turn.id);
    const faultPoint = await waitForJsonFile(path.join(controlPath, "fault-point.json"));
    assert.equal(faultPoint.windowId, PROCESS_CHAOS_WORKFLOW_STAGE_COMMIT_WINDOW_ID);
    assert.equal(faultPoint.pid, ownerPid);
    assert.equal(faultPoint.stageId, "product");
    assert.equal(faultPoint.stageAttempt, 1);
    assert.equal(faultPoint.invocationStatus, "committed");
    assert.equal(faultPoint.checkpointStatus, "running");
    const jobId = String(faultPoint.jobId);
    const runId = String(faultPoint.runId);
    const invocationId = String(faultPoint.invocationId);
    const persisted = await readRuntimeSnapshot(stateFilePath);
    assert.equal(persisted.modelInvocations.invocations.find((item) => item.invocationId === invocationId)?.status,
      "committed");
    assert.equal((persisted.agentRuntime.stageCheckpoints ?? []).filter((item) =>
      item.jobId === jobId && item.stageId === "product" && item.status === "running").length, 1);
    assert.equal(persisted.agentRuntime.evidence.filter((item) =>
      item.jobId === jobId && item.idempotencyKey === `${String(faultPoint.checkpointKey)}:evidence`).length, 0);
    assert.equal(persisted.agentRuntime.returns.filter((item) =>
      item.jobId === jobId && item.stageId === "product").length, 0);
    await forceKill(ownerPid);
    await assert.rejects(execution);
    await writeFile(clockPath, `${LEASE_TTL_MS + 1_000}\n`, "utf8");

    const successor = createClient(false);
    assert.equal((await successor.start()).state, "connected");
    const successorPid = requirePid(successor);
    assert.notEqual(successorPid, ownerPid);
    await successor.runTurn(executionTurn.turn.id);
    const final = await readRuntimeSnapshot(stateFilePath);
    const productInvocations = final.modelInvocations.invocations.filter((item) =>
      item.jobId === jobId && item.stageId === "product" && item.stageAttempt === 1);
    const productCheckpoints = (final.agentRuntime.stageCheckpoints ?? []).filter((item) =>
      item.jobId === jobId && item.stageId === "product" && item.stageAttempt === 1);
    const productEvidence = final.agentRuntime.evidence.filter((item) =>
      item.jobId === jobId && item.idempotencyKey === `${String(faultPoint.checkpointKey)}:evidence`);
    const productReturns = final.agentRuntime.returns.filter((item) =>
      item.jobId === jobId && item.stageId === "product");
    assert.equal(final.agentRuntime.jobs.find((item) => item.id === jobId)?.status, "completed");
    assert.equal(productInvocations.length, 1);
    assert.equal(productInvocations[0]?.invocationId, invocationId);
    assert.equal(productInvocations[0]?.status, "committed");
    assert.equal(productCheckpoints.length, 1);
    assert.equal(productCheckpoints[0]?.status, "completed");
    assert.equal(productEvidence.length, 1);
    assert.equal(productReturns.length, 1);

    const report: ProcessChaosBoundaryReport = {
      ...boundaryReportBase(PROCESS_CHAOS_WORKFLOW_STAGE_COMMIT_WINDOW_ID, seed, runStartedAt,
        ownerPid, successorPid),
      windowId: PROCESS_CHAOS_WORKFLOW_STAGE_COMMIT_WINDOW_ID,
      oracle: {
        id: "ORACLE-WORKFLOW-COMMIT-V1",
        ownerKilledBeforeStageCommit: true,
        successorRecoveredPersistedModelResult: true,
        productModelInvocationNotRepeated: true,
        productStageCommittedOnce: true,
      },
      evidence: {
        threadId: thread.id,
        jobId,
        runId,
        stageId: "product",
        stageAttempt: 1,
        invocationId,
        persistedInvocationStatus: "committed",
        persistedCheckpointStatus: "running",
        finalInvocationStatus: "committed",
        finalCheckpointStatus: "completed",
        finalJobStatus: "completed",
        productInvocationCount: 1,
        productCheckpointCount: 1,
        productEvidenceCount: 1,
        productReturnCount: 1,
      },
    };
    validateProcessChaosBoundaryReport(report);
    await writeFile(reportFilePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return report;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const cleanupErrors = await cleanupHarnessResources(clients, provider, transientPath);
    if (cleanupErrors.length > 0) throw new AggregateError(
      operationError === undefined ? cleanupErrors : [operationError, ...cleanupErrors],
      "Process Chaos workflow-stage cleanup failed",
    );
  }
}

async function runReturnBoundaryHarness(
  outputDirectory: string,
  seed: string,
  windowId: typeof PROCESS_CHAOS_RETURN_PERSISTED_WINDOW_ID | typeof PROCESS_CHAOS_FENCED_COMMIT_WINDOW_ID,
): Promise<ProcessChaosBoundaryReport> {
  assert.match(seed, /^[a-zA-Z0-9._-]+$/u, "seed must be filesystem-safe");
  const runStartedAt = new Date().toISOString();
  const caseDirectory = await prepareCaseDirectory(outputDirectory, seed);
  const stateFilePath = path.join(caseDirectory, "runtime-state.json");
  const leasePath = path.join(caseDirectory, "runtime-leases.json");
  const reportFilePath = path.join(caseDirectory, "process-chaos-boundary-report.json");
  const transientPath = path.join(caseDirectory, ".transient");
  const clockPath = path.join(transientPath, "clock-offset-ms.txt");
  const workspacePath = path.join(transientPath, "workspace");
  const plansPath = path.join(transientPath, "plans");
  const controlPath = path.join(transientPath, "fault-control");
  const successorControlPath = path.join(transientPath, "successor-control");
  const clients: AppServerClient[] = [];
  let provider: FakeResponsesServer | undefined;
  let operationError: unknown;

  try {
    await mkdir(transientPath, { recursive: true });
    await Promise.all([
      mkdir(workspacePath, { recursive: true }),
      mkdir(plansPath, { recursive: true }),
      mkdir(controlPath, { recursive: true }),
      mkdir(successorControlPath, { recursive: true }),
      writeFile(clockPath, "0\n", "utf8"),
    ]);
    provider = await FakeResponsesServer.start(seed);
    const activeProvider = provider;
    const createClient = (injection?: { controlPath: string; role: "original-owner" | "successor-terminal" }) => {
      const client = new AppServerClient({
        command: process.execPath,
        args: [
          "--import", "tsx",
          "--import", pathToFileURL(path.resolve("research/runtime-e2e-benchmarks/src/process-chaos-clock.ts")).href,
          "src/app-server/main.ts",
        ],
        cwd: process.cwd(),
        env: createHarnessEnvironment({
          statePath: stateFilePath,
          clockPath,
          workspacePath,
          plansPath,
          baseUrl: activeProvider.baseUrl,
          ...(injection === undefined ? {} : {
            faultWindow: windowId,
            controlPath: injection.controlPath,
            faultRole: injection.role,
          }),
        }),
        handshakeTimeoutMs: 60_000,
        shutdownTimeoutMs: 2_000,
      });
      clients.push(client);
      return client;
    };

    const originalOwner = createClient({ controlPath, role: "original-owner" });
    assert.equal((await originalOwner.start()).state, "connected");
    const originalOwnerPid = requirePid(originalOwner);
    const thread = await originalOwner.startThread();
    const planTurn = await originalOwner.startTurn(thread.id, `seed=${seed}: prepare persisted Return boundary`);
    await originalOwner.runTurn(planTurn.turn.id);
    const requirement = await originalOwner.getRequirement(thread.id);
    assert.ok(requirement !== undefined);
    await originalOwner.confirmRequirement(requirement.id, requirement.revision, requirement.planArtifact.contentHash);

    const executionTurn = await originalOwner.startTurn(thread.id, `seed=${seed}: execute persisted Return boundary`);
    const execution = originalOwner.runTurn(executionTurn.turn.id);
    const faultPoint = await waitForJsonFile(path.join(controlPath, "fault-point.json"));
    assert.equal(faultPoint.windowId, windowId);
    assert.equal(faultPoint.pid, originalOwnerPid);
    assert.equal(faultPoint.returnStatus, "ready");
    assert.equal(faultPoint.returnAttempts, 0);
    const persisted = await readRuntimeSnapshot(stateFilePath);
    const job = persisted.agentRuntime.jobs.find((item) => item.id === faultPoint.jobId);
    const persistedReturn = persisted.agentRuntime.returns.find((item) => item.id === faultPoint.returnId);
    assert.equal(job?.status, "waiting_returns");
    assert.equal(persistedReturn?.status, "ready");
    assert.equal(persistedReturn?.attempts, 0);
    const originalLease = await readLeaseSnapshot(leasePath);
    const originalLeaseEntry = originalLease.entries.find((item) => item.resourceType === "job" && item.resourceId === job.id);
    assert.equal(originalLeaseEntry?.ownerId, faultPoint.ownerId);
    assert.equal(originalLeaseEntry?.fencingToken, faultPoint.fencingToken);

    let successor: AppServerClient;
    let successorPid: number;
    let auditorPid: number | null = null;
    let staleCommitError = "";
    let successorFencingToken = Number(faultPoint.fencingToken);

    if (windowId === PROCESS_CHAOS_RETURN_PERSISTED_WINDOW_ID) {
      await forceKill(originalOwnerPid);
      await assert.rejects(execution);
      await writeFile(clockPath, `${LEASE_TTL_MS + 1_000}\n`, "utf8");
      successor = createClient();
      assert.equal((await successor.start()).state, "connected");
      successorPid = requirePid(successor);
    } else {
      await writeFile(clockPath, `${LEASE_TTL_MS + 1_000}\n`, "utf8");
      successor = createClient({ controlPath: successorControlPath, role: "successor-terminal" });
      assert.equal((await successor.start()).state, "connected");
      successorPid = requirePid(successor);
    }
    assert.notEqual(successorPid, originalOwnerPid);

    const recoveredRpc = asAgentRuntime(await successor.getAgentRuntime(thread.id));
    const recoveredReturn = recoveredRpc.returns.find((item) => item.id === persistedReturn.id);
    assert.equal(recoveredReturn?.status, "ready");
    assert.equal(recoveredReturn?.attempts, 0);
    const successorAdvance = successor.advanceFixedProduct(thread.id, "lead_return_ready");
    if (windowId === PROCESS_CHAOS_FENCED_COMMIT_WINDOW_ID) {
      const successorFaultPoint = await waitForJsonFile(path.join(successorControlPath, "fault-point.json"));
      assert.equal(successorFaultPoint.role, "successor-terminal");
      assert.equal(successorFaultPoint.pid, successorPid);
      assert.equal(successorFaultPoint.returnStatus, "consumed");
      const successorLease = await waitForLeaseSnapshot(leasePath, (snapshot) => snapshot.entries.some((item) =>
        item.resourceType === "job" && item.resourceId === job.id && item.ownerId?.includes(String(successorPid)) === true &&
        Number(item.fencingToken) > Number(faultPoint.fencingToken)));
      const successorEntry = successorLease.entries.find((item) =>
        item.resourceType === "job" && item.resourceId === job.id && item.ownerId?.includes(String(successorPid)) === true);
      assert.ok(successorEntry !== undefined);
      successorFencingToken = Number(successorEntry.fencingToken);
      await writeFile(path.join(controlPath, "release"), "release stale owner\n", "utf8");
      try {
        await execution;
        assert.fail("Stale owner unexpectedly committed after successor fencing takeover");
      } catch (error) {
        staleCommitError = error instanceof Error ? error.message : String(error);
      }
      assert.match(staleCommitError, /fencing token mismatch/u);
      await forceKill(originalOwnerPid);
      await writeFile(path.join(successorControlPath, "release"), "release successor\n", "utf8");
    }
    const advanced = asAdvanceResult(await successorAdvance);
    assert.equal(advanced.changed, true);
    assert.equal(advanced.stage, "completed");
    const repeated = asAdvanceResult(await successor.advanceFixedProduct(thread.id, "completed"));
    assert.deepEqual(repeated, { stage: "completed", changed: false });

    if (windowId === PROCESS_CHAOS_FENCED_COMMIT_WINDOW_ID) {
      const auditor = createClient();
      assert.equal((await auditor.start()).state, "connected");
      auditorPid = requirePid(auditor);
      assert.notEqual(auditorPid, successorPid);
      assert.equal(asAgentRuntime(await auditor.getAgentRuntime(thread.id)).job?.status, "completed");
    }

    const finalRaw = await readRuntimeSnapshot(stateFilePath);
    const finalJob = finalRaw.agentRuntime.jobs.find((item) => item.id === job.id);
    const finalReturn = finalRaw.agentRuntime.returns.find((item) => item.id === persistedReturn.id);
    const returnGodCheckpoints = (finalRaw.agentRuntime.stageCheckpoints ?? []).filter((item) =>
      item.jobId === job.id && item.stageId === "return_god");
    const returnGodEvidence = finalRaw.agentRuntime.evidence.filter((item) =>
      item.jobId === job.id && item.stageId === "return_god");
    assert.equal(finalJob?.status, "completed");
    assert.equal(finalReturn?.status, "consumed");
    assert.equal(finalReturn?.attempts, 1);
    assert.equal(returnGodCheckpoints.length, 1);
    assert.equal(returnGodEvidence.length, 1);
    assert.equal(activeProvider.requestCountsByStage().return_god, 1);

    const base = {
      schemaVersion: PROCESS_CHAOS_BOUNDARY_REPORT_SCHEMA_VERSION,
      windowId,
      evidenceLevel: "local-narrow-E3-pilot" as const,
      completeGate40: false as const,
      exactlyOnceClaimed: false as const,
      productionReadyClaimed: false as const,
      runStartedAt,
      runCompletedAt: new Date().toISOString(),
      environment: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        osRelease: osRelease(),
        local: true as const,
        appServerProcess: "real-child-process" as const,
        provider: { kind: "deterministic-loopback-fake" as const, realApiCalls: false as const, credentialsRead: false as const },
      },
      seed,
      productionEntry: "node --import tsx src/app-server/main.ts" as const,
      reproCommand: processChaosWindowReproCommand(windowId, seed),
      statePath: "runtime-state.json" as const,
      leasePath: "runtime-leases.json" as const,
      rawReportPath: "process-chaos-boundary-report.json" as const,
      pids: { originalOwner: originalOwnerPid, successor: successorPid, auditor: auditorPid },
      evidence: {
        threadId: thread.id,
        jobId: job.id,
        returnId: persistedReturn.id,
        persistedReturnStatus: "ready" as const,
        persistedReturnAttempts: 0 as const,
        finalReturnStatus: "consumed" as const,
        finalReturnAttempts: 1 as const,
        finalJobStatus: "completed" as const,
        finalDeliveryRequests: 1 as const,
        returnGodCheckpointCount: 1 as const,
        returnGodEvidenceCount: 1 as const,
      },
    };
    const report: ProcessChaosBoundaryReport = windowId === PROCESS_CHAOS_RETURN_PERSISTED_WINDOW_ID
      ? { ...base, windowId, oracle: {
        id: "ORACLE-RETURN-CONSUME-V1", ownerKilledAtPersistedBoundary: true,
        successorReloadedPersistedReturn: true, returnConsumedOnce: true, parentAdvancedOnce: true,
        repeatedAdvanceChangedState: false,
      } }
      : { ...base, windowId, oracle: {
        id: "ORACLE-FENCING-V1", originalFencingToken: Number(faultPoint.fencingToken), successorFencingToken,
        staleCommitRejected: true, staleCommitError, successorUniquelyCommitted: true,
        originalOwnerKilled: true, auditorReloadedAuthoritativeState: true,
      } };
    validateProcessChaosBoundaryReport(report);
    await writeFile(reportFilePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return report;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const cleanupErrors = await cleanupHarnessResources(clients, provider, transientPath);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(operationError === undefined ? cleanupErrors : [operationError, ...cleanupErrors],
        "Process Chaos boundary cleanup failed");
    }
  }
}

interface EffectHelperAudit {
  schemaVersion: "process-chaos-effect-ledger-v1";
  effects: Array<{
    operationId: string;
    payload: string;
    effectId: string;
    effectDigest: string;
    receipt: { receiptId: string; receiptDigest: string; receiptMac: string };
    proof: { proofId: string; proofDigest: string; proofMac: string };
    effectApplyCount: 1;
  }>;
  audit: { createRequests: number; duplicateCreateRequests: number; proofVerificationRequests: number };
}

class EffectHelperProcess {
  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    readonly baseUrl: string,
    readonly ledgerPath: string,
  ) {}

  get pid(): number {
    assert.equal(typeof this.child.pid, "number");
    return this.child.pid!;
  }

  static async start(ledgerPath: string): Promise<EffectHelperProcess> {
    assert.equal(path.isAbsolute(ledgerPath), true);
    const child = spawn(process.execPath, [
      "--import", "tsx",
      "research/runtime-e2e-benchmarks/src/process-chaos-effect-helper.ts",
      "--ledger", ledgerPath,
    ], {
      cwd: process.cwd(),
      env: createMinimalChildEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const ready = await withProcessChaosTimeout(new Promise<Record<string, unknown>>((resolve, reject) => {
      const inspect = () => {
        const newline = stdout.indexOf("\n");
        if (newline < 0) return;
        try { resolve(JSON.parse(stdout.slice(0, newline)) as Record<string, unknown>); } catch (error) { reject(error); }
      };
      child.stdout.on("data", inspect);
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Effect helper exited before ready (${code}): ${stderr}`)));
      inspect();
    }), 15_000, "effect helper ready");
    if (ready.schemaVersion !== "process-chaos-effect-helper-ready-v1" ||
      ready.pid !== child.pid || typeof ready.baseUrl !== "string" || ready.ledgerPath !== ledgerPath) {
      await forceKill(child.pid!);
      throw new Error("Invalid Process Chaos effect helper ready message");
    }
    return new EffectHelperProcess(child, ready.baseUrl, ledgerPath);
  }

  async audit(): Promise<EffectHelperAudit> {
    const response = await fetch(`${this.baseUrl}/audit`);
    if (!response.ok) throw new Error(`Effect helper audit HTTP ${response.status}`);
    return await response.json() as EffectHelperAudit;
  }

  async verifyProof(operationId: string, proof: EffectHelperAudit["effects"][number]["proof"]): Promise<boolean> {
    const response = await fetch(`${this.baseUrl}/effects/${encodeURIComponent(operationId)}/verify-proof`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proof }),
    });
    if (!response.ok) throw new Error(`Effect helper proof verification HTTP ${response.status}`);
    const value = await response.json() as { verified?: unknown };
    return value.verified === true;
  }

  async close(): Promise<void> {
    const pid = this.child.pid;
    if (pid === undefined || !isProcessAlive(pid)) return;
    this.child.kill("SIGTERM");
    const deadline = Date.now() + 5_000;
    while (isProcessAlive(pid) && Date.now() < deadline) await delay(20);
    if (isProcessAlive(pid)) await forceKill(pid);
  }
}

async function postEffect(
  baseUrl: string,
  operationId: string,
  payload: string,
): Promise<EffectHelperAudit["effects"][number]> {
  const response = await fetch(`${baseUrl}/effects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operationId, payload }),
  });
  if (!response.ok) throw new Error(`Effect helper create HTTP ${response.status}`);
  return await response.json() as EffectHelperAudit["effects"][number];
}

class FakeResponsesServer {
  readonly baseUrl: string;
  requestCount = 0;
  private readonly stageRequestCounts: FakeProviderRequestCounts = {
    prepare_requirement_plan: 0,
    plan_confirmation: 0,
    team_workflow: 0,
    return_god: 0,
  };
  private finalDeliveryResolve: (() => void) | undefined;
  private readonly finalDelivery = new Promise<void>((resolve) => { this.finalDeliveryResolve = resolve; });

  private constructor(private readonly server: Server, private readonly seed: string, port: number) {
    this.baseUrl = `http://127.0.0.1:${port}/v1`;
  }

  static async start(seed: string): Promise<FakeResponsesServer> {
    let instance: FakeResponsesServer | undefined;
    const server = createServer((request, response) => { void instance!.handle(request, response); });
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        const address = server.address();
        if (address === null || typeof address === "string") reject(new Error("Fake provider did not bind a TCP port"));
        else resolve(address.port);
      });
    });
    instance = new FakeResponsesServer(server, seed, port);
    return instance;
  }

  waitForFinalDeliveryResponse(): Promise<void> {
    return withProcessChaosTimeout(this.finalDelivery, FINAL_DELIVERY_RESPONSE_TIMEOUT_MS, "final delivery provider response");
  }

  requestCountsByStage(): FakeProviderRequestCounts {
    return { ...this.stageRequestCounts };
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((error) => error === undefined ? resolve() : reject(error));
      this.server.closeAllConnections();
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
    this.requestCount += 1;
    const requestId = `${this.seed}-response-${this.requestCount}`;
    const instructions = typeof body.instructions === "string" ? body.instructions : "";
    const input = Array.isArray(body.input) ? body.input : [];
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const hasPlanTool = tools.some((item) => isRecord(item) && item.name === "prepare_requirement_plan");
    const hasLocalEffectTool = tools.some((item) => isRecord(item) && item.name === "process_chaos_local_effect");
    const hasPlanOutput = input.some((item) => isRecord(item) && item.type === "function_call_output" &&
      typeof item.output === "string" && item.output.includes("awaiting_user_confirmation"));

    const serializedInput = JSON.stringify(input);
    const effectWindow = /local-effect-window:(FW-[A-Z-]+)/u.exec(serializedInput)?.[1] ??
      ([
        PROCESS_CHAOS_TOOL_EFFECT_RECEIPT_WINDOW_ID,
        PROCESS_CHAOS_RECEIPT_COMMIT_WINDOW_ID,
        PROCESS_CHAOS_PROOF_COMMIT_WINDOW_ID,
      ] as const).find((candidate) => serializedInput.includes(`${this.seed}-${candidate.toLowerCase()}`));
    if (hasLocalEffectTool && effectWindow !== undefined) {
      const operationId = `${this.seed}-${effectWindow.toLowerCase()}`;
      const payload = `payload-${this.seed}`;
      const hasEffectOutput = input.some((item) => isRecord(item) && item.type === "function_call_output" &&
        item.call_id === `${this.seed}-effect-call`);
      const hasProofOutput = input.some((item) => isRecord(item) && item.type === "function_call_output" &&
        item.call_id === `${this.seed}-proof-call`);
      if (hasProofOutput) {
        await respondJson(response, textResponse(requestId, `Local effect evidence committed for ${operationId}.`));
        return;
      }
      if (!hasEffectOutput) {
        await respondJson(response, functionCallResponse(requestId, "process_chaos_local_effect",
          `${this.seed}-effect-call`, JSON.stringify({ action: "create_effect", operationId, payload })));
        return;
      }
      if (effectWindow === PROCESS_CHAOS_PROOF_COMMIT_WINDOW_ID && !hasProofOutput) {
        await respondJson(response, functionCallResponse(requestId, "process_chaos_local_effect",
          `${this.seed}-proof-call`, JSON.stringify({ action: "verify_proof", operationId, payload })));
        return;
      }
      await respondJson(response, textResponse(requestId, `Local effect evidence committed for ${operationId}.`));
      return;
    }

    if (hasPlanTool && !hasPlanOutput) {
      this.stageRequestCounts.prepare_requirement_plan += 1;
      await respondJson(response, functionCallResponse(requestId, "prepare_requirement_plan", `${this.seed}-plan`, JSON.stringify({
        executionKind: "software_product_delivery",
        title: `Process chaos ${this.seed}`,
        objective: "Prove real App Server process crash recovery",
        scope: ["research/runtime-e2e-benchmarks/**"],
        nonGoals: ["production protocol changes"],
        constraints: ["deterministic fake provider"],
        deliverables: ["raw process chaos report"],
        acceptanceCriteria: ["PID changes and one observed Return request is retained without an exactly-once claim"],
        testCases: [{ id: `TC-${this.seed}`, title: "process recovery", kind: "recovery", steps: ["kill owner", "restart successor"], expected: "job completes after the held Lease expires" }],
        executionSteps: ["prepare", "confirm", "execute", "kill", "recover"],
      })));
      return;
    }
    if (hasPlanOutput) {
      this.stageRequestCounts.plan_confirmation += 1;
      await respondJson(response, textResponse(requestId, `Plan ${this.seed} is ready for confirmation.`));
      return;
    }
    if (instructions.includes("Workflow 的唯一最终交付者")) {
      this.stageRequestCounts.return_god += 1;
      const wideningPayload = this.stageRequestCounts.return_god === 1 ? "x".repeat(2_000_000) : "";
      await respondJson(response, textResponse(requestId, `Final delivery recovered for ${this.seed}.${wideningPayload}`));
      this.finalDeliveryResolve?.();
      return;
    }
    this.stageRequestCounts.team_workflow += 1;
    await respondJson(response, textResponse(requestId, stageResult()));
  }
}

function createProcessChaosClient(input: {
  stateFilePath: string;
  clockPath: string;
  workspacePath: string;
  plansPath: string;
  baseUrl: string;
  faultWindow?: ProcessChaosRunnableWindowId;
  controlPath?: string;
  faultRole?: "original-owner" | "successor-terminal";
  effectHelperBaseUrl?: string;
  experimentDirectory?: string;
}): AppServerClient {
  return new AppServerClient({
    command: process.execPath,
    args: [
      "--import", "tsx",
      "--import", pathToFileURL(path.resolve("research/runtime-e2e-benchmarks/src/process-chaos-clock.ts")).href,
      "src/app-server/main.ts",
    ],
    cwd: process.cwd(),
    env: createHarnessEnvironment({
      statePath: input.stateFilePath,
      clockPath: input.clockPath,
      workspacePath: input.workspacePath,
      plansPath: input.plansPath,
      baseUrl: input.baseUrl,
      ...(input.faultWindow === undefined ? {} : {
        faultWindow: input.faultWindow,
        controlPath: input.controlPath!,
        faultRole: input.faultRole!,
      }),
      ...(input.effectHelperBaseUrl === undefined ? {} : {
        effectHelperBaseUrl: input.effectHelperBaseUrl,
        experimentDirectory: input.experimentDirectory!,
      }),
    }),
    handshakeTimeoutMs: 60_000,
    shutdownTimeoutMs: 2_000,
  });
}

function boundaryReportBase(
  windowId: Exclude<ProcessChaosRunnableWindowId, typeof PROCESS_CHAOS_WINDOW_ID>,
  seed: string,
  runStartedAt: string,
  originalOwner: number,
  successor: number,
) {
  return {
    schemaVersion: PROCESS_CHAOS_BOUNDARY_REPORT_SCHEMA_VERSION,
    windowId,
    evidenceLevel: "local-narrow-E3-pilot" as const,
    completeGate40: false as const,
    exactlyOnceClaimed: false as const,
    productionReadyClaimed: false as const,
    runStartedAt,
    runCompletedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      osRelease: osRelease(),
      local: true as const,
      appServerProcess: "real-child-process" as const,
      provider: {
        kind: "deterministic-loopback-fake" as const,
        realApiCalls: false as const,
        credentialsRead: false as const,
      },
    },
    seed,
    productionEntry: "node --import tsx src/app-server/main.ts" as const,
    reproCommand: processChaosWindowReproCommand(windowId, seed),
    statePath: "runtime-state.json" as const,
    leasePath: "runtime-leases.json" as const,
    rawReportPath: "process-chaos-boundary-report.json" as const,
    pids: { originalOwner, successor, auditor: null },
  };
}

function createMinimalChildEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

function createHarnessEnvironment(input: {
  statePath: string;
  clockPath: string;
  workspacePath: string;
  plansPath: string;
  baseUrl: string;
  faultWindow?: ProcessChaosRunnableWindowId;
  controlPath?: string;
  faultRole?: "original-owner" | "successor-terminal";
  effectHelperBaseUrl?: string;
  experimentDirectory?: string;
}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    AGENT_STATE_PATH: input.statePath,
    AGENT_SKILLS_PATH: path.join(path.dirname(input.statePath), "skills"),
    AGENT_OUTCOME_UNKNOWN_STATE_PATH: path.join(path.dirname(input.statePath), "outcome-unknown.json"),
    AGENT_PLANS_PATH: input.plansPath,
    AGENT_WORKSPACE: input.workspacePath,
    PROCESS_CHAOS_CLOCK_PATH: input.clockPath,
    OPENAI_API_KEY: "process-chaos-deterministic-fake-key",
    OPENAI_BASE_URL: input.baseUrl,
    OPENAI_MODEL: "gpt-5.6-sol",
    // 该基准冻结在已发表的 v2 五阶段协议；V3 有独立的设计确认与三 Chat 并行门禁。
    AGENT_SOFTWARE_PRODUCT_DELIVERY_WORKFLOW_VERSION: "software_product_delivery_v2",
    ...(input.faultWindow === undefined && input.effectHelperBaseUrl === undefined ? {} : { NODE_ENV: "test" }),
    ...(input.faultWindow === undefined ? {} : {
      PROCESS_CHAOS_TEST_ONLY_FAULT_WINDOW: input.faultWindow,
      PROCESS_CHAOS_TEST_ONLY_CONTROL_DIRECTORY: input.controlPath!,
      PROCESS_CHAOS_TEST_ONLY_ROLE: input.faultRole!,
    }),
    ...(input.effectHelperBaseUrl === undefined ? {} : {
      PROCESS_CHAOS_TEST_ONLY_EFFECT_HELPER_URL: input.effectHelperBaseUrl,
      PROCESS_CHAOS_TEST_ONLY_EXPERIMENT_DIRECTORY: input.experimentDirectory!,
    }),
  };
  for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

async function prepareCaseDirectory(outputDirectory: string, seed: string): Promise<string> {
  const resolvedOutput = path.resolve(outputDirectory);
  const caseDirectory = path.join(resolvedOutput, `process-chaos-${seed}`);
  if (path.dirname(caseDirectory) !== resolvedOutput) {
    throw new Error("Process Chaos output escaped its requested directory");
  }
  await mkdir(resolvedOutput, { recursive: true });
  await rm(caseDirectory, { recursive: true, force: true });
  await mkdir(caseDirectory, { recursive: false });
  return caseDirectory;
}

async function cleanupHarnessResources(
  clients: AppServerClient[],
  provider: FakeResponsesServer | undefined,
  transientPath: string,
  helpers: EffectHelperProcess[] = [],
): Promise<unknown[]> {
  const errors: unknown[] = [];
  const closeResults = await Promise.allSettled(clients.map((client) => client.close()));
  for (const result of closeResults) {
    if (result.status === "rejected") errors.push(result.reason);
  }
  for (const client of clients) {
    const pid = client.getChildPid();
    if (pid !== undefined && isProcessAlive(pid)) {
      try {
        await forceKill(pid);
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (provider !== undefined) {
    try {
      await provider.close();
    } catch (error) {
      errors.push(error);
    }
  }
  const helperResults = await Promise.allSettled(helpers.map((helper) => helper.close()));
  for (const result of helperResults) {
    if (result.status === "rejected") errors.push(result.reason);
  }
  try {
    await rm(transientPath, { recursive: true, force: true });
  } catch (error) {
    errors.push(error);
  }
  return errors;
}

async function forceKill(pid: number): Promise<void> {
  process.kill(pid, "SIGKILL");
  const deadline = Date.now() + 10_000;
  while (isProcessAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for App Server PID ${pid} to exit`);
    await delay(20);
  }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function requirePid(client: AppServerClient): number {
  const pid = client.getChildPid();
  assert.equal(typeof pid, "number");
  return pid!;
}

async function readRuntimeSnapshot(statePath: string): Promise<RuntimeSnapshot> {
  return JSON.parse(await readFile(statePath, "utf8")) as RuntimeSnapshot;
}

async function readLeaseSnapshot(leasePath: string): Promise<LeaseSnapshot> {
  return JSON.parse(await readFile(leasePath, "utf8")) as LeaseSnapshot;
}

async function waitForJsonFile(filePath: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + PERSISTED_FAULT_POINT_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(filePath, "utf8")) as unknown;
      if (!isRecord(value)) throw new Error("fault point marker is not an object");
      return value;
    } catch (error) {
      lastError = error;
      await delay(20);
    }
  }
  throw new Error(`Timed out waiting for Process Chaos marker: ${errorSummary(lastError)}`);
}

async function waitForLeaseSnapshot(
  leasePath: string,
  predicate: (snapshot: LeaseSnapshot) => boolean,
): Promise<LeaseSnapshot> {
  const deadline = Date.now() + PERSISTED_FAULT_POINT_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const snapshot = await readLeaseSnapshot(leasePath);
      if (predicate(snapshot)) return snapshot;
    } catch (error) {
      lastError = error;
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for successor Lease: ${errorSummary(lastError)}`);
}

async function waitForRuntimeSnapshot(statePath: string, predicate: (snapshot: RuntimeSnapshot) => boolean): Promise<RuntimeSnapshot> {
  const deadline = Date.now() + PERSISTED_FAULT_POINT_TIMEOUT_MS;
  const expectedFileName = path.basename(statePath).toLocaleLowerCase("en-US");
  let fileEvents = 0;
  let readAttempts = 0;
  let eventGeneration = 0;
  let wake: (() => void) | undefined;
  let watcher: FSWatcher | undefined;
  let lastSnapshot: RuntimeSnapshot | undefined;
  let lastReadError: unknown;
  let lastWatchError: unknown;

  try {
    watcher = watch(path.dirname(statePath), (_eventType, fileName) => {
      if (fileName !== null && String(fileName).toLocaleLowerCase("en-US") !== expectedFileName) return;
      fileEvents += 1;
      eventGeneration += 1;
      wake?.();
      wake = undefined;
    });
    watcher.on("error", (error) => {
      lastWatchError = error;
      wake?.();
      wake = undefined;
    });

    let observedGeneration = -1;
    while (Date.now() < deadline) {
      if (observedGeneration !== eventGeneration) {
        observedGeneration = eventGeneration;
        readAttempts += 1;
        try {
          const snapshot = await readRuntimeSnapshot(statePath);
          lastSnapshot = snapshot;
          lastReadError = undefined;
          if (predicate(snapshot)) return snapshot;
        } catch (error) {
          // Atomic rename can briefly race the directory lookup on Windows.
          // Preserve the error for timeout diagnostics and retry on the next
          // file event or the bounded low-frequency fallback poll.
          lastReadError = error;
        }
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await Promise.race([
        waitForSnapshotEvent(() => eventGeneration, observedGeneration, (resolve) => { wake = resolve; }),
        delay(Math.min(SNAPSHOT_FALLBACK_POLL_MS, remaining)),
      ]);
      // The fallback poll is deliberately much slower than the old 10 ms loop:
      // it provides resilience if fs.watch coalesces a Windows rename without
      // competing with the Runtime's multi-megabyte atomic state writes.
      if (observedGeneration === eventGeneration) eventGeneration += 1;
    }
  } catch (error) {
    lastWatchError = error;
  } finally {
    watcher?.close();
  }

  throw new Error(
    `Timed out waiting for persisted process-chaos fault point after ${PERSISTED_FAULT_POINT_TIMEOUT_MS}ms; ` +
    `fileEvents=${fileEvents}; readAttempts=${readAttempts}; lastState=${summarizeFaultPointState(lastSnapshot)}; ` +
    `lastReadError=${errorSummary(lastReadError)}; lastWatchError=${errorSummary(lastWatchError)}`,
  );
}

function waitForSnapshotEvent(
  generation: () => number,
  observedGeneration: number,
  register: (resolve: () => void) => void,
): Promise<void> {
  if (generation() !== observedGeneration) return Promise.resolve();
  return new Promise<void>((resolve) => {
    register(resolve);
    // Close the small check/register race: an event between the first check
    // and assigning the waiter must still wake this observation cycle.
    if (generation() !== observedGeneration) resolve();
  });
}

function summarizeFaultPointState(snapshot: RuntimeSnapshot | undefined): string {
  if (snapshot === undefined) return "unread";
  return JSON.stringify({
    jobs: snapshot.agentRuntime.jobs.map((item) => ({ id: item.id, status: item.status })),
    returns: snapshot.agentRuntime.returns.map((item) => ({ id: item.id, stageId: item.stageId, status: item.status })),
    invocations: snapshot.modelInvocations.invocations.map((item) => ({ stageId: item.stageId, status: item.status })),
  });
}

function errorSummary(error: unknown): string {
  if (error === undefined) return "none";
  return error instanceof Error ? `${error.name}:${error.message}` : String(error);
}

function asAgentRuntime(value: unknown): {
  job?: { id: string; status: string };
  returns: Array<{ id: string; status: string; attempts: number }>;
} {
  assert.ok(isRecord(value));
  assert.ok(value.job === undefined || isRecord(value.job));
  assert.ok(Array.isArray(value.returns));
  return value as ReturnType<typeof asAgentRuntime>;
}

function asAdvanceResult(value: unknown): { stage: string; changed: boolean } {
  assert.ok(isRecord(value) && typeof value.stage === "string" && typeof value.changed === "boolean");
  return value as { stage: string; changed: boolean };
}

function stageResult(): string {
  return JSON.stringify({
    status: "completed",
    summary: "deterministic process-chaos stage completed",
    deliverables: ["runtime evidence"],
    evidence: ["persisted public App Server state"],
    blockers: [],
    nextStageRecommendation: "continue",
    contractVersion: STAGE_RESULT_CONTRACT_VERSION,
  });
}

function functionCallResponse(id: string, name: string, callId: string, argumentsJson: string): unknown {
  return { id, output: [{ type: "function_call", call_id: callId, name, arguments: argumentsJson }] };
}

function textResponse(id: string, text: string): unknown {
  return { id, output: [{ type: "message", content: [{ type: "output_text", text }] }] };
}

function respondJson(response: ServerResponse, value: unknown): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    response.once("error", reject);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(value), () => {
      response.removeListener("error", reject);
      resolve();
    });
  });
}

async function readBody(request: IncomingMessage): Promise<string> {
  let result = "";
  for await (const chunk of request) result += chunk.toString();
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function withProcessChaosTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
