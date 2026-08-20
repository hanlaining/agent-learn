import {
  EVIDENCE_CONTRACT_SCHEMA_VERSION,
  type CurrentEvidenceAuthority,
  type EvidenceContract,
  type EvidenceResource,
} from "./evidence-contract.js";
import { createEvidenceContract, recomputeEvidenceDigest } from "./evidence-normalization.js";
import { isProxy } from "node:util/types";
import { intersectCapabilityGrants, type CapabilityIntersectionInput } from "../capabilities/capability-intersection.js";
import {
  assertRuntimeEventEnvelope,
  digestRuntimeEventEnvelope,
  type RuntimeEventEnvelopeV1,
} from "../runtime/runtime-event.js";

const DIGEST = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const VERIFIED_PRODUCERS = new Set(["artifact_verifier", "test_verifier", "oracle_verifier", "reviewer", "arbiter"]);
const RESOURCE_BY_KIND: Partial<Record<EvidenceContract["kind"], EvidenceResource["type"]>> = {
  summary: "summary",
  source: "source",
  artifact: "artifact",
  diff: "diff",
  test: "test",
  oracle: "oracle",
  review: "review",
  remote_state: "remote_state",
  runtime_event: "runtime_event",
  screenshot: "screenshot",
};

export function validateEvidenceContract(evidence: EvidenceContract): void {
  assertDeepFrozenPlainData(evidence, "Evidence");
  if (evidence.schemaVersion !== EVIDENCE_CONTRACT_SCHEMA_VERSION) throw new Error("Unsupported Evidence schemaVersion");
  assertEnum(evidence.kind, ["summary", "source", "artifact", "diff", "test", "oracle", "review", "remote_state", "runtime_event", "screenshot"], "kind");
  assertEnum(evidence.producer, ["worker", "runtime", "artifact_verifier", "test_verifier", "oracle_verifier", "reviewer", "arbiter", "user"], "producer");
  assertEnum(evidence.assurance, ["unverified", "observed", "verified", "contradicted", "outcome_unknown"], "assurance");
  assertEnum(evidence.compatibility, ["native_v1", "legacy_projected"], "compatibility");
  assertIdentifier(evidence.id, "evidence.id");
  assertIdentifier(evidence.authority.jobId, "authority.jobId");
  assertIdentifier(evidence.authority.taskId, "authority.taskId");
  assertIdentifier(evidence.authority.runId, "authority.runId");
  if (evidence.compatibility === "native_v1") validateNativeAuthority(evidence);
  validateTimestamp(evidence.freshness.observedAt, "freshness.observedAt");
  validateTimestamp(evidence.freshness.recordedAt, "freshness.recordedAt");
  if (Date.parse(evidence.freshness.recordedAt) < Date.parse(evidence.freshness.observedAt)) {
    throw new Error("Evidence cannot be recorded before it was observed");
  }
  if (evidence.freshness.validUntil !== undefined) {
    validateTimestamp(evidence.freshness.validUntil, "freshness.validUntil");
    if (Date.parse(evidence.freshness.validUntil) < Date.parse(evidence.freshness.observedAt)) {
      throw new Error("Evidence validUntil precedes observedAt");
    }
  }
  if (evidence.freshness.inputDigest !== null) assertDigest(evidence.freshness.inputDigest, "freshness.inputDigest");
  if (evidence.summary.trim().length === 0) throw new Error("Evidence summary is required");
  const bindingKeys = evidence.criterionBindings.map((binding) => `${binding.criterionId}\u0000${binding.relation}`);
  if (new Set(bindingKeys).size !== bindingKeys.length) throw new Error("Duplicate Evidence criterion binding");
  for (const binding of evidence.criterionBindings) assertIdentifier(binding.criterionId, "criterionId");
  for (const binding of evidence.criterionBindings) assertEnum(binding.relation, ["informational", "supports", "contradicts"], "criterion relation");
  if (evidence.indexOnly && evidence.criterionBindings.some((binding) => binding.relation !== "informational")) {
    throw new Error("Index-only Evidence may only be informational");
  }
  if (["unverified", "contradicted", "outcome_unknown"].includes(evidence.assurance) &&
      evidence.criterionBindings.some((binding) => binding.relation !== "informational")) {
    throw new Error(`${evidence.assurance} Evidence may only be informational`);
  }
  if (evidence.producer === "worker" && !["unverified", "observed"].includes(evidence.assurance)) {
    throw new Error("Worker Evidence cannot claim verified, contradicted, or outcome_unknown assurance");
  }
  if (evidence.assurance === "verified" && !VERIFIED_PRODUCERS.has(evidence.producer)) {
    throw new Error("Only a Verifier, Reviewer, or Arbiter may create verified Evidence");
  }
  if (evidence.compatibility === "native_v1") {
    const resourceType = RESOURCE_BY_KIND[evidence.kind];
    if (resourceType === undefined || evidence.resource.type !== resourceType) {
      throw new Error("Evidence kind and resource discriminator do not match");
    }
  }
  if (evidence.compatibility === "legacy_projected" && (evidence.resource.type !== "legacy" || !evidence.indexOnly)) {
    throw new Error("Legacy Evidence must remain an index-only legacy resource");
  }
  validateResource(evidence);
  assertDigest(evidence.normalizedDigest, "normalizedDigest");
  if (evidence.normalizedDigest !== recomputeEvidenceDigest(evidence)) {
    throw new Error("Evidence normalizedDigest does not match its normalized content");
  }
}

declare const validatedEvidenceContractBrand: unique symbol;
export type ValidatedEvidenceContract = EvidenceContract & {
  readonly [validatedEvidenceContractBrand]: "validated.evidence_contract.v1";
};

/** Deterministic structural validation only; producer authentication remains a production AuthorityOwnership concern. */
export function createValidatedEvidenceContract(input: import("./evidence-contract.js").EvidenceContractInput): ValidatedEvidenceContract {
  const evidence = createEvidenceContract(input);
  validateEvidenceContract(evidence);
  return evidence as ValidatedEvidenceContract;
}

export function validateEvidenceSet(evidence: readonly EvidenceContract[]): void {
  const byId = new Map<string, EvidenceContract>();
  for (const item of evidence) {
    validateEvidenceContract(item);
    if (byId.has(item.id)) throw new Error(`Duplicate Evidence id: ${item.id}`);
    byId.set(item.id, item);
  }
  for (const item of evidence) {
    if (item.resource.type !== "review") continue;
    for (const reviewedId of item.resource.reviewedEvidenceIds) {
      const reviewed = byId.get(reviewedId);
      if (reviewed === undefined) throw new Error(`Review references missing Evidence: ${reviewedId}`);
      if (!sameReviewAuthority(item, reviewed)) {
        throw new Error("Review cannot cross Requirement revision, Plan version, Job, or Job attempt authority boundaries");
      }
    }
    if (item.assurance === "verified") {
      for (const binding of item.criterionBindings.filter((candidate) => candidate.relation !== "informational")) {
        const hasVerifiedBasis = item.resource.reviewedEvidenceIds.some((reviewedId) => {
          const reviewed = byId.get(reviewedId);
          return reviewed !== undefined &&
            reviewed.compatibility === "native_v1" &&
            !reviewed.indexOnly &&
            reviewed.assurance === "verified" &&
            reviewed.criterionBindings.some((candidate) => candidate.criterionId === binding.criterionId && candidate.relation === binding.relation);
        });
        if (!hasVerifiedBasis) {
          throw new Error(`Verified Review lacks native verified ${binding.relation} Evidence for criterion: ${binding.criterionId}`);
        }
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error("Evidence review graph contains a cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    const item = byId.get(id);
    if (item?.resource.type === "review") for (const next of item.resource.reviewedEvidenceIds) visit(next);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) visit(id);
}

/** Recomputes the deterministic five-layer grant; it does not prove a cryptographic production Issuer signature. */
export function validateRuntimeEventEvidenceBinding(
  evidence: EvidenceContract,
  event: RuntimeEventEnvelopeV1,
  capabilityLayers: CapabilityIntersectionInput,
): void {
  validateEvidenceContract(evidence);
  assertRuntimeEventEnvelope(event);
  const capability = intersectCapabilityGrants(capabilityLayers);
  if (evidence.compatibility !== "native_v1" || evidence.kind !== "runtime_event" || evidence.resource.type !== "runtime_event") {
    throw new Error("Runtime Event binding requires native runtime_event Evidence");
  }
  if (capability.compatibility !== "native_v1" || capability.authority.sourceKind !== "intersection") {
    throw new Error("Runtime Event binding requires the final native intersection CapabilityGrant");
  }
  if (evidence.resource.eventId !== event.eventId || evidence.resource.eventType !== event.eventType ||
      evidence.resource.eventDigest !== digestRuntimeEventEnvelope(event)) {
    throw new Error("Runtime Event Evidence resource does not match the actual Event envelope");
  }
  const correlation = event.correlation;
  const authority = evidence.authority;
  if (correlation.turnId === undefined || correlation.requirementId === undefined || correlation.requirementRevision === undefined ||
      correlation.jobId === undefined || correlation.jobAttempt === undefined ||
      correlation.taskId === undefined || correlation.taskAttempt === undefined || correlation.runId === undefined) {
    throw new Error("Task Evidence requires complete Runtime Event Turn/Requirement/Job/Task/Run lineage");
  }
  if (correlation.threadId !== authority.threadId || correlation.turnId !== authority.turnId ||
      correlation.requirementId !== authority.requirementId || correlation.requirementRevision !== authority.requirementRevision ||
      correlation.jobId !== authority.jobId || correlation.jobAttempt !== authority.jobAttempt ||
      correlation.taskId !== authority.taskId || correlation.taskAttempt !== authority.taskAttempt || correlation.runId !== authority.runId) {
    throw new Error("Runtime Event correlation does not match EvidenceLineage");
  }
  const subject = capability.subject;
  if (subject.threadId !== authority.threadId || subject.turnId !== authority.turnId ||
      subject.requirementId !== authority.requirementId || subject.requirementRevision !== authority.requirementRevision ||
      subject.jobId !== authority.jobId || subject.jobAttempt !== authority.jobAttempt ||
      subject.taskId !== authority.taskId || subject.taskAttempt !== authority.taskAttempt || subject.runId !== authority.runId ||
      subject.contractDigest !== authority.contractDigest) {
    throw new Error("CapabilityGrant subject does not match Event and Evidence lineage");
  }
  const confirmation = capability.confirmation;
  if (confirmation === undefined || confirmation.requirementId !== authority.requirementId ||
      confirmation.revision !== authority.requirementRevision || confirmation.contentHash !== authority.requirementContentHash) {
    throw new Error("CapabilityGrant confirmation does not match Evidence Requirement authority");
  }
}

function sameReviewAuthority(review: EvidenceContract, reviewed: EvidenceContract): boolean {
  return review.authority.threadId === reviewed.authority.threadId &&
    review.authority.turnId === reviewed.authority.turnId &&
    review.authority.requirementId === reviewed.authority.requirementId &&
    review.authority.requirementRevision === reviewed.authority.requirementRevision &&
    review.authority.requirementContentHash === reviewed.authority.requirementContentHash &&
    review.authority.planId === reviewed.authority.planId &&
    review.authority.planVersion === reviewed.authority.planVersion &&
    review.authority.jobId === reviewed.authority.jobId &&
    review.authority.jobAttempt === reviewed.authority.jobAttempt;
}

export function isEvidenceFreshFor(evidence: EvidenceContract, current: CurrentEvidenceAuthority): boolean {
  const authority = evidence.authority;
  return evidence.compatibility === "native_v1" &&
    authority.threadId === current.threadId &&
    authority.turnId === current.turnId &&
    authority.requirementId === current.requirementId &&
    authority.requirementRevision === current.requirementRevision &&
    authority.requirementContentHash === current.requirementContentHash &&
    authority.planId === current.planId &&
    authority.planVersion === current.planVersion &&
    authority.contractDigest === current.contractDigest &&
    authority.jobId === current.jobId &&
    authority.jobAttempt === current.jobAttempt &&
    authority.taskId === current.taskId &&
    authority.taskAttempt === current.taskAttempt &&
    authority.runId === current.runId &&
    evidence.freshness.inputDigest === current.inputDigest &&
    (evidence.freshness.validUntil === undefined || Date.parse(evidence.freshness.validUntil) >= Date.parse(current.at));
}

function validateNativeAuthority(evidence: EvidenceContract): void {
  const authority = evidence.authority;
  assertIdentifier(authority.threadId, "authority.threadId");
  assertIdentifier(authority.turnId, "authority.turnId");
  assertIdentifier(authority.requirementId, "authority.requirementId");
  assertPositiveInteger(authority.requirementRevision, "authority.requirementRevision");
  assertDigest(authority.requirementContentHash, "authority.requirementContentHash");
  assertIdentifier(authority.planId, "authority.planId");
  assertIdentifier(authority.planVersion, "authority.planVersion");
  assertDigest(authority.contractDigest, "authority.contractDigest");
  assertPositiveInteger(authority.jobAttempt, "authority.jobAttempt");
  assertPositiveInteger(authority.taskAttempt, "authority.taskAttempt");
  if (evidence.freshness.inputDigest === null) throw new Error("Native Evidence requires an inputDigest");
}

function validateResource(evidence: EvidenceContract): void {
  const resource = evidence.resource;
  switch (resource.type) {
    case "summary":
      if (!evidence.indexOnly || !resource.indexOnly) throw new Error("Summary Evidence must always be index-only");
      return;
    case "source":
      if (resource.uri.trim().length === 0 || resource.title.trim().length === 0) throw new Error("Source Evidence is incomplete");
      if (resource.contentDigest !== undefined) assertDigest(resource.contentDigest, "source.contentDigest");
      return;
    case "artifact":
      assertIdentifier(resource.namespace, "artifact.namespace");
      assertSafeRelativePath(resource.path, "artifact.path");
      assertDigest(resource.sha256, "artifact.sha256");
      assertNonNegativeInteger(resource.sizeBytes, "artifact.sizeBytes");
      if (!resource.mediaType.includes("/")) throw new Error("Invalid artifact.mediaType");
      ensureVerifiedProducerMatchesKind(evidence, "artifact_verifier");
      return;
    case "diff":
      assertIdentifier(resource.namespace, "diff.namespace");
      assertSafeRelativePath(resource.path, "diff.path");
      assertDigest(resource.baseDigest, "diff.baseDigest");
      assertDigest(resource.resultDigest, "diff.resultDigest");
      return;
    case "screenshot":
      assertIdentifier(resource.namespace, "screenshot.namespace");
      assertSafeRelativePath(resource.path, "screenshot.path");
      assertDigest(resource.sha256, "screenshot.sha256");
      assertPositiveInteger(resource.width, "screenshot.width");
      assertPositiveInteger(resource.height, "screenshot.height");
      if (!["image/png", "image/jpeg", "image/webp"].includes(resource.mediaType)) throw new Error("Invalid screenshot.mediaType");
      ensureVerifiedProducerMatchesKind(evidence, "artifact_verifier");
      return;
    case "test":
      assertIdentifier(resource.invocationId, "test.invocationId");
      assertIdentifier(resource.recipeId, "test.recipeId");
      assertDigest(resource.commandDigest, "test.commandDigest");
      assertDigest(resource.environmentDigest, "test.environmentDigest");
      validateTimestamp(resource.startedAt, "test.startedAt");
      validateTimestamp(resource.completedAt, "test.completedAt");
      if (Date.parse(resource.completedAt) < Date.parse(resource.startedAt)) throw new Error("Test completed before it started");
      if (resource.exitCode !== undefined && !Number.isSafeInteger(resource.exitCode)) throw new Error("Invalid test.exitCode");
      if (resource.status === "passed" && resource.exitCode !== undefined && resource.exitCode !== 0) throw new Error("Passed Test has a non-zero exit code");
      if (evidence.producer === "worker" && resource.status === "passed" && evidence.criterionBindings.some((binding) => binding.relation === "supports")) {
        throw new Error("A Worker self-reported passed Test cannot support completion");
      }
      ensureVerifiedProducerMatchesKind(evidence, "test_verifier");
      return;
    case "oracle":
      assertIdentifier(resource.oracleId, "oracle.oracleId");
      assertIdentifier(resource.oracleVersion, "oracle.oracleVersion");
      assertDigest(resource.queryDigest, "oracle.queryDigest");
      assertDigest(resource.observationDigest, "oracle.observationDigest");
      if (["unavailable", "unknown"].includes(resource.status)) {
        if (evidence.assurance === "verified" || evidence.criterionBindings.some((binding) => binding.relation === "supports")) {
          throw new Error("Unavailable or unknown Oracle Evidence cannot become successful proof");
        }
      }
      ensureVerifiedProducerMatchesKind(evidence, "oracle_verifier");
      return;
    case "review":
      if (resource.reviewedEvidenceIds.length === 0 && evidence.compatibility === "native_v1") throw new Error("Review must cite real Evidence");
      if (resource.reviewedEvidenceIds.includes(evidence.id)) throw new Error("Review Evidence cannot review itself");
      if (evidence.assurance === "verified" && resource.verdict !== "passed") throw new Error("Only a passed Review may claim verified assurance");
      return;
    case "remote_state":
      assertIdentifier(resource.systemId, "remote_state.systemId");
      assertIdentifier(resource.objectId, "remote_state.objectId");
      assertDigest(resource.stateDigest, "remote_state.stateDigest");
      return;
    case "runtime_event":
      assertIdentifier(resource.eventId, "runtime_event.eventId");
      assertIdentifier(resource.eventType, "runtime_event.eventType");
      assertDigest(resource.eventDigest, "runtime_event.eventDigest");
      return;
    case "legacy":
      if (evidence.compatibility !== "legacy_projected") throw new Error("Native Evidence cannot use a legacy resource");
      return;
  }
}

function ensureVerifiedProducerMatchesKind(evidence: EvidenceContract, expected: "artifact_verifier" | "test_verifier" | "oracle_verifier"): void {
  if (evidence.assurance === "verified" && ![expected, "reviewer", "arbiter"].includes(evidence.producer)) {
    throw new Error(`Verified ${evidence.kind} Evidence requires its dedicated Verifier, Reviewer, or Arbiter`);
  }
}

function assertSafeRelativePath(value: string, field: string): void {
  if (value.length === 0 || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) throw new Error(`Invalid ${field}`);
  if (value.split("/").some((part) => part.length === 0 || part === "." || part === "..")) throw new Error(`Invalid ${field}`);
}

function assertIdentifier(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new Error(`Invalid ${field}`);
}

function assertDigest(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new Error(`Invalid ${field}`);
}

function assertPositiveInteger(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${field}`);
}

function assertNonNegativeInteger(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${field}`);
}

function validateTimestamp(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`Invalid ${field}`);
}

function assertEnum(value: string, allowed: readonly string[], field: string): void {
  if (!allowed.includes(value)) throw new Error(`Invalid Evidence ${field}`);
}

function assertDeepFrozenPlainData(value: unknown, field: string): void {
  if (value === null || typeof value !== "object") return;
  if (isProxy(value)) throw new Error(`${field} cannot be a Proxy`);
  if (!Object.isFrozen(value)) throw new Error(`${field} must be a frozen stable snapshot`);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new Error(`${field} must contain plain data objects`);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (key === "length" && Array.isArray(value)) continue;
    if (descriptor.get !== undefined || descriptor.set !== undefined) throw new Error(`${field} cannot contain getters or setters`);
    assertDeepFrozenPlainData(descriptor.value, `${field}.${key}`);
  }
}
