# god-agent 工作交接：Electron 01 收尾与 Electron 02 启动

> 交接日期：2026-08-06  
> 项目目录：`D:\练手\agent-learn`  
> 当前阶段：Electron 01 已完成并验收  
> 最新基线：`npm run check` 通过，`npm test` 167/167 通过  
> 下一阶段：Electron 02——输入、Thread/Turn 与 Assistant 流式输出

Electron 01 的完整实施记录见：

- [`Electron-01-最小桌面壳与App-Server握手实现记录.md`](./Electron-01-最小桌面壳与App-Server握手实现记录.md)

## 一、当前总体架构

CLI 和 Electron 是同一个 App Server 的两个并列 Client：

```text
god-agent CLI                           Electron Desktop
├─ 命令、输入队列                       ├─ Renderer：纯 UI
├─ Thinking / Search / Sources          ├─ Preload：最小白名单
└─ Tool Permission                      └─ Main：子进程与 JSON-RPC
              \                         /
               \                       /
                └── JSONL + 双向 JSON-RPC
                              ↓
                         App Server
                         ├─ Thread / Turn / Item
                         ├─ Persistence / Resume
                         ├─ Cancel / Timeout / Retry
                         ├─ Agent Event Notification
                         └─ Agent Loop
                              ├─ Context / Token Budget
                              ├─ Rolling Compaction
                              ├─ LLM → Tool → LLM
                              └─ ToolOutputLimiter
                                   ↓
                              Tool Registry
                              ├─ Finance Tool
                              ├─ Workspace Tool
                              ├─ Skill Loader
                              └─ stdio MCP Tool
```

Electron 不复制 App Server、Agent Loop、LifecycleStore、Context、Tool Registry、Skill 或 MCP。

## 二、此前已经完成的 Runtime 能力

### Protocol 与生命周期

- JSON-RPC、JSONL、RequestMap、双向 `JsonRpcConnection`；
- `initialize / initialized`；
- Thread、Turn、Item、LifecycleStore；
- Runtime JSON 原子持久化和恢复；
- Cancel、Turn Timeout、Provider Retry；
- Agent Event Notification。

### Context、模型与公开事件

- 跨 Turn Context Builder；
- `o200k_base` Token 计算；
- Codex 式滚动 Compaction 和 Context Checkpoint；
- OpenAI Responses Provider；
- Reasoning Summary SSE；
- Web Search、Citation 与 Sources；
- `assistant/delta` 流式事件。

### Tool、安全与客户端

- 通用 Tool Registry；
- 确定性金融 Tool；
- Workspace Sandbox 和预注册命令；
- Tool Permission；
- Skill Loader / `read_skill`；
- stdio MCP Tool 完整主链路；
- 产品化 god-agent CLI 与 `--debug`。

MCP 已经收尾。本阶段不要重新实现或扩展 MCP Transport、Resources、Prompts、Sampling、Elicitation 或 OAuth。

## 三、Electron 01 已完成内容

Electron 01 已形成下面的真实主链路：

```text
启动 Electron
→ Main 启动现有 App Server
→ JsonRpcConnection 发送 initialize
→ 校验 Result
→ 发送 initialized
→ Main 发布 connected
→ Preload 校验安全状态
→ Renderer 展示 Runtime 已连接
→ 关闭窗口
→ Main 关闭 Connection 和 App Server stdin
→ App Server 清理并退出
→ Electron 等待子进程退出后关闭
```

页面支持：

```text
connecting
connected
failed
closed
```

真实桌面验收已经确认：

- `god-agent` 窗口可以打开；
- App Server 子进程可以检测到；
- Main 完成 `initialize / initialized`；
- 正常关闭后 Launcher、Electron Main、App Server 全部退出；
- 没有残留本轮诊断日志。

## 四、Electron 01 核心文件

| 文件 | 职责 |
|---|---|
| `src/electron/runtime-status.ts` | 四种 Runtime 安全状态 |
| `src/electron/app-server-client.ts` | spawn、JSON-RPC、握手、失败与关闭 |
| `src/electron/main.cjs` | Electron 生命周期、BrowserWindow 和 IPC |
| `src/electron/preload.cjs` | contextBridge 最小白名单和 Payload 校验 |
| `src/electron/renderer/index.html` | 最小桌面页面 |
| `src/electron/renderer/renderer.js` | 状态订阅和安全 DOM 更新 |
| `src/electron/renderer/styles.css` | 四状态页面样式 |
| `scripts/build-electron.mjs` | 编译后复制桌面静态资源 |
| `scripts/start-electron.mjs` | 以真正 Electron 桌面模式启动 |
| `tsconfig.electron.json` | Electron TypeScript 输出配置 |
| `tests/electron-app-server-client-test.ts` | 握手、脱敏和子进程退出测试 |

## 五、必须保留的 Electron 技术决策

### 1. Electron 版本

当前精确锁定：

```text
electron@41.6.1
```

项目宿主 Node 是 20.19。Electron 42/43 的安装工具要求 Node 22.12，因此不要在 Electron 02 无理由升级 Electron。

### 2. Main 使用 CommonJS 外壳

`src/electron/main.cjs` 是最外层 Electron 入口，在 `app.whenReady()` 后动态导入编译后的 TypeScript `AppServerClient`。

这是为 Windows + Electron 41 的启动兼容性做出的明确决策。不要直接改回 ESM Main，除非先建立独立验证。

### 3. Electron 与 App Server 的 Node 模式不同

```text
Electron Main：删除 ELECTRON_RUN_AS_NODE
App Server 子进程：ELECTRON_RUN_AS_NODE=1
```

`scripts/start-electron.mjs` 负责第一条；`src/electron/main.cjs` 负责第二条。

### 4. Renderer 安全边界

必须继续保持：

```text
contextIsolation: true
nodeIntegration: false
sandbox: true
```

Renderer 不能接触：

- `child_process`；
- 文件系统；
- `process.env`；
- Key；
- 原始 `ipcRenderer`；
- 原始 JSON-RPC；
- App Server stderr；
- initialize Result。

### 5. IPC Payload 必须二次校验

Main 只发送安全 DTO；Preload 仍需把 Payload 映射到固定白名单对象，不能直接把任意 Main Payload 透传给 Renderer。

### 6. App Server stdout / stderr 边界

```text
stdout：只允许 JSONL 协议
stderr：只留在 Main 诊断边界
```

## 六、Electron 01 期间补充的 CLI 幂等修复

全量回归发现一个此前已经存在的窄竞态：Assistant 文本已输出、`activeTurn` 尚未清空时收到 `/exit`，CLI 可能补发 `turn/cancel`，而 Runtime 已完成 Turn。

`src/cli/main.ts` 现在只对“当前 Turn 明确返回 `Turn is not running`”做幂等处理；其他取消错误仍正常抛出。

不要删除该处理。它保证完整测试在并行模式下稳定通过，且没有修改正常 CLI 输出。

## 七、当前验证命令与结果

```powershell
cd D:\练手\agent-learn

npm run check
npm test
npm run electron:build
npm run test:electron
node bin/god-agent.js --version
```

当前结果：

```text
npm run check            通过
npm test                 167/167 通过
npm run electron:build   通过
npm run test:electron    2/2 通过
god-agent CLI            god-agent 1.0.0
```

启动桌面端：

```powershell
npm run electron:dev
```

启动前应检查是否已有同项目 Electron 实例，避免重复窗口。需要重启时走正常关闭窗口路径，不直接留下孤儿进程。

## 八、下一切片只做 Electron 02

### 目标

```text
Renderer 输入一条普通文本
→ Preload 调用最小业务 API
→ Main 验证文本和当前状态
→ 恢复最近 active Thread，或创建新 Thread
→ turn/start
→ turn/run
→ Main 消费 agent/event
→ 只把安全聊天事件送给 Preload
→ Renderer 流式追加 Assistant 文本
→ Turn 完成后恢复可输入状态
```

### Electron 02 最小功能

1. 显示当前应用会话内的 User 和 Assistant 消息；
2. 提供单行或多行文本输入框与发送按钮；
3. Runtime 连接成功后恢复最近 active Thread；没有可恢复 Thread 时创建一个；
4. 每次发送依次调用 `turn/start` 和 `turn/run`；
5. 消费真实 `assistant/delta`，不能用假的打字动画；
6. 如果 Provider 没有发送 delta，使用 `turn/run` 最终 `assistantMessage` 兜底；
7. 同一时刻只允许一个 active Turn，运行期间禁用重复发送；
8. 失败时显示安全、可恢复的聊天错误，不显示原始路径、环境变量或 Provider Key；
9. Electron 02 尚无 Permission 弹窗，Main 必须对 `tool/request-permission` 返回固定安全 deny，不能悬挂或默认允许；
10. 关闭窗口时如果有 active Turn，先请求 `turn/cancel`，再关闭 App Server，继续保证无残留进程。

### Electron 02 的消息边界

Renderer 只能得到面向 UI 的安全对象，例如：

```ts
type ChatEvent =
  | { type: "user/message"; localId: string; text: string }
  | { type: "assistant/started"; turnId: string }
  | { type: "assistant/delta"; turnId: string; delta: string }
  | { type: "assistant/completed"; turnId: string; text: string }
  | { type: "chat/failed"; message: string };
```

具体名称可在实现前调整，但必须坚持：Renderer 不接触完整 Lifecycle Item、原始 AgentEvent、Tool 参数或 JSON-RPC。

### Thread 恢复的范围

Electron 02 只恢复最近 active Thread 供 Runtime Context 使用。

本切片不新增 Thread 侧边栏，也不要求把历史消息全部回放到页面。完整 Thread 列表、切换和历史恢复留到 Electron 05。

## 九、Electron 02 不要同时实现

- Thread 侧边栏、Thread 切换和历史会话页面；
- Thinking / Reasoning Summary UI；
- Tool、Web Search、Citation 或 Sources UI；
- Permission 弹窗；
- 输入消息 FIFO 队列；
- 手动取消按钮；
- MCP 设置或状态页；
- 设置页；
- Windows 打包、自动更新；
- React/Vite 迁移；
- Multi-Agent；
- MCP Streamable HTTP、Resources、Prompts、Sampling、Elicitation 或 OAuth。

## 十、Electron 02 推荐进程职责

```text
Renderer
  ├─ 输入和消息展示
  └─ 不保存 Runtime 权威状态
        ↓ contextBridge 业务白名单
Preload
  ├─ sendMessage(text)
  ├─ getChatSnapshot()
  └─ onChatEvent(listener)
        ↓ Electron IPC
Main
  ├─ Thread / active Turn 状态
  ├─ 参数校验
  ├─ AppServerClient 业务调用
  ├─ AgentEvent → ChatEvent 安全映射
  └─ 临时安全拒绝 Tool Permission
        ↓ JSONL + 双向 JSON-RPC
App Server
```

API 名称不是最终强制要求，但白名单范围不能比本切片业务需求更宽。

## 十一、Electron 02 建议新增或修改的文件

预计会涉及：

| 文件 | 用途 |
|---|---|
| `src/electron/app-server-client.ts` | 增加 Thread/Turn 调用、Agent Event 和关闭取消 |
| `src/electron/chat-types.ts` | 定义 Main → Preload → Renderer 的安全聊天 DTO |
| `src/electron/main.cjs` | 注册聊天 IPC 和 Main 会话控制 |
| `src/electron/preload.cjs` | 暴露聊天白名单并校验 Payload |
| `src/electron/renderer/index.html` | 消息区和输入区 |
| `src/electron/renderer/renderer.js` | 输入、消息状态和流式文本更新 |
| `src/electron/renderer/styles.css` | 最小聊天布局 |
| `tests/electron-app-server-client-test.ts` | Thread/Turn、delta、失败与关闭回归 |
| `tests/electron-chat-*.ts` | 安全 DTO、单 active Turn、Permission deny 等测试 |

实现前应根据源码再确认精确文件，不要为了凑结构创建无用抽象。

## 十二、Electron 02 最小验收

- [ ] `npm run check` 通过；
- [ ] 原有 167 项测试全部通过；
- [ ] 新增 Electron 02 测试通过；
- [ ] `npm run electron:build` 通过；
- [ ] `npm run electron:dev` 可以打开窗口；
- [ ] Runtime 完成握手后输入框可用；
- [ ] 能恢复或创建 Thread；
- [ ] User 消息立即进入当前页面；
- [ ] Assistant 文本来自真实 `assistant/delta`；
- [ ] 无 delta 时最终消息兜底有效；
- [ ] 运行期间不能重复启动第二个 Turn；
- [ ] Tool Permission 在没有 UI 时安全 deny；
- [ ] 失败文案不泄露 Key、环境变量、路径或原始错误；
- [ ] 关闭运行中窗口会取消 Turn，并且 App Server 无残留；
- [ ] 现有 god-agent CLI 和 `--debug` 没有回归；
- [ ] 核心新增代码包含中文注释。

## 十三、协作约束

- 使用中文教学；
- 每个文件修改前先说明用途；
- 核心代码写中文注释；
- 一次只推进一个可验证切片；
- 保留全部现有未提交修改；
- 不创建分支或 Worktree；
- 未经本轮明确授权，不执行 Git、commit、push、PR 或 merge；
- 不读取、修改或输出 Key；
- 不提交 `.env`、本机配置、IDE 文件、日志、缓存或 `dist`；
- 金额继续由确定性金融 Tool 计算；
- 默认 CLI 和 `--debug` 行为必须保留；
- 不重做 Runtime、Skill、MCP 或 Electron 01；
- 前端 UI 实现前先给 ASCII 草图并等待确认；
- 用户说“我来手戳”时，给完整代码与逐文件讲解；
- 用户说“你来实现”时，直接实现当前已确认切片并完整验证。

## 十四、推荐的开始顺序

1. 完整阅读本交接；
2. 阅读 Electron 01 实现记录；
3. 阅读 `AppServerClient`、Main、Preload、Renderer；
4. 阅读 CLI 的 Thread/Turn、Agent Event 和 Permission 处理作为参考；
5. 检查适用的 `AGENTS.md`；
6. 运行 `npm run check`；
7. 运行 `npm test`，确认 167/167；
8. 给出 Electron 02 ASCII 草图、数据流、文件计划、测试方案和回滚点；
9. 等用户确认后再实现。

