export interface RuntimeToolCapability {
  name: string;
  description: string;
  source: "builtin" | "workspace" | "mcp";
}

export interface RuntimeSkillCapability {
  name: string;
  description: string;
}

export interface RuntimeMcpCapability {
  name: string;
  protocolVersion: string;
  toolCount: number;
}

export interface RuntimeModelCapability {
  id: string;
  label: string;
  reasoningEfforts?: string[];
}

export interface RuntimeCapabilities {
  llm: boolean;
  currentModel?: string;
  models: RuntimeModelCapability[];
  webSearch: boolean;
  tools: RuntimeToolCapability[];
  skills: RuntimeSkillCapability[];
  mcpServers: RuntimeMcpCapability[];
  agents?: Array<{ id: string; name: string; description: string }>;
  multiAgent?: { maxConcurrentRuns: number; maxDepth: number; maxChildrenPerRun: number };
}

export const EMPTY_RUNTIME_CAPABILITIES: RuntimeCapabilities = {
  llm: false,
  models: [],
  webSearch: false,
  tools: [],
  skills: [],
  mcpServers: [],
};

export function isRuntimeCapabilities(
  value: unknown,
): value is RuntimeCapabilities {
  return (
    isRecord(value) &&
    typeof value.llm === "boolean" &&
    (value.currentModel === undefined || isNonEmptyString(value.currentModel)) &&
    Array.isArray(value.models) &&
    value.models.every(isModel) &&
    typeof value.webSearch === "boolean" &&
    Array.isArray(value.tools) &&
    value.tools.every(isTool) &&
    Array.isArray(value.skills) &&
    value.skills.every(isSkill) &&
    Array.isArray(value.mcpServers) &&
    value.mcpServers.every(isMcpServer) &&
    (value.agents === undefined || Array.isArray(value.agents)) &&
    (value.multiAgent === undefined || isRecord(value.multiAgent))
  );
}

export function cloneRuntimeCapabilities(
  value: RuntimeCapabilities,
): RuntimeCapabilities {
  return {
    llm: value.llm,
    ...(value.currentModel === undefined
      ? {}
      : { currentModel: value.currentModel }),
    models: value.models.map((model) => ({ ...model })),
    webSearch: value.webSearch,
    tools: value.tools.map((tool) => ({ ...tool })),
    skills: value.skills.map((skill) => ({ ...skill })),
    mcpServers: value.mcpServers.map((server) => ({ ...server })),
    ...(value.agents === undefined ? {} : { agents: value.agents.map((agent) => ({ ...agent })) }),
    ...(value.multiAgent === undefined ? {} : { multiAgent: { ...value.multiAgent } }),
  };
}

function isModel(value: unknown): value is RuntimeModelCapability {
  return isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.label) &&
    (value.reasoningEfforts === undefined ||
      (Array.isArray(value.reasoningEfforts) &&
        value.reasoningEfforts.every(isNonEmptyString)));
}

function isTool(value: unknown): value is RuntimeToolCapability {
  return (
    isRecord(value) &&
    isNonEmptyString(value.name) &&
    typeof value.description === "string" &&
    (value.source === "builtin" ||
      value.source === "workspace" ||
      value.source === "mcp")
  );
}

function isSkill(value: unknown): value is RuntimeSkillCapability {
  return (
    isRecord(value) &&
    isNonEmptyString(value.name) &&
    typeof value.description === "string"
  );
}

function isMcpServer(value: unknown): value is RuntimeMcpCapability {
  return (
    isRecord(value) &&
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.protocolVersion) &&
    Number.isInteger(value.toolCount) &&
    (value.toolCount as number) >= 0
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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
