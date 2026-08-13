import { readFile } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  resolve,
} from "node:path";

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  requestTimeoutMs?: number;
}

const ROOT_KEYS = new Set(["mcpServers"]);
const SERVER_KEYS = new Set([
  "command",
  "args",
  "cwd",
  "requestTimeoutMs",
]);

/**
 * MCP 启动命令只能来自用户预先写好的配置文件，不能由模型临时拼接。
 * 配置故意不支持 env，子进程只会继承 Stdio Client 的最小安全环境。
 */
export async function loadMcpServerConfigs(
  configPath: string,
): Promise<McpServerConfig[]> {
  if (configPath.trim().length === 0) {
    throw new Error("AGENT_MCP_CONFIG must not be empty");
  }

  const absoluteConfigPath = resolve(configPath);
  let parsed: unknown;

  try {
    parsed = JSON.parse(
      await readFile(absoluteConfigPath, "utf8"),
    ) as unknown;
  } catch (error) {
    throw new Error(
      `Failed to read MCP config: ${absoluteConfigPath}`,
      { cause: error },
    );
  }

  if (!isRecord(parsed)) {
    throw new Error("Invalid MCP config root");
  }

  rejectUnknownKeys(parsed, ROOT_KEYS, "MCP config");

  if (!isRecord(parsed.mcpServers)) {
    throw new Error("MCP config requires mcpServers object");
  }

  const configDirectory = dirname(absoluteConfigPath);

  return Object.entries(parsed.mcpServers).map(
    ([name, value]) =>
      parseServerConfig(name, value, configDirectory),
  );
}

function parseServerConfig(
  name: string,
  value: unknown,
  configDirectory: string,
): McpServerConfig {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid MCP Server name: ${name}`);
  }

  if (!isRecord(value)) {
    throw new Error(`Invalid MCP Server config: ${name}`);
  }

  rejectUnknownKeys(
    value,
    SERVER_KEYS,
    `MCP Server config ${name}`,
  );

  if (
    typeof value.command !== "string" ||
    value.command.trim().length === 0
  ) {
    throw new Error(`MCP Server command is required: ${name}`);
  }

  if (
    value.args !== undefined &&
    (!Array.isArray(value.args) ||
      !value.args.every(
        (argument) => typeof argument === "string",
      ))
  ) {
    throw new Error(`Invalid MCP Server args: ${name}`);
  }

  if (
    value.cwd !== undefined &&
    (typeof value.cwd !== "string" ||
      value.cwd.trim().length === 0)
  ) {
    throw new Error(`Invalid MCP Server cwd: ${name}`);
  }

  if (
    value.requestTimeoutMs !== undefined &&
    (!Number.isInteger(value.requestTimeoutMs) ||
      (value.requestTimeoutMs as number) <= 0)
  ) {
    throw new Error(
      `Invalid MCP Server requestTimeoutMs: ${name}`,
    );
  }

  const cwd = value.cwd as string | undefined;
  const requestTimeoutMs = value.requestTimeoutMs as
    | number
    | undefined;

  return {
    name,
    command: value.command,
    args: value.args === undefined
      ? []
      : [...value.args] as string[],
    ...(cwd === undefined
      ? {}
      : {
          cwd: isAbsolute(cwd)
            ? resolve(cwd)
            : resolve(configDirectory, cwd),
        }),
    ...(requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs }),
  };
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknownKey = Object.keys(value).find(
    (key) => !allowed.has(key),
  );

  if (unknownKey !== undefined) {
    throw new Error(
      `${label} contains unsupported field: ${unknownKey}`,
    );
  }
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
