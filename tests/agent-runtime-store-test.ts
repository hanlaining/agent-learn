import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntimeStore } from "../src/agents/agent-runtime-store.js";
import { DEFAULT_AGENT_TEAM_CONFIG } from "../src/agents/agent-runtime.js";
import { AgentRuntimeCoordinator } from "../src/agents/agent-runtime-coordinator.js";
import { AgentRunStore } from "../src/agents/agent-run-store.js";

test("terminal Job without executable Tasks remains terminal", () => {
  const store = new AgentRuntimeStore();
  const job = store.createJob({ threadId: "chat-team", rootTurnId: "turn-team", rootRunId: "run-team", configSnapshot: DEFAULT_AGENT_TEAM_CONFIG });
  store.setJobStatus(job.id, "failed");
  store.reconcilePersistedJobs();
  assert.equal(store.getJob(job.id)?.status, "failed");
});

test("persisted terminal Job without Tasks does not reopen after Runtime restart", () => {
  const store = new AgentRuntimeStore();
  const job = store.createJob({ threadId: "chat-team", rootTurnId: "turn-team", rootRunId: "run-team", configSnapshot: DEFAULT_AGENT_TEAM_CONFIG });
  store.setJobStatus(job.id, "failed");
  const restored = AgentRuntimeStore.fromSnapshot(store.exportSnapshot());
  restored.reconcilePersistedJobs();
  assert.equal(restored.getJob(job.id)?.status, "failed");
});

function fixture() {
  let tick = 0;
  const store = new AgentRuntimeStore(() => new Date(Date.UTC(2026, 7, 12, 0, 0, tick++)).toISOString());
  const job = store.createJob({ threadId: "chat-a", rootTurnId: "turn-a", rootRunId: "run-root", configSnapshot: DEFAULT_AGENT_TEAM_CONFIG });
  const task = (title: string, fileClaims: string[] = []) => store.createTask({ jobId: job.id, rootRunId: "run-root", ownerRunId: `run-${title}`, profileId: "coder", title, objective: title, scope: { allowedPaths: [], deniedPaths: [], nonGoals: [] }, requiredOutputs: [title], acceptanceCriteria: [`验收 ${title}`], fileClaims, maxAttempts: 2 });
  return { store, job, task };
}

test("Job 冻结 Chat 权限快照，后续配置修改不影响运行中 Job", () => {
  const store = new AgentRuntimeStore();
  const chatConfig = { ...DEFAULT_AGENT_TEAM_CONFIG, accessMode: "read_only" as "read_only" | "full_access" };
  const job = store.createJob({ threadId: "chat-access", rootTurnId: "turn-access", rootRunId: "run-access", configSnapshot: chatConfig });

  chatConfig.accessMode = "full_access";

  assert.equal(job.configSnapshot.accessMode, "read_only");
  assert.equal(store.getJob(job.id)?.configSnapshot.accessMode, "read_only");
});

test("Task DAG 拒绝环且 fork/join 只在硬依赖完成后 ready", () => {
  const { store, job, task } = fixture(); const forkA = task("fork-a"); const forkB = task("fork-b"); const join = task("join");
  store.addEdge({ jobId: job.id, fromTaskId: forkA.id, toTaskId: join.id, type: "depends_on", hard: true });
  store.addEdge({ jobId: job.id, fromTaskId: forkB.id, toTaskId: join.id, type: "depends_on", hard: true });
  assert.deepEqual(store.readyTasks(job.id).map((item) => item.id), [forkA.id, forkB.id]);
  store.setTaskStatus(forkA.id, "completed"); assert.equal(store.readyTasks(job.id).some((item) => item.id === join.id), false);
  store.setTaskStatus(forkB.id, "completed"); assert.equal(store.readyTasks(job.id).some((item) => item.id === join.id), true);
  assert.throws(() => store.addEdge({ jobId: job.id, fromTaskId: join.id, toTaskId: forkA.id, type: "depends_on", hard: true }), /cycle/);
  assert.equal(store.listEdges(job.id).length, 2);
});

test("先完成的 Task 可独立 Review，P0-P2 退回原 Task 返工", () => {
  const { store, job, task } = fixture(); const fast = task("fast"); const slow = task("slow");
  store.setTaskStatus(fast.id, "reviewing");
  store.addEvidence({ jobId: job.id, taskId: fast.id, runId: "run-fast", kind: "test", summary: "测试通过", producer: "runtime", verdict: "passed" });
  store.addEvidence({ jobId: job.id, taskId: fast.id, runId: "run-review", kind: "review", summary: "独立验收通过", producer: "reviewer", verdict: "passed" });
  assert.deepEqual(store.reviewTask(fast.id), { passed: true, rework: false }); assert.equal(store.getTask(slow.id)?.status, "draft");
  store.addEvidence({ jobId: job.id, taskId: slow.id, runId: "run-review", kind: "review", summary: "发现回归", producer: "reviewer", verdict: "failed", severity: "P2" });
  assert.deepEqual(store.reviewTask(slow.id), { passed: false, rework: true }); assert.equal(store.getTask(slow.id)?.ownerRunId, "run-slow");
});

test("文件 claim 冲突排队，lease 失联后可重派", () => {
  const { store, job, task } = fixture(); const first = task("first", ["src/agents"]); const second = task("second", ["src/agents/store.ts"]);
  store.claimTask(first.id, "worker-1", 1); assert.equal(store.readyTasks(job.id).some((item) => item.id === second.id), false);
  assert.equal(store.recoverExpiredLeases("2026-08-12T00:01:00.000Z")[0]?.id, first.id); assert.equal(store.readyTasks(job.id).some((item) => item.id === second.id), true);
});

test("Shared Board 拒绝敏感内容，只共享结构化事实", () => {
  const { store, job } = fixture();
  const entry = store.publishBoard({ jobId: job.id, producerRunId: "run-a", kind: "fact", title: "版本", summary: "Runtime v3", confidence: "confirmed", visibility: "job" });
  assert.equal(store.listBoard(job.id)[0]?.id, entry.id);
  assert.throws(() => store.publishBoard({ jobId: job.id, producerRunId: "run-a", kind: "fact", title: "token", summary: "secret token=abc", confidence: "confirmed", visibility: "job" }), /Sensitive/);
});

test("Shared Board 保留返工历史但当前视图只返回已通过的最新 attempt", () => {
  const { store, job, task } = fixture();
  const work = task("board-rework");
  store.setTaskOwnerRun(work.id, "run-attempt-1", 1);
  const first = store.publishBoard({ jobId: job.id, producerRunId: "run-attempt-1", taskId: work.id, attempt: 1,
    kind: "summary", title: work.title, summary: "旧结果", confidence: "supported", visibility: "job" });
  assert.deepEqual(store.listCurrentBoard(job.id), []);
  store.setTaskOwnerRun(work.id, "run-attempt-2", 2);
  store.setTaskStatus(work.id, "completed");
  store.addEvidence({ jobId: job.id, taskId: work.id, runId: "run-attempt-2:review", kind: "review",
    summary: "通过", producer: "reviewer", verdict: "passed" });
  const second = store.publishBoard({ jobId: job.id, producerRunId: "run-attempt-2", taskId: work.id, attempt: 2,
    kind: "summary", title: work.title, summary: "新结果", confidence: "confirmed", visibility: "job",
    supersedesBoardEntryId: first.id });
  assert.equal(store.listBoard(job.id).length, 2);
  assert.equal(store.listBoard(job.id)[0]?.supersededByBoardEntryId, second.id);
  assert.deepEqual(store.listCurrentBoard(job.id).map((item) => item.id), [second.id]);
});

test("Return Outbox 首次失败退避、重复创建幂等、重启恢复且仅消费一次", () => {
  const { store, job, task } = fixture(); const child = task("child");
  const input = { jobId: job.id, rootRunId: "run-root", parentRunId: "run-root", childRunId: "run-child", taskId: child.id, sequence: 1, result: { status: "completed" as const, summary: "done", evidenceIds: [], boardEntryIds: [] }, idempotencyKey: `${job.id}:run-child` };
  const envelope = store.createReturn(input); assert.equal(store.createReturn(input).id, envelope.id); assert.equal(store.claimReturn(envelope.id)?.attempts, 1);
  store.retryReturn(envelope.id, 0); assert.equal(store.claimReturn(envelope.id)?.attempts, 2);
  const restored = AgentRuntimeStore.fromSnapshot(store.exportSnapshot()); const pending = restored.listReturns(job.id)[0]!;
  assert.equal(pending.status, "ready"); assert.ok(restored.claimReturn(pending.id)); assert.equal(restored.consumeReturn(pending.id), true); assert.equal(restored.consumeReturn(pending.id), false);
});

test("Return 快照存在 receipt 时即使遗留 delivering 也按 consumed 恢复", () => {
  const { store, job, task } = fixture();
  const child = task("receipt-wins");
  const envelope = store.createReturn({
    jobId: job.id,
    rootRunId: "run-root",
    parentRunId: "run-root",
    childRunId: "run-child",
    taskId: child.id,
    sequence: 1,
    result: { status: "completed", summary: "done", evidenceIds: [], boardEntryIds: [] },
    idempotencyKey: `${job.id}:receipt-wins`,
  });
  store.claimReturn(envelope.id);
  store.consumeReturn(envelope.id);
  const snapshot = store.exportSnapshot();
  snapshot.returns[0]!.status = "delivering";
  delete snapshot.returns[0]!.consumedAt;

  const restored = AgentRuntimeStore.fromSnapshot(snapshot);

  assert.equal(restored.listReturns(job.id)[0]?.status, "consumed");
  assert.equal(restored.claimReturn(envelope.id), undefined);
  assert.equal(restored.recoverInterruptedWork().pendingReturns.length, 0);
});

test("父 continuation 首次失败自动重试，成功持久化后才 Ack", async () => {
  const { store, job, task } = fixture(); const child = task("child");
  const envelope = store.createReturn({ jobId: job.id, rootRunId: "run-root", parentRunId: "run-root", childRunId: "run-child", taskId: child.id, sequence: 1, result: { status: "completed", summary: "done", evidenceIds: [], boardEntryIds: [] }, idempotencyKey: `${job.id}:run-child` });
  let attempts = 0; const persistedStatuses: string[] = [];
  const coordinator = new AgentRuntimeCoordinator({ store, retryDelayMs: () => 0, persist: () => { persistedStatuses.push(store.listReturns(job.id)[0]!.status); } });
  const result = await coordinator.continueParent("turn-a", ["run-child"], async () => { attempts += 1; if (attempts === 1) throw new Error("temporary"); return "final"; });
  assert.equal(result, "final"); assert.equal(attempts, 2); assert.equal(store.listReturns(job.id)[0]?.status, "consumed");
  assert.deepEqual(persistedStatuses, ["delivering", "ready", "delivering", "delivering", "consumed"]);
  assert.equal(store.getJobByTurn("turn-a")?.id, job.id); assert.equal(envelope.status, "ready");
});

test("3 个 Chat 各冻结独立 10/4/3 快照且取消互不影响", () => {
  const store = new AgentRuntimeStore(); const jobs = Array.from({ length: 3 }, (_, index) => store.createJob({ threadId: `chat-${index}`, rootTurnId: `turn-${index}`, rootRunId: `root-${index}`, configSnapshot: DEFAULT_AGENT_TEAM_CONFIG }));
  for (const job of jobs) for (let index = 0; index < 10; index += 1) store.createTask({ jobId: job.id, rootRunId: job.rootRunId, ownerRunId: `${job.id}-run-${index}`, profileId: "tester", title: `task-${index}`, objective: "stress", scope: { allowedPaths: [], deniedPaths: [], nonGoals: [] }, requiredOutputs: [], acceptanceCriteria: [], fileClaims: [], maxAttempts: 1 });
  assert.deepEqual(jobs.map((job) => store.listTasks(job.id).length), [10, 10, 10]); store.cancelJob(jobs[0]!.id);
  assert.equal(store.getJob(jobs[0]!.id)?.status, "cancelled"); assert.deepEqual(jobs.slice(1).map((job) => store.getJob(job.id)?.status), ["planning", "planning"]);
});

test("启动恢复会释放过期 Task lease 并列出待投递 Return", () => {
  const { store, job, task } = fixture(); const child = task("recover"); store.claimTask(child.id, "worker", 1);
  const envelope = store.createReturn({ jobId: job.id, rootRunId: "run-root", parentRunId: "run-root", childRunId: "run-child", taskId: child.id, sequence: 1,
    result: { status: "completed", summary: "ready", evidenceIds: [], boardEntryIds: [] }, idempotencyKey: `${job.id}:recover` });
  const recovered = store.recoverInterruptedWork("2026-08-12T01:00:00.000Z");
  assert.equal(recovered.lostTasks[0]?.status, "lost"); assert.equal(recovered.pendingReturns[0]?.id, envelope.id);
});

test("失败 Task 的 Return 即使已经消费，Job 也绝不能变成 completed", () => {
  const { store, job, task } = fixture();
  const failed = task("failed-worker");
  store.setTaskStatus(failed.id, "failed");
  const envelope = store.createReturn({ jobId: job.id, rootRunId: "run-root", parentRunId: "run-root", childRunId: failed.ownerRunId,
    taskId: failed.id, sequence: 0, result: { status: "failed", summary: "worker failed", evidenceIds: [], boardEntryIds: [] },
    idempotencyKey: `${job.id}:${failed.ownerRunId}` });
  store.claimReturn(envelope.id); store.consumeReturn(envelope.id);

  assert.equal(store.reconcileJobStatus(job.id), "failed");
  assert.equal(store.getJob(job.id)?.status, "failed");
});

test("只有所有必需 Task 完成且存在独立 Review 通过证据时 Job 才 completed", () => {
  const { store, job, task } = fixture(); const worker = task("verified-worker");
  store.setTaskStatus(worker.id, "completed");
  assert.equal(store.reconcileJobStatus(job.id), "failed");
  store.addEvidence({ jobId: job.id, taskId: worker.id, runId: "review-1", kind: "review", summary: "accepted", producer: "reviewer", verdict: "passed" });
  assert.equal(store.reconcileJobStatus(job.id), "completed");
});

test("重启恢复只消费失败 Return，不重新调用父 Agent或派发第二套任务", async () => {
  const { store, job, task } = fixture(); const failed = task("recover-failed");
  store.setTaskStatus(failed.id, "failed");
  store.createReturn({ jobId: job.id, rootRunId: "run-root", parentRunId: "run-root", childRunId: failed.ownerRunId,
    taskId: failed.id, sequence: 0, result: { status: "failed", summary: "failed once", evidenceIds: [], boardEntryIds: [] },
    idempotencyKey: `${job.id}:${failed.ownerRunId}` });
  let deliveries = 0;
  const coordinator = new AgentRuntimeCoordinator({ store, retryDelayMs: () => 0 });
  await coordinator.recoverPendingReturns(async () => { deliveries += 1; return "unexpected"; });

  assert.equal(deliveries, 0);
  assert.equal(store.listReturns(job.id)[0]?.status, "consumed");
  assert.equal(store.getJob(job.id)?.status, "failed");
});

test("加载旧快照后会重新校正曾被错误标成 completed 的失败 Job", () => {
  const { store, job, task } = fixture(); const failed = task("legacy-failed");
  store.setTaskStatus(failed.id, "failed"); store.setJobStatus(job.id, "completed");
  const restored = AgentRuntimeStore.fromSnapshot(store.exportSnapshot());
  restored.reconcilePersistedJobs();
  assert.equal(restored.getJob(job.id)?.status, "failed");
});

test("同一 Job 新 attempt 忽略旧失败 Task，并保留旧 Evidence", () => {
  const { store, job, task } = fixture();
  const first = task("attempt-one");
  store.setTaskStatus(first.id, "failed");
  store.addEvidence({ jobId: job.id, taskId: first.id, runId: first.ownerRunId, kind: "summary",
    summary: "首轮失败证据", producer: "worker", verdict: "failed" });
  store.failJob(job.id, "failed", "agent_failed");
  const retried = store.startJobAttempt(job.id, "turn-retry", "run-retry");
  assert.equal(retried.id, job.id);
  assert.equal(retried.attempt, 2);
  assert.equal(retried.rootTurnId, "turn-retry");
  const second = task("attempt-two");
  assert.equal(second.jobAttempt, 2);
  store.setTaskStatus(second.id, "completed");
  store.addEvidence({ jobId: job.id, taskId: second.id, runId: "review-second", kind: "review",
    summary: "重试通过", producer: "reviewer", verdict: "passed" });
  assert.equal(store.reconcileJobStatus(job.id), "completed");
  assert.equal(store.listEvidence(first.id)[0]?.summary, "首轮失败证据");
});

test("Job 终态一次性关闭全部活动 Agent Run，已完成证据不倒退", () => {
  const runs = new AgentRunStore();
  const root = runs.ensureRoot("thread-close", "turn-close", "orchestrator", "job-close");
  const completed = runs.create({ jobId: root.jobId, threadId: "child-done", turnId: "turn-done",
    agentProfileId: "investigator", parentRunId: root.id, task: "已完成", depth: 1 });
  const queued = runs.create({ jobId: root.jobId, threadId: "child-queued", turnId: "turn-queued",
    agentProfileId: "reviewer", parentRunId: root.id, task: "仍排队", depth: 1 });
  runs.complete(completed.id, { runId: completed.id, status: "completed", summary: "有效证据" });
  runs.setStatus(root.id, "running");
  const closed = runs.closeActiveForJob(root.jobId, "failed", "Job 失败", "可重试");
  assert.deepEqual(closed.map((run) => run.id).sort(), [queued.id, root.id].sort());
  assert.equal(runs.get(completed.id)?.status, "completed");
  assert.equal(runs.get(completed.id)?.result?.summary, "有效证据");
  assert.equal(runs.listForJob(root.jobId).some((run) =>
    ["queued", "running", "waiting_children", "resuming"].includes(run.status)), false);
});

test("Agent Run 的 Thread 视图递归包含全部后代且隔离无关 Job", () => {
  const runs = new AgentRunStore();
  const root = runs.ensureRoot("thread-tree", "turn-root", "orchestrator", "job-tree");
  const child = runs.create({ jobId: root.jobId, threadId: "thread-child", turnId: "turn-child",
    agentProfileId: "coder", parentRunId: root.id, task: "child", depth: 1 });
  const grandchild = runs.create({ jobId: root.jobId, threadId: "thread-grandchild", turnId: "turn-grandchild",
    agentProfileId: "tester", parentRunId: child.id, task: "grandchild", depth: 2 });
  runs.ensureRoot("thread-other", "turn-other", "orchestrator", "job-other");

  assert.deepEqual(runs.listForThread("thread-tree").map((run) => run.id), [root.id, child.id, grandchild.id]);
  assert.deepEqual(runs.listForThread("missing-thread"), []);
  assert.equal(runs.isChildThread("thread-child"), true);
  assert.equal(runs.findWorkerThread(root.jobId, child.taskId ?? ""), undefined);
});

test("父 continuation 在无待消费 Return 时直接执行且不进入交付锁", async () => {
  const { store, job, task } = fixture();
  const child = task("already-consumed");
  const envelope = store.createReturn({
    jobId: job.id, rootRunId: "run-root", parentRunId: "run-root", childRunId: child.ownerRunId,
    taskId: child.id, sequence: 1,
    result: { status: "completed", summary: "done", evidenceIds: [], boardEntryIds: [] },
    idempotencyKey: `${job.id}:already-consumed`,
  });
  store.claimReturn(envelope.id); store.consumeReturn(envelope.id);
  let calls = 0;
  const coordinator = new AgentRuntimeCoordinator({ store });
  assert.equal(await coordinator.continueParent("missing-turn", [], async () => ++calls), 1);
  assert.equal(await coordinator.continueParent(job.rootTurnId, [child.ownerRunId], async () => ++calls), 2);
  assert.equal(calls, 2);
});

test("待投递 Return 恢复失败会退回 ready，已提交 receipt 则绝不回滚", async () => {
  const createPending = () => {
    const setup = fixture(); const child = setup.task("recover-completed");
    const envelope = setup.store.createReturn({
      jobId: setup.job.id, rootRunId: "run-root", parentRunId: "run-root", childRunId: child.ownerRunId,
      taskId: child.id, sequence: 1,
      result: { status: "completed" as const, summary: "done", evidenceIds: [], boardEntryIds: [] },
      idempotencyKey: `${setup.job.id}:recover-completed`,
    });
    return { ...setup, envelope };
  };

  const retryable = createPending();
  const originalWrite = process.stderr.write;
  let diagnostic = "";
  process.stderr.write = ((chunk: string | Uint8Array) => { diagnostic += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    const coordinator = new AgentRuntimeCoordinator({ store: retryable.store, retryDelayMs: () => 0 });
    assert.deepEqual(await coordinator.recoverPendingReturns(async () => { throw new Error("temporary delivery outage"); }, () => true), []);
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.equal(retryable.store.listReturns(retryable.job.id)[0]?.status, "ready");
  assert.equal(retryable.store.getJob(retryable.job.id)?.status, "waiting_returns");
  assert.match(diagnostic, /pending Return recovery deferred: temporary delivery outage/);

  const committed = createPending();
  const committedCoordinator = new AgentRuntimeCoordinator({ store: committed.store, retryDelayMs: () => 0 });
  await assert.rejects(
    committedCoordinator.recoverPendingReturns(async (_job, returns) => {
      committed.store.consumeReturn(returns[0]!.id);
      throw new Error("save failed after receipt");
    }, () => true),
    /save failed after receipt/,
  );
  assert.equal(committed.store.listReturns(committed.job.id)[0]?.status, "consumed");
});

test("执行租约被占用时 fail closed，成功持有时只交付一次", async () => {
  const waiting = fixture(); const waitingTask = waiting.task("lease-wait");
  waiting.store.createReturn({ jobId: waiting.job.id, rootRunId: "run-root", parentRunId: "run-root", childRunId: waitingTask.ownerRunId,
    taskId: waitingTask.id, sequence: 1, result: { status: "completed", summary: "done", evidenceIds: [], boardEntryIds: [] },
    idempotencyKey: `${waiting.job.id}:lease-wait` });
  const waitingLease = { runWithJobLease: async () => ({ status: "waiting" as const }) };
  const waitingCoordinator = new AgentRuntimeCoordinator({ store: waiting.store, executionLeases: waitingLease as never });
  await assert.rejects(
    waitingCoordinator.recoverPendingReturns(async () => "never", () => true),
    /waiting for its active execution owner/,
  );

  const acquired = fixture(); const acquiredTask = acquired.task("lease-acquired");
  acquired.store.createReturn({ jobId: acquired.job.id, rootRunId: "run-root", parentRunId: "run-root", childRunId: acquiredTask.ownerRunId,
    taskId: acquiredTask.id, sequence: 1, result: { status: "completed", summary: "done", evidenceIds: [], boardEntryIds: [] },
    idempotencyKey: `${acquired.job.id}:lease-acquired` });
  let deliveries = 0;
  const acquiredLease = { runWithJobLease: async (_jobId: string, operation: () => Promise<unknown>) => ({
    status: "acquired" as const, context: {}, value: await operation(),
  }) };
  const acquiredCoordinator = new AgentRuntimeCoordinator({ store: acquired.store, executionLeases: acquiredLease as never });
  assert.deepEqual(await acquiredCoordinator.recoverPendingReturns(async () => ++deliveries, () => true), [1]);
  assert.equal(deliveries, 1);
});

test("AgentRuntime Job 重试、父子 Task、租约与批量关闭边界 fail closed", () => {
  const first = fixture();
  first.store.setJobStatus(first.job.id, "completed");
  assert.throws(() => first.store.rebindJobTurn(first.job.id, "turn-other"), /Terminal Job cannot/);

  const active = fixture();
  assert.throws(() => active.store.startJobAttempt(active.job.id, "turn-new", "run-new"),
    /Only a terminal failed Job/);
  const pending = active.task("pending-return");
  const envelope = active.store.createReturn({ jobId: active.job.id, rootRunId: "run-root", parentRunId: "run-root",
    childRunId: pending.ownerRunId, taskId: pending.id, sequence: 1,
    result: { status: "completed", summary: "pending", evidenceIds: [], boardEntryIds: [] },
    idempotencyKey: `${active.job.id}:pending-retry` });
  active.store.failJob(active.job.id, "failed", "retryable");
  active.store.startJobAttempt(active.job.id, "turn-new", "run-new");
  assert.equal(active.store.listReturns(active.job.id).find((item) => item.id === envelope.id)?.status, "failed");

  const other = active.store.createJob({ threadId: "other", rootTurnId: "other-turn", rootRunId: "other-run",
    configSnapshot: DEFAULT_AGENT_TEAM_CONFIG });
  const otherParent = active.store.createTask({ jobId: other.id, rootRunId: other.rootRunId, ownerRunId: "other-owner",
    profileId: "coder", title: "other", objective: "other", scope: { allowedPaths: [], deniedPaths: [], nonGoals: [] },
    requiredOutputs: [], acceptanceCriteria: [], fileClaims: [], maxAttempts: 1 });
  assert.throws(() => active.store.createTask({ jobId: active.job.id, rootRunId: active.job.rootRunId,
    ownerRunId: "bad-child", parentTaskId: otherParent.id, profileId: "tester", title: "cross", objective: "cross",
    scope: { allowedPaths: [], deniedPaths: [], nonGoals: [] }, requiredOutputs: [], acceptanceCriteria: [], fileClaims: [], maxAttempts: 1 }),
    /Cross-job parent task/);

  const task = active.task("lease-boundary");
  assert.throws(() => active.store.heartbeat(task.id, "wrong"), /Task lease owner mismatch/);
  active.store.claimTask(task.id, "owner", 1000);
  assert.equal(active.store.heartbeat(task.id, "owner", 2000).leaseOwner, "owner");
  assert.deepEqual(active.store.listRunsForTask(task.id), [task.ownerRunId]);
  assert.deepEqual(active.store.closeTasks([task.id]).map((item) => item.status), ["cancelled"]);
  assert.deepEqual(active.store.closeTasks([task.id]), []);
});

test("Stage 重试达到上限后拒绝继续创建 Checkpoint", () => {
  const { store, job } = fixture();
  const first = store.beginStage(job.id, "bounded", 1);
  store.setStageStatus(first.idempotencyKey, "failed_retryable");
  assert.throws(() => store.beginStage(job.id, "bounded", 1, true), (error: unknown) =>
    error instanceof Error && (error as Error & { code?: string }).code === "stage_retry_exhausted");
});

test("重复恢复请求按 requirement 或 root Turn 幂等，不复制 Job 且冻结首次绑定", () => {
  const store = new AgentRuntimeStore();
  const first = store.createJob({ threadId: "thread-first", rootTurnId: "turn-first", rootRunId: "run-first", configSnapshot: DEFAULT_AGENT_TEAM_CONFIG,
    requirementId: "requirement-idempotent", requirementRevision: 1 });
  const duplicateRequirement = store.createJob({ threadId: "thread-second", rootTurnId: "turn-second", rootRunId: "run-second", configSnapshot: { ...DEFAULT_AGENT_TEAM_CONFIG, accessMode: "read_only" },
    requirementId: "requirement-idempotent", requirementRevision: 1 });
  assert.equal(duplicateRequirement.id, first.id);
  assert.equal(store.getJob(first.id)?.threadId, "thread-first");
  const duplicateTurn = store.createJob({ threadId: "thread-first", rootTurnId: "turn-first", rootRunId: "run-third", configSnapshot: DEFAULT_AGENT_TEAM_CONFIG });
  assert.equal(duplicateTurn.id, first.id);
  const detached = store.getJob(first.id)!;
  detached.configSnapshot.accessMode = "full_access";
  assert.equal(store.getJob(first.id)?.configSnapshot.accessMode, DEFAULT_AGENT_TEAM_CONFIG.accessMode);
});

test("Job 只有非终态允许重新绑定 Turn，所有终态都拒绝迟到回绑", () => {
  for (const status of ["planning", "running", "reviewing", "waiting_returns"] as const) {
    const store = new AgentRuntimeStore();
    const job = store.createJob({ threadId: `thread-${status}`, rootTurnId: `turn-${status}`, rootRunId: "run", configSnapshot: DEFAULT_AGENT_TEAM_CONFIG });
    store.setJobStatus(job.id, status);
    assert.equal(store.rebindJobTurn(job.id, `turn-${status}-next`).rootTurnId, `turn-${status}-next`);
  }
  for (const status of ["completed", "partial", "failed", "cancelled"] as const) {
    const store = new AgentRuntimeStore();
    const job = store.createJob({ threadId: `thread-${status}`, rootTurnId: `turn-${status}`, rootRunId: "run", configSnapshot: DEFAULT_AGENT_TEAM_CONFIG });
    store.setJobStatus(job.id, status);
    assert.throws(() => store.rebindJobTurn(job.id, "late-turn"), /Terminal Job cannot be rebound/);
  }
});

test("Job attempt 只接受 failed/cancelled/partial，重复 root Turn 不递增且旧 Return 失效", () => {
  for (const status of ["failed", "cancelled", "partial"] as const) {
    const store = new AgentRuntimeStore();
    const job = store.createJob({ threadId: `thread-attempt-${status}`, rootTurnId: "turn-old", rootRunId: "run-old", configSnapshot: DEFAULT_AGENT_TEAM_CONFIG });
    const task = store.createTask({ jobId: job.id, rootRunId: job.rootRunId, ownerRunId: "worker", profileId: "coder", title: "old", objective: "old",
      scope: { allowedPaths: [], deniedPaths: [], nonGoals: [] }, requiredOutputs: [], acceptanceCriteria: [], fileClaims: [], maxAttempts: 1 });
    const oldReturn = store.createReturn({ jobId: job.id, rootRunId: job.rootRunId, parentRunId: job.rootRunId, childRunId: task.ownerRunId, taskId: task.id, sequence: 1,
      result: { status: "completed", summary: "old", evidenceIds: [], boardEntryIds: [] }, idempotencyKey: `${job.id}:old` });
    store.setJobStatus(job.id, status);
    const retried = store.startJobAttempt(job.id, "turn-new", "run-new");
    assert.equal(retried.attempt, 2);
    assert.equal(store.listReturns(job.id).find((item) => item.id === oldReturn.id)?.status, "failed");
    assert.equal(store.startJobAttempt(job.id, "turn-new", "run-different").attempt, 2);
  }
  const active = fixture();
  assert.throws(() => active.store.startJobAttempt(active.job.id, "turn-new", "run-new"), /Only a terminal failed Job/);
  active.store.setJobStatus(active.job.id, "completed");
  assert.throws(() => active.store.startJobAttempt(active.job.id, "turn-new", "run-new"), /Only a terminal failed Job/);
});

test("cancelJob 关闭活动 Task/Return/Stage，但不倒退已完成事实", () => {
  const { store, job, task } = fixture();
  const draft = task("cancel-draft");
  const running = task("cancel-running");
  const completed = task("cancel-completed");
  const failed = task("cancel-failed");
  store.setTaskStatus(running.id, "running");
  store.setTaskStatus(completed.id, "completed");
  store.setTaskStatus(failed.id, "failed");
  const readyReturn = store.createReturn({ jobId: job.id, rootRunId: job.rootRunId, parentRunId: job.rootRunId, childRunId: draft.ownerRunId, taskId: draft.id, sequence: 1,
    result: { status: "completed", summary: "ready", evidenceIds: [], boardEntryIds: [] }, idempotencyKey: `${job.id}:ready` });
  const consumedReturn = store.createReturn({ jobId: job.id, rootRunId: job.rootRunId, parentRunId: job.rootRunId, childRunId: completed.ownerRunId, taskId: completed.id, sequence: 2,
    result: { status: "completed", summary: "consumed", evidenceIds: [], boardEntryIds: [] }, idempotencyKey: `${job.id}:consumed` });
  store.claimReturn(consumedReturn.id); store.consumeReturn(consumedReturn.id);
  const runningStage = store.beginStage(job.id, "cancel-running-stage");
  const validatingStage = store.beginStage(job.id, "cancel-validating-stage");
  store.setStageStatus(validatingStage.idempotencyKey, "validating");
  const completedStage = store.beginStage(job.id, "cancel-completed-stage");
  store.setStageStatus(completedStage.idempotencyKey, "validating");
  store.setStageStatus(completedStage.idempotencyKey, "completed");

  store.cancelJob(job.id);

  assert.equal(store.getJob(job.id)?.status, "cancelled");
  assert.equal(store.getTask(draft.id)?.status, "cancelled");
  assert.equal(store.getTask(running.id)?.status, "cancelled");
  assert.equal(store.getTask(completed.id)?.status, "completed");
  assert.equal(store.getTask(failed.id)?.status, "failed");
  assert.equal(store.listReturns(job.id).find((item) => item.id === readyReturn.id)?.status, "failed");
  assert.equal(store.listReturns(job.id).find((item) => item.id === consumedReturn.id)?.status, "consumed");
  assert.equal(store.listStageCheckpoints(job.id).find((item) => item.idempotencyKey === runningStage.idempotencyKey)?.status, "failed_terminal");
  assert.equal(store.listStageCheckpoints(job.id).find((item) => item.idempotencyKey === validatingStage.idempotencyKey)?.failureCode, "user_cancelled");
  assert.equal(store.listStageCheckpoints(job.id).find((item) => item.idempotencyKey === completedStage.idempotencyKey)?.status, "completed");
});

test("cancelled Job 在迟到 reconcile 中保持 cancelled，不被 pending Return 或 Task 重开", () => {
  const { store, job, task } = fixture();
  const pendingTask = task("late-return");
  const pending = store.createReturn({ jobId: job.id, rootRunId: job.rootRunId, parentRunId: job.rootRunId, childRunId: pendingTask.ownerRunId, taskId: pendingTask.id, sequence: 1,
    result: { status: "completed", summary: "late", evidenceIds: [], boardEntryIds: [] }, idempotencyKey: `${job.id}:late` });
  store.cancelJob(job.id);
  assert.equal(store.reconcileJobStatus(job.id), "cancelled");
  assert.equal(store.getJob(job.id)?.status, "cancelled");
  assert.equal(store.listReturns(job.id).find((item) => item.id === pending.id)?.status, "failed");
});

test("reconcileJobStatus 对空 Job、未完成 Task、reviewing Task 和 delivering Return 分别 fail closed", () => {
  const empty = fixture();
  assert.equal(empty.store.reconcileJobStatus(empty.job.id), "planning");

  const running = fixture();
  const runningTask = running.task("reconcile-running");
  assert.equal(running.store.reconcileJobStatus(running.job.id), "running");
  assert.equal(running.store.getTask(runningTask.id)?.status, "draft");

  const reviewing = fixture();
  const reviewTask = reviewing.task("reconcile-review");
  reviewing.store.setTaskStatus(reviewTask.id, "reviewing");
  assert.equal(reviewing.store.reconcileJobStatus(reviewing.job.id), "reviewing");

  const delivering = fixture();
  const deliverTask = delivering.task("reconcile-delivering");
  const envelope = delivering.store.createReturn({ jobId: delivering.job.id, rootRunId: delivering.job.rootRunId, parentRunId: delivering.job.rootRunId, childRunId: deliverTask.ownerRunId, taskId: deliverTask.id, sequence: 1,
    result: { status: "completed", summary: "delivering", evidenceIds: [], boardEntryIds: [] }, idempotencyKey: `${delivering.job.id}:delivering` });
  delivering.store.claimReturn(envelope.id);
  assert.equal(delivering.store.reconcileJobStatus(delivering.job.id), "waiting_returns");
});

test("过期 lease 只回收到期 Task 与指定 Job，未到期和其他 Job 保持 claimed", () => {
  let now = "2026-08-12T00:00:00.000Z";
  const store = new AgentRuntimeStore(() => now);
  const job = store.createJob({ threadId: "lease-thread", rootTurnId: "lease-turn", rootRunId: "lease-run", configSnapshot: DEFAULT_AGENT_TEAM_CONFIG });
  const expired = store.createTask({ jobId: job.id, rootRunId: job.rootRunId, ownerRunId: "expired-worker", profileId: "coder", title: "expired", objective: "expired",
    scope: { allowedPaths: [], deniedPaths: [], nonGoals: [] }, requiredOutputs: [], acceptanceCriteria: [], fileClaims: ["src/expired.ts"], maxAttempts: 1 });
  const live = store.createTask({ jobId: job.id, rootRunId: job.rootRunId, ownerRunId: "live-worker", profileId: "coder", title: "live", objective: "live",
    scope: { allowedPaths: [], deniedPaths: [], nonGoals: [] }, requiredOutputs: [], acceptanceCriteria: [], fileClaims: ["src/live.ts"], maxAttempts: 1 });
  store.claimTask(expired.id, "worker-expired", 1);
  store.claimTask(live.id, "worker-live", 60_000);
  store.setTaskStatus(live.id, "running");
  const other = store.createJob({ threadId: "other-thread", rootTurnId: "other-turn", rootRunId: "other-run", configSnapshot: DEFAULT_AGENT_TEAM_CONFIG });
  const otherTask = store.createTask({ jobId: other.id, rootRunId: other.rootRunId, ownerRunId: "other-worker", profileId: "coder", title: "other", objective: "other",
    scope: { allowedPaths: [], deniedPaths: [], nonGoals: [] }, requiredOutputs: [], acceptanceCriteria: [], fileClaims: ["src/other.ts"], maxAttempts: 1 });
  store.claimTask(otherTask.id, "worker-other", 1);

  now = "2026-08-12T00:00:02.000Z";
  const recovered = store.recoverExpiredLeases(now, job.id);
  assert.deepEqual(recovered.map((item) => item.id), [expired.id]);
  assert.equal(store.getTask(expired.id)?.status, "lost");
  assert.equal(store.getTask(live.id)?.status, "running");
  assert.equal(store.getTask(otherTask.id)?.status, "claimed");
  assert.equal(store.recoverExpiredLeases(now, job.id).length, 0);
});

test("Return claim/ retry/consume 状态机拒绝提前消费并尊重未来退避时间", () => {
  const { store, job, task } = fixture();
  const retryTask = task("retry-state");
  const envelope = store.createReturn({ jobId: job.id, rootRunId: job.rootRunId, parentRunId: job.rootRunId, childRunId: retryTask.ownerRunId, taskId: retryTask.id, sequence: 1,
    result: { status: "completed", summary: "retry", evidenceIds: [], boardEntryIds: [] }, idempotencyKey: `${job.id}:retry-state` });
  assert.throws(() => store.consumeReturn(envelope.id), /Return is not delivering/);
  assert.equal(store.claimReturn(envelope.id)?.status, "delivering");
  store.retryReturn(envelope.id, 60_000);
  assert.equal(store.claimReturn(envelope.id), undefined);
  assert.throws(() => store.consumeReturn(envelope.id), /Return is not delivering/);
  store.failReturn(envelope.id);
  assert.equal(store.listReturns(job.id)[0]?.status, "failed");
  assert.equal(store.claimReturn(envelope.id), undefined);
  store.failReturn(envelope.id);
  assert.equal(store.listReturns(job.id)[0]?.status, "failed");
});

test("重启恢复无 receipt 的 delivering Return 为 ready，有 receipt 的 Return 仍只可消费一次", () => {
  const { store, job, task } = fixture();
  const noReceiptTask = task("no-receipt");
  const noReceipt = store.createReturn({ jobId: job.id, rootRunId: job.rootRunId, parentRunId: job.rootRunId, childRunId: noReceiptTask.ownerRunId, taskId: noReceiptTask.id, sequence: 1,
    result: { status: "completed", summary: "no receipt", evidenceIds: [], boardEntryIds: [] }, idempotencyKey: `${job.id}:no-receipt` });
  store.claimReturn(noReceipt.id);
  const snapshot = store.exportSnapshot();
  const restored = AgentRuntimeStore.fromSnapshot(snapshot);
  assert.equal(restored.listReturns(job.id)[0]?.status, "ready");
  assert.equal(restored.recoverInterruptedWork().pendingReturns[0]?.id, noReceipt.id);
  assert.equal(restored.claimReturn(noReceipt.id)?.attempts, 2);
  assert.equal(restored.consumeReturn(noReceipt.id), true);
  assert.equal(restored.consumeReturn(noReceipt.id), false);
});

test("Dynamic execution generation 单调递增并在快照恢复后保持，非 dynamic Job 拒绝写入", () => {
  const { store, job } = fixture();
  const first = store.setDynamicExecution({ jobId: job.id, jobAttempt: 1, phase: "parent_running", recoveryAction: "explicit_model_resume", reason: "first", taskIds: [], returnIds: [] });
  const second = store.setDynamicExecution({ jobId: job.id, jobAttempt: 1, phase: "waiting_user", recoveryAction: "wait_user", reason: "blocked", taskIds: [], returnIds: [] });
  assert.equal(first.generation, 1);
  assert.equal(second.generation, 2);
  const restored = AgentRuntimeStore.fromSnapshot(store.exportSnapshot());
  assert.deepEqual(restored.getDynamicExecution(job.id), second);
  const teamJob = store.createJob({ threadId: "team-thread", rootTurnId: "team-turn", rootRunId: "team-run", configSnapshot: DEFAULT_AGENT_TEAM_CONFIG,
    executionKind: "software_product_delivery", workflowVersion: "software_product_delivery_v3" });
  assert.throws(() => store.setDynamicExecution({ jobId: teamJob.id, jobAttempt: 1, phase: "parent_running", recoveryAction: "explicit_model_resume", reason: "wrong engine", taskIds: [], returnIds: [] }), /requires a dynamic Job/);
});

test("Stage Checkpoint 恢复只允许合法顺序，重复 begin 幂等，失败可 force 新 attempt", () => {
  const { store, job } = fixture();
  const first = store.beginStage(job.id, "recover-stage", 3);
  assert.equal(store.beginStage(job.id, "recover-stage", 3).idempotencyKey, first.idempotencyKey);
  assert.throws(() => store.setStageStatus(first.idempotencyKey, "completed"), /Invalid stage transition/);
  store.setStageStatus(first.idempotencyKey, "validating");
  assert.throws(() => store.setStageStatus(first.idempotencyKey, "validating"), /Invalid stage transition/);
  store.setStageStatus(first.idempotencyKey, "failed_retryable", "provider_late");
  const second = store.beginStage(job.id, "recover-stage", 3, true);
  assert.equal(second.stageAttempt, 2);
  store.setStageStatus(second.idempotencyKey, "failed_terminal", "terminal");
  assert.equal(store.beginStage(job.id, "recover-stage", 3, true).idempotencyKey, second.idempotencyKey);
  const limited = store.beginStage(job.id, "limited-stage", 1);
  store.setStageStatus(limited.idempotencyKey, "failed_retryable");
  assert.throws(() => store.beginStage(job.id, "limited-stage", 1, true), /Stage retry exhausted/);
});

test("终态 Job reconcilePersistedJobs 不被迟到 Task/Checkpoint 重新打开", () => {
  for (const status of ["failed", "partial", "cancelled"] as const) {
    const { store, job, task } = fixture();
    const lateTask = task("late-task");
    store.setTaskStatus(lateTask.id, "running");
    store.setJobStatus(job.id, status);
    store.reconcilePersistedJobs(job.id);
    assert.equal(store.getJob(job.id)?.status, status);
  }
  const completed = fixture();
  const completedTask = completed.task("late-completed");
  completed.store.setTaskStatus(completedTask.id, "completed");
  completed.store.setJobStatus(completed.job.id, "completed");
  completed.store.reconcilePersistedJobs(completed.job.id);
  assert.equal(completed.store.getJob(completed.job.id)?.status, "failed");
});
