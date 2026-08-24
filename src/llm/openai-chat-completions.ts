import {
  InputItemBudgetExceededError,
} from "../runtime/item-budget.js";
import type {
  ConfigurableLlmProvider,
  LlmCreateResponseRequest,
  LlmFunctionCall,
  LlmFunctionOutput,
  LlmInputItem,
  LlmMessage,
  LlmResponse,
} from "./types.js";

export interface OpenAiChatCompletionsOptions {
  apiKey?: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxInputItems?: number;
  fetch?: typeof fetch;
}

interface PendingToolCall {
  callId: string;
  name: string;
  arguments: string;
}

export const DEFAULT_OPENAI_CHAT_TIMEOUT_MS = 120_000;

/**
 * OpenAI Chat Completions 兼容插头。
 *
 * 可连接 Gundam Bridge、LovBrowser Bridge、Ollama 以及任何符合
 * /v1/chat/completions 基本协议的官方或中转服务。
 */
export class OpenAiChatCompletionsProvider
implements ConfigurableLlmProvider {
  private readonly apiKey: string;
  private model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxInputItems: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiChatCompletionsOptions) {
    this.apiKey = options.apiKey?.trim() ?? "";
    this.model = requireNonEmpty(options.model, "model");
    this.baseUrl = requireNonEmpty(
      options.baseUrl ?? "https://api.openai.com/v1",
      "baseUrl",
    ).replace(/\/+$/, "");
    this.timeoutMs =
      options.timeoutMs ?? DEFAULT_OPENAI_CHAT_TIMEOUT_MS;
    this.maxInputItems = options.maxInputItems ?? 128;
    this.fetchImpl = options.fetch ?? globalThis.fetch;

    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("timeoutMs must be a positive integer");
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
    this.model = requireNonEmpty(model, "model");
  }

  async createResponse(
    request: LlmCreateResponseRequest,
  ): Promise<LlmResponse> {
    const messages = createChatMessages(
      request.instructions,
      request.input,
    );

    if (messages.length > this.maxInputItems) {
      throw new InputItemBudgetExceededError(
        messages.length,
        this.maxInputItems,
      );
    }

    const tools = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
    const body = {
      model: request.model ?? this.model,
      messages,
      stream: true,
      ...(tools.length === 0
        ? {}
        : {
            tools,
            tool_choice: "auto",
            parallel_tool_calls: true,
          }),
    };
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = request.signal === undefined
      ? timeoutSignal
      : AbortSignal.any([request.signal, timeoutSignal]);
    let response: Response;

    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.apiKey.length === 0
              ? {}
              : { authorization: `Bearer ${this.apiKey}` }),
          },
          body: JSON.stringify(body),
          signal,
        },
      );
    } catch (error) {
      if (request.signal?.aborted === true) {
        throw request.signal.reason;
      }
      throw error;
    }

    try {
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          `OpenAI Chat Completions API failed (${response.status}): ` +
            redactSecret(extractApiError(detail), this.apiKey),
        );
      }

      const contentType = response.headers.get("content-type") ?? "";

      if (!contentType.toLowerCase().includes("text/event-stream")) {
        return parseJsonResponse(
          await response.text(),
          request.onEvent,
          this.apiKey,
        );
      }

      if (response.body === null) {
        throw new Error("OpenAI Chat Completions stream body is missing");
      }

      return await parseEventStream(
        response.body,
        request.onEvent,
        this.apiKey,
      );
    } catch (error) {
      if (request.signal?.aborted === true) {
        throw request.signal.reason;
      }
      throw error;
    }
  }
}

function createChatMessages(
  instructions: string,
  input: string | readonly LlmInputItem[],
): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];

  if (instructions.trim().length > 0) {
    messages.push({ role: "system", content: instructions });
  }

  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }

  for (let index = 0; index < input.length;) {
    const item = input[index]!;

    if (isLlmMessage(item)) {
      messages.push({ role: item.role, content: item.text });
      index += 1;
      continue;
    }

    // 同一轮并行 Tool Call 会形成连续的 FunctionOutput。Chat Completions
    // 要求先用一个 assistant 消息声明整组 tool_calls，再逐个发送 tool 结果。
    const outputs: LlmFunctionOutput[] = [];

    while (index < input.length) {
      const output = input[index]!;

      if (isLlmMessage(output)) {
        break;
      }

      outputs.push(output);
      index += 1;
    }

    messages.push({
      role: "assistant",
      content: null,
      tool_calls: outputs.map((output) => ({
        id: output.callId,
        type: "function",
        function: {
          name: output.name,
          arguments: output.arguments,
        },
      })),
    });
    messages.push(...outputs.map((output) => ({
        role: "tool",
        tool_call_id: output.callId,
        content: output.output,
      })));
  }

  return messages;
}

async function parseEventStream(
  stream: ReadableStream<Uint8Array>,
  onEvent: LlmCreateResponseRequest["onEvent"],
  apiKey: string,
): Promise<LlmResponse> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const state = createResponseState();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      buffer += decoder.decode();
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";

    for (const block of blocks) {
      if (consumeEventBlock(block, state, onEvent, apiKey)) {
        return finishResponse(state);
      }
    }
  }

  if (buffer.trim().length > 0) {
    if (consumeEventBlock(buffer, state, onEvent, apiKey)) {
      return finishResponse(state);
    }
  }

  throw new Error(
    "OpenAI Chat Completions stream ended before completion marker",
  );
}

function consumeEventBlock(
  block: string,
  state: ReturnType<typeof createResponseState>,
  onEvent: LlmCreateResponseRequest["onEvent"],
  apiKey: string,
): boolean {
  const payload = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n")
    .trim();

  if (payload.length === 0) {
    return false;
  }

  if (payload === "[DONE]") {
    throw new Error(
      "OpenAI Chat Completions stream ended without a successful finish_reason",
    );
  }

  let value: unknown;

  try {
    value = JSON.parse(payload);
  } catch {
    return false;
  }

  return consumeCompletionChunk(value, state, onEvent, apiKey);
}

function consumeCompletionChunk(
  value: unknown,
  state: ReturnType<typeof createResponseState>,
  onEvent: LlmCreateResponseRequest["onEvent"],
  apiKey: string,
): boolean {
  if (!isRecord(value)) {
    return false;
  }

  if (isRecord(value.error)) {
    const message = typeof value.error.message === "string"
      ? value.error.message
      : "Unknown upstream stream error";
    throw new Error(
      `OpenAI Chat Completions stream failed: ${redactSecret(message, apiKey)}`,
    );
  }

  if (typeof value.id === "string" && value.id.length > 0) {
    state.id = value.id;
  }

  const choice = Array.isArray(value.choices)
    ? value.choices[0]
    : undefined;

  if (!isRecord(choice)) {
    return false;
  }

  const finished = isSuccessfulFinishReason(choice.finish_reason);

  if (!isRecord(choice.delta)) {
    return finished;
  }

  const delta = choice.delta;

  if (typeof delta.content === "string") {
    state.text += delta.content;
    onEvent?.({
      type: "output_text_delta",
      delta: delta.content,
    });
  }

  if (Array.isArray(delta.tool_calls)) {
    for (const rawCall of delta.tool_calls) {
      if (!isRecord(rawCall)) {
        continue;
      }

      const index = Number.isInteger(rawCall.index)
        ? rawCall.index as number
        : 0;
      const pending = state.toolCalls.get(index) ?? {
        callId: "",
        name: "",
        arguments: "",
      };

      if (typeof rawCall.id === "string") {
        pending.callId += rawCall.id;
      }

      if (isRecord(rawCall.function)) {
        if (typeof rawCall.function.name === "string") {
          pending.name += rawCall.function.name;
        }
        if (typeof rawCall.function.arguments === "string") {
          pending.arguments += rawCall.function.arguments;
        }
      }

      state.toolCalls.set(index, pending);
    }
  }

  return finished;
}

function parseJsonResponse(
  text: string,
  onEvent: LlmCreateResponseRequest["onEvent"],
  apiKey: string,
): LlmResponse {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error("Invalid OpenAI Chat Completions response", {
      cause: error,
    });
  }

  if (!isRecord(value)) {
    throw new Error("Invalid OpenAI Chat Completions response");
  }

  if (isRecord(value.error)) {
    const message = typeof value.error.message === "string"
      ? value.error.message
      : "Unknown upstream error";
    throw new Error(
      `OpenAI Chat Completions response failed: ${redactSecret(message, apiKey)}`,
    );
  }

  const choice = Array.isArray(value.choices)
    ? value.choices[0]
    : undefined;
  const message = isRecord(choice) && isRecord(choice.message)
    ? choice.message
    : undefined;

  if (message === undefined) {
    throw new Error("Invalid OpenAI Chat Completions response");
  }

  if (isRecord(choice)) {
    if (!isSuccessfulFinishReason(choice.finish_reason)) {
      throw new Error(
        "OpenAI Chat Completions response is missing a successful finish_reason",
      );
    }
  }
  const content = typeof message?.content === "string"
    ? message.content
    : "";

  if (content.length > 0) {
    onEvent?.({ type: "output_text_delta", delta: content });
  }

  const rawToolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls
    : [];
  const functionCalls = rawToolCalls.map(parseJsonToolCall);

  if (functionCalls.some((call) => call === undefined)) {
    throw new Error("Invalid OpenAI Chat Completions tool call");
  }

  if (content.length === 0 && functionCalls.length === 0) {
    throw new Error("Empty OpenAI Chat Completions response");
  }

  return {
    id: typeof value.id === "string" && value.id.length > 0
      ? value.id
      : `chatcmpl-compatible-${Date.now()}`,
    text: content,
    functionCalls: functionCalls as LlmFunctionCall[],
  };
}

function parseJsonToolCall(value: unknown): LlmFunctionCall | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !isRecord(value.function) ||
    typeof value.function.name !== "string" ||
    typeof value.function.arguments !== "string"
  ) {
    return undefined;
  }

  if (!isJsonObjectText(value.function.arguments)) {
    return undefined;
  }

  return {
    callId: value.id,
    name: value.function.name,
    arguments: value.function.arguments,
  };
}

function createResponseState(): {
  id: string;
  text: string;
  toolCalls: Map<number, PendingToolCall>;
} {
  return {
    id: "",
    text: "",
    toolCalls: new Map(),
  };
}

function finishResponse(
  state: ReturnType<typeof createResponseState>,
): LlmResponse {
  const functionCalls = [...state.toolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call], index) => {
      if (call.name.length === 0 || !isJsonObjectText(call.arguments)) {
        throw new Error("Incomplete OpenAI Chat Completions tool call");
      }

      return {
        callId: call.callId || `call-compatible-${index}`,
        name: call.name,
        arguments: call.arguments,
      };
    });

  if (state.text.length === 0 && functionCalls.length === 0) {
    throw new Error("Empty OpenAI Chat Completions response");
  }

  return {
    id: state.id || `chatcmpl-compatible-${Date.now()}`,
    text: state.text,
    functionCalls,
  };
}

function isJsonObjectText(value: string): boolean {
  try {
    return isRecord(JSON.parse(value));
  } catch {
    return false;
  }
}

function isSuccessfulFinishReason(value: unknown): boolean {
  if (value === undefined || value === null || value === "") {
    return false;
  }

  if (value === "stop" || value === "tool_calls" || value === "function_call") {
    return true;
  }

  if (typeof value === "string") {
    throw new Error(
      `OpenAI Chat Completions response incomplete: finish_reason=${value}`,
    );
  }

  throw new Error("Invalid OpenAI Chat Completions finish_reason");
}

function redactSecret(value: string, secret: string): string {
  if (secret.length === 0) {
    return value;
  }

  return value.split(secret).join("[REDACTED]");
}

function extractApiError(text: string): string {
  try {
    const value: unknown = JSON.parse(text);

    if (
      isRecord(value) &&
      isRecord(value.error) &&
      typeof value.error.message === "string"
    ) {
      return value.error.message;
    }
  } catch {
    // 非 JSON 错误体按脱敏后的短文本返回。
  }

  return text.trim().slice(0, 300) || "Unknown upstream error";
}

function isLlmMessage(item: LlmInputItem): item is LlmMessage {
  return "role" in item;
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new Error(`${field} must not be empty`);
  }

  return trimmed;
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
