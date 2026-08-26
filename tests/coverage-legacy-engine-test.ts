import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRuntimeStore } from "../src/agents/agent-runtime-store.js";
import type { FixedSoftwareTeamCoordinator } from "../src/agents/fixed-software-team-coordinator.js";
import { LegacyTeamExecutionEngineAdapter } from "../src/execution/legacy-team-execution-engine-adapter.js";

test("legacy engine adapter delegates lifecycle operations and reports an active job snapshot", async () => {
  const calls: string[] = [];
  const runtimeStore = {
    cancelJob(jobId: string) { calls.push(`cancel:${jobId}`); },
    getJob(jobId: string) {
      return jobId === "job-active"
        ? { workflowVersion: "legacy-v1", status: "running" }
        : undefined;
    },
  } as unknown as AgentRuntimeStore;
  const coordinator = {
    recoverPersistedCheckpoints() { calls.push("recover"); return 1; },
    getStage(jobId: string) { calls.push(`stage:${jobId}`); return "quality_ready" as const; },
    async advance(jobId: string, stage: string) {
      calls.push(`advance:${jobId}:${stage}`);
      return { stage: "quality_return_ready" as const, changed: true };
    },
  } as unknown as FixedSoftwareTeamCoordinator;
  const adapter = new LegacyTeamExecutionEngineAdapter(runtimeStore, coordinator);

  assert.equal(adapter.id, "legacy_team_adapter");
  assert.equal(adapter.control, "turn_agent");
  assert.equal(adapter.supports("software_product_delivery"), true);
  assert.equal(adapter.supports("analysis_only"), false);
  assert.deepEqual(await adapter.start({
    jobId: "job-active",
    threadId: "thread-1",
    rootRunId: "run-1",
    executionKind: "software_product_delivery",
    workflowVersion: "legacy-v1",
  }), {});
  assert.deepEqual(await adapter.resume("job-active"), {});
  await adapter.cancel("job-active");
  await adapter.recover("job-active");
  assert.deepEqual(await adapter.advance("job-active", "quality_ready"), {
    stage: "quality_return_ready",
    changed: true,
  });
  assert.deepEqual(adapter.snapshot("job-active"), {
    engine: "legacy_team_adapter",
    jobId: "job-active",
    workflowVersion: "legacy-v1",
    stage: "quality_ready",
    terminal: false,
  });
  assert.deepEqual(calls, [
    "cancel:job-active",
    "recover",
    "advance:job-active:quality_ready",
    "stage:job-active",
  ]);
});

test("legacy engine adapter fails closed to a terminal snapshot when the job is missing", () => {
  const runtimeStore = {
    cancelJob() {},
    getJob() { return undefined; },
  } as unknown as AgentRuntimeStore;
  const coordinator = {
    recoverPersistedCheckpoints() { return 0; },
    getStage() { return "ready_first_return" as const; },
    async advance() { return { stage: "ready_first_return" as const, changed: false }; },
  } as unknown as FixedSoftwareTeamCoordinator;
  const adapter = new LegacyTeamExecutionEngineAdapter(runtimeStore, coordinator);

  assert.deepEqual(adapter.snapshot("job-missing"), {
    engine: "legacy_team_adapter",
    jobId: "job-missing",
    stage: "ready_first_return",
    terminal: true,
  });
});
