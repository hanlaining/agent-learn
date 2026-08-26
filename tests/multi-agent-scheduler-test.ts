import assert from "node:assert/strict";
import test from "node:test";
import "./agent-runtime-store-test.js";
import "./tool-schema-test.js";
import "./agent-registry-test.js";

import { AgentRegistry } from "../src/agents/agent-registry.js";
import { AgentRunStore } from "../src/agents/agent-run-store.js";
import { MultiAgentScheduler } from "../src/agents/multi-agent-scheduler.js";
import { AgentRuntimeStore } from "../src/agents/agent-runtime-store.js";
import { DEFAULT_AGENT_TEAM_CONFIG } from "../src/agents/agent-runtime.js";
import { AgentLoop } from "../src/agent/agent-loop.js";
import { AgentRuntimeCoordinator } from "../src/agents/agent-runtime-coordinator.js";
import { ensureFixedSoftwareTeam } from "../src/agents/fixed-software-team.js";
import { LifecycleStore } from "../src/runtime/lifecycle-store.js";
import { createRunAgentTool } from "../src/tools/run-agent-tool.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { ScriptedLlmProvider } from "./helpers/scripted-llm.js";

test("多个子 Agent 并行完成并自动 run_return，重复回传被忽略", async () => {
  const store = new AgentRunStore();
  let active = 0;
  let peak = 0;
  const releases: Array<() => void> = [];
  let turnSequence = 0;
  const scheduler = new MultiAgentScheduler({
    registry: new AgentRegistry(), store,
    resolveParent: () => ({ threadId: "thread-parent" }),
    maxConcurrentRuns: 3,
    prepare: (_profile, task) => ({
      threadId: `thread-child-${++turnSequence}`,
      turnId: `turn-child-${turnSequence}`,
      execute: async () => {
        active += 1; peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1; return `completed: ${task}`;
      },
    }),
  });
  const runs = ["A", "B", "C"].map((task) => scheduler.runAgent({
    parentTurnId: "turn-parent", profileId: "tester", task,
  }));
  while (releases.length < 3) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(peak, 3);
  releases.splice(0).forEach((release) => release());
  const results = await Promise.all(runs);
  assert.equal(results.every((result) => result.status === "completed"), true);
  assert.equal(store.list().filter((run) => run.parentRunId !== undefined).length, 3);
  assert.equal(store.receiveReturn(results[0]!), false);
});

test("并发上限会排队", async () => {
  const store = new AgentRunStore();
  let active = 0;
  let peak = 0;
  let sequence = 0;
  const scheduler = new MultiAgentScheduler({
    registry: new AgentRegistry(), store,
    resolveParent: (turnId) => ({ threadId: `thread-${turnId}` }),
    maxConcurrentRuns: 2,
    prepare: () => ({
      threadId: `child-${++sequence}`, turnId: `turn-${sequence}`,
      execute: async () => { active += 1; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 5)); active -= 1; return "ok"; },
    }),
  });
  await Promise.all(Array.from({ length: 6 }, (_, index) => scheduler.runAgent({
    parentTurnId: `parent-${index}`, profileId: "investigator", task: `task-${index}`,
  })));
  assert.equal(peak, 2);
});

test("3 Chat 各 3 个子 Agent 在全局上限内并行回传", async () => {
  const store = new AgentRunStore();
  let active = 0;
  let peak = 0;
  let sequence = 0;
  const scheduler = new MultiAgentScheduler({
    registry: new AgentRegistry(), store, maxConcurrentRuns: 4,
    resolveParent: (turnId) => ({ threadId: turnId.replace("turn", "thread") }),
    prepare: (_profile, task) => ({
      threadId: `child-thread-${++sequence}`, turnId: `child-turn-${sequence}`,
      execute: async () => {
        active += 1; peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 8));
        active -= 1; return `returned ${task}`;
      },
    }),
  });
  const results = await Promise.all(
    Array.from({ length: 3 }, (_, chat) =>
      Array.from({ length: 3 }, (_, agent) => scheduler.runAgent({
        parentTurnId: `turn-${chat + 1}`,
        profileId: agent === 0 ? "investigator" : agent === 1 ? "coder" : "tester",
        task: `chat-${chat + 1}-agent-${agent + 1}`,
      })),
    ).flat(),
  );
  assert.equal(results.length, 9);
  assert.equal(results.every((result) => result.status === "completed"), true);
  assert.equal(peak, 4);
  assert.equal(store.exportSnapshot().returnReceipts.length, 9);
});

test("父 Agent 取消会级联取消全部后代", async () => {
  const store = new AgentRunStore();
  const root = store.ensureRoot("thread-root", "turn-root");
  const child = store.create({ threadId: "thread-child", turnId: "turn-child", agentProfileId: "coder", parentRunId: root.id, task: "child", depth: 1 });
  const grandchild = store.create({ threadId: "thread-grandchild", turnId: "turn-grandchild", agentProfileId: "tester", parentRunId: child.id, task: "grandchild", depth: 2 });
  store.setStatus(child.id, "running");
  store.setStatus(grandchild.id, "running");
  const cancelled: string[] = [];
  const scheduler = new MultiAgentScheduler({
    registry: new AgentRegistry(), store,
    resolveParent: () => ({ threadId: "thread-root" }),
    prepare: () => { throw new Error("unused"); },
  });
  assert.equal(scheduler.cancelChildren("turn-root", (turnId) => { cancelled.push(turnId); return true; }), 2);
  assert.deepEqual(cancelled, ["turn-child", "turn-grandchild"]);
  assert.equal(store.get(child.id)?.status, "cancelled");
  assert.equal(store.get(grandchild.id)?.status, "cancelled");
});

test("子 Agent 再委派时继承同一 Job 的总预算和快照", async () => {
  const store = new AgentRunStore(); const runtimeStore = new AgentRuntimeStore();
  const root = store.ensureRoot("thread-root", "turn-root");
  const job = runtimeStore.createJob({ threadId: "thread-root", rootTurnId: "turn-root", rootRunId: root.id, configSnapshot: { ...DEFAULT_AGENT_TEAM_CONFIG, maxSubagents: 2 } });
  const child = store.create({ jobId: job.id, threadId: "thread-child", turnId: "turn-child", agentProfileId: "investigator", parentRunId: root.id, task: "child", depth: 1 });
  const scheduler = new MultiAgentScheduler({ registry: new AgentRegistry(), store, runtimeStore,
    resolveParent: (turnId) => ({ threadId: turnId === "turn-child" ? "thread-child" : "thread-root" }),
    prepare: () => ({ threadId: "thread-grandchild", turnId: "turn-grandchild", execute: async () => "done" }) });
  const result = await scheduler.runAgent({ parentTurnId: child.turnId, profileId: "tester", task: "nested" });
  assert.equal(result.status, "completed");
  assert.equal(store.get(result.runId)?.jobId, job.id);
  assert.equal(runtimeStore.listJobs().length, 1);
});

test("DAG Dispatcher 等待硬依赖，自动 Reviewer 通过后才创建 Return", async () => {
  const store = new AgentRunStore(); const runtimeStore = new AgentRuntimeStore();
  let sequence = 0; const executionOrder: string[] = [];
  const scheduler = new MultiAgentScheduler({ registry: new AgentRegistry(), store, runtimeStore, enableAutomaticReview: true,
    resolveParent: () => ({ threadId: "thread-root", teamConfig: { ...DEFAULT_AGENT_TEAM_CONFIG, maxSubagents: 4 } }),
    prepare: (profile, task) => ({ threadId: `child-${++sequence}`, turnId: `turn-${sequence}`, execute: async () => {
      executionOrder.push(profile.id); return profile.id === "reviewer" ? `PASS 已独立验证 ${task.slice(0, 16)}` : `worker ${task}`;
    } }) });
  const first = await scheduler.runAgent({ parentTurnId: "turn-root", profileId: "investigator", task: "先排查" });
  const firstTask = runtimeStore.listTasks("job-turn-root").find((item) => item.ownerRunId === first.runId)!;
  const second = await scheduler.runAgent({ parentTurnId: "turn-root", profileId: "coder", task: "后实现", dependsOnTaskIds: [firstTask.id] });
  const secondTask = runtimeStore.listTasks("job-turn-root").find((item) => item.ownerRunId === second.runId)!;
  assert.deepEqual(executionOrder, ["investigator", "reviewer", "coder", "reviewer"]);
  assert.equal(secondTask.status, "completed");
  assert.equal(runtimeStore.listEvidence(secondTask.id).some((item) => item.producer === "reviewer" && item.verdict === "passed"), true);
  assert.equal(runtimeStore.listReturns("job-turn-root").filter((item) => item.taskId === secondTask.id).length, 1);
});

test("Reviewer 创建和完成事件都路由到根 Chat", async () => {
  const store = new AgentRunStore();
  const runtimeStore = new AgentRuntimeStore();
  const updates: Array<{ threadId: string; turnId: string; profile: string; status: string }> = [];
  let sequence = 0;
  const scheduler = new MultiAgentScheduler({
    registry: new AgentRegistry(), store, runtimeStore, enableAutomaticReview: true,
    resolveParent: () => ({ threadId: "thread-root" }),
    prepare: (profile) => ({
      threadId: `thread-internal-${++sequence}`,
      turnId: `turn-internal-${sequence}`,
      execute: async () => profile.id === "reviewer" ? "PASS 已验收" : "worker result",
    }),
    onRunUpdated: (threadId, turnId, runId) => {
      const run = store.get(runId)!;
      if (run.agentProfileId === "reviewer") updates.push({ threadId, turnId, profile: run.agentProfileId, status: run.status });
    },
  });

  await scheduler.runAgent({ parentTurnId: "turn-root", profileId: "investigator", task: "检查" });

  assert.deepEqual(updates, [
    { threadId: "thread-root", turnId: "turn-root", profile: "reviewer", status: "running" },
    { threadId: "thread-root", turnId: "turn-root", profile: "reviewer", status: "completed" },
  ]);
});

test("Reviewer 执行异常时关闭 Run 和 Task，不留下运行中节点", async () => {
  const store = new AgentRunStore();
  const runtimeStore = new AgentRuntimeStore();
  let sequence = 0;
  const scheduler = new MultiAgentScheduler({
    registry: new AgentRegistry(), store, runtimeStore, enableAutomaticReview: true,
    resolveParent: () => ({ threadId: "thread-root" }),
    prepare: (profile) => ({
      threadId: `thread-internal-${++sequence}`,
      turnId: `turn-internal-${sequence}`,
      execute: async () => {
        if (profile.id === "reviewer") throw new Error("Reviewer provider failed");
        return "worker result";
      },
    }),
  });

  const result = await scheduler.runAgent({ parentTurnId: "turn-root", profileId: "investigator", task: "检查" });
  const reviewer = store.listForJob("job-turn-root").find((run) => run.agentProfileId === "reviewer")!;
  const reviewerTask = runtimeStore.listTasks("job-turn-root").find((task) => task.profileId === "reviewer")!;

  assert.equal(result.status, "failed");
  assert.equal(reviewer.status, "failed");
  assert.equal(reviewer.result?.safeError, "Reviewer provider failed");
  assert.equal(reviewerTask.status, "failed");
});

test("Reviewer 拒绝时 Worker Run 保持 completed，失败只归属 Review和Task", async () => {
  const store = new AgentRunStore(); const runtimeStore = new AgentRuntimeStore(); let sequence = 0;
  const scheduler = new MultiAgentScheduler({ registry: new AgentRegistry(), store, runtimeStore, enableAutomaticReview: true,
    resolveParent: () => ({ threadId: "thread-root" }),
    prepare: (profile) => ({ threadId: `thread-${++sequence}`, turnId: `turn-${sequence}`,
      execute: async () => profile.id === "reviewer"
        ? JSON.stringify({ verdict: "fail", severity: "P3", summary: "evidence is incomplete" })
        : "worker output" }) });

  const result = await scheduler.runAgent({ parentTurnId: "turn-root", profileId: "tester", task: "verify reviewer attribution" });
  const runs = store.listForJob("job-turn-root"); const worker = runs.find((run) => run.agentProfileId === "tester")!;
  const reviewer = runs.find((run) => run.agentProfileId === "reviewer")!;
  assert.equal(result.status, "failed");
  assert.equal(worker.status, "completed");
  assert.equal(reviewer.status, "failed");
  assert.equal(runtimeStore.listTasks("job-turn-root").find((task) => task.profileId === "tester")?.status, "failed");
});

test("Reviewer JSON pass 合同不依赖 PASS 文本前缀", async () => {
  const store = new AgentRunStore(); const runtimeStore = new AgentRuntimeStore(); let sequence = 0;
  const scheduler = new MultiAgentScheduler({ registry: new AgentRegistry(), store, runtimeStore, enableAutomaticReview: true,
    resolveParent: () => ({ threadId: "thread-root" }),
    prepare: (profile) => ({ threadId: `thread-${++sequence}`, turnId: `turn-${sequence}`,
      execute: async () => profile.id === "reviewer"
        ? JSON.stringify({ verdict: "pass", severity: null, summary: "three tips verified" })
        : "three tips" }) });

  const result = await scheduler.runAgent({ parentTurnId: "turn-root", profileId: "tester", task: "return three tips" });
  assert.equal(result.status, "completed");
  assert.equal(runtimeStore.listTasks("job-turn-root").find((task) => task.profileId === "tester")?.status, "completed");
});

test("3 Chat × 每 Chat 10 子 Agent 真实调度遵守全局 4 并发且不串 Job", async () => {
  const store = new AgentRunStore(); const runtimeStore = new AgentRuntimeStore(); let active = 0; let peak = 0; let sequence = 0;
  const scheduler = new MultiAgentScheduler({ registry: new AgentRegistry(), store, runtimeStore, maxConcurrentRuns: 4,
    resolveParent: (turnId) => ({ threadId: turnId.replace("turn", "thread"), teamConfig: { ...DEFAULT_AGENT_TEAM_CONFIG, independentReview: false } }),
    prepare: (_profile, task) => ({ threadId: `worker-${++sequence}`, turnId: `worker-turn-${sequence}`, execute: async () => {
      active += 1; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 3)); active -= 1; return task;
    } }) });
  const results = await Promise.all(Array.from({ length: 3 }, (_, chat) => Array.from({ length: 10 }, (_, index) => scheduler.runAgent({ parentTurnId: `turn-${chat}`, profileId: "tester", task: `chat-${chat}-task-${index}` }))).flat());
  assert.equal(results.length, 30); assert.equal(peak, 4);
  assert.deepEqual(runtimeStore.listJobs().map((job) => runtimeStore.listTasks(job.id).length).sort((a, b) => a - b), [10, 10, 10]);
  for (const job of runtimeStore.listJobs()) assert.equal(runtimeStore.listReturns(job.id).every((item) => item.jobId === job.id), true);
});

test("P2 Review 自动回到同一 Task 创建第二个 Run，并保留首次 Run 与 Evidence", async () => {
  const store = new AgentRunStore(); const runtimeStore = new AgentRuntimeStore(); let sequence = 0; let reviewCount = 0;
  const scheduler = new MultiAgentScheduler({ registry: new AgentRegistry(), store, runtimeStore,
    resolveParent: () => ({ threadId: "thread-root", teamConfig: { ...DEFAULT_AGENT_TEAM_CONFIG, maxSubagents: 5 } }),
    prepare: (_profile, task) => ({ threadId: `child-${++sequence}`, turnId: `child-turn-${sequence}`, execute: async () => task.includes("第 2 次执行") ? "已根据 P2 修正" : "首次结果" }),
    review: async () => ++reviewCount === 1 ? { passed: false, summary: "P2 边界未覆盖", severity: "P2" } : { passed: true, summary: "PASS 返工验收通过" } });
  const result = await scheduler.runAgent({ parentTurnId: "turn-root", profileId: "coder", task: "实现并覆盖边界" });
  const job = runtimeStore.listJobs()[0]!; const workerTask = runtimeStore.listTasks(job.id)[0]!;
  assert.equal(workerTask.attempt, 2); assert.equal(workerTask.status, "completed");
  assert.equal(store.listForJob(job.id).filter((run) => run.taskId === workerTask.id).length, 2);
  assert.equal(runtimeStore.listEvidence(workerTask.id).some((item) => item.verdict === "failed" && item.severity === "P2"), true);
  assert.equal(runtimeStore.listEvidence(workerTask.id).at(-1)?.verdict, "passed"); assert.equal(result.summary, "已根据 P2 修正");
});

test("同角色不同 Task 使用不同 Thread，同一 Task 返工复用原 Thread", async () => {
  const store = new AgentRunStore(); const runtimeStore = new AgentRuntimeStore();
  let sequence = 0; let reviewCount = 0;
  const threadByTask = new Map<string, string>();
  const scheduler = new MultiAgentScheduler({ registry: new AgentRegistry(), store, runtimeStore,
    resolveParent: () => ({ threadId: "thread-root", teamConfig: { ...DEFAULT_AGENT_TEAM_CONFIG, independentReview: true, maxSubagents: 8 } }),
    prepare: (_profile, task, _parentRunId, taskId, attempt) => {
      const threadId = threadByTask.get(taskId) ?? `task-thread-${++sequence}`;
      threadByTask.set(taskId, threadId);
      return { threadId, turnId: `${threadId}-attempt-${attempt}`, execute: async () => task.includes("第 2 次执行") ? "返工完成" : "首次完成" };
    },
    review: async () => ++reviewCount === 1
      ? { passed: false, severity: "P2", summary: "需要返工" }
      : { passed: true, summary: "通过" } });
  const first = await scheduler.runAgent({ parentTurnId: "turn-root", profileId: "tester", task: "任务 A" });
  const second = await scheduler.runAgent({ parentTurnId: "turn-root", profileId: "tester", task: "任务 B" });
  const firstRuns = store.listForJob("job-turn-root").filter((run) => run.taskId === first.taskId);
  const secondRuns = store.listForJob("job-turn-root").filter((run) => run.taskId === second.taskId);
  assert.equal(new Set(firstRuns.map((run) => run.threadId)).size, 1);
  assert.equal(firstRuns.length, 2);
  assert.notEqual(firstRuns[0]?.threadId, secondRuns[0]?.threadId);
});

test("完整 AgentLoop 父→多子→独立 Review→Return Ack→父最终回答", async () => {
  const lifecycle = new LifecycleStore(); const thread = lifecycle.createThread(); const turn = lifecycle.createTurn(thread.id);
  lifecycle.appendItem(turn.id, "user_message", { text: "并行排查和测试后汇总" });
  const runs = new AgentRunStore(); const runtime = new AgentRuntimeStore(); let sequence = 0;
  let scheduler!: MultiAgentScheduler;
  const coordinator = new AgentRuntimeCoordinator({ store: runtime, retryDelayMs: () => 0 });
  const llm = new ScriptedLlmProvider([{ id: "parent-plan", text: "", functionCalls: [
    { callId: "child-a", name: "run_agent", arguments: JSON.stringify({ profileId: "investigator", task: "排查根因" }) },
    { callId: "child-b", name: "run_agent", arguments: JSON.stringify({ profileId: "tester", task: "执行测试" }) },
  ] }, { id: "parent-final", text: "父 Agent 已综合两个经过独立验收的结果。", functionCalls: [] }]);
  const loop = new AgentLoop({ lifecycleStore: lifecycle, llm, toolRegistry: new ToolRegistry([createRunAgentTool(() => scheduler)]),
    continueAfterAgentReturns: (turnId, childRunIds, continuation) => coordinator.continueParent(turnId, childRunIds, continuation) });
  scheduler = new MultiAgentScheduler({ registry: new AgentRegistry(), store: runs, runtimeStore: runtime, enableAutomaticReview: true,
    resolveParent: (turnId) => ({ threadId: lifecycle.getTurn(turnId)?.threadId ?? thread.id }),
    prepare: (profile, task) => ({ threadId: `child-${++sequence}`, turnId: `child-turn-${sequence}`,
      execute: async () => profile.id === "reviewer" ? `PASS 已核验：${task.slice(0, 30)}` : `${profile.id} 完成：${task}` }) });
  const result = await loop.run(turn.id);
  assert.equal((result.assistantMessage.content as { text: string }).text, "父 Agent 已综合两个经过独立验收的结果。");
  const job = runtime.getJobByTurn(turn.id)!; assert.equal(runtime.listReturns(job.id).length, 2);
  assert.equal(runtime.listReturns(job.id).every((item) => item.status === "consumed"), true);
  const workerTasks = runtime.listTasks(job.id).filter((task) => task.profileId !== "reviewer");
  assert.equal(workerTasks.length, 2); assert.equal(workerTasks.every((task) => task.status === "completed"), true);
  assert.equal(workerTasks.every((task) => runtime.listEvidence(task.id).some((item) => item.producer === "reviewer" && item.verdict === "passed")), true);
  assert.equal(llm.requests.length, 2);
});

test("fixed team skeleton does not consume the executable Task budget", async () => {
  const lifecycle = new LifecycleStore();
  const rootThread = lifecycle.createThread();
  const rootTurn = lifecycle.createTurn(rootThread.id);
  const store = new AgentRunStore();
  const runtimeStore = new AgentRuntimeStore();
  const root = store.ensureRoot(rootThread.id, rootTurn.id, "orchestrator", `job-${rootTurn.id}`);
  ensureFixedSoftwareTeam(lifecycle, store, root);
  runtimeStore.createJob({
    threadId: rootThread.id,
    rootTurnId: rootTurn.id,
    rootRunId: root.id,
    configSnapshot: { ...DEFAULT_AGENT_TEAM_CONFIG, independentReview: false, maxSubagents: 1 },
  });
  let sequence = 0;
  const scheduler = new MultiAgentScheduler({
    registry: new AgentRegistry(), store, runtimeStore,
    resolveParent: () => ({ threadId: rootThread.id }),
    prepare: () => ({
      threadId: `task-thread-${++sequence}`,
      turnId: `task-turn-${sequence}`,
      execute: async () => "done",
    }),
  });

  const first = await scheduler.runAgent({ parentTurnId: rootTurn.id, profileId: "tester", task: "first real task" });
  assert.equal(first.status, "completed");
  assert.equal(store.listForJob(root.jobId).filter((run) => run.taskId === undefined).length, 5);
  await assert.rejects(
    scheduler.runAgent({ parentTurnId: rootTurn.id, profileId: "tester", task: "second real task" }),
    /Agent Job budget exceeded/,
  );
});

test("run_agent definition satisfies Responses strict schema", () => {
  const tool = createRunAgentTool(() => undefined as never);
  const parameters = tool.definition.parameters as {
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: boolean;
  };
  assert.deepEqual(
    [...parameters.required].sort(),
    Object.keys(parameters.properties).sort(),
  );
  assert.equal(parameters.additionalProperties, false);
});

test("恢复 Task 必须属于当前 Job、必须是根 Task 且仍有可用 attempt", async () => {
  const lifecycle = new LifecycleStore(); const thread = lifecycle.createThread(); const turn = lifecycle.createTurn(thread.id);
  const store = new AgentRunStore(); const runtimeStore = new AgentRuntimeStore();
  const job = runtimeStore.createJob({ threadId: thread.id, rootTurnId: turn.id, rootRunId: "pending-root",
    configSnapshot: { ...DEFAULT_AGENT_TEAM_CONFIG, independentReview: false } });
  const root = store.ensureRoot(thread.id, turn.id, "orchestrator", job.id);
  const createTask = (overrides: Record<string, unknown> = {}) => runtimeStore.createTask({ jobId: job.id,
    rootRunId: root.id, ownerRunId: root.id, profileId: "tester", title: "resume", objective: "resume",
    scope: { allowedPaths: [], deniedPaths: [], nonGoals: [] }, requiredOutputs: [], acceptanceCriteria: [],
    fileClaims: [], maxAttempts: 2, ...overrides } as never);
  const scheduler = new MultiAgentScheduler({ registry: new AgentRegistry(), store, runtimeStore,
    resolveParent: () => ({ threadId: thread.id }), prepare: () => ({ threadId: "never", turnId: "never", execute: async () => "never" }) });
  assert.match((await scheduler.runAgent({ parentTurnId: turn.id, profileId: "tester", task: "missing", taskId: "missing" })).safeError ?? "", /Resumed Task is unavailable/);
  const parent = createTask();
  const child = createTask({ parentTaskId: parent.id });
  assert.match((await scheduler.runAgent({ parentTurnId: turn.id, profileId: "tester", task: "child", taskId: child.id })).safeError ?? "", /Resumed Task is unavailable/);
  const completed = createTask(); runtimeStore.setTaskStatus(completed.id, "completed");
  assert.match((await scheduler.runAgent({ parentTurnId: turn.id, profileId: "tester", task: "completed", taskId: completed.id })).safeError ?? "", /no eligible attempt/);
  const exhausted = createTask({ attempt: 2 });
  assert.match((await scheduler.runAgent({ parentTurnId: turn.id, profileId: "tester", task: "exhausted", taskId: exhausted.id })).safeError ?? "", /no eligible attempt/);
});

test("Scheduler cancelJob 与 recoverJob 只拒绝目标 Job 的等待队列", async () => {
  for (const action of ["cancel", "recover"] as const) {
    const store = new AgentRunStore(); const runtimeStore = new AgentRuntimeStore();
    const firstJob = runtimeStore.createJob({ threadId: `thread-${action}-a`, rootTurnId: `turn-${action}-a`,
      rootRunId: "pending-a", configSnapshot: { ...DEFAULT_AGENT_TEAM_CONFIG, independentReview: false } });
    const secondJob = runtimeStore.createJob({ threadId: `thread-${action}-b`, rootTurnId: `turn-${action}-b`,
      rootRunId: "pending-b", configSnapshot: { ...DEFAULT_AGENT_TEAM_CONFIG, independentReview: false } });
    const firstRoot = store.ensureRoot(firstJob.threadId, firstJob.rootTurnId, "orchestrator", firstJob.id);
    const secondRoot = store.ensureRoot(secondJob.threadId, secondJob.rootTurnId, "orchestrator", secondJob.id);
    let release: () => void = () => undefined;
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    const scheduler = new MultiAgentScheduler({ registry: new AgentRegistry(), store, runtimeStore, maxConcurrentRuns: 1,
      resolveParent: (turnId) => ({ threadId: turnId }), prepare: (_profile, task) => ({ threadId: `child-${task}`,
        turnId: `child-turn-${task}`, execute: async () => { if (task === "first") await blocker; return task; } }) });
    const first = scheduler.runAgent({ parentTurnId: firstRoot.turnId, profileId: "tester", task: "first" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const queued = scheduler.runAgent({ parentTurnId: secondRoot.turnId, profileId: "tester", task: "queued" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (action === "cancel") scheduler.cancelJob(secondRoot.jobId); else scheduler.recoverJob(secondRoot.jobId);
    assert.match((await queued).safeError ?? "", action === "cancel" ? /Scheduler wait cancelled/ : /discarded during deterministic restart recovery/);
    release();
    assert.equal((await first).status, "completed");
  }
});
