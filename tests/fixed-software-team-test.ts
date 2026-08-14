import assert from "node:assert/strict";
import test from "node:test";
import { ensureFixedSoftwareTeam } from "../src/agents/fixed-software-team.js";
import { AgentRunStore } from "../src/agents/agent-run-store.js";
import { LifecycleStore } from "../src/runtime/lifecycle-store.js";
import { AgentRuntimeStore } from "../src/agents/agent-runtime-store.js";
import { DEFAULT_AGENT_TEAM_CONFIG } from "../src/agents/agent-runtime.js";
import { FixedSoftwareTeamCoordinator } from "../src/agents/fixed-software-team-coordinator.js";

test("fixed software team waiting skeleton survives Runtime restart", () => {
  const lifecycle = new LifecycleStore();
  const rootThread = lifecycle.createThread();
  const rootTurn = lifecycle.createTurn(rootThread.id);
  const runs = new AgentRunStore();
  const root = runs.ensureRoot(rootThread.id, rootTurn.id, "orchestrator", "job-restart-team");
  const team = ensureFixedSoftwareTeam(lifecycle, runs, root);
  const restored = AgentRunStore.fromSnapshot(runs.exportSnapshot());
  assert.equal(team.every((member) => restored.get(member.id)?.status === "queued"), true);
});

test("fixed software team stable waiting and rework checkpoints are not mislabeled cancelled after restart", () => {
  const lifecycle = new LifecycleStore(); const rootThread = lifecycle.createThread(); const rootTurn = lifecycle.createTurn(rootThread.id);
  const runs = new AgentRunStore(); const root = runs.ensureRoot(rootThread.id, rootTurn.id, "orchestrator", "job-fixed-checkpoint");
  const team = ensureFixedSoftwareTeam(lifecycle, runs, root);
  const lead = team.find((run) => run.agentProfileId === "software_team_lead")!;
  const product = team.find((run) => run.agentProfileId === "product_role")!;
  runs.setStatus(root.id, "waiting_children"); runs.setStatus(lead.id, "waiting_children"); runs.setStatus(product.id, "resuming");
  const restored = AgentRunStore.fromSnapshot(runs.exportSnapshot());
  assert.equal(restored.get(root.id)?.status, "waiting_children");
  assert.equal(restored.get(lead.id)?.status, "waiting_children");
  assert.equal(restored.get(product.id)?.status, "resuming");
});

test("ACTION 后固定软件团队只创建一次且四个成员都是真实独立 Thread", () => {
  const lifecycle = new LifecycleStore();
  const rootThread = lifecycle.createThread();
  const rootTurn = lifecycle.createTurn(rootThread.id);
  const runs = new AgentRunStore();
  const root = runs.ensureRoot(rootThread.id, rootTurn.id, "orchestrator", "job-requirement-v1");
  const first = ensureFixedSoftwareTeam(lifecycle, runs, root);
  const second = ensureFixedSoftwareTeam(lifecycle, runs, root);
  assert.equal(first.length, 4);
  assert.equal(second.length, 4);
  assert.equal(runs.listForJob(root.jobId).length, 5);
  assert.equal(new Set(first.map((run) => run.threadId)).size, 4);
  const lead = first.find((run) => run.agentProfileId === "software_team_lead")!;
  assert.equal(lead.parentRunId, root.id);
  assert.equal(first.filter((run) => run.parentRunId === lead.id).length, 3);
  for (const run of first) {
    assert.equal(lifecycle.getThread(run.threadId)?.kind, "agent_internal");
  }
});

test("固定产品双轮 Return 复用一个 Agent、一个 Task 和原 Thread，最终只汇总一次", async () => {
  const lifecycle = new LifecycleStore();
  const rootThread = lifecycle.createThread(); const rootTurn = lifecycle.createTurn(rootThread.id);
  const runs = new AgentRunStore(); const runtime = new AgentRuntimeStore();
  const root = runs.ensureRoot(rootThread.id, rootTurn.id, "orchestrator");
  runtime.createJob({ threadId: rootThread.id, rootTurnId: rootTurn.id, rootRunId: root.id, configSnapshot: DEFAULT_AGENT_TEAM_CONFIG });
  ensureFixedSoftwareTeam(lifecycle, runs, root);
  const executions: Array<{ profileId: string; threadId: string; attempt: number }> = [];
  const coordinator = new FixedSoftwareTeamCoordinator({
    runStore: runs, runtimeStore: runtime,
    execute: async (input) => {
      executions.push({ profileId: input.profileId, threadId: input.threadId, attempt: input.attempt });
      return { turnId: `fixed-turn-${executions.length}`, summary: `${input.profileId} 第 ${input.attempt} 轮可验收结果` };
    },
  });

  const productBefore = runs.listForJob(root.jobId).find((run) => run.agentProfileId === "product_role")!;
  assert.deepEqual(await coordinator.advance(root.jobId, "ready_first_return"), { stage: "first_return_ready", changed: true });
  assert.deepEqual(await coordinator.advance(root.jobId, "ready_first_return"), { stage: "first_return_ready", changed: false });
  assert.equal(runtime.listTasks(root.jobId).filter((task) => task.profileId === "product_role").length, 1);
  assert.equal(runtime.listReturns(root.jobId).length, 1);
  assert.equal(runtime.listReturns(root.jobId)[0]?.status, "ready");

  assert.equal((await coordinator.advance(root.jobId, "first_return_ready")).stage, "rework");
  assert.equal(runtime.listTasks(root.jobId)[0]?.status, "rework");
  assert.equal(runtime.listReturns(root.jobId)[0]?.status, "consumed");
  assert.equal(runtime.listReturns(root.jobId)[0]?.attempts, 1);

  assert.equal((await coordinator.advance(root.jobId, "rework")).stage, "second_return_ready");
  const productAfter = runs.listForJob(root.jobId).find((run) => run.agentProfileId === "product_role")!;
  assert.equal(productAfter.id, productBefore.id);
  assert.equal(productAfter.threadId, productBefore.threadId);
  assert.equal(productAfter.attempt, 2);
  assert.equal(runs.listForJob(root.jobId).filter((run) => run.agentProfileId === "product_role").length, 1);
  assert.equal(runtime.listTasks(root.jobId).length, 1);

  assert.equal((await coordinator.advance(root.jobId, "second_return_ready")).stage, "lead_return_ready");
  assert.equal(runtime.listReturns(root.jobId).filter((item) => item.parentRunId === root.id).length, 1);
  assert.equal((await coordinator.advance(root.jobId, "lead_return_ready")).stage, "completed");
  assert.equal((await coordinator.advance(root.jobId, "lead_return_ready")).changed, false);
  assert.equal(runtime.listReturns(root.jobId).every((item) => item.status === "consumed"), true);
  assert.equal(executions.filter((item) => item.profileId === "orchestrator").length, 1);
  assert.equal(executions.filter((item) => item.profileId === "product_role").length, 2);
  assert.equal(executions.filter((item) => item.profileId === "product_role")[0]?.threadId,
    executions.filter((item) => item.profileId === "product_role")[1]?.threadId);
});

test("固定产品返工阶段经 Runtime 快照重启后可从原 Thread 继续", async () => {
  const lifecycle = new LifecycleStore(); const rootThread = lifecycle.createThread(); const rootTurn = lifecycle.createTurn(rootThread.id);
  const runs = new AgentRunStore(); const runtime = new AgentRuntimeStore();
  const root = runs.ensureRoot(rootThread.id, rootTurn.id, "orchestrator");
  runtime.createJob({ threadId: rootThread.id, rootTurnId: rootTurn.id, rootRunId: root.id, configSnapshot: DEFAULT_AGENT_TEAM_CONFIG });
  ensureFixedSoftwareTeam(lifecycle, runs, root);
  const first = new FixedSoftwareTeamCoordinator({ runStore: runs, runtimeStore: runtime,
    execute: async (input) => ({ turnId: `before-${input.profileId}`, summary: "第一次结果" }) });
  await first.advance(root.jobId, "ready_first_return"); await first.advance(root.jobId, "first_return_ready");

  const restoredRuns = AgentRunStore.fromSnapshot(runs.exportSnapshot());
  const restoredRuntime = AgentRuntimeStore.fromSnapshot(runtime.exportSnapshot());
  const productThread = restoredRuns.listForJob(root.jobId).find((run) => run.agentProfileId === "product_role")!.threadId;
  const resumed = new FixedSoftwareTeamCoordinator({ runStore: restoredRuns, runtimeStore: restoredRuntime,
    execute: async (input) => ({ turnId: `after-${input.profileId}`, summary: "第二次修订结果" }) });
  restoredRuns.setStatus(restoredRuns.listForJob(root.jobId).find((run) => run.agentProfileId === "software_team_lead")!.id, "cancelled");
  restoredRuns.setStatus(restoredRuns.listForJob(root.jobId).find((run) => run.agentProfileId === "product_role")!.id, "cancelled");
  assert.equal(resumed.recoverPersistedCheckpoints(), 1);
  assert.equal(resumed.getStage(root.jobId), "rework");
  assert.equal(restoredRuns.listForJob(root.jobId).find((run) => run.agentProfileId === "software_team_lead")?.status, "waiting_children");
  assert.equal(restoredRuns.listForJob(root.jobId).find((run) => run.agentProfileId === "product_role")?.status, "resuming");
  assert.equal((await resumed.advance(root.jobId, "rework")).stage, "second_return_ready");
  const product = restoredRuns.listForJob(root.jobId).find((run) => run.agentProfileId === "product_role")!;
  assert.equal(product.threadId, productThread); assert.equal(product.attempt, 2);
  assert.equal(restoredRuns.listForJob(root.jobId).filter((run) => run.agentProfileId === "product_role").length, 1);
});
