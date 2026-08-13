export type RequirementStatus =
  | "clarifying"
  | "planned"
  | "confirmed"
  | "executing"
  | "completed"
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
    ["confirmed", "executing"].includes(value.status) &&
    value.confirmedRevision === value.revision &&
    value.confirmedContentHash === value.planArtifact.contentHash;
}
