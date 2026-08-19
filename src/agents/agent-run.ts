export type AgentRunStatus =
  | "queued" | "running" | "waiting_children" | "resuming"
  | "completed" | "failed" | "cancelled" | "timed_out";

/**
 * Execution status answers whether code actually ran. Coordination status
 * explains why a Run is waiting/stopped without turning dependency feedback
 * into a false self-failure. All fields are optional for v1/v2 snapshots.
 */
export type AgentCoordinationStatus =
  | "waiting_assignment" | "waiting_parent" | "waiting_children" | "waiting_review"
  | "feedback_required" | "rework_required" | "upstream_blocked" | "skipped";

export type AgentAttentionLevel = "neutral" | "active" | "success" | "feedback" | "error";

export type AgentFailureOrigin =
  | "self" | "parent" | "dependency" | "runtime" | "provider" | "tool" | "contract";

export interface AgentRunResult {
  runId: string;
  taskId?: string;
  status: "completed" | "failed" | "cancelled" | "timed_out";
  summary: string;
  safeError?: string;
  failureOrigin?: AgentFailureOrigin;
  evidenceIds?: string[];
  boardEntryIds?: string[];
  boardEntries?: SharedBoardEntry[];
  reviewerVerdict?: { passed: boolean; summary: string };
}

export interface AgentRun {
  id: string;
  jobId: string;
  rootRunId: string;
  taskId?: string;
  attempt: number;
  threadId: string;
  turnId: string;
  agentProfileId: string;
  parentRunId?: string;
  childRunIds: string[];
  status: AgentRunStatus;
  coordinationStatus?: AgentCoordinationStatus;
  attentionLevel?: AgentAttentionLevel;
  statusMessage?: string;
  failureOrigin?: AgentFailureOrigin;
  task: string;
  depth: number;
  createdAt: string;
  completedAt?: string;
  result?: AgentRunResult;
}

export interface AgentRunSnapshot {
  version: 2;
  sequence: number;
  runs: AgentRun[];
  returnReceipts: string[];
}
import type { SharedBoardEntry } from "./agent-runtime.js";
