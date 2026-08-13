import type {
  LlmCreateResponseRequest,
  LlmFunctionCall,
  LlmInputItem,
  LlmMessage,
  LlmProvider,
  LlmResponse,
  LlmStreamEvent,
  ReasoningSummary,
} from "./types.js";
import {
  InputItemBudgetExceededError,
} from "../runtime/item-budget.js";
import { isStrictObjectSchema } from "./tool-schema.js";

export type OpenAiReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";

export interface OpenAiWebSearchOptions {
  externalWebAccess?: boolean;
  searchContextSize?: "low" | "medium" | "high";
}

export interface OpenAiResponsesOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  usePreviousResponseId?: boolean;
  maxInputItems?: number;
  reasoningSummary?: ReasoningSummary;
  reasoningEffort?: OpenAiReasoningEffort;
  serviceTier?: string;
  includeReasoningEncryptedContent?: boolean;
  webSearch?: OpenAiWebSearchOptions;
  fetch?: typeof fetch;
  sleep?: (
    milliseconds: number,
    signal?: AbortSignal,
  ) => Promise<void>;
}

export const DEFAULT_OPENAI_RESPONSES_TIMEOUT_MS = 120_000;

/**
 * 使用原生 fetch 调用 OpenAI Responses API。
 * 这里负责供应商协议适配，上层 Agent Loop 只依赖 LlmProvider。
 */
export class OpenAiResponsesProvider implements LlmProvider {
  private readonly apiKey: string;
  private model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly usePreviousResponseId: boolean;
  private readonly maxInputItems: number;
  private readonly reasoningSummary: ReasoningSummary;
  private readonly reasoningEffort: OpenAiReasoningEffort;
  private readonly serviceTier: string;
  private readonly includeReasoningEncryptedContent: boolean;
  private readonly webSearch: OpenAiWebSearchOptions | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (
    milliseconds: number,
    signal?: AbortSignal,
  ) => Promise<void>;

  constructor(options: OpenAiResponsesOptions) {
    if (options.apiKey.trim().length === 0) {
      throw new Error("OpenAI API key must not be empty");
    }

    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = (
      options.baseUrl ?? "https://api.openai.com/v1"
    ).replace(/\/$/, "");
    this.timeoutMs =
      options.timeoutMs ?? DEFAULT_OPENAI_RESPONSES_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryBaseDelayMs =
      options.retryBaseDelayMs ?? 250;
    this.usePreviousResponseId =
      options.usePreviousResponseId ?? true;
    this.maxInputItems = options.maxInputItems ?? 128;
    this.reasoningSummary = options.reasoningSummary ?? "auto";
    this.reasoningEffort = options.reasoningEffort ?? "high";
    this.serviceTier = options.serviceTier ?? "fast";
    this.includeReasoningEncryptedContent =
      options.includeReasoningEncryptedContent ?? true;
    this.webSearch = options.webSearch;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? wait;

    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs <= 0
    ) {
      throw new Error("timeoutMs must be a positive integer");
    }

    if (
      !Number.isInteger(this.maxRetries) ||
      this.maxRetries < 0
    ) {
      throw new Error("maxRetries must be a non-negative integer");
    }

    if (
      !Number.isInteger(this.retryBaseDelayMs) ||
      this.retryBaseDelayMs < 0
    ) {
      throw new Error(
        "retryBaseDelayMs must be a non-negative integer",
      );
    }

    if (
      !Number.isInteger(this.maxInputItems) ||
      this.maxInputItems <= 0
    ) {
      throw new Error("maxInputItems must be a positive integer");
    }
  }

  getModel(): string {
    return this.model;
  }

  setModel(model: string): void {
    if (model.trim().length === 0) {
      throw new Error("OpenAI model must not be empty");
    }
    this.model = model;
  }

  async createResponse(
    request: LlmCreateResponseRequest,
  ): Promise<LlmResponse> {
    const tools: Record<string, unknown>[] =
      request.tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: isStrictObjectSchema(tool.parameters),
      }));

    if (
      this.webSearch !== undefined &&
      request.allowHostedTools !== false
    ) {
      // Web Search 是 Provider 托管 Tool，不进入本地 Registry，也不由 Runtime 执行 URL 请求。
      tools.push({
        type: "web_search",
        external_web_access:
          this.webSearch.externalWebAccess ?? true,
        search_context_size:
          this.webSearch.searchContextSize ?? "low",
      });
    }

    const body: Record<string, unknown> = {
      model: request.model ?? this.model,
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
          : this.createInputItems(request.input),
      tools,
      // 与 Codex 的 Responses 请求保持同形，让模型可以一次选择多个 Tool Call。
      tool_choice: "auto",
      parallel_tool_calls: true,
      // Runtime 自己持久化 Thread/Turn/Item，不依赖 Provider 保存响应状态。
      store: false,
      // 官方端点和 LovBrowser 中转都会以 SSE 增量返回。
      stream: true,
      service_tier: this.serviceTier,
    };

    const encodedInput = body.input;

    if (!Array.isArray(encodedInput)) {
      throw new Error("Provider input encoding must be an array");
    }

    // 只有最终编码完成后的数组长度才是 Provider 边界的精确事实。
    // 断言必须位于 fetchWithRetry 之前，超限请求不能产生任何网络调用。
    if (encodedInput.length > this.maxInputItems) {
      throw new InputItemBudgetExceededError(
        encodedInput.length,
        this.maxInputItems,
      );
    }

    // effort 决定推理投入，summary 只控制是否返回可公开摘要；两者不能混为一谈。
    body.reasoning = {
      effort: request.reasoningEffort ?? this.reasoningEffort,
      ...(this.reasoningSummary === "none"
        ? {}
        : { summary: this.reasoningSummary }),
    };

    if (this.includeReasoningEncryptedContent) {
      // encrypted_content 只供模型跨请求延续推理状态，绝不能当作可显示文本。
      body.include = ["reasoning.encrypted_content"];
    }

    if (
      this.usePreviousResponseId &&
      request.previousResponseId !== undefined
    ) {
      body.previous_response_id = request.previousResponseId;
    }

    const response = await this.fetchWithRetry(
      `${this.baseUrl}/responses`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
      request.signal,
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

  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    externalSignal: AbortSignal | undefined,
  ): Promise<Response> {
    for (
      let attempt = 0;
      attempt <= this.maxRetries;
      attempt += 1
    ) {
      externalSignal?.throwIfAborted();

      const timeoutSignal = AbortSignal.timeout(
        this.timeoutMs,
      );
      const signal =
        externalSignal === undefined
          ? timeoutSignal
          : AbortSignal.any([
              externalSignal,
              timeoutSignal,
            ]);

      let response: Response;

      try {
        response = await this.fetchImpl(url, {
          ...init,
          signal,
        });
      } catch (error) {
        if (externalSignal?.aborted === true) {
          throw externalSignal.reason;
        }

        if (attempt === this.maxRetries) {
          throw error;
        }

        await this.waitBeforeRetry(
          attempt,
          externalSignal,
        );
        continue;
      }

      if (
        !response.ok &&
        isRetryableStatus(response.status) &&
        attempt < this.maxRetries
      ) {
        await response.body?.cancel();
        await this.waitBeforeRetry(
          attempt,
          externalSignal,
        );
        continue;
      }

      return response;
    }

    throw new Error("OpenAI retry loop ended unexpectedly");
  }

  private waitBeforeRetry(
    attempt: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const delay =
      this.retryBaseDelayMs * 2 ** attempt;

    return this.sleep(delay, signal);
  }

  private createInputItems(
    items: readonly LlmInputItem[],
  ): Record<string, unknown>[] {
    const input: Record<string, unknown>[] = [];

    for (const item of items) {
      if (isLlmMessage(item)) {
        input.push({
          role: item.role,
          content: [
            {
              type:
                item.role === "user"
                  ? "input_text"
                  : "output_text",
              text: item.text,
            },
          ],
        });
        continue;
      }

      if (this.usePreviousResponseId) {
        input.push({
          type: "function_call_output",
          call_id: item.callId,
          output: item.output,
        });
        continue;
      }

      // 无状态兼容端点需要显式回放 function_call，再追加 Tool 结果。
      input.push(
        {
          type: "function_call",
          call_id: item.callId,
          name: item.name,
          arguments: item.arguments,
        },
        {
          type: "function_call_output",
          call_id: item.callId,
          output: item.output,
        },
      );
    }

    return input;
  }
}

function isRetryableStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 409 ||
    status === 429 ||
    status >= 500
  );
}

function wait(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted === true) {
    return Promise.reject(signal.reason);
  }

  return new Promise((resolve, reject) => {
    const handleComplete = () => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    };
    const timeout = setTimeout(
      handleComplete,
      milliseconds,
    );
    const handleAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", handleAbort);
      reject(signal?.reason);
    };

    signal?.addEventListener("abort", handleAbort, {
      once: true,
    });
  });
}

function isLlmMessage(
  item: LlmInputItem,
): item is LlmMessage {
  return "role" in item;
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
  private reasoningSummaryOpen = false;
  private readonly output: unknown[] = [];
  private readonly webSearchCallIds = new Set<string>();
  private readonly searchingWebSearchCallIds = new Set<string>();
  private readonly completedWebSearchCallIds = new Set<string>();

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

    this.completeReasoningSummary();
    this.completeOpenWebSearchCalls();

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

      if (
        isRecord(event.item) &&
        event.item.type === "reasoning"
      ) {
        this.completeReasoningSummary();
      }

      if (
        isRecord(event.item) &&
        event.item.type === "web_search_call" &&
        typeof event.item.id === "string"
      ) {
        this.startWebSearch(event.item.id);
        this.completeWebSearch(
          event.item.id,
          extractWebSearchQuery(event.item),
        );
      }
    }

    if (
      event.type === "response.output_item.added" &&
      isRecord(event.item) &&
      event.item.type === "web_search_call" &&
      typeof event.item.id === "string"
    ) {
      this.startWebSearch(event.item.id);
    }

    if (
      event.type === "response.web_search_call.in_progress" &&
      typeof event.item_id === "string"
    ) {
      this.startWebSearch(event.item_id);
    }

    if (
      event.type === "response.web_search_call.searching" &&
      typeof event.item_id === "string"
    ) {
      this.startWebSearch(event.item_id);

      if (!this.searchingWebSearchCallIds.has(event.item_id)) {
        this.searchingWebSearchCallIds.add(event.item_id);
        this.onEvent?.({
          type: "web_search_searching",
          callId: event.item_id,
        });
      }
    }

    if (
      event.type === "response.web_search_call.completed" &&
      typeof event.item_id === "string"
    ) {
      // 查询文本随后才出现在 output_item.done；此处先登记 ID，避免缺少 added 时丢事件。
      this.startWebSearch(event.item_id);
    }

    if (
      event.type === "response.output_text.delta" &&
      typeof event.delta === "string"
    ) {
      // Assistant 开始输出前先结束摘要块，保证 UI 顺序与 Codex 一致。
      this.completeReasoningSummary();
      this.onEvent?.({
        type: "output_text_delta",
        delta: event.delta,
      });
    }

    if (
      event.type ===
        "response.reasoning_summary_part.added" &&
      isNonNegativeInteger(event.summary_index)
    ) {
      // 与 Codex 一样保留 summary_index，供上层区分同一轮中的多段公开摘要。
      this.onEvent?.({
        type: "reasoning_summary_part_added",
        summaryIndex: event.summary_index,
      });
    }

    if (
      event.type ===
        "response.reasoning_summary_text.delta" &&
      typeof event.delta === "string" &&
      isNonNegativeInteger(event.summary_index)
    ) {
      this.reasoningSummaryOpen = true;
      this.onEvent?.({
        type: "reasoning_summary_delta",
        summaryIndex: event.summary_index,
        delta: event.delta,
      });
    }

    if (
      event.type === "response.output_text.annotation.added" &&
      isRecord(event.annotation) &&
      event.annotation.type === "url_citation" &&
      typeof event.annotation.title === "string" &&
      typeof event.annotation.url === "string" &&
      isNonNegativeInteger(event.annotation.start_index) &&
      isNonNegativeInteger(event.annotation.end_index) &&
      event.annotation.end_index >= event.annotation.start_index &&
      isHttpUrl(event.annotation.url)
    ) {
      // 引用必须来自 Provider annotation；Assistant 自己写出的链接不进入 Sources。
      this.onEvent?.({
        type: "url_citation_added",
        title: event.annotation.title,
        url: event.annotation.url,
        startIndex: event.annotation.start_index,
        endIndex: event.annotation.end_index,
      });
    }

    if (event.type === "response.completed") {
      this.completeReasoningSummary();
      this.completeOpenWebSearchCalls();
    }
  }

  private startWebSearch(callId: string): void {
    if (this.webSearchCallIds.has(callId)) {
      return;
    }

    this.webSearchCallIds.add(callId);
    this.onEvent?.({
      type: "web_search_started",
      callId,
    });
  }

  private completeWebSearch(
    callId: string,
    query?: string,
  ): void {
    if (this.completedWebSearchCallIds.has(callId)) {
      return;
    }

    this.completedWebSearchCallIds.add(callId);
    this.onEvent?.({
      type: "web_search_completed",
      callId,
      ...(query === undefined ? {} : { query }),
    });
  }

  private completeOpenWebSearchCalls(): void {
    for (const callId of this.webSearchCallIds) {
      this.completeWebSearch(callId);
    }
  }

  private completeReasoningSummary(): void {
    if (!this.reasoningSummaryOpen) {
      return;
    }

    this.reasoningSummaryOpen = false;
    this.onEvent?.({
      type: "reasoning_summary_completed",
    });
  }
}

function extractWebSearchQuery(
  item: Record<string, unknown>,
): string | undefined {
  if (!isRecord(item.action) || item.action.type !== "search") {
    return undefined;
  }

  if (
    typeof item.action.query === "string" &&
    item.action.query.trim().length > 0
  ) {
    return item.action.query;
  }

  if (Array.isArray(item.action.queries)) {
    return item.action.queries.find(
      (query): query is string =>
        typeof query === "string" && query.trim().length > 0,
    );
  }

  return undefined;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
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

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}
