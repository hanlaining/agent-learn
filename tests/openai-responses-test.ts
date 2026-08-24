import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_OPENAI_RESPONSES_TIMEOUT_MS,
  OpenAiResponsesProvider,
  parseOpenAiResponse,
  parseOpenAiResponseBody,
} from "../src/llm/openai-responses.js";
import type {
  LlmFunctionOutput,
  LlmMessage,
} from "../src/llm/types.js";
import {
  InputItemBudgetExceededError,
} from "../src/runtime/item-budget.js";

test("Responses Provider 默认请求窗口允许复杂任务完成单次模型请求", () => {
  assert.equal(DEFAULT_OPENAI_RESPONSES_TIMEOUT_MS, 180_000);
});

test("Provider 拒绝非法 timeoutMs 配置", () => {
  assert.throws(
    () => new OpenAiResponsesProvider({
      apiKey: "test-key",
      model: "test-model",
      timeoutMs: 0,
    }),
    /timeoutMs must be a positive integer/,
  );
});

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
    'event: response.reasoning_text.delta\ndata: {"type":"response.reasoning_text.delta","delta":"不可公开的原始推理"}\n\n',
    'event: response.reasoning_summary_part.added\ndata: {"type":"response.reasoning_summary_part.added","summary_index":0}\n\n',
    'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","summary_index":0,"delta":"先查账本"}\n\n',
    'event: response.reasoning_summary_part.added\ndata: {"type":"response.reasoning_summary_part.added","summary_index":1}\n\n',
    'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","summary_index":1,"delta":"，再核对结果"}\n\n',
    'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"reasoning","summary":[{"type":"summary_text","text":"先查账本"}]}}\n\n',
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"id":"ws-1","type":"web_search_call","status":"in_progress"}}\n\n',
    'event: response.web_search_call.in_progress\ndata: {"type":"response.web_search_call.in_progress","item_id":"ws-1"}\n\n',
    'event: response.web_search_call.searching\ndata: {"type":"response.web_search_call.searching","item_id":"ws-1"}\n\n',
    'event: response.web_search_call.completed\ndata: {"type":"response.web_search_call.completed","item_id":"ws-1"}\n\n',
    'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"id":"ws-1","type":"web_search_call","status":"completed","action":{"type":"search","query":"2026 财务资料"}}}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"现金流"}\n',
    '\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"为正"}\n\n',
    'event: response.output_text.annotation.added\ndata: {"type":"response.output_text.annotation.added","annotation":{"type":"url_citation","start_index":0,"end_index":3,"title":"OpenAI Developers","url":"https://developers.openai.com/"}}\n\n',
    'event: response.output_text.annotation.added\ndata: {"type":"response.output_text.annotation.added","annotation":{"type":"url_citation","start_index":0,"end_index":3,"title":"unsafe","url":"javascript:alert(1)"}}\n\n',
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
      type: "reasoning_summary_part_added",
      summaryIndex: 0,
    },
    {
      type: "reasoning_summary_delta",
      summaryIndex: 0,
      delta: "先查账本",
    },
    {
      type: "reasoning_summary_part_added",
      summaryIndex: 1,
    },
    {
      type: "reasoning_summary_delta",
      summaryIndex: 1,
      delta: "，再核对结果",
    },
    {
      type: "reasoning_summary_completed",
    },
    {
      type: "web_search_started",
      callId: "ws-1",
    },
    {
      type: "web_search_searching",
      callId: "ws-1",
    },
    {
      type: "web_search_completed",
      callId: "ws-1",
      query: "2026 财务资料",
    },
    {
      type: "output_text_delta",
      delta: "现金流",
    },
    {
      type: "output_text_delta",
      delta: "为正",
    },
    {
      type: "url_citation_added",
      title: "OpenAI Developers",
      url: "https://developers.openai.com/",
      startIndex: 0,
      endIndex: 3,
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

test("内部模型请求可以关闭 Provider 托管 Tool", async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const provider = new OpenAiResponsesProvider({
    apiKey: "test-key",
    model: "test-model",
    webSearch: {
      externalWebAccess: true,
      searchContextSize: "low",
    },
    fetch: async (_input, init) => {
      capturedBody = JSON.parse(
        String(init?.body),
      ) as Record<string, unknown>;
      return new Response(JSON.stringify({
        id: "response-internal",
        output: [
          {
            type: "message",
            content: [
              { type: "output_text", text: "内部摘要" },
            ],
          },
        ],
      }));
    },
  });

  await provider.createResponse({
    instructions: "test",
    input: "test",
    tools: [],
    allowHostedTools: false,
  });

  assert.deepEqual(capturedBody?.tools, []);
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
    webSearch: {
      externalWebAccess: true,
      searchContextSize: "low",
    },
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
          properties: {},
          required: [],
          additionalProperties: false,
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
          properties: {},
          required: [],
          additionalProperties: false,
        },
        strict: true,
      },
      {
        type: "web_search",
        external_web_access: true,
        search_context_size: "low",
      },
    ],
    reasoning: {
      effort: "high",
      summary: "auto",
    },
    include: ["reasoning.encrypted_content"],
    tool_choice: "auto",
    parallel_tool_calls: true,
    store: false,
    stream: true,
    service_tier: "fast",
    previous_response_id: "response-1",
  });

  assert.equal(result.text, "净现金流为 6850 元。");
  assert.deepEqual(result.functionCalls, []);
});

test("Provider does not force optional third-party schemas into strict mode", async () => {
  let capturedStrict: unknown;
  let capturedParameters: unknown;
  const parameters = {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "number" },
    },
    required: ["query"],
  };
  const provider = new OpenAiResponsesProvider({
    apiKey: "test-key",
    model: "test-model",
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        tools: Array<{
          parameters: unknown;
          strict: unknown;
        }>;
      };
      capturedParameters = body.tools[0]?.parameters;
      capturedStrict = body.tools[0]?.strict;
      return new Response(JSON.stringify({
        id: "response-optional-tool",
        output: [{
          type: "message",
          content: [{ type: "output_text", text: "ok" }],
        }],
      }));
    },
  });

  await provider.createResponse({
    instructions: "test",
    input: "test optional tool",
    tools: [{
      name: "third_party_search",
      description: "third-party tool",
      parameters,
    }],
  });

  assert.equal(capturedStrict, false);
  assert.deepEqual(capturedParameters, parameters);
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

test("Provider 最终编码允许 127 和 128 条消息", async () => {
  for (const count of [127, 128]) {
    let fetchCount = 0;
    let encodedItemCount = 0;
    const provider = new OpenAiResponsesProvider({
      apiKey: "test-key",
      model: "test-model",
      maxInputItems: 128,
      maxRetries: 0,
      fetch: async (_input, init) => {
        fetchCount += 1;
        const body = JSON.parse(String(init?.body)) as {
          input: unknown[];
        };
        encodedItemCount = body.input.length;
        return new Response(JSON.stringify({
          id: `response-${count}`,
          output: [{
            type: "message",
            content: [{ type: "output_text", text: "完成" }],
          }],
        }));
      },
    });
    const messages: LlmMessage[] = Array.from(
      { length: count },
      () => ({ role: "user", text: "x" }),
    );

    await provider.createResponse({
      instructions: "test",
      input: messages,
      tools: [],
    });

    assert.equal(fetchCount, 1);
    assert.equal(encodedItemCount, count);
  }
});

test("Provider 最终编码在 129 和 135 items 时联网次数为 0", async () => {
  for (const count of [129, 135]) {
    let fetchCount = 0;
    const provider = new OpenAiResponsesProvider({
      apiKey: "test-key",
      model: "test-model",
      maxInputItems: 128,
      fetch: async () => {
        fetchCount += 1;
        throw new Error("fetch must not be called");
      },
    });
    const messages: LlmMessage[] = Array.from(
      { length: count },
      () => ({ role: "user", text: "private-message" }),
    );

    await assert.rejects(
      () => provider.createResponse({
        instructions: "test",
        input: messages,
        tools: [],
      }),
      (error: unknown) => {
        assert.ok(error instanceof InputItemBudgetExceededError);
        assert.equal(error.estimatedItems, count);
        assert.equal(error.maxInputItems, 128);
        assert.doesNotMatch(error.message, /private-message/);
        return true;
      },
    );
    assert.equal(fetchCount, 0);
  }
});

test("Provider 按最终无状态编码拒绝第 65 个 Tool Output", async () => {
  const createOutputs = (count: number): LlmFunctionOutput[] =>
    Array.from({ length: count }, (_, index) => ({
      callId: `call-${index}`,
      name: "private_tool",
      arguments: `{"privateArgument":${index}}`,
      output: `private-output-${index}`,
    }));

  for (const [count, expectedItems, expectedFetches] of [
    [64, 128, 1],
    [65, 130, 0],
  ] as const) {
    let fetchCount = 0;
    let encodedItemCount = 0;
    const provider = new OpenAiResponsesProvider({
      apiKey: "test-key",
      model: "test-model",
      usePreviousResponseId: false,
      maxInputItems: 128,
      fetch: async (_input, init) => {
        fetchCount += 1;
        const body = JSON.parse(String(init?.body)) as {
          input: unknown[];
        };
        encodedItemCount = body.input.length;
        return new Response(JSON.stringify({
          id: "response-tool-boundary",
          output: [{
            type: "message",
            content: [{ type: "output_text", text: "完成" }],
          }],
        }));
      },
    });

    if (expectedFetches === 1) {
      await provider.createResponse({
        instructions: "test",
        input: createOutputs(count),
        tools: [],
      });
      assert.equal(encodedItemCount, expectedItems);
    } else {
      await assert.rejects(
        () => provider.createResponse({
          instructions: "test",
          input: createOutputs(count),
          tools: [],
        }),
        (error: unknown) => {
          assert.ok(error instanceof InputItemBudgetExceededError);
          assert.equal(error.estimatedItems, expectedItems);
          assert.doesNotMatch(error.message, /private_tool/);
          assert.doesNotMatch(error.message, /private-output/);
          assert.doesNotMatch(error.message, /privateArgument/);
          return true;
        },
      );
    }

    assert.equal(fetchCount, expectedFetches);
  }
});

test("Provider 拒绝非法 maxInputItems 配置", () => {
  assert.throws(
    () => new OpenAiResponsesProvider({
      apiKey: "test-key",
      model: "test-model",
      maxInputItems: 0,
    }),
    /maxInputItems must be a positive integer/,
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

test("Provider 切换模型后下一次请求使用新模型", async () => {
  const requestModels: string[] = [];
  const provider = new OpenAiResponsesProvider({
    apiKey: "test-key",
    model: "gpt-5.6-sol",
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      requestModels.push(body.model);
      return new Response(JSON.stringify({
        id: "response-model-switch",
        output: [{
          type: "message",
          content: [{ type: "output_text", text: "ok" }],
        }],
      }), { status: 200 });
    },
  });

  provider.setModel("gpt-5.6-terra");
  assert.equal(provider.getModel(), "gpt-5.6-terra");
  await provider.createResponse({
    instructions: "test",
    input: "model switch",
    tools: [],
  });

  assert.deepEqual(requestModels, ["gpt-5.6-terra"]);
});
