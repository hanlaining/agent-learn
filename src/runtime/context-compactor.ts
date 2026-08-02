import type {
  LlmMessage,
  LlmProvider,
} from "../llm/types.js";
import {
  estimateMessagesTokens,
} from "./token-budget.js";

const COMPACTION_INSTRUCTIONS = `
你正在为下一个即将继续任务的模型生成 Handoff Summary。

只总结继续任务必须知道的信息：
- 用户目标与当前进度；
- 已确认的事实和关键决定；
- 必须继续遵守的约束；
- 尚未完成的工作和明确下一步。

不要调用任何工具，不要编造事实，不要复述隐藏思维链。
`.trim();

const CHECKPOINT_PREFIX = "[Context checkpoint]";

export interface ContextCompactorOptions {
  llm: LlmProvider;
  recentMessageTokens: number;
}

/**
 * 把较老消息转换成语义 Checkpoint，同时确定性保留最近真实消息。
 * 该组件只返回新的消息数组，不直接修改 LifecycleStore。
 */
export class ContextCompactor {
  private readonly llm: LlmProvider;
  private readonly recentMessageTokens: number;

  constructor(options: ContextCompactorOptions) {
    if (
      !Number.isInteger(options.recentMessageTokens) ||
      options.recentMessageTokens <= 0
    ) {
      throw new Error(
        "recentMessageTokens must be a positive integer",
      );
    }

    this.llm = options.llm;
    this.recentMessageTokens =
      options.recentMessageTokens;
  }

  async compact(
    messages: readonly LlmMessage[],
    signal?: AbortSignal,
  ): Promise<LlmMessage[]> {
    if (messages.length === 0) {
      return [];
    }

    const recentStart = this.findRecentStart(messages);
    const olderMessages = messages.slice(0, recentStart);

    if (olderMessages.length === 0) {
      return [...messages];
    }

    const response = await this.llm.createResponse({
      instructions: COMPACTION_INSTRUCTIONS,
      input: olderMessages,
      // Compaction 只生成交接摘要，绝不开放业务 Tool。
      tools: [],
      ...(signal === undefined ? {} : { signal }),
    });

    if (
      response.functionCalls.length > 0 ||
      response.text.trim().length === 0
    ) {
      throw new Error(
        "Compaction model must return summary text only",
      );
    }

    return [
      {
        role: "assistant",
        text:
          `${CHECKPOINT_PREFIX}\n` +
          response.text.trim(),
      },
      ...messages.slice(recentStart),
    ];
  }

  private findRecentStart(
    messages: readonly LlmMessage[],
  ): number {
    let recentStart = messages.length;
    let usedTokens = 0;

    for (
      let index = messages.length - 1;
      index >= 0;
      index -= 1
    ) {
      const message = messages[index]!;
      const messageTokens = estimateMessagesTokens([
        message,
      ]);

      // 最后一条通常是当前用户输入，即使它单独超预算也必须保留。
      if (
        index !== messages.length - 1 &&
        usedTokens + messageTokens >
          this.recentMessageTokens
      ) {
        break;
      }

      recentStart = index;
      usedTokens += messageTokens;
    }

    return recentStart;
  }
}
