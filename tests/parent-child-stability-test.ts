import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoop } from "../src/agent/agent-loop.js";
import { AgentRegistry } from "../src/agents/agent-registry.js";
import { AgentRunStore } from "../src/agents/agent-run-store.js";
import { DEFAULT_AGENT_TEAM_CONFIG } from "../src/agents/agent-runtime.js";
import { AgentRuntimeCoordinator } from "../src/agents/agent-runtime-coordinator.js";
import { AgentRuntimeStore } from "../src/agents/agent-runtime-store.js";
import { MultiAgentScheduler } from "../src/agents/multi-agent-scheduler.js";
import { LifecycleStore } from "../src/runtime/lifecycle-store.js";
import { createRunAgentTool } from "../src/tools/run-agent-tool.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { ScriptedLlmProvider } from "./helpers/scripted-llm.js";

test("父 Agent 等待子 Agent Return 后只收口一次，Job、Turn 与 Return 同步终止", async () => {
  const lifecycle = new LifecycleStore();
  const thread = lifecycle.createThread();
  const turn = lifecycle.createTurn(thread.id);
  lifecycle.appendItem(turn.id, "user_message", { text: "委派检查后给出最终答复" });
  const runs = new AgentRunStore();
  const runtime = new AgentRuntimeStore();
  const coordinator = new AgentRuntimeCoordinator({ store: runtime, retryDelayMs: () => 0 });
  let sequence = 0;
  let scheduler!: MultiAgentScheduler;
  const llm = new ScriptedLlmProvider([
    {
      id: "parent-delegates",
      text: "",
      functionCalls: [{
        callId: "child-check",
        name: "run_agent",
        arguments: JSON.stringify({ profileId: "tester", task: "检查父子链", dependsOnTaskIds: [], fileClaims: [] }),
      }],
    },
    { id: "parent-closes", text: "父 Agent 已根据子 Agent 的可验证结果完成收口。", functionCalls: [] },
  ]);
  const loop = new AgentLoop({
    lifecycleStore: lifecycle,
    llm,
    toolRegistry: new ToolRegistry([createRunAgentTool(() => scheduler)]),
    continueAfterAgentReturns: (turnId, childRunIds, continuation) =>
      coordinator.continueParent(turnId, childRunIds, continuation),
  });
  scheduler = new MultiAgentScheduler({
    registry: new AgentRegistry(),
    store: runs,
    runtimeStore: runtime,
    resolveParent: () => ({
      threadId: thread.id,
      teamConfig: { ...DEFAULT_AGENT_TEAM_CONFIG, independentReview: false },
    }),
    prepare: (_profile, task) => ({
      threadId: `child-thread-${++sequence}`,
      turnId: `child-turn-${sequence}`,
      execute: async () => `已完成并验证：${task}`,
    }),
  });

  const result = await loop.run(turn.id);
  const job = runtime.getJobByTurn(turn.id)!;
  const childRuns = runs.listForJob(job.id).filter((run) => run.parentRunId !== undefined);

  assert.deepEqual(result.assistantMessage.content, { text: "父 Agent 已根据子 Agent 的可验证结果完成收口。" });
  assert.equal(result.turn.status, "completed");
  assert.equal(job.status, "completed");
  assert.equal(childRuns.length, 1);
  assert.equal(childRuns[0]?.status, "completed");
  assert.equal(runtime.listReturns(job.id).length, 1);
  assert.equal(runtime.listReturns(job.id)[0]?.status, "consumed");
  assert.equal(llm.requests.length, 2);
});

test("子 Agent 失败、超时或取消的 Return 都被确认消费并把父 Job 收敛为失败", async () => {
  const cases = [
    { resultStatus: "failed" as const, taskStatus: "failed" as const },
    { resultStatus: "timed_out" as const, taskStatus: "lost" as const },
    { resultStatus: "cancelled" as const, taskStatus: "cancelled" as const },
  ];

  for (const [index, scenario] of cases.entries()) {
    const runtime = new AgentRuntimeStore();
    const turnId = `terminal-child-${index}`;
    const job = runtime.createJob({
      threadId: `thread-${index}`,
      rootTurnId: turnId,
      rootRunId: `root-${index}`,
      configSnapshot: { ...DEFAULT_AGENT_TEAM_CONFIG, independentReview: false },
    });
    const task = runtime.createTask({
      jobId: job.id,
      rootRunId: job.rootRunId,
      ownerRunId: `child-${index}`,
      profileId: "tester",
      title: "terminal child",
      objective: "验证异常子任务回传",
      scope: { allowedPaths: [], deniedPaths: [], nonGoals: [] },
      requiredOutputs: ["明确终态"],
      acceptanceCriteria: ["父 Job 不得卡在运行中"],
      fileClaims: [],
      maxAttempts: 1,
    });
    runtime.setTaskStatus(task.id, scenario.taskStatus);
    runtime.createReturn({
      jobId: job.id,
      rootRunId: job.rootRunId,
      parentRunId: job.rootRunId,
      childRunId: `child-${index}`,
      taskId: task.id,
      sequence: 1,
      result: {
        status: scenario.resultStatus,
        summary: `child ${scenario.resultStatus}`,
        evidenceIds: [],
        boardEntryIds: [],
      },
      idempotencyKey: `${job.id}:child-terminal`,
    });
    runtime.setJobStatus(job.id, "waiting_returns");
    let successfulDeliveryCalls = 0;
    const coordinator = new AgentRuntimeCoordinator({ store: runtime, retryDelayMs: () => 0 });

    const delivered = await coordinator.recoverPendingReturns(async () => {
      successfulDeliveryCalls += 1;
      return "unexpected success";
    });

    assert.deepEqual(delivered, []);
    assert.equal(successfulDeliveryCalls, 0);
    assert.equal(runtime.listReturns(job.id)[0]?.status, "consumed");
    assert.equal(runtime.getJob(job.id)?.status, "failed");
  }
});

test("Return 的创建、消费与迟到重复事件保持幂等，重启后不会重新投递", () => {
  const { runtime, jobId, taskId } = createRuntimeFixture("return-idempotency");
  const input = {
    jobId,
    rootRunId: "root-return-idempotency",
    parentRunId: "root-return-idempotency",
    childRunId: "child-return-idempotency",
    taskId,
    sequence: 1,
    result: {
      status: "completed" as const,
      summary: "first accepted result",
      evidenceIds: [],
      boardEntryIds: [],
    },
    idempotencyKey: `${jobId}:child:1`,
  };

  const first = runtime.createReturn(input);
  const duplicate = runtime.createReturn({
    ...input,
    result: { ...input.result, summary: "late duplicate must be ignored" },
  });
  assert.equal(duplicate.id, first.id);
  assert.equal(runtime.listReturns(jobId).length, 1);
  assert.equal(runtime.claimReturn(first.id)?.attempts, 1);
  assert.equal(runtime.consumeReturn(first.id), true);
  assert.equal(runtime.consumeReturn(first.id), false);

  const restored = AgentRuntimeStore.fromSnapshot(runtime.exportSnapshot());
  const lateAfterRestart = restored.createReturn({
    ...input,
    result: { ...input.result, summary: "late after restart" },
  });
  assert.equal(lateAfterRestart.id, first.id);
  assert.equal(lateAfterRestart.status, "consumed");
  assert.equal(lateAfterRestart.result.summary, "first accepted result");
  assert.equal(restored.claimReturn(first.id), undefined);
  assert.equal(restored.listReturns(jobId).length, 1);
});

test("父 Agent Tool 预算耗尽后保留已消费的子 Return，并以空工具轮强制最终收口", async () => {
  const lifecycle = new LifecycleStore();
  const thread = lifecycle.createThread();
  const turn = lifecycle.createTurn(thread.id);
  lifecycle.appendItem(turn.id, "user_message", { text: "调用子 Agent 后完成答复" });
  const runs = new AgentRunStore();
  const runtime = new AgentRuntimeStore();
  const coordinator = new AgentRuntimeCoordinator({ store: runtime, retryDelayMs: () => 0 });
  let scheduler!: MultiAgentScheduler;
  let childSequence = 0;
  const runAgentArguments = JSON.stringify({ profileId: "tester", task: "产生最终证据", dependsOnTaskIds: [], fileClaims: [] });
  const llm = new ScriptedLlmProvider([
    { id: "tool-round-0", text: "", functionCalls: [{ callId: "real-child", name: "run_agent", arguments: runAgentArguments }] },
    { id: "tool-round-limit", text: "", functionCalls: [{ callId: "skipped-child", name: "run_agent", arguments: runAgentArguments }] },
    { id: "forced-final", text: "工具预算已用尽，但父 Agent 已依据已有 Return 完成最终答复。", functionCalls: [] },
  ]);
  const loop = new AgentLoop({
    lifecycleStore: lifecycle,
    llm,
    maxToolRounds: 1,
    toolRegistry: new ToolRegistry([createRunAgentTool(() => scheduler)]),
    continueAfterAgentReturns: (turnId, childRunIds, continuation) =>
      coordinator.continueParent(turnId, childRunIds, continuation),
  });
  scheduler = new MultiAgentScheduler({
    registry: new AgentRegistry(),
    store: runs,
    runtimeStore: runtime,
    resolveParent: () => ({
      threadId: thread.id,
      teamConfig: { ...DEFAULT_AGENT_TEAM_CONFIG, independentReview: false },
    }),
    prepare: () => ({
      threadId: `budget-child-thread-${++childSequence}`,
      turnId: `budget-child-turn-${childSequence}`,
      execute: async () => "可用于最终收口的子任务证据",
    }),
  });

  const result = await loop.run(turn.id);
  const job = runtime.getJobByTurn(turn.id)!;

  assert.equal(result.turn.status, "completed");
  assert.deepEqual(result.assistantMessage.content, { text: "工具预算已用尽，但父 Agent 已依据已有 Return 完成最终答复。" });
  assert.equal(childSequence, 1);
  assert.equal(runtime.listReturns(job.id).length, 1);
  assert.equal(runtime.listReturns(job.id)[0]?.status, "consumed");
  assert.equal(runtime.getJob(job.id)?.status, "completed");
  assert.equal(llm.requests.length, 3);
  assert.deepEqual(llm.requests[2]?.tools, []);
  assert.match(llm.requests[2]?.instructions ?? "", /工具预算已经用尽.*不得再调用任何工具/s);
  const skipped = lifecycle.getItemsForTurn(turn.id).find((item) =>
    item.type === "tool_result" && (item.content as { callId?: string }).callId === "skipped-child");
  assert.equal((skipped?.content as { result?: { errorCode?: string } }).result?.errorCode, "tool_round_limit");
});

test("Checkpoint 快照恢复后复用同一幂等键，完成和运行中的 Stage 都不会重复创建", () => {
  const { runtime, jobId } = createRuntimeFixture("checkpoint-recovery");
  const completed = runtime.beginStage(jobId, "product", 2);
  runtime.setStageStatus(completed.idempotencyKey, "validating");
  runtime.setStageStatus(completed.idempotencyKey, "completed");
  const running = runtime.beginStage(jobId, "engineering", 2);

  const restored = AgentRuntimeStore.fromSnapshot(runtime.exportSnapshot());
  const completedAgain = restored.beginStage(jobId, "product", 2);
  const runningAgain = restored.beginStage(jobId, "engineering", 2);

  assert.equal(completedAgain.idempotencyKey, completed.idempotencyKey);
  assert.equal(completedAgain.stageAttempt, 1);
  assert.equal(runningAgain.idempotencyKey, running.idempotencyKey);
  assert.equal(runningAgain.stageAttempt, 1);
  assert.equal(restored.listStageCheckpoints(jobId).length, 2);
});

test("取消终态不会被迟到成功 Return 倒退，已完成子 Run 也不会被批量关闭改写", () => {
  const { runtime, jobId, taskId } = createRuntimeFixture("terminal-monotonicity");
  runtime.setTaskStatus(taskId, "cancelled");
  runtime.cancelJob(jobId);
  const late = runtime.createReturn({
    jobId,
    rootRunId: "root-terminal-monotonicity",
    parentRunId: "root-terminal-monotonicity",
    childRunId: "late-success-child",
    taskId,
    sequence: 1,
    result: { status: "completed", summary: "late success", evidenceIds: [], boardEntryIds: [] },
    idempotencyKey: `${jobId}:late-success`,
  });

  assert.equal(runtime.reconcileJobStatus(jobId), "cancelled");
  assert.equal(runtime.getJob(jobId)?.status, "cancelled");
  assert.equal(runtime.claimReturn(late.id)?.id, late.id);
  assert.equal(runtime.consumeReturn(late.id), true);
  assert.equal(runtime.reconcileJobStatus(jobId), "cancelled");

  const runs = new AgentRunStore();
  const root = runs.ensureRoot("terminal-thread", "terminal-turn", "orchestrator", jobId);
  const completed = runs.create({
    jobId,
    threadId: "completed-child-thread",
    turnId: "completed-child-turn",
    agentProfileId: "tester",
    parentRunId: root.id,
    task: "already completed",
    depth: 1,
  });
  runs.complete(completed.id, { runId: completed.id, status: "completed", summary: "durable evidence" });
  runs.setStatus(root.id, "running");
  runs.closeActiveForJob(jobId, "cancelled", "job cancelled");
  assert.equal(runs.get(completed.id)?.status, "completed");
  assert.equal(runs.get(completed.id)?.result?.summary, "durable evidence");
});

function createRuntimeFixture(suffix: string) {
  const runtime = new AgentRuntimeStore();
  const rootRunId = `root-${suffix}`;
  const job = runtime.createJob({
    threadId: `thread-${suffix}`,
    rootTurnId: `turn-${suffix}`,
    rootRunId,
    configSnapshot: { ...DEFAULT_AGENT_TEAM_CONFIG, independentReview: false },
  });
  const task = runtime.createTask({
    jobId: job.id,
    rootRunId,
    ownerRunId: `child-${suffix}`,
    profileId: "tester",
    title: suffix,
    objective: suffix,
    scope: { allowedPaths: [], deniedPaths: [], nonGoals: [] },
    requiredOutputs: ["result"],
    acceptanceCriteria: ["terminal"],
    fileClaims: [],
    maxAttempts: 2,
  });
  return { runtime, jobId: job.id, taskId: task.id };
}
