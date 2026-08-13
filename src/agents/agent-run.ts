export type AgentRunStatus =
  | "queued" | "running" | "waiting_children" | "resuming"
  | "completed" | "failed" | "cancelled" | "timed_out";

export interface AgentRunResult {
  runId: string;
  taskId?: string;
  status: "completed" | "failed" | "cancelled" | "timed_out";
  summary: string;
  safeError?: string;
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
