import assert from "node:assert/strict";
import test from "node:test";

import {
  ContextCheckpointStore,
} from "../src/runtime/context-checkpoint-store.js";
import {
  LifecycleStore,
} from "../src/runtime/lifecycle-store.js";

test("LifecycleStore 快照可恢复顺序与 ID 序列", () => {
  const original = new LifecycleStore({
    now: () => "2026-08-02T09:00:00.000Z",
  });
  const thread = original.createThread();
  const turn = original.createTurn(thread.id);
  const item = original.appendItem(
    turn.id,
    "user_message",
    { text: "你好" },
  );
  original.completeTurn(turn.id);

  const snapshot = original.exportSnapshot();
  const restored = LifecycleStore.fromSnapshot(
    snapshot,
    { now: () => "2026-08-02T10:00:00.000Z" },
  );

  assert.deepEqual(restored.getThread(thread.id), thread);
  assert.deepEqual(restored.getTurn(turn.id), turn);
  assert.deepEqual(restored.getItem(item.id), item);
  assert.equal(restored.createThread().id, "thread-4");

  // 恢复后的 Store 必须拥有自己的副本，不能与输入快照共享数组。
  snapshot.threads[0]!.turnIds.push("turn-corrupted");
  assert.deepEqual(
    restored.getThread(thread.id)?.turnIds,
    [turn.id],
  );
});

test("LifecycleStore 拒绝引用缺失的快照", () => {
  assert.throws(
    () => LifecycleStore.fromSnapshot({
      version: 1,
      idSequence: 1,
      threads: [
        {
          id: "thread-1",
          status: "active",
          createdAt: "2026-08-02T09:00:00.000Z",
          turnIds: ["turn-missing"],
        },
      ],
      turns: [],
      items: [],
    }),
    /Invalid lifecycle snapshot/,
  );
});

test("ContextCheckpointStore 快照恢复完整窗口链", () => {
  const original = new ContextCheckpointStore({
    now: () => "2026-08-02T09:00:00.000Z",
  });
  original.record({
    threadId: "thread-1",
    throughTurnId: "turn-1",
    replacementMessages: [
      {
        role: "assistant",
        text: "[Context checkpoint]\n第一窗口",
      },
    ],
    beforeTokens: 100,
    afterTokens: 40,
  });
  const second = original.record({
    threadId: "thread-1",
    throughTurnId: "turn-2",
    replacementMessages: [
      {
        role: "assistant",
        text: "[Context checkpoint]\n第二窗口",
      },
    ],
    beforeTokens: 120,
    afterTokens: 45,
  });

  const restored = ContextCheckpointStore.fromSnapshot(
    original.exportSnapshot(),
    { now: () => "2026-08-02T10:00:00.000Z" },
  );

  assert.deepEqual(restored.getLatest("thread-1"), second);

  const third = restored.record({
    threadId: "thread-1",
    throughTurnId: "turn-3",
    replacementMessages: [
      { role: "user", text: "继续" },
    ],
    beforeTokens: 130,
    afterTokens: 50,
  });

  assert.equal(third.id, "checkpoint-3");
  assert.equal(third.windowNumber, 3);
  assert.equal(third.previousCheckpointId, second.id);
});
