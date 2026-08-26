import assert from "node:assert/strict";
import {
  fileURLToPath,
} from "node:url";
import test from "node:test";

import {
  MCP_LEGACY_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION,
} from "../src/mcp/mcp-protocol.js";
import {
  McpStdioClient,
} from "../src/mcp/stdio-mcp-client.js";

const fixturePath = fileURLToPath(new URL(
  "./fixtures/mcp-test-server.mjs",
  import.meta.url,
));

function createOptions(mode: string) {
  return {
    command: process.execPath,
    args: [fixturePath, mode],
    requestTimeoutMs: 2_000,
  };
}

test("通过 MCP 2026-07-28 stdio 发现 Server 并列出 Tool", async (context) => {
  const client = await McpStdioClient.start(
    createOptions("happy"),
  );

  context.after(() => client.close());

  assert.deepEqual(client.discovery, {
    supportedVersions: [MCP_PROTOCOL_VERSION],
    capabilities: { tools: {} },
    instructions: "Deterministic MCP test server",
  });

  const page = await client.listTools();

  assert.deepEqual(page, {
    tools: [
      {
        name: "echo",
        description: "Echo deterministic text",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
          },
          required: ["text"],
          additionalProperties: false,
        },
      },
    ],
  });

  await client.close();
  assert.equal(client.isClosed, true);
});

test("拒绝不支持 MCP 2026-07-28 的 Server", async () => {
  await assert.rejects(
    () => McpStdioClient.start(
      createOptions("unsupported-version"),
    ),
    /does not support protocol 2026-07-28/,
  );
});

test("启动发现使用独立 timeout，不受短 Tool request timeout 影响", async (context) => {
  const client = await McpStdioClient.start({
    ...createOptions("slow-discover"),
    requestTimeoutMs: 20,
    discoveryTimeoutMs: 2_000,
  });
  context.after(() => client.close());
  assert.equal(client.discovery.instructions, "Deterministic MCP test server");
  await assert.rejects(
    () => client.callTool("echo", { text: "slow" }),
    /MCP request timed out: tools\/call/,
  );
});

test("并发启动多个 MCP Client 时 discovery 预算与短调用预算仍隔离", async (context) => {
  const clients = await Promise.all(
    Array.from({ length: 3 }, () => McpStdioClient.start({
      ...createOptions("slow-discover"),
      requestTimeoutMs: 20,
      discoveryTimeoutMs: 2_000,
    })),
  );
  context.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
  });

  assert.deepEqual(clients.map((client) => client.discovery.instructions), [
    "Deterministic MCP test server",
    "Deterministic MCP test server",
    "Deterministic MCP test server",
  ]);
  await Promise.all(clients.map(async (client) => {
    await assert.rejects(
      () => client.callTool("echo", { text: "slow" }),
      /MCP request timed out: tools\/call/,
    );
  }));
});

test("拒绝非正 discovery timeout 配置", async () => {
  for (const discoveryTimeoutMs of [0, -1, 1.5]) {
    await assert.rejects(
      () => McpStdioClient.start({ ...createOptions("happy"), discoveryTimeoutMs }),
      /MCP discoveryTimeoutMs must be a positive integer/,
    );
  }
});

test("拒绝缺少 jsonrpc 2.0 的 MCP 消息", async () => {
  await assert.rejects(
    () => McpStdioClient.start(
      createOptions("missing-jsonrpc"),
    ),
    /jsonrpc must be 2\.0/,
  );
});

test("拒绝根节点不是 object 的 MCP Tool Schema", async (context) => {
  const client = await McpStdioClient.start(
    createOptions("invalid-tool-schema"),
  );

  context.after(() => client.close());

  await assert.rejects(
    () => client.listTools(),
    /Invalid MCP Tool definition/,
  );
});

test("新版发现不支持时回退到 MCP 2025-11-25 initialize", async (context) => {
  const client = await McpStdioClient.start(
    createOptions("legacy"),
  );

  context.after(() => client.close());

  assert.equal(
    client.protocolVersion,
    MCP_LEGACY_PROTOCOL_VERSION,
  );
  assert.deepEqual(client.discovery, {
    supportedVersions: [MCP_LEGACY_PROTOCOL_VERSION],
    capabilities: { tools: {} },
    instructions: "Legacy deterministic MCP test server",
  });
  assert.equal((await client.listAllTools())[0]?.name, "echo");
});

test("自动遍历 tools/list 的全部分页", async (context) => {
  const client = await McpStdioClient.start(
    createOptions("paginated"),
  );

  context.after(() => client.close());

  assert.deepEqual(
    (await client.listAllTools()).map((tool) => tool.name),
    ["echo", "upper"],
  );
});

test("调用 MCP Tool 并保留 content 与 structuredContent", async (context) => {
  const client = await McpStdioClient.start(
    createOptions("happy"),
  );

  context.after(() => client.close());

  assert.deepEqual(
    await client.callTool("echo", { text: "你好 MCP" }),
    {
      content: [{ type: "text", text: "你好 MCP" }],
      structuredContent: { echoed: "你好 MCP" },
      isError: false,
    },
  );
});

test("MCP Tool 的 isError 作为结果返回而不是破坏连接", async (context) => {
  const client = await McpStdioClient.start(
    createOptions("tool-error"),
  );

  context.after(() => client.close());

  const result = await client.callTool("echo", { text: "fail" });

  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    code: "E_FIXTURE",
  });
  assert.equal((await client.listTools()).tools.length, 1);
});

test("拒绝结构非法的 MCP tools/call 结果", async (context) => {
  const client = await McpStdioClient.start(
    createOptions("invalid-tool-result"),
  );

  context.after(() => client.close());

  await assert.rejects(
    () => client.callTool("echo", { text: "hello" }),
    /Invalid MCP tools\/call result/,
  );
});

test("单个 MCP 请求超时后发送取消通知且 Server 仍可复用", async (context) => {
  const client = await McpStdioClient.start({
    ...createOptions("happy"),
    requestTimeoutMs: 250,
  });

  context.after(() => client.close());

  await assert.rejects(
    () => client.callTool("echo", { text: "slow" }),
    /MCP request timed out: tools\/call/,
  );

  // 等待迟到响应到达，锁定它不会被当作未知 ID 进而关闭 Server。
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal((await client.listTools()).tools.length, 1);
  const status = await client.callTool(
    "cancellation_status",
    {},
  );
  assert.deepEqual(status.structuredContent, {
    cancellationCount: 1,
  });
});

test("AbortSignal 只取消当前 MCP Tool 调用", async (context) => {
  const client = await McpStdioClient.start(
    createOptions("happy"),
  );
  const controller = new AbortController();

  context.after(() => client.close());

  const call = client.callTool(
    "echo",
    { text: "slow" },
    controller.signal,
  );
  controller.abort(new Error("用户取消 MCP Tool"));

  await assert.rejects(call, /用户取消 MCP Tool/);
  assert.equal((await client.listTools()).tools.length, 1);
});
