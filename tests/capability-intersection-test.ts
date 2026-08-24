import assert from "node:assert/strict";
import test from "node:test";
import { createCapabilityGrant, type CapabilityGrant, type CapabilityGrantInput, type CapabilityGrantSourceKind } from "../src/capabilities/capability-grant.js";
import { intersectCapabilityGrants, type CapabilityIntersectionInput } from "../src/capabilities/capability-intersection.js";

const HASH = "b".repeat(64);

test("five-layer Capability intersection is deny-first and takes conservative ceilings", () => {
  const input = layers();
  const result = intersectCapabilityGrants(input);
  assert.deepEqual(result.tools, { allow: ["read_file"], deny: ["run_command", "write_file"] });
  assert.deepEqual(result.skills.allow, ["research"]);
  assert.deepEqual(result.credentials.allow, ["credential:read"]);
  assert.deepEqual(result.mcp, [{ serverId: "docs", tools: { allow: ["search"], deny: ["write"] } }]);
  assert.deepEqual(result.workspaces[0]?.paths.allow, ["src"]);
  assert.deepEqual(result.workspaces[0]?.operations.allow, ["read"]);
  assert.deepEqual(result.terminal.recipes, [{ recipeId: "test", workspaceNamespace: "workspace" }]);
  assert.equal(result.terminal.network, "none");
  assert.equal(result.maxSideEffectClass, "read_only");
  assert.equal(result.quotas.maxToolInvocations, 3);
  assert.equal(result.quotas.maxConcurrentProcesses, 1);
  assert.equal(result.subject.contractDigest, HASH);
  assert.equal(result.subject.requirementRevision, 1);
  assert.equal(result.subject.jobAttempt, 1);
  assert.equal(result.subject.taskAttempt, 1);
});

test("Capability intersection is commutative in effective content and rejects a missing confirmation", () => {
  const input = layers();
  const permuted = {
    profile: cloneAs(input.task, "profile"),
    job: cloneAs(input.workspacePolicy, "job"),
    task: cloneAs(input.profile, "task"),
    workspacePolicy: cloneAs(input.job, "workspace_policy"),
    userConfirmation: input.userConfirmation,
  } satisfies CapabilityIntersectionInput;
  const left = intersectCapabilityGrants(input);
  const right = intersectCapabilityGrants(permuted);
  assert.deepEqual(stripAuthority(left), stripAuthority(right));

  const { confirmation: _confirmation, ...withoutConfirmation } = withoutDigest(input.userConfirmation);
  const noConfirmation = createCapabilityGrant(withoutConfirmation);
  assert.throws(() => intersectCapabilityGrants({ ...input, userConfirmation: noConfirmation }), /lacks a confirmed revision/);

  const conflictingTask = cloneWithSubject(input.task, { ...input.task.subject, contractDigest: "c".repeat(64) });
  assert.throws(() => intersectCapabilityGrants({ ...input, task: conflictingTask }), /different contractDigest/);

  const withoutTurn = mapSubjects(input, (subject) => {
    const { turnId: _turnId, ...rest } = subject;
    return rest;
  });
  assert.throws(() => intersectCapabilityGrants(withoutTurn), /requires complete Thread\/Turn\/Requirement\/Job\/Task\/Run\/Contract/);
});

function layers(): CapabilityIntersectionInput {
  return {
    profile: grant("profile", { tools: set(["*"]), skills: set(["*"]), maxSideEffectClass: "external_reversible" }),
    job: grant("job", { tools: set(["read_file", "write_file", "run_command"], ["run_command"]), skills: set(["research", "coding"]), quotas: quotas(8, 2) }),
    task: grant("task", { tools: set(["read_file", "write_file"], ["write_file"]), skills: set(["research"]), maxSideEffectClass: "workspace_write", quotas: quotas(5, 1) }),
    workspacePolicy: grant("workspace_policy", { tools: set(["read_file", "write_file"]), skills: set(["*"]), terminal: terminal("none"), maxSideEffectClass: "read_only" }),
    userConfirmation: grant("user_confirmation", { tools: set(["read_file", "write_file"]), skills: set(["research"]), quotas: quotas(3, 2) }),
  };
}

function grant(sourceKind: CapabilityGrantSourceKind, overrides: Partial<CapabilityGrantInput>): CapabilityGrant {
  return createCapabilityGrant({
    schemaVersion: 1,
    authority: { sourceKind, sourceId: `${sourceKind}:1`, sourceRevision: "1", issuedAt: "2026-08-20T00:00:00.000Z" },
    subject: { threadId: "thread-1", turnId: "turn-1", requirementId: "req-1", requirementRevision: 1,
      jobId: "job-1", jobAttempt: 1, taskId: "task-1", taskAttempt: 1, runId: "run-1", contractDigest: HASH },
    tools: set(["*"]), skills: set(["*"]),
    mcp: [{ serverId: "docs", tools: set(["search", "write"], ["write"]) }],
    workspaces: [{ namespace: "workspace", pathSemantics: "expressed", paths: set(["src"]), operations: set(["read"]) }],
    credentials: set(["credential:read"]),
    terminal: terminal("restricted"),
    maxSideEffectClass: "external_reversible",
    quotas: quotas(10, 3),
    confirmation: { requirementId: "req-1", revision: 1, contentHash: HASH },
    compatibility: "native_v1",
    ...overrides,
  });
}

function set(allow: string[], deny: string[] = []) { return { allow, deny }; }
function quotas(maxToolInvocations: number, maxConcurrentProcesses: number) {
  return { maxToolInvocations, maxModelInvocations: 10, maxWallClockMs: 60_000, maxConcurrentProcesses, maxOutputBytes: 1_000_000 };
}
function terminal(network: "none" | "restricted" | "full") {
  return { recipes: [{ recipeId: "test", workspaceNamespace: "workspace" }], network, process: "recipe_only" as const };
}
function withoutDigest(grant: CapabilityGrant): CapabilityGrantInput {
  const { normalizedDigest: _ignored, ...input } = grant;
  return input;
}
function cloneAs(grant: CapabilityGrant, sourceKind: CapabilityGrantSourceKind): CapabilityGrant {
  return createCapabilityGrant({ ...withoutDigest(grant), authority: { ...grant.authority, sourceKind, sourceId: `${sourceKind}:permuted` } });
}
function cloneWithSubject(grant: CapabilityGrant, subject: CapabilityGrant["subject"]): CapabilityGrant {
  return createCapabilityGrant({ ...withoutDigest(grant), subject });
}
function stripAuthority(grant: CapabilityGrant): unknown {
  const { authority: _authority, normalizedDigest: _digest, ...effective } = grant;
  return effective;
}
function mapSubjects(input: CapabilityIntersectionInput, map: (subject: CapabilityGrant["subject"]) => CapabilityGrant["subject"]): CapabilityIntersectionInput {
  return {
    profile: cloneWithSubject(input.profile, map(input.profile.subject)),
    job: cloneWithSubject(input.job, map(input.job.subject)),
    task: cloneWithSubject(input.task, map(input.task.subject)),
    workspacePolicy: cloneWithSubject(input.workspacePolicy, map(input.workspacePolicy.subject)),
    userConfirmation: cloneWithSubject(input.userConfirmation, map(input.userConfirmation.subject)),
  };
}
