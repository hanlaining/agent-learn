import { randomUUID } from "node:crypto";
import {
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  join,
} from "node:path";

import {
  RuntimeLeaseConflictError,
  assertRuntimeLease,
  assertRuntimeLeaseResource,
  runtimeLeaseResourceKey,
  type RuntimeLease,
  type RuntimeLeaseResource,
  type RuntimeLeaseResourceType,
} from "./runtime-lease.js";
import {
  ProcessSafeFileLock,
  type ProcessSafeFileLockOptions,
} from "./process-safe-file-lock.js";

interface PersistedRuntimeLeaseEntry {
  resourceType: RuntimeLeaseResourceType;
  resourceId: string;
  leaseVersion: number;
  fencingToken: number;
  ownerId?: string;
  expiresAt?: string;
  updatedAt: string;
}

interface RuntimeLeaseStateSnapshot {
  version: 1;
  entries: PersistedRuntimeLeaseEntry[];
}

export interface AcquireRuntimeLeaseInput {
  resource: RuntimeLeaseResource;
  ownerId: string;
  ttlMs: number;
  /** Zero means that the resource has never had a lease. */
  expectedLeaseVersion?: number;
}

export interface PersistentRuntimeLeaseStoreOptions extends ProcessSafeFileLockOptions {
  now?: () => string;
}

const EMPTY_STATE: RuntimeLeaseStateSnapshot = {
  version: 1,
  entries: [],
};

/**
 * A process-safe, persistent Lease/CAS store backed by one JSON file.
 *
 * Every read/modify/write transaction is serialized by unique Bakery-algorithm
 * claim files. A crashed process only loses its own immutable claim, so stale
 * recovery never deletes a successor's lock. Lease state is then replaced
 * through a same-directory temporary file. Ownership safety comes from both
 * this transaction mutex and persisted CAS versions plus fencing tokens.
 */
export class PersistentRuntimeLeaseStore {
  private readonly now: () => string;
  private readonly stateLock: ProcessSafeFileLock;

  constructor(
    private readonly statePath: string,
    options: PersistentRuntimeLeaseStoreOptions = {},
  ) {
    if (statePath.trim().length === 0) {
      throw new Error("Runtime lease state path must not be empty");
    }
    this.now = options.now ?? (() => new Date().toISOString());
    this.stateLock = new ProcessSafeFileLock(`${statePath}.lock`, options, "Runtime lease state");
  }

  async acquire(input: AcquireRuntimeLeaseInput): Promise<RuntimeLease> {
    assertRuntimeLeaseResource(input.resource);
    assertOwnerId(input.ownerId);
    const ttlMs = positiveInteger(input.ttlMs, "ttlMs");
    if (
      input.expectedLeaseVersion !== undefined &&
      (!Number.isSafeInteger(input.expectedLeaseVersion) ||
        input.expectedLeaseVersion < 0)
    ) {
      throw new Error("expectedLeaseVersion must be a non-negative safe integer");
    }

    return this.withStateLock(async () => {
      const state = await this.readState();
      const entry = findEntry(state, input.resource);
      const currentVersion = entry?.leaseVersion ?? 0;
      if (
        input.expectedLeaseVersion !== undefined &&
        input.expectedLeaseVersion !== currentVersion
      ) {
        throw new RuntimeLeaseConflictError(
          "lease_version_mismatch",
          `Runtime lease version mismatch: ${runtimeLeaseResourceKey(input.resource)}`,
          entry === undefined ? undefined : toLease(entry),
        );
      }

      const timestamp = this.validNow();
      if (entry !== undefined && isUnexpired(entry, timestamp)) {
        throw new RuntimeLeaseConflictError(
          "lease_held",
          `Runtime lease is already held: ${runtimeLeaseResourceKey(input.resource)}`,
          toLease(entry),
        );
      }

      const acquired: PersistedRuntimeLeaseEntry = {
        resourceType: input.resource.type,
        resourceId: input.resource.id,
        leaseVersion: currentVersion + 1,
        fencingToken: (entry?.fencingToken ?? 0) + 1,
        ownerId: input.ownerId,
        expiresAt: addMilliseconds(timestamp, ttlMs),
        updatedAt: timestamp,
      };
      replaceEntry(state, acquired);
      await this.writeState(state);
      return toLease(acquired)!;
    });
  }

  async renew(lease: RuntimeLease, ttlMs: number): Promise<RuntimeLease> {
    assertRuntimeLease(lease);
    const duration = positiveInteger(ttlMs, "ttlMs");
    return this.mutateHeldLease(lease, (entry, timestamp) => {
      entry.leaseVersion += 1;
      entry.expiresAt = addMilliseconds(timestamp, duration);
      entry.updatedAt = timestamp;
      return toLease(entry)!;
    });
  }

  async release(lease: RuntimeLease): Promise<number> {
    assertRuntimeLease(lease);
    return this.mutateHeldLease(lease, (entry, timestamp) => {
      entry.leaseVersion += 1;
      entry.updatedAt = timestamp;
      delete entry.ownerId;
      delete entry.expiresAt;
      return entry.leaseVersion;
    });
  }

  async read(resource: RuntimeLeaseResource): Promise<RuntimeLease | undefined> {
    assertRuntimeLeaseResource(resource);
    return this.withStateLock(async () => {
      const state = await this.readState();
      const entry = findEntry(state, resource);
      return entry === undefined ? undefined : toLease(entry);
    });
  }

  async assertHeld(lease: RuntimeLease): Promise<void> {
    assertRuntimeLease(lease);
    await this.withStateLock(async () => {
      const state = await this.readState();
      this.requireHeldEntry(state, lease, this.validNow());
    });
  }

  /**
   * Runs a persistence commit in the same cross-process critical section as
   * lease takeover. An expired or superseded owner is rejected before the
   * callback starts, eliminating the check-then-write race.
   */
  async withFencedCommit<T>(
    lease: RuntimeLease,
    commit: (fencingToken: number) => T | Promise<T>,
  ): Promise<T> {
    assertRuntimeLease(lease);
    return this.withStateLock(async () => {
      const state = await this.readState();
      this.requireHeldEntry(state, lease, this.validNow());
      return commit(lease.fencingToken);
    });
  }

  private async mutateHeldLease<T>(
    lease: RuntimeLease,
    mutate: (
      entry: PersistedRuntimeLeaseEntry,
      timestamp: string,
    ) => T,
  ): Promise<T> {
    return this.withStateLock(async () => {
      const state = await this.readState();
      const timestamp = this.validNow();
      const entry = this.requireHeldEntry(state, lease, timestamp);
      const result = mutate(entry, timestamp);
      await this.writeState(state);
      return result;
    });
  }

  private requireHeldEntry(
    state: RuntimeLeaseStateSnapshot,
    lease: RuntimeLease,
    timestamp: string,
  ): PersistedRuntimeLeaseEntry {
    const entry = findEntry(state, lease.resource);
    if (entry === undefined || entry.ownerId === undefined || entry.expiresAt === undefined) {
      throw new RuntimeLeaseConflictError(
        "lease_not_active",
        `Runtime lease is not active: ${runtimeLeaseResourceKey(lease.resource)}`,
      );
    }
    if (entry.fencingToken !== lease.fencingToken) {
      throw new RuntimeLeaseConflictError(
        "fencing_token_mismatch",
        `Runtime lease fencing token mismatch: ${runtimeLeaseResourceKey(lease.resource)}`,
        toLease(entry),
      );
    }
    if (entry.ownerId !== lease.ownerId) {
      throw new RuntimeLeaseConflictError(
        "owner_mismatch",
        `Runtime lease owner mismatch: ${runtimeLeaseResourceKey(lease.resource)}`,
        toLease(entry),
      );
    }
    if (entry.leaseVersion !== lease.leaseVersion) {
      throw new RuntimeLeaseConflictError(
        "lease_version_mismatch",
        `Runtime lease version mismatch: ${runtimeLeaseResourceKey(lease.resource)}`,
        toLease(entry),
      );
    }
    if (!isUnexpired(entry, timestamp)) {
      throw new RuntimeLeaseConflictError(
        "lease_expired",
        `Runtime lease has expired: ${runtimeLeaseResourceKey(lease.resource)}`,
        toLease(entry),
      );
    }
    return entry;
  }

  private validNow(): string {
    const timestamp = this.now();
    if (!Number.isFinite(Date.parse(timestamp))) {
      throw new Error("Runtime lease clock returned an invalid timestamp");
    }
    return timestamp;
  }

  private async withStateLock<T>(operation: () => Promise<T>): Promise<T> {
    return this.stateLock.withLock(operation);
  }

  private async readState(): Promise<RuntimeLeaseStateSnapshot> {
    let text: string;
    try {
      text = await readFile(this.statePath, "utf8");
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return structuredClone(EMPTY_STATE);
      throw error;
    }
    return parseState(JSON.parse(text) as unknown);
  }

  private async writeState(state: RuntimeLeaseStateSnapshot): Promise<void> {
    const temporaryPath = join(
      dirname(this.statePath),
      `.${basename(this.statePath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify(state, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      await rename(temporaryPath, this.statePath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }
}

function parseState(value: unknown): RuntimeLeaseStateSnapshot {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries)) {
    throw new Error("Invalid Runtime lease state");
  }
  const entries = value.entries.map(parseEntry);
  const keys = entries.map((entry) => runtimeLeaseResourceKey({
    type: entry.resourceType,
    id: entry.resourceId,
  }));
  if (new Set(keys).size !== keys.length) {
    throw new Error("Invalid Runtime lease state: duplicate resource");
  }
  return { version: 1, entries };
}

function parseEntry(value: unknown): PersistedRuntimeLeaseEntry {
  if (!isRecord(value)) throw new Error("Invalid Runtime lease entry");
  const resource = {
    type: value.resourceType as RuntimeLeaseResourceType,
    id: value.resourceId as string,
  };
  assertRuntimeLeaseResource(resource);
  if (
    !Number.isSafeInteger(value.leaseVersion) ||
    (value.leaseVersion as number) <= 0 ||
    !Number.isSafeInteger(value.fencingToken) ||
    (value.fencingToken as number) <= 0 ||
    !Number.isFinite(Date.parse(value.updatedAt as string)) ||
    ((value.ownerId === undefined) !== (value.expiresAt === undefined))
  ) {
    throw new Error("Invalid Runtime lease entry");
  }
  if (
    value.ownerId !== undefined &&
    (typeof value.ownerId !== "string" ||
      value.ownerId.trim().length === 0 ||
      !Number.isFinite(Date.parse(value.expiresAt as string)))
  ) {
    throw new Error("Invalid Runtime lease entry");
  }
  return {
    resourceType: resource.type,
    resourceId: resource.id,
    leaseVersion: value.leaseVersion as number,
    fencingToken: value.fencingToken as number,
    ...(value.ownerId === undefined ? {} : { ownerId: value.ownerId as string }),
    ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt as string }),
    updatedAt: value.updatedAt as string,
  };
}

function findEntry(
  state: RuntimeLeaseStateSnapshot,
  resource: RuntimeLeaseResource,
): PersistedRuntimeLeaseEntry | undefined {
  return state.entries.find((entry) =>
    entry.resourceType === resource.type && entry.resourceId === resource.id);
}

function replaceEntry(
  state: RuntimeLeaseStateSnapshot,
  replacement: PersistedRuntimeLeaseEntry,
): void {
  const index = state.entries.findIndex((entry) =>
    entry.resourceType === replacement.resourceType &&
    entry.resourceId === replacement.resourceId);
  if (index === -1) state.entries.push(replacement);
  else state.entries[index] = replacement;
}

function toLease(entry: PersistedRuntimeLeaseEntry): RuntimeLease | undefined {
  if (entry.ownerId === undefined || entry.expiresAt === undefined) return undefined;
  return {
    resource: {
      type: entry.resourceType,
      id: entry.resourceId,
    },
    ownerId: entry.ownerId,
    leaseVersion: entry.leaseVersion,
    fencingToken: entry.fencingToken,
    expiresAt: entry.expiresAt,
  };
}

function isUnexpired(
  entry: PersistedRuntimeLeaseEntry,
  timestamp: string,
): boolean {
  return entry.ownerId !== undefined && entry.expiresAt !== undefined &&
    Date.parse(entry.expiresAt) > Date.parse(timestamp);
}

function addMilliseconds(timestamp: string, duration: number): string {
  return new Date(Date.parse(timestamp) + duration).toISOString();
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function assertOwnerId(ownerId: string): void {
  if (typeof ownerId !== "string" || ownerId.trim().length === 0) {
    throw new Error("ownerId must not be empty");
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
