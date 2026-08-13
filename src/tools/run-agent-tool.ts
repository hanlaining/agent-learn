import type { MultiAgentScheduler } from "../agents/multi-agent-scheduler.js";
import { strictObjectSchema } from "../llm/tool-schema.js";
import type { AgentTool } from "./tool-registry.js";

export function createRunAgentTool(
  scheduler: () => MultiAgentScheduler,
): AgentTool {
  return {
    definition: {
      name: "run_agent",
      description: "启动一个子 Agent 执行独立子任务；完成后结果会自动回传并继续当前 Agent。",
      parameters: strictObjectSchema({
        // 没有依赖或文件声明时，模型传空数组即可，调度语义保持不变。
        profileId: { type: "string", enum: ["investigator", "researcher", "coder", "tester", "reviewer"] },
        task: { type: "string", minLength: 1, maxLength: 8000 },
        dependsOnTaskIds: { type: "array", items: { type: "string" } },
        fileClaims: { type: "array", items: { type: "string" } },
      }),
    },
    requiresPermission: false,
    riskLevel: "read",
    async execute(argumentsJson, context) {
      const value = JSON.parse(argumentsJson) as unknown;
      if (!isRecord(value) || typeof value.profileId !== "string" ||
        typeof value.task !== "string" || value.task.trim().length === 0) {
        throw new Error("Invalid run_agent arguments");
      }
      const turnId = context.turnId;
      if (turnId === undefined) throw new Error("run_agent requires an active parent Turn");
      const result = await scheduler().runAgent({
        parentTurnId: turnId,
        profileId: value.profileId,
        task: value.task,
        ...(isStringArray(value.dependsOnTaskIds) ? { dependsOnTaskIds: value.dependsOnTaskIds } : {}),
        ...(isStringArray(value.fileClaims) ? { fileClaims: value.fileClaims } : {}),
      });
      return { result, modelOutput: { type: "run_return", ...result } };
    },
  };
}

function isStringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === "string"); }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
