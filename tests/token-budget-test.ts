import assert from "node:assert/strict";
import test from "node:test";

import {
  TokenBudget,
  estimateTextTokens,
} from "../src/runtime/token-budget.js";

test("使用 o200k_base 计算中英文消息并判断压缩阈值", () => {
  const budget = new TokenBudget({
    maxContextTokens: 20,
    compactThresholdTokens: 10,
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
    estimatedTokens: 10,
    remainingTokens: 10,
    maxContextTokens: 20,
    compactThresholdTokens: 10,
    shouldCompact: true,
  });
});

test("正文 Token 使用真实 BPE 而不是字符数近似", () => {
  assert.equal(estimateTextTokens("hello world"), 2);
  assert.equal(estimateTextTokens("你好，世界"), 3);
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
