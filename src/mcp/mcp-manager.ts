import type {
  AgentTool,
} from "../tools/tool-registry.js";
import type {
  McpServerConfig,
} from "./mcp-config.js";
import {
  createMcpAgentTool,
} from "./mcp-tool-adapter.js";
import {
  McpStdioClient,
} from "./stdio-mcp-client.js";

export interface McpServerStatus {
  name: string;
  protocolVersion: string;
  toolCount: number;
}

interface ManagedMcpServer {
  name: string;
  client: McpStdioClient;
  toolCount: number;
}

/** 统一持有所有 MCP 子进程以及转换后的 Agent Tool。 */
export class McpManager {
  private closed = false;

  private constructor(
    private readonly servers: ManagedMcpServer[],
    private readonly tools: AgentTool[],
  ) {}

  static async start(
    configs: readonly McpServerConfig[],
  ): Promise<McpManager> {
    const servers: ManagedMcpServer[] = [];
    const tools: AgentTool[] = [];
    const runtimeNames = new Set<string>();

    try {
      for (const config of configs) {
        const client = await McpStdioClient.start({
          command: config.command,
          args: config.args,
          ...(config.cwd === undefined
            ? {}
            : { cwd: config.cwd }),
          ...(config.requestTimeoutMs === undefined
            ? {}
            : { requestTimeoutMs: config.requestTimeoutMs }),
        });
        const managedServer: ManagedMcpServer = {
          name: config.name,
          client,
          toolCount: 0,
        };

        // 先纳入生命周期，再做 tools/list；发现失败时 finally 路径也能关闭它。
        servers.push(managedServer);
        const mcpTools = await client.listAllTools();
        managedServer.toolCount = mcpTools.length;

        for (const mcpTool of mcpTools) {
          const agentTool = createMcpAgentTool(
            config.name,
            mcpTool,
            client,
          );
          const runtimeName = agentTool.definition.name;

          if (runtimeNames.has(runtimeName)) {
            throw new Error(
              `Duplicate MCP Runtime Tool name: ${runtimeName}`,
            );
          }

          runtimeNames.add(runtimeName);
          tools.push(agentTool);
        }
      }

      return new McpManager(servers, tools);
    } catch (error) {
      // 任一 Server 启动失败时回收此前已经启动的全部子进程。
      await Promise.allSettled(
        servers.map((server) => server.client.close()),
      );
      throw error;
    }
  }

  getAgentTools(): AgentTool[] {
    return [...this.tools];
  }

  getStatuses(): McpServerStatus[] {
    return this.servers.map((server) => ({
      name: server.name,
      protocolVersion: server.client.protocolVersion,
      toolCount: server.toolCount,
    }));
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    await Promise.allSettled(
      this.servers.map((server) => server.client.close()),
    );
  }
}
