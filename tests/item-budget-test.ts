import assert from "node:assert/strict";
import test from "node:test";

import type {
  LlmFunctionOutput,
  LlmMessage,
} from "../src/llm/types.js";
import {
  InputItemBudgetExceededError,
  ItemBudget,
} from "../src/runtime/item-budget.js";

const STATELESS_OPTIONS = {
  maxInputItems: 128,
  compactThresholdItems: 120,
  functionOutputItemCost: 2 as const,
};

function createMessages(count: number): LlmMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    text: "x",
  }));
}

function createFunctionOutputs(
  count: number,
): LlmFunctionOutput[] {
  return Array.from({ length: count }, (_, index) => ({
    callId: `call-${index}`,
    name: "diagnostic_tool",
    arguments: `{"secretArgument":"argument-${index}"}`,
    output: `secret-output-${index}`,
  }));
}

test("字符串和普通消息各按一个 Provider item 计数", () => {
  const budget = new ItemBudget(STATELESS_OPTIONS);

  assert.equal(budget.assess("hello").estimatedItems, 1);
  assert.equal(
    budget.assess(createMessages(3)).estimatedItems,
    3,
  );
  assert.equal(budget.assess([]).estimatedItems, 0);
});

test("119 不压缩，120 达到 Runtime 软阈值", () => {
  const budget = new ItemBudget(STATELESS_OPTIONS);
  const belowThreshold = budget.assess(createMessages(119));
  const atThreshold = budget.assess(createMessages(120));

  assert.equal(belowThreshold.shouldCompact, false);
  assert.equal(belowThreshold.remainingItems, 9);
  assert.equal(atThreshold.shouldCompact, true);
  assert.equal(atThreshold.exceedsLimit, false);
  assert.equal(atThreshold.remainingItems, 8);
});

test("127、128、129 和 135 覆盖 Provider 硬边界", () => {
  const budget = new ItemBudget(STATELESS_OPTIONS);

  for (const count of [127, 128]) {
    const assessment = budget.assess(createMessages(count));

    assert.equal(assessment.estimatedItems, count);
    assert.equal(assessment.exceedsLimit, false);
    assert.doesNotThrow(() => {
      budget.assertWithinLimit(createMessages(count));
    });
  }

  for (const count of [129, 135]) {
    const assessment = budget.assess(createMessages(count));

    assert.equal(assessment.estimatedItems, count);
    assert.equal(assessment.exceedsLimit, true);
    assert.throws(
      () => budget.assertWithinLimit(createMessages(count)),
      InputItemBudgetExceededError,
    );
  }
});

test("无状态 Function Output 按两个 Provider items 计数", () => {
  const budget = new ItemBudget(STATELESS_OPTIONS);

  assert.deepEqual(
    budget.assessFunctionOutputCount(64),
    budget.assess(createFunctionOutputs(64)),
  );
  assert.equal(
    budget.assess(createFunctionOutputs(64)).estimatedItems,
    128,
  );
  assert.equal(
    budget.assess(createFunctionOutputs(64)).exceedsLimit,
    false,
  );
  assert.equal(
    budget.assess(createFunctionOutputs(65)).estimatedItems,
    130,
  );
  assert.equal(
    budget.assess(createFunctionOutputs(65)).exceedsLimit,
    true,
  );
});

test("有状态 Function Output 按一个 Provider item 计数", () => {
  const budget = new ItemBudget({
    ...STATELESS_OPTIONS,
    functionOutputItemCost: 1,
  });

  assert.equal(
    budget.assess(createFunctionOutputs(65)).estimatedItems,
    65,
  );
  assert.equal(
    budget.assessFunctionOutputCount(65).estimatedItems,
    65,
  );
});

test("拒绝非法 Item Budget 配置和 Function Output 数量", () => {
  assert.throws(
    () => new ItemBudget({
      ...STATELESS_OPTIONS,
      maxInputItems: 0,
    }),
    /maxInputItems must be a positive integer/,
  );
  assert.throws(
    () => new ItemBudget({
      ...STATELESS_OPTIONS,
      compactThresholdItems: 129,
    }),
    /compactThresholdItems must not exceed maxInputItems/,
  );
  assert.throws(
    () => new ItemBudget({
      ...STATELESS_OPTIONS,
      functionOutputItemCost: 3 as 1,
    }),
    /functionOutputItemCost must be 1 or 2/,
  );

  const budget = new ItemBudget(STATELESS_OPTIONS);
  assert.throws(
    () => budget.assessFunctionOutputCount(-1),
    /count must be a non-negative integer/,
  );
});

test("超限错误只包含安全计数", () => {
  const budget = new ItemBudget(STATELESS_OPTIONS);
  const input = createFunctionOutputs(65);

  assert.throws(
    () => budget.assertWithinLimit(input),
    (error: unknown) => {
      assert.ok(error instanceof InputItemBudgetExceededError);
      assert.equal(error.estimatedItems, 130);
      assert.equal(error.maxInputItems, 128);
      assert.equal(
        error.message,
        "Provider input item limit exceeded: 130 > 128",
      );
      assert.doesNotMatch(error.message, /secretArgument/);
      assert.doesNotMatch(error.message, /secret-output/);
      assert.doesNotMatch(error.message, /diagnostic_tool/);
      return true;
    },
  );
});
