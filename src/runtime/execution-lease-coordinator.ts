import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import type {
  AcquireRuntimeLeaseInput,
} from "./persistent-runtime-lease-store.js";
import {
  RuntimeLeaseConflictError,
  type RuntimeLease,
  type RuntimeLeaseResource,
} from "./runtime-lease.js";

export type ExecutionLeaseCommitBoundary =
  | "return_claim"
  | "return_consume"
  | "workflow_stage"
  | "parent_continuation"
  | "model_commit"
  | "tool_commit"
  | "cancel"
  | "runtime_state";

export interface ExecutionLeaseContext {
  resource: RuntimeLeaseResource;
  ownerId: string;
  leaseVersion: number;
  fencingToken: number;
  deadline: string;
  ttlMs: number;
}

export interface ExecutionLeaseStore {
  acquire(input: AcquireRuntimeLeaseInput): Promise<RuntimeLease>;
  renew(lease: RuntimeLease, ttlMs: number): Promise<RuntimeLease>;
  release(lease: RuntimeLease): Promise<number>;
  withFencedCommit<T>(
    lease: RuntimeLease,
    commit: (fencingToken: number) => T | Promise<T>,
  ): Promise<T>;
}

export interface ExecutionLeaseCoordinatorOptions {
  ownerId?: string;
  ttlMs?: number;
  renewIntervalMs?: number;
  maxAcquireAttempts?: number;
  acquireRetryDelayMs?: (attempt: number) => number;
  maxRenewals?: number;
  maxReleaseAttempts?: number;
  releaseRetryDelayMs?: (attempt: number) => number;
}

export type ExecutionLeaseRunResult<T> =
  | { status: "acquired"; context: ExecutionLeaseContext; value: T }
  | { status: "waiting"; currentLease?: RuntimeLease };

export class ExecutionLeaseUnavailableError extends Error {
  constructor(public readonly jobId: string) {
    super(`Recoverable Job is waiting for its active execution owner: ${jobId}`);
    this.name = "ExecutionLeaseUnavailableError";
  }
}

interface ActiveExecutionLease {
  context: ExecutionLeaseContext;
  lease: RuntimeLease;
  stopped: boolean;
  renewals: number;
  timer?: ReturnType<typeof setTimeout>;
  renewalFailure?: unknown;
  queue: Promise<void>;
}

const DEFAULT_TTL_MS = 120_000;

/**
 * Owns a bounded, persistent Job lease for one recoverable execution drive.
 *
 * The async-local context deliberately carries only client-side fencing data.
 * A fenced commit prevents an expired/superseded app instance from publishing
 * local Runtime state; it does not make a remote Model or Tool provider
 * exactly-once.
 */
export class ExecutionLeaseCoordinator {
  readonly ownerId: string;
  private readonly ttlMs: number;
  private readonly renewIntervalMs: number;
  private readonly maxAcquireAttempts: number;
  private readonly acquireRetryDelayMs: (attempt: number) => number;
  private readonly maxRenewals: number;
  private readonly maxReleaseAttempts: number;
  private readonly releaseRetryDelayMs: (attempt: number) => number;
  private readonly active = new AsyncLocalStorage<ActiveExecutionLease>();

  constructor(
    private readonly store: ExecutionLeaseStore,
    options: ExecutionLeaseCoordinatorOptions = {},
  ) {
    this.ownerId = nonEmpty(options.ownerId ?? `app-${process.pid}-${randomUUID()}`, "ownerId");
    this.ttlMs = positiveInteger(options.ttlMs ?? DEFAULT_TTL_MS, "ttlMs");
    this.renewIntervalMs = positiveInteger(
      options.renewIntervalMs ?? Math.max(1, Math.floor(this.ttlMs / 3)),
      "renewIntervalMs",
    );
    if (this.renewIntervalMs >= this.ttlMs) {
      throw new Error("renewIntervalMs must be less than ttlMs");
    }
    this.maxAcquireAttempts = positiveInteger(
      options.maxAcquireAttempts ?? 1,
      "maxAcquireAttempts",
    );
    this.acquireRetryDelayMs = options.acquireRetryDelayMs ?? (() => 50);
    this.maxRenewals = nonNegativeInteger(options.maxRenewals ?? 30, "maxRenewals");
    this.maxReleaseAttempts = positiveInteger(
      options.maxReleaseAttempts ?? 1,
      "maxReleaseAttempts",
    );
    this.releaseRetryDelayMs = options.releaseRetryDelayMs ?? (() => 25);
  }

  currentContext(): ExecutionLeaseContext | undefined {
    return this.active.getStore()?.context;
  }

  async withJob<T>(jobId: string, operation: () => Promise<T>): Promise<T> {
    const result = await this.runWithJobLease(jobId, () => operation());
    if (result.status === "waiting") throw new ExecutionLeaseUnavailableError(jobId);
    return result.value;
  }

  async runWithJobLease<T>(
    jobId: string,
    operation: (context: ExecutionLeaseContext) => Promise<T>,
  ): Promise<ExecutionLeaseRunResult<T>> {
    nonEmpty(jobId, "jobId");
    const resource = { type: "job", id: jobId } as const;
    const inherited = this.active.getStore();
    if (inherited !== undefined) {
      if (inherited.stopped) throw new Error("Execution lease is no longer active");
      if (inherited.lease.resource.type !== "job" || inherited.lease.resource.id !== jobId) {
        throw new Error("Cannot nest execution leases for different Jobs");
      }
      return {
        status: "acquired",
        context: inherited.context,
        value: await operation(inherited.context),
      };
    }

    const acquired = await this.acquireBounded(resource);
    if (acquired.status === "waiting") return acquired;
    const session: ActiveExecutionLease = {
      lease: acquired.lease,
      context: toContext(acquired.lease, this.ttlMs),
      stopped: false,
      renewals: 0,
      queue: Promise.resolve(),
    };
    this.scheduleRenewal(session);

    let value: T | undefined;
    let operationFailed = false;
    let operationError: unknown;
    try {
      value = await this.active.run(session, () => operation(session.context));
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }
    const cleanupError = await this.stopAndRelease(session);
    if (operationFailed) throw operationError;
    if (session.renewalFailure !== undefined) throw session.renewalFailure;
    if (cleanupError !== undefined) throw cleanupError;
    return { status: "acquired", context: session.context, value: value! };
  }

  async withActiveFencedCommit<T>(
    _boundary: ExecutionLeaseCommitBoundary,
    commit: (fencingToken?: number) => T | Promise<T>,
  ): Promise<T> {
    const session = this.active.getStore();
    if (session === undefined) return commit();
    return this.commitWithSession(session, commit);
  }

  async withRequiredActiveFencedCommit<T>(
    _boundary: ExecutionLeaseCommitBoundary,
    commit: (fencingToken: number) => T | Promise<T>,
  ): Promise<T> {
    const session = this.active.getStore();
    if (session === undefined) throw new Error("No active execution lease");
    return this.commitWithSession(session, commit);
  }

  async renewActiveLease(): Promise<ExecutionLeaseContext> {
    const session = this.active.getStore();
    if (session === undefined || session.stopped) {
      throw new Error("No active execution lease");
    }
    await this.renewSession(session);
    return session.context;
  }

  private async acquireBounded(
    resource: RuntimeLeaseResource,
  ): Promise<{ status: "acquired"; lease: RuntimeLease } | {
    status: "waiting";
    currentLease?: RuntimeLease;
  }> {
    for (let attempt = 1; attempt <= this.maxAcquireAttempts; attempt += 1) {
      try {
        return {
          status: "acquired",
          lease: await this.store.acquire({
            resource,
            ownerId: this.ownerId,
            ttlMs: this.ttlMs,
          }),
        };
      } catch (error) {
        if (!(error instanceof RuntimeLeaseConflictError) || error.code !== "lease_held") {
          throw error;
        }
        if (attempt === this.maxAcquireAttempts) {
          return {
            status: "waiting",
            ...(error.currentLease === undefined ? {} : { currentLease: error.currentLease }),
          };
        }
        await delay(nonNegativeDelay(this.acquireRetryDelayMs(attempt), "acquireRetryDelayMs"));
      }
    }
    throw new Error("Execution lease acquisition attempts exhausted unexpectedly");
  }

  private scheduleRenewal(session: ActiveExecutionLease): void {
    if (session.stopped || session.renewals >= this.maxRenewals) return;
    session.timer = setTimeout(() => {
      delete session.timer;
      void this.renewSession(session).then(
        () => this.scheduleRenewal(session),
        (error) => { session.renewalFailure = error; },
      );
    }, this.renewIntervalMs);
    session.timer.unref?.();
  }

  private async renewSession(session: ActiveExecutionLease): Promise<void> {
    if (session.stopped) return;
    if (session.renewals >= this.maxRenewals) {
      throw new Error("Execution lease renewal limit reached");
    }
    await this.serialize(session, async () => {
      if (session.stopped) return;
      const renewed = await this.store.renew(session.lease, this.ttlMs);
      session.lease = renewed;
      Object.assign(session.context, toContext(renewed, this.ttlMs));
      session.renewals += 1;
    });
  }

  private async stopAndRelease(session: ActiveExecutionLease): Promise<unknown> {
    session.stopped = true;
    if (session.timer !== undefined) clearTimeout(session.timer);
    await session.queue;
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxReleaseAttempts; attempt += 1) {
      try {
        await this.store.release(session.lease);
        return undefined;
      } catch (error) {
        lastError = error;
        if (attempt < this.maxReleaseAttempts) {
          await delay(nonNegativeDelay(this.releaseRetryDelayMs(attempt), "releaseRetryDelayMs"));
        }
      }
    }
    return lastError;
  }

  private serialize<T>(
    session: ActiveExecutionLease,
    operation: () => Promise<T>,
  ): Promise<T> {
    const result = session.queue.then(operation);
    session.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private commitWithSession<T>(
    session: ActiveExecutionLease,
    commit: (fencingToken: number) => T | Promise<T>,
  ): Promise<T> {
    if (session.stopped) return Promise.reject(new Error("Execution lease is no longer active"));
    return this.serialize(session, async () => {
      if (session.renewalFailure !== undefined) throw session.renewalFailure;
      return this.store.withFencedCommit(session.lease, commit);
    });
  }
}

function toContext(lease: RuntimeLease, ttlMs: number): ExecutionLeaseContext {
  return {
    resource: structuredClone(lease.resource),
    ownerId: lease.ownerId,
    leaseVersion: lease.leaseVersion,
    fencingToken: lease.fencingToken,
    deadline: lease.expiresAt,
    ttlMs,
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function nonNegativeDelay(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must return a non-negative finite number`);
  }
  return value;
}

function nonEmpty(value: string, name: string): string {
  if (value.trim().length === 0) throw new Error(`${name} must not be empty`);
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return milliseconds === 0
    ? Promise.resolve()
    : new Promise((resolve) => setTimeout(resolve, milliseconds));
}
