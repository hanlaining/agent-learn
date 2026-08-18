import {
  createModelRequestDigest,
} from "./model-invocation.js";

export type ToolInvocationStatus =
  | "prepared"
  | "executing"
  | "result_received"
  | "committed"
  | "outcome_unknown";

export interface ToolInvocationIdentity {
  modelInvocationId: string;
  callId: string;
  /** 持久化使用的规范字段。 */
  toolName?: string | undefined;
  /** 兼容早期内存调用；Store 会规范化为 toolName，Snapshot 不写此别名。 */
  name?: string | undefined;
  argumentsDigest: string;
}

export interface ToolInvocationNormalizedResult {
  result: unknown;
  output: string;
}

export interface ToolInvocation {
  modelInvocationId: string;
  callId: string;
  toolName: string;
  argumentsDigest: string;
  toolInvocationId: string;
  status: ToolInvocationStatus;
  executionAttempts: number;
  result?: unknown;
  output?: string;
  targetCommitKey?: string;
  lastErrorCode?: string;
  createdAt: string;
  updatedAt: string;
  executingAt?: string;
  resultReceivedAt?: string;
  committedAt?: string;
  outcomeUnknownAt?: string;
}

export interface ToolInvocationSnapshot {
  version: 1;
  invocations: ToolInvocation[];
}

export function createToolArgumentsDigest(argumentsValue: unknown): string {
  if (typeof argumentsValue !== "string") {
    return createModelRequestDigest(argumentsValue);
  }
  try {
    return createModelRequestDigest(JSON.parse(argumentsValue) as unknown);
  } catch {
    return createModelRequestDigest(argumentsValue);
  }
}

export function createToolInvocationId(
  identity: ToolInvocationIdentity,
): string {
  const toolName = identity.toolName ?? identity.name;
  if (typeof toolName !== "string" || toolName.trim().length === 0) {
    throw new Error("toolName must not be empty");
  }
  const digest = createModelRequestDigest({
    modelInvocationId: identity.modelInvocationId,
    callId: identity.callId,
    toolName,
    argumentsDigest: identity.argumentsDigest,
  });
  return `tool-invocation-${digest.slice("sha256:".length, "sha256:".length + 32)}`;
}
