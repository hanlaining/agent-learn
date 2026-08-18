export const RUNTIME_LEASE_RESOURCE_TYPES = [
  "job",
  "turn",
  "model_invocation",
  "tool_invocation",
] as const;

export type RuntimeLeaseResourceType =
  typeof RUNTIME_LEASE_RESOURCE_TYPES[number];

export interface RuntimeLeaseResource {
  type: RuntimeLeaseResourceType;
  id: string;
}

/**
 * leaseVersion changes on every successful CAS mutation. fencingToken changes
 * only when ownership is acquired, so it can fence work started by an older
 * owner even after that owner wakes up late.
 */
export interface RuntimeLease {
  resource: RuntimeLeaseResource;
  ownerId: string;
  leaseVersion: number;
  fencingToken: number;
  expiresAt: string;
}

export type RuntimeLeaseConflictCode =
  | "lease_held"
  | "lease_not_active"
  | "lease_expired"
  | "owner_mismatch"
  | "lease_version_mismatch"
  | "fencing_token_mismatch";

export class RuntimeLeaseConflictError extends Error {
  constructor(
    public readonly code: RuntimeLeaseConflictCode,
    message: string,
    public readonly currentLease?: RuntimeLease,
  ) {
    super(message);
    this.name = "RuntimeLeaseConflictError";
  }
}

export function runtimeLeaseResourceKey(
  resource: RuntimeLeaseResource,
): string {
  assertRuntimeLeaseResource(resource);
  return `${resource.type}\u0000${resource.id}`;
}

export function assertRuntimeLeaseResource(
  resource: RuntimeLeaseResource,
): void {
  if (
    !RUNTIME_LEASE_RESOURCE_TYPES.includes(resource.type) ||
    typeof resource.id !== "string" ||
    resource.id.trim().length === 0
  ) {
    throw new Error("Invalid Runtime lease resource");
  }
}

export function assertRuntimeLease(lease: RuntimeLease): void {
  assertRuntimeLeaseResource(lease.resource);
  if (
    typeof lease.ownerId !== "string" ||
    lease.ownerId.trim().length === 0 ||
    !Number.isSafeInteger(lease.leaseVersion) ||
    lease.leaseVersion <= 0 ||
    !Number.isSafeInteger(lease.fencingToken) ||
    lease.fencingToken <= 0 ||
    !Number.isFinite(Date.parse(lease.expiresAt))
  ) {
    throw new Error("Invalid Runtime lease");
  }
}
