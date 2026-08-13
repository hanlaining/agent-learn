# 新任务 Prompt：继续实现 Electron 02 聊天主链路

复制下面代码块内的内容到一个新任务：

```text
请继续教我从 0 到 1 手写 Codex-like 单 Agent Runtime，并进入 Electron 02：输入、Thread/Turn 与 Assistant 流式输出。

项目目录：
D:\练手\agent-learn

请先完整阅读最新工作交接：
D:\练手\agent-learn\docs\工作交接-2026-08-06-Electron01收尾与Electron02启动.md

同时阅读 Electron 01 实现记录：
D:\练手\agent-learn\docs\Electron-01-最小桌面壳与App-Server握手实现记录.md

如果需要确认 MCP 边界，再阅读：
D:\练手\agent-learn\docs\MCP-实现记录与验收手册.md

当前已经完成：

- JSON-RPC、JSONL、RequestMap、双向 Connection 和 App Server；
- Thread、Turn、Item、LifecycleStore 与 Runtime 持久化；
- 跨 Turn Context Builder、o200k Tokenizer、Codex 式滚动 Compaction；
- OpenAI Responses、Reasoning Summary SSE、Web Search 与 Sources；
- Agent Loop、Tool Registry、Permission、Workspace Sandbox；
- Cancel、Timeout、Retry、Resume；
- 产品化 god-agent CLI 与 --debug；
- Skill Loader；
- stdio MCP 新旧协议、Tool Adapter、Permission、Cancel、Agent Loop 与 CLI 端到端；
- Electron 01 最小桌面壳；
- Electron Main 启动现有 App Server；
- initialize / initialized；
- Preload 最小状态白名单；
- connecting / connected / failed / closed 页面；
- 关闭窗口时安全退出 App Server；
- CLI Turn 完成与 /exit 窄竞态的幂等处理。

最新测试基线：

npm run check 通过
npm test 167/167 通过
npm run electron:build 通过
npm run test:electron 2/2 通过
真实 Electron 窗口和 App Server 启动/关闭验收通过

当前 Electron 技术决策：

- 使用最小原生 Electron，不使用 Vite/React；
- electron 精确锁定为 41.6.1，兼容当前 Node 20.19；
- src/electron/main.cjs 是 CommonJS 外壳；
- Main 在 app.whenReady() 后动态导入 TypeScript AppServerClient；
- scripts/start-electron.mjs 启动桌面 Main 前删除 ELECTRON_RUN_AS_NODE；
- Main 启动 App Server 子进程时设置 ELECTRON_RUN_AS_NODE=1；
- contextIsolation: true；
- nodeIntegration: false；
- sandbox: true。

下一步只做 Electron 02：

Renderer 输入普通文本
→ Preload 调用最小业务 API
→ Main 校验输入和状态
→ 恢复最近 active Thread，或创建 Thread
→ turn/start
→ turn/run
→ Main 消费 agent/event
→ 安全映射 assistant/delta
→ Renderer 流式追加 Assistant 文本
→ Turn 完成后恢复可输入状态

本切片必须实现：

1. 当前应用会话内的 User / Assistant 消息列表；
2. 文本输入框和发送按钮；
3. Runtime connected 后恢复最近 active Thread；没有时创建 Thread；
4. turn/start / turn/run；
5. 真实 assistant/delta 流式展示，禁止假的打字动画；
6. Provider 没有 delta 时使用 turn/run 最终 assistantMessage 兜底；
7. 同一时刻只允许一个 active Turn，运行时禁止重复发送；
8. 失败时显示安全错误并恢复输入状态；
9. 尚无 Permission UI 时，Main 对 tool/request-permission 固定安全 deny，不能默认允许或悬挂；
10. 关闭窗口时如果有 active Turn，先请求 turn/cancel，再关闭 App Server；
11. Main/Preload/Renderer 之间只传安全聊天 DTO，不透传原始 AgentEvent、Lifecycle Item 或 JSON-RPC。

Thread 恢复边界：

- Electron 02 只恢复最近 active Thread 供 Runtime Context 使用；
- 当前页面只展示本次应用启动后的消息；
- 不实现 Thread 侧边栏、Thread 切换或历史消息完整回放。

本切片不要同时实现：

- Thinking / Reasoning Summary UI；
- Tool、Search、Citation 或 Sources 展示；
- Permission 弹窗；
- Thread 侧边栏和历史恢复页；
- FIFO 输入队列；
- 手动取消按钮；
- MCP 设置页；
- 设置页；
- React/Vite 迁移；
- Windows 打包或自动更新；
- Multi-Agent；
- MCP Streamable HTTP、Resources、Prompts、Sampling、Elicitation 或 OAuth。

安全边界：

1. Renderer 只负责 UI，不能访问 child_process、文件系统、process.env、Key、ipcRenderer 或原始 JSON-RPC。
2. App Server 子进程和 JsonRpcConnection 继续只由 Main 持有。
3. Preload 只能暴露 getChatSnapshot、sendMessage、onChatEvent 一类最小业务白名单；具体命名可在方案中调整。
4. Main 必须验证 Renderer 输入，Preload 必须验证 Main 返回的聊天 DTO。
5. Key 只能留在 Main/App Server 环境，不能进入 Renderer、IPC Payload、日志、测试快照或文档。
6. App Server stdout 继续只承载 JSONL，stderr 只留在 Main 诊断边界。
7. Assistant 流式文本必须来自真实 assistant/delta。
8. Tool Permission 在 Electron 04 前默认安全拒绝，绝不能自动允许。
9. Electron 是 CLI 的并列 Client，不删除或重写 CLI。

开始前必须：

1. 检查当前源码、package.json、测试和适用的 AGENTS.md。
2. 检查是否已有同项目 Electron 实例，避免重复启动；需要重启时正常关闭。
3. 运行 npm run check。
4. 运行 npm test，确认 167/167 基线。
5. 阅读 src/electron/app-server-client.ts、main.cjs、preload.cjs 和 renderer。
6. 阅读 CLI 的 Thread/Turn、Agent Event、Permission 和关闭流程作为参考，但不要复制 CLI UI。
7. 用中文简短复述 Electron Main、Preload、Renderer、App Server 的职责。
8. 给出 Electron 02 ASCII 界面草图、数据流、状态机、准备修改文件、每个文件用途、测试方案和回滚点。
9. 因为涉及前端 UI，在我确认草图和交互前不要开始实现。
10. 不要重新讨论或更换 Electron 技术栈，除非发现真实阻塞。
11. 我说“我来手戳”时，给当前切片完整代码和逐文件讲解。
12. 我说“你来实现”时，直接实现 Electron 02，完成自动化验证和真实桌面启动/关闭验收。

协作约束：

- 使用中文教学；
- 每个文件修改前先说明用途；
- 核心代码写中文注释；
- 一次只推进一个可验证切片；
- 保留全部现有未提交修改；
- 不创建分支或 Worktree；
- 未经本轮明确授权，不执行 Git、commit、push、PR 或 merge；
- 不读取、修改或输出 Key；
- 不提交 .env、本机配置、IDE 文件、日志、缓存或 dist；
- 金额继续由确定性金融 Tool 计算，LLM 只负责选择和解释；
- 默认 CLI 和 --debug 行为必须保留；
- 不重新实现 Runtime、Skill、MCP 或 Electron 01。

Electron 02 最小验收：

- npm run check 通过；
- 原有 npm test 167 项全部通过；
- 新增 Electron 02 自动化测试通过；
- npm run electron:build 通过；
- Electron 窗口可以打开；
- Runtime connected 后输入框可用；
- 能恢复或创建 Thread；
- User 消息进入当前页面；
- Assistant 文本通过真实 assistant/delta 流式显示；
- 无 delta 时最终消息兜底有效；
- 运行期间不能重复启动 Turn；
- Tool Permission 固定安全 deny；
- 失败错误不泄露 Key、环境变量、路径或原始错误；
- 关闭运行中的窗口会取消 Turn；
- 关闭后 Launcher、Electron Main、App Server 没有残留；
- 现有 god-agent CLI 与 --debug 没有回归。

现在先完成检查、架构复述、Electron 02 ASCII 草图、数据流、状态机和文件计划，等待我确认，不要直接写 Electron 02 代码。
```

