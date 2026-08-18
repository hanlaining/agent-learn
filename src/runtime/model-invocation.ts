import { createHash } from "node:crypto";

export type ModelInvocationStatus =
  | "prepared"
  | "submitted"
  | "response_received"
  | "committed"
  | "outcome_unknown"
  | "failed_retryable"
  | "failed_terminal";

export interface ModelInvocationIdentity {
  threadId: string;
  turnId: string;
  round: number;
  purpose: string;
  jobId?: string;
  jobAttempt?: number;
  taskId?: string;
  runId?: string;
  workflowVersion?: string;
  stageId?: string;
  stageAttempt?: number;
}

export interface ModelInvocationNormalizedResult {
  text: string;
  functionCalls: Array<{
    callId: string;
    name: string;
    arguments: string;
  }>;
}

export interface ModelInvocation extends ModelInvocationIdentity {
  invocationId: string;
  requestDigest: string;
  provider: string;
  model: string;
  status: ModelInvocationStatus;
  dispatchAttempts: number;
  previousResponseId?: string;
  providerResponseId?: string;
  normalizedResult?: ModelInvocationNormalizedResult;
  targetCommitKey?: string;
  lastErrorCode?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
  responseReceivedAt?: string;
  committedAt?: string;
  outcomeUnknownAt?: string;
  failedAt?: string;
}

export interface ModelInvocationSnapshot {
  version: 1;
  invocations: ModelInvocation[];
}

export function createModelInvocationId(identity: ModelInvocationIdentity): string {
  const stableIdentity: ModelInvocationIdentity = {
    threadId: identity.threadId,
    turnId: identity.turnId,
    round: identity.round,
    purpose: identity.purpose,
    ...(identity.jobId === undefined ? {} : { jobId: identity.jobId }),
    ...(identity.jobAttempt === undefined ? {} : { jobAttempt: identity.jobAttempt }),
    ...(identity.taskId === undefined ? {} : { taskId: identity.taskId }),
    ...(identity.runId === undefined ? {} : { runId: identity.runId }),
    ...(identity.workflowVersion === undefined ? {} : { workflowVersion: identity.workflowVersion }),
    ...(identity.stageId === undefined ? {} : { stageId: identity.stageId }),
    ...(identity.stageAttempt === undefined ? {} : { stageAttempt: identity.stageAttempt }),
  };
  return `model-invocation-${sha256(stableJson(stableIdentity)).slice(0, 32)}`;
}

export function createModelRequestDigest(request: unknown): string {
  return `sha256:${sha256(stableJson(request))}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value, new Set<object>()));
}

function normalizeJson(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Model invocation digest input must contain finite numbers");
    return value;
  }
  if (typeof value !== "object") throw new Error("Model invocation digest input must be JSON-compatible");
  if (seen.has(value)) throw new Error("Model invocation digest input must not contain cycles");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => normalizeJson(item, seen));
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, normalizeJson(record[key], seen)]));
  } finally {
    seen.delete(value);
  }
}
