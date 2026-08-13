import type {
  LlmFunctionOutput,
} from "../llm/types.js";
import {
  OPENAI_BPE_TOKEN_COUNTER,
  truncateTextToTokens,
  type TokenCounter,
} from "./token-counter.js";

export interface ToolOutputLimiterOptions {
  maxOutputTokens: number;
  tokenCounter?: TokenCounter;
}

/**
 * LifecycleStore 保存 Tool 的完整确定性结果；这一层只限制交给模型的副本，
 * 防止单个日志或目录结果占满 Context Window。
 */
export class ToolOutputLimiter {
  private readonly maxOutputTokens: number;
  private readonly tokenCounter: TokenCounter;

  constructor(options: ToolOutputLimiterOptions) {
    if (
      !Number.isInteger(options.maxOutputTokens) ||
      options.maxOutputTokens <= 0
    ) {
      throw new Error(
        "maxOutputTokens must be a positive integer",
      );
    }

    this.maxOutputTokens = options.maxOutputTokens;
    this.tokenCounter =
      options.tokenCounter ?? OPENAI_BPE_TOKEN_COUNTER;
  }

  limit(
    outputs: readonly LlmFunctionOutput[],
  ): LlmFunctionOutput[] {
    return outputs.map((output) => {
      const originalTokens =
        this.tokenCounter.countText(output.output);
      const limited = truncateTextToTokens(
        output.output,
        this.maxOutputTokens,
        this.tokenCounter,
        `\n...[tool output truncated from ${originalTokens} tokens]...\n`,
      );

      return limited.truncated
        ? { ...output, output: limited.text }
        : { ...output };
    });
  }
}
