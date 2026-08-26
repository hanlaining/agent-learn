import type { RequirementExecutionKind } from "../requirements/requirement.js";
import type { ExecutionContext } from "./execution-context.js";

export interface ExecutionEngineSnapshot {
  engine: string;
  jobId: string;
  workflowVersion?: string;
  stage?: string;
  terminal?: boolean;
  phase?: string;
  recoveryAction?: string;
  reason?: string;
  deadlineAt?: string;
}

/**
 * Declares which runtime owns the user-facing root turn.
 *
 * `turn_agent` keeps the existing AgentLoop path. `workflow` means the
 * versioned workflow drives every stage, including the exactly-once final
 * delivery, so the generic root AgentLoop must not run in parallel.
 */
export type ExecutionControl = "turn_agent" | "engine" | "workflow";

export interface ExecutionEngineResult {
  output?: unknown;
}

export interface ExecutionFeedback {
  turnId: string;
  text: string;
}

export interface ExecutionEngine {
  readonly id: string;
  readonly control: ExecutionControl;
  supports(kind: RequirementExecutionKind): boolean;
  isActive?(jobId: string): boolean;
  validateStart?(allowedTools: string[], workflowVersion?: string): void;
  provideFeedback?(jobId: string, feedback: ExecutionFeedback): Promise<boolean>;
  start(context: ExecutionContext): Promise<ExecutionEngineResult>;
  resume(jobId: string): Promise<ExecutionEngineResult>;
  cancel(jobId: string): Promise<void>;
  recover(jobId: string): Promise<void>;
  snapshot(jobId: string): ExecutionEngineSnapshot;
}

const SNAPSHOT_KEYS = [
  "engine", "jobId", "workflowVersion", "stage", "terminal", "phase", "recoveryAction", "reason", "deadlineAt",
] as const;

export function assertExecutionFeedback(value: unknown): asserts value is ExecutionFeedback {
  if (!isRecord(value) || !hasExactKeys(value, ["turnId", "text"]) ||
    !nonBlank(value.turnId) || !nonBlank(value.text)) {
    throw new Error("Invalid execution feedback");
  }
}

/** Engine snapshots cross the App Server boundary and must retain their routed identity. */
export function assertExecutionEngineSnapshot(
  value: unknown,
  expected: { engine: string; jobId: string },
): asserts value is ExecutionEngineSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, ["engine", "jobId"], SNAPSHOT_KEYS.slice(2)) ||
    value.engine !== expected.engine || value.jobId !== expected.jobId ||
    !nonBlank(value.engine) || !nonBlank(value.jobId) ||
    !optionalNonBlank(value.workflowVersion) || !optionalNonBlank(value.stage) ||
    !optionalNonBlank(value.phase) || !optionalNonBlank(value.recoveryAction) || !optionalNonBlank(value.reason) ||
    !(value.terminal === undefined || typeof value.terminal === "boolean") ||
    !validOptionalTimestamp(value.deadlineAt)) {
    throw new Error("Invalid execution engine snapshot");
  }
}

function validOptionalTimestamp(value: unknown): boolean {
  return value === undefined || nonBlank(value) && Number.isFinite(Date.parse(value));
}

function optionalNonBlank(value: unknown): boolean {
  return value === undefined || nonBlank(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key));
}
