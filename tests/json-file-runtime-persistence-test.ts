import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, {
  type TestContext,
} from "node:test";

import {
  JsonFileRuntimePersistence,
} from "../src/runtime/json-file-runtime-persistence.js";

async function createFixture(t: TestContext) {
  const directory = await mkdtemp(
    join(tmpdir(), "agent-runtime-state-"),
  );
  t.after(() => rm(directory, {
    recursive: true,
    force: true,
  }));

  return {
    statePath: join(directory, "nested", "state.json"),
  };
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

  await persistence.save(
    loaded.lifecycleStore,
    loaded.contextCheckpointStore,
  );

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
  assert.equal(json.version, 1);
});

test("后续保存覆盖旧快照且保持合法 JSON", async (t) => {
  const fixture = await createFixture(t);
  const persistence = new JsonFileRuntimePersistence(
    fixture.statePath,
  );
  const loaded = await persistence.load();

  loaded.lifecycleStore.createThread();
  await persistence.save(
    loaded.lifecycleStore,
    loaded.contextCheckpointStore,
  );
  loaded.lifecycleStore.createThread();
  await persistence.save(
    loaded.lifecycleStore,
    loaded.contextCheckpointStore,
  );

  const restored = await persistence.load();
  assert.equal(
    restored.lifecycleStore.exportSnapshot().threads.length,
    2,
  );
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
  await persistence.save(
    loaded.lifecycleStore,
    loaded.contextCheckpointStore,
  );

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
