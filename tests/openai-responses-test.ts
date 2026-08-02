import assert from "node:assert/strict";
import test from "node:test";

import {
  OpenAiResponsesProvider,
  parseOpenAiResponse,
  parseOpenAiResponseBody,
} from "../src/llm/openai-responses.js";

test("解析 OpenAI function_call", () => {
  const response = parseOpenAiResponse({
    id: "response-1",
    output: [
      {
        type: "function_call",
        call_id: "call-1",
        name: "finance_monthly_summary",
        arguments: '{"period":"2026-07"}',
      },
    ],
  });

  assert.equal(response.id, "response-1");
  assert.equal(response.text, "");
  assert.deepEqual(response.functionCalls, [
    {
      callId: "call-1",
      name: "finance_monthly_summary",
      arguments: '{"period":"2026-07"}',
    },
  ]);
});

test("解析 OpenAI SSE 响应", () => {
  const body = [
    "event: response.created",
    'data: {"type":"response.created","response":{"id":"response-sse"}}',
    "",
    "event: response.output_item.done",
    'data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"SSE 回答"}]}}',
    "",
    "event: response.completed",
    'data: {"type":"response.completed","response":{"id":"response-sse"}}',
    "",
  ].join("\n");

  const normalized = parseOpenAiResponseBody(
    body,
    "text/event-stream",
  );

  const response = parseOpenAiResponse(normalized);

  assert.equal(response.id, "response-sse");
  assert.equal(response.text, "SSE 回答");
});

test("Provider 在 SSE 完成前发送文本和推理摘要增量", async () => {
  const chunks = [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"response-stream"}}\n\n',
    'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"先查账本"}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"现金流"}\n',
    '\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"为正"}\n\n',
    'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"现金流为正"}]}}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"response-stream"}}\n\n',
  ];
  const encoder = new TextEncoder();
  const streamEvents: unknown[] = [];

  const provider = new OpenAiResponsesProvider({
    apiKey: "test-key",
    model: "test-model",
    fetch: async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });

      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
        },
      });
    },
  });

  const response = await provider.createResponse({
    instructions: "test",
    input: "test input",
    tools: [],
    onEvent: (event) => streamEvents.push(event),
  });

  assert.equal(response.text, "现金流为正");
  assert.deepEqual(streamEvents, [
    {
      type: "reasoning_summary_delta",
      delta: "先查账本",
    },
    {
      type: "output_text_delta",
      delta: "现金流",
    },
    {
      type: "output_text_delta",
      delta: "为正",
    },
  ]);
});

test("字符串输入编码成显式 user message 数组", async () => {
  let capturedBody: Record<string, unknown> | undefined;

  const provider = new OpenAiResponsesProvider({
    apiKey: "test-key",
    model: "test-model",
    fetch: async (_input, init) => {
      capturedBody = JSON.parse(
        String(init?.body),
      ) as Record<string, unknown>;

      return new Response(
        JSON.stringify({
          id: "response-1",
          output: [
            {
              type: "function_call",
              call_id: "call-1",
              name: "finance_monthly_summary",
              arguments: '{"period":"2026-07"}',
            },
          ],
        }),
        { status: 200 },
      );
    },
  });

  await provider.createResponse({
    instructions: "test instructions",
    input: "分析 2026 年 7 月财务情况",
    tools: [],
  });

  assert.deepEqual(capturedBody?.input, [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: "分析 2026 年 7 月财务情况",
        },
      ],
    },
  ]);
});

test("多轮消息输入保持角色与顺序", async () => {
  let capturedBody: Record<string, unknown> | undefined;

  const provider = new OpenAiResponsesProvider({
    apiKey: "test-key",
    model: "test-model",
    fetch: async (_input, init) => {
      capturedBody = JSON.parse(
        String(init?.body),
      ) as Record<string, unknown>;

      return new Response(
        JSON.stringify({
          id: "response-context",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "继续分析",
                },
              ],
            },
          ],
        }),
        { status: 200 },
      );
    },
  });

  await provider.createResponse({
    instructions: "test",
    input: [
      {
        role: "user",
        text: "分析 2026 年 7 月财务",
      },
      {
        role: "assistant",
        text: "净现金流为 ¥6,850.00",
      },
      {
        role: "user",
        text: "刚才最大的支出是什么？",
      },
    ],
    tools: [],
  });

  assert.deepEqual(capturedBody?.input, [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: "分析 2026 年 7 月财务",
        },
      ],
    },
    {
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: "净现金流为 ¥6,850.00",
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: "刚才最大的支出是什么？",
        },
      ],
    },
  ]);
});

test("Responses Provider 发送工具结果并解析最终文本", async () => {
  let capturedBody: unknown;
  let capturedUrl = "";

  const provider = new OpenAiResponsesProvider({
    apiKey: "test-key",
    model: "test-model",
    baseUrl: "https://example.test/openai/v1/",
    fetch: async (input, init) => {
      capturedUrl = String(input);
      capturedBody = JSON.parse(String(init?.body)) as unknown;

      return new Response(
        JSON.stringify({
          id: "response-2",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "净现金流为 6850 元。",
                },
              ],
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    },
  });

  const result = await provider.createResponse({
    instructions: "test instructions",
    previousResponseId: "response-1",
    input: [
      {
        callId: "call-1",
        name: "finance_monthly_summary",
        arguments: '{"period":"2026-07"}',
        output: '{"netCashFlow":685000}',
      },
    ],
    tools: [
      {
        name: "finance_monthly_summary",
        description: "test tool",
        parameters: {
          type: "object",
        },
      },
    ],
  });

  assert.equal(
    capturedUrl,
    "https://example.test/openai/v1/responses",
  );

  assert.deepEqual(capturedBody, {
    model: "test-model",
    instructions: "test instructions",
    input: [
      {
        type: "function_call_output",
        call_id: "call-1",
        output: '{"netCashFlow":685000}',
      },
    ],
    tools: [
      {
        type: "function",
        name: "finance_monthly_summary",
        description: "test tool",
        parameters: {
          type: "object",
        },
        strict: true,
      },
    ],
    stream: true,
    previous_response_id: "response-1",
  });

  assert.equal(result.text, "净现金流为 6850 元。");
  assert.deepEqual(result.functionCalls, []);
});

test("无状态端点显式回放 function_call", async () => {
  let capturedBody: Record<string, unknown> | undefined;

  const provider = new OpenAiResponsesProvider({
    apiKey: "test-key",
    model: "test-model",
    usePreviousResponseId: false,
    fetch: async (_input, init) => {
      capturedBody = JSON.parse(
        String(init?.body),
      ) as Record<string, unknown>;

      return new Response(
        JSON.stringify({
          id: "response-final",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "完成",
                },
              ],
            },
          ],
        }),
        { status: 200 },
      );
    },
  });

  await provider.createResponse({
    instructions: "test",
    previousResponseId: "ignored-response-id",
    input: [
      {
        callId: "call-1",
        name: "finance_monthly_summary",
        arguments: '{"period":"2026-07"}',
        output: '{"netCashFlow":685000}',
      },
    ],
    tools: [],
  });

  assert.deepEqual(capturedBody?.input, [
    {
      type: "function_call",
      call_id: "call-1",
      name: "finance_monthly_summary",
      arguments: '{"period":"2026-07"}',
    },
    {
      type: "function_call_output",
      call_id: "call-1",
      output: '{"netCashFlow":685000}',
    },
  ]);
  assert.equal(
    "previous_response_id" in (capturedBody ?? {}),
    false,
  );
});

test("Provider 把 Runtime 取消信号传给 fetch", async () => {
  const controller = new AbortController();
  let fetchStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    fetchStarted = resolve;
  });
  const provider = new OpenAiResponsesProvider({
    apiKey: "test-key",
    model: "test-model",
    fetch: async (_input, init) => {
      fetchStarted?.();

      return new Promise((_, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
      });
    },
  });

  const responsePromise = provider.createResponse({
    instructions: "test",
    input: "等待取消",
    tools: [],
    signal: controller.signal,
  });
  await started;
  controller.abort(new Error("user cancelled"));

  await assert.rejects(responsePromise, /user cancelled/);
});

test("Provider 对临时 503 使用有上限的指数退避重试", async () => {
  let requestCount = 0;
  const delays: number[] = [];
  const provider = new OpenAiResponsesProvider({
    apiKey: "test-key",
    model: "test-model",
    maxRetries: 2,
    retryBaseDelayMs: 10,
    sleep: async (milliseconds) => {
      delays.push(milliseconds);
    },
    fetch: async () => {
      requestCount += 1;

      if (requestCount < 3) {
        return new Response("temporary", { status: 503 });
      }

      return new Response(
        JSON.stringify({
          id: "response-after-retry",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "恢复成功",
                },
              ],
            },
          ],
        }),
        { status: 200 },
      );
    },
  });

  const result = await provider.createResponse({
    instructions: "test",
    input: "retry",
    tools: [],
  });

  assert.equal(result.text, "恢复成功");
  assert.equal(requestCount, 3);
  assert.deepEqual(delays, [10, 20]);
});

test("Provider 对 401 不重试", async () => {
  let requestCount = 0;
  const provider = new OpenAiResponsesProvider({
    apiKey: "test-key",
    model: "test-model",
    maxRetries: 3,
    sleep: async () => {
      throw new Error("should not sleep");
    },
    fetch: async () => {
      requestCount += 1;
      return new Response(
        JSON.stringify({
          error: { message: "unauthorized" },
        }),
        {
          status: 401,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    },
  });

  await assert.rejects(
    () => provider.createResponse({
      instructions: "test",
      input: "no retry",
      tools: [],
    }),
    /unauthorized/,
  );
  assert.equal(requestCount, 1);
});
