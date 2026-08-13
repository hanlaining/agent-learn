# MCP 02：从协议兼容到 Agent / CLI 完整闭环

> 逐项验收请查看 [`MCP-实现记录与验收手册.md`](./MCP-实现记录与验收手册.md)。

本阶段完成的是单 Agent 最需要的 MCP Tool 主链路：用户配置一个 stdio MCP Server 后，Tool 会进入模型定义，模型选择后经过 CLI Permission，执行结果返回模型，最终继续生成回答。

## 一、完整数据流

```text
AGENT_MCP_CONFIG
  → 读取用户预设的 Server 命令
  → 启动 stdio 子进程
  → 优先 server/discover（2026-07-28）
  → 不支持时回退 initialize / initialized（2025-11-25）
  → 分页 tools/list
  → MCP Tool 转成 mcp__<server>__<tool>
  → 注册到现有 ToolRegistry
  → LLM 选择 Tool
  → CLI Permission
  → tools/call
  → 完整结果保存到 LifecycleStore
  → 受 ToolOutputLimiter 限制的副本交回 LLM
  → Assistant 最终回答
```

MCP 没有替换 Agent Loop。它是 Tool 的外部来源，仍然经过项目原有的 Registry、Permission、取消、超时、Lifecycle 和 Context 边界。

## 二、核心文件

### 1. 协议边界

源码：[`src/mcp/mcp-protocol.ts`](../src/mcp/mcp-protocol.ts)

负责校验新版 Discovery、旧版 Initialize、分页 Tool Schema，以及 `content`、`structuredContent`、`isError` 组成的 Tool Result。Runtime 不擅自解释图片、音频或资源内容块，只验证最小公共结构并完整保存。

### 2. stdio Client

源码：[`src/mcp/stdio-mcp-client.ts`](../src/mcp/stdio-mcp-client.ts)

负责 JSON-RPC 2.0、JSONL、协议协商、分页 `tools/list`、`tools/call` 和 `notifications/cancelled`。单个请求超时或 Abort 只清理对应 Request，不会杀掉整个 MCP Server；迟到响应会被安全忽略。

### 3. 静态配置边界

源码：[`src/mcp/mcp-config.ts`](../src/mcp/mcp-config.ts)

只接受用户提前写好的 `command`、`args`、`cwd`、`requestTimeoutMs`。不支持 `env`，模型也不能动态生成启动命令；MCP 子进程继续只继承最小系统环境。

示例配置：

```json
{
  "mcpServers": {
    "demo": {
      "command": "node",
      "args": ["D:\\path\\to\\server.mjs"],
      "cwd": "D:\\path\\to",
      "requestTimeoutMs": 10000
    }
  }
}
```

运行前由用户指定文件：

```powershell
$env:AGENT_MCP_CONFIG = "D:\path\to\mcp.json"
node bin/god-agent.js
```

### 4. Agent Tool Adapter

源码：[`src/mcp/mcp-tool-adapter.ts`](../src/mcp/mcp-tool-adapter.ts)

把 MCP Tool 转为现有 `AgentTool`。正常名称使用 `mcp__服务名__工具名`；非法字符或超长名称使用稳定哈希消歧。所有 MCP Tool 默认需要 Permission，即使 Server 声明只读也不会绕过审批。

### 5. 生命周期 Manager

源码：[`src/mcp/mcp-manager.ts`](../src/mcp/mcp-manager.ts)

统一启动多个 Server、聚合 Tool、报告协议版本，并在启动失败或 App Server 退出时关闭全部子进程。发现 Tool 失败时，刚启动但尚未注册完成的 Server 也会被回收。

### 6. App Server 组装

源码：[`src/app-server/main.ts`](../src/app-server/main.ts)

读取 `AGENT_MCP_CONFIG`，把 MCP Tool 与金融、Workspace、Skill Tool 一起放入同一个 Registry；stdin 结束时先关闭 JSON-RPC Connection，再关闭全部 MCP Server。

## 三、结果为何分成 result 与 modelOutput

Adapter 返回：

```text
result      → 完整写入 LifecycleStore，作为事实记录
modelOutput → JSON 序列化后交给模型，再经过 ToolOutputLimiter
```

当前两者内容相同，但职责不同。以后即使模型副本被裁剪，Runtime 仍保存原始 MCP `content`、`structuredContent` 和 `isError`。

`isError: true` 是 MCP Tool 的业务失败结果，不等于 stdio 连接损坏；它会正常交给模型解释，Server 仍能继续使用。

## 四、测试证明了什么

- 新版 `2026-07-28` 与旧版 `2025-11-25` Server 都能发现 Tool。
- `tools/list` 会遍历全部分页并拒绝重复名称或循环 Cursor。
- `tools/call` 保存完整结果，非法结果会在协议边界被拒绝。
- Timeout 与 Abort 会发送取消通知，只取消单个请求。
- 多 Server Tool 使用命名空间，不与内置 Tool 混淆。
- MCP Tool 默认进入 Permission。
- Fake LLM → MCP Tool → Tool Result → Fake LLM 的 Agent Loop 已通过。
- 产品 CLI 已验证 Tool Schema、审批提示、调用结果回放和最终 Assistant 输出。

测试使用仓库内确定性假 Server 和本地假 LLM，不联网、不读取真实 Key。

## 五、当前边界

已经打通的是：

```text
stdio MCP Tool 主链路
```

本阶段没有实现：

```text
Streamable HTTP Transport
resources/list / resources/read
prompts/list / prompts/get
sampling / elicitation
动态 Tool 列表变化通知
OAuth 与需要秘密环境变量的 Server
Electron
Multi-Agent
```

这些是后续扩展能力，不影响当前单 Agent 通过 stdio 使用 MCP Tool。
