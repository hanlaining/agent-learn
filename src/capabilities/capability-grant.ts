import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";

export const CAPABILITY_GRANT_SCHEMA_VERSION = 1 as const;

export type CapabilityGrantSourceKind =
  | "profile"
  | "job"
  | "task"
  | "workspace_policy"
  | "user_confirmation"
  | "intersection"
  | "legacy";

/** GrantIssuer provenance; this is not Runtime AuthorityOwnership or a Store writer registration. */
export interface CapabilityGrantAuthority {
  sourceKind: CapabilityGrantSourceKind;
  sourceId: string;
  sourceRevision: string;
  issuedAt: string;
  expiresAt?: string;
}

export interface CapabilityGrantSubject {
  threadId: string;
  turnId?: string;
  requirementId?: string;
  requirementRevision?: number;
  jobId?: string;
  jobAttempt?: number;
  taskId?: string;
  taskAttempt?: number;
  runId?: string;
  /** Digest of the Task Contract, not the CapabilityGrant normalizedDigest. */
  contractDigest?: string;
}

export interface CapabilityNameSet {
  allow: string[];
  deny: string[];
}

export interface McpServerCapability {
  serverId: string;
  tools: CapabilityNameSet;
}

export type WorkspaceOperation = "read" | "list" | "write" | "execute";

export interface WorkspaceCapability {
  namespace: string;
  pathSemantics: "expressed" | "unexpressed";
  paths: CapabilityNameSet;
  operations: CapabilityNameSet;
}

export interface TerminalRecipeCapability {
  recipeId: string;
  workspaceNamespace: string;
}

export interface TerminalCapability {
  recipes: TerminalRecipeCapability[];
  network: "none" | "restricted" | "full";
  process: "none" | "recipe_only";
}

export type SideEffectClass =
  | "none"
  | "read_only"
  | "workspace_write"
  | "external_reversible"
  | "external_irreversible";

export interface CapabilityQuotaCeilings {
  maxToolInvocations: number;
  maxModelInvocations: number;
  maxWallClockMs: number;
  maxConcurrentProcesses: number;
  maxOutputBytes: number;
}

export interface CapabilityConfirmation {
  requirementId: string;
  revision: number;
  contentHash: string;
}

export interface CapabilityGrant {
  schemaVersion: typeof CAPABILITY_GRANT_SCHEMA_VERSION;
  authority: CapabilityGrantAuthority;
  subject: CapabilityGrantSubject;
  tools: CapabilityNameSet;
  skills: CapabilityNameSet;
  mcp: McpServerCapability[];
  workspaces: WorkspaceCapability[];
  credentials: CapabilityNameSet;
  terminal: TerminalCapability;
  maxSideEffectClass: SideEffectClass;
  quotas: CapabilityQuotaCeilings;
  confirmation?: CapabilityConfirmation;
  compatibility: "native_v1" | "legacy_projected";
  normalizedDigest: string;
}

export type CapabilityGrantInput = Omit<CapabilityGrant, "normalizedDigest">;

export function createCapabilityGrant(input: CapabilityGrantInput): CapabilityGrant {
  const captured = capturePlainData(input);
  assertCapabilityInputKeys(captured);
  const normalized = normalizeCapturedCapabilityGrant(captured);
  return deepFreeze({ ...normalized, normalizedDigest: digestCapabilityGrant(normalized) });
}

export function recomputeCapabilityGrantDigest(grant: CapabilityGrant): string {
  const { normalizedDigest: _ignored, ...input } = grant;
  return digestCapabilityGrant(normalizeCapabilityGrantShape(input));
}

export function normalizeCapabilityGrantShape(input: CapabilityGrantInput): CapabilityGrantInput {
  const captured = capturePlainData(input);
  assertCapabilityInputKeys(captured);
  return normalizeCapturedCapabilityGrant(captured);
}

function normalizeCapturedCapabilityGrant(input: CapabilityGrantInput): CapabilityGrantInput {
  return {
    schemaVersion: 1,
    authority: { ...input.authority },
    subject: { ...input.subject },
    tools: normalizeNameSet(input.tools),
    skills: normalizeNameSet(input.skills),
    mcp: input.mcp
      .map((server) => ({ serverId: server.serverId, tools: normalizeNameSet(server.tools) }))
      .sort((left, right) => left.serverId.localeCompare(right.serverId)),
    workspaces: input.workspaces
      .map((workspace) => ({
        namespace: workspace.namespace,
        pathSemantics: workspace.pathSemantics,
        paths: normalizeNameSet(workspace.paths),
        operations: normalizeNameSet(workspace.operations),
      }))
      .sort((left, right) => left.namespace.localeCompare(right.namespace)),
    credentials: normalizeNameSet(input.credentials),
    terminal: {
      recipes: [...input.terminal.recipes]
        .map((recipe) => ({ ...recipe }))
        .sort((left, right) => recipeKey(left).localeCompare(recipeKey(right))),
      network: input.terminal.network,
      process: input.terminal.process,
    },
    maxSideEffectClass: input.maxSideEffectClass,
    quotas: { ...input.quotas },
    ...(input.confirmation === undefined ? {} : { confirmation: { ...input.confirmation } }),
    compatibility: input.compatibility,
  };
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function digestCapabilityGrant(input: CapabilityGrantInput): string {
  return createHash("sha256").update(stableJson(input)).digest("hex");
}

function normalizeNameSet(value: CapabilityNameSet): CapabilityNameSet {
  return {
    allow: [...new Set(value.allow)].sort(),
    deny: [...new Set(value.deny)].sort(),
  };
}

function recipeKey(value: TerminalRecipeCapability): string {
  return `${value.workspaceNamespace}\u0000${value.recipeId}`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) output[key] = sortJson(entry);
    }
    return output;
  }
  return value;
}

function assertCapabilityInputKeys(input: CapabilityGrantInput): void {
  assertExactKeys(input, ["schemaVersion", "authority", "subject", "tools", "skills", "mcp", "workspaces", "credentials", "terminal", "maxSideEffectClass", "quotas", "confirmation", "compatibility"], "CapabilityGrant");
  assertExactKeys(input.authority, ["sourceKind", "sourceId", "sourceRevision", "issuedAt", "expiresAt"], "CapabilityGrant.authority");
  assertExactKeys(input.subject, ["threadId", "turnId", "requirementId", "requirementRevision", "jobId", "jobAttempt", "taskId", "taskAttempt", "runId", "contractDigest"], "CapabilityGrant.subject");
  for (const [field, set] of [["tools", input.tools], ["skills", input.skills], ["credentials", input.credentials]] as const) {
    assertExactKeys(set, ["allow", "deny"], `CapabilityGrant.${field}`);
  }
  for (const server of input.mcp) {
    assertExactKeys(server, ["serverId", "tools"], "CapabilityGrant.mcp[]");
    assertExactKeys(server.tools, ["allow", "deny"], "CapabilityGrant.mcp[].tools");
  }
  for (const workspace of input.workspaces) {
    assertExactKeys(workspace, ["namespace", "pathSemantics", "paths", "operations"], "CapabilityGrant.workspaces[]");
    assertExactKeys(workspace.paths, ["allow", "deny"], "CapabilityGrant.workspaces[].paths");
    assertExactKeys(workspace.operations, ["allow", "deny"], "CapabilityGrant.workspaces[].operations");
  }
  assertExactKeys(input.terminal, ["recipes", "network", "process"], "CapabilityGrant.terminal");
  for (const recipe of input.terminal.recipes) assertExactKeys(recipe, ["recipeId", "workspaceNamespace"], "CapabilityGrant.terminal.recipes[]");
  assertExactKeys(input.quotas, ["maxToolInvocations", "maxModelInvocations", "maxWallClockMs", "maxConcurrentProcesses", "maxOutputBytes"], "CapabilityGrant.quotas");
  if (input.confirmation !== undefined) assertExactKeys(input.confirmation, ["requirementId", "revision", "contentHash"], "CapabilityGrant.confirmation");
  if (input.schemaVersion !== 1) throw new Error("Unsupported CapabilityGrant schemaVersion");
  assertEnum(input.authority.sourceKind, ["profile", "job", "task", "workspace_policy", "user_confirmation", "intersection", "legacy"], "authority.sourceKind");
  assertEnum(input.compatibility, ["native_v1", "legacy_projected"], "compatibility");
  assertEnum(input.maxSideEffectClass, ["none", "read_only", "workspace_write", "external_reversible", "external_irreversible"], "maxSideEffectClass");
  assertEnum(input.terminal.network, ["none", "restricted", "full"], "terminal.network");
  assertEnum(input.terminal.process, ["none", "recipe_only"], "terminal.process");
  for (const workspace of input.workspaces) assertEnum(workspace.pathSemantics, ["expressed", "unexpressed"], "workspace.pathSemantics");
  if ((input.authority.sourceKind === "legacy") !== (input.compatibility === "legacy_projected")) {
    throw new Error("CapabilityGrant legacy authority and compatibility must match");
  }
}

function assertEnum(value: string, allowed: readonly string[], field: string): void {
  if (!allowed.includes(value)) throw new Error(`Invalid CapabilityGrant ${field}`);
}

function assertExactKeys(value: object, allowed: readonly string[], field: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${field} contains unknown field: ${unknown.sort().join(",")}`);
}

function capturePlainData<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (isProxy(value)) throw new Error("CapabilityGrant input cannot contain a Proxy");
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) throw new Error("CapabilityGrant input cannot contain accessors or sparse arrays");
      output.push(capturePlainData(descriptor.value));
    }
    return output as T;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("CapabilityGrant input must contain plain data objects");
  const output: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.get !== undefined || descriptor.set !== undefined) throw new Error("CapabilityGrant input cannot contain getters or setters");
    output[key] = capturePlainData(descriptor.value);
  }
  return output as T;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}
