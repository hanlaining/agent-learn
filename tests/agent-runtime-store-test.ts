import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntimeStore } from "../src/agents/agent-runtime-store.js";
import { DEFAULT_AGENT_TEAM_CONFIG } from "../src/agents/agent-runtime.js";
import { AgentRuntimeCoordinator } from "../src/agents/agent-runtime-coordinator.js";

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
