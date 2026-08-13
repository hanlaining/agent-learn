import assert from "node:assert/strict";
import test from "node:test";

import {
  LifecycleStore,
} from "../src/runtime/lifecycle-store.js";

function createStore(): LifecycleStore {
  return new LifecycleStore({
    now: () => "2026-08-01T09:00:00.000Z",
  });
}

test("创建财务分析 Thread", () => {
  const store = createStore();

  const thread = store.createThread();

  assert.equal(thread.status, "active");
  assert.deepEqual(thread.turnIds, []);
  assert.equal(
    thread.createdAt,
    "2026-08-01T09:00:00.000Z",
  );
});

test("Thread 下可以创建 Turn", () => {
  const store = createStore();

  const thread = store.createThread();
  const turn = store.createTurn(thread.id);

  assert.equal(turn.threadId, thread.id);
  assert.equal(turn.status, "in_progress");

  assert.deepEqual(thread.turnIds, [
    turn.id,
  ]);
});

test("财务问题可以作为 Item 加入 Turn", () => {
  const store = createStore();

  const thread = store.createThread();
  const turn = store.createTurn(thread.id);

  const item = store.appendItem(
    turn.id,
    "user_message",
    {
      text: "分析 2026 年 7 月餐饮支出",
      domain: "finance",
    },
  );

  assert.equal(item.threadId, thread.id);
  assert.equal(item.turnId, turn.id);
  assert.equal(item.type, "user_message");

  assert.deepEqual(item.content, {
    text: "分析 2026 年 7 月餐饮支出",
    domain: "finance",
  });

  assert.deepEqual(turn.itemIds, [
    item.id,
  ]);
});

test("完成 Turn 后不能继续添加 Item", () => {
  const store = createStore();

  const thread = store.createThread();
  const turn = store.createTurn(thread.id);

  store.completeTurn(turn.id);

  assert.equal(turn.status, "completed");
  assert.equal(
    turn.completedAt,
    "2026-08-01T09:00:00.000Z",
  );

  assert.throws(
    () => {
      store.appendItem(
        turn.id,
        "assistant_message",
        {
          text: "财务分析结果",
        },
      );
    },
    /Turn is not in progress/,
  );
});

test("不能在不存在的 Thread 下创建 Turn", () => {
  const store = createStore();

  assert.throws(
    () => store.createTurn("missing-thread"),
    /Thread not found/,
  );
});

test("失败的 Turn 进入 failed 终态", () => {
  const store = createStore();

  const thread = store.createThread();
  const turn = store.createTurn(thread.id);

  store.failTurn(turn.id);

  assert.equal(turn.status, "failed");
  assert.equal(
    turn.completedAt,
    "2026-08-01T09:00:00.000Z",
  );

  assert.throws(
    () => store.appendItem(
      turn.id,
      "assistant_message",
      { text: "不应写入" },
    ),
    /Turn is not in progress/,
  );
});

test("取消的 Turn 进入 interrupted 终态", () => {
  const store = createStore();
  const thread = store.createThread();
  const turn = store.createTurn(thread.id);

  store.interruptTurn(turn.id);

  assert.equal(turn.status, "interrupted");
  assert.equal(
    turn.completedAt,
    "2026-08-01T09:00:00.000Z",
  );
  assert.throws(
    () => store.appendItem(
      turn.id,
      "assistant_message",
      { text: "不应写入" },
    ),
    /Turn is not in progress/,
  );
});

test("超时的 Turn 进入 timed_out 终态", () => {
  const store = createStore();
  const thread = store.createThread();
  const turn = store.createTurn(thread.id);

  store.timeoutTurn(turn.id);

  assert.equal(turn.status, "timed_out");
  assert.equal(
    turn.completedAt,
    "2026-08-01T09:00:00.000Z",
  );
});
