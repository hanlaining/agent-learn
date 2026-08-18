import type { RequirementExecutionKind } from "../requirements/requirement.js";

export interface ExecutionContext {
  jobId: string;
  threadId: string;
  rootRunId: string;
  executionKind: RequirementExecutionKind;
  workflowVersion: string;
}
