import assert from "node:assert/strict";
import test from "node:test";

import {
  sampleTransactions,
} from "../src/domains/finance/fixtures.js";
import {
  parseMonthlySummaryRequest,
  summarizeMonthlyTransactions,
} from "../src/domains/finance/summary.js";

test("汇总 2026-07 的模拟金融流水", () => {
  const summary = summarizeMonthlyTransactions(
    sampleTransactions,
    {
      period: "2026-07",
    },
  );

  assert.equal(summary.totalIncome.minorUnits, 1_000_000);
  assert.equal(summary.totalExpense.minorUnits, 315_000);
  assert.equal(summary.netCashFlow.minorUnits, 685_000);
  assert.equal(summary.transactionCount, 5);

  assert.deepEqual(summary.expensesByCategory, [
    {
      category: "housing",
      amount: {
        minorUnits: 300_000,
        currency: "CNY",
      },
    },
    {
      category: "food",
      amount: {
        minorUnits: 12_000,
        currency: "CNY",
      },
    },
    {
      category: "transport",
      amount: {
        minorUnits: 3_000,
        currency: "CNY",
      },
    },
  ]);
});

test("没有匹配流水的月份返回零值", () => {
  const summary = summarizeMonthlyTransactions(
    sampleTransactions,
    {
      period: "2026-08",
    },
  );

  assert.equal(summary.totalIncome.minorUnits, 0);
  assert.equal(summary.totalExpense.minorUnits, 0);
  assert.equal(summary.netCashFlow.minorUnits, 0);
  assert.equal(summary.transactionCount, 0);
  assert.deepEqual(summary.expensesByCategory, []);
});

test("拒绝不合法的月份参数", () => {
  assert.throws(
    () => parseMonthlySummaryRequest({ period: "2026-13" }),
    /period must use YYYY-MM format/,
  );
});

test("可以解析带 accountId 的请求参数", () => {
  assert.deepEqual(
    parseMonthlySummaryRequest({
      period: "2026-07",
      accountId: "account-checking-1",
    }),
    {
      period: "2026-07",
      accountId: "account-checking-1",
    },
  );
});
