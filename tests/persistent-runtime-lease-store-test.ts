import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";

import { PersistentRuntimeLeaseStore } from "../src/runtime/persistent-runtime-lease-store.js";
import {
  RuntimeLeaseConflictError,
  type RuntimeLeaseResource,
} from "../src/runtime/runtime-lease.js";

const execFileAsync = promisify(execFile);

class ManualClock {
  constructor(private milliseconds: number) {}
  now = (): string => new Date(this.milliseconds).toISOString();
  advance(milliseconds: number): void { this.milliseconds += milliseconds; }
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "runtime-lease-cas-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    directory,
    statePath: join(directory, "runtime-leases.json"),
  };
}

function expectConflict(code: RuntimeLeaseConflictError["code"]): (
  error: unknown,
) => boolean {
  return (error) => error instanceof RuntimeLeaseConflictError && error.code === code;
}

test("two instances serialize acquisition of the same Job", async (t) => {
  const { statePath } = await fixture(t);
  const clock = new ManualClock(Date.parse("2026-08-18T00:00:00.000Z"));
  const resource = { type: "job", id: "job-1" } as const;
  const first = new PersistentRuntimeLeaseStore(statePath, { now: clock.now });
  const second = new PersistentRuntimeLeaseStore(statePath, { now: clock.now });

  const results = await Promise.allSettled([
    first.acquire({ resource, ownerId: "app-a", ttlMs: 1_000 }),
    second.acquire({ resource, ownerId: "app-b", ttlMs: 1_000 }),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected?.status === "rejected");
  assert.match(String(rejected.reason), /already held/);
});

test("a separate process cannot acquire a Job held by this process", async (t) => {
  const { statePath } = await fixture(t);
  const resource = { type: "job", id: "cross-process-job" } as const;
  const parentStore = new PersistentRuntimeLeaseStore(statePath);
  await parentStore.acquire({ resource, ownerId: "parent-app", ttlMs: 10_000 });
  const moduleUrl = pathToFileURL(join(
    process.cwd(),
    "src",
    "runtime",
    "persistent-runtime-lease-store.ts",
  )).href;
  const childProgram = `
    import { PersistentRuntimeLeaseStore } from ${JSON.stringify(moduleUrl)};
    const store = new PersistentRuntimeLeaseStore(${JSON.stringify(statePath)});
    try {
      await store.acquire({
        resource: { type: "job", id: "cross-process-job" },
        ownerId: "child-app",
        ttlMs: 10000,
      });
      process.stdout.write("unexpected-acquire");
    } catch (error) {
      process.stdout.write(String(error?.code ?? error));
    }
  `;

  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", childProgram],
    { cwd: process.cwd() },
  );
  assert.equal(stdout, "lease_held");
});

test("renew and release are versioned compare-and-swap operations", async (t) => {
  const { statePath } = await fixture(t);
  const clock = new ManualClock(Date.parse("2026-08-18T01:00:00.000Z"));
  const store = new PersistentRuntimeLeaseStore(statePath, { now: clock.now });
  const resource = { type: "turn", id: "turn-1" } as const;
  const acquired = await store.acquire({ resource, ownerId: "app-a", ttlMs: 1_000 });

  clock.advance(400);
  const renewed = await store.renew(acquired, 1_000);
  assert.equal(renewed.leaseVersion, acquired.leaseVersion + 1);
  assert.equal(renewed.fencingToken, acquired.fencingToken);
  assert.equal(renewed.expiresAt, "2026-08-18T01:00:01.400Z");
  await assert.rejects(store.release(acquired), expectConflict("lease_version_mismatch"));
  const releasedVersion = await store.release(renewed);
  assert.equal(releasedVersion, renewed.leaseVersion + 1);
  assert.equal(await store.read(resource), undefined);

  const reacquired = await store.acquire({
    resource,
    ownerId: "app-b",
    ttlMs: 1_000,
    expectedLeaseVersion: releasedVersion,
  });
  assert.equal(reacquired.fencingToken, acquired.fencingToken + 1);
});

test("expired crashed owner is taken over and its late commit is fenced", async (t) => {
  const { directory, statePath } = await fixture(t);
  const clock = new ManualClock(Date.parse("2026-08-18T02:00:00.000Z"));
  const resource = { type: "model_invocation", id: "model-invocation-1" } as const;
  const crashedProcess = new PersistentRuntimeLeaseStore(statePath, { now: clock.now });
  const restartedProcess = new PersistentRuntimeLeaseStore(statePath, { now: clock.now });
  const oldLease = await crashedProcess.acquire({
    resource,
    ownerId: "process-before-crash",
    ttlMs: 500,
  });

  clock.advance(501);
  const takeover = await restartedProcess.acquire({
    resource,
    ownerId: "process-after-restart",
    ttlMs: 1_000,
  });
  assert.equal(takeover.fencingToken, oldLease.fencingToken + 1);

  const commitPath = join(directory, "commit.txt");
  await assert.rejects(
    crashedProcess.withFencedCommit(oldLease, () => writeFile(commitPath, "stale")),
    expectConflict("fencing_token_mismatch"),
  );
  await assert.rejects(readFile(commitPath, "utf8"), /ENOENT/);
  await restartedProcess.withFencedCommit(takeover, (token) =>
    writeFile(commitPath, `accepted:${token}`));
  assert.equal(await readFile(commitPath, "utf8"), `accepted:${takeover.fencingToken}`);
});

test("an expired lease cannot commit before takeover", async (t) => {
  const { statePath } = await fixture(t);
  const clock = new ManualClock(Date.parse("2026-08-18T03:00:00.000Z"));
  const store = new PersistentRuntimeLeaseStore(statePath, { now: clock.now });
  const lease = await store.acquire({
    resource: { type: "tool_invocation", id: "tool-invocation-1" },
    ownerId: "app-a",
    ttlMs: 100,
  });
  clock.advance(100);
  await assert.rejects(
    store.withFencedCommit(lease, () => assert.fail("late commit callback ran")),
    expectConflict("lease_expired"),
  );
});

test("a live transaction mutex is never stolen and is recovered after process death", async (t) => {
  const { directory, statePath } = await fixture(t);
  const readyPath = join(directory, "lock-owner-ready");
  const moduleUrl = pathToFileURL(join(
    process.cwd(),
    "src",
    "runtime",
    "persistent-runtime-lease-store.ts",
  )).href;
  const childProgram = `
    import { writeFile } from "node:fs/promises";
    import { PersistentRuntimeLeaseStore } from ${JSON.stringify(moduleUrl)};
    const store = new PersistentRuntimeLeaseStore(${JSON.stringify(statePath)}, {
      staleLockMs: 10,
      retryDelayMs: 1,
    });
    const lease = await store.acquire({
      resource: { type: "job", id: "lock-owner-job" },
      ownerId: "lock-owner-process",
      ttlMs: 20000,
    });
    await store.withFencedCommit(lease, async () => {
      await writeFile(${JSON.stringify(readyPath)}, "ready");
      await new Promise((resolve) => setTimeout(resolve, 10000));
    });
  `;
  const lockOwner = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", childProgram],
    { cwd: process.cwd(), stdio: "ignore" },
  );
  const lockOwnerExit = new Promise<void>((resolve, reject) => {
    lockOwner.once("exit", () => resolve());
    lockOwner.once("error", reject);
  });
  t.after(() => lockOwner.kill());
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      if (await readFile(readyPath, "utf8") === "ready") break;
    } catch (error) {
      if (!String(error).includes("ENOENT")) throw error;
    }
    if (lockOwner.exitCode !== null) assert.fail("lock owner exited before acquiring mutex");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(await readFile(readyPath, "utf8"), "ready");

  const contender = new PersistentRuntimeLeaseStore(statePath, {
    lockTimeoutMs: 50,
    staleLockMs: 10,
    retryDelayMs: 1,
  });
  await assert.rejects(
    contender.read({ type: "job", id: "lock-owner-job" }),
    /Timed out acquiring Runtime lease state lock/,
  );

  lockOwner.kill();
  await lockOwnerExit;

  const store = new PersistentRuntimeLeaseStore(statePath, {
    lockTimeoutMs: 1_000,
    staleLockMs: 10,
    retryDelayMs: 1,
  });
  const lease = await store.acquire({
    resource: { type: "job", id: "job-after-lock-crash" },
    ownerId: "restarted-app",
    ttlMs: 1_000,
  });
  assert.equal(lease.ownerId, "restarted-app");
});

test("all protected resource kinds persist independently", async (t) => {
  const { statePath } = await fixture(t);
  const clock = new ManualClock(Date.parse("2026-08-18T04:00:00.000Z"));
  const store = new PersistentRuntimeLeaseStore(statePath, { now: clock.now });
  const resources: RuntimeLeaseResource[] = [
    { type: "job", id: "same-id" },
    { type: "turn", id: "same-id" },
    { type: "model_invocation", id: "same-id" },
    { type: "tool_invocation", id: "same-id" },
  ];

  const leases = [];
  for (const resource of resources) {
    leases.push(await store.acquire({ resource, ownerId: "one-app", ttlMs: 1_000 }));
  }
  assert.deepEqual(leases.map((lease) => lease.resource.type), resources.map((item) => item.type));
  assert.deepEqual(leases.map((lease) => lease.fencingToken), [1, 1, 1, 1]);
});
