# 阶段总结 03：MCP Tool 从 stdio 到 CLI 闭环

本阶段没有改写 Agent Loop，而是把 MCP 作为外部 Tool 来源接入现有 Runtime。

## 完成步骤

1. 协议兼容：优先使用 `2026-07-28 server/discover`；Server 返回 `-32601` 时回退 `2025-11-25 initialize → initialized`。
2. Tool 发现：遍历 `tools/list` 全部分页，校验 Tool Schema、重复名称和 Cursor。
3. Tool 调用：实现 `tools/call`，完整保留 `content`、`structuredContent`、`isError`。
4. 取消与超时：发送 `notifications/cancelled`，只拒绝对应 Request，迟到响应不破坏连接。
5. 静态配置：`AGENT_MCP_CONFIG` 指向 JSON；只允许命令、参数、工作目录和请求时限，不允许 `env`。
6. Tool Adapter：使用 `mcp__<server>__<tool>` 命名，所有 MCP Tool 默认经过 Permission。
7. Manager：管理多个 MCP 子进程；发现失败和 App Server 退出时统一清理。
8. Agent / CLI：Tool Definition 进入模型，Fake LLM 选择 MCP Tool，CLI 审批后调用并把结果交回模型生成最终回答。

## 核心源码

- [`src/mcp/mcp-protocol.ts`](../src/mcp/mcp-protocol.ts)：协议类型与不可信结果校验。
- [`src/mcp/stdio-mcp-client.ts`](../src/mcp/stdio-mcp-client.ts)：stdio JSON-RPC、新旧握手、分页、调用与取消。
- [`src/mcp/mcp-config.ts`](../src/mcp/mcp-config.ts)：用户静态配置边界。
- [`src/mcp/mcp-tool-adapter.ts`](../src/mcp/mcp-tool-adapter.ts)：MCP Tool 到 AgentTool 的转换。
- [`src/mcp/mcp-manager.ts`](../src/mcp/mcp-manager.ts)：多 Server 生命周期。
- [`src/app-server/main.ts`](../src/app-server/main.ts)：把 MCP Tool 注入现有 Registry，并在退出时关闭 Server。
- [`tests/stdio-mcp-client-test.ts`](../tests/stdio-mcp-client-test.ts)：协议、分页、调用、错误、取消和超时。
- [`tests/mcp-manager-test.ts`](../tests/mcp-manager-test.ts)：Manager、Adapter、Permission、Agent Loop 和 Turn Cancel。
- [`tests/cli-smoke-test.ts`](../tests/cli-smoke-test.ts)：Fake LLM + MCP + CLI 的最终验收。

详细配置与设计说明见 [`MCP-02-从协议兼容到Agent-CLI完整闭环.md`](./MCP-02-从协议兼容到Agent-CLI完整闭环.md)。

## 当前边界

已经完成 stdio MCP Tool 主链路；未实现 Streamable HTTP、Resources、Prompts、Sampling、Elicitation、OAuth、Electron 或 Multi-Agent。
