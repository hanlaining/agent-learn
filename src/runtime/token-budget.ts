import type {
  LlmMessage,
} from "../llm/types.js";
import {
  OPENAI_BPE_TOKEN_COUNTER,
  type TokenCounter,
} from "./token-counter.js";

export interface TokenBudgetOptions {
  maxContextTokens: number;
  compactThresholdTokens?: number;
  tokenCounter?: TokenCounter;
}

export interface TokenBudgetAssessment {
  estimatedTokens: number;
  remainingTokens: number;
  maxContextTokens: number;
  compactThresholdTokens: number;
  shouldCompact: boolean;
}

/**
 * Token Budget 使用可替换的 TokenCounter。默认正文由 o200k_base BPE
 * 真实分词，结构开销保持确定性估算；它不负责删除或摘要消息。
 */
export class TokenBudget {
  private readonly maxContextTokens: number;
  private readonly compactThresholdTokens: number;
  private readonly tokenCounter: TokenCounter;

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
    this.tokenCounter =
      options.tokenCounter ?? OPENAI_BPE_TOKEN_COUNTER;
  }

  assess(
    messages: readonly LlmMessage[],
  ): TokenBudgetAssessment {
    const estimatedTokens =
      this.tokenCounter.countMessages(messages);

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
  return OPENAI_BPE_TOKEN_COUNTER.countMessages(messages);
}

/**
 * 使用 o200k_base BPE 返回正文的真实 Token 数。
 */
export function estimateTextTokens(text: string): number {
  return OPENAI_BPE_TOKEN_COUNTER.countText(text);
}

function requirePositiveInteger(
  value: number,
  name: string,
): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}
