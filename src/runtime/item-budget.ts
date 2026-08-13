import type {
  LlmInputItem,
} from "../llm/types.js";

export interface ItemBudgetOptions {
  maxInputItems: number;
  compactThresholdItems: number;
  functionOutputItemCost: 1 | 2;
}

export interface ItemBudgetAssessment {
  estimatedItems: number;
  remainingItems: number;
  maxInputItems: number;
  compactThresholdItems: number;
  shouldCompact: boolean;
  exceedsLimit: boolean;
}

/**
 * 只携带安全计数，不包含输入正文、Tool 参数或 Tool 输出。
 */
export class InputItemBudgetExceededError extends Error {
  constructor(
    readonly estimatedItems: number,
    readonly maxInputItems: number,
  ) {
    super(
      `Provider input item limit exceeded: ${estimatedItems} > ${maxInputItems}`,
    );
    this.name = "InputItemBudgetExceededError";
  }
}

/**
 * Item Budget 按 Provider 的最终编码成本估算输入数量。
 * 它只负责计数和断言，不压缩输入，也不访问 Provider 或网络。
 */
export class ItemBudget {
  private readonly maxInputItems: number;
  private readonly compactThresholdItems: number;
  private readonly functionOutputItemCost: 1 | 2;

  constructor(options: ItemBudgetOptions) {
    requirePositiveInteger(
      options.maxInputItems,
      "maxInputItems",
    );
    requirePositiveInteger(
      options.compactThresholdItems,
      "compactThresholdItems",
    );

    if (
      options.compactThresholdItems > options.maxInputItems
    ) {
      throw new Error(
        "compactThresholdItems must not exceed maxInputItems",
      );
    }

    if (
      options.functionOutputItemCost !== 1 &&
      options.functionOutputItemCost !== 2
    ) {
      throw new Error(
        "functionOutputItemCost must be 1 or 2",
      );
    }

    this.maxInputItems = options.maxInputItems;
    this.compactThresholdItems =
      options.compactThresholdItems;
    this.functionOutputItemCost =
      options.functionOutputItemCost;
  }

  assess(
    input: string | readonly LlmInputItem[],
  ): ItemBudgetAssessment {
    const estimatedItems =
      typeof input === "string"
        ? 1
        : input.reduce(
            (total, item) =>
              total +
              (isFunctionOutput(item)
                ? this.functionOutputItemCost
                : 1),
            0,
          );

    return this.createAssessment(estimatedItems);
  }

  assertWithinLimit(
    input: string | readonly LlmInputItem[],
  ): void {
    const assessment = this.assess(input);

    if (assessment.exceedsLimit) {
      throw new InputItemBudgetExceededError(
        assessment.estimatedItems,
        assessment.maxInputItems,
      );
    }
  }

  assessFunctionOutputCount(
    count: number,
  ): ItemBudgetAssessment {
    requireNonNegativeInteger(count, "count");
    return this.createAssessment(
      count * this.functionOutputItemCost,
    );
  }

  private createAssessment(
    estimatedItems: number,
  ): ItemBudgetAssessment {
    return {
      estimatedItems,
      remainingItems: Math.max(
        0,
        this.maxInputItems - estimatedItems,
      ),
      maxInputItems: this.maxInputItems,
      compactThresholdItems: this.compactThresholdItems,
      shouldCompact:
        estimatedItems >= this.compactThresholdItems,
      exceedsLimit: estimatedItems > this.maxInputItems,
    };
  }
}

function isFunctionOutput(
  item: LlmInputItem,
): boolean {
  return !("role" in item);
}

function requirePositiveInteger(
  value: number,
  name: string,
): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function requireNonNegativeInteger(
  value: number,
  name: string,
): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}
