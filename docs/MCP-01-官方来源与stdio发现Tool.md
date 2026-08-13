# MCP 01：从官方来源手写 stdio Client，并发现 Tool

> 本文保留第一切片完成时的历史状态。新旧协议兼容、`tools/call`、Permission、Agent Loop 与 CLI 闭环已经在 [`MCP-02-从协议兼容到Agent-CLI完整闭环.md`](./MCP-02-从协议兼容到Agent-CLI完整闭环.md) 完成。

## 一、MCP 到底去哪里找

MCP 不是一个必须购买或申请账号的服务，而是一套 Client 与 Server 通信的开放协议。

本项目只以这些官方来源为准：

1. [MCP 官方规范仓库](https://github.com/modelcontextprotocol/modelcontextprotocol)
2. [2026-07-28 稳定版发布](https://github.com/modelcontextprotocol/modelcontextprotocol/releases/tag/2026-07-28)
3. [2026-07-28 官方 TypeScript Schema](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/2026-07-28/schema/2026-07-28/schema.ts)
4. [官方 TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
5. [官方 MCP Registry](https://registry.modelcontextprotocol.io)
6. [Registry 开源仓库](https://github.com/modelcontextprotocol/registry)

学习协议时看规范与 Schema；准备连接真实 Server 时去 Registry 找。第一片不直接安装公网 Server，而是启动仓库内的确定性测试 Server，先排除网络、账号、版本和 Key 对协议学习的干扰。

## 二、为什么没有照旧教程写 initialize

许多旧教程基于 `2025-11-25`：

```text
initialize
→ initialize result
→ notifications/initialized
→ tools/list
```

截至 2026-08-03，最新稳定规范是 `2026-07-28`。它改成每个 Request 都携带：

```text
_meta.io.modelcontextprotocol/protocolVersion
_meta.io.modelcontextprotocol/clientCapabilities
_meta.io.modelcontextprotocol/clientInfo
```

同时 Server 必须支持 `server/discover`，Client 可以先发现 Server 支持的版本和能力：

```text
启动 stdio Server
→ server/discover
→ 校验 supportedVersions
→ 校验 capabilities.tools
→ tools/list
→ 校验每个 Tool 的 inputSchema
→ close
```

本切片只实现最新稳定版。兼容仍使用 `initialize` 的 `2025-11-25` Server，需要在后续切片中明确实现，不能假装已经兼容。

## 三、为什么项目内的 App Server Connection 不能直接照搬

现有 [`src/protocol/json-rpc.ts`](../src/protocol/json-rpc.ts) 为了学习 Codex App Server，故意省略了标准 JSON-RPC 的：

```json
{ "jsonrpc": "2.0" }
```

MCP Schema 要求 `jsonrpc: "2.0"`。因此 MCP 不能修改原有 App Server 协议，否则会影响已经完成的 Connection；新的 MCP Client 复用了已有 JSONL 分帧和 RequestMap，但在 MCP 边界强制发送并校验 `jsonrpc: "2.0"`。

## 四、本切片的核心文件

### 1. MCP 协议类型与校验

源码：[`src/mcp/mcp-protocol.ts`](../src/mcp/mcp-protocol.ts)

职责：

- 固定稳定协议版本 `2026-07-28`；
- 生成每个 Request 必须携带的 `_meta`；
- 校验 `server/discover`；
- 校验 `tools/list`；
- 强制 Tool 的 `inputSchema.type` 为 `object`；
- 拒绝重复 Tool 名称。

### 2. stdio MCP Client

源码：[`src/mcp/stdio-mcp-client.ts`](../src/mcp/stdio-mcp-client.ts)

职责：

- 使用 `spawn(command, args, { shell: false })` 启动 Server；
- stdin 写 JSON-RPC Request；
- stdout 按 JSONL 解析协议消息；
- stderr 只排空，不混进协议，也不回显可能存在的秘密；
- 使用已有 `RequestMap` 关联请求与响应；
- 为 Request 设置超时；
- Server 不支持当前版本时关闭进程并报错；
- Client 没有声明反向能力时，以 `-32601` 拒绝 Server Request；
- 关闭 Client 时清理等待中的请求和子进程。

### 3. 确定性测试 Server

源码：[`tests/fixtures/mcp-test-server.mjs`](../tests/fixtures/mcp-test-server.mjs)

它不是产品 MCP Server，只负责验证 wire protocol。它只在 stdout 写 JSON-RPC，不读取 Key，也不联网。

### 4. 协议测试

源码：[`tests/stdio-mcp-client-test.ts`](../tests/stdio-mcp-client-test.ts)

覆盖：

1. `server/discover` 成功；
2. `tools/list` 返回确定性 `echo` Tool；
3. 拒绝不支持 `2026-07-28` 的 Server；
4. 拒绝缺少 `jsonrpc: "2.0"` 的消息；
5. 拒绝根节点不是 `object` 的 Tool Schema；
6. 安全关闭 Server 子进程。

## 五、当前能做什么、不能做什么

已经完成：

```text
stdio 子进程
→ MCP JSON-RPC 2.0
→ 每请求协议元数据
→ server/discover
→ tools/list
→ Tool Schema 校验
→ close
```

尚未完成：

```text
2025-11-25 initialize 兼容
tools/call
Tool Registry Adapter
Permission / Cancel 贯穿 MCP Tool
真实 Registry Server 配置
CLI MCP 状态展示
```

所以当前 MCP Client 还是独立协议组件，Agent Loop 还不能调用 MCP Tool。

## 六、验证结果

```text
npm run check                         通过
npx tsx --test tests/stdio-mcp-client-test.ts
                                      4/4 通过
npm test                              148/148 通过
```

## 七、下一切片

为了真正连接 Registry 中的新旧 Server，下一片建议先增加协议兼容协商：

```text
优先尝试 2026-07-28 server/discover
→ 若 Server 明确不认识该方法
→ 回退 2025-11-25 initialize / initialized
→ 统一输出 McpDiscovery 与 McpTool
```

兼容层验证后，再实现 `tools/call` 和 Tool Registry Adapter，避免协议兼容、Tool 执行、Permission 三件事同时混在一个切片。
