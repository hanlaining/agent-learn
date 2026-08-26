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

const EXECUTION_KINDS: readonly RequirementExecutionKind[] = [
  "analysis_only",
  "software_change",
  "software_product_delivery",
];

/** Fail closed before an untrusted or stale request reaches an execution engine. */
export function assertExecutionContext(value: unknown): asserts value is ExecutionContext {
  if (!isRecord(value) || !hasExactKeys(value, [
    "jobId", "threadId", "rootRunId", "executionKind", "workflowVersion",
  ], ["drive"]) ||
    !nonBlank(value.jobId) || !nonBlank(value.threadId) || !nonBlank(value.rootRunId) ||
    !EXECUTION_KINDS.includes(value.executionKind as RequirementExecutionKind) ||
    !nonBlank(value.workflowVersion) ||
    !(value.drive === undefined || typeof value.drive === "function")) {
    throw new Error("Invalid execution context");
  }
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key));
}
