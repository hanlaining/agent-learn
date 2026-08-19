import type { RequirementExecutionKind } from "../requirements/requirement.js";
import type { ExecutionContext } from "./execution-context.js";

export interface ExecutionEngineSnapshot {
  engine: string;
  jobId: string;
  workflowVersion?: string;
  stage?: string;
  terminal?: boolean;
}

/**
 * Declares which runtime owns the user-facing root turn.
 *
 * `turn_agent` keeps the existing AgentLoop path. `workflow` means the
 * versioned workflow drives every stage, including the exactly-once final
 * delivery, so the generic root AgentLoop must not run in parallel.
 */
export type ExecutionControl = "turn_agent" | "workflow";

export interface ExecutionFeedback {
  turnId: string;
  text: string;
}

export interface ExecutionEngine {
  readonly id: string;
  readonly control: ExecutionControl;
  supports(kind: RequirementExecutionKind): boolean;
  isActive?(jobId: string): boolean;
  validateStart?(allowedTools: string[]): void;
  provideFeedback?(jobId: string, feedback: ExecutionFeedback): Promise<boolean>;
  start(context: ExecutionContext): Promise<void>;
  resume(jobId: string): Promise<void>;
  cancel(jobId: string): Promise<void>;
  recover(jobId: string): Promise<void>;
  snapshot(jobId: string): ExecutionEngineSnapshot;
}
