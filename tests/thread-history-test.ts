import assert from "node:assert/strict";
import test from "node:test";

import {
  LifecycleStore,
} from "../src/runtime/lifecycle-store.js";
import {
  isThreadHistoryResult,
  readThreadHistory,
} from "../src/runtime/thread-history.js";

test("Thread 历史只公开 User 和 Assistant 消息", () => {
  let sequence = 0;
  const store = new LifecycleStore({
    now: () => "2026-08-06T10:00:00.000Z",
    createId: (prefix) => `${prefix}-${++sequence}`,
  });
  const thread = store.createThread();
  const turn = store.createTurn(thread.id);

  store.appendItem(turn.id, "user_message", {
    text: "读取当前项目",
  });
  store.appendItem(turn.id, "tool_call", {
    name: "read_file",
    arguments: { path: "private-path" },
  });
  store.appendItem(turn.id, "tool_result", {
    secret: "must-not-cross-history-boundary",
  });
  store.appendItem(turn.id, "runtime_message", {
    text: "Runtime recovery detail must stay internal",
  });
  store.appendItem(turn.id, "assistant_message", {
    text: "项目读取完成。",
  });
  store.completeTurn(turn.id);

  const result = readThreadHistory(store, thread.id);

  assert.ok(isThreadHistoryResult(result));
  assert.deepEqual(
    result.messages.map(({ role, text }) => ({ role, text })),
    [
      { role: "user", text: "读取当前项目" },
      { role: "assistant", text: "项目读取完成。" },
    ],
  );
  assert.doesNotMatch(JSON.stringify(result), /private-path|secret|Runtime recovery detail/);
});

test("旧版 Runtime 恢复伪用户消息加载后迁移为内部消息", () => {
  const source = new LifecycleStore();
  const thread = source.createThread();
  const turn = source.createTurn(thread.id);
  source.appendItem(turn.id, "user_message", { text: "Runtime 重启恢复：以下子 Agent 结果已经持久化并等待自动继续" });
  source.appendItem(turn.id, "assistant_message", { text: "恢复完成" });
  source.completeTurn(turn.id);
  const restored = LifecycleStore.fromSnapshot(source.exportSnapshot());
  assert.deepEqual(readThreadHistory(restored, thread.id).messages.map((item) => item.text), ["恢复完成"]);
  assert.equal(restored.getItemsForTurn(turn.id)[0]?.type, "runtime_message");
});
