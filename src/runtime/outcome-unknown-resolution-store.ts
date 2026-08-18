import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  OutcomeUnknownResolutionError,
  type OutcomeUnknownAuditRecord,
  type OutcomeUnknownExternalResult,
  type OutcomeUnknownResolutionAction,
  type OutcomeUnknownResolutionRecord,
  type OutcomeUnknownResolutionSnapshot,
  type RegisterOutcomeUnknownInput,
  type ResolveOutcomeUnknownInput,
} from "./outcome-unknown-resolution.js";

export interface OutcomeUnknownResolutionStoreOptions {
  statePath?: string;
  now?: () => string;
  createId?: (prefix: "audit" | "retry") => string;
  initialSnapshot?: OutcomeUnknownResolutionSnapshot;
}

export class OutcomeUnknownResolutionStore {
  private snapshot: OutcomeUnknownResolutionSnapshot;
  private mutationQueue: Promise<void> = Promise.resolve();
  private sequence = 0;
  private readonly now: () => string;
  private readonly createId: (prefix: "audit" | "retry") => string;

  constructor(private readonly options: OutcomeUnknownResolutionStoreOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? ((prefix) => `${prefix}-${cryptoId()}`);
    this.snapshot = parseSnapshot(options.initialSnapshot ?? { version: 1, records: [] });
  }

  static async open(options: Omit<OutcomeUnknownResolutionStoreOptions, "initialSnapshot">): Promise<OutcomeUnknownResolutionStore> {
    if (options.statePath === undefined) return new OutcomeUnknownResolutionStore(options);
    let snapshot: OutcomeUnknownResolutionSnapshot | undefined;
    try {
      snapshot = JSON.parse(await readFile(options.statePath, "utf8")) as OutcomeUnknownResolutionSnapshot;
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
    }
    return new OutcomeUnknownResolutionStore({ ...options, ...(snapshot === undefined ? {} : { initialSnapshot: snapshot }) });
  }

  list(threadId?: string): OutcomeUnknownResolutionRecord[] {
    return this.snapshot.records
      .filter((record) => threadId === undefined || record.identity.threadId === threadId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(cloneRecord);
  }

  get(resolutionId: string): OutcomeUnknownResolutionRecord | undefined {
    const record = this.snapshot.records.find((item) => item.resolutionId === resolutionId);
    return record === undefined ? undefined : cloneRecord(record);
  }

  register(input: RegisterOutcomeUnknownInput): Promise<OutcomeUnknownResolutionRecord> {
    return this.mutate((snapshot) => {
      validateRegistration(input);
      const resolutionId = createResolutionId(input.invocationKind, input.invocationId);
      const existing = snapshot.records.find((record) => record.resolutionId === resolutionId);
      if (existing !== undefined) {
        if (registrationFingerprint(existing) !== registrationFingerprint(input)) {
          throw new OutcomeUnknownResolutionError("INVALID_INPUT", "Invocation immutable facts do not match");
        }
        return cloneRecord(existing);
      }
      const timestamp = this.now();
      const record: OutcomeUnknownResolutionRecord = {
        resolutionId,
        invocationKind: input.invocationKind,
        invocationId: input.invocationId,
        requestDigest: input.requestDigest,
        identity: structuredClone(input.identity),
        sideEffectRisk: input.sideEffectRisk,
        state: "outcome_unknown",
        version: 1,
        ...(input.unknownReasonCode === undefined ? {} : { unknownReasonCode: input.unknownReasonCode }),
        createdAt: timestamp,
        updatedAt: timestamp,
        audit: [],
      };
      snapshot.records.push(record);
      return cloneRecord(record);
    });
  }

  resolve(input: ResolveOutcomeUnknownInput, actorId: string): Promise<OutcomeUnknownResolutionRecord> {
    return this.mutate((snapshot) => {
      validateResolveInput(input, actorId);
      const fingerprint = requestFingerprint(input);
      const priorAudit = snapshot.records.flatMap((record) => record.audit)
        .find((audit) => audit.idempotencyKey === input.idempotencyKey);
      if (priorAudit !== undefined) {
        if (priorAudit.requestFingerprint !== fingerprint || priorAudit.actorId !== actorId) {
          throw new OutcomeUnknownResolutionError("IDEMPOTENCY_KEY_REUSED", "Idempotency key was already used for another action");
        }
        const priorRecord = snapshot.records.find((record) => record.resolutionId === priorAudit.resolutionId);
        if (priorRecord === undefined) throw new Error("Resolution audit references a missing record");
        return cloneRecord(priorRecord);
      }

      const record = snapshot.records.find((item) => item.resolutionId === input.resolutionId);
      if (record === undefined) {
        throw new OutcomeUnknownResolutionError("NOT_FOUND", "Outcome-unknown invocation was not found");
      }
      if (record.version !== input.expectedVersion) {
        throw new OutcomeUnknownResolutionError("VERSION_CONFLICT", `Expected version ${input.expectedVersion}, current version is ${record.version}`);
      }
      assertTransition(record, input.resolution);

      const timestamp = this.now();
      const fromState = record.state;
      const toState = targetState(input.resolution);
      record.state = toState;
      record.version += 1;
      record.updatedAt = timestamp;
      delete record.externalResult;
      delete record.retryTicket;

      let externalResultDigest: string | undefined;
      if (input.resolution.action === "record_external_result") {
        record.externalResult = sanitizeExternalResult(input.resolution.externalResult);
        externalResultDigest = digest(record.externalResult);
      }
      if (input.resolution.action === "confirm_not_executed_retry") {
        record.retryTicket = {
          id: this.createId("retry"),
          invocationId: record.invocationId,
          authorizedBy: actorId,
          authorizedAt: timestamp,
          consumed: false,
          automaticReplay: false,
        };
      }

      const audit: OutcomeUnknownAuditRecord = {
        id: this.createId("audit"),
        resolutionId: record.resolutionId,
        action: input.resolution.action,
        actorId,
        reason: input.resolution.reason.trim(),
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: fingerprint,
        fromState,
        toState,
        version: record.version,
        occurredAt: timestamp,
        ...(externalResultDigest === undefined ? {} : { externalResultDigest }),
        ...(input.resolution.action === "confirm_not_executed_retry" && input.resolution.toolSideEffectConfirmed === true
          ? { toolSideEffectConfirmed: true }
          : {}),
      };
      record.audit.push(audit);
      return cloneRecord(record);
    });
  }

  exportSnapshot(): OutcomeUnknownResolutionSnapshot {
    return structuredClone(this.snapshot);
  }

  private mutate<T>(operation: (snapshot: OutcomeUnknownResolutionSnapshot) => T): Promise<T> {
    let result!: T;
    const task = this.mutationQueue.then(async () => {
      const candidate = structuredClone(this.snapshot);
      result = operation(candidate);
      await this.writeSnapshot(candidate);
      this.snapshot = candidate;
    });
    this.mutationQueue = task.catch(() => undefined);
    return task.then(() => result);
  }

  private async writeSnapshot(snapshot: OutcomeUnknownResolutionSnapshot): Promise<void> {
    if (this.options.statePath === undefined) return;
    const statePath = this.options.statePath;
    const directory = dirname(statePath);
    this.sequence += 1;
    const temporaryPath = join(directory, `.${basename(statePath)}.${process.pid}.${this.sequence}.tmp`);
    await mkdir(directory, { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, statePath);
  }
}

function targetState(action: OutcomeUnknownResolutionAction): OutcomeUnknownResolutionRecord["state"] {
  switch (action.action) {
    case "confirm_not_executed_retry": return "retry_authorized";
    case "record_external_result": return "external_result_recorded";
    case "mark_manual_required": return "manual_required";
    case "abandon": return "abandoned";
  }
}

function assertTransition(record: OutcomeUnknownResolutionRecord, action: OutcomeUnknownResolutionAction): void {
  if (record.state !== "outcome_unknown" && record.state !== "manual_required") {
    throw new OutcomeUnknownResolutionError("INVALID_STATE", `Cannot resolve invocation in state ${record.state}`);
  }
  if (record.state === "manual_required" && action.action === "mark_manual_required") {
    throw new OutcomeUnknownResolutionError("INVALID_STATE", "Invocation already requires manual handling");
  }
  if (action.action === "confirm_not_executed_retry" && record.invocationKind === "tool" &&
    record.sideEffectRisk !== "none" && action.toolSideEffectConfirmed !== true) {
    throw new OutcomeUnknownResolutionError(
      "TOOL_SIDE_EFFECT_CONFIRMATION_REQUIRED",
      "Tool retry requires explicit confirmation that the side effect did not occur",
    );
  }
}

function validateRegistration(input: RegisterOutcomeUnknownInput): void {
  if (input.invocationKind !== "model" && input.invocationKind !== "tool") {
    throw new OutcomeUnknownResolutionError("INVALID_INPUT", "invocationKind is invalid");
  }
  if (input.sideEffectRisk !== "none" && input.sideEffectRisk !== "possible" && input.sideEffectRisk !== "known") {
    throw new OutcomeUnknownResolutionError("INVALID_INPUT", "sideEffectRisk is invalid");
  }
  assertNonEmpty(input.invocationId, "invocationId");
  if (!/^sha256:[a-f0-9]{64}$/u.test(input.requestDigest)) {
    throw new OutcomeUnknownResolutionError("INVALID_INPUT", "requestDigest must be a SHA-256 digest");
  }
  assertNonEmpty(input.identity.threadId, "threadId");
  assertNonEmpty(input.identity.turnId, "turnId");
  assertNonEmpty(input.identity.displayName, "displayName");
  for (const [field, value] of Object.entries(input.identity)) {
    if (value !== undefined && typeof value !== "string") {
      throw new OutcomeUnknownResolutionError("INVALID_INPUT", `${field} must be a string`);
    }
  }
  if (input.invocationKind === "tool") assertNonEmpty(input.identity.toolName ?? "", "toolName");
}

function validateResolveInput(input: ResolveOutcomeUnknownInput, actorId: string): void {
  assertNonEmpty(actorId, "actorId");
  assertNonEmpty(input.resolutionId, "resolutionId");
  assertNonEmpty(input.idempotencyKey, "idempotencyKey");
  assertNonEmpty(input.resolution.reason, "reason");
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new OutcomeUnknownResolutionError("INVALID_INPUT", "expectedVersion must be a positive integer");
  }
  if (input.resolution.action === "record_external_result") {
    sanitizeExternalResult(input.resolution.externalResult);
  }
}

function sanitizeExternalResult(value: OutcomeUnknownExternalResult): OutcomeUnknownExternalResult {
  if (typeof value !== "object" || value === null) {
    throw new OutcomeUnknownResolutionError("INVALID_INPUT", "External result is required");
  }
  assertNonEmpty(value.summary, "externalResult.summary");
  return {
    summary: value.summary.trim().slice(0, 2_000),
    value: cloneRedactedJson(value.value),
  };
}

function cloneRedactedJson(value: unknown): unknown {
  const normalized = redact(value, new Set<object>());
  const serialized = JSON.stringify(normalized);
  if (serialized === undefined || serialized.length > 256_000) {
    throw new OutcomeUnknownResolutionError("INVALID_INPUT", "External result must be bounded JSON");
  }
  return JSON.parse(serialized) as unknown;
}

function redact(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new OutcomeUnknownResolutionError("INVALID_INPUT", "External result contains a non-finite number");
    return value;
  }
  if (typeof value !== "object" || seen.has(value)) {
    throw new OutcomeUnknownResolutionError("INVALID_INPUT", "External result must be acyclic JSON");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => redact(item, seen));
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      /authorization|api[_-]?key|token|cookie|secret/i.test(key) ? "[REDACTED]" : redact(item, seen),
    ]));
  } finally {
    seen.delete(value);
  }
}

function parseSnapshot(value: OutcomeUnknownResolutionSnapshot): OutcomeUnknownResolutionSnapshot {
  if (typeof value !== "object" || value === null || value.version !== 1 || !Array.isArray(value.records)) {
    throw new Error("Invalid outcome-unknown resolution snapshot");
  }
  const snapshot = structuredClone(value);
  const ids = new Set<string>();
  const idempotencyKeys = new Set<string>();
  const states = new Set(["outcome_unknown", "retry_authorized", "external_result_recorded", "manual_required", "abandoned"]);
  const actions = new Set(["confirm_not_executed_retry", "record_external_result", "mark_manual_required", "abandon"]);
  for (const record of snapshot.records) {
    validateRegistration(record);
    if (record.resolutionId !== createResolutionId(record.invocationKind, record.invocationId) || ids.has(record.resolutionId) ||
      !states.has(record.state) || !Number.isInteger(record.version) || record.version < 1 ||
      !isTimestamp(record.createdAt) || !isTimestamp(record.updatedAt) || !Array.isArray(record.audit)) {
      throw new Error("Invalid outcome-unknown resolution snapshot record");
    }
    ids.add(record.resolutionId);
    for (const audit of record.audit) {
      if (typeof audit !== "object" || audit === null || audit.resolutionId !== record.resolutionId ||
        !actions.has(audit.action) || typeof audit.actorId !== "string" || typeof audit.reason !== "string" ||
        typeof audit.idempotencyKey !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(audit.requestFingerprint) ||
        !states.has(audit.fromState) || !states.has(audit.toState) || !Number.isInteger(audit.version) ||
        audit.version < 2 || audit.version > record.version || !isTimestamp(audit.occurredAt) ||
        idempotencyKeys.has(audit.idempotencyKey)) {
        throw new Error("Invalid outcome-unknown audit snapshot record");
      }
      idempotencyKeys.add(audit.idempotencyKey);
    }
  }
  return snapshot;
}

function registrationFingerprint(value: RegisterOutcomeUnknownInput | OutcomeUnknownResolutionRecord): string {
  return digest({
    invocationKind: value.invocationKind,
    invocationId: value.invocationId,
    requestDigest: value.requestDigest,
    identity: value.identity,
    sideEffectRisk: value.sideEffectRisk,
    unknownReasonCode: value.unknownReasonCode,
  });
}

function requestFingerprint(input: ResolveOutcomeUnknownInput): string {
  return digest({ resolutionId: input.resolutionId, resolution: input.resolution });
}

function createResolutionId(kind: string, invocationId: string): string {
  return `outcome-resolution-${digest({ kind, invocationId }).slice("sha256:".length, "sha256:".length + 32)}`;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value), "utf8").digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function cloneRecord(value: OutcomeUnknownResolutionRecord): OutcomeUnknownResolutionRecord {
  return structuredClone(value);
}

function cryptoId(): string {
  return randomUUID();
}

function isTimestamp(value: string): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new OutcomeUnknownResolutionError("INVALID_INPUT", `${field} must not be empty`);
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
