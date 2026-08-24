/**
 * Agent Core 依赖的最小模型抽象。
 * 上层不需要知道 OpenAI HTTP Response 的具体字段。
 */
export interface LlmToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmFunctionCall {
  callId: string;
  name: string;
  arguments: string;
}

export interface LlmFunctionOutput {
  callId: string;
  name: string;
  arguments: string;
  output: string;
}

/**
 * Runtime 生成的 Provider 无关消息。
 * Provider 负责把它转换成具体厂家的 HTTP input 结构。
 */
export interface LlmMessage {
  role: "user" | "assistant";
  text: string;
}

export type LlmInputItem =
  | LlmMessage
  | LlmFunctionOutput;

export interface LlmResponse {
  id: string;
  text: string;
  functionCalls: LlmFunctionCall[];
}

export type ReasoningSummary =
  | "auto"
  | "concise"
  | "detailed"
  | "none";

/**
 * Provider 可以边接收厂家 SSE，边把可公开的增量交给 Runtime。
 */
export type LlmStreamEvent =
  | {
      type: "output_text_delta";
      delta: string;
    }
  | {
      type: "reasoning_summary_part_added";
      // 同一个 reasoning item 可以包含多段公开摘要，序号不能在 Provider 边界丢失。
      summaryIndex: number;
    }
  | {
      type: "reasoning_summary_delta";
      // 增量必须归属到明确的摘要分段，不能和最终回答混在一起。
      summaryIndex: number;
      delta: string;
    }
  | {
      type: "reasoning_summary_completed";
    }
  | {
      type: "web_search_started";
      callId: string;
    }
  | {
      type: "web_search_searching";
      callId: string;
    }
  | {
      type: "web_search_completed";
      callId: string;
      query?: string;
    }
  | {
      type: "url_citation_added";
      title: string;
      url: string;
      startIndex: number;
      endIndex: number;
    };

export interface LlmCreateResponseRequest {
  model?: string;
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  instructions: string;
  input: string | readonly LlmInputItem[];
  tools: readonly LlmToolDefinition[];
  // Compaction 等内部调用可关闭 Provider 托管 Tool，普通 Agent Turn 默认允许。
  allowHostedTools?: boolean;
  previousResponseId?: string;
  signal?: AbortSignal;
  onEvent?: (event: LlmStreamEvent) => void;
}

export interface LlmProvider {
  createResponse(
    request: LlmCreateResponseRequest,
  ): Promise<LlmResponse>;
}

/**
 * 可由 Runtime 切换模型的 Provider 插座。
 *
 * Agent Core 继续只依赖 LlmProvider；App Server 的装配层在需要展示或切换
 * 当前模型时使用这个更窄的可配置契约。
 */
export interface ConfigurableLlmProvider extends LlmProvider {
  getModel(): string;
  setModel(model: string): void;
}
