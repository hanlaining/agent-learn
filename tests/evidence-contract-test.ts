import assert from "node:assert/strict";
import test from "node:test";
import type { EvidenceContractInput, EvidenceResource } from "../src/evidence/evidence-contract.js";
import { createEvidenceContract } from "../src/evidence/evidence-normalization.js";
import { validateEvidenceContract } from "../src/evidence/evidence-validation.js";

const HASH = "c".repeat(64);

test("verified Artifact Evidence is authority-bound and digest-stable", () => {
  const resource: EvidenceResource = { type: "artifact", namespace: "workspace", path: "dist/report.json", sha256: HASH, sizeBytes: 42, mediaType: "application/json" };
  const left = createEvidenceContract(base({ kind: "artifact", producer: "artifact_verifier", assurance: "verified", indexOnly: false, resource,
    criterionBindings: [{ criterionId: "criterion-1", relation: "supports" }] }));
  const right = createEvidenceContract(base({ kind: "artifact", producer: "artifact_verifier", assurance: "verified", indexOnly: false, resource,
    criterionBindings: [{ criterionId: "criterion-1", relation: "supports" }] }));
  validateEvidenceContract(left);
  assert.equal(left.normalizedDigest, right.normalizedDigest);
  assert.equal(left.authority.requirementRevision, 2);
});

test("Worker and Summary Evidence cannot self-promote into completion proof", () => {
  const workerVerified = createEvidenceContract(base({ producer: "worker", assurance: "verified" }));
  assert.throws(() => validateEvidenceContract(workerVerified), /Worker Evidence cannot claim/);

  const supportingSummary = createEvidenceContract(base({ criterionBindings: [{ criterionId: "criterion-1", relation: "supports" }] }));
  assert.throws(() => validateEvidenceContract(supportingSummary), /Index-only Evidence/);

  assert.throws(() => createEvidenceContract({ ...base(), completionProof: { completed: true } } as EvidenceContractInput), /unknown field/);
});

test("Evidence captures and freezes plain data while rejecting getters and Proxy inputs", () => {
  const input = base();
  const bindings = input.criterionBindings;
  const evidence = createEvidenceContract(input);
  bindings.push({ criterionId: "late-criterion", relation: "supports" });
  assert.equal(evidence.criterionBindings.length, 1);
  assert.equal(Object.isFrozen(evidence.authority), true);
  assert.throws(() => validateEvidenceContract(new Proxy(evidence, {})), /Proxy/);

  const getterInput = base();
  Object.defineProperty(getterInput, "summary", { enumerable: true, get: () => "forged" });
  assert.throws(() => createEvidenceContract(getterInput), /getters or setters/);
  assert.throws(() => createEvidenceContract(new Proxy(base(), {}) as EvidenceContractInput), /Proxy/);
  assert.throws(() => createEvidenceContract({ ...base(), schemaVersion: 2 as 1 }), /schemaVersion/);
  assert.throws(() => createEvidenceContract({ ...base(), resource: { type: "proof" } as never }), /resource.type/);
});

export function base(overrides: Partial<EvidenceContractInput> = {}): EvidenceContractInput {
  return {
    schemaVersion: 1,
    id: "evidence-1",
    authority: {
      threadId: "thread-1", turnId: "turn-1",
      requirementId: "req-1", requirementRevision: 2, requirementContentHash: HASH,
      planId: "plan-1", planVersion: "v2", contractDigest: HASH, jobId: "job-1", jobAttempt: 1,
      taskId: "task-1", taskAttempt: 1, runId: "run-1",
    },
    criterionBindings: [{ criterionId: "criterion-1", relation: "informational" }],
    kind: "summary",
    producer: "worker",
    assurance: "observed",
    freshness: { observedAt: "2026-08-20T00:00:00.000Z", recordedAt: "2026-08-20T00:00:01.000Z", inputDigest: HASH },
    summary: "Observed result",
    indexOnly: true,
    resource: { type: "summary", indexOnly: true },
    compatibility: "native_v1",
    ...overrides,
  };
}
