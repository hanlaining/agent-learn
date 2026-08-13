import type {
  WorkspaceCommandRunner,
} from "../sandbox/workspace-command-runner.js";
import { strictObjectSchema } from "../llm/tool-schema.js";
import type {
  AgentTool,
} from "./tool-registry.js";

export const RUN_COMMAND_TOOL_NAME = "run_command";

/**
 * 模型只能选择已注册配方名，不能传 executable、args 或 shell 片段。
 */
export function createRunCommandTool(
  runner: WorkspaceCommandRunner,
): AgentTool {
  const commands = runner.listCommands();

  return {
    riskLevel: "execute",
    definition: {
      name: RUN_COMMAND_TOOL_NAME,
      description:
        "在授权 Workspace 中运行预注册的检查或测试命令。" +
        "是否需要用户审批由当前 Chat 的权限模式决定。",
      parameters: strictObjectSchema({
        command: {
          type: "string",
          enum: commands,
          description: "要运行的安全命令配方名。",
        },
      }),
    },
    describePermission(argumentsJson) {
      const input = parseRunCommandArguments(argumentsJson);
      const display = runner.getCommandDisplay(input.command);

      if (display === undefined) {
        throw new Error(
          `Command recipe is not allowed: ${input.command}`,
        );
      }

      return `运行受控命令：${display}`;
    },
    async execute(argumentsJson, context) {
      const input = parseRunCommandArguments(argumentsJson);
      const result = await runner.run(
        input.command,
        context.signal,
      );

      return {
        result,
        modelOutput: result,
      };
    },
  };
}

function parseRunCommandArguments(
  argumentsJson: string,
): { command: string } {
  let value: unknown;

  try {
    value = JSON.parse(argumentsJson) as unknown;
  } catch {
    throw new Error(
      "run_command arguments must be valid JSON",
    );
  }

  if (!isRecord(value)) {
    throw new Error("run_command arguments must be an object");
  }

  if (
    Object.keys(value).some((key) => key !== "command")
  ) {
    throw new Error(
      "run_command arguments contain unknown fields",
    );
  }

  if (
    typeof value.command !== "string" ||
    value.command.trim().length === 0
  ) {
    throw new Error(
      "run_command command must be a non-empty string",
    );
  }

  return { command: value.command };
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
