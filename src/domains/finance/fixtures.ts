import type {
  Transaction,
} from "./types.js";

/**
 * MVP 暂时只使用一个银行卡账户。
 *
 * 后续加入 Account Store 后，
 * 这里会改成引用真实 Account 对象。
 */
export const SAMPLE_ACCOUNT_ID =
  "account-checking-1";

/**
 * 固定的模拟交易数据。
 *
 * 金额统一使用人民币最小单位“分”：
 *
 * 1 元      = 100
 * 100 元    = 10_000
 * 10,000 元 = 1_000_000
 *
 * 使用固定数据可以让测试结果保持确定，
 * 不会因为时间或随机数变化。
 */
export const sampleTransactions = [
  {
    id: "transaction-salary-2026-07",
    accountId: SAMPLE_ACCOUNT_ID,

    // 工资属于收入。
    kind: "income",
    status: "posted",
    category: "salary",

    amount: {
      // ¥10,000.00
      minorUnits: 1_000_000,
      currency: "CNY",
    },

    description: "2026 年 7 月工资",
    occurredAt: "2026-07-01T09:00:00.000Z",
    createdAt: "2026-07-01T09:00:00.000Z",
  },

  {
    id: "transaction-rent-2026-07",
    accountId: SAMPLE_ACCOUNT_ID,

    // 房租属于支出。
    kind: "expense",
    status: "posted",
    category: "housing",

    amount: {
      // ¥3,000.00
      minorUnits: 300_000,
      currency: "CNY",
    },

    description: "2026 年 7 月房租",
    occurredAt: "2026-07-02T08:00:00.000Z",
    createdAt: "2026-07-02T08:00:00.000Z",
  },

  {
    id: "transaction-food-1-2026-07",
    accountId: SAMPLE_ACCOUNT_ID,

    kind: "expense",
    status: "posted",
    category: "food",

    amount: {
      // ¥80.00
      minorUnits: 8_000,
      currency: "CNY",
    },

    description: "餐饮支出",
    occurredAt: "2026-07-05T12:30:00.000Z",
    createdAt: "2026-07-05T12:30:00.000Z",
  },

  {
    id: "transaction-food-2-2026-07",
    accountId: SAMPLE_ACCOUNT_ID,

    kind: "expense",
    status: "posted",
    category: "food",

    amount: {
      // ¥40.00
      minorUnits: 4_000,
      currency: "CNY",
    },

    description: "餐饮支出",
    occurredAt: "2026-07-12T18:30:00.000Z",
    createdAt: "2026-07-12T18:30:00.000Z",
  },

  {
    id: "transaction-transport-2026-07",
    accountId: SAMPLE_ACCOUNT_ID,

    kind: "expense",
    status: "posted",
    category: "transport",

    amount: {
      // ¥30.00
      minorUnits: 3_000,
      currency: "CNY",
    },

    description: "地铁与公交",
    occurredAt: "2026-07-15T08:30:00.000Z",
    createdAt: "2026-07-15T08:30:00.000Z",
  },
] satisfies readonly Transaction[];