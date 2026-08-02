import assert from "node:assert/strict";
import test from "node:test";

import {
  TokenBudget,
} from "../src/runtime/token-budget.js";

test("确定性估算中英文消息并判断压缩阈值", () => {
  const budget = new TokenBudget({
    maxContextTokens: 20,
    compactThresholdTokens: 11,
  });

  const assessment = budget.assess([
    {
      role: "user",
      text: "abcd",
    },
    {
      role: "assistant",
      text: "你好",
    },
  ]);

  assert.deepEqual(assessment, {
    estimatedTokens: 11,
    remainingTokens: 9,
    maxContextTokens: 20,
    compactThresholdTokens: 11,
    shouldCompact: true,
  });
});

test("未达到阈值时保留剩余预算", () => {
  const budget = new TokenBudget({
    maxContextTokens: 12,
    compactThresholdTokens: 10,
  });

  const assessment = budget.assess([
    {
      role: "user",
      text: "abcd",
    },
  ]);

  assert.equal(assessment.estimatedTokens, 5);
  assert.equal(assessment.remainingTokens, 7);
  assert.equal(assessment.shouldCompact, false);
});

test("拒绝超过 Context Window 的压缩阈值", () => {
  assert.throws(
    () => new TokenBudget({
      maxContextTokens: 10,
      compactThresholdTokens: 11,
    }),
    /compactThresholdTokens must not exceed maxContextTokens/,
  );
});
