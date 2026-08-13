# MCP 实现记录与验收手册

> 完成日期：2026-08-04  
> 项目目录：`D:\练手\agent-learn`  
> 实现范围：单 Agent Runtime 的 stdio MCP Tool 主链路  
> 当前基线：`npm run check` 通过，`npm test` 165/165 通过

## 一、验收结论

当前已经完成：

```text
用户静态配置 MCP Server
→ Runtime 启动 stdio 子进程
→ 新旧 MCP 协议协商
→ 发现全部 Tool
→ 转换为 AgentTool
→ Tool Definition 发送给 LLM
→ LLM 选择 MCP Tool
→ CLI 请求 Permission
→ MCP tools/call
→ 完整结果写入 LifecycleStore
→ 受限副本返回 LLM
→ Assistant 最终回答
→ CLI 退出并关闭 MCP 子进程
```

这说明 MCP 已经进入现有 Agent Loop，并非只能单独列出 Tool。

## 二、MCP 在项目架构中的位置

```text
god-agent CLI
  ├─ 展示 Tool 审批
  └─ 允许 / 拒绝
          ↓ 双向 JSON-RPC
App Server
  ├─ 读取 AGENT_MCP_CONFIG
  ├─ McpManager 管理 MCP Server
  └─ MCP Tool 注入 ToolRegistry
          ↓
Agent Loop
  ├─ LLM 选择 mcp__<server>__<tool>
  ├─ PermissionGate
  ├─ AbortSignal / Timeout
  └─ ToolOutputLimiter
          ↓
MCP Tool Adapter
          ↓ JSON-RPC 2.0 + JSONL + stdio
MCP Server
```

MCP 没有变成第二个 Agent，也没有替换 Agent Loop。它只是现有 Agent 可以调用的一类外部 Tool。

## 三、实现步骤记录

### 步骤 1：定义和校验 MCP 协议数据

文件：[`src/mcp/mcp-protocol.ts`](../src/mcp/mcp-protocol.ts)

作用：

- 定义新版 `2026-07-28` 和兼容版 `2025-11-25`；
- 生成新版每个 Request 携带的 `_meta`；
- 校验 `server/discover`；
- 把旧版 `initialize` 结果转换成统一的 `McpDiscovery`；
- 校验 Tool Schema；
- 校验 `tools/call` 的 `content`、`structuredContent` 和 `isError`。

为什么要校验：MCP Server 属于 Runtime 外部边界，不能默认相信它输出的数据结构。

### 步骤 2：实现 stdio MCP Client

文件：[`src/mcp/stdio-mcp-client.ts`](../src/mcp/stdio-mcp-client.ts)

作用：

- 使用 `spawn(command, args, { shell: false })` 启动 Server；
- stdin 发送 JSON-RPC 2.0；
- stdout 按 JSONL 读取 Response；
- stderr 只排空，不进入协议和模型 Context；
- 使用 Request ID 关联 Request 与 Response；
- 支持分页 `tools/list`；
- 支持 `tools/call`；
- 支持超时和 `AbortSignal`；
- 关闭 Client 时清理请求和子进程。

核心协商顺序：

```text
先发送 server/discover
├─ 成功：使用 2026-07-28
└─ 返回 -32601：
   initialize(2025-11-25)
   → initialize result
   → notifications/initialized
```

这里不会对所有错误都盲目回退。只有 Server 明确返回“方法不存在”时，才判断它可能是旧版 Server。

### 步骤 3：让单个请求可以独立取消

文件：[`src/protocol/request-map.ts`](../src/protocol/request-map.ts)

新增 `reject(id, error)`，只拒绝指定请求：

```text
MCP Tool A 超时
→ 只清理 A
→ 发送 notifications/cancelled
→ MCP Server 和其他请求继续运行
```

如果 Server 后续仍返回 A 的迟到响应，Client 会识别并忽略它，不会把整个连接判定为损坏。

### 步骤 4：读取用户静态 MCP 配置

文件：[`src/mcp/mcp-config.ts`](../src/mcp/mcp-config.ts)

支持字段：

```text
command
args
cwd
requestTimeoutMs
```

配置入口：

```text
AGENT_MCP_CONFIG=D:\path\to\mcp.json
```

配置不支持 `env`。模型不能临时拼接启动命令，也不能借此读取或传递 Provider Key。

### 步骤 5：把 MCP Tool 转成 AgentTool

文件：[`src/mcp/mcp-tool-adapter.ts`](../src/mcp/mcp-tool-adapter.ts)

转换结果：

```text
Server：demo
MCP Tool：echo
Agent Tool：mcp__demo__echo
```

名称包含非法字符或超过模型 Function 名称上限时，Adapter 会生成稳定的安全名称并追加哈希。

所有 MCP Tool 都设置为：

```text
requiresPermission: true
```

即使 MCP Server 声明只读，也只是把风险级别标为 `read`，不会绕过用户审批。

### 步骤 6：保存完整结果，限制模型副本

MCP Adapter 返回：

```text
result      → 完整保存到 LifecycleStore
modelOutput → JSON 序列化并经过 ToolOutputLimiter 后交给 LLM
```

因此大型 MCP 输出即使在模型 Context 中被裁剪，LifecycleStore 中仍保留完整事实结果。

`isError: true` 代表 MCP Tool 返回的业务错误，不代表 stdio 连接已经损坏。该结果仍会交给模型解释，Server 可以继续使用。

### 步骤 7：管理多个 MCP Server

文件：[`src/mcp/mcp-manager.ts`](../src/mcp/mcp-manager.ts)

作用：

- 启动配置中的多个 MCP Server；
- 发现每个 Server 的全部 Tool；
- 生成带 Server 命名空间的 AgentTool；
- 拒绝 Runtime Tool 重名；
- 任一 Server 启动或发现失败时回收已经启动的子进程；
- App Server 退出时统一关闭全部 MCP Server。

### 步骤 8：接入 App Server 和 Agent Loop

文件：[`src/app-server/main.ts`](../src/app-server/main.ts)

App Server 把这些 Tool 放进同一个 Registry：

```text
金融 Tool
Workspace Tool
Skill Tool
MCP Tool
```

因此 MCP Tool 自动复用了现有能力：

- Tool Definition；
- PermissionGate；
- Agent Event；
- Lifecycle Item；
- AbortSignal；
- Turn Timeout；
- ToolOutputLimiter；
- Function Call Result 回放。

## 四、配置示例

下面的配置使用仓库内确定性 MCP Server，不联网，也不需要 MCP Key：

```json
{
  "mcpServers": {
    "demo": {
      "command": "node",
      "args": [
        "D:\\练手\\agent-learn\\tests\\fixtures\\mcp-test-server.mjs",
        "happy"
      ],
      "requestTimeoutMs": 2000
    }
  }
}
```

建议把验收配置保存在仓库外的临时目录，不要提交本机路径配置。

## 五、自动化验收

在 PowerShell 中执行：

```powershell
cd D:\练手\agent-learn

npm run check
npx tsx --test tests/stdio-mcp-client-test.ts
npx tsx --test tests/mcp-config-test.ts tests/mcp-manager-test.ts
npx tsx --test tests/cli-smoke-test.ts
npm test
```

当前预期结果：

```text
npm run check          通过
npm test               165/165 通过
```

测试职责：

| 测试文件 | 验收内容 |
|---|---|
| [`tests/stdio-mcp-client-test.ts`](../tests/stdio-mcp-client-test.ts) | 新旧协议、分页、Tool 调用、非法结果、`isError`、Timeout、Abort |
| [`tests/mcp-config-test.ts`](../tests/mcp-config-test.ts) | 配置解析、相对 cwd、拒绝 env、Server 名称校验 |
| [`tests/mcp-manager-test.ts`](../tests/mcp-manager-test.ts) | 多 Server、命名空间、Permission、Agent Loop、Turn Cancel、连接复用 |
| [`tests/cli-smoke-test.ts`](../tests/cli-smoke-test.ts) | Fake LLM 选择 MCP Tool、CLI 审批、结果回放、最终 Assistant 输出 |
| [`tests/fixtures/mcp-test-server.mjs`](../tests/fixtures/mcp-test-server.mjs) | 不联网的确定性新旧 MCP 测试 Server |

## 六、CLI 端到端验收证据

自动化 CLI 用例实际执行：

```text
Fake LLM 返回 function_call：mcp__demo__echo
→ CLI 显示 Permission:sensitive
→ 测试输入 y
→ Runtime 发送 tools/call
→ MCP 返回 structuredContent.echoed
→ Runtime 发送 function_call_output 给 Fake LLM
→ Assistant 输出：MCP 回显完成：CLI MCP 成功
```

第二次模型请求中已经断言存在：

```text
function_call
function_call_output
```

并且 `function_call_output` 包含 MCP 返回的：

```json
{ "echoed": "CLI MCP 成功" }
```

## 七、手动 CLI 验收

前提：你自己的模型环境变量已经正常配置。不要把 Key 写进 MCP JSON 或文档。

```powershell
$env:AGENT_MCP_CONFIG = "D:\path\to\mcp-acceptance.json"
cd D:\练手\agent-learn
node bin/god-agent.js --debug
```

输入：

```text
请调用 demo MCP Server 的 echo 工具，回显“手动验收成功”。
```

预期过程：

```text
1. 模型选择 mcp__demo__echo
2. CLI 出现 MCP Permission 提示
3. 输入 y
4. debug 日志出现 Tool started / completed
5. Assistant 根据 echo 结果回答
6. 输入 /exit 后 CLI 与 MCP 子进程一起退出
```

模型是否主动选 Tool 具有模型决策的不确定性，所以代码回归以 Fake LLM 自动化用例为确定性证据。

## 八、验收清单

- [ ] `npm run check` 通过。
- [ ] `npm test` 显示 165/165。
- [ ] 能看到新版 MCP `server/discover` 测试通过。
- [ ] 能看到旧版 MCP `initialize` 回退测试通过。
- [ ] 能看到分页 `tools/list` 测试通过。
- [ ] 能看到 `tools/call` 与完整结果测试通过。
- [ ] 能看到 Timeout、Abort 和连接复用测试通过。
- [ ] 能看到 MCP Tool 默认 Permission 测试通过。
- [ ] 能看到 Agent Loop MCP Tool 闭环测试通过。
- [ ] 能看到 CLI MCP 端到端测试通过。
- [ ] 已确认退出时 MCP Server 被关闭。

## 九、本阶段未实现内容

以下内容不属于这次“stdio MCP Tool 主链路”验收：

```text
Streamable HTTP Transport
Resources
Prompts
Sampling
Elicitation
动态 Tool 列表通知
OAuth
秘密环境变量注入
Electron
Multi-Agent
```

## 十、最终判断标准

同时满足下面三项，即可判定本阶段验收通过：

1. `npm run check` 和 `npm test` 全部通过；
2. CLI MCP Smoke Test 完成“模型选择 → 审批 → 调用 → 回放 → 最终回答”；
3. MCP 超时或取消后，Server 连接仍能继续执行下一次 Tool 调用。

当前源码和测试已经满足以上标准。
