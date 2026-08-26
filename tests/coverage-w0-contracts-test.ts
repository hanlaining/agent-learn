import assert from "node:assert/strict";
import test from "node:test";

// These are the repository's behavioral W0 contract suites.  The main test
// collection historically omitted them even though they exercise executable
// source contracts.  Keeping the original suites as the single source of
// truth avoids weakening or silently copying their assertions.
import "./authority-registry-test.js";
import "./runtime-correlation-test.js";
import "./runtime-event-test.js";
import "./capability-grant-test.js";
import "./capability-intersection-test.js";
import "./legacy-capability-adapter-test.js";
import "./evidence-contract-test.js";
import "./evidence-validation-test.js";
import "./legacy-evidence-adapter-test.js";

import { createCapabilityGrant, stableJson, type CapabilityGrantInput } from "../src/capabilities/capability-grant.js";
import { isSafeRelativeCapabilityPath, validateCapabilityGrant } from "../src/capabilities/capability-grant-validation.js";
import { createEvidenceContract } from "../src/evidence/evidence-normalization.js";
import { isEvidenceFreshFor, validateEvidenceContract } from "../src/evidence/evidence-validation.js";

const DIGEST = "a".repeat(64);

test("coverage contract integration keeps normalized authorization deterministic and rejects unsafe paths", () => {
  const grant = createCapabilityGrant(baseGrant());
  assert.doesNotThrow(() => validateCapabilityGrant(grant));
  assert.equal(stableJson({ z: 1, a: { y: 2, x: 1 } }), '{"a":{"x":1,"y":2},"z":1}');
  assert.equal(isSafeRelativeCapabilityPath("src/runtime/session.ts"), true);
  assert.equal(isSafeRelativeCapabilityPath("../secrets.env"), false);
  assert.throws(
    () => validateCapabilityGrant(createCapabilityGrant(baseGrant({ tools: { allow: ["read_*"], deny: [] } }))),
    /complete.*wildcard/u,
  );
});

test("coverage contract integration binds evidence freshness and rejects authority drift", () => {
  const evidence = createEvidenceContract({
    schemaVersion: 1,
    id: "evidence-coverage-1",
    authority: {
      threadId: "thread-1",
      turnId: "turn-1",
      requirementId: "requirement-1",
      requirementRevision: 1,
      requirementContentHash: DIGEST,
      planId: "plan-1",
      planVersion: "v1",
      contractDigest: DIGEST,
      jobId: "job-1",
      jobAttempt: 1,
      taskId: "task-1",
      taskAttempt: 1,
      runId: "run-1",
    },
    criterionBindings: [{ criterionId: "criterion-1", relation: "supports" }],
    kind: "artifact",
    producer: "artifact_verifier",
    assurance: "verified",
    freshness: {
      observedAt: "2026-08-24T00:00:00.000Z",
      recordedAt: "2026-08-24T00:00:01.000Z",
      inputDigest: DIGEST,
      validUntil: "2026-08-25T00:00:00.000Z",
    },
    summary: "verified artifact",
    indexOnly: false,
    resource: {
      type: "artifact",
      namespace: "workspace",
      path: "dist/result.json",
      sha256: DIGEST,
      sizeBytes: 42,
      mediaType: "application/json",
    },
    compatibility: "native_v1",
  });
  assert.doesNotThrow(() => validateEvidenceContract(evidence));
  const authority = {
    threadId: "thread-1",
    turnId: "turn-1",
    requirementId: "requirement-1",
    requirementRevision: 1,
    requirementContentHash: DIGEST,
    planId: "plan-1",
    planVersion: "v1",
    contractDigest: DIGEST,
    jobId: "job-1",
    jobAttempt: 1,
    taskId: "task-1",
    taskAttempt: 1,
    runId: "run-1",
    inputDigest: DIGEST,
    at: "2026-08-24T12:00:00.000Z",
  };
  assert.equal(isEvidenceFreshFor(evidence, authority), true);
  assert.equal(isEvidenceFreshFor(evidence, { ...authority, requirementRevision: 2 }), false);
  assert.throws(
    () => validateEvidenceContract({ ...evidence, normalizedDigest: "b".repeat(64) }),
    /frozen stable snapshot|normalizedDigest/u,
  );
});

function baseGrant(overrides: Partial<CapabilityGrantInput> = {}): CapabilityGrantInput {
  return {
    schemaVersion: 1,
    authority: {
      sourceKind: "task",
      sourceId: "task:coverage",
      sourceRevision: "1",
      issuedAt: "2026-08-24T00:00:00.000Z",
    },
    subject: {
      threadId: "thread-1",
      turnId: "turn-1",
      requirementId: "requirement-1",
      requirementRevision: 1,
      jobId: "job-1",
      jobAttempt: 1,
      taskId: "task-1",
      taskAttempt: 1,
      runId: "run-1",
      contractDigest: DIGEST,
    },
    tools: { allow: ["read_file"], deny: [] },
    skills: { allow: ["research"], deny: [] },
    mcp: [],
    workspaces: [{
      namespace: "workspace",
      pathSemantics: "expressed",
      paths: { allow: ["src"], deny: [] },
      operations: { allow: ["read"], deny: [] },
    }],
    credentials: { allow: [], deny: [] },
    terminal: { recipes: [], network: "none", process: "none" },
    maxSideEffectClass: "read_only",
    quotas: {
      maxToolInvocations: 10,
      maxModelInvocations: 2,
      maxWallClockMs: 30_000,
      maxConcurrentProcesses: 1,
      maxOutputBytes: 10_000,
    },
    confirmation: { requirementId: "requirement-1", revision: 1, contentHash: DIGEST },
    compatibility: "native_v1",
    ...overrides,
  };
}
