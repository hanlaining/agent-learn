export type RequirementStatus =
  | "clarifying"
  | "planned"
  | "confirmed"
  | "executing"
  | "failed_retryable"
  | "completed"
  | "cancelled";

export type RequirementExecutionKind =
  | "analysis_only"
  | "software_change"
  | "software_product_delivery";

export type RequirementExecutionState =
  | "not_started"
  | "executing"
  | "completed"
  | "failed_retryable"
  | "cancelled";

export interface RequirementTestCase {
  id: string;
  title: string;
  kind: "positive" | "negative" | "permission" | "recovery" | "ui" | "integration";
  steps: string[];
  expected: string;
}

export interface RequirementPlanArtifact {
  path: string;
  contentHash: string;
  generatedAt: string;
}

export interface RequirementDraft {
  executionKind: RequirementExecutionKind;
  title: string;
  objective: string;
  scope: string[];
  nonGoals: string[];
  constraints: string[];
  deliverables: string[];
  acceptanceCriteria: string[];
  testCases: RequirementTestCase[];
  executionSteps: string[];
}

export interface Requirement extends RequirementDraft {
  id: string;
  parentThreadId: string;
  revision: number;
  status: RequirementStatus;
  executionState: RequirementExecutionState;
  planArtifact: RequirementPlanArtifact;
  createdAt: string;
  updatedAt: string;
  confirmedRevision?: number;
  confirmedContentHash?: string;
  confirmedAt?: string;
  jobId?: string;
}

export interface RequirementSnapshot {
  version: 1;
  sequence: number;
  requirements: Requirement[];
}

export function isRequirementConfirmed(value: Requirement | undefined): boolean {
  return value !== undefined &&
    value.status !== "planned" && value.status !== "clarifying" && value.status !== "cancelled" &&
    value.confirmedRevision === value.revision &&
    value.confirmedContentHash === value.planArtifact.contentHash;
}
