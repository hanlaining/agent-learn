import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { OutcomeUnknownResolutionStore } from "../src/runtime/outcome-unknown-resolution-store.js";
import {
  OutcomeUnknownResolutionError,
  type RegisterOutcomeUnknownInput,
} from "../src/runtime/outcome-unknown-resolution.js";
import { PersistentRuntimeLeaseStore } from "../src/runtime/persistent-runtime-lease-store.js";
import { RuntimeLeaseConflictError } from "../src/runtime/runtime-lease.js";

const NOW = "2026-08-24T09:00:00.000Z";
const DIGEST = `sha256:${"a".repeat(64)}`;

function registration(overrides: Partial<RegisterOutcomeUnknownInput> = {}): RegisterOutcomeUnknownInput {
  return {
    invocationKind: "model",
    invocationId: "model-recovery-1",
    requestDigest: DIGEST,
    identity: {
      threadId: "thread-recovery",
      turnId: "turn-recovery",
      displayName: "恢复模型调用",
      provider: "offline",
      model: "deterministic",
    },
    sideEffectRisk: "none",
    unknownReasonCode: "connection_lost_after_dispatch",
    ...overrides,
  };
}

function hasOutcomeCode(code: OutcomeUnknownResolutionError["code"]) {
  return (error: unknown) => error instanceof OutcomeUnknownResolutionError && error.code === code;
}

function hasLeaseCode(code: RuntimeLeaseConflictError["code"]) {
  return (error: unknown) => error instanceof RuntimeLeaseConflictError && error.code === code;
}

test("PersistentRuntimeLeaseStore 对参数、CAS 与伪造 Lease 全部 fail closed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "god-hotpaths5-lease-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, "leases.json");
  const resource = { type: "job", id: "job-recovery" } as const;
  assert.throws(() => new PersistentRuntimeLeaseStore(" "), /must not be empty/);

  const store = new PersistentRuntimeLeaseStore(statePath, { now: () => NOW });
  await assert.rejects(store.acquire({ resource, ownerId: "", ttlMs: 100 }), /ownerId/);
  await assert.rejects(store.acquire({ resource, ownerId: "owner-a", ttlMs: 0 }), /positive safe integer/);
  await assert.rejects(
    store.acquire({ resource, ownerId: "owner-a", ttlMs: 100, expectedLeaseVersion: -1 }),
    /non-negative safe integer/,
  );
  await assert.rejects(
    store.acquire({ resource, ownerId: "owner-a", ttlMs: 100, expectedLeaseVersion: 1 }),
    hasLeaseCode("lease_version_mismatch"),
  );

  const lease = await store.acquire({ resource, ownerId: "owner-a", ttlMs: 100 });
  await assert.rejects(store.assertHeld({ ...lease, ownerId: "owner-b" }), hasLeaseCode("owner_mismatch"));
  await assert.rejects(store.assertHeld({ ...lease, fencingToken: lease.fencingToken + 1 }), hasLeaseCode("fencing_token_mismatch"));
  await assert.rejects(store.assertHeld({ ...lease, leaseVersion: lease.leaseVersion + 1 }), hasLeaseCode("lease_version_mismatch"));
  const releasedVersion = await store.release(lease);
  assert.equal(releasedVersion, lease.leaseVersion + 1);
  await assert.rejects(store.assertHeld(lease), hasLeaseCode("lease_not_active"));

  const invalidClock = new PersistentRuntimeLeaseStore(join(directory, "invalid-clock.json"), {
    now: () => "not-a-time",
  });
  await assert.rejects(
    invalidClock.acquire({ resource: { type: "turn", id: "turn-1" }, ownerId: "owner", ttlMs: 1 }),
    /invalid timestamp/,
  );
});

test("PersistentRuntimeLeaseStore 拒绝损坏、重复或半写入状态", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "god-hotpaths5-lease-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, "leases.json");
  const store = new PersistentRuntimeLeaseStore(statePath, { now: () => NOW });
  const resource = { type: "job", id: "job-state" } as const;

  for (const state of [
    null,
    { version: 2, entries: [] },
    { version: 1, entries: [null] },
    { version: 1, entries: [{ resourceType: "job", resourceId: "job-state", leaseVersion: -1, fencingToken: 1, updatedAt: NOW }] },
    { version: 1, entries: [{ resourceType: "job", resourceId: "job-state", leaseVersion: 1, fencingToken: 1, ownerId: "owner", updatedAt: NOW }] },
    { version: 1, entries: [{ resourceType: "job", resourceId: "job-state", leaseVersion: 1, fencingToken: 1, ownerId: "", expiresAt: NOW, updatedAt: NOW }] },
    { version: 1, entries: [
      { resourceType: "job", resourceId: "job-state", leaseVersion: 1, fencingToken: 1, updatedAt: NOW },
      { resourceType: "job", resourceId: "job-state", leaseVersion: 2, fencingToken: 2, updatedAt: NOW },
    ] },
  ]) {
    await writeFile(statePath, JSON.stringify(state), "utf8");
    await assert.rejects(store.read(resource), /Invalid Runtime lease/);
  }
});

test("OutcomeUnknownResolutionStore 拒绝非法注册和不可变事实漂移", async () => {
  assert.throws(
    () => new OutcomeUnknownResolutionStore({ initialSnapshot: { version: 2, records: [] } as never }),
    /Invalid outcome-unknown resolution snapshot/,
  );
  const store = new OutcomeUnknownResolutionStore({ now: () => NOW, createId: (prefix) => `${prefix}-fixed` });
  for (const invalid of [
    registration({ invocationKind: "remote" as never }),
    registration({ sideEffectRisk: "unbounded" as never }),
    registration({ invocationId: "" }),
    registration({ requestDigest: "sha256:bad" }),
    registration({ identity: { ...registration().identity, threadId: "" } }),
    registration({ identity: { ...registration().identity, provider: 1 as never } }),
    registration({ invocationKind: "tool", identity: { ...registration().identity, toolName: "" } }),
  ]) {
    await assert.rejects(store.register(invalid), hasOutcomeCode("INVALID_INPUT"));
  }

  const first = await store.register(registration());
  assert.equal((await store.register(registration())).resolutionId, first.resolutionId);
  await assert.rejects(
    store.register(registration({ requestDigest: `sha256:${"b".repeat(64)}` })),
    hasOutcomeCode("INVALID_INPUT"),
  );
  assert.equal(store.exportSnapshot().records.length, 1);
});

test("OutcomeUnknownResolutionStore 对处置输入、幂等键和外部 JSON 保守拒绝", async () => {
  const store = new OutcomeUnknownResolutionStore({ now: () => NOW, createId: (prefix) => `${prefix}-1` });
  const record = await store.register(registration());
  const base = {
    resolutionId: record.resolutionId,
    expectedVersion: 1,
    idempotencyKey: "decision-1",
    resolution: { action: "mark_manual_required" as const, reason: "人工复核" },
  };
  await assert.rejects(store.resolve({ ...base, resolutionId: "missing" }, "operator"), hasOutcomeCode("NOT_FOUND"));
  await assert.rejects(store.resolve({ ...base, expectedVersion: 0 }, "operator"), hasOutcomeCode("INVALID_INPUT"));
  await assert.rejects(store.resolve({ ...base, idempotencyKey: "" }, "operator"), hasOutcomeCode("INVALID_INPUT"));
  await assert.rejects(store.resolve(base, ""), hasOutcomeCode("INVALID_INPUT"));

  const manual = await store.resolve(base, "operator");
  assert.equal(manual.state, "manual_required");
  await assert.rejects(
    store.resolve({ ...base, expectedVersion: manual.version, idempotencyKey: "decision-2" }, "operator"),
    hasOutcomeCode("INVALID_STATE"),
  );
  await assert.rejects(
    store.resolve({ ...base, idempotencyKey: "decision-1", resolution: { action: "abandon", reason: "different" } }, "operator"),
    hasOutcomeCode("IDEMPOTENCY_KEY_REUSED"),
  );

  const external = new OutcomeUnknownResolutionStore({ now: () => NOW });
  const externalRecord = await external.register(registration({ invocationId: "model-external" }));
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  for (const [index, value] of [undefined, { summary: "", value: {} }, { summary: "bad", value: Number.NaN }, { summary: "bad", value: cyclic }].entries()) {
    await assert.rejects(
      external.resolve({
        resolutionId: externalRecord.resolutionId,
        expectedVersion: 1,
        idempotencyKey: `external-${index}`,
        resolution: { action: "record_external_result", reason: "外部确认", externalResult: value as never },
      }, "operator"),
      hasOutcomeCode("INVALID_INPUT"),
    );
  }
});
