import type {
  CategoryExpense,
  Money,
  MonthlyFinanceSummary,
  MonthlySummaryRequest,
  Transaction,
  TransactionCategory,
} from "./types.js";

const YEAR_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * JSON-RPC params 来自进程边界，类型是 unknown。
 * 在进入金融计算前必须做运行时校验，不能只依赖 TypeScript。
 */
export function parseMonthlySummaryRequest(
  value: unknown,
): MonthlySummaryRequest {
  if (!isRecord(value)) {
    throw new Error("Monthly summary params must be an object");
  }

  if (
    typeof value.period !== "string" ||
    !YEAR_MONTH_PATTERN.test(value.period)
  ) {
    throw new Error("period must use YYYY-MM format");
  }

  if (
    "accountId" in value &&
    typeof value.accountId !== "string"
  ) {
    throw new Error("accountId must be a string");
  }

  if (typeof value.accountId === "string") {
    return {
      period: value.period,
      accountId: value.accountId,
    };
  }

  return {
    period: value.period,
  };
}

/**
 * 对已入账流水做确定性汇总。
 * pending/cancelled 和账户间转账暂不计入收入与支出。
 */
export function summarizeMonthlyTransactions(
  transactions: readonly Transaction[],
  request: MonthlySummaryRequest,
): MonthlyFinanceSummary {
  const expenseTotals = new Map<TransactionCategory, number>();

  let totalIncomeMinorUnits = 0;
  let totalExpenseMinorUnits = 0;
  let transactionCount = 0;

  for (const transaction of transactions) {
    if (!matchesRequest(transaction, request)) {
      continue;
    }

    validateTransactionAmount(transaction);

    if (transaction.kind === "income") {
      totalIncomeMinorUnits += transaction.amount.minorUnits;
      transactionCount += 1;
      continue;
    }

    if (transaction.kind === "expense") {
      totalExpenseMinorUnits += transaction.amount.minorUnits;
      transactionCount += 1;

      const previous =
        expenseTotals.get(transaction.category) ?? 0;

      expenseTotals.set(
        transaction.category,
        previous + transaction.amount.minorUnits,
      );
    }
  }

  const expensesByCategory: CategoryExpense[] =
    [...expenseTotals.entries()]
      .map(([category, minorUnits]) => ({
        category,
        amount: createMoney(minorUnits),
      }))
      // 金额最大的类别排在前面，便于 CLI 和后续模型解释。
      .sort(
        (left, right) =>
          right.amount.minorUnits - left.amount.minorUnits,
      );

  return {
    period: request.period,
    currency: "CNY",
    totalIncome: createMoney(totalIncomeMinorUnits),
    totalExpense: createMoney(totalExpenseMinorUnits),
    netCashFlow: createMoney(
      totalIncomeMinorUnits - totalExpenseMinorUnits,
    ),
    expensesByCategory,
    transactionCount,
  };
}

/**
 * Client 从 JSON-RPC Response 得到 unknown，展示前再次校验响应外壳。
 */
export function isMonthlyFinanceSummary(
  value: unknown,
): value is MonthlyFinanceSummary {
  return (
    isRecord(value) &&
    typeof value.period === "string" &&
    value.currency === "CNY" &&
    isMoney(value.totalIncome) &&
    isMoney(value.totalExpense) &&
    isMoney(value.netCashFlow) &&
    Number.isInteger(value.transactionCount) &&
    Array.isArray(value.expensesByCategory) &&
    value.expensesByCategory.every(isCategoryExpense)
  );
}

function matchesRequest(
  transaction: Transaction,
  request: MonthlySummaryRequest,
): boolean {
  return (
    transaction.status === "posted" &&
    transaction.kind !== "transfer" &&
    transaction.occurredAt.startsWith(`${request.period}-`) &&
    (
      request.accountId === undefined ||
      transaction.accountId === request.accountId
    )
  );
}

function validateTransactionAmount(
  transaction: Transaction,
): void {
  if (
    transaction.amount.currency !== "CNY" ||
    !Number.isInteger(transaction.amount.minorUnits) ||
    transaction.amount.minorUnits < 0
  ) {
    throw new Error(
      `Invalid amount for transaction: ${transaction.id}`,
    );
  }
}

function createMoney(minorUnits: number): Money {
  return {
    minorUnits,
    currency: "CNY",
  };
}

function isMoney(value: unknown): value is Money {
  return (
    isRecord(value) &&
    value.currency === "CNY" &&
    Number.isInteger(value.minorUnits)
  );
}

function isCategoryExpense(
  value: unknown,
): value is CategoryExpense {
  return (
    isRecord(value) &&
    typeof value.category === "string" &&
    isMoney(value.amount)
  );
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
