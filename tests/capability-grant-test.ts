import assert from "node:assert/strict";
import test from "node:test";
import { createCapabilityGrant, recomputeCapabilityGrantDigest, type CapabilityGrantInput } from "../src/capabilities/capability-grant.js";
import { validateCapabilityGrant } from "../src/capabilities/capability-grant-validation.js";

const HASH = "a".repeat(64);

test("CapabilityGrant v1 normalizes unordered sets and binds a stable digest", () => {
  const left = createCapabilityGrant(baseGrant({ tools: { allow: ["write_file", "read_file", "read_file"], deny: ["run_agent"] } }));
  const right = createCapabilityGrant(baseGrant({ tools: { allow: ["read_file", "write_file"], deny: ["run_agent"] } }));
  validateCapabilityGrant(left);
  validateCapabilityGrant(right);
  assert.deepEqual(left.tools.allow, ["read_file", "write_file"]);
  assert.equal(left.normalizedDigest, right.normalizedDigest);
  assert.equal(left.normalizedDigest, recomputeCapabilityGrantDigest(left));
});

test("CapabilityGrant rejects partial wildcards, unsafe paths and digest tampering", () => {
  const partialWildcard = createCapabilityGrant(baseGrant({ tools: { allow: ["read_*"], deny: [] } }));
  assert.throws(() => validateCapabilityGrant(partialWildcard), /complete.*wildcard/);

  const unsafePath = createCapabilityGrant(baseGrant({ workspaces: [{
    namespace: "workspace", pathSemantics: "expressed",
    paths: { allow: ["../secret"], deny: [] }, operations: { allow: ["read"], deny: [] },
  }] }));
  assert.throws(() => validateCapabilityGrant(unsafePath), /Unsafe workspace path/);

  const valid = createCapabilityGrant(baseGrant());
  const tampered = { ...valid, quotas: { ...valid.quotas, maxToolInvocations: 999 } };
  assert.throws(() => validateCapabilityGrant(tampered), /frozen stable snapshot|normalizedDigest/);

  const expired = createCapabilityGrant(baseGrant({ authority: { sourceKind: "task", sourceId: "task:t1", sourceRevision: "1",
    issuedAt: "2026-08-20T00:00:01.000Z", expiresAt: "2026-08-20T00:00:00.000Z" } }));
  assert.throws(() => validateCapabilityGrant(expired), /expiresAt/);
  const badQuota = createCapabilityGrant(baseGrant({ quotas: { maxToolInvocations: -1, maxModelInvocations: 1, maxWallClockMs: 1, maxConcurrentProcesses: 1, maxOutputBytes: 1 } }));
  assert.throws(() => validateCapabilityGrant(badQuota), /quotas.maxToolInvocations/);
});

test("CapabilityGrant rejects unknown fields and freezes a stable clone", () => {
  const input = baseGrant();
  const originalAllow = input.tools.allow;
  const grant = createCapabilityGrant(input);
  originalAllow.push("late_tool");
  assert.deepEqual(grant.tools.allow, ["*"]);
  assert.equal(Object.isFrozen(grant.tools.allow), true);
  assert.throws(() => validateCapabilityGrant(new Proxy(grant, {})), /Proxy/);
  assert.throws(() => createCapabilityGrant({ ...baseGrant(), unexpected: true } as CapabilityGrantInput), /unknown field/);

  const getterInput = baseGrant();
  Object.defineProperty(getterInput, "tools", { enumerable: true, get: () => ({ allow: ["*"], deny: [] }) });
  assert.throws(() => createCapabilityGrant(getterInput), /getters or setters/);

  assert.throws(() => createCapabilityGrant(baseGrant({ authority: { sourceKind: "owner" as "task", sourceId: "bad", sourceRevision: "1", issuedAt: "2026-08-20T00:00:00.000Z" } })), /sourceKind/);
  assert.throws(() => createCapabilityGrant(baseGrant({ maxSideEffectClass: "superuser" as "none" })), /maxSideEffectClass/);
  assert.throws(() => createCapabilityGrant({ ...baseGrant(), schemaVersion: 2 as 1 }), /schemaVersion/);
  assert.throws(() => createCapabilityGrant(baseGrant({ terminal: { recipes: [], network: "internet" as "none", process: "recipe_only" } })), /terminal.network/);

  const { contractDigest: _contractDigest, ...subjectWithoutContract } = baseGrant().subject;
  const taskWithoutContract = createCapabilityGrant(baseGrant({ subject: subjectWithoutContract }));
  assert.throws(() => validateCapabilityGrant(taskWithoutContract), /require subject.contractDigest/);

  const { requirementId: _requirementId, requirementRevision: _requirementRevision, ...subjectWithoutRequirement } = baseGrant().subject;
  assert.throws(() => validateCapabilityGrant(createCapabilityGrant(baseGrant({ subject: subjectWithoutRequirement }))), /must exactly match/);
  assert.throws(() => validateCapabilityGrant(createCapabilityGrant(baseGrant({ confirmation: { requirementId: "req-other", revision: 1, contentHash: HASH } }))), /must exactly match/);
  assert.throws(() => validateCapabilityGrant(createCapabilityGrant(baseGrant({ confirmation: { requirementId: "req-1", revision: 2, contentHash: HASH } }))), /must exactly match/);
});

function baseGrant(overrides: Partial<CapabilityGrantInput> = {}): CapabilityGrantInput {
  return {
    schemaVersion: 1,
    authority: { sourceKind: "task", sourceId: "task:t1", sourceRevision: "1", issuedAt: "2026-08-20T00:00:00.000Z" },
    subject: { threadId: "thread-1", turnId: "turn-1", requirementId: "req-1", requirementRevision: 1,
      jobId: "job-1", jobAttempt: 1, taskId: "task-1", taskAttempt: 1, runId: "run-1", contractDigest: HASH },
    tools: { allow: ["*"], deny: [] },
    skills: { allow: ["*"], deny: [] },
    mcp: [{ serverId: "docs", tools: { allow: ["search"], deny: [] } }],
    workspaces: [{ namespace: "workspace", pathSemantics: "expressed", paths: { allow: ["*"], deny: [] }, operations: { allow: ["read", "write"], deny: [] } }],
    credentials: { allow: ["credential:provider"], deny: [] },
    terminal: { recipes: [{ recipeId: "test", workspaceNamespace: "workspace" }], network: "restricted", process: "recipe_only" },
    maxSideEffectClass: "workspace_write",
    quotas: { maxToolInvocations: 20, maxModelInvocations: 10, maxWallClockMs: 60_000, maxConcurrentProcesses: 2, maxOutputBytes: 1_000_000 },
    confirmation: { requirementId: "req-1", revision: 1, contentHash: HASH },
    compatibility: "native_v1",
    ...overrides,
  };
}
