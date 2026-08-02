import type {
  LlmMessage,
} from "../llm/types.js";

const MESSAGE_STRUCTURE_TOKENS = 4;

export interface TokenBudgetOptions {
  maxContextTokens: number;
  compactThresholdTokens?: number;
}

export interface TokenBudgetAssessment {
  estimatedTokens: number;
  remainingTokens: number;
  maxContextTokens: number;
  compactThresholdTokens: number;
  shouldCompact: boolean;
}

/**
 * 第一版 Token Budget 使用确定性近似值，不冒充厂家 tokenizer 的精确结果。
 * 它只负责回答“用了多少、是否达到阈值”，不负责删除或摘要消息。
 */
export class TokenBudget {
  private readonly maxContextTokens: number;
  private readonly compactThresholdTokens: number;

  constructor(options: TokenBudgetOptions) {
    requirePositiveInteger(
      options.maxContextTokens,
      "maxContextTokens",
    );

    const compactThresholdTokens =
      options.compactThresholdTokens ??
      Math.max(1, Math.floor(
        options.maxContextTokens * 0.8,
      ));

    requirePositiveInteger(
      compactThresholdTokens,
      "compactThresholdTokens",
    );

    if (
      compactThresholdTokens > options.maxContextTokens
    ) {
      throw new Error(
        "compactThresholdTokens must not exceed maxContextTokens",
      );
    }

    this.maxContextTokens = options.maxContextTokens;
    this.compactThresholdTokens = compactThresholdTokens;
  }

  assess(
    messages: readonly LlmMessage[],
  ): TokenBudgetAssessment {
    const estimatedTokens = estimateMessagesTokens(messages);

    return {
      estimatedTokens,
      remainingTokens: Math.max(
        0,
        this.maxContextTokens - estimatedTokens,
      ),
      maxContextTokens: this.maxContextTokens,
      compactThresholdTokens:
        this.compactThresholdTokens,
      shouldCompact:
        estimatedTokens >= this.compactThresholdTokens,
    };
  }
}

export function estimateMessagesTokens(
  messages: readonly LlmMessage[],
): number {
  return messages.reduce(
    (total, message) =>
      total +
      MESSAGE_STRUCTURE_TOKENS +
      estimateTextTokens(message.text),
    0,
  );
}

/**
 * 英文和常见 ASCII 粗略按 4 字符一个 Token；中文等非 ASCII
 * 按一个 Unicode 字符一个 Token。该算法便于测试，后续可替换真实 tokenizer。
 */
export function estimateTextTokens(text: string): number {
  let asciiCharacters = 0;
  let nonAsciiTokens = 0;

  for (const character of text) {
    if (character.codePointAt(0)! <= 0x7f) {
      asciiCharacters += 1;
    } else {
      nonAsciiTokens += 1;
    }
  }

  return (
    Math.ceil(asciiCharacters / 4) +
    nonAsciiTokens
  );
}

function requirePositiveInteger(
  value: number,
  name: string,
): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}
