# 新任务 Prompt：继续实现 Electron 03 受控右侧工作区

复制下面代码块内的内容到一个新任务：

```text
请继续教我从 0 到 1 手写 Codex-like 单 Agent Runtime，并进入 Electron 03：受控右侧工作区。

项目目录：
D:\练手\agent-learn

开始前请完整阅读：

D:\练手\agent-learn\docs\Electron-02-Codex风格桌面客户端实现记录.md
D:\练手\agent-learn\docs\工作交接-2026-08-06-Electron01收尾与Electron02启动.md
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
- stdio MCP 新旧协议兼容以及 Agent Loop/CLI 端到端；
- Electron Main 启动 App Server，并完成 initialize / initialized；
- React + Vite 的 Codex 风格三栏桌面客户端；
- 真实历史任务、新建、搜索、切换与历史消息；
- 发送消息、流式 assistant/delta、停止 Turn；
- 真实 Reasoning、Tool、Search、Sources Activity；
- 右侧 Activity 和 Extensions 的真实 Runtime 数据；
- 左右侧栏收缩和本地 UI 偏好保存；
- Main/Preload 双层白名单和安全 DTO；
- 退出时取消 Turn 并关闭 App Server。

当前真实测试基线：

npm run check 通过
npm test 172/172 通过
npm run electron:build 通过
node bin/god-agent.js --version 输出 god-agent 1.0.0

Electron 02 中仍未完成：

- Permission 弹窗；
- 右侧 Changes 的真实数据源；
- 受控命令面板；
- 任意 Shell（明确不应直接实现）。

Electron 03 建议拆成三个独立可验收切片，不要一次全部编码：

Electron 03A：Permission 弹窗闭环

Runtime permission/requested
→ App Server / Main 转成安全 DTO
→ Preload 白名单转发
→ Renderer 展示请求原因、工具名和安全参数摘要
→ 用户明确 Allow 或 Deny
→ Main 把决定送回现有 Permission 机制
→ 超时、窗口关闭和异常默认 Deny

Electron 03B：Changes 真实只读数据源

Workspace Adapter
→ 读取工作区文件变化摘要
→ Main 转为安全 DTO
→ Preload 白名单转发
→ 右侧 Changes 展示文件级摘要和受限 diff

注意：任何 Git 命令，包括只读 git status / git diff，都必须在本轮重新获得我的明确授权后才能运行或接入。未经授权时，优先设计不依赖 Git 的只读 Workspace Adapter，或只写方案不实施。

Electron 03C：受控命令面板

Renderer 选择预注册命令
→ Main 校验命令 ID
→ App Server / Workspace Command Runner 执行固定 argv
→ 输出经过大小、类型和敏感信息限制
→ Renderer 展示状态和结果

只允许预注册命令，例如 npm run check、npm test、npm run electron:build。不要向 Renderer 暴露任意 command、shell、cwd、env 或 child_process。

本轮不要同时实现：

- 任意 Shell 或交互式终端；
- MCP Streamable HTTP、Resources、Prompts、Sampling、Elicitation 或 OAuth；
- Multi-Agent；
- MCP 设置页；
- Windows 打包和自动更新；
- 删除或重写现有 CLI；
- 与本切片无关的 Runtime 重构。

安全边界：

1. Renderer 只负责 UI，不能直接访问 Node、child_process、文件系统、原始 JSON-RPC、IPC channel 或 process.env。
2. 继续使用 contextIsolation: true、nodeIntegration: false、sandbox: true。
3. App Server 子进程、JsonRpcConnection、权限决策和命令执行由 Main/App Server 持有。
4. Preload 只能通过 contextBridge 暴露最小白名单 API，并清洗参数、返回值和事件。
5. Key 只能留在 Main/App Server 环境，不能进入 Renderer、IPC payload、日志、测试快照或文档。
6. App Server stdout 继续只承载 JSONL，stderr 才能写诊断日志。
7. 所有权限异常、超时、窗口关闭和 DTO 校验失败都必须 fail-closed。
8. Permission 参数展示必须是安全摘要，禁止把环境变量、Key、完整敏感路径或任意原始对象直接送进 Renderer。
9. Changes 只能读取批准范围内的数据，不能修改文件。
10. 命令面板只能使用固定 command ID 到固定 argv 的映射；拒绝任意 Shell 字符串。
11. Electron 与 CLI 是并列 Client，默认 CLI 和 --debug 行为必须保留。

开始前必须：

1. 检查当前源码、package.json、测试以及项目内适用的 AGENTS.md。
2. 保留所有现有未提交修改，不创建分支或 Worktree。
3. 不执行任何 Git 命令；如果需要只读 Git，也先单独向我说明用途并等待明确授权。
4. 运行 npm run check、npm test 和 npm run electron:build，确认 172/172 基线；若基线不同，先查明并如实报告。
5. 用中文简短复述当前 Main、Preload、Renderer、App Server 和 Permission 的职责边界。
6. 先比较 03A、03B、03C 的风险和依赖，推荐一次只做 03A。
7. 给出本切片 ASCII 界面草图、事件流、准备新增或修改的文件、每个文件用途、验证命令和回滚点。
8. 因为涉及前端 UI，在我确认草图和方案前不要开始写代码。
9. 不要未经说明安装依赖；优先使用已有 React、Vite 和 Lucide React。
10. 我说“我来手戳”时，给出当前单一切片所需的完整代码和逐文件讲解。
11. 我说“你来实现”时，只实现我确认的单一切片，并完成自动化验证与本地启动验收。

Permission 弹窗建议草图：

┌─────────────────────────────────────────────────────────────┐
│ 需要你的许可                                           ×    │
├─────────────────────────────────────────────────────────────┤
│ Agent 请求运行：workspace.runCommand                         │
│                                                             │
│ 用途：运行项目类型检查                                      │
│ 命令：npm run check                                         │
│ 工作区：仅显示安全的相对路径                                │
│                                                             │
│ 关闭窗口、超时或发生错误时将自动拒绝。                      │
├─────────────────────────────────────────────────────────────┤
│                                      [拒绝] [允许本次]       │
└─────────────────────────────────────────────────────────────┘

Electron 03A 最小验收：

- npm run check 通过；
- 原有 npm test 172/172 全部通过，新测试数量如实增加；
- npm run electron:build 通过；
- 真实 permission/requested 可以显示弹窗；
- Allow 和 Deny 都能完成现有权限请求；
- 同一请求不能重复决定；
- 参数只显示安全摘要；
- 超时、窗口关闭、Renderer 崩溃或 IPC 异常时默认 Deny；
- 不把 Key、env、任意路径或原始 RPC 对象送进 Renderer；
- 关闭 Electron 后没有 App Server 残留；
- god-agent CLI 没有回归。

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

现在先完成检查、架构讲解、03A/03B/03C 比较和 Permission 弹窗 ASCII 草图，等待我确认，不要直接写 Electron 03 代码。
```
