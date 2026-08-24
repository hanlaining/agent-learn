export const RUNTIME_CORRELATION_FIELDS = [
  "schemaVersion",
  "correlationId",
  "threadId",
  "turnId",
  "requirementId",
  "requirementRevision",
  "jobId",
  "jobAttempt",
  "taskId",
  "taskAttempt",
  "runId",
  "parentRunId",
  "rootRunId",
  "modelInvocationId",
  "toolInvocationId",
  "workflowId",
  "workflowVersion",
  "stageId",
  "stageAttempt",
  "leaseResourceType",
  "leaseResourceId",
  "attribution",
] as const;

export type RuntimeCorrelationAttribution =
  | "native"
  | "legacy_derived"
  | "legacy_unattributed";

export type RuntimeLeaseCorrelationResourceType =
  | "job"
  | "turn"
  | "model_invocation"
  | "tool_invocation";

export interface RuntimeCorrelationV1 {
  readonly schemaVersion: 1;
  readonly correlationId: string;
  readonly threadId: string;
  readonly turnId?: string;
  readonly requirementId?: string;
  readonly requirementRevision?: number;
  readonly jobId?: string;
  readonly jobAttempt?: number;
  readonly taskId?: string;
  readonly taskAttempt?: number;
  readonly runId?: string;
  readonly parentRunId?: string;
  readonly rootRunId?: string;
  readonly modelInvocationId?: string;
  readonly toolInvocationId?: string;
  readonly workflowId?: string;
  readonly workflowVersion?: string;
  readonly stageId?: string;
  readonly stageAttempt?: number;
  readonly leaseResourceType?: RuntimeLeaseCorrelationResourceType;
  readonly leaseResourceId?: string;
  readonly attribution: RuntimeCorrelationAttribution;
}

export type RuntimeCorrelationInput = Omit<
  RuntimeCorrelationV1,
  "schemaVersion" | "correlationId" | "attribution"
> & {
  readonly correlationId?: string;
  readonly attribution?: RuntimeCorrelationAttribution;
};

export function deriveRuntimeCorrelationId(input: {
  readonly jobId?: string;
  readonly turnId?: string;
}): string {
  if (input.jobId !== undefined) return `job:${assertIdentifier(input.jobId, "jobId")}`;
  if (input.turnId !== undefined) return `turn:${assertIdentifier(input.turnId, "turnId")}`;
  throw new Error("Runtime correlation requires jobId or turnId");
}

export function deriveLegacyUnattributedCorrelationId(
  aggregateKind: string,
  aggregateId: string,
): string {
  return `legacy:${encodeURIComponent(assertIdentifier(aggregateKind, "aggregateKind"))}:${encodeURIComponent(assertIdentifier(aggregateId, "aggregateId"))}`;
}

export function createRuntimeCorrelation(
  input: RuntimeCorrelationInput,
): RuntimeCorrelationV1 {
  const attribution = input.attribution ?? "native";
  const derived = attribution === "legacy_unattributed"
    ? input.correlationId
    : deriveRuntimeCorrelationId(input);
  if (derived === undefined) {
    throw new Error("Legacy unattributed correlation requires an explicit stable correlationId");
  }
  const value = {
    ...input,
    schemaVersion: 1 as const,
    correlationId: derived,
    attribution,
  };
  assertRuntimeCorrelation(value);
  return Object.freeze({ ...value });
}

export function assertRuntimeCorrelation(
  value: unknown,
): asserts value is RuntimeCorrelationV1 {
  if (!isRecord(value)) throw new Error("Invalid Runtime correlation");
  assertNoUnknownFields(value, RUNTIME_CORRELATION_FIELDS, "Runtime correlation");
  if (value.schemaVersion !== 1 ||
      !isAttribution(value.attribution)) {
    throw new Error("Invalid Runtime correlation version or attribution");
  }
  for (const field of RUNTIME_CORRELATION_FIELDS) {
    if (field === "schemaVersion" || field === "attribution" || field === "leaseResourceType" ||
        field === "requirementRevision" || field === "jobAttempt" ||
        field === "taskAttempt" || field === "stageAttempt") continue;
    const candidate = value[field];
    if (candidate !== undefined) assertIdentifier(candidate, field);
  }
  assertIdentifier(value.threadId, "threadId");
  for (const field of ["requirementRevision", "jobAttempt", "taskAttempt", "stageAttempt"] as const) {
    const candidate = value[field];
    if (candidate !== undefined &&
        (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate <= 0)) {
      throw new Error(`Invalid Runtime correlation ${field}`);
    }
  }
  requireCompanion(value, "requirementRevision", "requirementId");
  requireCompanion(value, "jobAttempt", "jobId");
  if (value.attribution === "native" && value.jobId !== undefined && value.jobAttempt === undefined) {
    throw new Error("Native Job correlation requires jobAttempt");
  }
  if (value.taskId !== undefined || value.taskAttempt !== undefined) {
    requireFields(value, ["jobId", "taskId", "taskAttempt"], "Task correlation");
  }
  if (value.runId !== undefined || value.parentRunId !== undefined || value.rootRunId !== undefined) {
    requireFields(value, ["jobId", "runId"], "Run correlation");
  }
  if (value.modelInvocationId !== undefined) {
    requireFields(value, ["turnId", "modelInvocationId"], "Model Invocation correlation");
  }
  if (value.toolInvocationId !== undefined) {
    requireFields(value, ["turnId", "modelInvocationId", "toolInvocationId"], "Tool Invocation correlation");
  }
  if (value.workflowId !== undefined || value.workflowVersion !== undefined ||
      value.stageId !== undefined || value.stageAttempt !== undefined) {
    requireFields(value, ["jobId", "workflowId", "workflowVersion", "stageId", "stageAttempt"], "Workflow correlation");
  }
  if (value.leaseResourceType !== undefined || value.leaseResourceId !== undefined) {
    requireFields(value, ["leaseResourceType", "leaseResourceId"], "Lease correlation");
    if (!isLeaseResourceType(value.leaseResourceType)) {
      throw new Error("Invalid Lease correlation resource type");
    }
    const lineageField: Record<RuntimeLeaseCorrelationResourceType, keyof RuntimeCorrelationV1> = {
      job: "jobId",
      turn: "turnId",
      model_invocation: "modelInvocationId",
      tool_invocation: "toolInvocationId",
    };
    if (value[lineageField[value.leaseResourceType]] !== value.leaseResourceId) {
      throw new Error("Lease resource does not match Runtime lineage");
    }
  }
  const correlationId = assertIdentifier(value.correlationId, "correlationId");
  if (value.attribution === "legacy_unattributed") {
    assertCanonicalLegacyCorrelationId(correlationId);
  } else if (correlationId !== deriveRuntimeCorrelationId(value)) {
    throw new Error("Runtime correlationId does not match its Job/Turn lineage");
  }
}

function assertCanonicalLegacyCorrelationId(value: string): void {
  const match = /^legacy:([^:]+):([^:]+)$/u.exec(value);
  if (match === null) throw new Error("Unattributed legacy correlation must use canonical encoding");
  let kind: string;
  let id: string;
  try {
    kind = decodeURIComponent(match[1]!);
    id = decodeURIComponent(match[2]!);
  } catch {
    throw new Error("Unattributed legacy correlation must use canonical encoding");
  }
  if (deriveLegacyUnattributedCorrelationId(kind, id) !== value) {
    throw new Error("Unattributed legacy correlation must use canonical encoding");
  }
}

function isLeaseResourceType(value: unknown): value is RuntimeLeaseCorrelationResourceType {
  return value === "job" || value === "turn" ||
    value === "model_invocation" || value === "tool_invocation";
}

export function assertRuntimeCausationId(
  value: unknown,
): asserts value is string | null {
  if (value === null) return;
  assertIdentifier(value, "causationId");
}

function requireCompanion(
  value: Record<string, unknown>,
  field: string,
  companion: string,
): void {
  if (value[field] !== undefined && value[companion] === undefined) {
    throw new Error(`${field} requires ${companion}`);
  }
}

function requireFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): void {
  if (fields.some((field) => value[field] === undefined)) {
    throw new Error(`${label} is incomplete`);
  }
}

function assertIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value !== value.trim() || value.length === 0 ||
      value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`Invalid Runtime correlation ${label}`);
  }
  return value;
}

function isAttribution(value: unknown): value is RuntimeCorrelationAttribution {
  return value === "native" || value === "legacy_derived" || value === "legacy_unattributed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNoUnknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${label} has unknown fields: ${unknown.join(", ")}`);
}
