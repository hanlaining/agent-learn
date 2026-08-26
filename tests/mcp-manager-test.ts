import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  McpManager,
} from "../src/mcp/mcp-manager.js";
import {
  createMcpAgentTool,
} from "../src/mcp/mcp-tool-adapter.js";
import {
  MCP_LEGACY_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION,
} from "../src/mcp/mcp-protocol.js";
import {
  ToolRegistry,
} from "../src/tools/tool-registry.js";
import {
  AgentLoop,
  TurnCancelledError,
} from "../src/agent/agent-loop.js";
import {
  LifecycleStore,
} from "../src/runtime/lifecycle-store.js";
import {
  ScriptedLlmProvider,
} from "./helpers/scripted-llm.js";

const fixturePath = fileURLToPath(new URL(
  "./fixtures/mcp-test-server.mjs",
  import.meta.url,
));

test("Manager 启动新旧 MCP Server 并生成带命名空间的 Agent Tool", async (context) => {
  const manager = await McpManager.start([
    {
      name: "modern",
      command: process.execPath,
      args: [fixturePath, "happy"],
      requestTimeoutMs: 2_000,
    },
    {
      name: "legacy",
      command: process.execPath,
      args: [fixturePath, "legacy"],
      requestTimeoutMs: 2_000,
    },
  ]);

  context.after(() => manager.close());

  assert.deepEqual(manager.getStatuses(), [
    {
      name: "modern",
      protocolVersion: MCP_PROTOCOL_VERSION,
      toolCount: 1,
    },
    {
      name: "legacy",
      protocolVersion: MCP_LEGACY_PROTOCOL_VERSION,
      toolCount: 1,
    },
  ]);

  const registry = new ToolRegistry(manager.getAgentTools());

  assert.deepEqual(
    registry.getDefinitions().map((tool) => tool.name),
    ["mcp__modern__echo", "mcp__legacy__echo"],
  );
  assert.equal(
    registry.requiresPermission("mcp__modern__echo"),
    true,
  );
  assert.equal(
    registry.getRiskLevel("mcp__modern__echo"),
    "sensitive",
  );
  assert.match(
    registry.getPermissionDescription(
      "mcp__modern__echo",
      '{"text":"hello"}',
    ) ?? "",
    /modern.*echo/,
  );

  const execution = await registry.execute(
    "mcp__modern__echo",
    '{"text":"hello"}',
  );

  assert.deepEqual(execution.result, {
    content: [{ type: "text", text: "hello" }],
    structuredContent: { echoed: "hello" },
    isError: false,
  });
  assert.equal(
    execution.output,
    JSON.stringify(execution.result),
  );

  await manager.close();
});

test("Adapter 为非法或超长 Tool 名生成稳定的模型安全名称", () => {
  const tool = createMcpAgentTool(
    "demo",
    {
      name: "read.file/with a very long name that exceeds the model function name limit",
      inputSchema: { type: "object" },
    },
    {
      callTool: async () => ({ content: [] }),
    },
  );

  assert.match(tool.definition.name, /^[A-Za-z0-9_-]+$/);
  assert.equal(tool.definition.name.length <= 64, true);
  assert.equal(
    tool.definition.name,
    createMcpAgentTool(
      "demo",
      {
        name: "read.file/with a very long name that exceeds the model function name limit",
        inputSchema: { type: "object" },
      },
      { callTool: async () => ({ content: [] }) },
    ).definition.name,
  );
});

test("Adapter 拒绝非 JSON Object 的模型参数", async () => {
  const tool = createMcpAgentTool(
    "demo",
    {
      name: "echo",
      inputSchema: { type: "object" },
    },
    {
      callTool: async () => ({ content: [] }),
    },
  );

  await assert.rejects(
    async () => Promise.resolve(
      tool.execute("[]", {
        signal: new AbortController().signal,
      }),
    ),
    /arguments must be an object/,
  );
});

test("MCP Tool 经过 Permission 和 Agent Loop 后把完整结果交回模型", async (context) => {
  const manager = await McpManager.start([
    {
      name: "demo",
      command: process.execPath,
      args: [fixturePath, "happy"],
      requestTimeoutMs: 2_000,
    },
  ]);

  context.after(() => manager.close());

  const store = new LifecycleStore();
  const thread = store.createThread();
  const turn = store.createTurn(thread.id);
  store.appendItem(turn.id, "user_message", {
    text: "让 MCP 回显 hello",
  });
  const llm = new ScriptedLlmProvider([
    {
      id: "response-mcp-call",
      text: "",
      functionCalls: [
        {
          callId: "call-mcp-1",
          name: "mcp__demo__echo",
          arguments: '{"text":"hello"}',
        },
      ],
    },
    {
      id: "response-mcp-final",
      text: "MCP 已回显 hello",
      functionCalls: [],
    },
  ]);
  const permissionRequests: string[] = [];
  const loop = new AgentLoop({
    lifecycleStore: store,
    llm,
    toolRegistry: new ToolRegistry(
      manager.getAgentTools(),
    ),
    permissionGate: {
      request: async (request) => {
        permissionRequests.push(request.toolName);
        return { decision: "allow" };
      },
    },
  });

  const result = await loop.run(turn.id);

  assert.deepEqual(permissionRequests, [
    "mcp__demo__echo",
  ]);
  assert.deepEqual(result.assistantMessage.content, {
    text: "MCP 已回显 hello",
  });
  assert.deepEqual(
    store.getItemsForTurn(turn.id)[2]?.content,
    {
      callId: "call-mcp-1",
      name: "mcp__demo__echo",
      result: {
        content: [{ type: "text", text: "hello" }],
        structuredContent: { echoed: "hello" },
        isError: false,
      },
    },
  );

  const continuation = llm.requests[1]?.input;
  assert.ok(Array.isArray(continuation));
  assert.match(
    continuation[0]?.output ?? "",
    /"echoed":"hello"/,
  );
});

test("取消 Turn 会沿 AbortSignal 中断正在执行的 MCP Tool", async (context) => {
  const manager = await McpManager.start([
    {
      name: "demo",
      command: process.execPath,
      args: [fixturePath, "happy"],
      requestTimeoutMs: 2_000,
    },
  ]);

  context.after(() => manager.close());

  const store = new LifecycleStore();
  const thread = store.createThread();
  const turn = store.createTurn(thread.id);
  store.appendItem(turn.id, "user_message", {
    text: "启动慢 MCP Tool",
  });
  const llm = new ScriptedLlmProvider([
    {
      id: "response-mcp-slow",
      text: "",
      functionCalls: [
        {
          callId: "call-mcp-slow",
          name: "mcp__demo__echo",
          arguments: '{"text":"slow"}',
        },
      ],
    },
  ]);
  let notifyToolStarted: (() => void) | undefined;
  const toolStarted = new Promise<void>((resolve) => {
    notifyToolStarted = resolve;
  });
  const registry = new ToolRegistry(manager.getAgentTools());
  const loop = new AgentLoop({
    lifecycleStore: store,
    llm,
    toolRegistry: registry,
    events: {
      emit: (event) => {
        if (event.type === "tool/started") {
          notifyToolStarted?.();
        }
      },
    },
  });

  const running = loop.run(turn.id);
  await toolStarted;
  assert.equal(loop.cancel(turn.id), true);
  await assert.rejects(
    running,
    (error: unknown) => error instanceof TurnCancelledError,
  );
  assert.equal(store.getTurn(turn.id)?.status, "interrupted");

  // 取消只影响刚才的请求，Server 进程和 stdio 连接仍能继续服务。
  assert.match(
    (await registry.execute(
      "mcp__demo__echo",
      '{"text":"still-alive"}',
    )).output,
    /still-alive/,
  );
});

test("Manager 发现跨 Server 的重复 Runtime Tool 时关闭全部已启动进程并拒绝启动", async () => {
  await assert.rejects(
    McpManager.start([
      { name: "duplicate", command: process.execPath, args: [fixturePath, "happy"], requestTimeoutMs: 2_000 },
      { name: "duplicate", command: process.execPath, args: [fixturePath, "legacy"], requestTimeoutMs: 2_000 },
    ]),
    /Duplicate MCP Runtime Tool name/,
  );
});

test("Manager 的空配置可重复关闭且返回隔离副本", async () => {
  const manager = await McpManager.start([]);
  const tools = manager.getAgentTools();
  tools.push({} as never);
  assert.deepEqual(manager.getAgentTools(), []);
  assert.deepEqual(manager.getStatuses(), []);
  await manager.close();
  await manager.close();
});
