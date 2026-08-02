import type {
  LlmCreateResponseRequest,
  LlmFunctionCall,
  LlmProvider,
  LlmResponse,
  LlmStreamEvent,
} from "./types.js";

export interface OpenAiResponsesOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  usePreviousResponseId?: boolean;
  fetch?: typeof fetch;
}

/**
 * 使用原生 fetch 调用 OpenAI Responses API。
 * 这里负责供应商协议适配，上层 Agent Loop 只依赖 LlmProvider。
 */
export class OpenAiResponsesProvider implements LlmProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly usePreviousResponseId: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiResponsesOptions) {
    if (options.apiKey.trim().length === 0) {
      throw new Error("OpenAI API key must not be empty");
    }

    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = (
      options.baseUrl ?? "https://api.openai.com/v1"
    ).replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 45_000;
    this.usePreviousResponseId =
      options.usePreviousResponseId ?? true;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async createResponse(
    request: LlmCreateResponseRequest,
  ): Promise<LlmResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      instructions: request.instructions,
      input:
        typeof request.input === "string"
          ? [
              {
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: request.input,
                  },
                ],
              },
            ]
          : this.createToolContinuationInput(request.input),
      tools: request.tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: true,
      })),
      // 官方端点和 LovBrowser 中转都会以 SSE 增量返回。
      stream: true,
    };

    if (
      this.usePreviousResponseId &&
      request.previousResponseId !== undefined
    ) {
      body.previous_response_id = request.previousResponseId;
    }

    const response = await this.fetchImpl(
      `${this.baseUrl}/responses`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        // 外部 API 无响应时主动终止，Agent Loop 会把 Turn 标记为 failed。
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );

    if (!response.ok) {
      const responseText = await response.text();
      const responseBody = parseOpenAiResponseBody(
        responseText,
        response.headers.get("content-type"),
      );

      throw new Error(
        `OpenAI Responses API failed (${response.status}): ` +
          extractApiError(responseBody),
      );
    }

    if (
      response.headers
        .get("content-type")
        ?.includes("text/event-stream") === true
    ) {
      return readOpenAiEventStream(
        response,
        request.onEvent,
      );
    }

    const responseBody = parseOpenAiResponseBody(
      await response.text(),
      response.headers.get("content-type"),
    );
    const result = parseOpenAiResponse(responseBody);

    // 非流式厂家至少发送一次完整文本增量，保持上层事件语义一致。
    if (result.text.length > 0) {
      request.onEvent?.({
        type: "output_text_delta",
        delta: result.text,
      });
    }

    return result;
  }

  private createToolContinuationInput(
    outputs: Extract<
      LlmCreateResponseRequest["input"],
      readonly unknown[]
    >,
  ): Record<string, unknown>[] {
    if (this.usePreviousResponseId) {
      return outputs.map((output) => ({
        type: "function_call_output",
        call_id: output.callId,
        output: output.output,
      }));
    }

    // 无状态兼容端点需要显式回放 function_call，再追加 Tool 结果。
    return outputs.flatMap((output) => [
      {
        type: "function_call",
        call_id: output.callId,
        name: output.name,
        arguments: output.arguments,
      },
      {
        type: "function_call_output",
        call_id: output.callId,
        output: output.output,
      },
    ]);
  }
}

/**
 * 官方端点通常返回 JSON；部分 OpenAI 兼容网关固定返回 SSE。
 * 两种格式都在 Provider 边界归一化，上层无需感知差异。
 */
export function parseOpenAiResponseBody(
  value: string,
  contentType: string | null,
): unknown {
  if (
    contentType?.includes("text/event-stream") === true ||
    value.trimStart().startsWith("event:")
  ) {
    return parseOpenAiEventStream(value);
  }

  return parseJson(value);
}

async function readOpenAiEventStream(
  response: Response,
  onEvent: ((event: LlmStreamEvent) => void) | undefined,
): Promise<LlmResponse> {
  if (response.body === null) {
    throw new Error("OpenAI event stream has no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const accumulator = new OpenAiEventStreamAccumulator(onEvent);

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    accumulator.push(
      decoder.decode(value, { stream: true }),
    );
  }

  accumulator.push(decoder.decode());

  return parseOpenAiResponse(accumulator.finish());
}

/**
 * 将 OpenAI 原始 Response 归一化成 Agent Core 使用的结构。
 */
export function parseOpenAiResponse(
  value: unknown,
): LlmResponse {
  if (!isRecord(value) || typeof value.id !== "string") {
    throw new Error("Invalid OpenAI response: missing id");
  }

  if (!Array.isArray(value.output)) {
    throw new Error("Invalid OpenAI response: missing output");
  }

  const functionCalls: LlmFunctionCall[] = [];
  const textParts: string[] = [];

  for (const outputItem of value.output) {
    if (!isRecord(outputItem)) {
      continue;
    }

    if (outputItem.type === "function_call") {
      if (
        typeof outputItem.call_id !== "string" ||
        typeof outputItem.name !== "string" ||
        typeof outputItem.arguments !== "string"
      ) {
        throw new Error(
          "Invalid OpenAI function_call output",
        );
      }

      functionCalls.push({
        callId: outputItem.call_id,
        name: outputItem.name,
        arguments: outputItem.arguments,
      });

      continue;
    }

    if (
      outputItem.type === "message" &&
      Array.isArray(outputItem.content)
    ) {
      for (const contentItem of outputItem.content) {
        if (
          isRecord(contentItem) &&
          contentItem.type === "output_text" &&
          typeof contentItem.text === "string"
        ) {
          textParts.push(contentItem.text);
        }
      }
    }
  }

  if (functionCalls.length === 0 && textParts.length === 0) {
    throw new Error(
      "OpenAI response contains neither text nor function calls",
    );
  }

  return {
    id: value.id,
    text: textParts.join("\n").trim(),
    functionCalls,
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("OpenAI API returned invalid JSON");
  }
}

function parseOpenAiEventStream(value: string): unknown {
  const accumulator = new OpenAiEventStreamAccumulator();
  accumulator.push(value);
  return accumulator.finish();
}

class OpenAiEventStreamAccumulator {
  private buffer = "";
  private responseId: string | undefined;
  private readonly output: unknown[] = [];

  constructor(
    private readonly onEvent?: (
      event: LlmStreamEvent,
    ) => void,
  ) {}

  push(chunk: string): void {
    this.buffer += chunk;
    // CRLF 可能刚好被拆在两个网络 chunk 之间，所以追加后再归一化。
    this.buffer = this.buffer.replace(/\r\n/g, "\n");

    let boundary = this.buffer.indexOf("\n\n");

    while (boundary >= 0) {
      const frame = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      this.handleFrame(frame);
      boundary = this.buffer.indexOf("\n\n");
    }
  }

  finish(): unknown {
    if (this.buffer.trim().length > 0) {
      this.handleFrame(this.buffer);
      this.buffer = "";
    }

    if (this.responseId === undefined) {
      throw new Error(
        "Invalid OpenAI event stream: missing response id",
      );
    }

    return {
      id: this.responseId,
      output: this.output,
    };
  }

  private handleFrame(frame: string): void {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n")
      .trim();

    if (data.length === 0 || data === "[DONE]") {
      return;
    }

    const event = parseJson(data);

    if (!isRecord(event)) {
      return;
    }

    if (
      (event.type === "response.created" ||
        event.type === "response.completed") &&
      isRecord(event.response) &&
      typeof event.response.id === "string"
    ) {
      this.responseId = event.response.id;
    }

    if (
      event.type === "response.output_item.done" &&
      "item" in event
    ) {
      this.output.push(event.item);
    }

    if (
      event.type === "response.output_text.delta" &&
      typeof event.delta === "string"
    ) {
      this.onEvent?.({
        type: "output_text_delta",
        delta: event.delta,
      });
    }

    if (
      (
        event.type ===
          "response.reasoning_summary_text.delta" ||
        event.type === "response.reasoning_text.delta"
      ) &&
      typeof event.delta === "string"
    ) {
      this.onEvent?.({
        type: "reasoning_summary_delta",
        delta: event.delta,
      });
    }
  }
}

function extractApiError(value: unknown): string {
  if (
    isRecord(value) &&
    isRecord(value.error) &&
    typeof value.error.message === "string"
  ) {
    return value.error.message;
  }

  return "Unknown OpenAI API error";
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}
