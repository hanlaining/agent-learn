import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvidence } from "../src/agents/agent-runtime.js";
import { projectLegacyEvidence } from "../src/evidence/legacy-evidence-adapter.js";
import { isEvidenceFreshFor, validateEvidenceContract } from "../src/evidence/evidence-validation.js";

test("legacy passed Evidence remains index-only unverified data and never becomes verified", () => {
  const legacy = oldEvidence("passed");
  const snapshot = structuredClone(legacy);
  const projected = projectLegacyEvidence(legacy, {
    requirementId: "req-1", requirementRevision: 1, requirementContentHash: "e".repeat(64),
    planId: "plan-1", planVersion: "v1", contractDigest: "e".repeat(64), jobAttempt: 1, taskAttempt: 1, inputDigest: "e".repeat(64),
  });
  validateEvidenceContract(projected);
  assert.equal(projected.id, legacy.id);
  assert.equal(projected.kind, legacy.kind);
  assert.equal(projected.compatibility, "legacy_projected");
  assert.equal(projected.indexOnly, true);
  assert.equal(projected.assurance, "unverified");
  assert.notEqual(projected.assurance, "verified");
  assert.deepEqual(projected.criterionBindings, []);
  assert.deepEqual(legacy, snapshot);
});

test("legacy Evidence cannot pass native freshness even when optional context is supplied", () => {
  const projected = projectLegacyEvidence(oldEvidence("supported"), {
    requirementId: "req-1", requirementRevision: 1, requirementContentHash: "e".repeat(64),
    planId: "plan-1", planVersion: "v1", contractDigest: "e".repeat(64), jobAttempt: 1, taskAttempt: 1, inputDigest: "e".repeat(64),
  });
  assert.equal(isEvidenceFreshFor(projected, {
    threadId: "thread-1", turnId: "turn-1",
    requirementId: "req-1", requirementRevision: 1, requirementContentHash: "e".repeat(64),
    planId: "plan-1", planVersion: "v1", contractDigest: "e".repeat(64), jobId: "job-1", jobAttempt: 1,
    taskId: "task-1", taskAttempt: 1, runId: "run-1", inputDigest: "e".repeat(64), at: "2026-08-20T00:00:01.000Z",
  }), false);
});

function oldEvidence(verdict: AgentEvidence["verdict"]): AgentEvidence {
  return {
    id: "legacy-evidence-1", jobId: "job-1", taskId: "task-1", runId: "run-1",
    kind: "test", uri: "memory:test", digest: "old-digest", summary: "Legacy test passed",
    producer: "worker", verdict, jobAttempt: 1, createdAt: "2026-08-20T00:00:00.000Z",
  };
}
