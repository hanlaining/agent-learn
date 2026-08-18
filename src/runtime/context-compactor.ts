import type {
  LlmCreateResponseRequest,
  LlmMessage,
  LlmProvider,
  LlmResponse,
} from "../llm/types.js";
import {
  OPENAI_BPE_TOKEN_COUNTER,
  truncateTextToTokens,
  type TokenCounter,
} from "./token-counter.js";

/**
 * 与 Codex 开源实现相同的合成压缩提示词。
 * Codex 会把它作为最后一条 user 消息追加到当前历史，再请求模型生成交接摘要。
 */
export const CODEX_COMPACTION_PROMPT = `
You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.
`.trim();

/** Codex 用这个固定前缀让下一次压缩能够识别并排除旧摘要。 */
export const CODEX_SUMMARY_PREFIX =
  "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";

const DEFAULT_RETAINED_USER_MESSAGE_TOKENS = 20_000;
const DEFAULT_MAX_SUMMARY_INPUT_ITEMS = 120;
const DEFAULT_MAX_RETAINED_USER_MESSAGES = 32;

export interface ContextCompactorOptions {
  llm: LlmProvider;
  retainedUserMessageTokens?: number;
  maxSummaryInputTokens?: number;
  maxSummaryInputItems?: number;
  maxRetainedUserMessages?: number;
  maxMessageTokens?: number;
  tokenCounter?: TokenCounter;
}

/**
 * Codex 式本地 Context Compactor：
 * 1. 用整个当前历史生成 Handoff Summary；
 * 2. 从最新往前保留有限量真实 user 消息；
 * 3. 把带固定前缀的摘要作为替换历史的最后一条 user 消息。
 *
 * 该组件只返回替换消息，不直接修改 LifecycleStore 或安装 Checkpoint。
 */
export class ContextCompactor {
  private readonly llm: LlmProvider;
  private readonly retainedUserMessageTokens: number;
  private readonly maxSummaryInputTokens: number;
  private readonly maxSummaryInputItems: number;
  private readonly maxRetainedUserMessages: number;
  private readonly maxMessageTokens: number;
  private readonly tokenCounter: TokenCounter;

  constructor(options: ContextCompactorOptions) {
    this.llm = options.llm;
    this.retainedUserMessageTokens =
      options.retainedUserMessageTokens ??
      DEFAULT_RETAINED_USER_MESSAGE_TOKENS;
    this.maxSummaryInputTokens =
      options.maxSummaryInputTokens ?? 96_000;
    this.maxSummaryInputItems =
      options.maxSummaryInputItems ??
      DEFAULT_MAX_SUMMARY_INPUT_ITEMS;
    this.maxRetainedUserMessages =
      options.maxRetainedUserMessages ??
      DEFAULT_MAX_RETAINED_USER_MESSAGES;
    this.maxMessageTokens =
      options.maxMessageTokens ?? 20_000;
    this.tokenCounter =
      options.tokenCounter ?? OPENAI_BPE_TOKEN_COUNTER;

    requirePositiveInteger(
      this.retainedUserMessageTokens,
      "retainedUserMessageTokens",
    );
    requirePositiveInteger(
      this.maxSummaryInputTokens,
      "maxSummaryInputTokens",
    );
    requirePositiveInteger(
      this.maxSummaryInputItems,
      "maxSummaryInputItems",
    );
    requirePositiveInteger(
      this.maxRetainedUserMessages,
      "maxRetainedUserMessages",
    );
    requirePositiveInteger(
      this.maxMessageTokens,
      "maxMessageTokens",
    );

    if (this.maxMessageTokens > this.maxSummaryInputTokens) {
      throw new Error(
        "maxMessageTokens must not exceed maxSummaryInputTokens",
      );
    }
  }

  async compact(
    messages: readonly LlmMessage[],
    signal?: AbortSignal,
    createResponse?: (
      request: LlmCreateResponseRequest,
    ) => Promise<LlmResponse>,
  ): Promise<LlmMessage[]> {
    if (messages.length === 0) {
      return [];
    }

    const response = await (createResponse ??
      ((request) => this.llm.createResponse(request)))({
      // 当前教学 Runtime 没有 Codex 的 BaseInstructions 快照，因此用最小内部说明，
      // 真正的压缩任务仍由 input 最后一条合成 user 消息定义。
      instructions:
        "Generate only the requested context checkpoint summary.",
      input: this.prepareSummaryInput(messages),
      // Compaction 只生成交接摘要，绝不开放本地或 Provider 托管 Tool。
      tools: [],
      allowHostedTools: false,
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

    const retainedUserMessages =
      this.selectRetainedUserMessages(messages);

    // Codex 把摘要编码成 user 消息并放在最后；这是模型续接压缩历史时依赖的顺序。
    return [
      ...retainedUserMessages,
      {
        role: "user",
        text:
          `${CODEX_SUMMARY_PREFIX}\n` +
          response.text.trim(),
      },
    ];
  }

  private prepareSummaryInput(
    messages: readonly LlmMessage[],
  ): LlmMessage[] {
    const promptMessage: LlmMessage = {
      role: "user",
      text: CODEX_COMPACTION_PROMPT,
    };
    const promptTokens =
      this.tokenCounter.countMessages([promptMessage]);

    if (promptTokens > this.maxSummaryInputTokens) {
      throw new Error(
        "maxSummaryInputTokens cannot fit the compaction prompt",
      );
    }

    const safeMessages = messages.map((message) => ({
      ...message,
      text: truncateTextToTokens(
        message.text,
        this.maxMessageTokens,
        this.tokenCounter,
        "\n...[message truncated for compaction]...\n",
      ).text,
    }));
    const selected: LlmMessage[] = [];
    let usedTokens = promptTokens;

    // Codex 在压缩请求溢出时从最老项开始删除；这里在 Provider 调用前按
    // Token 和 Item 双预算预裁剪，优先保留最接近当前任务的历史。
    // maxSummaryInputItems 包含最后的合成压缩提示词。
    for (
      let index = safeMessages.length - 1;
      index >= 0;
      index -= 1
    ) {
      if (
        selected.length + 1 >=
        this.maxSummaryInputItems
      ) {
        break;
      }

      const message = safeMessages[index]!;
      const messageTokens =
        this.tokenCounter.countMessages([message]);

      if (
        usedTokens + messageTokens >
        this.maxSummaryInputTokens
      ) {
        break;
      }

      selected.unshift(message);
      usedTokens += messageTokens;
    }

    return [...selected, promptMessage];
  }

  private selectRetainedUserMessages(
    messages: readonly LlmMessage[],
  ): LlmMessage[] {
    const retained: LlmMessage[] = [];
    let remainingTokens = this.retainedUserMessageTokens;

    // 与 Codex 的 build_compacted_history 相同：从最新 user 消息向前装预算，
    // 遇到边界消息时截断一次后停止，最后再恢复原始时间顺序。
    for (
      let index = messages.length - 1;
      index >= 0 &&
      remainingTokens > 0 &&
      retained.length < this.maxRetainedUserMessages;
      index -= 1
    ) {
      const message = messages[index]!;

      if (
        message.role !== "user" ||
        isCompactionSummary(message.text)
      ) {
        continue;
      }

      const messageTokens =
        this.tokenCounter.countText(message.text);

      if (messageTokens <= remainingTokens) {
        retained.push({ ...message });
        remainingTokens -= messageTokens;
        continue;
      }

      retained.push({
        role: "user",
        text: truncateTextToTokens(
          message.text,
          remainingTokens,
          this.tokenCounter,
          "\n...[user message truncated for compaction]...\n",
        ).text,
      });
      break;
    }

    return retained.reverse();
  }
}

function isCompactionSummary(text: string): boolean {
  return text.startsWith(`${CODEX_SUMMARY_PREFIX}\n`);
}

function requirePositiveInteger(
  value: number,
  name: string,
): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}
