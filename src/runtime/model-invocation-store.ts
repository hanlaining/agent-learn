import {
  createModelInvocationId,
  type ModelInvocation,
  type ModelInvocationIdentity,
  type ModelInvocationNormalizedResult,
  type ModelInvocationSnapshot,
  type ModelInvocationStatus,
} from "./model-invocation.js";

export interface PrepareModelInvocationInput extends ModelInvocationIdentity {
  invocationId?: string;
  requestDigest: string;
  provider: string;
  model: string;
  previousResponseId?: string;
  targetCommitKey?: string;
}

const TRANSITIONS: Readonly<Record<ModelInvocationStatus, readonly ModelInvocationStatus[]>> = {
  prepared: ["submitted", "failed_terminal"],
  submitted: ["response_received", "outcome_unknown", "failed_retryable", "failed_terminal"],
  response_received: ["committed", "failed_terminal"],
  committed: [],
  // Provider 不支持幂等键时，结果未知不得自动重提；未来只能通过续查补记结果或终止。
  outcome_unknown: ["response_received", "failed_terminal"],
  failed_retryable: ["submitted", "failed_terminal"],
  failed_terminal: [],
};

export class ModelInvocationStore {
  private readonly invocations = new Map<string, ModelInvocation>();

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  static fromSnapshot(value: ModelInvocationSnapshot | undefined): ModelInvocationStore {
    const store = new ModelInvocationStore();
    if (value === undefined) return store;
    if (value.version !== 1 || !Array.isArray(value.invocations)) {
      throw new Error("Invalid model invocation snapshot");
    }
    for (const candidate of value.invocations) {
      const invocation = parseModelInvocation(candidate);
      if (store.invocations.has(invocation.invocationId)) throw new Error("Duplicate model invocation ID");
      store.invocations.set(invocation.invocationId, invocation);
    }
    return store;
  }

  prepare(input: PrepareModelInvocationInput): ModelInvocation {
    assertIdentity(input);
    assertRequestDigest(input.requestDigest);
    assertNonEmpty(input.provider, "provider");
    assertNonEmpty(input.model, "model");
    assertOptionalNonEmpty(input.previousResponseId, "previousResponseId");
    assertOptionalNonEmpty(input.targetCommitKey, "targetCommitKey");
    const derivedInvocationId = createModelInvocationId(input);
    const invocationId = input.invocationId ?? derivedInvocationId;
    if (invocationId !== derivedInvocationId) {
      throw new Error("invocationId must match the stable invocation identity");
    }
    const existing = this.invocations.get(invocationId);
    if (existing !== undefined) {
      if (!samePreparedFacts(existing, input)) {
        throw new Error(`Model invocation prepared facts mismatch: ${invocationId}`);
      }
      return structuredClone(existing);
    }
    const timestamp = this.now();
    const invocation: ModelInvocation = {
      ...copyIdentity(input),
      invocationId,
      requestDigest: input.requestDigest,
      provider: input.provider,
      model: input.model,
      status: "prepared",
      dispatchAttempts: 0,
      ...(input.previousResponseId === undefined ? {} : { previousResponseId: input.previousResponseId }),
      ...(input.targetCommitKey === undefined ? {} : { targetCommitKey: input.targetCommitKey }),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.invocations.set(invocationId, invocation);
    return structuredClone(invocation);
  }

  get(invocationId: string): ModelInvocation | undefined {
    const invocation = this.invocations.get(invocationId);
    return invocation === undefined ? undefined : structuredClone(invocation);
  }

  list(status?: ModelInvocationStatus): ModelInvocation[] {
    return [...this.invocations.values()]
      .filter((item) => status === undefined || item.status === status)
      .map((item) => structuredClone(item));
  }

  markSubmitted(invocationId: string): ModelInvocation {
    const invocation = this.transition(invocationId, "submitted");
    invocation.dispatchAttempts += 1;
    invocation.submittedAt = invocation.updatedAt;
    delete invocation.lastErrorCode;
    return structuredClone(invocation);
  }

  recordResponse(invocationId: string, input: {
    providerResponseId: string;
    normalizedResult: ModelInvocationNormalizedResult;
  }): ModelInvocation {
    assertNonEmpty(input.providerResponseId, "providerResponseId");
    assertNormalizedResult(input.normalizedResult);
    const invocation = this.transition(invocationId, "response_received");
    invocation.providerResponseId = input.providerResponseId;
    invocation.normalizedResult = copyNormalizedResult(input.normalizedResult);
    invocation.responseReceivedAt = invocation.updatedAt;
    return structuredClone(invocation);
  }

  markCommitted(invocationId: string, targetCommitKey?: string): ModelInvocation {
    assertOptionalNonEmpty(targetCommitKey, "targetCommitKey");
    const existing = this.require(invocationId);
    if (existing.status === "committed") {
      if (targetCommitKey !== undefined && targetCommitKey !== existing.targetCommitKey) {
        throw new Error(`Model invocation target commit key mismatch: ${invocationId}`);
      }
      return structuredClone(existing);
    }
    const invocation = this.transition(invocationId, "committed");
    if (targetCommitKey !== undefined) invocation.targetCommitKey = targetCommitKey;
    invocation.committedAt = invocation.updatedAt;
    return structuredClone(invocation);
  }

  markOutcomeUnknown(invocationId: string, errorCode?: string): ModelInvocation {
    assertOptionalNonEmpty(errorCode, "lastErrorCode");
    const invocation = this.transition(invocationId, "outcome_unknown");
    invocation.outcomeUnknownAt = invocation.updatedAt;
    if (errorCode !== undefined) invocation.lastErrorCode = errorCode;
    return structuredClone(invocation);
  }

  markFailed(invocationId: string, status: "failed_retryable" | "failed_terminal", errorCode: string): ModelInvocation {
    assertNonEmpty(errorCode, "lastErrorCode");
    const invocation = this.transition(invocationId, status);
    invocation.lastErrorCode = errorCode;
    invocation.failedAt = invocation.updatedAt;
    return structuredClone(invocation);
  }

  acquireLease(invocationId: string, owner: string, leaseMs: number): ModelInvocation {
    assertNonEmpty(owner, "leaseOwner");
    if (!Number.isInteger(leaseMs) || leaseMs <= 0) throw new Error("leaseMs must be a positive integer");
    const invocation = this.require(invocationId);
    const timestamp = this.now();
    if (invocation.leaseOwner !== undefined && invocation.leaseOwner !== owner &&
      invocation.leaseExpiresAt !== undefined && invocation.leaseExpiresAt > timestamp) {
      throw new Error(`Model invocation lease is already held: ${invocationId}`);
    }
    invocation.leaseOwner = owner;
    invocation.leaseExpiresAt = new Date(Date.parse(timestamp) + leaseMs).toISOString();
    invocation.updatedAt = timestamp;
    return structuredClone(invocation);
  }

  releaseLease(invocationId: string, owner: string): ModelInvocation {
    const invocation = this.require(invocationId);
    if (invocation.leaseOwner !== owner) throw new Error("Model invocation lease owner mismatch");
    delete invocation.leaseOwner;
    delete invocation.leaseExpiresAt;
    invocation.updatedAt = this.now();
    return structuredClone(invocation);
  }

  exportSnapshot(): ModelInvocationSnapshot {
    return { version: 1, invocations: this.list() };
  }

  private transition(invocationId: string, status: ModelInvocationStatus): ModelInvocation {
    const invocation = this.require(invocationId);
    if (!TRANSITIONS[invocation.status].includes(status)) {
      throw new Error(`Invalid model invocation transition: ${invocation.status} -> ${status}`);
    }
    invocation.status = status;
    invocation.updatedAt = this.now();
    return invocation;
  }

  private require(invocationId: string): ModelInvocation {
    const invocation = this.invocations.get(invocationId);
    if (invocation === undefined) throw new Error(`Model invocation not found: ${invocationId}`);
    return invocation;
  }
}

function parseModelInvocation(value: ModelInvocation): ModelInvocation {
  if (typeof value !== "object" || value === null || !Object.hasOwn(TRANSITIONS, value.status)) {
    throw new Error("Invalid model invocation snapshot entry");
  }
  assertIdentity(value);
  assertNonEmpty(value.invocationId, "invocationId");
  if (value.invocationId !== createModelInvocationId(value)) {
    throw new Error("Invalid stable model invocation ID");
  }
  assertRequestDigest(value.requestDigest);
  assertNonEmpty(value.provider, "provider");
  assertNonEmpty(value.model, "model");
  if (!Number.isInteger(value.dispatchAttempts) || value.dispatchAttempts < 0 ||
    typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
    throw new Error("Invalid model invocation snapshot entry");
  }
  if (value.normalizedResult !== undefined) assertNormalizedResult(value.normalizedResult);
  for (const [name, item] of [
    ["previousResponseId", value.previousResponseId],
    ["providerResponseId", value.providerResponseId],
    ["targetCommitKey", value.targetCommitKey],
    ["lastErrorCode", value.lastErrorCode],
    ["leaseOwner", value.leaseOwner],
  ] as const) assertOptionalNonEmpty(item, name);
  for (const [name, item] of [
    ["leaseExpiresAt", value.leaseExpiresAt],
    ["submittedAt", value.submittedAt],
    ["responseReceivedAt", value.responseReceivedAt],
    ["committedAt", value.committedAt],
    ["outcomeUnknownAt", value.outcomeUnknownAt],
    ["failedAt", value.failedAt],
  ] as const) {
    if (item !== undefined && !Number.isFinite(Date.parse(item))) {
      throw new Error(`Invalid model invocation ${name}`);
    }
  }
  return {
    ...copyIdentity(value),
    invocationId: value.invocationId,
    requestDigest: value.requestDigest,
    provider: value.provider,
    model: value.model,
    status: value.status,
    dispatchAttempts: value.dispatchAttempts,
    ...(value.previousResponseId === undefined ? {} : { previousResponseId: value.previousResponseId }),
    ...(value.providerResponseId === undefined ? {} : { providerResponseId: value.providerResponseId }),
    ...(value.normalizedResult === undefined ? {} : { normalizedResult: copyNormalizedResult(value.normalizedResult) }),
    ...(value.targetCommitKey === undefined ? {} : { targetCommitKey: value.targetCommitKey }),
    ...(value.lastErrorCode === undefined ? {} : { lastErrorCode: value.lastErrorCode }),
    ...(value.leaseOwner === undefined ? {} : { leaseOwner: value.leaseOwner }),
    ...(value.leaseExpiresAt === undefined ? {} : { leaseExpiresAt: value.leaseExpiresAt }),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.submittedAt === undefined ? {} : { submittedAt: value.submittedAt }),
    ...(value.responseReceivedAt === undefined ? {} : { responseReceivedAt: value.responseReceivedAt }),
    ...(value.committedAt === undefined ? {} : { committedAt: value.committedAt }),
    ...(value.outcomeUnknownAt === undefined ? {} : { outcomeUnknownAt: value.outcomeUnknownAt }),
    ...(value.failedAt === undefined ? {} : { failedAt: value.failedAt }),
  };
}

function samePreparedFacts(existing: ModelInvocation, input: PrepareModelInvocationInput): boolean {
  return existing.requestDigest === input.requestDigest && existing.provider === input.provider &&
    existing.model === input.model && existing.previousResponseId === input.previousResponseId &&
    existing.targetCommitKey === input.targetCommitKey;
}

function copyIdentity(value: ModelInvocationIdentity): ModelInvocationIdentity {
  return {
    threadId: value.threadId,
    turnId: value.turnId,
    round: value.round,
    purpose: value.purpose,
    ...(value.jobId === undefined ? {} : { jobId: value.jobId }),
    ...(value.jobAttempt === undefined ? {} : { jobAttempt: value.jobAttempt }),
    ...(value.taskId === undefined ? {} : { taskId: value.taskId }),
    ...(value.runId === undefined ? {} : { runId: value.runId }),
    ...(value.workflowVersion === undefined ? {} : { workflowVersion: value.workflowVersion }),
    ...(value.stageId === undefined ? {} : { stageId: value.stageId }),
    ...(value.stageAttempt === undefined ? {} : { stageAttempt: value.stageAttempt }),
  };
}

function copyNormalizedResult(value: ModelInvocationNormalizedResult): ModelInvocationNormalizedResult {
  return {
    text: value.text,
    functionCalls: value.functionCalls.map((call) => ({
      callId: call.callId,
      name: call.name,
      arguments: sanitizeToolArguments(call.arguments),
    })),
  };
}

function sanitizeToolArguments(value: string): string {
  try {
    return JSON.stringify(redactProviderCredentials(JSON.parse(value) as unknown));
  } catch {
    return value;
  }
}

function redactProviderCredentials(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactProviderCredentials);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    isProviderCredentialKey(key) ? "[REDACTED]" : redactProviderCredentials(item),
  ]));
}

function isProviderCredentialKey(key: string): boolean {
  return /^(authorization|proxy-authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|cookie|set-cookie|client[_-]?secret|api[_-]?secret)$/i.test(key);
}

function assertNormalizedResult(value: ModelInvocationNormalizedResult): void {
  if (typeof value !== "object" || value === null || typeof value.text !== "string" ||
    !Array.isArray(value.functionCalls) || value.functionCalls.some((call) =>
      typeof call !== "object" || call === null || typeof call.callId !== "string" ||
      typeof call.name !== "string" || typeof call.arguments !== "string")) {
    throw new Error("Invalid model invocation normalized result");
  }
}

function assertIdentity(value: ModelInvocationIdentity): void {
  assertNonEmpty(value.threadId, "threadId");
  assertNonEmpty(value.turnId, "turnId");
  assertNonEmpty(value.purpose, "purpose");
  if (!Number.isInteger(value.round) || value.round < 0) throw new Error("round must be a non-negative integer");
  for (const [name, item] of [
    ["jobId", value.jobId],
    ["taskId", value.taskId],
    ["runId", value.runId],
    ["workflowVersion", value.workflowVersion],
    ["stageId", value.stageId],
  ] as const) assertOptionalNonEmpty(item, name);
  for (const [name, item] of [
    ["jobAttempt", value.jobAttempt],
    ["stageAttempt", value.stageAttempt],
  ] as const) {
    if (item !== undefined && (!Number.isInteger(item) || item < 0)) {
      throw new Error(`${name} must be a non-negative integer`);
    }
  }
}

function assertOptionalNonEmpty(value: string | undefined, name: string): void {
  if (value !== undefined) assertNonEmpty(value, name);
}

function assertRequestDigest(value: string): void {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error("requestDigest must be a stable SHA-256 digest");
  }
}

function assertNonEmpty(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} must not be empty`);
}
