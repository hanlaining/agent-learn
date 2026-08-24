import assert from "node:assert/strict";
import test from "node:test";
import type { AgentProfile } from "../src/agents/agent-profile.js";
import type { AgentJob, AgentTask } from "../src/agents/agent-runtime.js";
import { projectLegacyCapabilityGrant } from "../src/capabilities/legacy-capability-adapter.js";

test("legacy Capability projection intersects old allowlists without claiming native v1", () => {
  const profile = profileWith(["*", "!run_agent"], ["*"]);
  const job = jobWith(["read_file", "write_file"], ["research"]);
  const projected = projectLegacyCapabilityGrant({ profile, job, threadId: "thread-1", issuedAt: "2026-08-20T00:00:00.000Z" });
  assert.equal(projected.compatibility, "legacy_projected");
  assert.equal(projected.authority.sourceKind, "legacy");
  assert.deepEqual(projected.tools, { allow: ["read_file", "write_file"], deny: ["run_agent"] });
  assert.deepEqual(projected.skills.allow, ["research"]);
  assert.equal(projected.maxSideEffectClass, "none");
});

test("empty legacy allowedPaths remains explicitly unexpressed", () => {
  const projected = projectLegacyCapabilityGrant({
    profile: profileWith(["read_file"], ["research"]),
    job: jobWith(["read_file"], ["research"]),
    task: taskWith([], ["secrets"]),
    threadId: "thread-1",
    issuedAt: "2026-08-20T00:00:00.000Z",
  });
  assert.equal(projected.workspaces[0]?.pathSemantics, "unexpressed");
  assert.deepEqual(projected.workspaces[0]?.paths.allow, []);
  assert.notDeepEqual(projected.workspaces[0]?.paths.allow, ["*"]);
});

function profileWith(allowedTools: string[], allowedSkills: string[]): AgentProfile {
  return { id: "coder", name: "Coder", description: "Coder", instructions: "Do work", defaultModel: "fake", reasoningEffort: "medium", allowedTools, allowedSkills };
}

function jobWith(allowedTools: string[], allowedSkills: string[]): AgentJob {
  return {
    id: "job-1", threadId: "thread-1", rootTurnId: "turn-1", rootRunId: "run-1",
    configSnapshot: { version: 1, mode: "auto", maxSubagents: 2, maxConcurrent: 2, maxDepth: 1,
      allowedProfiles: ["coder"], scheduling: "dependency_graph", accessMode: "workspace", permissionMode: "least_privilege",
      shareBoard: true, independentReview: false, modelRouting: "inherit_chat", allowedTools, allowedSkills },
    executionKind: "software_change", workflowVersion: "legacy", attempt: 1, status: "running", createdAt: "2026-08-20T00:00:00.000Z",
  };
}

function taskWith(allowedPaths: string[], deniedPaths: string[]): AgentTask {
  return {
    id: "task-1", jobId: "job-1", rootRunId: "run-1", ownerRunId: "run-2", profileId: "coder",
    title: "Task", objective: "Task", scope: { allowedPaths, deniedPaths, nonGoals: [] }, requiredOutputs: [], acceptanceCriteria: [],
    dependencyIds: [], fileClaims: [], attempt: 1, jobAttempt: 1, maxAttempts: 2, status: "running",
    createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z",
  };
}
