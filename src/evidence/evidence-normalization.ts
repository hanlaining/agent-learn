import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import type {
  EvidenceContract,
  EvidenceContractInput,
  EvidenceResource,
} from "./evidence-contract.js";

export function createEvidenceContract(input: EvidenceContractInput): EvidenceContract {
  const captured = capturePlainData(input);
  assertEvidenceInputKeys(captured);
  const normalized = normalizeCapturedEvidence(captured);
  return deepFreeze({ ...normalized, normalizedDigest: digestEvidence(normalized) });
}

export function recomputeEvidenceDigest(evidence: EvidenceContract): string {
  const { normalizedDigest: _ignored, ...input } = evidence;
  return digestEvidence(normalizeEvidenceShape(input));
}

export function normalizeEvidenceShape(input: EvidenceContractInput): EvidenceContractInput {
  const captured = capturePlainData(input);
  assertEvidenceInputKeys(captured);
  return normalizeCapturedEvidence(captured);
}

function normalizeCapturedEvidence(input: EvidenceContractInput): EvidenceContractInput {
  return {
    schemaVersion: 1,
    id: input.id,
    authority: { ...input.authority },
    criterionBindings: [...input.criterionBindings]
      .map((binding) => ({ ...binding }))
      .sort((left, right) => `${left.criterionId}\u0000${left.relation}`.localeCompare(`${right.criterionId}\u0000${right.relation}`)),
    kind: input.kind,
    producer: input.producer,
    assurance: input.assurance,
    freshness: { ...input.freshness },
    summary: input.summary,
    indexOnly: input.indexOnly,
    resource: normalizeResource(input.resource),
    compatibility: input.compatibility,
  };
}

function normalizeResource(resource: EvidenceResource): EvidenceResource {
  if (resource.type === "review") {
    return { ...resource, reviewedEvidenceIds: [...new Set(resource.reviewedEvidenceIds)].sort() };
  }
  if (resource.type === "test") {
    return { ...resource, reportArtifactIds: [...new Set(resource.reportArtifactIds)].sort() };
  }
  return { ...resource };
}

function digestEvidence(input: EvidenceContractInput): string {
  return createHash("sha256").update(stableJson(input)).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) output[key] = sortJson(entry);
    }
    return output;
  }
  return value;
}

function assertEvidenceInputKeys(input: EvidenceContractInput): void {
  assertExactKeys(input, ["schemaVersion", "id", "authority", "criterionBindings", "kind", "producer", "assurance", "freshness", "summary", "indexOnly", "resource", "compatibility"], "Evidence");
  assertExactKeys(input.authority, ["threadId", "turnId", "requirementId", "requirementRevision", "requirementContentHash", "planId", "planVersion", "contractDigest", "jobId", "jobAttempt", "taskId", "taskAttempt", "runId"], "Evidence.authority");
  for (const binding of input.criterionBindings) assertExactKeys(binding, ["criterionId", "relation"], "Evidence.criterionBindings[]");
  assertExactKeys(input.freshness, ["observedAt", "recordedAt", "validUntil", "inputDigest"], "Evidence.freshness");
  const resourceKeys: Record<EvidenceResource["type"], readonly string[]> = {
    summary: ["type", "indexOnly"],
    source: ["type", "uri", "title", "contentDigest"],
    artifact: ["type", "namespace", "path", "sha256", "sizeBytes", "mediaType"],
    diff: ["type", "namespace", "path", "baseDigest", "resultDigest"],
    screenshot: ["type", "namespace", "path", "sha256", "width", "height", "mediaType"],
    test: ["type", "invocationId", "recipeId", "commandDigest", "environmentDigest", "startedAt", "completedAt", "status", "exitCode", "reportArtifactIds"],
    oracle: ["type", "oracleId", "oracleVersion", "queryDigest", "observationDigest", "status", "requestId"],
    review: ["type", "reviewedEvidenceIds", "verdict", "severity"],
    remote_state: ["type", "systemId", "objectId", "stateDigest", "requestId"],
    runtime_event: ["type", "eventId", "eventType", "eventDigest"],
    legacy: ["type", "legacyKind", "legacyVerdict", "uri", "digest"],
  };
  assertEnum(input.resource.type, Object.keys(resourceKeys), "resource.type");
  assertExactKeys(input.resource, resourceKeys[input.resource.type], `Evidence.resource.${input.resource.type}`);
  if (input.schemaVersion !== 1) throw new Error("Unsupported Evidence schemaVersion");
  assertEnum(input.kind, ["summary", "source", "artifact", "diff", "test", "oracle", "review", "remote_state", "runtime_event", "screenshot"], "kind");
  assertEnum(input.producer, ["worker", "runtime", "artifact_verifier", "test_verifier", "oracle_verifier", "reviewer", "arbiter", "user"], "producer");
  assertEnum(input.assurance, ["unverified", "observed", "verified", "contradicted", "outcome_unknown"], "assurance");
  assertEnum(input.compatibility, ["native_v1", "legacy_projected"], "compatibility");
  for (const binding of input.criterionBindings) assertEnum(binding.relation, ["informational", "supports", "contradicts"], "criterion relation");
  if (input.compatibility === "native_v1" && input.resource.type !== input.kind) throw new Error("Evidence kind and resource discriminator do not match");
}

function assertEnum(value: string, allowed: readonly string[], field: string): void {
  if (!allowed.includes(value)) throw new Error(`Invalid Evidence ${field}`);
}

function assertExactKeys(value: object, allowed: readonly string[], field: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${field} contains unknown field: ${unknown.sort().join(",")}`);
}

function capturePlainData<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (isProxy(value)) throw new Error("Evidence input cannot contain a Proxy");
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) throw new Error("Evidence input cannot contain accessors or sparse arrays");
      output.push(capturePlainData(descriptor.value));
    }
    return output as T;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("Evidence input must contain plain data objects");
  const output: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.get !== undefined || descriptor.set !== undefined) throw new Error("Evidence input cannot contain getters or setters");
    output[key] = capturePlainData(descriptor.value);
  }
  return output as T;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}
