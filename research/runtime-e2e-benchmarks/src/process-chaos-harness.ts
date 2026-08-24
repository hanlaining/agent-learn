import assert from "node:assert/strict";
import { watch, type FSWatcher } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { release as osRelease } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { AppServerClient } from "../../../src/electron/app-server-client.js";
import { STAGE_RESULT_CONTRACT_VERSION } from "../../../src/execution/stage-contract.js";
import {
  PROCESS_CHAOS_EXPERIMENT_ID,
  PROCESS_CHAOS_REPORT_SCHEMA_VERSION,
  processChaosReproCommand,
  validateProcessChaosReport,
  type FakeProviderRequestCounts,
  type ProcessChaosReport,
} from "./process-chaos-schema.js";

const LEASE_TTL_MS = 120_000;
const FINAL_DELIVERY_RESPONSE_TIMEOUT_MS = 30_000;
const PERSISTED_FAULT_POINT_TIMEOUT_MS = 45_000;
const SNAPSHOT_FALLBACK_POLL_MS = 250;
export type { ProcessChaosReport } from "./process-chaos-schema.js";

interface RuntimeSnapshot {
  version: number;
  lifecycle: { threads: Array<{ id: string }>; turns: Array<{ id: string; threadId: string; status: string }> };
  agentRuntime: {
    jobs: Array<{ id: string; threadId: string; status: string }>;
    returns: Array<{ id: string; jobId: string; status: string; stageId?: string }>;
  };
  modelInvocations: {
    invocations: Array<{ status: string; stageId?: string }>;
  };
}

interface LeaseSnapshot {
  version: number;
  entries: Array<{
    resourceType: string;
    resourceId: string;
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
    const hasPlanOutput = input.some((item) => isRecord(item) && item.type === "function_call_output" &&
      typeof item.output === "string" && item.output.includes("awaiting_user_confirmation"));

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

function createHarnessEnvironment(input: {
  statePath: string;
  clockPath: string;
  workspacePath: string;
  plansPath: string;
  baseUrl: string;
}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    AGENT_STATE_PATH: input.statePath,
    AGENT_OUTCOME_UNKNOWN_STATE_PATH: path.join(path.dirname(input.statePath), "outcome-unknown.json"),
    AGENT_PLANS_PATH: input.plansPath,
    AGENT_WORKSPACE: input.workspacePath,
    // This legacy Return-window harness validates the v2 stage topology.
    AGENT_SOFTWARE_PRODUCT_DELIVERY_WORKFLOW_VERSION: "software_product_delivery_v2",
    PROCESS_CHAOS_CLOCK_PATH: input.clockPath,
    OPENAI_API_KEY: "process-chaos-deterministic-fake-key",
    OPENAI_BASE_URL: input.baseUrl,
    OPENAI_MODEL: "gpt-5.6-sol",
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
  returns: Array<{ id: string; status: string }>;
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
