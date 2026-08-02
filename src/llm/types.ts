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

export interface LlmResponse {
  id: string;
  text: string;
  functionCalls: LlmFunctionCall[];
}

/**
 * Provider 可以边接收厂家 SSE，边把可公开的增量交给 Runtime。
 */
export type LlmStreamEvent =
  | {
      type: "output_text_delta";
      delta: string;
    }
  | {
      type: "reasoning_summary_delta";
      delta: string;
    };

export interface LlmCreateResponseRequest {
  instructions: string;
  input: string | LlmFunctionOutput[];
  tools: readonly LlmToolDefinition[];
  previousResponseId?: string;
  onEvent?: (event: LlmStreamEvent) => void;
}

export interface LlmProvider {
  createResponse(
    request: LlmCreateResponseRequest,
  ): Promise<LlmResponse>;
}
