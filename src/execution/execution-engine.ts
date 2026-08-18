import type { RequirementExecutionKind } from "../requirements/requirement.js";
import type { ExecutionContext } from "./execution-context.js";

export interface ExecutionEngineSnapshot {
  engine: string;
  jobId: string;
  workflowVersion?: string;
  stage?: string;
  terminal?: boolean;
}

export interface ExecutionEngine {
  readonly id: string;
  supports(kind: RequirementExecutionKind): boolean;
  validateStart?(allowedTools: string[]): void;
  start(context: ExecutionContext): Promise<void>;
  resume(jobId: string): Promise<void>;
  cancel(jobId: string): Promise<void>;
  recover(jobId: string): Promise<void>;
  snapshot(jobId: string): ExecutionEngineSnapshot;
}
