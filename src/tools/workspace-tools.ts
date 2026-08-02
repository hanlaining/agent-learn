import type {
  WorkspaceSandbox,
} from "../sandbox/workspace-sandbox.js";
import type {
  AgentTool,
} from "./tool-registry.js";

export const LIST_FILES_TOOL_NAME = "list_files";
export const READ_FILE_TOOL_NAME = "read_file";

/**
 * Workspace Tool 不直接接触 node:fs，所有路径和容量限制统一交给 Sandbox。
 */
export function createWorkspaceTools(
  sandbox: WorkspaceSandbox,
): AgentTool[] {
  return [
    {
      definition: {
        name: LIST_FILES_TOOL_NAME,
        description:
          "列出当前授权 Workspace 内指定目录的文件和子目录。",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description:
                "Workspace 内的相对目录；省略时使用根目录。",
            },
          },
          additionalProperties: false,
        },
      },
      async execute(argumentsJson) {
        const input = parseArguments(
          LIST_FILES_TOOL_NAME,
          argumentsJson,
        );
        const path = readOptionalPath(input, ".");
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
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Workspace 内的相对文件路径。",
            },
          },
          required: ["path"],
          additionalProperties: false,
        },
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
  ];
}

function parseArguments(
  toolName: string,
  argumentsJson: string,
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
    (key) => key !== "path",
  );

  if (unexpectedKeys.length > 0) {
    throw new Error(
      `${toolName} arguments contain unknown fields`,
    );
  }

  return value;
}

function readOptionalPath(
  input: Record<string, unknown>,
  fallback: string,
): string {
  if (input.path === undefined) {
    return fallback;
  }

  return readPath("list_files", input.path);
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
