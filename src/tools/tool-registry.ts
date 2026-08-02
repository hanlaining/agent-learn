import type {
  LlmToolDefinition,
} from "../llm/types.js";

export interface AgentToolExecution {
  /** Runtime 保存的原始确定性结果。 */
  result: unknown;
  /** 经过筛选和格式化、允许交给模型阅读的结果。 */
  modelOutput: unknown;
}

export interface AgentToolExecutionContext {
  signal: AbortSignal;
}

export interface AgentTool {
  definition: LlmToolDefinition;
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

  getDefinitions(): LlmToolDefinition[] {
    return [...this.tools.values()].map(
      (tool) => tool.definition,
    );
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

  async execute(
    name: string,
    argumentsJson: string,
    signal = new AbortController().signal,
  ): Promise<ToolRegistryExecution> {
    const tool = this.tools.get(name);

    if (tool === undefined) {
      throw new Error(`Unknown tool: ${name}`);
    }

    signal.throwIfAborted();
    const execution = await tool.execute(
      argumentsJson,
      { signal },
    );
    signal.throwIfAborted();
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
}
