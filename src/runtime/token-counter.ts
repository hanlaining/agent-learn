import { encode } from "gpt-tokenizer";

import type {
  LlmMessage,
} from "../llm/types.js";

const MESSAGE_STRUCTURE_TOKENS = 4;

/**
 * Token Budget 只依赖这个接口，后续更换模型或编码器时不需要改预算算法。
 */
export interface TokenCounter {
  countText(text: string): number;
  countMessages(messages: readonly LlmMessage[]): number;
}

/**
 * 使用现代 OpenAI 模型采用的 o200k_base BPE 对正文做真实分词。
 * Responses 消息封装仍保留每条 4 Token 的确定性结构开销；厂家没有
 * 公布所有服务端包装细节，因此这里不会冒充完整请求的账单精确值。
 */
export class OpenAiBpeTokenCounter implements TokenCounter {
  countText(text: string): number {
    return encode(text).length;
  }

  countMessages(messages: readonly LlmMessage[]): number {
    return messages.reduce(
      (total, message) =>
        total +
        MESSAGE_STRUCTURE_TOKENS +
        this.countText(message.text),
      0,
    );
  }
}

export const OPENAI_BPE_TOKEN_COUNTER =
  new OpenAiBpeTokenCounter();

export interface TokenTruncation {
  text: string;
  originalTokens: number;
  finalTokens: number;
  truncated: boolean;
}

/**
 * 按 Token 上限保留正文头尾。二分的是 Unicode 字符数量，最终仍用
 * TokenCounter 复核，因此不会因为中英文字符宽度不同而越过预算。
 */
export function truncateTextToTokens(
  text: string,
  maxTokens: number,
  tokenCounter: TokenCounter = OPENAI_BPE_TOKEN_COUNTER,
  marker = "\n...[truncated]...\n",
): TokenTruncation {
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new Error("maxTokens must be a positive integer");
  }

  const originalTokens = tokenCounter.countText(text);

  if (originalTokens <= maxTokens) {
    return {
      text,
      originalTokens,
      finalTokens: originalTokens,
      truncated: false,
    };
  }

  const characters = [...text];
  const markerTokens = tokenCounter.countText(marker);

  if (markerTokens >= maxTokens) {
    const prefix = fitPrefix(
      characters,
      maxTokens,
      tokenCounter,
    );

    return {
      text: prefix,
      originalTokens,
      finalTokens: tokenCounter.countText(prefix),
      truncated: true,
    };
  }

  let low = 0;
  let high = characters.length;
  let best = marker;

  while (low <= high) {
    const keepCharacters = Math.floor((low + high) / 2);
    const headLength = Math.ceil(keepCharacters / 2);
    const tailLength = Math.floor(keepCharacters / 2);
    const candidate =
      characters.slice(0, headLength).join("") +
      marker +
      (tailLength === 0
        ? ""
        : characters.slice(-tailLength).join(""));

    if (tokenCounter.countText(candidate) <= maxTokens) {
      best = candidate;
      low = keepCharacters + 1;
    } else {
      high = keepCharacters - 1;
    }
  }

  return {
    text: best,
    originalTokens,
    finalTokens: tokenCounter.countText(best),
    truncated: true,
  };
}

function fitPrefix(
  characters: readonly string[],
  maxTokens: number,
  tokenCounter: TokenCounter,
): string {
  let low = 0;
  let high = characters.length;
  let best = "";

  while (low <= high) {
    const length = Math.floor((low + high) / 2);
    const candidate = characters.slice(0, length).join("");

    if (tokenCounter.countText(candidate) <= maxTokens) {
      best = candidate;
      low = length + 1;
    } else {
      high = length - 1;
    }
  }

  return best;
}
