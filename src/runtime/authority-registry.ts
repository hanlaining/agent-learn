export const AUTHORITY_KINDS = [
  "thread",
  "turn",
  "item",
  "requirement",
  "job",
  "task",
  "task_edge",
  "evidence",
  "shared_board",
  "return",
  "stage_checkpoint",
  "dynamic_execution",
  "agent_run",
  "model_invocation",
  "tool_invocation",
  "context_checkpoint",
  "runtime_lease",
  "completion_proof",
] as const;

export type AuthorityKind = typeof AUTHORITY_KINDS[number];

export const AUTHORITATIVE_STORES = [
  "LifecycleStore",
  "RequirementStore",
  "AgentRuntimeStore",
  "AgentRunStore",
  "ModelInvocationStore",
  "ToolInvocationStore",
  "ContextCheckpointStore",
  "PersistentRuntimeLeaseStore",
  "unimplemented",
] as const;

export type AuthoritativeStore = typeof AUTHORITATIVE_STORES[number];
export type AuthorityWriter = Exclude<AuthoritativeStore, "unimplemented">;

export type AuthorityPersistenceDomain =
  | "global_snapshot"
  | "lease_file"
  | "future_job_partition"
  | "none";

export interface AuthorityRegistration {
  readonly kind: AuthorityKind;
  readonly authoritativeStore: AuthoritativeStore;
  readonly persistenceDomain: AuthorityPersistenceDomain;
  readonly permittedWriters: readonly string[];
  readonly projections: readonly string[];
  readonly recoverySource: string;
  readonly terminalAuthority: boolean;
  readonly implementationStatus: "active" | "unimplemented";
}

const PROJECTION_ONLY_NAMES = new Set([
  "AgentEvent",
  "ElectronReducer",
  "runtimeSessions",
]);

const RAW_AUTHORITY_REGISTRY: readonly AuthorityRegistration[] = [
  registration("thread", "LifecycleStore", "global_snapshot", ["LifecycleStore"], ["AgentEvent", "runtimeSessions", "ElectronReducer"], "LifecycleSnapshot", true),
  registration("turn", "LifecycleStore", "global_snapshot", ["LifecycleStore"], ["AgentEvent", "runtimeSessions", "ElectronReducer"], "LifecycleSnapshot", true),
  registration("item", "LifecycleStore", "global_snapshot", ["LifecycleStore"], ["AgentEvent", "runtimeSessions", "ElectronReducer"], "LifecycleSnapshot", false),
  registration("requirement", "RequirementStore", "global_snapshot", ["RequirementStore"], ["runtimeSessions", "ElectronReducer"], "RequirementSnapshot", true),
  registration("job", "AgentRuntimeStore", "global_snapshot", ["AgentRuntimeStore"], ["runtimeSessions", "ElectronReducer"], "AgentRuntimeSnapshot", true),
  registration("task", "AgentRuntimeStore", "global_snapshot", ["AgentRuntimeStore"], ["runtimeSessions", "ElectronReducer"], "AgentRuntimeSnapshot", true),
  registration("task_edge", "AgentRuntimeStore", "global_snapshot", ["AgentRuntimeStore"], ["runtimeSessions", "ElectronReducer"], "AgentRuntimeSnapshot", false),
  registration("evidence", "AgentRuntimeStore", "global_snapshot", ["AgentRuntimeStore"], ["runtimeSessions", "ElectronReducer"], "AgentRuntimeSnapshot", false),
  registration("shared_board", "AgentRuntimeStore", "global_snapshot", ["AgentRuntimeStore"], ["runtimeSessions", "ElectronReducer"], "AgentRuntimeSnapshot", false),
  registration("return", "AgentRuntimeStore", "global_snapshot", ["AgentRuntimeStore"], ["runtimeSessions", "ElectronReducer"], "AgentRuntimeSnapshot", true),
  registration("stage_checkpoint", "AgentRuntimeStore", "global_snapshot", ["AgentRuntimeStore"], ["runtimeSessions", "ElectronReducer"], "AgentRuntimeSnapshot", true),
  registration("dynamic_execution", "AgentRuntimeStore", "global_snapshot", ["AgentRuntimeStore"], ["runtimeSessions", "ElectronReducer"], "AgentRuntimeSnapshot", true),
  registration("agent_run", "AgentRunStore", "global_snapshot", ["AgentRunStore"], ["AgentEvent", "runtimeSessions", "ElectronReducer"], "AgentRunSnapshot", true),
  registration("model_invocation", "ModelInvocationStore", "global_snapshot", ["ModelInvocationStore"], ["AgentEvent", "runtimeSessions", "ElectronReducer"], "ModelInvocationSnapshot", true),
  registration("tool_invocation", "ToolInvocationStore", "global_snapshot", ["ToolInvocationStore"], ["AgentEvent", "runtimeSessions", "ElectronReducer"], "ToolInvocationSnapshot", true),
  registration("context_checkpoint", "ContextCheckpointStore", "global_snapshot", ["ContextCheckpointStore"], ["runtimeSessions"], "ContextCheckpointSnapshot", false),
  registration("runtime_lease", "PersistentRuntimeLeaseStore", "lease_file", ["PersistentRuntimeLeaseStore"], ["runtimeSessions", "ElectronReducer"], "PersistentRuntimeLeaseFile", true),
  Object.freeze({
    kind: "completion_proof",
    authoritativeStore: "unimplemented",
    persistenceDomain: "none",
    permittedWriters: Object.freeze([]),
    projections: Object.freeze([]),
    recoverySource: "unimplemented",
    terminalAuthority: false,
    implementationStatus: "unimplemented",
  }),
];

export const AUTHORITY_REGISTRY = createAuthorityRegistry(RAW_AUTHORITY_REGISTRY);

const AUTHORITY_BY_KIND = new Map(
  AUTHORITY_REGISTRY.map((entry) => [entry.kind, entry] as const),
);

export function getAuthorityRegistration(
  kind: AuthorityKind,
): AuthorityRegistration {
  const entry = AUTHORITY_BY_KIND.get(kind);
  if (entry === undefined) throw new Error(`Authority is not registered: ${kind}`);
  return entry;
}

export function assertAuthorityRegistry(
  registrations: readonly AuthorityRegistration[],
): void {
  const seen = new Set<AuthorityKind>();
  for (const entry of registrations) {
    if (!AUTHORITY_KINDS.includes(entry.kind)) {
      throw new Error(`Invalid authority kind: ${String(entry.kind)}`);
    }
    if (seen.has(entry.kind)) {
      throw new Error(`Duplicate authority registration: ${entry.kind}`);
    }
    seen.add(entry.kind);
    if (!AUTHORITATIVE_STORES.includes(entry.authoritativeStore)) {
      throw new Error(`Invalid authoritative store: ${String(entry.authoritativeStore)}`);
    }
    const isProof = entry.kind === "completion_proof";
    assertNonEmptyStrings(entry.permittedWriters, `writers for ${entry.kind}`, isProof);
    assertNonEmptyStrings(entry.projections, `projections for ${entry.kind}`, true);
    for (const writer of entry.permittedWriters) {
      if (PROJECTION_ONLY_NAMES.has(writer)) {
        throw new Error(`Projection cannot write authority: ${entry.kind}`);
      }
      if (!AUTHORITATIVE_STORES.includes(writer as AuthoritativeStore) || writer === "unimplemented") {
        throw new Error(`Unknown authority writer for ${entry.kind}: ${writer}`);
      }
      if (writer !== entry.authoritativeStore) {
        throw new Error(`Authority writer does not own ${entry.kind}: ${writer}`);
      }
    }
    if (entry.recoverySource.trim().length === 0) {
      throw new Error(`Authority recovery source is empty: ${entry.kind}`);
    }
    if (isProof !== (entry.implementationStatus === "unimplemented") ||
        isProof !== (entry.authoritativeStore === "unimplemented")) {
      throw new Error("Completion Proof must remain explicitly unimplemented in W0");
    }
    if (isProof && (entry.persistenceDomain !== "none" || entry.permittedWriters.length > 0)) {
      throw new Error("Unimplemented Completion Proof cannot have persistence or writers");
    }
  }
  const missing = AUTHORITY_KINDS.filter((kind) => !seen.has(kind));
  if (missing.length > 0) {
    throw new Error(`Missing authority registrations: ${missing.join(", ")}`);
  }
}

export function createAuthorityRegistry(
  registrations: readonly AuthorityRegistration[],
): readonly AuthorityRegistration[] {
  assertAuthorityRegistry(registrations);
  return Object.freeze(registrations.map((entry) => Object.freeze({
    ...entry,
    permittedWriters: Object.freeze([...entry.permittedWriters]),
    projections: Object.freeze([...entry.projections]),
  })));
}

export function assertAuthorityWriteAllowed(
  kind: AuthorityKind,
  writer: string,
): asserts writer is AuthorityWriter {
  if (!AUTHORITATIVE_STORES.includes(writer as AuthoritativeStore) || writer === "unimplemented") {
    throw new Error(`Unknown authority writer: ${writer}`);
  }
  const registration = getAuthorityRegistration(kind);
  if (registration.implementationStatus !== "active" ||
      registration.authoritativeStore === "unimplemented") {
    throw new Error(`Authority writes are unavailable: ${kind}`);
  }
  if (writer !== registration.authoritativeStore ||
      !registration.permittedWriters.includes(writer)) {
    throw new Error(`Authority writer is not allowed for ${kind}: ${writer}`);
  }
}

function registration(
  kind: AuthorityKind,
  authoritativeStore: Exclude<AuthoritativeStore, "unimplemented">,
  persistenceDomain: Exclude<AuthorityPersistenceDomain, "none">,
  permittedWriters: readonly string[],
  projections: readonly string[],
  recoverySource: string,
  terminalAuthority: boolean,
): AuthorityRegistration {
  return Object.freeze({
    kind,
    authoritativeStore,
    persistenceDomain,
    permittedWriters: Object.freeze([...permittedWriters]),
    projections: Object.freeze([...projections]),
    recoverySource,
    terminalAuthority,
    implementationStatus: "active",
  });
}

function assertNonEmptyStrings(
  values: readonly string[],
  label: string,
  allowEmpty: boolean,
): void {
  if ((!allowEmpty && values.length === 0) ||
      values.some((value) => typeof value !== "string" || value.trim().length === 0) ||
      new Set(values).size !== values.length) {
    throw new Error(`Invalid ${label}`);
  }
}
