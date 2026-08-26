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

test("无活动 Lease 时 optional commit 放行、required commit 和 renew 均 fail closed", async (t) => {
  const { statePath } = await fixture(t);
  const coordinator = new ExecutionLeaseCoordinator(new PersistentRuntimeLeaseStore(statePath), {
    ownerId: "no-active-owner", ttlMs: 1_000, renewIntervalMs: 500, maxRenewals: 0,
  });
  assert.equal(await coordinator.withActiveFencedCommit("runtime_state", () => "optional"), "optional");
  await assert.rejects(() => coordinator.withRequiredActiveFencedCommit("runtime_state", () => 1), /No active execution lease/);
  await assert.rejects(() => coordinator.renewActiveLease(), /No active execution lease/);
});

test("Lease 配置与 Job 输入的边界均 fail closed", async (t) => {
  const { statePath } = await fixture(t);
  assert.throws(() => new ExecutionLeaseCoordinator(new PersistentRuntimeLeaseStore(statePath), {
    ownerId: "", ttlMs: 1_000, renewIntervalMs: 500, maxRenewals: 0,
  }), /ownerId/);
  const coordinator = new ExecutionLeaseCoordinator(new PersistentRuntimeLeaseStore(statePath), {
    ownerId: "boundary-owner", ttlMs: 1_000, renewIntervalMs: 500, maxRenewals: 0,
  });
  await assert.rejects(() => coordinator.runWithJobLease("", async () => undefined), /jobId/);
  await assert.rejects(() => coordinator.withJob("", async () => undefined), /jobId/);
});

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

test("same-Job nesting reuses one Lease while different-Job nesting is rejected", async (t) => {
  const { statePath } = await fixture(t);
  let acquireCalls = 0;
  const backing = new PersistentRuntimeLeaseStore(statePath);
  const store: ExecutionLeaseStore = {
    acquire: (input) => { acquireCalls += 1; return backing.acquire(input); },
    renew: (lease, ttlMs) => backing.renew(lease, ttlMs),
    release: (lease) => backing.release(lease),
    withFencedCommit: (lease, commit) => backing.withFencedCommit(lease, commit),
  };
  const coordinator = new ExecutionLeaseCoordinator(store, {
    ownerId: "nested-owner", ttlMs: 1_000, renewIntervalMs: 500, maxRenewals: 0,
  });

  await coordinator.withJob("job-a", async () => {
    const outer = coordinator.currentContext();
    await coordinator.withJob("job-a", async () => {
      assert.equal(coordinator.currentContext(), outer);
      await coordinator.withRequiredActiveFencedCommit("runtime_state", () => undefined);
    });
    await assert.rejects(
      coordinator.withJob("job-b", async () => undefined),
      /Cannot nest execution leases for different Jobs/,
    );
  });
  assert.equal(acquireCalls, 1);
});

test("independent async callers for the same Job join the active local Lease session", async (t) => {
  const { statePath } = await fixture(t);
  let acquireCalls = 0;
  const backing = new PersistentRuntimeLeaseStore(statePath);
  const store: ExecutionLeaseStore = {
    acquire: (input) => { acquireCalls += 1; return backing.acquire(input); },
    renew: (lease, ttlMs) => backing.renew(lease, ttlMs),
    release: (lease) => backing.release(lease),
    withFencedCommit: (lease, commit) => backing.withFencedCommit(lease, commit),
  };
  const coordinator = new ExecutionLeaseCoordinator(store, {
    ownerId: "concurrent-local-owner", ttlMs: 1_000, renewIntervalMs: 500, maxRenewals: 0,
  });
  const entered = deferred();
  const releaseOuter = deferred();
  let outerContext = coordinator.currentContext();
  const outer = coordinator.withJob("job-concurrent-local", async () => {
    outerContext = coordinator.currentContext();
    entered.resolve();
    await releaseOuter.promise;
  });
  await entered.promise;

  const joinedOutcome = await coordinator.withJob("job-concurrent-local", async () => {
    assert.equal(coordinator.currentContext(), outerContext);
    await coordinator.withRequiredActiveFencedCommit("cancel", () => undefined);
    return "joined";
  }).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  releaseOuter.resolve();
  await outer;

  assert.deepEqual(joinedOutcome, { ok: true, value: "joined" });
  assert.equal(acquireCalls, 1);
});

test("concurrent first callers single-flight the persistent Job Lease acquisition", async (t) => {
  const { statePath } = await fixture(t);
  const acquireStarted = deferred();
  const releaseAcquire = deferred();
  let acquireCalls = 0;
  const backing = new PersistentRuntimeLeaseStore(statePath);
  const store: ExecutionLeaseStore = {
    acquire: async (input) => {
      acquireCalls += 1;
      acquireStarted.resolve();
      await releaseAcquire.promise;
      return backing.acquire(input);
    },
    renew: (lease, ttlMs) => backing.renew(lease, ttlMs),
    release: (lease) => backing.release(lease),
    withFencedCommit: (lease, commit) => backing.withFencedCommit(lease, commit),
  };
  const coordinator = new ExecutionLeaseCoordinator(store, {
    ownerId: "single-flight-owner", ttlMs: 1_000, renewIntervalMs: 500, maxRenewals: 0,
  });
  const contexts: unknown[] = [];
  const first = coordinator.runWithJobLease("job-single-flight", async (context) => {
    contexts.push(context);
    return "first";
  });
  await acquireStarted.promise;
  const second = coordinator.runWithJobLease("job-single-flight", async (context) => {
    contexts.push(context);
    return "second";
  });
  await Promise.resolve();

  assert.equal(acquireCalls, 1, "the pending acquisition must be visible before Store.acquire resolves");
  releaseAcquire.resolve();
  const outcomes = await Promise.all([first, second]);

  assert.deepEqual(outcomes.map((item) => item.status), ["acquired", "acquired"]);
  assert.deepEqual(outcomes.map((item) => item.status === "acquired" ? item.value : undefined), ["first", "second"]);
  assert.equal(contexts.length, 2);
  assert.equal(contexts[0], contexts[1]);
  assert.equal(acquireCalls, 1);
});

test("concurrent first callers share a diagnostic waiting result and leave no pending acquisition", async (t) => {
  const { statePath } = await fixture(t);
  const backing = new PersistentRuntimeLeaseStore(statePath);
  const held = await backing.acquire({
    resource: { type: "job", id: "job-single-flight-waiting" }, ownerId: "other-owner", ttlMs: 10_000,
  });
  const acquireStarted = deferred();
  const releaseAcquire = deferred();
  let acquireCalls = 0;
  const store: ExecutionLeaseStore = {
    acquire: async (input) => {
      acquireCalls += 1;
      acquireStarted.resolve();
      await releaseAcquire.promise;
      return backing.acquire(input);
    },
    renew: (lease, ttlMs) => backing.renew(lease, ttlMs),
    release: (lease) => backing.release(lease),
    withFencedCommit: (lease, commit) => backing.withFencedCommit(lease, commit),
  };
  const coordinator = new ExecutionLeaseCoordinator(store, {
    ownerId: "waiting-owner", ttlMs: 1_000, renewIntervalMs: 500, maxRenewals: 0,
  });
  let operations = 0;
  const run = () => coordinator.runWithJobLease("job-single-flight-waiting", async () => {
    operations += 1;
  });
  const first = run();
  await acquireStarted.promise;
  const second = run();
  await Promise.resolve();

  assert.equal(acquireCalls, 1);
  releaseAcquire.resolve();
  const outcomes = await Promise.all([first, second]);

  assert.equal(outcomes[0]?.status, "waiting");
  assert.equal(outcomes[1]?.status, "waiting");
  if (outcomes[0]?.status === "waiting" && outcomes[1]?.status === "waiting") {
    assert.deepEqual(outcomes[0].currentLease, held);
    assert.deepEqual(outcomes[1].currentLease, held);
  }
  assert.equal(operations, 0);
  assert.equal(acquireCalls, 1);

  await backing.release(held);
  const retry = await coordinator.runWithJobLease("job-single-flight-waiting", async () => "retry-acquired");
  assert.equal(retry.status, "acquired", "a waiting single-flight must not leak its pending entry");
  if (retry.status === "acquired") assert.equal(retry.value, "retry-acquired");
  assert.equal(acquireCalls, 2);
});

test("concurrent first callers share an acquisition failure and a later retry can acquire", async (t) => {
  const { statePath } = await fixture(t);
  const backing = new PersistentRuntimeLeaseStore(statePath);
  const acquireStarted = deferred();
  const releaseAcquire = deferred();
  const diagnostic = new Error("lease backend unavailable: audit-e2");
  let acquireCalls = 0;
  let failAcquire = true;
  const store: ExecutionLeaseStore = {
    acquire: async (input) => {
      acquireCalls += 1;
      if (failAcquire) {
        acquireStarted.resolve();
        await releaseAcquire.promise;
        throw diagnostic;
      }
      return backing.acquire(input);
    },
    renew: (lease, ttlMs) => backing.renew(lease, ttlMs),
    release: (lease) => backing.release(lease),
    withFencedCommit: (lease, commit) => backing.withFencedCommit(lease, commit),
  };
  const coordinator = new ExecutionLeaseCoordinator(store, {
    ownerId: "failing-single-flight-owner", ttlMs: 1_000, renewIntervalMs: 500, maxRenewals: 0,
  });
  let operations = 0;
  const capture = (promise: Promise<unknown>) => promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const run = () => capture(coordinator.withJob("job-single-flight-failure", async () => {
    operations += 1;
  }));
  const first = run();
  await acquireStarted.promise;
  const second = run();
  await Promise.resolve();

  assert.equal(acquireCalls, 1);
  releaseAcquire.resolve();
  const outcomes = await Promise.all([first, second]);

  assert.deepEqual(outcomes.map((item) => item.ok), [false, false]);
  assert.equal(outcomes[0]?.ok === false ? outcomes[0].error : undefined, diagnostic);
  assert.equal(outcomes[1]?.ok === false ? outcomes[1].error : undefined, diagnostic);
  assert.equal(operations, 0);
  assert.equal(acquireCalls, 1);

  failAcquire = false;
  await coordinator.withJob("job-single-flight-failure", async () => { operations += 1; });
  assert.equal(operations, 1, "a failed single-flight must not leak its pending entry");
  assert.equal(acquireCalls, 2);
});

test("required fenced commit rejects a silent commit without an active Lease", async (t) => {
  const { statePath } = await fixture(t);
  const coordinator = new ExecutionLeaseCoordinator(
    new PersistentRuntimeLeaseStore(statePath),
    { ownerId: "strict-owner", ttlMs: 1_000, renewIntervalMs: 500, maxRenewals: 0 },
  );
  let committed = false;
  await assert.rejects(
    coordinator.withRequiredActiveFencedCommit("runtime_state", () => { committed = true; }),
    /No active execution lease/,
  );
  assert.equal(committed, false);
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

test("后台续租成功会更新活动 Context，续租故障则阻止最终提交", async () => {
  const lease = {
    resource: { type: "job" as const, id: "job-auto-renew" },
    ownerId: "automatic-owner",
    leaseVersion: 1,
    fencingToken: 7,
    expiresAt: "2026-08-24T00:00:00.050Z",
  };
  let renewCalls = 0;
  let releaseCalls = 0;
  const successfulStore: ExecutionLeaseStore = {
    acquire: async () => structuredClone(lease),
    renew: async (current) => {
      renewCalls += 1;
      return { ...current, leaseVersion: current.leaseVersion + 1, expiresAt: "2026-08-24T00:00:00.100Z" };
    },
    release: async () => ++releaseCalls,
    withFencedCommit: async (current, commit) => commit(current.fencingToken),
  };
  const successful = new ExecutionLeaseCoordinator(successfulStore, {
    ownerId: "automatic-owner", ttlMs: 50, renewIntervalMs: 2, maxRenewals: 1,
  });
  const outcome = await successful.runWithJobLease(lease.resource.id, async (context) => {
    await new Promise((resolve) => setTimeout(resolve, 15));
    return { version: context.leaseVersion, deadline: context.deadline };
  });
  assert.equal(outcome.status, "acquired");
  if (outcome.status === "acquired") {
    assert.deepEqual(outcome.value, { version: 2, deadline: "2026-08-24T00:00:00.100Z" });
  }
  assert.equal(renewCalls, 1);
  assert.equal(releaseCalls, 1);

  const renewalFailure = new Error("automatic renewal unavailable");
  const failingStore: ExecutionLeaseStore = {
    ...successfulStore,
    renew: async () => { throw renewalFailure; },
  };
  const failing = new ExecutionLeaseCoordinator(failingStore, {
    ownerId: "automatic-owner", ttlMs: 50, renewIntervalMs: 2, maxRenewals: 1,
  });
  await assert.rejects(
    failing.runWithJobLease(lease.resource.id, async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }),
    (error) => error === renewalFailure,
  );
});

test("执行租约拒绝非法配置和非法重试延迟", async () => {
  const unreachable: ExecutionLeaseStore = {
    acquire: async () => { throw new RuntimeLeaseConflictError("lease_held", "held"); },
    renew: async (lease) => lease,
    release: async () => 0,
    withFencedCommit: async (lease, commit) => commit(lease.fencingToken),
  };
  assert.throws(() => new ExecutionLeaseCoordinator(unreachable, { ownerId: " " }), /ownerId must not be empty/);
  assert.throws(() => new ExecutionLeaseCoordinator(unreachable, { ownerId: "boundary", ttlMs: 0 }), /ttlMs must be a positive safe integer/);
  assert.throws(() => new ExecutionLeaseCoordinator(unreachable, { ownerId: "boundary", ttlMs: 10, renewIntervalMs: 10 }), /renewIntervalMs must be less than ttlMs/);
  assert.throws(() => new ExecutionLeaseCoordinator(unreachable, { maxRenewals: -1 }), /maxRenewals must be a non-negative safe integer/);
  const invalidDelay = new ExecutionLeaseCoordinator(unreachable, {
    ownerId: "invalid-delay", ttlMs: 100, renewIntervalMs: 50,
    maxAcquireAttempts: 2, acquireRetryDelayMs: () => Number.NaN,
  });
  await assert.rejects(
    invalidDelay.runWithJobLease("job-invalid-delay", async () => undefined),
    /acquireRetryDelayMs must return a non-negative finite number/,
  );
});

test("释放重试使用非零退避并在恢复后完成清理", async () => {
  const lease = {
    resource: { type: "job" as const, id: "job-release-backoff" },
    ownerId: "backoff-owner", leaseVersion: 1, fencingToken: 1,
    expiresAt: "2026-08-24T00:00:01.000Z",
  };
  let releaseCalls = 0;
  const store: ExecutionLeaseStore = {
    acquire: async () => structuredClone(lease),
    renew: async (value) => value,
    release: async () => {
      releaseCalls += 1;
      if (releaseCalls === 1) throw new Error("transient release");
      return 0;
    },
    withFencedCommit: async (value, commit) => commit(value.fencingToken),
  };
  const coordinator = new ExecutionLeaseCoordinator(store, {
    ownerId: "backoff-owner", maxReleaseAttempts: 2,
    releaseRetryDelayMs: () => 1,
  });
  const result = await coordinator.runWithJobLease("job-release-backoff", async () => "done");
  assert.equal(result.status, "acquired");
  assert.equal(result.status === "acquired" ? result.value : undefined, "done");
  assert.equal(releaseCalls, 2);
});

test("无活动租约时 fenced commit 明确区分可选与必需语义", async () => {
  const store: ExecutionLeaseStore = {
    acquire: async () => { throw new Error("unused"); },
    renew: async (lease) => lease,
    release: async () => 0,
    withFencedCommit: async (_lease, commit) => commit(1),
  };
  const coordinator = new ExecutionLeaseCoordinator(store, { ownerId: "outside-owner" });
  assert.equal(await coordinator.withActiveFencedCommit("tool_commit", () => "optional"), "optional");
  await assert.rejects(
    coordinator.withRequiredActiveFencedCommit("tool_commit", () => "required"),
    /No active execution lease/,
  );
  await assert.rejects(coordinator.renewActiveLease(), /No active execution lease/);
});

test("获取租约在非冲突错误上立即传播，不伪造 waiting", async () => {
  const failure = new Error("store unavailable");
  const store: ExecutionLeaseStore = {
    acquire: async () => { throw failure; },
    renew: async (lease) => lease,
    release: async () => 0,
    withFencedCommit: async (lease, commit) => commit(lease.fencingToken),
  };
  const coordinator = new ExecutionLeaseCoordinator(store, { ownerId: "error-owner", maxAcquireAttempts: 3 });
  await assert.rejects(coordinator.runWithJobLease("job-error", async () => undefined), (error) => error === failure);
});

test("冲突达到上限时返回 waiting 并保留当前 lease，而不是抛错", async () => {
  const currentLease = {
    resource: { type: "job" as const, id: "job-waiting" },
    ownerId: "other-owner", leaseVersion: 2, fencingToken: 9,
    expiresAt: "2026-08-24T00:00:01.000Z",
  };
  const store: ExecutionLeaseStore = {
    acquire: async () => { throw new RuntimeLeaseConflictError("lease_held", "held", currentLease); },
    renew: async (lease) => lease,
    release: async () => 0,
    withFencedCommit: async (lease, commit) => commit(lease.fencingToken),
  };
  const coordinator = new ExecutionLeaseCoordinator(store, { ownerId: "waiting-owner", maxAcquireAttempts: 2, acquireRetryDelayMs: () => 0 });
  const result = await coordinator.runWithJobLease("job-waiting", async () => "must-not-run");
  assert.equal(result.status, "waiting");
  if (result.status === "waiting") assert.deepEqual(result.currentLease, currentLease);
});

test("释放租约失败时按上限重试，成功后返回业务结果", async () => {
  const lease = {
    resource: { type: "job" as const, id: "job-release-retry" }, ownerId: "release-owner",
    leaseVersion: 1, fencingToken: 1, expiresAt: "2026-08-24T00:00:01.000Z",
  };
  let releases = 0;
  const store: ExecutionLeaseStore = {
    acquire: async () => structuredClone(lease), renew: async (value) => value,
    release: async () => { releases += 1; if (releases < 3) throw new Error("transient release"); return 0; },
    withFencedCommit: async (value, commit) => commit(value.fencingToken),
  };
  const coordinator = new ExecutionLeaseCoordinator(store, { ownerId: "release-owner", maxReleaseAttempts: 3, releaseRetryDelayMs: () => 0 });
  const result = await coordinator.runWithJobLease("job-release-retry", async () => "done");
  assert.equal(result.status, "acquired");
  assert.equal(releases, 3);
});

test("释放租约连续失败时业务成功仍返回 release 错误", async () => {
  const failure = new Error("release permanently unavailable");
  const lease = {
    resource: { type: "job" as const, id: "job-release-fail" }, ownerId: "release-fail-owner",
    leaseVersion: 1, fencingToken: 1, expiresAt: "2026-08-24T00:00:01.000Z",
  };
  let releases = 0;
  const store: ExecutionLeaseStore = {
    acquire: async () => structuredClone(lease), renew: async (value) => value,
    release: async () => { releases += 1; if (releases > 0) throw failure; return 0; },
    withFencedCommit: async (value, commit) => commit(value.fencingToken),
  };
  const coordinator = new ExecutionLeaseCoordinator(store, { ownerId: "release-fail-owner", maxReleaseAttempts: 2, releaseRetryDelayMs: () => 0 });
  await assert.rejects(coordinator.runWithJobLease("job-release-fail", async () => "done"), (error) => error === failure);
  assert.equal(releases, 2);
});

test("活动租约续租达到上限后 fail closed", async () => {
  const lease = {
    resource: { type: "job" as const, id: "job-renew-limit" }, ownerId: "renew-owner",
    leaseVersion: 1, fencingToken: 1, expiresAt: "2026-08-24T00:00:01.000Z",
  };
  const store: ExecutionLeaseStore = {
    acquire: async () => structuredClone(lease), renew: async (value) => ({ ...value, leaseVersion: value.leaseVersion + 1 }),
    release: async () => 0,
    withFencedCommit: async (value, commit) => commit(value.fencingToken),
  };
  const coordinator = new ExecutionLeaseCoordinator(store, { ownerId: "renew-owner", maxRenewals: 1 });
  await coordinator.runWithJobLease("job-renew-limit", async () => {
    await coordinator.renewActiveLease();
    await assert.rejects(coordinator.renewActiveLease(), /renewal limit reached/);
  });
});
