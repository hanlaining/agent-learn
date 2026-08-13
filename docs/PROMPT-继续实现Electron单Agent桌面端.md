# 新任务 Prompt：继续实现 Electron 单 Agent 桌面端

复制下面代码块内的内容到一个新任务：

```text
请继续教我从 0 到 1 手写 Codex-like 单 Agent Runtime，并开始 Electron 桌面端阶段。

项目目录：
D:\练手\agent-learn

请先完整阅读最新工作交接：
D:\练手\agent-learn\docs\工作交接-2026-08-04-MCP收尾与Electron启动.md

同时阅读 MCP 验收记录，确认 MCP 已经收尾，不要重新实现：
D:\练手\agent-learn\docs\MCP-实现记录与验收手册.md

当前已经完成：

- JSON-RPC、JSONL、RequestMap、双向 Connection 和 App Server；
- Thread、Turn、Item、LifecycleStore 与 Runtime 持久化；
- 跨 Turn Context Builder、o200k Tokenizer、Codex 式滚动 Compaction；
- OpenAI Responses、Reasoning Summary SSE、Web Search 与 Sources；
- Agent Loop、Tool Registry、Permission、Workspace Sandbox；
- Cancel、Timeout、Retry、Resume；
- 产品化 god-agent CLI；
- Skill Loader；
- stdio MCP 新旧协议兼容、tools/list、tools/call、Tool Adapter、Permission、Cancel、Agent Loop 与 CLI 端到端。

最新测试基线：

npm run check 通过
npm test 165/165 通过

下一步只进入 Electron 01：最小桌面壳与 App Server 握手。

本切片目标：

Electron 启动
→ Main Process 启动现有 App Server
→ 完成 initialize / initialized
→ Preload 通过最小安全 API 转发连接状态
→ Renderer 展示 connecting / connected / failed / closed
→ 关闭窗口时安全关闭 App Server，不能残留子进程

本切片不要同时实现：

- 聊天输入和消息列表；
- Thread 侧边栏；
- Thinking / Reasoning Summary UI；
- Tool 或 Search 展示；
- Permission 弹窗；
- MCP 设置页；
- Windows 打包；
- Multi-Agent；
- MCP Streamable HTTP、Resources、Prompts、Sampling、Elicitation 或 OAuth。

安全边界：

1. Electron Renderer 只负责 UI，不能直接访问 child_process、文件系统、原始 JSON-RPC 或 process.env。
2. 使用 contextIsolation: true，禁止 nodeIntegration。
3. App Server 子进程和 JsonRpcConnection 由 Electron Main Process 持有。
4. Preload 只能通过 contextBridge 暴露最小白名单 API。
5. Key 只能留在 Main/App Server 环境，不能进入 Renderer、IPC Payload、日志、测试快照或文档。
6. App Server stdout 继续只承载 JSONL，stderr 才是诊断日志。
7. Electron 是 CLI 的并列 Client，不删除、不重写现有 CLI。

开始前必须：

1. 检查当前源码、package.json、测试以及项目内适用的 AGENTS.md。
2. 运行 npm run check 和 npm test，确认 165/165 基线。
3. 用中文简短复述当前架构，并解释 Electron Main、Preload、Renderer、App Server 四者的区别。
4. 比较“最小原生 Electron”和“Electron + Vite + React”两种方案，给出推荐及依赖影响；不要未经说明直接安装依赖。
5. 给出 Electron 01 的 ASCII 界面草图、数据流、准备新增或修改的文件、每个文件用途、验证命令和回滚点。
6. 因为涉及前端 UI，在我确认草图和方案前不要开始实现。
7. 我说“我来手戳”时，给我当前切片所需的完整代码和逐文件讲解。
8. 我说“你来实现”时，直接实现 Electron 01 并完成自动化验证与本地启动验收。

协作约束：

- 使用中文教学；
- 每个文件先说明用途；
- 核心代码写中文注释；
- 一次只推进一个可验证切片；
- 保留所有现有未提交修改；
- 不创建分支或 Worktree；
- 未经本轮明确授权，不执行 Git、commit、push、PR 或 merge；
- 不读取、修改或输出 Key；
- 不提交 .env、本机路径配置、IDE 文件、日志或缓存；
- 金额继续由确定性金融 Tool 计算，LLM 只负责选择和解释；
- 默认 CLI 和 --debug 行为必须保留；
- 不重新实现已经完成的 Runtime、Skill 或 MCP。

Electron 01 最小验收：

- npm run check 通过；
- 原有 npm test 165/165 全部通过；
- Electron 窗口可以打开；
- 页面显示 Runtime 连接状态；
- Main Process 确实完成 initialize / initialized；
- App Server 启动失败时显示安全错误；
- 关闭 Electron 后 App Server 没有残留进程；
- 现有 god-agent CLI 没有回归。

现在先完成检查、架构讲解、方案比较和 ASCII 草图，等待我确认，不要直接写 Electron 代码。
```
