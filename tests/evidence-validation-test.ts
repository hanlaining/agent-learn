import assert from "node:assert/strict";
import test from "node:test";
import type { CurrentEvidenceAuthority, EvidenceContract, EvidenceContractInput } from "../src/evidence/evidence-contract.js";
import { createEvidenceContract } from "../src/evidence/evidence-normalization.js";
import { isEvidenceFreshFor, validateEvidenceContract, validateEvidenceSet, validateRuntimeEventEvidenceBinding } from "../src/evidence/evidence-validation.js";
import { createCapabilityGrant, type CapabilityGrant, type CapabilityGrantInput, type CapabilityGrantSourceKind, type CapabilityGrantSubject } from "../src/capabilities/capability-grant.js";
import { type CapabilityIntersectionInput } from "../src/capabilities/capability-intersection.js";
import { createValidatedCapabilityGrant } from "../src/capabilities/capability-grant-validation.js";
import { createAggregateGeneration, createRuntimeEvent, digestRuntimeEventEnvelope, type RuntimeEventEnvelopeV1 } from "../src/runtime/runtime-event.js";
import { createRuntimeCorrelation } from "../src/runtime/runtime-correlation.js";

const HASH = "c".repeat(64);

test("Worker passed Test and unknown Oracle cannot support completion", () => {
  const workerTest = createEvidenceContract(base({
    kind: "test", producer: "worker", assurance: "observed", indexOnly: false,
    criterionBindings: [{ criterionId: "criterion-1", relation: "supports" }],
    resource: { type: "test", invocationId: "invocation-1", recipeId: "test", commandDigest: HASH, environmentDigest: HASH,
      startedAt: "2026-08-20T00:00:00.000Z", completedAt: "2026-08-20T00:00:01.000Z", status: "passed", exitCode: 0, reportArtifactIds: [] },
  }));
  assert.throws(() => validateEvidenceContract(workerTest), /self-reported passed Test/);

  const unknownOracle = createEvidenceContract(base({
    kind: "oracle", producer: "oracle_verifier", assurance: "outcome_unknown", indexOnly: false,
    criterionBindings: [{ criterionId: "criterion-1", relation: "supports" }],
    resource: { type: "oracle", oracleId: "remote", oracleVersion: "v1", queryDigest: HASH, observationDigest: HASH, status: "unknown" },
  }));
  assert.throws(() => validateEvidenceContract(unknownOracle), /outcome_unknown Evidence/);
});

test("Review graph rejects self-reference, cycles and cross-Job evidence", () => {
  const artifact = artifactEvidence("artifact-1", "job-1");
  const selfReview = reviewEvidence("review-self", "job-1", ["review-self"]);
  assert.throws(() => validateEvidenceContract(selfReview), /cannot review itself/);

  const reviewA = reviewEvidence("review-a", "job-1", ["review-b"]);
  const reviewB = reviewEvidence("review-b", "job-1", ["review-a"]);
  assert.throws(() => validateEvidenceSet([reviewA, reviewB]), /cycle/);

  const crossJobReview = reviewEvidence("review-cross", "job-2", [artifact.id]);
  assert.throws(() => validateEvidenceSet([artifact, crossJobReview]), /authority boundaries/);
  assert.throws(() => validateEvidenceSet([reviewEvidence("review-missing", "job-1", ["missing-evidence"])]), /missing Evidence/);
});

test("Review rejects stale authority and cannot launder Summary into verified support", () => {
  const currentArtifact = artifactEvidence("artifact-current", "job-1");
  const oldPlanArtifact = createEvidenceContract(base({
    id: "artifact-old-plan", authority: { ...base().authority, planVersion: "v1" },
    kind: "artifact", producer: "artifact_verifier", assurance: "verified", indexOnly: false,
    criterionBindings: [{ criterionId: "criterion-1", relation: "supports" }],
    resource: { type: "artifact", namespace: "workspace", path: "old-plan.json", sha256: HASH, sizeBytes: 10, mediaType: "application/json" },
  }));
  assert.throws(() => validateEvidenceSet([oldPlanArtifact, reviewEvidence("review-old-plan", "job-1", [oldPlanArtifact.id])]), /authority boundaries/);

  const oldAttemptArtifact = createEvidenceContract(base({
    id: "artifact-old-attempt", authority: { ...base().authority, jobAttempt: 2 },
    kind: "artifact", producer: "artifact_verifier", assurance: "verified", indexOnly: false,
    criterionBindings: [{ criterionId: "criterion-1", relation: "supports" }],
    resource: { type: "artifact", namespace: "workspace", path: "old-attempt.json", sha256: HASH, sizeBytes: 10, mediaType: "application/json" },
  }));
  assert.throws(() => validateEvidenceSet([oldAttemptArtifact, reviewEvidence("review-old-attempt", "job-1", [oldAttemptArtifact.id])]), /authority boundaries/);

  const summary = createEvidenceContract(base({ id: "summary-only" }));
  assert.throws(() => validateEvidenceSet([summary, reviewEvidence("review-summary", "job-1", [summary.id])]), /lacks native verified supports Evidence/);
  assert.doesNotThrow(() => validateEvidenceSet([currentArtifact, reviewEvidence("review-valid", "job-1", [currentArtifact.id])]));

  const verifiedFailure = verifiedFailedTest("failed-test-1");
  const contradictionReview = reviewEvidence("review-contradiction", "job-1", [verifiedFailure.id], "contradicts");
  assert.doesNotThrow(() => validateEvidenceSet([verifiedFailure, contradictionReview]));
  const summaryContradiction = reviewEvidence("review-summary-contradiction", "job-1", [summary.id], "contradicts");
  assert.throws(() => validateEvidenceSet([summary, summaryContradiction]), /lacks native verified contradicts Evidence/);

  const childArtifact = createEvidenceContract(base({
    id: "artifact-child-task", authority: { ...base().authority, taskId: "task-child", taskAttempt: 2, runId: "run-child", contractDigest: "d".repeat(64) },
    kind: "artifact", producer: "artifact_verifier", assurance: "verified", indexOnly: false,
    criterionBindings: [{ criterionId: "criterion-1", relation: "supports" }],
    resource: { type: "artifact", namespace: "workspace", path: "child.json", sha256: HASH, sizeBytes: 10, mediaType: "application/json" },
  }));
  assert.doesNotThrow(() => validateEvidenceSet([childArtifact, reviewEvidence("review-parent-task", "job-1", [childArtifact.id])]));
});

test("Runtime Event Evidence resolver binds digest, lineage, contract and confirmation", () => {
  const event = taskEvent();
  const evidence = runtimeEventEvidence(event);
  const capability = capabilityLayers();
  assert.doesNotThrow(() => validateRuntimeEventEvidenceBinding(evidence, event, capability));

  const wrongDigestEvidence = runtimeEventEvidence(event, { eventDigest: "d".repeat(64) });
  assert.throws(() => validateRuntimeEventEvidenceBinding(wrongDigestEvidence, event, capability), /does not match the actual Event/);
  assert.throws(() => validateRuntimeEventEvidenceBinding(runtimeEventEvidence(event, { eventId: "event-other" }), event, capability), /does not match the actual Event/);
  assert.throws(() => validateRuntimeEventEvidenceBinding(runtimeEventEvidence(event, { eventType: "task.other" }), event, capability), /does not match the actual Event/);

  const jobOnly = createRuntimeEvent({
    eventId: "event-job-1", eventType: "job.status_changed", aggregateType: "job", aggregateId: "job-1",
    authorityWriter: "AgentRuntimeStore", generationDomain: "aggregate", generation: createAggregateGeneration(1),
    correlation: createRuntimeCorrelation({ threadId: "thread-1", turnId: "turn-1", requirementId: "req-1", requirementRevision: 2, jobId: "job-1", jobAttempt: 1 }),
    causationId: null, occurredAt: "2026-08-20T00:00:00.000Z", producer: { component: "AgentRuntimeStore" }, payload: { status: "running" },
  });
  assert.throws(() => validateRuntimeEventEvidenceBinding(runtimeEventEvidence(jobOnly), jobOnly, capability), /complete Runtime Event Turn\/Requirement\/Job\/Task\/Run lineage/);

  const missingRequirement = eventFromCorrelation(createRuntimeCorrelation({ threadId: "thread-1", turnId: "turn-1",
    jobId: "job-1", jobAttempt: 1, taskId: "task-1", taskAttempt: 1, runId: "run-1" }), "event-missing-requirement");
  assert.throws(() => validateRuntimeEventEvidenceBinding(runtimeEventEvidence(missingRequirement), missingRequirement, capability), /complete Runtime Event Turn\/Requirement/);

  const wrongJobAttempt = eventFromCorrelation(createRuntimeCorrelation({ threadId: "thread-1", turnId: "turn-1", requirementId: "req-1", requirementRevision: 2,
    jobId: "job-1", jobAttempt: 2, taskId: "task-1", taskAttempt: 1, runId: "run-1" }), "event-wrong-job-attempt");
  const wrongTaskAttempt = eventFromCorrelation(createRuntimeCorrelation({ threadId: "thread-1", turnId: "turn-1", requirementId: "req-1", requirementRevision: 2,
    jobId: "job-1", jobAttempt: 1, taskId: "task-1", taskAttempt: 2, runId: "run-1" }), "event-wrong-task-attempt");
  const wrongRun = eventFromCorrelation(createRuntimeCorrelation({ threadId: "thread-1", turnId: "turn-1", requirementId: "req-1", requirementRevision: 2,
    jobId: "job-1", jobAttempt: 1, taskId: "task-1", taskAttempt: 1, runId: "run-other" }), "event-wrong-run");
  const wrongTurn = eventFromCorrelation(createRuntimeCorrelation({ threadId: "thread-1", turnId: "turn-other", requirementId: "req-1", requirementRevision: 2,
    jobId: "job-1", jobAttempt: 1, taskId: "task-1", taskAttempt: 1, runId: "run-1" }), "event-wrong-turn");
  for (const wrong of [wrongJobAttempt, wrongTaskAttempt, wrongRun, wrongTurn]) {
    assert.throws(() => validateRuntimeEventEvidenceBinding(runtimeEventEvidence(wrong), wrong, capability), /does not match EvidenceLineage/);
  }

  const wrongContractCapability = capabilityLayers({ contractDigest: "d".repeat(64) });
  assert.throws(() => validateRuntimeEventEvidenceBinding(evidence, event, wrongContractCapability), /subject does not match/);

  const staleAttempts = capabilityLayers({ jobAttempt: 2, taskAttempt: 2 });
  assert.throws(() => validateRuntimeEventEvidenceBinding(evidence, event, staleAttempts), /subject does not match/);

  const forgedFinal = createValidatedCapabilityGrant(layerInput("intersection", completeSubject()));
  assert.throws(() => validateRuntimeEventEvidenceBinding(evidence, event, forgedFinal as unknown as CapabilityIntersectionInput), /Missing mandatory CapabilityGrant layer/);
  if (false) {
    // @ts-expect-error Resolver accepts five source layers, never a self-labelled final Grant.
    validateRuntimeEventEvidenceBinding(evidence, event, forgedFinal);
  }
});

test("Evidence becomes stale after Requirement, Plan, attempt or input digest changes", () => {
  const evidence = artifactEvidence("artifact-1", "job-1");
  const current: CurrentEvidenceAuthority = {
    threadId: "thread-1", turnId: "turn-1",
    requirementId: "req-1", requirementRevision: 2, requirementContentHash: HASH,
    planId: "plan-1", planVersion: "v2", contractDigest: HASH, jobId: "job-1", jobAttempt: 1,
    taskId: "task-1", taskAttempt: 1, runId: "run-1", inputDigest: HASH, at: "2026-08-20T00:00:02.000Z",
  };
  assert.equal(isEvidenceFreshFor(evidence, current), true);
  assert.equal(isEvidenceFreshFor(evidence, { ...current, requirementRevision: 3 }), false);
  assert.equal(isEvidenceFreshFor(evidence, { ...current, planVersion: "v3" }), false);
  assert.equal(isEvidenceFreshFor(evidence, { ...current, taskAttempt: 2 }), false);
  assert.equal(isEvidenceFreshFor(evidence, { ...current, runId: "run-2" }), false);
  assert.equal(isEvidenceFreshFor(evidence, { ...current, contractDigest: "d".repeat(64) }), false);
  assert.equal(isEvidenceFreshFor(evidence, { ...current, inputDigest: "d".repeat(64) }), false);
});

function artifactEvidence(id: string, jobId: string): EvidenceContract {
  return createEvidenceContract(base({
    id, authority: { ...base().authority, jobId }, kind: "artifact", producer: "artifact_verifier", assurance: "verified", indexOnly: false,
    criterionBindings: [{ criterionId: "criterion-1", relation: "supports" }],
    resource: { type: "artifact", namespace: "workspace", path: "report.json", sha256: HASH, sizeBytes: 10, mediaType: "application/json" },
  }));
}

test("Evidence assurance and criterion relations fail closed", () => {
  const contradictedContradiction = createEvidenceContract(base({ assurance: "contradicted", producer: "reviewer", indexOnly: false,
    kind: "review", criterionBindings: [{ criterionId: "criterion-1", relation: "contradicts" }],
    resource: { type: "review", reviewedEvidenceIds: ["artifact-1"], verdict: "rejected" } }));
  assert.throws(() => validateEvidenceContract(contradictedContradiction), /contradicted Evidence may only be informational/);

  const verifiedFailedTest = createEvidenceContract(base({ assurance: "verified", producer: "test_verifier", indexOnly: false,
    kind: "test", criterionBindings: [{ criterionId: "criterion-1", relation: "contradicts" }],
    resource: { type: "test", invocationId: "invocation-failed", recipeId: "test", commandDigest: HASH,
      environmentDigest: HASH, startedAt: "2026-08-20T00:00:00.000Z", completedAt: "2026-08-20T00:00:01.000Z",
      status: "failed", exitCode: 1, reportArtifactIds: [] } }));
  assert.doesNotThrow(() => validateEvidenceContract(verifiedFailedTest));

  const indexOnlyContradiction = createEvidenceContract(base({ criterionBindings: [{ criterionId: "criterion-1", relation: "contradicts" }] }));
  assert.throws(() => validateEvidenceContract(indexOnlyContradiction), /Index-only Evidence may only be informational/);

  assert.throws(() => createEvidenceContract({ ...base(), kind: "proof" as "summary" }), /Invalid Evidence kind/);
});

function reviewEvidence(id: string, jobId: string, reviewedEvidenceIds: string[], relation: "supports" | "contradicts" = "supports"): EvidenceContract {
  const input: Partial<EvidenceContractInput> = {
    id, authority: { ...base().authority, jobId }, kind: "review", producer: "reviewer", assurance: "verified", indexOnly: false,
    criterionBindings: [{ criterionId: "criterion-1", relation }],
    resource: { type: "review", reviewedEvidenceIds, verdict: "passed" },
  };
  return createEvidenceContract(base(input));
}

function verifiedFailedTest(id: string): EvidenceContract {
  return createEvidenceContract(base({ id, kind: "test", producer: "test_verifier", assurance: "verified", indexOnly: false,
    criterionBindings: [{ criterionId: "criterion-1", relation: "contradicts" }],
    resource: { type: "test", invocationId: `invocation-${id}`, recipeId: "test", commandDigest: HASH, environmentDigest: HASH,
      startedAt: "2026-08-20T00:00:00.000Z", completedAt: "2026-08-20T00:00:01.000Z", status: "failed", exitCode: 1, reportArtifactIds: [] } }));
}

function taskEvent() {
  return createRuntimeEvent({
    eventId: "event-task-1", eventType: "task.status_changed", aggregateType: "task", aggregateId: "task-1",
    authorityWriter: "AgentRuntimeStore", generationDomain: "aggregate", generation: createAggregateGeneration(1),
    correlation: createRuntimeCorrelation({ threadId: "thread-1", turnId: "turn-1", requirementId: "req-1", requirementRevision: 2,
      jobId: "job-1", jobAttempt: 1, taskId: "task-1", taskAttempt: 1, runId: "run-1" }),
    causationId: null, occurredAt: "2026-08-20T00:00:00.000Z", producer: { component: "AgentRuntimeStore" }, payload: { status: "running" },
  });
}

function runtimeEventEvidence(event: RuntimeEventEnvelopeV1, overrides: Partial<{ eventId: string; eventType: string; eventDigest: string }> = {}): EvidenceContract {
  return createEvidenceContract(base({ id: `evidence-${event.eventId}`, kind: "runtime_event", producer: "runtime", assurance: "observed", indexOnly: false,
    resource: { type: "runtime_event", eventId: overrides.eventId ?? event.eventId, eventType: overrides.eventType ?? event.eventType,
      eventDigest: overrides.eventDigest ?? digestRuntimeEventEnvelope(event) } }));
}

function eventFromCorrelation(correlation: ReturnType<typeof createRuntimeCorrelation>, eventId: string): RuntimeEventEnvelopeV1 {
  return createRuntimeEvent({ eventId, eventType: "task.status_changed", aggregateType: "task", aggregateId: "task-1",
    authorityWriter: "AgentRuntimeStore", generationDomain: "aggregate", generation: createAggregateGeneration(1), correlation,
    causationId: null, occurredAt: "2026-08-20T00:00:00.000Z", producer: { component: "AgentRuntimeStore" }, payload: { status: "running" } });
}

function capabilityLayers(subjectOverrides: Partial<CapabilityGrantSubject> = {}): CapabilityIntersectionInput {
  const subject = completeSubject(subjectOverrides);
  return {
    profile: createValidatedCapabilityGrant(layerInput("profile", subject)),
    job: createValidatedCapabilityGrant(layerInput("job", subject)),
    task: createValidatedCapabilityGrant(layerInput("task", subject)),
    workspacePolicy: createValidatedCapabilityGrant(layerInput("workspace_policy", subject)),
    userConfirmation: createValidatedCapabilityGrant(layerInput("user_confirmation", subject)),
  };
}

function completeSubject(overrides: Partial<CapabilityGrantSubject> = {}): CapabilityGrantSubject {
  return { threadId: "thread-1", turnId: "turn-1", requirementId: "req-1", requirementRevision: 2,
    jobId: "job-1", jobAttempt: 1, taskId: "task-1", taskAttempt: 1, runId: "run-1", contractDigest: HASH, ...overrides };
}

function layerInput(sourceKind: CapabilityGrantSourceKind, subject: CapabilityGrantSubject): CapabilityGrantInput {
  return {
    schemaVersion: 1,
    authority: { sourceKind, sourceId: `${sourceKind}:test`, sourceRevision: "1", issuedAt: "2026-08-20T00:00:00.000Z" },
    subject,
    tools: { allow: ["read_file"], deny: [] }, skills: { allow: [], deny: [] }, mcp: [],
    workspaces: [{ namespace: "workspace", pathSemantics: "expressed", paths: { allow: ["src"], deny: [] }, operations: { allow: ["read"], deny: [] } }],
    credentials: { allow: [], deny: [] }, terminal: { recipes: [], network: "none", process: "none" }, maxSideEffectClass: "read_only",
    quotas: { maxToolInvocations: 1, maxModelInvocations: 1, maxWallClockMs: 1_000, maxConcurrentProcesses: 0, maxOutputBytes: 1_000 },
    confirmation: { requirementId: subject.requirementId!, revision: subject.requirementRevision!, contentHash: HASH }, compatibility: "native_v1",
  };
}

function base(overrides: Partial<EvidenceContractInput> = {}): EvidenceContractInput {
  return {
    schemaVersion: 1, id: "evidence-1",
    authority: { requirementId: "req-1", requirementRevision: 2, requirementContentHash: HASH,
      threadId: "thread-1", turnId: "turn-1",
      planId: "plan-1", planVersion: "v2", contractDigest: HASH, jobId: "job-1", jobAttempt: 1,
      taskId: "task-1", taskAttempt: 1, runId: "run-1" },
    criterionBindings: [{ criterionId: "criterion-1", relation: "informational" }],
    kind: "summary", producer: "worker", assurance: "observed",
    freshness: { observedAt: "2026-08-20T00:00:00.000Z", recordedAt: "2026-08-20T00:00:01.000Z", inputDigest: HASH },
    summary: "Observed result", indexOnly: true, resource: { type: "summary", indexOnly: true }, compatibility: "native_v1",
    ...overrides,
  };
}
