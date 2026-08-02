import assert from "node:assert/strict";
import test from "node:test";

import {
  ContextBuilder,
} from "../src/runtime/context-builder.js";
import {
  LifecycleStore,
} from "../src/runtime/lifecycle-store.js";
import {
  ContextCheckpointStore,
} from "../src/runtime/context-checkpoint-store.js";

function createStore(): LifecycleStore {
  return new LifecycleStore({
    // 所有对象故意使用相同时间，证明 Context 顺序不依赖时间戳排序。
    now: () => "2026-08-02T09:00:00.000Z",
  });
}

test("按 Turn 生命周期顺序构建跨 Turn 消息", () => {
  const store = createStore();
  const thread = store.createThread();

  const firstTurn = store.createTurn(thread.id);
  store.appendItem(firstTurn.id, "user_message", {
    text: "分析 2026 年 7 月财务",
  });
  store.appendItem(firstTurn.id, "tool_call", {
    name: "finance_monthly_summary",
  });
  store.appendItem(firstTurn.id, "tool_result", {
    result: "deterministic finance result",
  });
  store.appendItem(firstTurn.id, "assistant_message", {
    text: "净现金流为 ¥6,850.00",
  });
  store.completeTurn(firstTurn.id);

  const failedTurn = store.createTurn(thread.id);
  store.appendItem(failedTurn.id, "user_message", {
    text: "这条失败消息不应进入 Context",
  });
  store.failTurn(failedTurn.id);

  const currentTurn = store.createTurn(thread.id);
  store.appendItem(currentTurn.id, "user_message", {
    text: "刚才最大的支出是什么？",
  });

  const context = new ContextBuilder(store).build(
    currentTurn.id,
  );

  assert.deepEqual(context, [
    {
      role: "user",
      text: "分析 2026 年 7 月财务",
    },
    {
      role: "assistant",
      text: "净现金流为 ¥6,850.00",
    },
    {
      role: "user",
      text: "刚才最大的支出是什么？",
    },
  ]);
});

test("当前 Turn 缺少有效用户消息时拒绝构建 Context", () => {
  const store = createStore();
  const thread = store.createThread();
  const currentTurn = store.createTurn(thread.id);

  const builder = new ContextBuilder(store);

  assert.throws(
    () => builder.build(currentTurn.id),
    /Current Turn has no valid user message/,
  );
});

test("从最新 Checkpoint 继续追加后续对话", () => {
  const store = createStore();
  const checkpointStore = new ContextCheckpointStore();
  const thread = store.createThread();

  const oldTurn = store.createTurn(thread.id);
  store.appendItem(oldTurn.id, "user_message", {
    text: "不应重新出现的旧问题",
  });
  store.appendItem(oldTurn.id, "assistant_message", {
    text: "不应重新出现的旧回答",
  });
  store.completeTurn(oldTurn.id);

  const boundaryTurn = store.createTurn(thread.id);
  store.appendItem(boundaryTurn.id, "user_message", {
    text: "边界问题",
  });
  store.appendItem(boundaryTurn.id, "assistant_message", {
    text: "边界回答",
  });
  store.completeTurn(boundaryTurn.id);

  checkpointStore.record({
    threadId: thread.id,
    throughTurnId: boundaryTurn.id,
    replacementMessages: [
      {
        role: "assistant",
        text: "[Context checkpoint]\n旧历史摘要",
      },
      {
        role: "user",
        text: "边界问题",
      },
    ],
    beforeTokens: 100,
    afterTokens: 40,
  });

  const currentTurn = store.createTurn(thread.id);
  store.appendItem(currentTurn.id, "user_message", {
    text: "继续追问",
  });

  const context = new ContextBuilder(
    store,
    checkpointStore,
  ).build(currentTurn.id);

  assert.deepEqual(context, [
    {
      role: "assistant",
      text: "[Context checkpoint]\n旧历史摘要",
    },
    {
      role: "user",
      text: "边界问题",
    },
    {
      role: "assistant",
      text: "边界回答",
    },
    {
      role: "user",
      text: "继续追问",
    },
  ]);
});
