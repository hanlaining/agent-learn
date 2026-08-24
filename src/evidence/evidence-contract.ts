export const EVIDENCE_CONTRACT_SCHEMA_VERSION = 1 as const;

export type EvidenceKind =
  | "summary"
  | "source"
  | "artifact"
  | "diff"
  | "test"
  | "oracle"
  | "review"
  | "remote_state"
  | "runtime_event"
  | "screenshot";

export type EvidenceProducer =
  | "worker"
  | "runtime"
  | "artifact_verifier"
  | "test_verifier"
  | "oracle_verifier"
  | "reviewer"
  | "arbiter"
  | "user";

export type EvidenceAssurance =
  | "unverified"
  | "observed"
  | "verified"
  | "contradicted"
  | "outcome_unknown";

/** EvidenceLineage binding; this is not Runtime AuthorityOwnership or a Store writer claim. */
export interface EvidenceAuthority {
  threadId: string | null;
  turnId: string | null;
  requirementId: string | null;
  requirementRevision: number | null;
  requirementContentHash: string | null;
  planId: string | null;
  /** Requirement Plan version. It must never be substituted with Runtime workflowVersion. */
  planVersion: string | null;
  contractDigest: string | null;
  jobId: string;
  jobAttempt: number | null;
  taskId: string;
  taskAttempt: number | null;
  runId: string;
}

export interface EvidenceCriterionBinding {
  criterionId: string;
  relation: "informational" | "supports" | "contradicts";
}

export interface EvidenceFreshness {
  observedAt: string;
  recordedAt: string;
  validUntil?: string;
  inputDigest: string | null;
}

export interface SummaryEvidenceResource {
  type: "summary";
  indexOnly: true;
}

export interface SourceEvidenceResource {
  type: "source";
  uri: string;
  title: string;
  contentDigest?: string;
}

export interface ArtifactEvidenceResource {
  type: "artifact";
  namespace: string;
  path: string;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
}

export interface DiffEvidenceResource {
  type: "diff";
  namespace: string;
  path: string;
  baseDigest: string;
  resultDigest: string;
}

export interface ScreenshotEvidenceResource {
  type: "screenshot";
  namespace: string;
  path: string;
  sha256: string;
  width: number;
  height: number;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
}

export interface TestEvidenceResource {
  type: "test";
  invocationId: string;
  recipeId: string;
  commandDigest: string;
  environmentDigest: string;
  startedAt: string;
  completedAt: string;
  status: "passed" | "failed" | "timed_out" | "cancelled" | "unknown";
  exitCode?: number;
  reportArtifactIds: string[];
}

export interface OracleEvidenceResource {
  type: "oracle";
  oracleId: string;
  oracleVersion: string;
  queryDigest: string;
  observationDigest: string;
  status: "satisfied" | "contradicted" | "unavailable" | "unknown";
  requestId?: string;
}

export interface ReviewEvidenceResource {
  type: "review";
  reviewedEvidenceIds: string[];
  verdict: "passed" | "rejected" | "inconclusive";
  severity?: "P0" | "P1" | "P2" | "P3";
}

export interface RemoteStateEvidenceResource {
  type: "remote_state";
  systemId: string;
  objectId: string;
  stateDigest: string;
  requestId?: string;
}

export interface RuntimeEventEvidenceResource {
  type: "runtime_event";
  /** C04 must register eventType↔aggregate semantics; v1 only binds the actual envelope digest and identity. */
  eventId: string;
  eventType: string;
  eventDigest: string;
}

export interface LegacyEvidenceResource {
  type: "legacy";
  legacyKind: string;
  legacyVerdict: string;
  uri?: string;
  digest?: string;
}

export type EvidenceResource =
  | SummaryEvidenceResource
  | SourceEvidenceResource
  | ArtifactEvidenceResource
  | DiffEvidenceResource
  | ScreenshotEvidenceResource
  | TestEvidenceResource
  | OracleEvidenceResource
  | ReviewEvidenceResource
  | RemoteStateEvidenceResource
  | RuntimeEventEvidenceResource
  | LegacyEvidenceResource;

export interface EvidenceContract {
  schemaVersion: typeof EVIDENCE_CONTRACT_SCHEMA_VERSION;
  id: string;
  authority: EvidenceAuthority;
  criterionBindings: EvidenceCriterionBinding[];
  kind: EvidenceKind;
  producer: EvidenceProducer;
  assurance: EvidenceAssurance;
  freshness: EvidenceFreshness;
  summary: string;
  indexOnly: boolean;
  resource: EvidenceResource;
  compatibility: "native_v1" | "legacy_projected";
  normalizedDigest: string;
}

/** Evidence is an input fact only. CompletionProof is intentionally a separate, unimplemented contract. */

export type EvidenceContractInput = Omit<EvidenceContract, "normalizedDigest">;

export interface CurrentEvidenceAuthority {
  threadId: string;
  turnId: string;
  requirementId: string;
  requirementRevision: number;
  requirementContentHash: string;
  planId: string;
  planVersion: string;
  contractDigest: string;
  jobId: string;
  jobAttempt: number;
  taskId: string;
  taskAttempt: number;
  runId: string;
  inputDigest: string;
  at: string;
}
