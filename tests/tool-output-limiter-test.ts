import assert from "node:assert/strict";
import test from "node:test";

import {
  ToolOutputLimiter,
} from "../src/runtime/tool-output-limiter.js";
import type {
  TokenCounter,
} from "../src/runtime/token-counter.js";

const CHARACTER_COUNTER: TokenCounter = {
  countText: (text) => [...text].length,
  countMessages: (messages) =>
    messages.reduce(
      (total, message) => total + [...message.text].length,
      0,
    ),
};

test("限制交给模型的 Tool Output，但不修改原对象", () => {
  const limiter = new ToolOutputLimiter({
    maxOutputTokens: 70,
    tokenCounter: CHARACTER_COUNTER,
  });
  const original = {
    callId: "call-1",
    name: "read_file",
    arguments: "{}",
    output: "开头" + "很长".repeat(100) + "结尾",
  };

  const [limited] = limiter.limit([original]);

  assert.ok(limited);
  assert.equal(original.output.endsWith("结尾"), true);
  assert.notEqual(limited.output, original.output);
  assert.equal(
    CHARACTER_COUNTER.countText(limited.output) <= 70,
    true,
  );
  assert.match(limited.output, /tool output truncated/);
  assert.equal(limited.output.endsWith("结尾"), true);
});

test("未超预算的 Tool Output 保持原文", () => {
  const limiter = new ToolOutputLimiter({
    maxOutputTokens: 20,
    tokenCounter: CHARACTER_COUNTER,
  });
  const [limited] = limiter.limit([
    {
      callId: "call-2",
      name: "read_file",
      arguments: "{}",
      output: "短结果",
    },
  ]);

  assert.equal(limited?.output, "短结果");
});
