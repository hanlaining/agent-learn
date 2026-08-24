import assert from "node:assert/strict";
import test from "node:test";

import {
  OpenAiChatCompletionsProvider,
} from "../src/llm/openai-chat-completions.js";
import {
  InputItemBudgetExceededError,
} from "../src/runtime/item-budget.js";

test("兼容插头把 God 消息、工具定义和工具结果翻译为 Chat Completions", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const events: unknown[] = [];
  const provider = new OpenAiChatCompletionsProvider({
    apiKey: "test-key",
    model: "bridge-model",
    baseUrl: "http://127.0.0.1:18800/v1",
    fetch: async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      const body = [
        'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"已"}}]}',
        "",
        'data: {"choices":[{"delta":{"content":"完成","tool_calls":[{"index":0,"id":"call_","function":{"name":"read_","arguments":"{\\\"path\\\":"}}]}}]}',
        "",
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"1","function":{"name":"file","arguments":"\\\"a.txt\\\"}"}}]},"finish_reason":"tool_calls"}]}',
        "",
        "data: [DONE]",
        "",
      ].join("\n");

      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  const response = await provider.createResponse({
    instructions: "system rules",
    input: [
      { role: "user", text: "读取文件" },
      {
        callId: "old-call",
        name: "list_files",
        arguments: "{}",
        output: "a.txt",
      },
    ],
    tools: [
      {
        name: "read_file",
        description: "read",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
    ],
    onEvent: (event) => events.push(event),
  });

  assert.equal(capturedUrl, "http://127.0.0.1:18800/v1/chat/completions");
  assert.equal(
    new Headers(capturedInit?.headers).get("authorization"),
    "Bearer test-key",
  );
  const body = JSON.parse(String(capturedInit?.body));
  assert.equal(body.model, "bridge-model");
  assert.deepEqual(body.messages.slice(0, 4), [
    { role: "system", content: "system rules" },
    { role: "user", content: "读取文件" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "old-call",
        type: "function",
        function: { name: "list_files", arguments: "{}" },
      }],
    },
    { role: "tool", tool_call_id: "old-call", content: "a.txt" },
  ]);
  assert.equal(body.tools[0].function.name, "read_file");
  assert.deepEqual(response, {
    id: "chatcmpl-1",
    text: "已完成",
    functionCalls: [{
      callId: "call_1",
      name: "read_file",
      arguments: '{"path":"a.txt"}',
    }],
  });
  assert.deepEqual(events, [
    { type: "output_text_delta", delta: "已" },
    { type: "output_text_delta", delta: "完成" },
  ]);
});

test("兼容插头支持无 Key 本地服务和非流式 JSON 回落", async () => {
  let authorization: string | null = "unexpected";
  const provider = new OpenAiChatCompletionsProvider({
    model: "llama3",
    baseUrl: "http://localhost:11434/v1",
    fetch: async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization");
      return Response.json({
        id: "chatcmpl-json",
        choices: [{
          finish_reason: "tool_calls",
          message: {
            content: "本地完成",
            tool_calls: [{
              id: "call-json",
              function: { name: "done", arguments: "{}" },
            }],
          },
        }],
      });
    },
  });

  const response = await provider.createResponse({
    instructions: "",
    input: "hello",
    tools: [],
  });

  assert.equal(authorization, null);
  assert.deepEqual(response, {
    id: "chatcmpl-json",
    text: "本地完成",
    functionCalls: [{
      callId: "call-json",
      name: "done",
      arguments: "{}",
    }],
  });
});

test("兼容插头在预算超限时不发起网络请求", async () => {
  let fetchCalls = 0;
  const provider = new OpenAiChatCompletionsProvider({
    model: "fixture",
    maxInputItems: 1,
    fetch: async () => {
      fetchCalls += 1;
      return Response.json({});
    },
  });

  await assert.rejects(
    provider.createResponse({
      instructions: "system",
      input: "user",
      tools: [],
    }),
    InputItemBudgetExceededError,
  );
  assert.equal(fetchCalls, 0);
});

test("兼容插头保留上游错误状态和消息", async () => {
  const provider = new OpenAiChatCompletionsProvider({
    model: "fixture",
    fetch: async () => Response.json(
      { error: { message: "model unavailable" } },
      { status: 503 },
    ),
  });

  await assert.rejects(
    provider.createResponse({
      instructions: "",
      input: "hello",
      tools: [],
    }),
    /503.*model unavailable/,
  );
});

test("兼容插头把 SSE 错误事件升级为失败", async () => {
  const provider = new OpenAiChatCompletionsProvider({
    model: "fixture",
    fetch: async () => new Response(
      'data: {"error":{"message":"bridge disconnected"}}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ),
  });

  await assert.rejects(
    provider.createResponse({
      instructions: "",
      input: "hello",
      tools: [],
    }),
    /stream failed: bridge disconnected/,
  );
});

test("兼容插头聚合交错的多个流式 Tool Call", async () => {
  const provider = new OpenAiChatCompletionsProvider({
    model: "fixture",
    fetch: async () => new Response([
      'data: {"id":"chatcmpl-multi","choices":[{"delta":{"tool_calls":[{"index":1,"id":"call-b","function":{"name":"write_","arguments":"{\\"b\\":"}},{"index":0,"id":"call-a","function":{"name":"read_","arguments":"{\\"a\\":"}}]}}]}',
      "",
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"1}"}},{"index":1,"function":{"name":"file","arguments":"2}"}}]},"finish_reason":"tool_calls"}]}',
      "",
    ].join("\n"), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
  });

  const response = await provider.createResponse({
    instructions: "",
    input: "tools",
    tools: [],
  });

  assert.deepEqual(response.functionCalls, [
    { callId: "call-a", name: "read_file", arguments: '{"a":1}' },
    { callId: "call-b", name: "write_file", arguments: '{"b":2}' },
  ]);
});

test("兼容插头把同一轮多个工具结果重放为一组 assistant tool_calls", async () => {
  let messages: Array<Record<string, unknown>> = [];
  const provider = new OpenAiChatCompletionsProvider({
    model: "fixture",
    fetch: async (_input, init) => {
      messages = (JSON.parse(String(init?.body)) as {
        messages: Array<Record<string, unknown>>;
      }).messages;
      return Response.json({ id: "chatcmpl-replay", choices: [{ finish_reason: "stop", message: { content: "done" } }] });
    },
  });

  await provider.createResponse({
    instructions: "",
    input: [
      { role: "user", text: "parallel tools" },
      { callId: "call-a", name: "read_file", arguments: '{"path":"a"}', output: "A" },
      { callId: "call-b", name: "read_file", arguments: '{"path":"b"}', output: "B" },
    ],
    tools: [],
  });

  assert.equal(messages.length, 4);
  assert.equal(messages[1]?.role, "assistant");
  assert.deepEqual(
    (messages[1]?.tool_calls as Array<{ id: string }>).map((call) => call.id),
    ["call-a", "call-b"],
  );
  assert.deepEqual(messages.slice(2), [
    { role: "tool", tool_call_id: "call-a", content: "A" },
    { role: "tool", tool_call_id: "call-b", content: "B" },
  ]);
});

test("兼容插头拒绝没有完成标记的断流，避免把部分回答记成成功", async () => {
  const provider = new OpenAiChatCompletionsProvider({
    model: "fixture",
    fetch: async () => new Response(
      'data: {"id":"chatcmpl-partial","choices":[{"delta":{"content":"partial"}}]}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ),
  });

  await assert.rejects(
    provider.createResponse({
      instructions: "",
      input: "hello",
      tools: [],
    }),
    /ended before completion marker/,
  );
});

test("兼容插头在读取流时保留调用方的取消原因", async () => {
  const controller = new AbortController();
  const expected = new Error("user cancelled compatible request");
  const provider = new OpenAiChatCompletionsProvider({
    model: "fixture",
    fetch: async (_input, init) => {
      const signal = init?.signal;
      return new Response(new ReadableStream<Uint8Array>({
        start(streamController) {
          signal?.addEventListener("abort", () => {
            streamController.error(signal.reason);
          }, { once: true });
        },
      }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  const pending = provider.createResponse({
    instructions: "",
    input: "hello",
    tools: [],
    signal: controller.signal,
  });
  controller.abort(expected);

  await assert.rejects(pending, (error) => error === expected);
});

test("兼容插头超时会中止唯一一次网络请求", async () => {
  let fetchCalls = 0;
  const provider = new OpenAiChatCompletionsProvider({
    model: "fixture",
    timeoutMs: 5,
    fetch: async (_input, init): Promise<Response> => {
      fetchCalls += 1;
      await new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason);
        }, { once: true });
      });
      throw new Error("unreachable");
    },
  });

  await assert.rejects(
    provider.createResponse({
      instructions: "",
      input: "timeout",
      tools: [],
    }),
    (error: unknown) =>
      error instanceof DOMException && error.name === "TimeoutError",
  );
  assert.equal(fetchCalls, 1);
});

test("兼容插头拒绝空响应和终态不完整的 Tool Call", async () => {
  const emptyProvider = new OpenAiChatCompletionsProvider({
    model: "fixture",
    fetch: async () => Response.json({ id: "chatcmpl-empty", choices: [] }),
  });
  await assert.rejects(
    emptyProvider.createResponse({ instructions: "", input: "empty", tools: [] }),
    /Invalid OpenAI Chat Completions response/,
  );

  const incompleteToolProvider = new OpenAiChatCompletionsProvider({
    model: "fixture",
    fetch: async () => new Response([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_file","arguments":"{"}}]},"finish_reason":"tool_calls"}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"), {
      headers: { "content-type": "text/event-stream" },
    }),
  });
  await assert.rejects(
    incompleteToolProvider.createResponse({ instructions: "", input: "tool", tools: [] }),
    /Incomplete OpenAI Chat Completions tool call/,
  );
});

test("兼容插头从 HTTP 和 SSE 错误中移除当前 API Key", async () => {
  const sentinel = "super-secret-sentinel";
  const httpProvider = new OpenAiChatCompletionsProvider({
    apiKey: sentinel,
    model: "fixture",
    fetch: async () => Response.json(
      { error: { message: `credential ${sentinel} rejected` } },
      { status: 401 },
    ),
  });
  await assert.rejects(
    httpProvider.createResponse({ instructions: "", input: "http", tools: [] }),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("[REDACTED]") &&
      !error.message.includes(sentinel),
  );

  const streamProvider = new OpenAiChatCompletionsProvider({
    apiKey: sentinel,
    model: "fixture",
    fetch: async () => new Response(
      `data: {"error":{"message":"credential ${sentinel} rejected"}}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    ),
  });
  await assert.rejects(
    streamProvider.createResponse({ instructions: "", input: "sse", tools: [] }),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("[REDACTED]") &&
      !error.message.includes(sentinel),
  );
});

test("兼容插头不会把 length/content_filter 截断结果记成成功", async () => {
  const streamProvider = new OpenAiChatCompletionsProvider({
    model: "fixture",
    fetch: async () => new Response([
      'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}',
      "",
    ].join("\n"), {
      headers: { "content-type": "text/event-stream" },
    }),
  });
  await assert.rejects(
    streamProvider.createResponse({ instructions: "", input: "stream", tools: [] }),
    /response incomplete: finish_reason=length/,
  );

  const jsonProvider = new OpenAiChatCompletionsProvider({
    model: "fixture",
    fetch: async () => Response.json({
      id: "chatcmpl-filtered",
      choices: [{
        finish_reason: "content_filter",
        message: { content: "partial" },
      }],
    }),
  });
  await assert.rejects(
    jsonProvider.createResponse({ instructions: "", input: "json", tools: [] }),
    /response incomplete: finish_reason=content_filter/,
  );

  const missingReasonStream = new OpenAiChatCompletionsProvider({
    model: "fixture",
    fetch: async () => new Response([
      'data: {"choices":[{"delta":{"content":"looks complete"}}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"), {
      headers: { "content-type": "text/event-stream" },
    }),
  });
  await assert.rejects(
    missingReasonStream.createResponse({ instructions: "", input: "stream", tools: [] }),
    /without a successful finish_reason/,
  );

  const missingReasonJson = new OpenAiChatCompletionsProvider({
    model: "fixture",
    fetch: async () => Response.json({
      id: "chatcmpl-no-reason",
      choices: [{ message: { content: "looks complete" } }],
    }),
  });
  await assert.rejects(
    missingReasonJson.createResponse({ instructions: "", input: "json", tools: [] }),
    /missing a successful finish_reason/,
  );
});
