import assert from "node:assert/strict";
import test from "node:test";

import {
  CliMessageQueue,
} from "../src/cli/message-queue.js";

test("CLI 输入队列按 FIFO 返回消息", () => {
  const queue = new CliMessageQueue();

  assert.equal(queue.enqueue("first"), 1);
  assert.equal(queue.enqueue("second"), 2);
  assert.equal(queue.size, 2);
  assert.equal(queue.dequeue(), "first");
  assert.equal(queue.dequeue(), "second");
  assert.equal(queue.dequeue(), undefined);
});

test("CLI 输入队列可在退出时清空", () => {
  const queue = new CliMessageQueue();
  queue.enqueue("first");
  queue.enqueue("second");

  assert.equal(queue.clear(), 2);
  assert.equal(queue.size, 0);
});
