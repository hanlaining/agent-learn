import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AgentRegistry } from "../src/agents/agent-registry.js";
import { AgentRunStore } from "../src/agents/agent-run-store.js";
import { DEFAULT_AGENT_TEAM_CONFIG } from "../src/agents/agent-runtime.js";
import { AgentRuntimeStore } from "../src/agents/agent-runtime-store.js";
import { MultiAgentScheduler } from "../src/agents/multi-agent-scheduler.js";
import {
  DynamicAgentExecutionEngine,
  type DynamicExecutionOwnership,
} from "../src/execution/dynamic-agent-execution-engine.js";
import type { ExecutionLeaseCommitBoundary } from "../src/runtime/execution-lease-coordinator.js";

class TrackingOwnership implements DynamicExecutionOwnership {
  activeJobId: string | undefined;
  readonly entries: string[] = [];

  async withJob<T>(jobId: string, operation: () => Promise<T>): Promise<T> {
    assert.equal(this.activeJobId, undefined);
    this.activeJobId = jobId;
    this.entries.push(jobId);
    try {
      return await operation();
    } finally {
      this.activeJobId = undefined;
    }
  }
}

function deferredSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("Dynamic Engine 的五个公开操作及持久提交都处于同一 Job ownership", async () => {
  const setup = createFixture("all-owned-operations");
  const ownership = new TrackingOwnership();
  const boundaries: ExecutionLeaseCommitBoundary[] = [];
  let drives = 0;
  const engine = new DynamicAgentExecutionEngine(setup.runtime, {
    runStore: setup.runs,
    ownership,
    persist: (boundary) => {
      assert.equal(ownership.activeJobId, setup.jobId);
      boundaries.push(boundary);
    },
  });
  const context = {
    jobId: setup.jobId,
    threadId: setup.threadId,
    rootRunId: setup.rootRunId,
    executionKind: "software_change" as const,
    workflowVersion: "dynamic_v1",
    drive: async () => {
      drives += 1;
      return {};
    },
  };

  assert.equal(await engine.provideFeedback(setup.jobId, {
    turnId: `feedback-${setup.jobId}`,
    text: "continue",
  }), true);
  await engine.recover(setup.jobId);
  await engine.start(context);
  await engine.resume(setup.jobId);
  await engine.cancel(setup.jobId);

  assert.equal(drives, 1, "recover and terminal resume must not invoke the model drive");
  assert.deepEqual(ownership.entries, Array(5).fill(setup.jobId));
  assert.ok(boundaries.length >= 4);
  assert.equal(boundaries.every((boundary) => boundary !== undefined), true);
  assert.ok(boundaries.includes("cancel"));
  assert.ok(boundaries.includes("parent_continuation"));
});

test("Dynamic Engine 未取得 Job ownership 时五个公开操作均不推进事实", async () => {
  const operations = ["feedback", "recover", "start", "resume", "cancel"] as const;
  for (const operation of operations) {
    const setup = createFixture(`ownership-wait-${operation}`);
    const before = setup.runtime.exportSnapshot();
    let drives = 0;
    let persists = 0;
    const ownership: DynamicExecutionOwnership = {
      withJob: async () => { throw new Error("lease waiting"); },
    };
    const engine = new DynamicAgentExecutionEngine(setup.runtime, {
      ownership,
      persist: () => { persists += 1; },
    });
    const context = {
      jobId: setup.jobId,
      threadId: setup.threadId,
      rootRunId: setup.rootRunId,
      executionKind: "software_change" as const,
      workflowVersion: "dynamic_v1",
      drive: async () => { drives += 1; return {}; },
    };
    const invoke = () => operation === "feedback"
      ? engine.provideFeedback(setup.jobId, { turnId: "feedback-turn", text: "continue" })
      : operation === "recover"
        ? engine.recover(setup.jobId)
        : operation === "start"
          ? engine.start(context)
          : operation === "resume"
            ? engine.resume(setup.jobId)
            : engine.cancel(setup.jobId);

    await assert.rejects(invoke, /lease waiting/);
    assert.deepEqual(setup.runtime.exportSnapshot(), before, `${operation} mutated Runtime without ownership`);
    assert.equal(drives, 0);
    assert.equal(persists, 0);
  }
});

test("生产 main 为 Dynamic Engine 注入共享 Lease 并把占用态留作可观察等待", async () => {
  const source = await readFile(new URL("../src/app-server/main.ts", import.meta.url), "utf8");
  assert.match(source, /new DynamicAgentExecutionEngine[\s\S]*?ownership:\s*executionLeaseCoordinator/);
  assert.match(source, /persist:\s*\(boundary\)[\s\S]*?withRequiredActiveFencedCommit/);
  assert.match(source, /registerAppServerHandlers[\s\S]*?executionOwnership:\s*executionLeaseCoordinator/);
  assert.match(source, /registerAppServerHandlers[\s\S]*?saveState:\s*persistRuntimeState/);
  assert.match(source, /ExecutionLeaseUnavailableError/);
  assert.match(source, /waiting for active execution owner/);
});

test("五个 kill/restart 窗口恢复为唯一持久裁决且启动恢复零模型", async () => {
  const cases = [
    { name: "queued", setup: setupQueued, phase: "queued", action: "explicit_model_resume" },
    { name: "waiting_dependencies", setup: setupWaitingDependencies, phase: "waiting_dependencies", action: "explicit_model_resume" },
    { name: "child_running", setup: setupChildRunning, phase: "child_running", action: "manual_intervention" },
    { name: "return_ready", setup: setupReturnReady, phase: "return_ready", action: "explicit_model_resume" },
    { name: "parent_continuation", setup: setupParentContinuation, phase: "manual_intervention", action: "manual_intervention" },
  ] as const;

  for (const scenario of cases) {
    const before = createFixture(`window-${scenario.name}`);
    scenario.setup(before);
    const restored = AgentRuntimeStore.fromSnapshot(before.runtime.exportSnapshot());
    const engine = new DynamicAgentExecutionEngine(restored);
    await engine.recover(before.jobId);
    const state = restored.getDynamicExecution(before.jobId);
    assert.equal(state?.phase, scenario.phase);
    assert.equal(state?.recoveryAction, scenario.action);
    assert.equal(restored.listJobs().length, 1);
    assert.equal(restored.listTasks(before.jobId).length, before.runtime.listTasks(before.jobId).length);
    assert.equal(restored.exportSnapshot().dynamicExecutions?.length, 1);
    await assert.rejects(() => engine.resume(before.jobId), /requires an explicit validated drive context/);
  }
});

test("父 continuation 由 Dynamic Engine 唯一驱动并只消费一次 Return", async () => {
  const setup = createFixture("continuation-once");
  const task = addTask(setup, "completed");
  const envelope = addReturn(setup, task.id, "completed");
  let drives = 0;
  const engine = new DynamicAgentExecutionEngine(setup.runtime, { runStore: setup.runs });
  const result = await engine.start({
    jobId: setup.jobId, threadId: setup.threadId, rootRunId: setup.rootRunId,
    executionKind: "software_change", workflowVersion: "dynamic_v1",
    drive: async (request) => {
      drives += 1;
      assert.equal(request.kind, "parent_continuation");
      assert.match(request.guidance ?? "", new RegExp(task.id));
      return { output: { delivered: true } };
    },
  });

  assert.deepEqual(result.output, { delivered: true });
  assert.equal(drives, 1);
  assert.equal(setup.runtime.listReturns(setup.jobId)[0]?.status, "consumed");
  assert.equal(setup.runtime.getJob(setup.jobId)?.status, "completed");
  assert.equal(setup.runtime.getDynamicExecution(setup.jobId)?.recoveryAction, "terminate");
  await engine.resume(setup.jobId);
  assert.equal(drives, 1, "terminal resume must not redeliver");
});

test("Return claim、父 continuation、模型结果与 consume 使用同一 ownership 的独立 fencing 边界", async () => {
  const setup = createFixture("continuation-boundaries");
  const task = addTask(setup, "completed");
  addReturn(setup, task.id, "completed");
  const ownership = new TrackingOwnership();
  const boundaries: ExecutionLeaseCommitBoundary[] = [];
  const engine = new DynamicAgentExecutionEngine(setup.runtime, {
    ownership,
    persist: (boundary) => {
      assert.equal(ownership.activeJobId, setup.jobId);
      boundaries.push(boundary);
    },
  });

  await engine.start({
    jobId: setup.jobId,
    threadId: setup.threadId,
    rootRunId: setup.rootRunId,
    executionKind: "software_change",
    workflowVersion: "dynamic_v1",
    drive: async () => {
      assert.equal(setup.runtime.listReturns(setup.jobId)[0]?.status, "delivering");
      assert.equal(ownership.activeJobId, setup.jobId);
      return {};
    },
  });

  assert.deepEqual(boundaries, [
    "return_claim",
    "parent_continuation",
    "model_commit",
    "return_consume",
  ]);
  assert.deepEqual(ownership.entries, [setup.jobId]);
  assert.equal(setup.runtime.listReturns(setup.jobId)[0]?.status, "consumed");
});

test("cancel 提交后 root drive 的迟到普通异常不得把 Job 从 cancelled 改为 failed", async () => {
  const setup = createFixture("cancelled-root-late-error");
  const driveStarted = deferredSignal();
  const releaseDrive = deferredSignal();
  const engine = new DynamicAgentExecutionEngine(setup.runtime, { runStore: setup.runs });
  const running = engine.start({
    jobId: setup.jobId,
    threadId: setup.threadId,
    rootRunId: setup.rootRunId,
    executionKind: "software_change",
    workflowVersion: "dynamic_v1",
    drive: async () => {
      driveStarted.resolve();
      await releaseDrive.promise;
      throw new Error("late root provider failure");
    },
  });
  await driveStarted.promise;

  await engine.cancel(setup.jobId);
  releaseDrive.resolve();
  await assert.rejects(running, /late root provider failure/);

  assert.equal(setup.runtime.getJob(setup.jobId)?.status, "cancelled");
  assert.equal(setup.runtime.getDynamicExecution(setup.jobId)?.recoveryAction, "terminate");
  assert.equal(setup.runs.get(setup.rootRunId)?.status, "cancelled");
});

test("cancel 提交后 continuation 的迟到普通异常不得重试 Return 或改为 waiting_returns", async () => {
  const setup = createFixture("cancelled-continuation-late-error");
  const task = addTask(setup, "completed");
  const returned = addReturn(setup, task.id, "completed");
  const driveStarted = deferredSignal();
  const releaseDrive = deferredSignal();
  const engine = new DynamicAgentExecutionEngine(setup.runtime, { runStore: setup.runs });
  const running = engine.start({
    jobId: setup.jobId,
    threadId: setup.threadId,
    rootRunId: setup.rootRunId,
    executionKind: "software_change",
    workflowVersion: "dynamic_v1",
    drive: async (request) => {
      assert.equal(request.kind, "parent_continuation");
      assert.equal(setup.runtime.listReturns(setup.jobId)[0]?.status, "delivering");
      driveStarted.resolve();
      await releaseDrive.promise;
      throw new Error("late continuation provider failure");
    },
  });
  await driveStarted.promise;

  await engine.cancel(setup.jobId);
  releaseDrive.resolve();
  await assert.rejects(running, /late continuation provider failure/);

  assert.equal(setup.runtime.getJob(setup.jobId)?.status, "cancelled");
  assert.equal(setup.runtime.listReturns(setup.jobId).find((item) => item.id === returned.id)?.status, "failed");
  assert.equal(setup.runtime.getDynamicExecution(setup.jobId)?.recoveryAction, "terminate");
  assert.equal(setup.runs.get(setup.rootRunId)?.status, "cancelled");
});

test("失败 child 接收反馈后沿用同 Job、原 Task/Thread并创建新 attempt", async () => {
  const setup = createFixture("same-task-thread");
  const originalTask = addTask(setup, "failed");
  const originalRun = setup.runs.create({ jobId: setup.jobId, threadId: "worker-thread-stable", turnId: "worker-turn-1",
    agentProfileId: "tester", parentRunId: setup.rootRunId, task: originalTask.objective, depth: 1 });
  setup.runs.setTaskId(originalRun.id, originalTask.id);
  setup.runs.complete(originalRun.id, { runId: originalRun.id, taskId: originalTask.id, status: "failed", summary: "blocked" });
  setup.runtime.setTaskOwnerRun(originalTask.id, originalRun.id, 1);
  setup.runtime.setJobStatus(setup.jobId, "running");
  const feedbackTurn = "feedback-turn";
  const engine = new DynamicAgentExecutionEngine(setup.runtime, { runStore: setup.runs });
  assert.equal(await engine.provideFeedback(setup.jobId, { turnId: feedbackTurn, text: "retry safely" }), true);

  const prepared: Array<{ taskId: string; attempt: number; threadId: string }> = [];
  const scheduler = new MultiAgentScheduler({
    registry: new AgentRegistry(), store: setup.runs, runtimeStore: setup.runtime,
    resolveParent: () => ({ threadId: setup.threadId, teamConfig: { ...DEFAULT_AGENT_TEAM_CONFIG, independentReview: false } }),
    prepare: (_profile, _task, _parentRunId, taskId, attempt) => {
      const threadId = setup.runs.findWorkerThread(setup.jobId, taskId) ?? `new-thread-${taskId}`;
      prepared.push({ taskId, attempt, threadId });
      return { threadId, turnId: `worker-turn-${attempt}`, execute: async () => "retry completed" };
    },
  });
  const result = await scheduler.runAgent({ parentTurnId: feedbackTurn, profileId: "tester", taskId: originalTask.id,
    task: originalTask.objective });

  assert.equal(result.status, "completed");
  assert.equal(setup.runtime.listJobs().length, 1);
  assert.equal(setup.runtime.listTasks(setup.jobId).filter((item) => item.parentTaskId === undefined).length, 1);
  assert.equal(setup.runtime.getTask(originalTask.id)?.attempt, 2);
  assert.deepEqual(prepared, [{ taskId: originalTask.id, attempt: 2, threadId: "worker-thread-stable" }]);
  assert.equal(setup.runs.listForJob(setup.jobId).filter((run) => run.taskId === originalTask.id).at(-1)?.threadId, "worker-thread-stable");
});

test("Scheduler 依赖等待支持 deadline/取消且不使用轮询", async () => {
  const setup = createFixture("scheduler-signals");
  const dependency = addTask(setup, "draft", "dependency");
  const controller = new AbortController();
  let executes = 0;
  const scheduler = new MultiAgentScheduler({ registry: new AgentRegistry(), store: setup.runs, runtimeStore: setup.runtime, waitTimeoutMs: 5_000,
    resolveParent: () => ({ threadId: setup.threadId, teamConfig: { ...DEFAULT_AGENT_TEAM_CONFIG, independentReview: false } }),
    prepare: () => ({ threadId: "cancelled-thread", turnId: "cancelled-turn", execute: async () => { executes += 1; return "unexpected"; } }),
  });
  const waiting = scheduler.runAgent({ parentTurnId: "root-turn-scheduler-signals", profileId: "tester", task: "dependent",
    dependsOnTaskIds: [dependency.id], signal: controller.signal, deadlineAt: new Date(Date.now() + 1_000).toISOString() });
  controller.abort();
  const result = await waiting;
  assert.equal(result.status, "failed");
  assert.match(result.safeError ?? "", /cancel/i);
  assert.equal(executes, 0);

  const deadlineSetup = createFixture("scheduler-deadline");
  const pending = addTask(deadlineSetup, "draft", "pending");
  const deadlineScheduler = new MultiAgentScheduler({ registry: new AgentRegistry(), store: deadlineSetup.runs,
    runtimeStore: deadlineSetup.runtime, waitTimeoutMs: 20,
    resolveParent: () => ({ threadId: deadlineSetup.threadId, teamConfig: { ...DEFAULT_AGENT_TEAM_CONFIG, independentReview: false } }),
    prepare: () => ({ threadId: "deadline-thread", turnId: "deadline-turn", execute: async () => "unexpected" }),
  });
  const deadlineResult = await deadlineScheduler.runAgent({ parentTurnId: "root-turn-scheduler-deadline", profileId: "tester",
    task: "deadline dependent", dependsOnTaskIds: [pending.id] });
  assert.equal(deadlineResult.status, "failed");
  assert.match(deadlineResult.safeError ?? "", /deadline exceeded/);

  const capacitySetup = createFixture("scheduler-capacity-cancel");
  let releaseFirst!: () => void; let markStarted!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstStarted = new Promise<void>((resolve) => { markStarted = resolve; });
  const capacityScheduler = new MultiAgentScheduler({ registry: new AgentRegistry(), store: capacitySetup.runs,
    runtimeStore: capacitySetup.runtime, maxConcurrentRuns: 1,
    resolveParent: () => ({ threadId: capacitySetup.threadId, teamConfig: { ...DEFAULT_AGENT_TEAM_CONFIG, independentReview: false, maxConcurrent: 1 } }),
    prepare: (_profile, task) => ({ threadId: `capacity-${task}`, turnId: `capacity-${task}`,
      execute: async () => { if (task === "first") { markStarted(); await firstGate; } return task; } }),
  });
  const first = capacityScheduler.runAgent({ parentTurnId: "root-turn-scheduler-capacity-cancel", profileId: "tester", task: "first" });
  await firstStarted;
  const queuedController = new AbortController();
  const second = capacityScheduler.runAgent({ parentTurnId: "root-turn-scheduler-capacity-cancel", profileId: "tester", task: "second",
    signal: queuedController.signal, deadlineAt: new Date(Date.now() + 1_000).toISOString() });
  queuedController.abort();
  const cancelledSecond = await second;
  assert.equal(cancelledSecond.status, "failed");
  assert.match(cancelledSecond.safeError ?? "", /cancel/i);
  releaseFirst();
  assert.equal((await first).status, "completed");
});

test("动态 Engine 只观察自己的 Return，不消费固定 Workflow Return", async () => {
  const dynamic = createFixture("return-isolation");
  const dynamicTask = addTask(dynamic, "completed");
  addReturn(dynamic, dynamicTask.id, "completed");
  const teamJob = dynamic.runtime.createJob({ threadId: "team-thread", rootTurnId: "team-turn", rootRunId: "team-root",
    configSnapshot: DEFAULT_AGENT_TEAM_CONFIG, executionKind: "software_product_delivery", workflowVersion: "software_product_delivery_v2" });
  const teamTask = dynamic.runtime.createTask({ jobId: teamJob.id, rootRunId: teamJob.rootRunId, ownerRunId: "team-child",
    profileId: "product_role", title: "team", objective: "team", scope: { allowedPaths: [], deniedPaths: [], nonGoals: [] },
    requiredOutputs: ["team"], acceptanceCriteria: ["team"], fileClaims: [], maxAttempts: 1, status: "completed" });
  const teamReturn = dynamic.runtime.createReturn({ jobId: teamJob.id, rootRunId: teamJob.rootRunId, parentRunId: teamJob.rootRunId,
    childRunId: "team-child", taskId: teamTask.id, sequence: 1, result: { status: "completed", summary: "team-only", evidenceIds: [], boardEntryIds: [] },
    idempotencyKey: `${teamJob.id}:team`, workflowVersion: "software_product_delivery_v2" });

  const engine = new DynamicAgentExecutionEngine(dynamic.runtime);
  await engine.recover(dynamic.jobId);
  assert.deepEqual(dynamic.runtime.getDynamicExecution(dynamic.jobId)?.returnIds, [dynamic.runtime.listReturns(dynamic.jobId)[0]?.id]);
  assert.equal(dynamic.runtime.listReturns(teamJob.id).find((item) => item.id === teamReturn.id)?.status, "ready");
});

function createFixture(suffix: string) {
  const runtime = new AgentRuntimeStore(); const runs = new AgentRunStore();
  const threadId = `thread-${suffix}`; const rootTurnId = `root-turn-${suffix}`;
  const root = runs.ensureRoot(threadId, rootTurnId, "orchestrator", `job-${rootTurnId}`);
  const job = runtime.createJob({ threadId, rootTurnId, rootRunId: root.id,
    configSnapshot: { ...DEFAULT_AGENT_TEAM_CONFIG, independentReview: false }, executionKind: "software_change", workflowVersion: "dynamic_v1" });
  return { runtime, runs, threadId, rootRunId: root.id, jobId: job.id };
}

function addTask(setup: ReturnType<typeof createFixture>, status: "draft" | "running" | "completed" | "failed", title = "task") {
  return setup.runtime.createTask({ jobId: setup.jobId, rootRunId: setup.rootRunId, ownerRunId: `owner-${title}`,
    profileId: "tester", title, objective: title, scope: { allowedPaths: [], deniedPaths: [], nonGoals: [] },
    requiredOutputs: ["result"], acceptanceCriteria: ["verified"], fileClaims: [], maxAttempts: 2, status });
}

function addReturn(setup: ReturnType<typeof createFixture>, taskId: string, status: "completed" | "failed") {
  return setup.runtime.createReturn({ jobId: setup.jobId, rootRunId: setup.rootRunId, parentRunId: setup.rootRunId,
    childRunId: `child-${taskId}`, taskId, sequence: 1,
    result: { status, summary: `${status} child feedback`, evidenceIds: [], boardEntryIds: [] },
    idempotencyKey: `${setup.jobId}:${taskId}:1`, jobAttempt: 1, workflowVersion: "dynamic_v1" });
}

function setupQueued(setup: ReturnType<typeof createFixture>) { addTask(setup, "draft"); }
function setupWaitingDependencies(setup: ReturnType<typeof createFixture>) { const dependency = addTask(setup, "draft", "dependency"); const dependent = addTask(setup, "draft", "dependent"); setup.runtime.addEdge({ jobId: setup.jobId, fromTaskId: dependency.id, toTaskId: dependent.id, type: "depends_on", hard: true }); }
function setupChildRunning(setup: ReturnType<typeof createFixture>) { const task = addTask(setup, "draft"); setup.runtime.claimTask(task.id, "child-running", 60_000); setup.runtime.setTaskStatus(task.id, "running"); }
function setupReturnReady(setup: ReturnType<typeof createFixture>) { const task = addTask(setup, "completed"); addReturn(setup, task.id, "completed"); }
function setupParentContinuation(setup: ReturnType<typeof createFixture>) { const task = addTask(setup, "completed"); const result = addReturn(setup, task.id, "completed"); setup.runtime.setDynamicExecution({ jobId: setup.jobId, jobAttempt: 1, phase: "parent_continuation", recoveryAction: "manual_intervention", reason: "crashed after Return claim and before parent commit", taskIds: [task.id], returnIds: [result.id] }); }
