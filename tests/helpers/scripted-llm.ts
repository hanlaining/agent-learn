import type {
  LlmCreateResponseRequest,
  LlmProvider,
  LlmResponse,
} from "../../src/llm/types.js";

/**
 * 测试专用 Fake LLM：按顺序返回预先写好的 Response。
 */
export class ScriptedLlmProvider implements LlmProvider {
  readonly requests: LlmCreateResponseRequest[] = [];

  constructor(
    private readonly responses: LlmResponse[],
  ) {}

  async createResponse(
    request: LlmCreateResponseRequest,
  ): Promise<LlmResponse> {
    this.requests.push(request);

    const response = this.responses.shift();

    if (response === undefined) {
      throw new Error("No scripted LLM response available");
    }

    if (response.text.length > 0) {
      request.onEvent?.({
        type: "output_text_delta",
        delta: response.text,
      });
    }

    return response;
  }
}
