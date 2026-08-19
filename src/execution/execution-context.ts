import type { RequirementExecutionKind } from "../requirements/requirement.js";

export interface ExecutionDriveRequest {
  kind: "root" | "parent_continuation";
  guidance?: string;
}

export interface ExecutionDriveResult {
  output?: unknown;
}

export interface ExecutionContext {
  jobId: string;
  threadId: string;
  rootRunId: string;
  executionKind: RequirementExecutionKind;
  workflowVersion: string;
  /**
   * The Handler freezes the request-scoped model and permission inputs in this
   * closure. The selected Engine is the only component allowed to invoke it.
   * Recovery never persists or invokes the closure automatically.
   */
  drive?: (request: ExecutionDriveRequest) => Promise<ExecutionDriveResult>;
}
