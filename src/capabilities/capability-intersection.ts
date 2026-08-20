import { createHash } from "node:crypto";
import {
  type CapabilityConfirmation,
  type CapabilityGrant,
  type CapabilityGrantSourceKind,
  type CapabilityGrantSubject,
  type CapabilityNameSet,
  type McpServerCapability,
  type SideEffectClass,
  type TerminalRecipeCapability,
  type WorkspaceCapability,
} from "./capability-grant.js";
import { validateCapabilityGrant } from "./capability-grant-validation.js";
import { createValidatedCapabilityGrant, type ValidatedCapabilityGrant } from "./capability-grant-validation.js";

export interface CapabilityIntersectionInput {
  profile: CapabilityGrant;
  job: CapabilityGrant;
  task: CapabilityGrant;
  workspacePolicy: CapabilityGrant;
  userConfirmation: CapabilityGrant;
}

const REQUIRED_LAYERS: ReadonlyArray<[keyof CapabilityIntersectionInput, CapabilityGrantSourceKind]> = [
  ["profile", "profile"],
  ["job", "job"],
  ["task", "task"],
  ["workspacePolicy", "workspace_policy"],
  ["userConfirmation", "user_confirmation"],
];

const SIDE_EFFECT_ORDER: SideEffectClass[] = [
  "none", "read_only", "workspace_write", "external_reversible", "external_irreversible",
];

export function intersectCapabilityGrants(input: CapabilityIntersectionInput): ValidatedCapabilityGrant {
  const layers = REQUIRED_LAYERS.map(([name, expectedKind]) => {
    const layer = input[name];
    if (layer === undefined) throw new Error(`Missing mandatory CapabilityGrant layer: ${name}`);
    validateCapabilityGrant(layer);
    if (layer.compatibility !== "native_v1") throw new Error(`Capability intersection rejects non-native layer: ${name}`);
    if (layer.authority.sourceKind !== expectedKind) throw new Error(`Capability layer ${name} has the wrong authority kind`);
    return layer;
  });
  const confirmation = requireConsistentConfirmation(layers, input.userConfirmation);
  const subject = intersectSubjects(layers.map((layer) => layer.subject));
  const issuedAt = layers.map((layer) => layer.authority.issuedAt).sort().at(-1)!;
  const expiries = layers.map((layer) => layer.authority.expiresAt).filter((value): value is string => value !== undefined).sort();
  const sourceDigest = createHash("sha256").update(layers.map((layer) => layer.normalizedDigest).sort().join("\n")).digest("hex");
  return createValidatedCapabilityGrant({
    schemaVersion: 1,
    authority: {
      sourceKind: "intersection",
      sourceId: `intersection:${sourceDigest}`,
      sourceRevision: layers.map((layer) => layer.normalizedDigest).sort().join(":"),
      issuedAt,
      ...(expiries[0] === undefined ? {} : { expiresAt: expiries[0] }),
    },
    subject,
    tools: intersectNameSets(layers.map((layer) => layer.tools)),
    skills: intersectNameSets(layers.map((layer) => layer.skills)),
    mcp: intersectMcp(layers.map((layer) => layer.mcp)),
    workspaces: intersectWorkspaces(layers.map((layer) => layer.workspaces)),
    credentials: intersectNameSets(layers.map((layer) => layer.credentials), false),
    terminal: {
      recipes: intersectRecipes(layers.map((layer) => layer.terminal.recipes)),
      network: minimumByOrder(layers.map((layer) => layer.terminal.network), ["none", "restricted", "full"]),
      process: minimumByOrder(layers.map((layer) => layer.terminal.process), ["none", "recipe_only"]),
    },
    maxSideEffectClass: minimumByOrder(layers.map((layer) => layer.maxSideEffectClass), SIDE_EFFECT_ORDER),
    quotas: {
      maxToolInvocations: Math.min(...layers.map((layer) => layer.quotas.maxToolInvocations)),
      maxModelInvocations: Math.min(...layers.map((layer) => layer.quotas.maxModelInvocations)),
      maxWallClockMs: Math.min(...layers.map((layer) => layer.quotas.maxWallClockMs)),
      maxConcurrentProcesses: Math.min(...layers.map((layer) => layer.quotas.maxConcurrentProcesses)),
      maxOutputBytes: Math.min(...layers.map((layer) => layer.quotas.maxOutputBytes)),
    },
    confirmation,
    compatibility: "native_v1",
  });
}

export function intersectNameSets(sets: readonly CapabilityNameSet[], wildcard = true): CapabilityNameSet {
  if (sets.length === 0) return { allow: [], deny: ["*"] };
  const deny = [...new Set(sets.flatMap((set) => set.deny))].sort();
  if (deny.includes("*")) return { allow: [], deny };
  const explicit = sets.filter((set) => !(wildcard && set.allow.includes("*"))).map((set) => new Set(set.allow));
  let allow: string[];
  if (explicit.length === 0) allow = wildcard ? ["*"] : [];
  else allow = [...explicit[0]!].filter((name) => explicit.slice(1).every((set) => set.has(name))).sort();
  allow = allow.filter((name) => !deny.includes(name));
  return { allow, deny };
}

function intersectMcp(layers: readonly McpServerCapability[][]): McpServerCapability[] {
  if (layers.length === 0) return [];
  const serverIds = [...new Set(layers[0]!.map((server) => server.serverId))]
    .filter((serverId) => layers.slice(1).every((layer) => layer.some((server) => server.serverId === serverId)))
    .sort();
  return serverIds.map((serverId) => ({
    serverId,
    tools: intersectNameSets(layers.map((layer) => layer.find((server) => server.serverId === serverId)!.tools)),
  }));
}

function intersectWorkspaces(layers: readonly WorkspaceCapability[][]): WorkspaceCapability[] {
  if (layers.some((layer) => layer.some((workspace) => workspace.pathSemantics === "unexpressed"))) {
    throw new Error("Cannot safely intersect unexpressed workspace paths");
  }
  if (layers.length === 0) return [];
  const namespaces = [...new Set(layers[0]!.map((workspace) => workspace.namespace))]
    .filter((namespace) => layers.slice(1).every((layer) => layer.some((workspace) => workspace.namespace === namespace)))
    .sort();
  return namespaces.map((namespace) => {
    const entries = layers.map((layer) => layer.find((workspace) => workspace.namespace === namespace)!);
    return {
      namespace,
      pathSemantics: "expressed",
      paths: intersectNameSets(entries.map((entry) => entry.paths)),
      operations: intersectNameSets(entries.map((entry) => entry.operations), false),
    };
  });
}

function intersectRecipes(layers: readonly TerminalRecipeCapability[][]): TerminalRecipeCapability[] {
  if (layers.length === 0) return [];
  const key = (recipe: TerminalRecipeCapability) => `${recipe.workspaceNamespace}\u0000${recipe.recipeId}`;
  const common = new Set(layers[0]!.map(key));
  for (const layer of layers.slice(1)) {
    const current = new Set(layer.map(key));
    for (const candidate of common) if (!current.has(candidate)) common.delete(candidate);
  }
  return [...common].sort().map((value) => {
    const [workspaceNamespace, recipeId] = value.split("\u0000");
    return { workspaceNamespace: workspaceNamespace!, recipeId: recipeId! };
  });
}

function intersectSubjects(subjects: readonly CapabilityGrantSubject[]): CapabilityGrantSubject {
  const fields = ["threadId", "turnId", "requirementId", "requirementRevision", "jobId", "jobAttempt", "taskId", "taskAttempt", "runId", "contractDigest"] as const;
  const output: Record<string, string | number> = {};
  for (const field of fields) {
    const values = [...new Set(subjects.map((subject) => subject[field]).filter((value): value is string | number => value !== undefined))];
    if (values.length > 1) throw new Error(`Capability layers belong to different ${field} values`);
    if (values[0] !== undefined) output[field] = values[0];
  }
  if (output.threadId === undefined) throw new Error("Capability intersection requires a Thread subject");
  return output as unknown as CapabilityGrantSubject;
}

function requireConsistentConfirmation(layers: readonly CapabilityGrant[], userLayer: CapabilityGrant): CapabilityConfirmation {
  if (userLayer.confirmation === undefined) throw new Error("User confirmation layer lacks a confirmed revision and hash");
  const expected = JSON.stringify(userLayer.confirmation);
  for (const confirmation of layers.map((layer) => layer.confirmation).filter((value): value is CapabilityConfirmation => value !== undefined)) {
    if (JSON.stringify(confirmation) !== expected) throw new Error("Capability layers bind different user confirmations");
  }
  return { ...userLayer.confirmation };
}

function minimumByOrder<T extends string>(values: readonly T[], order: readonly T[]): T {
  return values.reduce((minimum, current) => order.indexOf(current) < order.indexOf(minimum) ? current : minimum);
}
