import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test, {
  type TestContext,
} from "node:test";

import {
  JsonFileRuntimePersistence,
  SnapshotConflictError,
  SnapshotStateIdentityError,
  type LoadedRuntimeState,
} from "../src/runtime/json-file-runtime-persistence.js";
import { DEFAULT_AGENT_TEAM_CONFIG } from "../src/agents/agent-runtime.js";
import { PersistentRuntimeLeaseStore } from "../src/runtime/persistent-runtime-lease-store.js";
import {
  createModelRequestDigest,
} from "../src/runtime/model-invocation.js";
import {
  createToolArgumentsDigest,
} from "../src/runtime/tool-invocation.js";

async function createFixture(t: TestContext) {
  const directory = await mkdtemp(
    join(tmpdir(), "agent-runtime-state-"),
  );
  t.after(() => rm(directory, {
    recursive: true,
    force: true,
  }));

  return {
    directory,
    statePath: join(directory, "nested", "state.json"),
  };
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      await readFile(path, "utf8");
      return;
    } catch (error) {
      if (!String(error).includes("ENOENT")) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${path}`);
}

function saveLoadedState(
  persistence: JsonFileRuntimePersistence,
  state: LoadedRuntimeState,
): Promise<void> {
  return persistence.save(state);
}

function waitForSuccessfulExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Child exited with code ${code}, signal ${signal}`));
    });
  });
}

test("状态文件不存在时返回新的空 Store", async (t) => {
  const fixture = await createFixture(t);
  const persistence = new JsonFileRuntimePersistence(
    fixture.statePath,
  );

  const loaded = await persistence.load();

  assert.equal(loaded.restored, false);
  assert.deepEqual(loaded.recoveredTurnIds, []);
  assert.deepEqual(
    loaded.lifecycleStore.exportSnapshot().threads,
    [],
  );
  assert.deepEqual(
    loaded.contextCheckpointStore.exportSnapshot().checkpoints,
    [],
  );
});

test("原子保存并在新实例中恢复 Runtime 状态", async (t) => {
  const fixture = await createFixture(t);
  const persistence = new JsonFileRuntimePersistence(
    fixture.statePath,
  );
  const loaded = await persistence.load();
  const thread = loaded.lifecycleStore.createThread();
  const turn = loaded.lifecycleStore.createTurn(thread.id);
  loaded.lifecycleStore.appendItem(
    turn.id,
    "user_message",
    { text: "持久化测试" },
  );
  loaded.lifecycleStore.completeTurn(turn.id);
  loaded.contextCheckpointStore.record({
    threadId: thread.id,
    throughTurnId: turn.id,
    replacementMessages: [
      { role: "user", text: "持久化测试" },
    ],
    beforeTokens: 20,
    afterTokens: 10,
  });

  await saveLoadedState(persistence, loaded);

  const restored = await new JsonFileRuntimePersistence(
    fixture.statePath,
  ).load();

  assert.equal(restored.restored, true);
  assert.deepEqual(
    restored.lifecycleStore.getThread(thread.id),
    thread,
  );
  assert.equal(
    restored.contextCheckpointStore
      .getLatest(thread.id)?.throughTurnId,
    turn.id,
  );

  const json = JSON.parse(
    await readFile(fixture.statePath, "utf8"),
  ) as { version: number };
  assert.equal(json.version, 7);
});

test("后续保存覆盖旧快照且保持合法 JSON", async (t) => {
  const fixture = await createFixture(t);
  const persistence = new JsonFileRuntimePersistence(
    fixture.statePath,
  );
  const loaded = await persistence.load();
  assert.equal(loaded.generation, 0);

  loaded.lifecycleStore.createThread();
  await saveLoadedState(persistence, loaded);
  assert.equal(
    (JSON.parse(await readFile(fixture.statePath, "utf8")) as { generation: number }).generation,
    1,
  );
  loaded.lifecycleStore.createThread();
  await saveLoadedState(persistence, loaded);

  const restored = await persistence.load();
  assert.equal(restored.generation, 2);
  assert.equal(
    restored.lifecycleStore.exportSnapshot().threads.length,
    2,
  );
});

test("同一状态身份的排队保存连续推进 generation", async (t) => {
  const fixture = await createFixture(t);
  const persistence = new JsonFileRuntimePersistence(fixture.statePath);
  const state = await persistence.load();

  state.lifecycleStore.createThread();
  const firstSave = persistence.save(state);
  state.lifecycleStore.createThread();
  const secondSave = persistence.save(state);
  await Promise.all([firstSave, secondSave]);

  assert.equal(state.generation, 2);
  const durable = await new JsonFileRuntimePersistence(fixture.statePath).load();
  assert.equal(durable.generation, 2);
  assert.equal(durable.lifecycleStore.exportSnapshot().threads.length, 2);
});

test("旧实例的非 Job 保存不能把磁盘上的 completed Job 覆盖回 planning", async (t) => {
  const fixture = await createFixture(t);
  const seedPersistence = new JsonFileRuntimePersistence(fixture.statePath);
  const seed = await seedPersistence.load();
  const job = seed.agentRuntimeStore.createJob({
    threadId: "thread-stale-writer",
    rootTurnId: "turn-stale-writer",
    rootRunId: "run-stale-writer",
    configSnapshot: DEFAULT_AGENT_TEAM_CONFIG,
  });
  await saveLoadedState(seedPersistence, seed);

  const persistenceA = new JsonFileRuntimePersistence(fixture.statePath);
  const persistenceB = new JsonFileRuntimePersistence(fixture.statePath);
  const stateA = await persistenceA.load();
  const staleStateB = await persistenceB.load();

  stateA.agentRuntimeStore.setJobStatus(job.id, "completed");
  await saveLoadedState(persistenceA, stateA);

  staleStateB.lifecycleStore.createThread();
  await assert.rejects(
    () => saveLoadedState(persistenceB, staleStateB),
    (error) => {
      assert.ok(error instanceof SnapshotConflictError);
      assert.equal(error.name, "SnapshotConflict");
      assert.equal(error.code, "snapshot_conflict");
      assert.equal(error.expectedGeneration, 1);
      assert.equal(error.actualGeneration, 2);
      assert.match(error.message, /reload before retrying/);
      return true;
    },
  );

  const durable = await new JsonFileRuntimePersistence(fixture.statePath).load();
  assert.equal(durable.generation, 2);
  assert.equal(durable.agentRuntimeStore.getJob(job.id)?.status, "completed");

  // Discarding a reload result must not refresh authorization for stale Stores.
  staleStateB.generation = 2;
  await persistenceB.load();
  await assert.rejects(
    () => saveLoadedState(persistenceB, staleStateB),
    (error) => {
      assert.ok(error instanceof SnapshotConflictError);
      assert.equal(error.expectedGeneration, 1);
      assert.equal(error.actualGeneration, 2);
      return true;
    },
  );

  // Conflict recovery is explicit: reload drops the uncommitted stale view,
  // then the caller may reapply a known-safe local mutation and retry.
  const reloadedB = await persistenceB.load();
  assert.equal(reloadedB.generation, 2);
  assert.equal(reloadedB.lifecycleStore.exportSnapshot().threads.length, 0);
  reloadedB.lifecycleStore.createThread();
  await saveLoadedState(persistenceB, reloadedB);
  const afterExplicitRetry = await new JsonFileRuntimePersistence(fixture.statePath).load();
  assert.equal(afterExplicitRetry.generation, 3);
  assert.equal(afterExplicitRetry.agentRuntimeStore.getJob(job.id)?.status, "completed");
});

test("新加载状态不能与旧 AgentRuntime Store 混用后保存", async (t) => {
  const fixture = await createFixture(t);
  const seedPersistence = new JsonFileRuntimePersistence(fixture.statePath);
  const seed = await seedPersistence.load();
  const job = seed.agentRuntimeStore.createJob({
    threadId: "thread-mixed-state",
    rootTurnId: "turn-mixed-state",
    rootRunId: "run-mixed-state",
    configSnapshot: DEFAULT_AGENT_TEAM_CONFIG,
  });
  await saveLoadedState(seedPersistence, seed);

  const persistenceA = new JsonFileRuntimePersistence(fixture.statePath);
  const persistenceB = new JsonFileRuntimePersistence(fixture.statePath);
  const stateA = await persistenceA.load();
  const staleStateB = await persistenceB.load();
  stateA.agentRuntimeStore.setJobStatus(job.id, "completed");
  await saveLoadedState(persistenceA, stateA);

  const freshStateB = await persistenceB.load();
  freshStateB.agentRuntimeStore = staleStateB.agentRuntimeStore;
  await assert.rejects(
    async () => persistenceB.save(freshStateB),
    (error) => {
      assert.ok(error instanceof SnapshotStateIdentityError);
      assert.equal(error.name, "SnapshotConflict");
      assert.equal(error.code, "snapshot_state_identity_mismatch");
      return true;
    },
  );

  const durable = await new JsonFileRuntimePersistence(fixture.statePath).load();
  assert.equal(durable.generation, 2);
  assert.equal(durable.agentRuntimeStore.getJob(job.id)?.status, "completed");
});

test("两个进程同时保存同一 generation 时只有一个成功", async (t) => {
  const fixture = await createFixture(t);
  const goPath = join(fixture.directory, "save-go");
  const moduleUrl = pathToFileURL(join(
    process.cwd(),
    "src",
    "runtime",
    "json-file-runtime-persistence.ts",
  )).href;
  const children = ["a", "b"].map((id) => {
    const readyPath = join(fixture.directory, `ready-${id}`);
    const resultPath = join(fixture.directory, `result-${id}.json`);
    const program = `
      import { readFile, writeFile } from "node:fs/promises";
      import { JsonFileRuntimePersistence } from ${JSON.stringify(moduleUrl)};
      const persistence = new JsonFileRuntimePersistence(${JSON.stringify(fixture.statePath)}, {
        lockTimeoutMs: 2000,
        staleLockMs: 100,
        retryDelayMs: 1,
      });
      const state = await persistence.load();
      state.lifecycleStore.createThread();
      await writeFile(${JSON.stringify(readyPath)}, "ready");
      while (true) {
        try { await readFile(${JSON.stringify(goPath)}, "utf8"); break; }
        catch (error) {
          if (!String(error).includes("ENOENT")) throw error;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
      let result;
      try {
        await persistence.save(state);
        result = { ok: true };
      } catch (error) {
        result = {
          ok: false,
          name: error?.name,
          code: error?.code,
          expectedGeneration: error?.expectedGeneration,
          actualGeneration: error?.actualGeneration,
        };
      }
      await writeFile(${JSON.stringify(resultPath)}, JSON.stringify(result));
    `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", program],
      { cwd: process.cwd(), stdio: "ignore" },
    );
    t.after(() => child.kill());
    return { child, readyPath, resultPath };
  });
  const exits = children.map(({ child }) => waitForSuccessfulExit(child));
  await Promise.all(children.map(({ readyPath }) => waitForFile(readyPath)));
  await writeFile(goPath, "go");
  await Promise.all(exits);

  const results = await Promise.all(children.map(async ({ resultPath }) =>
    JSON.parse(await readFile(resultPath, "utf8")) as {
      ok: boolean;
      name?: string;
      code?: string;
      expectedGeneration?: number;
      actualGeneration?: number;
    }));
  assert.equal(results.filter((result) => result.ok).length, 1);
  const conflict = results.find((result) => !result.ok);
  assert.deepEqual(conflict, {
    ok: false,
    name: "SnapshotConflict",
    code: "snapshot_conflict",
    expectedGeneration: 0,
    actualGeneration: 1,
  });

  const durable = await new JsonFileRuntimePersistence(fixture.statePath).load();
  assert.equal(durable.generation, 1);
  assert.equal(durable.lifecycleStore.exportSnapshot().threads.length, 1);
});

test("快照 writer 崩溃后不会留下永久锁", async (t) => {
  const fixture = await createFixture(t);
  const readyPath = join(fixture.directory, "snapshot-lock-owner-ready");
  const moduleUrl = pathToFileURL(join(
    process.cwd(),
    "src",
    "runtime",
    "process-safe-file-lock.ts",
  )).href;
  const program = `
    import { writeFile } from "node:fs/promises";
    import { ProcessSafeFileLock } from ${JSON.stringify(moduleUrl)};
    const lock = new ProcessSafeFileLock(${JSON.stringify(`${fixture.statePath}.lock`)}, {
      staleLockMs: 10,
      retryDelayMs: 1,
    }, "Runtime snapshot");
    await lock.withLock(async () => {
      await writeFile(${JSON.stringify(readyPath)}, "ready");
      await new Promise((resolve) => setTimeout(resolve, 10000));
    });
  `;
  const lockOwner = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", program],
    { cwd: process.cwd(), stdio: "ignore" },
  );
  t.after(() => lockOwner.kill());
  const ownerExit = new Promise<void>((resolve, reject) => {
    lockOwner.once("error", reject);
    lockOwner.once("exit", () => resolve());
  });
  await waitForFile(readyPath);
  lockOwner.kill();
  await ownerExit;

  const persistence = new JsonFileRuntimePersistence(fixture.statePath, {
    lockTimeoutMs: 1_000,
    staleLockMs: 10,
    retryDelayMs: 1,
  });
  const state = await persistence.load();
  state.lifecycleStore.createThread();
  await saveLoadedState(persistence, state);

  const durable = JSON.parse(await readFile(fixture.statePath, "utf8")) as {
    version: number;
    generation: number;
  };
  assert.equal(durable.version, 7);
  assert.equal(durable.generation, 1);
});

test("Lease fenced commit 与普通保存共用 Snapshot CAS", async (t) => {
  const fixture = await createFixture(t);
  const seedPersistence = new JsonFileRuntimePersistence(fixture.statePath);
  const seed = await seedPersistence.load();
  const job = seed.agentRuntimeStore.createJob({
    threadId: "thread-fenced-cas",
    rootTurnId: "turn-fenced-cas",
    rootRunId: "run-fenced-cas",
    configSnapshot: DEFAULT_AGENT_TEAM_CONFIG,
  });
  await saveLoadedState(seedPersistence, seed);

  const persistenceA = new JsonFileRuntimePersistence(fixture.statePath);
  const persistenceB = new JsonFileRuntimePersistence(fixture.statePath);
  const stateA = await persistenceA.load();
  const staleStateB = await persistenceB.load();
  const leaseStore = new PersistentRuntimeLeaseStore(
    join(fixture.directory, "runtime-leases.json"),
  );
  const leaseA = await leaseStore.acquire({
    resource: { type: "job", id: job.id },
    ownerId: "process-a",
    ttlMs: 10_000,
  });

  stateA.agentRuntimeStore.setJobStatus(job.id, "completed");
  await leaseStore.withFencedCommit(leaseA, () =>
    saveLoadedState(persistenceA, stateA));

  const unrelatedLeaseB = await leaseStore.acquire({
    resource: { type: "job", id: "job-unrelated" },
    ownerId: "process-b",
    ttlMs: 10_000,
  });
  staleStateB.lifecycleStore.createThread();
  await assert.rejects(
    () => leaseStore.withFencedCommit(unrelatedLeaseB, () =>
      saveLoadedState(persistenceB, staleStateB)),
    (error) => {
      assert.ok(error instanceof SnapshotConflictError);
      assert.equal(error.expectedGeneration, 1);
      assert.equal(error.actualGeneration, 2);
      return true;
    },
  );
  await persistenceB.load();
  await assert.rejects(
    () => leaseStore.withFencedCommit(unrelatedLeaseB, () =>
      saveLoadedState(persistenceB, staleStateB)),
    (error) => {
      assert.ok(error instanceof SnapshotConflictError);
      assert.equal(error.expectedGeneration, 1);
      assert.equal(error.actualGeneration, 2);
      return true;
    },
  );

  const durable = await new JsonFileRuntimePersistence(fixture.statePath).load();
  assert.equal(durable.generation, 2);
  assert.equal(durable.agentRuntimeStore.getJob(job.id)?.status, "completed");
});

test("拒绝损坏的 Runtime 状态文件", async (t) => {
  const fixture = await createFixture(t);
  await mkdir(join(fixture.statePath, ".."), {
    recursive: true,
  });
  await writeFile(fixture.statePath, "not-json", "utf8");

  await assert.rejects(
    () => new JsonFileRuntimePersistence(
      fixture.statePath,
    ).load(),
    /Invalid runtime state file/,
  );
});

test("解析失败不会污染既有状态身份的 generation", async (t) => {
  const fixture = await createFixture(t);
  const persistence = new JsonFileRuntimePersistence(fixture.statePath);
  const original = await persistence.load();
  original.lifecycleStore.createThread();
  await persistence.save(original);
  const validText = await readFile(fixture.statePath, "utf8");
  const invalid = JSON.parse(validText) as Record<string, unknown>;
  invalid.generation = 2;
  invalid.lifecycle = { version: 999 };
  await writeFile(fixture.statePath, JSON.stringify(invalid), "utf8");

  await assert.rejects(
    () => persistence.load(),
    /Invalid runtime state file/,
  );

  await writeFile(fixture.statePath, validText, "utf8");
  const otherPersistence = new JsonFileRuntimePersistence(fixture.statePath);
  const current = await otherPersistence.load();
  current.lifecycleStore.createThread();
  await otherPersistence.save(current);

  await assert.rejects(
    () => persistence.save(original),
    (error) => {
      assert.ok(error instanceof SnapshotConflictError);
      assert.equal(error.expectedGeneration, 1);
      assert.equal(error.actualGeneration, 2);
      return true;
    },
  );
});

test("重启时把遗留的 in_progress Turn 恢复为 interrupted", async (t) => {
  const fixture = await createFixture(t);
  const persistence = new JsonFileRuntimePersistence(
    fixture.statePath,
  );
  const loaded = await persistence.load();
  const thread = loaded.lifecycleStore.createThread();
  const turn = loaded.lifecycleStore.createTurn(thread.id);
  loaded.lifecycleStore.appendItem(
    turn.id,
    "user_message",
    { text: "进程中断前的问题" },
  );
  await saveLoadedState(persistence, loaded);

  const restored = await new JsonFileRuntimePersistence(
    fixture.statePath,
  ).load();

  assert.deepEqual(restored.recoveredTurnIds, [turn.id]);
  assert.equal(
    restored.lifecycleStore.getTurn(turn.id)?.status,
    "interrupted",
  );

  const persistedAgain = await new JsonFileRuntimePersistence(
    fixture.statePath,
  ).load();
  assert.deepEqual(persistedAgain.recoveredTurnIds, []);
  assert.equal(
    persistedAgain.lifecycleStore.getTurn(turn.id)?.status,
    "interrupted",
  );
});

test("v1 快照迁移到 v7 并初始化 Agent Runtime 与 Requirement 数据", async (t) => {
  const fixture = await createFixture(t);
  const base = await new JsonFileRuntimePersistence(fixture.statePath).load();
  const legacy = {
    version: 1,
    lifecycle: base.lifecycleStore.exportSnapshot(),
    contextCheckpoints: base.contextCheckpointStore.exportSnapshot(),
  };
  await mkdir(join(fixture.statePath, ".."), { recursive: true });
  await writeFile(fixture.statePath, JSON.stringify(legacy), "utf8");
  const migrationPersistence = new JsonFileRuntimePersistence(fixture.statePath);
  const loaded = await migrationPersistence.load();
  assert.equal(loaded.restored, true);
  assert.deepEqual(loaded.agentRunStore.list(), []);
  await saveLoadedState(migrationPersistence, loaded);
  const persisted = JSON.parse(await readFile(fixture.statePath, "utf8")) as { version: number; generation: number };
  assert.equal(persisted.version, 7);
  assert.equal(persisted.generation, 1);
});

test("v1-v6 无 generation 快照均可加载并在首次保存时迁移", async (t) => {
  const fixture = await createFixture(t);
  const currentPersistence = new JsonFileRuntimePersistence(fixture.statePath);
  const current = await currentPersistence.load();
  await saveLoadedState(currentPersistence, current);
  const currentSnapshot = JSON.parse(
    await readFile(fixture.statePath, "utf8"),
  ) as Record<string, unknown>;

  for (const version of [1, 2, 3, 4, 5, 6]) {
    const legacy = structuredClone(currentSnapshot);
    legacy.version = version;
    delete legacy.generation;
    await writeFile(fixture.statePath, JSON.stringify(legacy), "utf8");

    const persistence = new JsonFileRuntimePersistence(fixture.statePath);
    const loaded = await persistence.load();
    assert.equal(loaded.generation, 0, `v${version} should start at generation zero`);
    await saveLoadedState(persistence, loaded);

    const migrated = JSON.parse(await readFile(fixture.statePath, "utf8")) as {
      version: number;
      generation: number;
    };
    assert.equal(migrated.version, 7);
    assert.equal(migrated.generation, 1);
  }
});

test("v4 快照加载后 ModelInvocation 默认为空", async (t) => {
  const fixture = await createFixture(t);
  const persistence = new JsonFileRuntimePersistence(fixture.statePath);
  const base = await persistence.load();
  await saveLoadedState(persistence, base);

  const legacy = JSON.parse(
    await readFile(fixture.statePath, "utf8"),
  ) as { version: number; modelInvocations?: unknown };
  legacy.version = 4;
  delete legacy.modelInvocations;
  await writeFile(fixture.statePath, JSON.stringify(legacy), "utf8");

  const loaded = await new JsonFileRuntimePersistence(fixture.statePath).load();
  assert.equal(loaded.restored, true);
  assert.deepEqual(loaded.modelInvocationStore.list(), []);
});

test("v5 快照加载后 ToolInvocation 默认为空", async (t) => {
  const fixture = await createFixture(t);
  const persistence = new JsonFileRuntimePersistence(fixture.statePath);
  const base = await persistence.load();
  await saveLoadedState(persistence, base);

  const legacy = JSON.parse(
    await readFile(fixture.statePath, "utf8"),
  ) as { version: number; toolInvocations?: unknown };
  legacy.version = 5;
  delete legacy.toolInvocations;
  await writeFile(fixture.statePath, JSON.stringify(legacy), "utf8");

  const loaded = await new JsonFileRuntimePersistence(fixture.statePath).load();
  assert.equal(loaded.restored, true);
  assert.deepEqual(loaded.toolInvocationStore.list(), []);
});

test("v7 快照往返保留 ModelInvocation WAL", async (t) => {
  const fixture = await createFixture(t);
  const persistence = new JsonFileRuntimePersistence(fixture.statePath);
  const loaded = await persistence.load();
  const invocation = loaded.modelInvocationStore.prepare({
    threadId: "thread-wal",
    turnId: "turn-wal",
    round: 0,
    purpose: "workflow_stage",
    jobId: "job-wal",
    jobAttempt: 1,
    stageId: "product",
    stageAttempt: 1,
    requestDigest: createModelRequestDigest({ prompt: "persist WAL" }),
    provider: "openai",
    model: "gpt-5.6",
  });
  loaded.modelInvocationStore.markSubmitted(invocation.invocationId);
  loaded.modelInvocationStore.recordResponse(invocation.invocationId, {
    providerResponseId: "response-wal",
    normalizedResult: { text: "persisted result", functionCalls: [] },
  });
  const expected = loaded.modelInvocationStore.exportSnapshot();

  await saveLoadedState(persistence, loaded);

  const persisted = JSON.parse(
    await readFile(fixture.statePath, "utf8"),
  ) as { version: number; modelInvocations?: unknown };
  assert.equal(persisted.version, 7);
  assert.deepEqual(persisted.modelInvocations, expected);

  const restored = await new JsonFileRuntimePersistence(fixture.statePath).load();
  assert.deepEqual(restored.modelInvocationStore.exportSnapshot(), expected);
  assert.equal(
    restored.modelInvocationStore.get(invocation.invocationId)?.status,
    "response_received",
  );
  assert.deepEqual(
    restored.modelInvocationStore.get(invocation.invocationId)?.normalizedResult,
    { text: "persisted result", functionCalls: [] },
  );
});

test("v7 快照往返保留 ToolInvocation WAL", async (t) => {
  const fixture = await createFixture(t);
  const persistence = new JsonFileRuntimePersistence(fixture.statePath);
  const loaded = await persistence.load();
  const invocation = loaded.toolInvocationStore.prepare({
    modelInvocationId: "model-invocation-tool-wal",
    callId: "call-tool-wal",
    toolName: "durable_tool",
    argumentsDigest: createToolArgumentsDigest({
      path: "README.md",
      value: 1,
    }),
  });
  loaded.toolInvocationStore.markExecuting(invocation.toolInvocationId);
  loaded.toolInvocationStore.recordResult(invocation.toolInvocationId, {
    result: { ok: true, value: 1 },
    output: '{"ok":true,"value":1}',
  });
  const expected = loaded.toolInvocationStore.exportSnapshot();

  await saveLoadedState(persistence, loaded);

  const persisted = JSON.parse(
    await readFile(fixture.statePath, "utf8"),
  ) as { version: number; toolInvocations?: unknown };
  assert.equal(persisted.version, 7);
  assert.deepEqual(persisted.toolInvocations, expected);

  const restored = await new JsonFileRuntimePersistence(fixture.statePath).load();
  assert.deepEqual(restored.toolInvocationStore.exportSnapshot(), expected);
  assert.equal(
    restored.toolInvocationStore.get(invocation.toolInvocationId)?.status,
    "result_received",
  );
  assert.equal(
    restored.toolInvocationStore.get(invocation.toolInvocationId)?.toolName,
    "durable_tool",
  );
});

test("Runtime Snapshot 保留恢复所需业务原文，仅排除 Provider 凭据与认证头", async (t) => {
  const fixture = await createFixture(t);
  const persistence = new JsonFileRuntimePersistence(fixture.statePath);
  const loaded = await persistence.load();
  const thread = loaded.lifecycleStore.createThread();
  const turn = loaded.lifecycleStore.createTurn(thread.id);
  loaded.lifecycleStore.appendItem(turn.id, "user_message", {
    text: "用户业务原文：论文实验与项目路径必须可恢复",
  });
  const modelInvocation = loaded.modelInvocationStore.prepare({
    threadId: thread.id,
    turnId: turn.id,
    round: 0,
    purpose: "initial",
    requestDigest: createModelRequestDigest({ prompt: "论文实验" }),
    provider: "openai",
    model: "test-model",
  });
  loaded.modelInvocationStore.markSubmitted(modelInvocation.invocationId);
  loaded.modelInvocationStore.recordResponse(modelInvocation.invocationId, {
    providerResponseId: "response-business-content",
    normalizedResult: {
      text: "模型业务文本：保留研究结论",
      functionCalls: [{
        callId: "call-business",
        name: "research_tool",
        arguments: JSON.stringify({ topic: "科研恢复", authorization: "Bearer provider-secret" }),
      }],
    },
  });
  const toolInvocation = loaded.toolInvocationStore.prepare({
    modelInvocationId: modelInvocation.invocationId,
    callId: "call-business",
    toolName: "research_tool",
    argumentsDigest: createToolArgumentsDigest({ topic: "科研恢复" }),
  });
  loaded.toolInvocationStore.markExecuting(toolInvocation.toolInvocationId);
  loaded.toolInvocationStore.recordResult(toolInvocation.toolInvocationId, {
    result: {
      businessText: "工具业务结果：实验通过",
      tokenCount: 42,
      apiKey: "sk-provider-secret",
    },
    output: JSON.stringify({
      businessText: "工具输出原文",
      authorization: "Bearer provider-secret",
    }),
  });

  await saveLoadedState(persistence, loaded);

  const serialized = await readFile(fixture.statePath, "utf8");
  assert.match(serialized, /用户业务原文：论文实验与项目路径必须可恢复/);
  assert.match(serialized, /模型业务文本：保留研究结论/);
  assert.match(serialized, /科研恢复/);
  assert.match(serialized, /工具业务结果：实验通过/);
  assert.match(serialized, /工具输出原文/);
  assert.match(serialized, /tokenCount/);
  assert.doesNotMatch(serialized, /provider-secret|sk-provider-secret/);
  assert.match(serialized, /\[REDACTED\]/);
});

test("v2 恢复 Thread 配置、RuntimeSession 和 run_return 收据", async (t) => {
  const fixture = await createFixture(t);
  const persistence = new JsonFileRuntimePersistence(fixture.statePath);
  const loaded = await persistence.load();
  const thread = loaded.lifecycleStore.createThread();
  const turn = loaded.lifecycleStore.createTurn(thread.id);
  loaded.lifecycleStore.appendItem(turn.id, "user_message", { text: "restore" });
  const run = loaded.agentRunStore.ensureRoot(thread.id, turn.id);
  const result = { runId: run.id, status: "completed" as const, summary: "done" };
  loaded.agentRunStore.complete(run.id, result);
  loaded.agentRunStore.receiveReturn(result);
  loaded.threadConfigs.push({
    threadId: thread.id,
    model: "gpt-5.6-terra",
    reasoningEffort: "xhigh",
    agentProfileId: "orchestrator",
  });
  loaded.runtimeSessions.push({
    threadId: thread.id,
    turnState: "completed",
    session: { turnId: turn.id, status: "completed", startedAt: "2026-08-12T00:00:00.000Z", completedAt: "2026-08-12T00:00:01.000Z", items: [] },
  });
  await saveLoadedState(persistence, loaded);
  const restored = await new JsonFileRuntimePersistence(fixture.statePath).load();
  assert.equal(restored.threadConfigs[0]?.model, "gpt-5.6-terra");
  assert.equal(restored.runtimeSessions[0]?.session.status, "completed");
  assert.equal(restored.agentRunStore.receiveReturn(result), false);
});
