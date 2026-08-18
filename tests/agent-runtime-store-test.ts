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
