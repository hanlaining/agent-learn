# god-agent 工作交接：MCP 收尾与 Electron 启动

> 交接日期：2026-08-04  
> 项目目录：`D:\练手\agent-learn`  
> 当前阶段：单 Agent Runtime、产品化 CLI、Skill Loader、stdio MCP Tool 主链路均已完成  
> 最新基线：`npm run check` 通过，`npm test` 165/165 通过  
> 下一阶段：Electron 01——最小桌面壳与 App Server 握手

> Electron 的 Thinking / Activity 设计见 [`Electron-真实Thinking与Activity分层展示方案.md`](./Electron-真实Thinking与Activity分层展示方案.md)。

## 一、当前架构

```text
god-agent CLI
  ├─ 用户输入、消息队列、Thread 命令
  ├─ Thinking / Reasoning Summary / Search / Sources
  └─ Tool Permission
          ↓ JSONL + 双向 JSON-RPC
App Server
  ├─ Thread / Turn / Item
  ├─ Persistence / Cancel / Timeout / Retry
  └─ Agent Event Notification
          ↓
Agent Loop
  ├─ Context Builder / o200k Token Budget
  ├─ Codex 式滚动 Compaction
  ├─ LLM → Tool → LLM
  └─ ToolOutputLimiter
          ↓
Tool Registry
  ├─ 确定性金融 Tool
  ├─ Workspace Sandbox Tool
  ├─ Skill Loader / read_skill
  └─ stdio MCP Tool
```

CLI 和未来 Electron 都是 App Server 的 Client。Electron 不应复制或重写 Agent Loop、LifecycleStore、Context、Tool Registry 或 MCP。

## 二、已经完成的能力

### Protocol 与 Runtime

- JSON-RPC、JSONL、RequestMap、双向 Connection；
- App Server initialize 握手；
- Thread、Turn、Item、LifecycleStore；
- Runtime JSON 原子持久化与恢复；
- Turn Cancel、Timeout 和 Provider Retry。

### Context 与模型

- 跨 Turn Context Builder；
- `o200k_base` Token 计算；
- Codex 式滚动 Compaction 和 Context Checkpoint；
- OpenAI Responses Provider；
- Reasoning Summary SSE；
- Web Search、Citation 与 Sources。

### Tool 与安全边界

- 通用 Tool Registry；
- CLI Permission：允许一次、本会话允许、拒绝；
- Workspace 路径与符号链接边界；
- 预注册命令、进程树取消、超时和输出限制；
- Tool Output 模型副本限流，Lifecycle 保留完整结果；
- 金额始终由确定性金融 Tool 使用整数“分”计算。

### CLI

- `You ›`、`Assistant ›`、`Thinking…`；
- Reasoning Summary 折叠式摘要展示；
- FIFO 消息队列；
- `/help`、`/status`、`/threads`、`/new`、`/cancel`、`/exit`；
- Thread 恢复；
- 默认产品模式与 `--debug` 学习模式；
- 安全关闭 App Server。

### Skill 与 MCP

- Skill Loader 渐进披露；
- `read_skill`；
- MCP `2026-07-28 server/discover`；
- 回退兼容 `2025-11-25 initialize / initialized`；
- 分页 `tools/list`；
- `tools/call`；
- `content`、`structuredContent`、`isError`；
- `mcp__<server>__<tool>` 命名空间；
- MCP Permission、Abort、Timeout 和连接复用；
- 多 MCP Server 生命周期；
- Fake LLM + MCP + CLI 端到端验收。

## 三、MCP 收尾结论

已完成的是单 Agent 所需的 stdio MCP Tool 主链路：

```text
静态配置
→ 启动 Server
→ 协议协商
→ Tool 发现
→ AgentTool Adapter
→ Permission
→ tools/call
→ Lifecycle Result
→ LLM 最终回答
→ 退出清理
```

详细验收文档：

- [`MCP-实现记录与验收手册.md`](./MCP-实现记录与验收手册.md)
- [`MCP-02-从协议兼容到Agent-CLI完整闭环.md`](./MCP-02-从协议兼容到Agent-CLI完整闭环.md)
- [`阶段总结-03-MCP-Tool从stdio到CLI闭环.md`](./阶段总结-03-MCP-Tool从stdio到CLI闭环.md)

本阶段不继续扩展 Streamable HTTP、Resources、Prompts、Sampling、Elicitation、OAuth 或动态 Tool 通知。

## 四、当前核心文件

| 文件 | 职责 |
|---|---|
| [`src/cli/main.ts`](../src/cli/main.ts) | 现有产品化 CLI Client，可作为 Electron Client 行为参考 |
| [`src/app-server/main.ts`](../src/app-server/main.ts) | App Server 进程入口与 Runtime 组装 |
| [`src/app-server/handlers.ts`](../src/app-server/handlers.ts) | initialize、Thread、Turn、Cancel RPC Handler |
| [`src/protocol/connection.ts`](../src/protocol/connection.ts) | 双向 JSON-RPC Connection |
| [`src/agent/agent-loop.ts`](../src/agent/agent-loop.ts) | Context、Model、Permission、Tool 与 Turn 生命周期 |
| [`src/agent/events.ts`](../src/agent/events.ts) | Renderer 后续需要消费的 Agent Event 类型 |
| [`src/runtime/lifecycle-store.ts`](../src/runtime/lifecycle-store.ts) | Thread、Turn、Item 事实源 |
| [`src/permissions/json-rpc-permission-gate.ts`](../src/permissions/json-rpc-permission-gate.ts) | App Server 反向请求 Client 审批 |
| [`src/mcp/mcp-manager.ts`](../src/mcp/mcp-manager.ts) | MCP Server 和 Tool 生命周期 |
| [`tests/cli-smoke-test.ts`](../tests/cli-smoke-test.ts) | 当前 Client → App Server 端到端行为基线 |

## 五、下一阶段只做 Electron 01

### 目标

```text
启动 Electron
→ Main Process 启动现有 App Server
→ 完成 initialize / initialized
→ Renderer 显示 Runtime 已连接
→ 关闭窗口
→ App Server 安全退出且没有残留进程
```

### 推荐进程边界

```text
Renderer
  只负责 UI
  不接触 Node、Key、child_process 或原始 JSON-RPC
        ↓ contextBridge 暴露的最小 API
Preload
  只转发允许的状态与动作
        ↓ Electron IPC
Main Process
  持有 App Server 子进程
  持有 JsonRpcConnection
  持有秘密环境变量
        ↓ stdin/stdout JSONL
App Server
```

必须坚持：

- `contextIsolation: true`；
- Renderer 禁止 `nodeIntegration`；
- Renderer 不能读取 `process.env`；
- Key 不能通过 IPC、日志或页面传递；
- App Server `stdout` 仍然只能承载 JSONL；
- Electron 是 CLI 的并列 Client，不删除 CLI；
- Electron 关闭时必须等待 App Server 清理；
- 第一切片不实现聊天、侧边栏、Permission 弹窗或 Codex 风格视觉。

### Electron 01 界面草图

```text
┌──────────────────────────────────────────────┐
│ god-agent                                    │
├──────────────────────────────────────────────┤
│                                              │
│             Runtime 正在连接…                │
│                                              │
│  连接成功后显示：                            │
│  ● Runtime 已连接                            │
│                                              │
└──────────────────────────────────────────────┘
```

在真正实现 UI 前，应先向用户确认该结构和所选技术栈。

### Electron 01 验收条件

- [ ] `npm run check` 继续通过；
- [ ] 原有 `npm test` 165 项全部通过；
- [ ] Electron 窗口可以打开；
- [ ] 页面能区分 connecting、connected、failed、closed；
- [ ] Main Process 完成 App Server initialize 握手；
- [ ] App Server 失败时 Renderer 只收到安全错误，不包含环境变量；
- [ ] 关闭窗口后 App Server 子进程退出；
- [ ] CLI 行为没有回归；
- [ ] 新增核心代码包含中文注释。

## 六、Electron 后续切片

Electron 01 验收后，按顺序推进：

```text
Electron 02：输入框 + Thread / Turn + Assistant 流式输出
Electron 03：Thinking / Reasoning Summary / Tool / Search / Sources
Electron 04：Permission 弹窗
Electron 05：Thread 侧边栏与恢复
Electron 06：设置、MCP 状态、异常恢复与 Windows 打包
```

一次只实现一个可验证切片，不要并行进入 Multi-Agent。

## 七、协作约束

- 使用中文沟通和教学；
- 每个文件修改前先说明用途；
- 核心代码写中文注释；
- 用户说“我来手戳”时给完整代码和讲解；
- 用户说“你来实现”时直接实现并验证；
- 保留全部现有未提交修改；
- 不创建分支或 Worktree；
- 未经本轮明确授权，不执行 Git、commit、push、PR 或 merge；
- 不读取、修改或输出 Key；
- 不提交 `.env`、机器路径配置、IDE 文件、日志或缓存；
- 不重做已经通过测试的 Runtime；
- 不提前进入 Multi-Agent；
- 前端 UI 开始实现前，先给 ASCII 草图并等用户确认。

## 八、新任务开始时的检查顺序

1. 完整阅读本交接文档；
2. 阅读 `package.json`、CLI、App Server、Connection 与 Agent Event；
3. 检查项目内是否存在更具体的 `AGENTS.md`；
4. 运行 `npm run check`；
5. 运行 `npm test`，确认 165/165；
6. 用中文复述当前架构；
7. 比较最小 Electron 技术栈方案；
8. 给出 Electron 01 ASCII 草图、文件列表、依赖变化和测试方案；
9. 等用户确认后再安装依赖和实现。

## 九、禁止重做

不要重新实现：

```text
JSON-RPC / JSONL / Connection
Thread / Turn / Item / LifecycleStore
Context Builder / Tokenizer / Compaction
OpenAI Responses / Summary SSE / Web Search
Agent Loop / Event System
Tool Registry / Permission / Sandbox
Persistence / Cancel / Timeout / Retry
产品化 CLI
Skill Loader
stdio MCP Tool 主链路
```

Electron 应复用这些能力。
