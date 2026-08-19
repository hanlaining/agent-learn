import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  ExecutionLeaseCoordinator,
  ExecutionLeaseUnavailableError,
  type ExecutionLeaseCommitBoundary,
  type ExecutionLeaseStore,
} from "../src/runtime/execution-lease-coordinator.js";
import { PersistentRuntimeLeaseStore } from "../src/runtime/persistent-runtime-lease-store.js";
import { RuntimeLeaseConflictError } from "../src/runtime/runtime-lease.js";
import { AgentLoop } from "../src/agent/agent-loop.js";
import { LifecycleStore } from "../src/runtime/lifecycle-store.js";
import { ScriptedLlmProvider } from "./helpers/scripted-llm.js";
import { AgentRuntimeStore } from "../src/agents/agent-runtime-store.js";
import { DEFAULT_AGENT_TEAM_CONFIG } from "../src/agents/agent-runtime.js";
import { AgentRuntimeCoordinator } from "../src/agents/agent-runtime-coordinator.js";

class ManualClock {
  constructor(private milliseconds: number) {}
  now = (): string => new Date(this.milliseconds).toISOString();
  advance(milliseconds: number): void { this.milliseconds += milliseconds; }
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "execution-lease-wiring-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { statePath: join(directory, "runtime-leases.json") };
}

function conflict(code: RuntimeLeaseConflictError["code"]) {
  return (error: unknown): boolean =>
    error instanceof RuntimeLeaseConflictError && error.code === code;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("two real Store/coordinator instances keep one legal Job owner across 1000 races", async (t) => {
  const { statePath } = await fixture(t);
  const clock = new ManualClock(Date.parse("2026-08-19T00:00:00.000Z"));
  const first = new ExecutionLeaseCoordinator(
    new PersistentRuntimeLeaseStore(statePath, { now: clock.now, retryDelayMs: 1 }),
    { ownerId: "app-a", ttlMs: 1_000, renewIntervalMs: 500, maxRenewals: 0 },
  );
  const second = new ExecutionLeaseCoordinator(
    new PersistentRuntimeLeaseStore(statePath, { now: clock.now, retryDelayMs: 1 }),
    { ownerId: "app-b", ttlMs: 1_000, renewIntervalMs: 500, maxRenewals: 0 },
  );
  let activeOwners = 0;
  let maximumActiveOwners = 0;
  let acquiredRuns = 0;

  for (let round = 0; round < 1_000; round += 1) {
    const compete = (coordinator: ExecutionLeaseCoordinator) =>
      coordinator.runWithJobLease("job-race", async (context) => {
        activeOwners += 1;
        acquiredRuns += 1;
        maximumActiveOwners = Math.max(maximumActiveOwners, activeOwners);
        assert.equal(context.ownerId === "app-a" || context.ownerId === "app-b", true);
        await Promise.resolve();
        activeOwners -= 1;
      });
    await Promise.all([compete(first), compete(second)]);
    assert.equal(activeOwners, 0);
  }

  assert.equal(maximumActiveOwners, 1);
  assert.ok(acquiredRuns >= 1_000);
});

test("takeover fences 100% of stale Return, Stage, Model and Tool commits", async (t) => {
  const { statePath } = await fixture(t);
  const clock = new ManualClock(Date.parse("2026-08-19T01:00:00.000Z"));
  const oldOwner = new ExecutionLeaseCoordinator(
    new PersistentRuntimeLeaseStore(statePath, { now: clock.now }),
    { ownerId: "old-owner", ttlMs: 100, renewIntervalMs: 50, maxRenewals: 0 },
  );
  const newOwner = new ExecutionLeaseCoordinator(
    new PersistentRuntimeLeaseStore(statePath, { now: clock.now }),
    { ownerId: "new-owner", ttlMs: 1_000, renewIntervalMs: 500, maxRenewals: 0 },
  );
  const oldReady = deferred();
  const takeoverReady = deferred();
  const releaseOld = deferred();
  const releaseNew = deferred();
  const committed: string[] = [];
  const boundaries: ExecutionLeaseCommitBoundary[] = [
    "return_consume",
    "workflow_stage",
    "model_commit",
    "tool_commit",
  ];

  const oldRun = oldOwner.runWithJobLease("job-fenced", async () => {
    oldReady.resolve();
    await takeoverReady.promise;
    let rejected = 0;
    for (const boundary of boundaries) {
      await assert.rejects(
        oldOwner.withActiveFencedCommit(boundary, () => committed.push(boundary)),
        conflict("fencing_token_mismatch"),
      );
      rejected += 1;
    }
    assert.equal(rejected, boundaries.length);
    await releaseOld.promise;
  });
  await oldReady.promise;
  clock.advance(101);
  const newRun = newOwner.runWithJobLease("job-fenced", async (context) => {
    assert.equal(context.ownerId, "new-owner");
    assert.equal(context.fencingToken, 2);
    takeoverReady.resolve();
    await releaseNew.promise;
  });
  await takeoverReady.promise;
  releaseOld.resolve();
  await assert.rejects(oldRun, conflict("fencing_token_mismatch"));
  assert.deepEqual(committed, []);
  releaseNew.resolve();
  assert.equal((await newRun).status, "acquired");
});

test("renewal advances CAS version without changing the fencing token", async (t) => {
  const { statePath } = await fixture(t);
  const clock = new ManualClock(Date.parse("2026-08-19T02:00:00.000Z"));
  const store = new PersistentRuntimeLeaseStore(statePath, { now: clock.now });
  const coordinator = new ExecutionLeaseCoordinator(store, {
    ownerId: "renewing-owner", ttlMs: 100, renewIntervalMs: 50, maxRenewals: 2,
  });

  const result = await coordinator.runWithJobLease("job-renew", async (initial) => {
    const initialVersion = initial.leaseVersion;
    const initialToken = initial.fencingToken;
    clock.advance(40);
    const renewed = await coordinator.renewActiveLease();
    assert.equal(renewed, initial);
    assert.equal(renewed.leaseVersion, initialVersion + 1);
    assert.equal(renewed.fencingToken, initialToken);
    assert.equal(renewed.deadline, "2026-08-19T02:00:00.140Z");
  });
  assert.equal(result.status, "acquired");
  assert.equal(await store.read({ type: "job", id: "job-renew" }), undefined);
});

test("explicit cancellation commits while fenced and then releases the Job", async (t) => {
  const { statePath } = await fixture(t);
  const store = new PersistentRuntimeLeaseStore(statePath);
  const coordinator = new ExecutionLeaseCoordinator(store, {
    ownerId: "cancelling-owner", ttlMs: 1_000, renewIntervalMs: 500, maxRenewals: 0,
  });
  let status = "running";

  await coordinator.runWithJobLease("job-cancel", async () => {
    await coordinator.withActiveFencedCommit("cancel", () => { status = "cancelled"; });
  });
  assert.equal(status, "cancelled");
  const successor = await store.acquire({
    resource: { type: "job", id: "job-cancel" }, ownerId: "successor", ttlMs: 1_000,
  });
  assert.equal(successor.fencingToken, 2);
});

test("persistence failure aborts the commit and still makes later takeover possible", async (t) => {
  const { statePath } = await fixture(t);
  const store = new PersistentRuntimeLeaseStore(statePath);
  const coordinator = new ExecutionLeaseCoordinator(store, {
    ownerId: "failing-owner", ttlMs: 1_000, renewIntervalMs: 500, maxRenewals: 0,
  });

  await assert.rejects(
    coordinator.runWithJobLease("job-persist-failure", async () => {
      await coordinator.withActiveFencedCommit("runtime_state", () => {
        throw new Error("simulated persistence failure");
      });
    }),
    /simulated persistence failure/,
  );
  const successor = await store.acquire({
    resource: { type: "job", id: "job-persist-failure" }, ownerId: "successor", ttlMs: 1_000,
  });
  assert.equal(successor.fencingToken, 2);
});

test("acquire and release retries are bounded", async (t) => {
  const { statePath } = await fixture(t);
  const backing = new PersistentRuntimeLeaseStore(statePath);
  await backing.acquire({
    resource: { type: "job", id: "job-bounded-acquire" }, ownerId: "holder", ttlMs: 10_000,
  });
  let acquireCalls = 0;
  const countingStore: ExecutionLeaseStore = {
    acquire: (input) => { acquireCalls += 1; return backing.acquire(input); },
    renew: (lease, ttlMs) => backing.renew(lease, ttlMs),
    release: (lease) => backing.release(lease),
    withFencedCommit: (lease, commit) => backing.withFencedCommit(lease, commit),
  };
  const contender = new ExecutionLeaseCoordinator(countingStore, {
    ownerId: "contender", ttlMs: 1_000, renewIntervalMs: 500,
    maxAcquireAttempts: 3, acquireRetryDelayMs: () => 0, maxRenewals: 0,
  });
  assert.equal(
    (await contender.runWithJobLease("job-bounded-acquire", async () => assert.fail())).status,
    "waiting",
  );
  assert.equal(acquireCalls, 3);

  let releaseCalls = 0;
  const releaseFailingStore: ExecutionLeaseStore = {
    acquire: (input) => backing.acquire(input),
    renew: (lease, ttlMs) => backing.renew(lease, ttlMs),
    release: async () => { releaseCalls += 1; throw new Error("release unavailable"); },
    withFencedCommit: (lease, commit) => backing.withFencedCommit(lease, commit),
  };
  const releaseFailing = new ExecutionLeaseCoordinator(releaseFailingStore, {
    ownerId: "release-owner", ttlMs: 1_000, renewIntervalMs: 500, maxRenewals: 0,
    maxReleaseAttempts: 2, releaseRetryDelayMs: () => 0,
  });
  await assert.rejects(
    releaseFailing.runWithJobLease("job-bounded-release", async () => undefined),
    /release unavailable/,
  );
  assert.equal(releaseCalls, 2);
});

test("a dynamic Job AgentLoop waits without dispatching Model when another app owns the Lease", async (t) => {
  const { statePath } = await fixture(t);
  const store = new PersistentRuntimeLeaseStore(statePath);
  const held = await store.acquire({
    resource: { type: "job", id: "job-dynamic" }, ownerId: "other-app", ttlMs: 10_000,
  });
  const coordinator = new ExecutionLeaseCoordinator(store, {
    ownerId: "this-app", ttlMs: 1_000, renewIntervalMs: 500, maxRenewals: 0,
  });
  const lifecycle = new LifecycleStore();
  const thread = lifecycle.createThread();
  const turn = lifecycle.createTurn(thread.id);
  lifecycle.appendItem(turn.id, "user_message", { text: "do not dispatch yet" });
  const statusBeforeRun = lifecycle.getTurn(turn.id)?.status;
  const llm = new ScriptedLlmProvider([{ id: "must-not-run", text: "unexpected", functionCalls: [] }]);
  const loop = new AgentLoop({
    lifecycleStore: lifecycle,
    llm,
    executionLeases: coordinator,
    resolveExecutionContext: () => ({ jobId: "job-dynamic" }),
  });

  await assert.rejects(
    loop.run(turn.id),
    (error) => error instanceof ExecutionLeaseUnavailableError && error.jobId === "job-dynamic",
  );
  assert.equal(llm.requests.length, 0);
  assert.equal(lifecycle.getTurn(turn.id)?.status, statusBeforeRun);
  await store.release(held);
});

test("Return claim/consume and parent continuation do not advance without the Job Lease", async (t) => {
  const { statePath } = await fixture(t);
  const leaseStore = new PersistentRuntimeLeaseStore(statePath);
  const runtimeStore = new AgentRuntimeStore();
  const job = runtimeStore.createJob({
    threadId: "thread-parent",
    rootTurnId: "turn-parent",
    rootRunId: "run-parent",
    configSnapshot: DEFAULT_AGENT_TEAM_CONFIG,
  });
  const task = runtimeStore.createTask({
    jobId: job.id,
    rootRunId: "run-parent",
    ownerRunId: "run-child",
    profileId: "coder",
    title: "child",
    objective: "child",
    scope: { allowedPaths: [], deniedPaths: [], nonGoals: [] },
    requiredOutputs: ["result"],
    acceptanceCriteria: ["done"],
    fileClaims: [],
    maxAttempts: 1,
  });
  runtimeStore.createReturn({
    jobId: job.id,
    rootRunId: "run-parent",
    parentRunId: "run-parent",
    childRunId: "run-child",
    taskId: task.id,
    sequence: 1,
    result: { status: "completed", summary: "done", evidenceIds: [], boardEntryIds: [] },
    idempotencyKey: `${job.id}:run-child`,
  });
  const held = await leaseStore.acquire({
    resource: { type: "job", id: job.id }, ownerId: "other-app", ttlMs: 10_000,
  });
  const executionLeases = new ExecutionLeaseCoordinator(leaseStore, {
    ownerId: "this-app", ttlMs: 1_000, renewIntervalMs: 500, maxRenewals: 0,
  });
  let continuationCalls = 0;
  let persistCalls = 0;
  const coordinator = new AgentRuntimeCoordinator({
    store: runtimeStore,
    executionLeases,
    persist: () => { persistCalls += 1; },
  });

  await assert.rejects(
    coordinator.continueParent("turn-parent", ["run-child"], async () => {
      continuationCalls += 1;
      return "unexpected";
    }),
    (error) => error instanceof ExecutionLeaseUnavailableError && error.jobId === job.id,
  );
  assert.equal(continuationCalls, 0);
  assert.equal(persistCalls, 0);
  assert.equal(runtimeStore.listReturns(job.id)[0]?.status, "ready");
  await leaseStore.release(held);
});
