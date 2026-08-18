import {
  createToolInvocationId,
  type ToolInvocation,
  type ToolInvocationIdentity,
  type ToolInvocationNormalizedResult,
  type ToolInvocationSnapshot,
  type ToolInvocationStatus,
} from "./tool-invocation.js";

export interface PrepareToolInvocationInput extends ToolInvocationIdentity {
  toolInvocationId?: string;
  targetCommitKey?: string;
}

const TRANSITIONS: Readonly<Record<
  ToolInvocationStatus,
  readonly ToolInvocationStatus[]
>> = {
  prepared: ["executing"],
  executing: ["result_received", "outcome_unknown"],
  result_received: ["committed"],
  committed: [],
  // Tool 没有可续查的远端结果标识，未知结果不得自动重新执行。
  outcome_unknown: [],
};

export class ToolInvocationStore {
  private readonly invocations = new Map<string, ToolInvocation>();

  constructor(
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  static fromSnapshot(
    value: ToolInvocationSnapshot | undefined,
  ): ToolInvocationStore {
    const store = new ToolInvocationStore();
    if (value === undefined) return store;
    if (value.version !== 1 || !Array.isArray(value.invocations)) {
      throw new Error("Invalid tool invocation snapshot");
    }
    for (const candidate of value.invocations) {
      const invocation = parseToolInvocation(candidate);
      if (store.invocations.has(invocation.toolInvocationId)) {
        throw new Error("Duplicate tool invocation ID");
      }
      store.invocations.set(invocation.toolInvocationId, invocation);
    }
    return store;
  }

  prepare(input: PrepareToolInvocationInput): ToolInvocation {
    assertIdentity(input);
    assertOptionalNonEmpty(input.targetCommitKey, "targetCommitKey");
    const derivedId = createToolInvocationId(input);
    const toolInvocationId = input.toolInvocationId ?? derivedId;
    if (toolInvocationId !== derivedId) {
      throw new Error(
        "toolInvocationId must match the stable tool invocation identity",
      );
    }
    const existing = this.invocations.get(toolInvocationId);
    if (existing !== undefined) {
      if (existing.targetCommitKey !== input.targetCommitKey) {
        throw new Error(
          `Tool invocation prepared facts mismatch: ${toolInvocationId}`,
        );
      }
      return structuredClone(existing);
    }
    const timestamp = this.now();
    const invocation: ToolInvocation = {
      ...copyIdentity(input),
      toolInvocationId,
      status: "prepared",
      executionAttempts: 0,
      ...(input.targetCommitKey === undefined
        ? {}
        : { targetCommitKey: input.targetCommitKey }),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.invocations.set(toolInvocationId, invocation);
    return structuredClone(invocation);
  }

  get(toolInvocationId: string): ToolInvocation | undefined {
    const invocation = this.invocations.get(toolInvocationId);
    return invocation === undefined
      ? undefined
      : structuredClone(invocation);
  }

  list(status?: ToolInvocationStatus): ToolInvocation[] {
    return [...this.invocations.values()]
      .filter((item) => status === undefined || item.status === status)
      .map((item) => structuredClone(item));
  }

  markExecuting(toolInvocationId: string): ToolInvocation {
    const invocation = this.transition(toolInvocationId, "executing");
    invocation.executionAttempts += 1;
    invocation.executingAt = invocation.updatedAt;
    delete invocation.lastErrorCode;
    return structuredClone(invocation);
  }

  recordResult(
    toolInvocationId: string,
    input: ToolInvocationNormalizedResult | {
      normalizedResult: ToolInvocationNormalizedResult;
    },
  ): ToolInvocation {
    const normalizedResult = "normalizedResult" in input
      ? input.normalizedResult
      : input;
    assertNormalizedResult(normalizedResult);
    const invocation = this.transition(toolInvocationId, "result_received");
    const copied = copyNormalizedResult(normalizedResult);
    invocation.result = copied.result;
    invocation.output = copied.output;
    invocation.resultReceivedAt = invocation.updatedAt;
    return structuredClone(invocation);
  }

  markCommitted(
    toolInvocationId: string,
    targetCommitKey?: string,
  ): ToolInvocation {
    assertOptionalNonEmpty(targetCommitKey, "targetCommitKey");
    const existing = this.require(toolInvocationId);
    if (existing.status === "committed") {
      if (
        targetCommitKey !== undefined &&
        existing.targetCommitKey !== targetCommitKey
      ) {
        throw new Error(
          `Tool invocation target commit key mismatch: ${toolInvocationId}`,
        );
      }
      return structuredClone(existing);
    }
    if (targetCommitKey === undefined && existing.targetCommitKey === undefined) {
      throw new Error("Tool invocation target commit key is required");
    }
    const invocation = this.transition(toolInvocationId, "committed");
    if (targetCommitKey !== undefined) {
      invocation.targetCommitKey = targetCommitKey;
    }
    invocation.committedAt = invocation.updatedAt;
    return structuredClone(invocation);
  }

  markOutcomeUnknown(
    toolInvocationId: string,
    errorCode?: string,
  ): ToolInvocation {
    assertOptionalNonEmpty(errorCode, "lastErrorCode");
    const existing = this.require(toolInvocationId);
    if (existing.status === "outcome_unknown") {
      return structuredClone(existing);
    }
    const invocation = this.transition(toolInvocationId, "outcome_unknown");
    invocation.outcomeUnknownAt = invocation.updatedAt;
    if (errorCode !== undefined) invocation.lastErrorCode = errorCode;
    return structuredClone(invocation);
  }

  recoverExecuting(
    errorCode = "process_recovered_during_tool_execution",
  ): ToolInvocation[] {
    const recovered: ToolInvocation[] = [];
    for (const invocation of this.invocations.values()) {
      if (invocation.status !== "executing") continue;
      recovered.push(this.markOutcomeUnknown(
        invocation.toolInvocationId,
        errorCode,
      ));
    }
    return recovered;
  }

  exportSnapshot(): ToolInvocationSnapshot {
    return { version: 1, invocations: this.list() };
  }

  private transition(
    toolInvocationId: string,
    status: ToolInvocationStatus,
  ): ToolInvocation {
    const invocation = this.require(toolInvocationId);
    if (!TRANSITIONS[invocation.status].includes(status)) {
      throw new Error(
        `Invalid tool invocation transition: ${invocation.status} -> ${status}`,
      );
    }
    invocation.status = status;
    invocation.updatedAt = this.now();
    return invocation;
  }

  private require(toolInvocationId: string): ToolInvocation {
    const invocation = this.invocations.get(toolInvocationId);
    if (invocation === undefined) {
      throw new Error(`Tool invocation not found: ${toolInvocationId}`);
    }
    return invocation;
  }
}

function parseToolInvocation(value: ToolInvocation): ToolInvocation {
  if (
    typeof value !== "object" ||
    value === null ||
    !Object.hasOwn(TRANSITIONS, value.status)
  ) {
    throw new Error("Invalid tool invocation snapshot entry");
  }
  assertIdentity(value);
  assertNonEmpty(value.toolInvocationId, "toolInvocationId");
  if (value.toolInvocationId !== createToolInvocationId(value)) {
    throw new Error("Invalid stable tool invocation ID");
  }
  if (
    !Number.isInteger(value.executionAttempts) ||
    value.executionAttempts < 0 ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt)
  ) {
    throw new Error("Invalid tool invocation snapshot entry");
  }
  if (value.result !== undefined || value.output !== undefined) {
    assertNormalizedResult({ result: value.result, output: value.output! });
  }
  if (
    (value.status === "result_received" || value.status === "committed") &&
    (value.result === undefined || value.output === undefined)
  ) {
    throw new Error("Tool invocation snapshot result is incomplete");
  }
  if (value.status === "committed" && value.targetCommitKey === undefined) {
    throw new Error("Committed tool invocation has no target commit key");
  }
  assertOptionalNonEmpty(value.targetCommitKey, "targetCommitKey");
  assertOptionalNonEmpty(value.lastErrorCode, "lastErrorCode");
  for (const [name, item] of [
    ["executingAt", value.executingAt],
    ["resultReceivedAt", value.resultReceivedAt],
    ["committedAt", value.committedAt],
    ["outcomeUnknownAt", value.outcomeUnknownAt],
  ] as const) {
    if (item !== undefined && !isTimestamp(item)) {
      throw new Error(`Invalid tool invocation ${name}`);
    }
  }
  return {
    ...copyIdentity(value),
    toolInvocationId: value.toolInvocationId,
    status: value.status,
    executionAttempts: value.executionAttempts,
    ...(value.result === undefined
      ? {}
      : { result: cloneJson(value.result) }),
    ...(value.output === undefined
      ? {}
      : { output: sanitizeOutput(value.output) }),
    ...(value.targetCommitKey === undefined
      ? {}
      : { targetCommitKey: value.targetCommitKey }),
    ...(value.lastErrorCode === undefined
      ? {}
      : { lastErrorCode: value.lastErrorCode }),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.executingAt === undefined
      ? {}
      : { executingAt: value.executingAt }),
    ...(value.resultReceivedAt === undefined
      ? {}
      : { resultReceivedAt: value.resultReceivedAt }),
    ...(value.committedAt === undefined
      ? {}
      : { committedAt: value.committedAt }),
    ...(value.outcomeUnknownAt === undefined
      ? {}
      : { outcomeUnknownAt: value.outcomeUnknownAt }),
  };
}

function copyIdentity(
  value: ToolInvocationIdentity,
): {
  modelInvocationId: string;
  callId: string;
  toolName: string;
  argumentsDigest: string;
} {
  const toolName = value.toolName ?? value.name;
  if (toolName === undefined) throw new Error("toolName must not be empty");
  return {
    modelInvocationId: value.modelInvocationId,
    callId: value.callId,
    toolName,
    argumentsDigest: value.argumentsDigest,
  };
}

function copyNormalizedResult(
  value: ToolInvocationNormalizedResult,
): ToolInvocationNormalizedResult {
  return {
    result: cloneJson(value.result),
    output: sanitizeOutput(value.output),
  };
}

function assertNormalizedResult(
  value: ToolInvocationNormalizedResult,
): void {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.output !== "string"
  ) {
    throw new Error("Invalid tool invocation normalized result");
  }
  cloneJson(value.result);
}

function assertIdentity(value: ToolInvocationIdentity): void {
  assertNonEmpty(value.modelInvocationId, "modelInvocationId");
  assertNonEmpty(value.callId, "callId");
  assertNonEmpty(value.toolName ?? value.name ?? "", "toolName");
  if (!/^sha256:[a-f0-9]{64}$/.test(value.argumentsDigest)) {
    throw new Error("argumentsDigest must be a stable SHA-256 digest");
  }
}

function cloneJson(value: unknown): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(redactSensitiveFields(value));
  } catch {
    throw new Error("Tool invocation result must be JSON-compatible");
  }
  if (serialized === undefined) {
    throw new Error("Tool invocation result must be JSON-compatible");
  }
  return JSON.parse(serialized) as unknown;
}

function sanitizeOutput(output: string): string {
  try {
    return JSON.stringify(redactSensitiveFields(JSON.parse(output) as unknown));
  } catch {
    return output;
  }
}

function redactSensitiveFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitiveFields);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [
    key,
    isSensitiveKey(key) ? "[REDACTED]" : redactSensitiveFields(item),
  ]));
}

function isSensitiveKey(key: string): boolean {
  return /^(authorization|proxy-authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|cookie|set-cookie|client[_-]?secret|api[_-]?secret)$/i.test(key);
}

function isTimestamp(value: string): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function assertOptionalNonEmpty(
  value: string | undefined,
  name: string,
): void {
  if (value !== undefined) assertNonEmpty(value, name);
}

function assertNonEmpty(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must not be empty`);
  }
}
