import assert from "node:assert/strict";
import test from "node:test";

import {
  ContextCheckpointStore,
} from "../src/runtime/context-checkpoint-store.js";

test("按 Thread 递增记录 Context Window", () => {
  let sequence = 0;
  const store = new ContextCheckpointStore({
    now: () => "2026-08-02T09:00:00.000Z",
    createId: () => {
      sequence += 1;
      return `checkpoint-${sequence}`;
    },
  });

  const first = store.record({
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
  const second = store.record({
    threadId: "thread-1",
    throughTurnId: "turn-2",
    replacementMessages: [
      {
        role: "assistant",
        text: "[Context checkpoint]\n第二窗口",
      },
    ],
    beforeTokens: 110,
    afterTokens: 45,
  });

  assert.equal(first.windowNumber, 1);
  assert.equal(first.previousCheckpointId, undefined);
  assert.equal(second.windowNumber, 2);
  assert.equal(
    second.previousCheckpointId,
    first.id,
  );
  assert.deepEqual(
    store.getLatest("thread-1"),
    second,
  );
  assert.equal(
    store.getLatest("missing-thread"),
    undefined,
  );
});
