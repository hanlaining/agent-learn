import type { AgentReasoningEffort } from "./agent-profile.js";

export type AgentCollaborationMode = "off" | "auto" | "manual";
export type AgentRole = "investigator" | "researcher" | "coder" | "tester" | "reviewer";
export type AgentAccessMode = "read_only" | "workspace" | "full_access";

export interface AgentTeamConfig {
  version: 1;
  mode: AgentCollaborationMode;
  maxSubagents: number;
  maxConcurrent: number;
  maxDepth: number;
  allowedProfiles: AgentRole[];
  scheduling: "dependency_graph" | "independent_only";
  accessMode: AgentAccessMode;
  permissionMode: "least_privilege" | "inherit_chat";
  shareBoard: boolean;
  independentReview: boolean;
  modelRouting: "inherit_chat" | "role_based";
  roleModels?: Partial<Record<AgentRole, {
    model: string;
    reasoningEffort?: AgentReasoningEffort;
  }>>;
  allowedTools?: string[];
  allowedSkills?: string[];
}

export const DEFAULT_AGENT_TEAM_CONFIG: AgentTeamConfig = {
  version: 1,
  mode: "auto",
  maxSubagents: 10,
  maxConcurrent: 4,
  maxDepth: 3,
  allowedProfiles: ["investigator", "researcher", "coder", "tester", "reviewer"],
  scheduling: "dependency_graph",
  accessMode: "workspace",
  permissionMode: "least_privilege",
  shareBoard: true,
  independentReview: true,
  modelRouting: "inherit_chat",
  allowedTools: ["*"],
  allowedSkills: ["*"],
};

export type AgentJobStatus =
  | "queued" | "planning" | "running" | "waiting_dependencies"
  | "waiting_returns" | "reviewing" | "resuming"
  | "completed" | "partial" | "failed" | "cancelled";

export interface AgentJob {
  id: string;
  threadId: string;
  rootTurnId: string;
  rootRunId: string;
  configSnapshot: AgentTeamConfig;
  status: AgentJobStatus;
  createdAt: string;
  completedAt?: string;
}

export type AgentTaskStatus =
  | "draft" | "blocked" | "ready" | "claimed" | "running"
  | "awaiting_evidence" | "reviewing" | "rework"
  | "completed" | "failed" | "cancelled" | "lost";

export interface AgentTask {
  id: string;
  jobId: string;
  rootRunId: string;
  ownerRunId: string;
  parentTaskId?: string;
  profileId: string;
  title: string;
  objective: string;
  scope: { allowedPaths: string[]; deniedPaths: string[]; nonGoals: string[] };
  requiredOutputs: string[];
  acceptanceCriteria: string[];
  dependencyIds: string[];
  fileClaims: string[];
  attempt: number;
  maxAttempts: number;
  status: AgentTaskStatus;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  heartbeatAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentTaskEdge {
  id: string;
  jobId: string;
  fromTaskId: string;
  toTaskId: string;
  type: "depends_on" | "blocks" | "produces" | "validates";
  hard: boolean;
  artifactKey?: string;
  createdAt: string;
}

export interface AgentEvidence {
  id: string;
  jobId: string;
  taskId: string;
  runId: string;
  kind: "summary" | "source" | "artifact" | "diff" | "test" | "screenshot" | "review" | "remote_state";
  uri?: string;
  digest?: string;
  summary: string;
  producer: "worker" | "runtime" | "reviewer";
  verdict: "unverified" | "supported" | "passed" | "failed";
  severity?: "P0" | "P1" | "P2" | "P3";
  createdAt: string;
}

export interface SharedBoardEntry {
  id: string;
  jobId: string;
  producerRunId: string;
  kind: "fact" | "artifact" | "source" | "decision" | "test_result" | "file_claim" | "warning" | "summary";
  title: string;
  summary: string;
  payload?: unknown;
  confidence: "unverified" | "supported" | "confirmed";
  visibility: "job" | "parent_only";
  createdAt: string;
  supersedesId?: string;
}

export type AgentReturnStatus = "ready" | "delivering" | "consumed" | "failed";
export interface AgentReturnEnvelope {
  id: string;
  jobId: string;
  rootRunId: string;
  parentRunId: string;
  childRunId: string;
  taskId: string;
  sequence: number;
  status: AgentReturnStatus;
  result: {
    status: "completed" | "failed" | "cancelled" | "timed_out";
    summary: string;
    evidenceIds: string[];
    boardEntryIds: string[];
  };
  idempotencyKey: string;
  attempts: number;
  nextAttemptAt?: string;
  createdAt: string;
  consumedAt?: string;
}

export interface AgentRuntimeSnapshot {
  version: 1;
  sequence: number;
  jobs: AgentJob[];
  tasks: AgentTask[];
  edges: AgentTaskEdge[];
  evidence: AgentEvidence[];
  board: SharedBoardEntry[];
  returns: AgentReturnEnvelope[];
  returnReceipts: string[];
}

export function normalizeAgentTeamConfig(value: Partial<AgentTeamConfig> = {}): AgentTeamConfig {
  const maxSubagents = clampInteger(value.maxSubagents, 1, 10, 10);
  return {
    ...DEFAULT_AGENT_TEAM_CONFIG,
    ...structuredClone(value),
    version: 1,
    maxSubagents,
    maxConcurrent: clampInteger(value.maxConcurrent, 1, maxSubagents, Math.min(4, maxSubagents)),
    maxDepth: clampInteger(value.maxDepth, 1, 3, 3),
    accessMode: value.accessMode === "read_only" || value.accessMode === "full_access"
      ? value.accessMode
      : "workspace",
    allowedProfiles: [...(value.allowedProfiles ?? DEFAULT_AGENT_TEAM_CONFIG.allowedProfiles)],
  };
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  return Number.isInteger(value) ? Math.max(min, Math.min(max, value!)) : fallback;
}
