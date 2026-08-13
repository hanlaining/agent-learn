import readline from "node:readline";

const PROTOCOL_VERSION = "2026-07-28";
const LEGACY_PROTOCOL_VERSION = "2025-11-25";
const mode = process.argv[2] ?? "happy";
const lines = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

let legacyInitialized = false;
let cancellationCount = 0;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result, includeVersion = true) {
  send({
    ...(includeVersion ? { jsonrpc: "2.0" } : {}),
    id,
    result,
  });
}

function sendError(id, code, message) {
  send({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
}

function hasValidMeta(message) {
  const meta = message.params?._meta;

  return (
    meta?.["io.modelcontextprotocol/protocolVersion"] ===
      PROTOCOL_VERSION &&
    typeof meta?.[
      "io.modelcontextprotocol/clientCapabilities"
    ] === "object" &&
    meta?.["io.modelcontextprotocol/clientInfo"]?.name ===
      "god-agent"
  );
}

function createEchoTool(name = "echo") {
  return {
    name,
    description: "Echo deterministic text",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  };
}

function handleToolsList(message) {
  if (mode === "paginated") {
    if (message.params?.cursor === "page-2") {
      sendResult(message.id, {
        tools: [createEchoTool("upper")],
      });
      return;
    }

    sendResult(message.id, {
      tools: [createEchoTool()],
      nextCursor: "page-2",
    });
    return;
  }

  sendResult(message.id, {
    tools: [
      mode === "invalid-tool-schema"
        ? {
            ...createEchoTool(),
            inputSchema: { type: "string" },
          }
        : createEchoTool(),
    ],
  });
}

function handleToolCall(message) {
  const toolName = message.params?.name;
  const argumentsValue = message.params?.arguments;

  if (toolName === "cancellation_status") {
    sendResult(message.id, {
      content: [
        { type: "text", text: String(cancellationCount) },
      ],
      structuredContent: { cancellationCount },
    });
    return;
  }

  if (argumentsValue?.text === "slow") {
    setTimeout(() => {
      sendResult(message.id, {
        content: [{ type: "text", text: "late" }],
      });
    }, 400);
    return;
  }

  if (mode === "invalid-tool-result") {
    sendResult(message.id, { content: "not-an-array" });
    return;
  }

  if (mode === "tool-error") {
    sendResult(message.id, {
      content: [{ type: "text", text: "deterministic failure" }],
      structuredContent: { code: "E_FIXTURE" },
      isError: true,
    });
    return;
  }

  sendResult(message.id, {
    content: [
      {
        type: "text",
        text: String(argumentsValue?.text ?? ""),
      },
    ],
    structuredContent: {
      echoed: argumentsValue?.text ?? "",
    },
    isError: false,
  });
}

for await (const line of lines) {
  if (line.trim().length === 0) {
    continue;
  }

  const message = JSON.parse(line);

  if (message.jsonrpc !== "2.0") {
    sendError(message.id, -32600, "Invalid JSON-RPC version");
    continue;
  }

  if (message.method === "notifications/cancelled") {
    cancellationCount += 1;
    continue;
  }

  if (mode === "legacy") {
    if (message.method === "server/discover") {
      sendError(message.id, -32601, "Method not found");
      continue;
    }

    if (message.method === "initialize") {
      if (
        message.params?.protocolVersion !==
          LEGACY_PROTOCOL_VERSION ||
        message.params?.clientInfo?.name !== "god-agent"
      ) {
        sendError(message.id, -32602, "Invalid initialize params");
        continue;
      }

      sendResult(message.id, {
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: {
          name: "legacy-test-server",
          version: "1.0.0",
        },
        instructions: "Legacy deterministic MCP test server",
      });
      continue;
    }

    if (message.method === "notifications/initialized") {
      legacyInitialized = true;
      continue;
    }

    if (!legacyInitialized) {
      sendError(message.id, -32002, "Server not initialized");
      continue;
    }
  } else {
    if (!hasValidMeta(message)) {
      sendError(message.id, -32602, "Invalid request metadata");
      continue;
    }

    if (message.method === "server/discover") {
      sendResult(
        message.id,
        {
          supportedVersions:
            mode === "unsupported-version"
              ? [LEGACY_PROTOCOL_VERSION]
              : [PROTOCOL_VERSION],
          capabilities: { tools: {} },
          instructions: "Deterministic MCP test server",
        },
        mode !== "missing-jsonrpc",
      );
      continue;
    }
  }

  if (message.method === "tools/list") {
    handleToolsList(message);
    continue;
  }

  if (message.method === "tools/call") {
    handleToolCall(message);
    continue;
  }

  sendError(message.id, -32601, "Method not found");
}
