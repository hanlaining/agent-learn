import { createHash } from "node:crypto";

import {
  AUTHORITY_KINDS,
  assertAuthorityWriteAllowed,
  type AuthorityKind,
  type AuthorityWriter,
} from "./authority-registry.js";
import {
  assertRuntimeCausationId,
  assertRuntimeCorrelation,
  type RuntimeCorrelationV1,
} from "./runtime-correlation.js";

export type RuntimeJsonPrimitive = string | number | boolean | null;
export type RuntimeJsonValue =
  | RuntimeJsonPrimitive
  | RuntimeJsonValue[]
  | { [key: string]: RuntimeJsonValue };
export type RuntimeEventPayload = Record<string, RuntimeJsonValue>;

declare const aggregateGenerationBrand: unique symbol;
export type AggregateGeneration = number & {
  readonly [aggregateGenerationBrand]: "runtime.aggregate_generation";
};

export const AGGREGATE_GENERATION_DOMAIN = "aggregate" as const;

export function createAggregateGeneration(value: number): AggregateGeneration {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Invalid aggregate-local generation");
  }
  return value as AggregateGeneration;
}

export interface RuntimeEventProducer {
  readonly component: string;
  readonly instanceId?: string;
}

export interface RuntimeEventEnvelopeV1<
  TType extends string = string,
  TPayload extends RuntimeEventPayload = RuntimeEventPayload,
> {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly eventType: TType;
  readonly aggregateType: AuthorityKind;
  readonly aggregateId: string;
  readonly authorityWriter: AuthorityWriter;
  readonly generationDomain: typeof AGGREGATE_GENERATION_DOMAIN;
  /**
   * Aggregate-local mutation generation. The brand prevents accidental plain
   * version numbers at TypeScript factory call sites. Runtime JSON cannot prove
   * a number's origin; authoritative allocation belongs to C04/C05.
   */
  readonly generation: AggregateGeneration;
  readonly correlation: RuntimeCorrelationV1;
  readonly causationId: string | null;
  readonly occurredAt: string;
  readonly producer: RuntimeEventProducer;
  readonly payloadSchemaVersion: 1;
  readonly payload: TPayload;
}

export type CreateRuntimeEventInput<
  TType extends string,
  TPayload extends RuntimeEventPayload,
> = Omit<
  RuntimeEventEnvelopeV1<TType, TPayload>,
  "schemaVersion" | "payloadSchemaVersion"
>;

const EVENT_FIELDS = [
  "schemaVersion",
  "eventId",
  "eventType",
  "aggregateType",
  "aggregateId",
  "authorityWriter",
  "generationDomain",
  "generation",
  "correlation",
  "causationId",
  "occurredAt",
  "producer",
  "payloadSchemaVersion",
  "payload",
] as const;

const PRODUCER_FIELDS = ["component", "instanceId"] as const;

export function createRuntimeEvent<
  TType extends string,
  TPayload extends RuntimeEventPayload,
>(
  input: CreateRuntimeEventInput<TType, TPayload>,
  predecessor?: RuntimeEventEnvelopeV1,
): RuntimeEventEnvelopeV1<TType, TPayload> {
  const cloned = cloneRuntimeJson({
    ...input,
    schemaVersion: 1,
    payloadSchemaVersion: 1,
  }) as unknown as RuntimeEventEnvelopeV1<TType, TPayload>;
  assertRuntimeEventEnvelope(cloned);
  if (cloned.causationId === null) {
    if (predecessor !== undefined) throw new Error("Root Runtime Event cannot have a predecessor");
  } else {
    if (predecessor === undefined) {
      throw new Error("Causal Runtime Event factory requires its predecessor");
    }
    assertRuntimeEventPredecessor(cloned, predecessor);
  }
  return deepFreeze(cloned);
}

export function parseRuntimeEventEnvelope(
  value: unknown,
): RuntimeEventEnvelopeV1 {
  const cloned = cloneRuntimeJson(value) as unknown;
  assertRuntimeEventEnvelope(cloned);
  return deepFreeze(cloned);
}

/**
 * Produces the stable JSON bytes used to bind Runtime Events to Evidence.
 * Object keys are recursively sorted, arrays retain their original order, and
 * the digest itself is deliberately not part of the Event Envelope.
 */
export function canonicalRuntimeEventJson(event: unknown): string {
  const cloned = cloneRuntimeJson(event) as unknown;
  assertRuntimeEventEnvelope(cloned);
  return JSON.stringify(sortRuntimeJsonObjectKeys(cloned as unknown as RuntimeJsonValue));
}

export function digestRuntimeEventEnvelope(event: unknown): string {
  return createHash("sha256")
    .update(canonicalRuntimeEventJson(event), "utf8")
    .digest("hex");
}

export function assertRuntimeEventEnvelope(
  value: unknown,
): asserts value is RuntimeEventEnvelopeV1 {
  if (!isRecord(value)) throw new Error("Invalid Runtime Event Envelope");
  assertNoUnknownFields(value, EVENT_FIELDS, "Runtime Event Envelope");
  if (value.schemaVersion !== 1 || value.payloadSchemaVersion !== 1) {
    throw new Error("Unsupported Runtime Event Envelope version");
  }
  assertIdentifier(value.eventId, "eventId");
  assertIdentifier(value.eventType, "eventType");
  if (typeof value.aggregateType !== "string" ||
      !AUTHORITY_KINDS.includes(value.aggregateType as AuthorityKind)) {
    throw new Error("Invalid Runtime Event aggregateType");
  }
  assertIdentifier(value.aggregateId, "aggregateId");
  if (typeof value.authorityWriter !== "string") {
    throw new Error("Invalid Runtime Event authorityWriter");
  }
  assertAuthorityWriteAllowed(value.aggregateType as AuthorityKind, value.authorityWriter);
  if (value.generationDomain !== AGGREGATE_GENERATION_DOMAIN) {
    throw new Error("Invalid Runtime Event generation domain");
  }
  if (!Number.isSafeInteger(value.generation) || (value.generation as number) < 0) {
    throw new Error("Invalid Runtime Event aggregate generation");
  }
  assertRuntimeCorrelation(value.correlation);
  assertRuntimeCausationId(value.causationId);
  assertCanonicalTimestamp(value.occurredAt);
  assertProducer(value.producer);
  if (!isRecord(value.payload)) throw new Error("Runtime Event payload must be an object");
  assertJsonValue(value.payload, new Set());
  assertAggregateCorrelation(
    value.aggregateType as AuthorityKind,
    value.aggregateId as string,
    value.correlation,
  );
}

export function assertRuntimeEventPredecessor(
  event: RuntimeEventEnvelopeV1,
  predecessor: RuntimeEventEnvelopeV1,
): void {
  assertRuntimeEventEnvelope(event);
  assertRuntimeEventEnvelope(predecessor);
  if (event.eventId === predecessor.eventId) {
    throw new Error("Runtime Event cannot cause itself");
  }
  if (event.causationId !== predecessor.eventId) {
    throw new Error("Runtime Event causationId does not match predecessor eventId");
  }
  if (event.correlation.correlationId !== predecessor.correlation.correlationId) {
    throw new Error("Runtime Event predecessor belongs to another correlation");
  }
  if (event.aggregateType === predecessor.aggregateType &&
      event.aggregateId === predecessor.aggregateId &&
      event.generation <= predecessor.generation) {
    throw new Error("Runtime Event aggregate generation must advance after its predecessor");
  }
}

function assertAggregateCorrelation(
  aggregateType: AuthorityKind,
  aggregateId: string,
  correlation: RuntimeCorrelationV1,
): void {
  const exact: Partial<Record<AuthorityKind, keyof RuntimeCorrelationV1>> = {
    thread: "threadId",
    turn: "turnId",
    requirement: "requirementId",
    job: "jobId",
    task: "taskId",
    agent_run: "runId",
    model_invocation: "modelInvocationId",
    tool_invocation: "toolInvocationId",
  };
  const exactField = exact[aggregateType];
  if (exactField !== undefined && correlation[exactField] !== aggregateId) {
    throw new Error(`Runtime Event ${aggregateType} is misrouted`);
  }
  if (aggregateType === "item" && correlation.turnId === undefined) {
    throw new Error("Runtime Event item requires Turn correlation");
  }
  if (aggregateType === "stage_checkpoint" && correlation.stageId !== aggregateId) {
    throw new Error("Runtime Event stage_checkpoint is misrouted");
  }
  if (aggregateType === "context_checkpoint" && correlation.turnId === undefined) {
    throw new Error("Runtime Event context_checkpoint requires Turn correlation");
  }
  if (aggregateType === "runtime_lease") {
    if (correlation.leaseResourceType === undefined ||
        correlation.leaseResourceId === undefined ||
        correlation.leaseResourceId !== aggregateId) {
      throw new Error("Runtime Event runtime_lease requires an exact resource correlation");
    }
  }
  if ([
    "task_edge",
    "evidence",
    "shared_board",
    "return",
    "stage_checkpoint",
    "dynamic_execution",
    "completion_proof",
  ].includes(aggregateType) && correlation.jobId === undefined) {
    throw new Error(`Runtime Event ${aggregateType} requires Job correlation`);
  }
}

function assertProducer(value: unknown): asserts value is RuntimeEventProducer {
  if (!isRecord(value)) throw new Error("Invalid Runtime Event producer");
  assertNoUnknownFields(value, PRODUCER_FIELDS, "Runtime Event producer");
  assertIdentifier(value.component, "producer.component");
  if (value.instanceId !== undefined) assertIdentifier(value.instanceId, "producer.instanceId");
}

function assertCanonicalTimestamp(value: unknown): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error("Invalid Runtime Event occurredAt");
  }
  const canonical = new Date(value).toISOString();
  if (canonical !== value) throw new Error("Runtime Event occurredAt must be canonical UTC ISO-8601");
}

function cloneRuntimeJson(value: unknown): RuntimeJsonValue {
  assertJsonValue(value, new Set());
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => cloneRuntimeJson(item));
  const result: Record<string, RuntimeJsonValue> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = cloneRuntimeJson(item);
  }
  return result;
}

function sortRuntimeJsonObjectKeys(value: RuntimeJsonValue): RuntimeJsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => sortRuntimeJsonObjectKeys(item));
  const result: Record<string, RuntimeJsonValue> = {};
  for (const key of Object.keys(value).sort()) {
    result[key] = sortRuntimeJsonObjectKeys(value[key]!);
  }
  return result;
}

function assertJsonValue(value: unknown, ancestors: Set<object>): asserts value is RuntimeJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Runtime Event contains a non-finite number");
    return;
  }
  if (typeof value !== "object") throw new Error("Runtime Event must contain JSON values only");
  if (ancestors.has(value)) throw new Error("Runtime Event contains a cyclic value");
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new Error("Runtime Event objects must be plain records");
  }
  if (!Array.isArray(value) && Object.keys(value).some((key) =>
    key === "__proto__" || key === "prototype" || key === "constructor")) {
    throw new Error("Runtime Event contains an unsafe object key");
  }
  ancestors.add(value);
  const entries = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  for (const item of entries) assertJsonValue(item, ancestors);
  ancestors.delete(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value !== value.trim() || value.length === 0 ||
      value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`Invalid Runtime Event ${label}`);
  }
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
