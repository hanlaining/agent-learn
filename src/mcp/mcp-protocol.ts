export const MCP_PROTOCOL_VERSION = "2026-07-28";
export const MCP_LEGACY_PROTOCOL_VERSION = "2025-11-25";
export const MCP_JSON_RPC_VERSION = "2.0";

export interface McpImplementation {
  name: string;
  version: string;
  title?: string;
  description?: string;
  websiteUrl?: string;
}

export interface McpDiscovery {
  supportedVersions: string[];
  capabilities: Record<string, unknown>;
  instructions?: string;
}

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown> & {
    type: "object";
  };
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface McpToolListPage {
  tools: McpTool[];
  nextCursor?: string;
}

export interface McpToolCallResult {
  content: McpContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Runtime 当前不解释 MCP 内容块，只校验最小公共边界并完整保存。
 * 这样 text、image、audio、resource 等标准内容都能原样进入 Tool Result。
 */
export type McpContentBlock = Record<string, unknown> & {
  type: string;
};

export interface McpRequestMeta
  extends Record<string, unknown> {
  "io.modelcontextprotocol/protocolVersion": string;
  "io.modelcontextprotocol/clientCapabilities": Record<
    string,
    unknown
  >;
  "io.modelcontextprotocol/clientInfo": McpImplementation;
}

/**
 * MCP 2026-07-28 不再使用一次性的 initialize 状态。
 * 协议版本、Client 信息和能力必须随每个 Request 一起发送。
 */
export function createMcpRequestMeta(
  protocolVersion: string,
  clientInfo: McpImplementation,
): McpRequestMeta {
  return {
    "io.modelcontextprotocol/protocolVersion":
      protocolVersion,
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": {
      ...clientInfo,
    },
  };
}

export function parseMcpDiscovery(
  value: unknown,
): McpDiscovery {
  if (
    !isRecord(value) ||
    !Array.isArray(value.supportedVersions) ||
    value.supportedVersions.length === 0 ||
    !value.supportedVersions.every(isNonEmptyString) ||
    !isRecord(value.capabilities) ||
    (value.instructions !== undefined &&
      typeof value.instructions !== "string")
  ) {
    throw new Error("Invalid MCP server/discover result");
  }

  if (
    value.capabilities.tools !== undefined &&
    !isRecord(value.capabilities.tools)
  ) {
    throw new Error("Invalid MCP tools capability");
  }

  return {
    supportedVersions: [...value.supportedVersions],
    capabilities: { ...value.capabilities },
    ...(value.instructions === undefined
      ? {}
      : { instructions: value.instructions }),
  };
}

/** 把 2025-11-25 initialize 结果统一成 Runtime 内部的 Discovery。 */
export function parseLegacyMcpInitializeResult(
  value: unknown,
): McpDiscovery {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.protocolVersion) ||
    !isRecord(value.capabilities) ||
    !isRecord(value.serverInfo) ||
    !isNonEmptyString(value.serverInfo.name) ||
    !isNonEmptyString(value.serverInfo.version) ||
    (value.instructions !== undefined &&
      typeof value.instructions !== "string")
  ) {
    throw new Error("Invalid MCP initialize result");
  }

  if (
    value.capabilities.tools !== undefined &&
    !isRecord(value.capabilities.tools)
  ) {
    throw new Error("Invalid MCP tools capability");
  }

  return {
    supportedVersions: [value.protocolVersion],
    capabilities: { ...value.capabilities },
    ...(value.instructions === undefined
      ? {}
      : { instructions: value.instructions }),
  };
}

export function parseMcpToolListPage(
  value: unknown,
): McpToolListPage {
  if (
    !isRecord(value) ||
    !Array.isArray(value.tools) ||
    (value.nextCursor !== undefined &&
      typeof value.nextCursor !== "string")
  ) {
    throw new Error("Invalid MCP tools/list result");
  }

  const tools = value.tools.map(parseMcpTool);
  const names = new Set<string>();

  for (const tool of tools) {
    if (names.has(tool.name)) {
      throw new Error(`Duplicate MCP Tool name: ${tool.name}`);
    }

    names.add(tool.name);
  }

  return {
    tools,
    ...(value.nextCursor === undefined
      ? {}
      : { nextCursor: value.nextCursor }),
  };
}

export function parseMcpToolCallResult(
  value: unknown,
): McpToolCallResult {
  if (
    !isRecord(value) ||
    !Array.isArray(value.content) ||
    (value.structuredContent !== undefined &&
      !isRecord(value.structuredContent)) ||
    (value.isError !== undefined &&
      typeof value.isError !== "boolean")
  ) {
    throw new Error("Invalid MCP tools/call result");
  }

  const content = value.content.map((block) => {
    if (!isRecord(block) || !isNonEmptyString(block.type)) {
      throw new Error("Invalid MCP content block");
    }

    return { ...block, type: block.type };
  });

  return {
    content,
    ...(value.structuredContent === undefined
      ? {}
      : { structuredContent: { ...value.structuredContent } }),
    ...(value.isError === undefined
      ? {}
      : { isError: value.isError }),
  };
}

function parseMcpTool(value: unknown): McpTool {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.name) ||
    (value.title !== undefined &&
      typeof value.title !== "string") ||
    (value.description !== undefined &&
      typeof value.description !== "string") ||
    !isRecord(value.inputSchema) ||
    value.inputSchema.type !== "object" ||
    (value.outputSchema !== undefined &&
      !isRecord(value.outputSchema)) ||
    (value.annotations !== undefined &&
      !isRecord(value.annotations)) ||
    (value._meta !== undefined && !isRecord(value._meta))
  ) {
    throw new Error("Invalid MCP Tool definition");
  }

  return {
    name: value.name,
    ...(value.title === undefined
      ? {}
      : { title: value.title }),
    ...(value.description === undefined
      ? {}
      : { description: value.description }),
    inputSchema: {
      ...value.inputSchema,
      type: "object",
    },
    ...(value.outputSchema === undefined
      ? {}
      : { outputSchema: { ...value.outputSchema } }),
    ...(value.annotations === undefined
      ? {}
      : { annotations: { ...value.annotations } }),
    ...(value._meta === undefined
      ? {}
      : { _meta: { ...value._meta } }),
  };
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

function isNonEmptyString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0
  );
}
