import type { AgentEvidence } from "../agents/agent-runtime.js";
import type { EvidenceKind } from "./evidence-contract.js";
import { createValidatedEvidenceContract, type ValidatedEvidenceContract } from "./evidence-validation.js";

export interface LegacyEvidenceProjectionContext {
  threadId?: string;
  turnId?: string;
  requirementId?: string;
  requirementRevision?: number;
  requirementContentHash?: string;
  planId?: string;
  planVersion?: string;
  contractDigest?: string;
  jobAttempt?: number;
  taskAttempt?: number;
  inputDigest?: string;
  recordedAt?: string;
}

export function projectLegacyEvidence(
  legacy: AgentEvidence,
  context: LegacyEvidenceProjectionContext = {},
): ValidatedEvidenceContract {
  return createValidatedEvidenceContract({
    schemaVersion: 1,
    id: legacy.id,
    authority: {
      threadId: context.threadId ?? null,
      turnId: context.turnId ?? null,
      requirementId: context.requirementId ?? null,
      requirementRevision: context.requirementRevision ?? null,
      requirementContentHash: context.requirementContentHash ?? null,
      planId: context.planId ?? null,
      planVersion: context.planVersion ?? null,
      contractDigest: context.contractDigest ?? null,
      jobId: legacy.jobId,
      jobAttempt: legacy.jobAttempt ?? context.jobAttempt ?? null,
      taskId: legacy.taskId,
      taskAttempt: context.taskAttempt ?? null,
      runId: legacy.runId,
    },
    criterionBindings: [],
    kind: legacy.kind as EvidenceKind,
    producer: legacy.producer,
    assurance: "unverified",
    freshness: {
      observedAt: legacy.createdAt,
      recordedAt: context.recordedAt ?? legacy.createdAt,
      inputDigest: context.inputDigest ?? null,
    },
    summary: legacy.summary,
    indexOnly: true,
    resource: {
      type: "legacy",
      legacyKind: legacy.kind,
      legacyVerdict: legacy.verdict,
      ...(legacy.uri === undefined ? {} : { uri: legacy.uri }),
      ...(legacy.digest === undefined ? {} : { digest: legacy.digest }),
    },
    compatibility: "legacy_projected",
  });
}
