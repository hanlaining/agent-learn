import type {
  LlmToolDefinition,
} from "../llm/types.js";
import type {
  ToolRiskLevel,
} from "../permissions/permission-gate.js";

export interface AgentToolExecution {
  /** Runtime 保存的原始确定性结果。 */
  result: unknown;
  /** 经过筛选和格式化、允许交给模型阅读的结果。 */
  modelOutput: unknown;
}

export interface AgentToolExecutionContext {
  signal: AbortSignal;
  turnId?: string;
}

export interface AgentTool {
  definition: LlmToolDefinition;
  /** 默认需要审批；只读且已由 Runtime 预授权的内部 Tool 可以关闭。 */
  requiresPermission?: boolean;
  riskLevel?: ToolRiskLevel;
  describePermission?: (argumentsJson: string) => string;
  execute(
    argumentsJson: string,
    context: AgentToolExecutionContext,
  ): AgentToolExecution | Promise<AgentToolExecution>;
}

export interface ToolRegistryExecution {
  result: unknown;
  output: string;
}

/**
 * Tool Registry 只负责名称映射、定义列表和确定性执行。
 * Permission 与 Sandbox 会在后续切片包裹 execute，而不是塞进 Registry。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  constructor(tools: readonly AgentTool[] = []) {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  register(tool: AgentTool): void {
    const name = tool.definition.name;

    if (this.tools.has(name)) {
      throw new Error(`Tool already registered: ${name}`);
    }

    this.tools.set(name, tool);
  }

  getDefinitions(allowedNames: readonly string[] = ["*"]): LlmToolDefinition[] {
    return [...this.tools.values()].filter((tool) => isAllowed(tool.definition.name, allowedNames)).map(
      (tool) => tool.definition,
    );
  }

  isAllowed(name: string, allowedNames: readonly string[] = ["*"]): boolean {
    return this.tools.has(name) && isAllowed(name, allowedNames);
  }

  getPermissionDescription(
    name: string,
    argumentsJson: string,
  ): string | undefined {
    const description =
      this.tools.get(name)?.describePermission?.(
        argumentsJson,
      );

    if (
      description !== undefined &&
      description.trim().length === 0
    ) {
      throw new Error(
        `Tool permission description is empty: ${name}`,
      );
    }

    return description;
  }

  requiresPermission(name: string): boolean {
    return this.requireTool(name).requiresPermission !== false;
  }

  getRiskLevel(name: string): ToolRiskLevel {
    return this.requireTool(name).riskLevel ?? "sensitive";
  }

  async execute(
    name: string,
    argumentsJson: string,
    signal = new AbortController().signal,
    turnId?: string,
    allowedNames: readonly string[] = ["*"],
  ): Promise<ToolRegistryExecution> {
    if (!isAllowed(name, allowedNames)) {
      throw new Error(`Tool is not allowed for this Agent: ${name}`);
    }
    const tool = this.requireTool(name);

    signal.throwIfAborted();
    const execution = await tool.execute(
      argumentsJson,
      { signal, ...(turnId === undefined ? {} : { turnId }) },
    );
    // Once a Tool has returned, surface its result so AgentLoop can persist
    // result_received before deciding whether cancellation permits publishing.
    const output = JSON.stringify(execution.modelOutput);

    if (output === undefined) {
      throw new Error(
        `Tool model output is not JSON serializable: ${name}`,
      );
    }

    return {
      result: execution.result,
      output,
    };
  }

  private requireTool(name: string): AgentTool {
    const tool = this.tools.get(name);

    if (tool === undefined) {
      throw new Error(`Unknown tool: ${name}`);
    }

    return tool;
  }
}

function isAllowed(name: string, allowedNames: readonly string[]): boolean {
  return !allowedNames.includes(`!${name}`) &&
    (allowedNames.includes("*") || allowedNames.includes(name));
}
