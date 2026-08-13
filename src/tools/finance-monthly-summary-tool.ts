import {
  sampleTransactions,
} from "../domains/finance/fixtures.js";
import {
  parseMonthlySummaryRequest,
  summarizeMonthlyTransactions,
} from "../domains/finance/summary.js";
import type {
  Money,
  MonthlyFinanceSummary,
} from "../domains/finance/types.js";
import type {
  LlmToolDefinition,
} from "../llm/types.js";
import { strictObjectSchema } from "../llm/tool-schema.js";
import type {
  AgentTool,
} from "./tool-registry.js";

export const FINANCE_MONTHLY_SUMMARY_TOOL_NAME =
  "finance_monthly_summary";

/**
 * 给 LLM 阅读的 Tool 说明与 JSON Schema。
 * LLM 只能选择工具和提供参数，不能直接修改金融数据。
 */
export const financeMonthlySummaryTool: LlmToolDefinition = {
  name: FINANCE_MONTHLY_SUMMARY_TOOL_NAME,
  description:
    "计算指定月份的已入账收入、支出、净现金流和分类支出。" +
    "涉及金额事实时必须调用此工具，不要自行计算或猜测。",
  parameters: strictObjectSchema({
    period: {
      type: "string",
      description: "要分析的月份，格式为 YYYY-MM",
      pattern: "^\\d{4}-(0[1-9]|1[0-2])$",
    },
  }),
};

/**
 * 真正执行金融 Tool。金额仍由确定性 TypeScript 代码计算。
 */
export function executeFinanceMonthlySummaryTool(
  argumentsJson: string,
): MonthlyFinanceSummary {
  let parsedArguments: unknown;

  try {
    parsedArguments = JSON.parse(argumentsJson) as unknown;
  } catch {
    throw new Error(
      "finance_monthly_summary arguments must be valid JSON",
    );
  }

  const request = parseMonthlySummaryRequest(
    parsedArguments,
  );

  return summarizeMonthlyTransactions(
    sampleTransactions,
    request,
  );
}

/**
 * 给模型的金额同时携带确定性格式化结果。
 * 模型只需原样复制 display，不再自行把“分”换算成“元”。
 */
export function createFinanceSummaryModelOutput(
  summary: MonthlyFinanceSummary,
): unknown {
  return {
    ...summary,
    totalIncome: createModelMoney(summary.totalIncome),
    totalExpense: createModelMoney(summary.totalExpense),
    netCashFlow: createModelMoney(summary.netCashFlow),
    expensesByCategory: summary.expensesByCategory.map(
      (expense) => ({
        ...expense,
        amount: createModelMoney(expense.amount),
      }),
    ),
  };
}

/**
 * Registry 使用的通用适配器。原始结果进入 LifecycleStore，
 * 带确定性 display 的安全结果交给模型解释。
 */
export const financeMonthlySummaryAgentTool: AgentTool = {
  definition: financeMonthlySummaryTool,
  execute(argumentsJson) {
    const result = executeFinanceMonthlySummaryTool(
      argumentsJson,
    );

    return {
      result,
      modelOutput: createFinanceSummaryModelOutput(result),
    };
  },
};

function createModelMoney(money: Money) {
  return {
    ...money,
    display: new Intl.NumberFormat("zh-CN", {
      style: "currency",
      currency: money.currency,
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(money.minorUnits / 100),
  };
}
