import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTHORITY_KINDS,
  AUTHORITY_REGISTRY,
  assertAuthorityRegistry,
  assertAuthorityWriteAllowed,
  createAuthorityRegistry,
  getAuthorityRegistration,
  type AuthorityRegistration,
} from "../src/runtime/authority-registry.js";

test("C01 默认 Registry 完整、唯一并映射到现有权威 Store", () => {
  assert.equal(AUTHORITY_REGISTRY.length, AUTHORITY_KINDS.length);
  assert.equal(new Set(AUTHORITY_REGISTRY.map((entry) => entry.kind)).size, AUTHORITY_KINDS.length);
  assert.equal(getAuthorityRegistration("thread").authoritativeStore, "LifecycleStore");
  assert.equal(getAuthorityRegistration("requirement").authoritativeStore, "RequirementStore");
  assert.equal(getAuthorityRegistration("job").authoritativeStore, "AgentRuntimeStore");
  assert.equal(getAuthorityRegistration("agent_run").authoritativeStore, "AgentRunStore");
  assert.equal(getAuthorityRegistration("runtime_lease").authoritativeStore, "PersistentRuntimeLeaseStore");
});

test("C01 Registry 拒绝同一实体种类存在两个 Authority", () => {
  assert.throws(
    () => assertAuthorityRegistry([...AUTHORITY_REGISTRY, AUTHORITY_REGISTRY[0]!]),
    /Duplicate authority registration/,
  );
});

test("C01 Registry 拒绝缺失任一 Authority kind", () => {
  assert.throws(
    () => assertAuthorityRegistry(AUTHORITY_REGISTRY.filter((entry) => entry.kind !== "tool_invocation")),
    /Missing authority registrations: tool_invocation/,
  );
});

test("C01 UI Projection 不能注册为权威写入者", () => {
  const invalid = AUTHORITY_REGISTRY.map((entry) => entry.kind === "job"
    ? { ...entry, permittedWriters: ["runtimeSessions"] }
    : entry) as readonly AuthorityRegistration[];
  assert.throws(() => assertAuthorityRegistry(invalid), /Projection cannot write authority: job/);
  const noWriter = AUTHORITY_REGISTRY.map((entry) => entry.kind === "job"
    ? { ...entry, permittedWriters: [] }
    : entry) as readonly AuthorityRegistration[];
  assert.throws(() => assertAuthorityRegistry(noWriter), /Invalid writers for job/);
  const wrongKnownWriter = AUTHORITY_REGISTRY.map((entry) => entry.kind === "job"
    ? { ...entry, permittedWriters: ["LifecycleStore"] }
    : entry) as readonly AuthorityRegistration[];
  assert.throws(() => assertAuthorityRegistry(wrongKnownWriter), /does not own job/);
});

test("C01 Completion Proof 显式未实现且 Registry 不持有 Store 实例", () => {
  const proof = getAuthorityRegistration("completion_proof");
  assert.deepEqual(proof, {
    kind: "completion_proof",
    authoritativeStore: "unimplemented",
    persistenceDomain: "none",
    permittedWriters: [],
    projections: [],
    recoverySource: "unimplemented",
    terminalAuthority: false,
    implementationStatus: "unimplemented",
  });
  for (const entry of AUTHORITY_REGISTRY) {
    assert.equal("store" in entry, false);
    assert.equal(Object.isFrozen(entry), true);
    assert.equal(Object.isFrozen(entry.permittedWriters), true);
    assert.equal(Object.isFrozen(entry.projections), true);
  }
});

test("C01 fail-closed 写权限只允许该 kind 的唯一权威 Store", () => {
  assert.doesNotThrow(() => assertAuthorityWriteAllowed("job", "AgentRuntimeStore"));
  assert.throws(() => assertAuthorityWriteAllowed("job", "LifecycleStore"), /not allowed for job/);
  assert.throws(() => assertAuthorityWriteAllowed("job", "runtimeSessions"), /Unknown authority writer/);
  assert.throws(() => assertAuthorityWriteAllowed("completion_proof", "AgentRuntimeStore"), /writes are unavailable/);
});

test("C01 createAuthorityRegistry 返回不受输入后续 mutation 影响的深冻结稳定副本", () => {
  const mutable = AUTHORITY_REGISTRY.map((entry) => ({
    ...entry,
    permittedWriters: [...entry.permittedWriters],
    projections: [...entry.projections],
  }));
  const stable = createAuthorityRegistry(mutable);
  mutable[0]!.permittedWriters.push("LifecycleStore");
  mutable[0]!.projections.push("later-projection");
  assert.deepEqual(stable[0]!.permittedWriters, ["LifecycleStore"]);
  assert.equal(stable[0]!.projections.includes("later-projection"), false);
  assert.equal(Object.isFrozen(stable), true);
  assert.equal(Object.isFrozen(stable[0]), true);
  assert.equal(Object.isFrozen(stable[0]!.permittedWriters), true);
});
