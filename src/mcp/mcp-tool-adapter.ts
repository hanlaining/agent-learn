import { createHash } from "node:crypto";

import type {
  AgentTool,
} from "../tools/tool-registry.js";
import type {
  McpTool,
} from "./mcp-protocol.js";
import type {
  McpStdioClient,
} from "./stdio-mcp-client.js";

const MAX_FUNCTION_NAME_LENGTH = 64;

/** 把一个 Server 暴露的 MCP Tool 转成现有 Agent Runtime 的统一 Tool。 */
export function createMcpAgentTool(
  serverName: string,
  tool: McpTool,
  client: Pick<McpStdioClient, "callTool">,
): AgentTool {
  const runtimeName = createMcpRuntimeToolName(
    serverName,
    tool.name,
  );

  return {
    definition: {
      name: runtimeName,
      description:
        tool.description ??
        tool.title ??
        `调用 MCP Server ${serverName} 的 ${tool.name}`,
      parameters: { ...tool.inputSchema },
    },
    // 外部 MCP Server 位于 Runtime 信任边界之外，即使只读也默认询问用户。
    requiresPermission: true,
    riskLevel:
      tool.annotations?.readOnlyHint === true
        ? "read"
        : "sensitive",
    describePermission: () =>
      `允许 MCP Server “${serverName}”执行 Tool “${tool.name}”`,
    async execute(argumentsJson, context) {
      const argumentsValue = parseToolArguments(
        runtimeName,
        argumentsJson,
      );
      const result = await client.callTool(
        tool.name,
        argumentsValue,
        context.signal,
      );

      // LifecycleStore 保存完整 MCP Result；交给模型的副本继续受 ToolOutputLimiter 限制。
      return {
        result,
        modelOutput: result,
      };
    },
  };
}

export function createMcpRuntimeToolName(
  serverName: string,
  toolName: string,
): string {
  const rawName = `mcp__${serverName}__${toolName}`;

  if (
    rawName.length <= MAX_FUNCTION_NAME_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(rawName)
  ) {
    return rawName;
  }

  // 非法字符和超长名称使用稳定哈希消歧，仍满足模型 Function 名称约束。
  const hash = createHash("sha256")
    .update(rawName)
    .digest("hex")
    .slice(0, 10);
  const prefixLength =
    MAX_FUNCTION_NAME_LENGTH - hash.length - 2;
  const safePrefix = rawName
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, prefixLength);

  return `${safePrefix}__${hash}`;
}

function parseToolArguments(
  toolName: string,
  argumentsJson: string,
): Record<string, unknown> {
  let value: unknown;

  try {
    value = JSON.parse(argumentsJson) as unknown;
  } catch {
    throw new Error(
      `MCP Tool arguments must be valid JSON: ${toolName}`,
    );
  }

  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error(
      `MCP Tool arguments must be an object: ${toolName}`,
    );
  }

  return value as Record<string, unknown>;
}
