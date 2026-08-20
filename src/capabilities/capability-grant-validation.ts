import {
  CAPABILITY_GRANT_SCHEMA_VERSION,
  createCapabilityGrant,
  recomputeCapabilityGrantDigest,
  type CapabilityGrant,
  type CapabilityGrantInput,
  type CapabilityNameSet,
  type WorkspaceCapability,
} from "./capability-grant.js";
import { isProxy } from "node:util/types";

const DIGEST = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const WORKSPACE_OPERATIONS = new Set(["read", "list", "write", "execute"]);

export function validateCapabilityGrant(grant: CapabilityGrant): void {
  assertDeepFrozenPlainData(grant, "CapabilityGrant");
  if (grant.schemaVersion !== CAPABILITY_GRANT_SCHEMA_VERSION) throw new Error("Unsupported CapabilityGrant schemaVersion");
  assertEnum(grant.authority.sourceKind, ["profile", "job", "task", "workspace_policy", "user_confirmation", "intersection", "legacy"], "authority.sourceKind");
  assertEnum(grant.compatibility, ["native_v1", "legacy_projected"], "compatibility");
  assertEnum(grant.maxSideEffectClass, ["none", "read_only", "workspace_write", "external_reversible", "external_irreversible"], "maxSideEffectClass");
  assertEnum(grant.terminal.network, ["none", "restricted", "full"], "terminal.network");
  assertEnum(grant.terminal.process, ["none", "recipe_only"], "terminal.process");
  assertIdentifier(grant.authority.sourceId, "authority.sourceId");
  assertNonEmpty(grant.authority.sourceRevision, "authority.sourceRevision");
  assertTimestamp(grant.authority.issuedAt, "authority.issuedAt");
  if (grant.authority.expiresAt !== undefined) {
    assertTimestamp(grant.authority.expiresAt, "authority.expiresAt");
    if (Date.parse(grant.authority.expiresAt) <= Date.parse(grant.authority.issuedAt)) {
      throw new Error("CapabilityGrant expiresAt must be later than issuedAt");
    }
  }
  assertIdentifier(grant.subject.threadId, "subject.threadId");
  for (const [field, value] of Object.entries(grant.subject)) {
    if (value !== undefined && field !== "contractDigest" &&
        field !== "requirementRevision" && field !== "jobAttempt" && field !== "taskAttempt") {
      assertIdentifier(value, `subject.${field}`);
    }
  }
  for (const field of ["requirementRevision", "jobAttempt", "taskAttempt"] as const) {
    const value = grant.subject[field];
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new Error(`Invalid subject.${field}`);
  }
  if (grant.subject.contractDigest !== undefined) assertDigest(grant.subject.contractDigest, "subject.contractDigest");
  if (grant.compatibility === "native_v1" && ["task", "intersection"].includes(grant.authority.sourceKind) &&
      grant.subject.contractDigest === undefined) {
    throw new Error("Native Task and intersection CapabilityGrant require subject.contractDigest");
  }
  validateNameSet(grant.tools, "tools");
  validateNameSet(grant.skills, "skills");
  validateNameSet(grant.credentials, "credentials", false);
  assertUnique(grant.mcp.map((item) => item.serverId), "MCP server");
  for (const server of grant.mcp) {
    assertIdentifier(server.serverId, "mcp.serverId");
    validateNameSet(server.tools, `mcp.${server.serverId}.tools`);
  }
  assertUnique(grant.workspaces.map((item) => item.namespace), "workspace namespace");
  for (const workspace of grant.workspaces) validateWorkspace(workspace, grant.compatibility);
  assertUnique(grant.terminal.recipes.map((item) => `${item.workspaceNamespace}\u0000${item.recipeId}`), "terminal recipe");
  for (const recipe of grant.terminal.recipes) {
    assertIdentifier(recipe.recipeId, "terminal.recipeId");
    assertIdentifier(recipe.workspaceNamespace, "terminal.workspaceNamespace");
    if (!grant.workspaces.some((workspace) => workspace.namespace === recipe.workspaceNamespace)) {
      throw new Error("Terminal recipe references an undeclared workspace namespace");
    }
  }
  for (const [field, value] of Object.entries(grant.quotas)) assertNonNegativeInteger(value, `quotas.${field}`);
  if (grant.confirmation !== undefined) {
    assertIdentifier(grant.confirmation.requirementId, "confirmation.requirementId");
    if (!Number.isSafeInteger(grant.confirmation.revision) || grant.confirmation.revision <= 0) {
      throw new Error("Capability confirmation revision must be a positive integer");
    }
    assertDigest(grant.confirmation.contentHash, "confirmation.contentHash");
    if (grant.subject.requirementId === undefined || grant.subject.requirementRevision === undefined ||
        grant.subject.requirementId !== grant.confirmation.requirementId ||
        grant.subject.requirementRevision !== grant.confirmation.revision) {
      throw new Error("Capability confirmation must exactly match the subject Requirement ID and revision");
    }
  }
  if (grant.compatibility === "native_v1" && grant.authority.sourceKind === "intersection") {
    const required = ["threadId", "turnId", "requirementId", "requirementRevision", "jobId", "jobAttempt", "taskId", "taskAttempt", "runId", "contractDigest"] as const;
    if (required.some((field) => grant.subject[field] === undefined)) {
      throw new Error("Final Capability intersection requires complete Thread/Turn/Requirement/Job/Task/Run/Contract subject lineage");
    }
  }
  if (grant.authority.sourceKind === "legacy" && grant.compatibility !== "legacy_projected") throw new Error("A legacy source cannot claim native_v1 compatibility");
  if (grant.compatibility === "legacy_projected" && grant.authority.sourceKind !== "legacy") throw new Error("Only a legacy source may claim legacy_projected compatibility");
  assertDigest(grant.normalizedDigest, "normalizedDigest");
  if (grant.normalizedDigest !== recomputeCapabilityGrantDigest(grant)) {
    throw new Error("CapabilityGrant normalizedDigest does not match its normalized content");
  }
}

declare const validatedCapabilityGrantBrand: unique symbol;
export type ValidatedCapabilityGrant = CapabilityGrant & {
  readonly [validatedCapabilityGrantBrand]: "validated.capability_grant.v1";
};

/** Deterministic structural validation only; this is not a cryptographic production Issuer signature. */
export function createValidatedCapabilityGrant(input: CapabilityGrantInput): ValidatedCapabilityGrant {
  const grant = createCapabilityGrant(input);
  validateCapabilityGrant(grant);
  return grant as ValidatedCapabilityGrant;
}

export function isSafeRelativeCapabilityPath(value: string): boolean {
  if (value === "*") return true;
  if (value.length === 0 || value.includes("\\") || value.includes("\0")) return false;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

function validateWorkspace(workspace: WorkspaceCapability, compatibility: CapabilityGrant["compatibility"]): void {
  assertIdentifier(workspace.namespace, "workspace.namespace");
  assertEnum(workspace.pathSemantics, ["expressed", "unexpressed"], "workspace.pathSemantics");
  if (workspace.pathSemantics === "unexpressed" && compatibility !== "legacy_projected") {
    throw new Error("Only a legacy projection may carry unexpressed workspace paths");
  }
  validatePathSet(workspace.paths, `workspace.${workspace.namespace}.paths`);
  validateNameSet(workspace.operations, `workspace.${workspace.namespace}.operations`, false);
  for (const operation of [...workspace.operations.allow, ...workspace.operations.deny]) {
    if (!WORKSPACE_OPERATIONS.has(operation)) throw new Error(`Unknown workspace operation: ${operation}`);
  }
}

function validatePathSet(value: CapabilityNameSet, field: string): void {
  assertUnique(value.allow, `${field}.allow`);
  assertUnique(value.deny, `${field}.deny`);
  for (const path of [...value.allow, ...value.deny]) {
    if (path !== "*" && path.includes("*")) throw new Error(`${field} only supports the complete \"*\" wildcard`);
    if (!isSafeRelativeCapabilityPath(path)) throw new Error(`Unsafe workspace path: ${path}`);
  }
}

function validateNameSet(value: CapabilityNameSet, field: string, allowWildcard = true): void {
  assertUnique(value.allow, `${field}.allow`);
  assertUnique(value.deny, `${field}.deny`);
  for (const name of [...value.allow, ...value.deny]) {
    if (name === "*" && allowWildcard) continue;
    if (name.includes("*")) throw new Error(`${field} only supports the complete \"*\" wildcard`);
    assertIdentifier(name, field);
  }
}

function assertIdentifier(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new Error(`Invalid ${field}`);
}

function assertNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`Invalid ${field}`);
}

function assertTimestamp(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`Invalid ${field}`);
}

function assertDigest(value: string, field: string): void {
  if (!DIGEST.test(value)) throw new Error(`Invalid ${field}`);
}

function assertNonNegativeInteger(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${field}`);
}

function assertUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${field}`);
}

function assertEnum(value: string, allowed: readonly string[], field: string): void {
  if (!allowed.includes(value)) throw new Error(`Invalid ${field}`);
}

function assertDeepFrozenPlainData(value: unknown, field: string): void {
  if (value === null || typeof value !== "object") return;
  if (isProxy(value)) throw new Error(`${field} cannot be a Proxy`);
  if (!Object.isFrozen(value)) throw new Error(`${field} must be a frozen stable snapshot`);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new Error(`${field} must contain plain data objects`);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (key === "length" && Array.isArray(value)) continue;
    if (descriptor.get !== undefined || descriptor.set !== undefined) throw new Error(`${field} cannot contain getters or setters`);
    assertDeepFrozenPlainData(descriptor.value, `${field}.${key}`);
  }
}
