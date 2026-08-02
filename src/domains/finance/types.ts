/**
 * 金融 MVP 当前只支持人民币。
 * 后续接入多币种时再扩展，而不是提前增加汇率复杂度。
 */
export type Currency = "CNY";

/**
 * 金额使用最小货币单位“分”，避免 0.1 + 0.2 一类浮点误差。
 * 例如 10.50 元保存为 1050。
 */
export interface Money {
  minorUnits: number;
  currency: Currency;
}

export type AccountId = string;
export type TransactionId = string;

export type TransactionKind =
  | "income"
  | "expense"
  | "transfer";

export type TransactionStatus =
  | "pending"
  | "posted"
  | "cancelled";

export type TransactionCategory =
  | "salary"
  | "food"
  | "transport"
  | "housing"
  | "shopping"
  | "entertainment"
  | "medical"
  | "education"
  | "transfer"
  | "other";

/**
 * 一条账本流水。
 * amount 始终保存非负数，资金方向由 kind 表示。
 */
export interface Transaction {
  id: TransactionId;
  accountId: AccountId;
  kind: TransactionKind;
  status: TransactionStatus;
  category: TransactionCategory;
  amount: Money;
  description: string;
  occurredAt: string;
  createdAt: string;
  transferAccountId?: AccountId;
}

/**
 * finance/monthly-summary 的请求参数。
 * period 使用 YYYY-MM；accountId 省略时汇总全部账户。
 */
export interface MonthlySummaryRequest {
  period: string;
  accountId?: AccountId;
}

export interface CategoryExpense {
  category: TransactionCategory;
  amount: Money;
}

/**
 * 月度汇总是确定性金融服务的输出，LLM 只能解释它，不能改写金额。
 */
export interface MonthlyFinanceSummary {
  period: string;
  currency: Currency;
  totalIncome: Money;
  totalExpense: Money;
  netCashFlow: Money;
  expensesByCategory: CategoryExpense[];
  transactionCount: number;
}
