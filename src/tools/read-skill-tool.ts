import type {
  SkillLoader,
} from "../skills/skill-loader.js";
import { strictObjectSchema } from "../llm/tool-schema.js";
import type {
  AgentTool,
} from "./tool-registry.js";

export const READ_SKILL_TOOL_NAME = "read_skill";

/**
 * Skill 根目录已经由用户配置并由 Loader 校验，因此按名称读取不再重复审批。
 */
export function createReadSkillTool(
  loaderOrProvider: SkillLoader | (() => SkillLoader),
): AgentTool {
  const getLoader = typeof loaderOrProvider === "function"
    ? loaderOrProvider
    : () => loaderOrProvider;
  const initialSkillNames = getLoader().list().map((skill) => skill.name);

  if (typeof loaderOrProvider !== "function" && initialSkillNames.length === 0) {
    throw new Error("read_skill requires at least one Skill");
  }

  return {
    isAvailable: () => getLoader().list().length > 0,
    requiresPermission: false,
    riskLevel: "read",
    get definition() {
      return {
        name: READ_SKILL_TOOL_NAME,
        description:
          "读取一个已发现 Skill 的完整说明。只有任务匹配 Skill 时才调用。",
        parameters: strictObjectSchema({
          name: {
            type: "string",
            enum: getLoader().list().map((skill) => skill.name),
            description: "要读取的 Skill 名称。",
          },
        }),
      };
    },
    execute(argumentsJson) {
      const name = parseReadSkillArguments(argumentsJson);
      const skill = getLoader().read(name);

      return {
        result: skill,
        modelOutput: skill,
      };
    },
  };
}

function parseReadSkillArguments(argumentsJson: string): string {
  let value: unknown;

  try {
    value = JSON.parse(argumentsJson) as unknown;
  } catch {
    throw new Error("read_skill arguments must be valid JSON");
  }

  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== "name") ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    value.name.trim().length === 0
  ) {
    throw new Error("read_skill requires only a non-empty name");
  }

  return value.name;
}
