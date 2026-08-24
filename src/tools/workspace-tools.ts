import type {
  WorkspaceSandbox,
} from "../sandbox/workspace-sandbox.js";
import { strictObjectSchema } from "../llm/tool-schema.js";
import type {
  AgentTool,
} from "./tool-registry.js";

export const LIST_FILES_TOOL_NAME = "list_files";
export const READ_FILE_TOOL_NAME = "read_file";
export const WRITE_FILE_TOOL_NAME = "write_file";

/**
 * Workspace Tool 不直接接触 node:fs，所有路径和容量限制统一交给 Sandbox。
 */
export function createWorkspaceTools(
  sandbox: WorkspaceSandbox,
  options: {
    authorizeWrite?: (input: { turnId?: string; path: string }) => void | Promise<void>;
  } = {},
): AgentTool[] {
  return [
    {
      definition: {
        name: LIST_FILES_TOOL_NAME,
        description:
          "列出当前授权 Workspace 内指定目录的文件和子目录。",
        parameters: strictObjectSchema({
          path: {
            type: "string",
            description:
              "Workspace 内的相对目录；根目录请传入 .。",
          },
        }),
      },
      riskLevel: "read",
      describePermission(argumentsJson) {
        const input = parseArguments(
          LIST_FILES_TOOL_NAME,
          argumentsJson,
        );
        return `列出 Workspace 目录：${readRequiredPath(
          LIST_FILES_TOOL_NAME,
          input,
        )}`;
      },
      async execute(argumentsJson) {
        const input = parseArguments(
          LIST_FILES_TOOL_NAME,
          argumentsJson,
        );
        const path = readRequiredPath(
          LIST_FILES_TOOL_NAME,
          input,
        );
        const result = await sandbox.listFiles(path);

        return {
          result,
          modelOutput: result,
        };
      },
    },
    {
      definition: {
        name: READ_FILE_TOOL_NAME,
        description:
          "读取当前授权 Workspace 内 UTF-8 文本文件。",
        parameters: strictObjectSchema({
          path: {
            type: "string",
            description: "Workspace 内的相对文件路径。",
          },
        }),
      },
      riskLevel: "read",
      describePermission(argumentsJson) {
        const input = parseArguments(
          READ_FILE_TOOL_NAME,
          argumentsJson,
        );
        return `读取 Workspace 文件：${readRequiredPath(
          READ_FILE_TOOL_NAME,
          input,
        )}`;
      },
      async execute(argumentsJson) {
        const input = parseArguments(
          READ_FILE_TOOL_NAME,
          argumentsJson,
        );
        const path = readRequiredPath(
          READ_FILE_TOOL_NAME,
          input,
        );
        const result = await sandbox.readTextFile(path);

        return {
          result,
          modelOutput: result,
        };
      },
    },
    {
      definition: {
        name: WRITE_FILE_TOOL_NAME,
        description: "Write complete UTF-8 text to one file inside the authorized Workspace. Use only after the requirement revision is confirmed.",
        parameters: strictObjectSchema({
          path: { type: "string", description: "Workspace-relative file path." },
          text: { type: "string", description: "Complete replacement file content." },
        }),
      },
      riskLevel: "execute",
      describePermission(argumentsJson) {
        const input = parseArguments(WRITE_FILE_TOOL_NAME, argumentsJson, ["path", "text"]);
        return `写入 Workspace 文件：${readRequiredPath(WRITE_FILE_TOOL_NAME, input)}`;
      },
      async execute(argumentsJson, context) {
        const input = parseArguments(WRITE_FILE_TOOL_NAME, argumentsJson, ["path", "text"]);
        if (typeof input.text !== "string") throw new Error("write_file text must be a string");
        const path = readRequiredPath(WRITE_FILE_TOOL_NAME, input);
        await options.authorizeWrite?.({ ...(context.turnId === undefined ? {} : { turnId: context.turnId }), path });
        const result = await sandbox.writeTextFile(path, input.text);
        return { result, modelOutput: result };
      },
    },
  ];
}

export function assertWorkspacePathWithinTaskScope(
  path: string,
  scope: { allowedPaths: readonly string[]; deniedPaths: readonly string[] },
): void {
  const normalized = normalizeWorkspacePath(path);
  const denied = scope.deniedPaths.some((candidate) => candidate === "*" || pathWithin(normalized, normalizeWorkspacePath(candidate)));
  const allowed = scope.allowedPaths.some((candidate) => pathWithin(normalized, normalizeWorkspacePath(candidate)));
  if (denied || !allowed) throw new Error(`Task file boundary rejected write: ${path}`);
}

function normalizeWorkspacePath(value: string): string {
  const slashPath = value.replace(/\\/g, "/");
  if (
    slashPath.startsWith("/") ||
    /^[a-zA-Z]:\//.test(slashPath) ||
    slashPath.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`Task file boundary rejected non-canonical path: ${value}`);
  }
  return slashPath.replace(/\/{2,}/g, "/").replace(/\/\*\*$/, "").replace(/\/$/, "");
}

function pathWithin(path: string, boundary: string): boolean {
  return path === boundary || path.startsWith(`${boundary}/`);
}

function parseArguments(
  toolName: string,
  argumentsJson: string,
  allowedKeys: readonly string[] = ["path"],
): Record<string, unknown> {
  let value: unknown;

  try {
    value = JSON.parse(argumentsJson) as unknown;
  } catch {
    throw new Error(
      `${toolName} arguments must be valid JSON`,
    );
  }

  if (!isRecord(value)) {
    throw new Error(
      `${toolName} arguments must be an object`,
    );
  }

  const unexpectedKeys = Object.keys(value).filter(
    (key) => !allowedKeys.includes(key),
  );

  if (unexpectedKeys.length > 0) {
    throw new Error(
      `${toolName} arguments contain unknown fields`,
    );
  }

  return value;
}

function readRequiredPath(
  toolName: string,
  input: Record<string, unknown>,
): string {
  return readPath(toolName, input.path);
}

function readPath(
  toolName: string,
  value: unknown,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0
  ) {
    throw new Error(
      `${toolName} path must be a non-empty string`,
    );
  }

  return value;
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
