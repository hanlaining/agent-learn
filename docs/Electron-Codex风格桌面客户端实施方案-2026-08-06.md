# god-agent：Codex 风格 Electron 桌面客户端实施方案

> 方案日期：2026-08-06  
> 项目目录：`D:\练手\agent-learn`  
> 当前基线：`npm run check` 通过，`npm test` 167/167 通过  
> 当前状态：只完成方案，尚未安装 React/Vite，尚未修改 Electron 源码

## 一、目标纠正

Electron 01 只完成了桌面进程、安全边界与 App Server 握手。截图中的“Runtime 已连接”页面是握手验收页，不是最终客户端。

接下来的目标改为：在保留现有单 Agent Runtime、CLI、MCP 和 Electron 安全进程模型的前提下，做一个在信息架构、视觉层级和核心交互上接近 Codex Desktop 的可用客户端。

目标不是复制 OpenAI 私有源码，也不复制 Codex 商标、Logo 或未授权资源。项目中没有 Codex Desktop 私有前端源码；实现方式是根据官方公开界面和用户提供的截图，重新编写 god-agent 自己的 React、CSS、Main Bridge 与测试。

### 完成后的产品结构

```text
Codex 风格桌面客户端
├─ 左侧任务区
│  ├─ 新建任务
│  ├─ 最近任务
│  └─ 当前任务状态
├─ 中央对话区
│  ├─ User / Assistant 消息
│  ├─ Thinking / Activity
│  ├─ Tool / Search / Sources
│  └─ 失败、取消、超时状态
├─ 底部 Composer
│  ├─ 多行输入
│  ├─ 发送
│  └─ 停止当前 Turn
└─ Main Process
   ├─ App Server 生命周期
   ├─ Thread / Turn 控制
   ├─ Permission
   └─ 安全 IPC DTO
```

## 二、当前架构与可复用基础

```text
god-agent CLI                    Electron Desktop
      │                                │
      │ JSONL + 双向 JSON-RPC          │ Main 持有连接
      └──────────────┬─────────────────┘
                     ↓
                 App Server
                 ├─ Thread / Turn / Item
                 ├─ Persistence / Resume
                 ├─ Cancel / Timeout / Retry
                 ├─ Agent Event
                 └─ Agent Loop
                      ├─ Responses API
                      ├─ Reasoning Summary
                      ├─ Web Search / Sources
                      ├─ Tool / Permission
                      ├─ Skill
                      └─ MCP
```

Electron 01 已经提供并必须保留：

- Electron 41.6.1 与 Windows/Node 20.19 兼容边界；
- Main Process 启动和关闭 App Server；
- `initialize / initialized`；
- `contextIsolation: true`；
- `nodeIntegration: false`；
- `sandbox: true`；
- Main/Preload/Renderer 三层 IPC 白名单；
- App Server stdout 只承载 JSONL；
- 关闭 Electron 后 App Server 不残留；
- CLI 与 Electron 是并列 Client。

### 当前缺口

现有 `thread/list` 只返回 Thread 元数据：ID、状态、创建时间和 Turn ID，不能提供任务标题与历史消息。因此真正的任务侧边栏不能靠 Renderer 伪造，需要在 App Server 增加只读、受控的 `thread/history` 业务接口。

`thread/history` 只返回 User/Assistant 对话文本和必要的时间、状态字段，不返回：

- Tool 原始参数；
- Tool 完整结果；
- Provider 原始事件；
- 环境变量或 Key；
- stderr、堆栈或本机路径；
- 原始 LifecycleStore 快照。

任务标题第一版由首条 User 消息确定性截取生成，不调用 LLM、不额外消耗 Token，也不修改现有 Runtime Context。

## 三、技术方案

采用：**Electron + Vite + React + TypeScript + 原生 CSS**。

Main 与 Preload 保持现有 CommonJS 安全外壳；Vite 只负责 Renderer 的生产构建，不把 App Server、JSON-RPC 或 Node API打进 Renderer。

### 授权安装的依赖

运行时依赖：

```text
react
react-dom
lucide-react
```

开发依赖：

```text
vite
@vitejs/plugin-react
@types/react
@types/react-dom
```

实施时先检查各包 `engines`，选择兼容当前 Node 20.19 的版本并写入 lockfile，不顺带升级 Electron、TypeScript 或其他既有依赖。

不引入 Tailwind、Ant Design、Material UI 或整套组件库。Codex 风格需要靠明确的布局和设计 Token 控制，通用组件库反而容易产生明显的“后台管理系统”外观。

### Renderer 构建方式

```text
Vite 生产构建
→ 生成本地 HTML / JS / CSS
→ Electron Main 使用 loadFile()
→ CSP 继续只允许 self
→ Renderer 不连接 Vite Dev Server
```

第一阶段不使用远程开发服务器和 HMR，以继续保持 `connect-src 'none'`，减少 Electron Renderer 攻击面。

## 四、Codex 风格界面草图

### 1. 有历史任务和正在回答

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│  god-agent                                                    Runtime ●     │
├──────────────────────┬──────────────────────────────────────────────────────┤
│  ＋ 新建任务         │  agent-learn                               ···      │
│                      ├──────────────────────────────────────────────────────┤
│  最近任务            │                                                      │
│                      │  你                                                  │
│  Electron 客户端     │  把 Electron 客户端做成 Codex 风格                  │
│  MCP 实现记录        │                                                      │
│  Runtime 调试        │  Agent                                               │
│                      │  我会先检查现有 Electron 进程边界。                   │
│                      │                                                      │
│                      │  ▾ 正在检查客户端结构                                │
│                      │    ✓ 读取 Electron Main                              │
│                      │    ✓ 检查 App Server 握手                            │
│                      │    ◌ 整理 Renderer 改造方案                          │
│                      │                                                      │
│                      │  当前 Electron 01 已经具备安全握手基础……█           │
│                      │                                                      │
│                      ├──────────────────────────────────────────────────────┤
│  ⚙ 设置             │  输入任务，Shift+Enter 换行                          │
│                      │                                      [■ 停止]       │
└──────────────────────┴──────────────────────────────────────────────────────┘
```

### 2. 新任务空状态

```text
┌──────────────────────┬──────────────────────────────────────────────────────┐
│  ＋ 新建任务         │  agent-learn                         Runtime ●       │
│                      │                                                      │
│  最近任务            │              今天想构建什么？                        │
│  Electron 客户端     │                                                      │
│  MCP 实现记录        │        ┌──────────────────────────────────┐          │
│                      │        │ 描述任务，或输入要修改的内容……   │          │
│                      │        │                                  │          │
│                      │        │                            [发送] │          │
│  ⚙ 设置             │        └──────────────────────────────────┘          │
└──────────────────────┴──────────────────────────────────────────────────────┘
```

### 3. Runtime 失败

```text
┌──────────────────────┬──────────────────────────────────────────────────────┐
│  ＋ 新建任务         │  Runtime 连接失败                                   │
│                      │                                                      │
│  最近任务            │  无法启动本地 Agent Runtime。                       │
│                      │  页面不会显示 Key、路径、stderr 或原始错误。         │
│                      │                                                      │
│  ⚙ 设置             │                         [重新启动客户端]             │
└──────────────────────┴──────────────────────────────────────────────────────┘
```

### 视觉约束

- 默认窗口建议 `1180 × 760`，最小尺寸 `900 × 620`；
- 左栏约 240–260px，主对话内容最大宽度约 780–840px；
- 使用低对比度暖灰背景、细边框、小圆角和紧凑 13–14px 字号；
- 消息不是大面积彩色气泡，重点依靠留白、角色层级和 Activity 折叠；
- Runtime 状态放到顶栏，不再占据页面中央；
- 运行中发送按钮切换为停止按钮；
- 不展示无功能的假按钮。附件、模型选择和设置项必须等真实能力存在后再显示；
- 优先完成浅色主题；深色主题在核心链路稳定后单独验收；
- 用户提供的官方 Codex 截图是最终视觉比对基准，截图中的隐私内容应先打码。

## 五、主数据流

### 启动与恢复

```text
Electron 启动
→ Main 启动 App Server
→ initialize / initialized
→ Main 请求 thread/list
→ Main 按需请求 thread/history
→ Main 映射为安全 DesktopSnapshot
→ Preload 二次校验
→ React Reducer 恢复任务列表、当前任务和历史消息
```

### 发送与流式回复

```text
Composer 提交文本
→ Preload 校验非空、长度和类型
→ Main 再次校验 Runtime / Thread / active Turn
→ thread/start（没有当前 Thread 时）
→ turn/start
→ turn/run
→ App Server agent/event
→ Main 校验 AgentEvent
→ Main 映射安全 DesktopEvent
→ Preload 再次白名单校验
→ React Reducer 追加真实 assistant/delta
→ turn/run 最终 Assistant Item 作为无 delta 兜底
```

### 停止与关闭

```text
用户点击停止或关闭窗口
→ Main 对当前 active Turn 发送 turn/cancel
→ 等待 Runtime 进入 interrupted 或请求自然完成
→ Main 关闭 JsonRpcConnection
→ 结束 App Server stdin
→ 有界等待子进程退出
→ Electron 退出
```

## 六、Renderer 白名单 API 草案

```ts
window.godAgent.desktop.getSnapshot();
window.godAgent.desktop.createThread();
window.godAgent.desktop.selectThread(threadId);
window.godAgent.desktop.sendMessage(text);
window.godAgent.desktop.cancelTurn();
window.godAgent.desktop.onEvent(listener);

window.godAgent.runtime.getStatus();
window.godAgent.runtime.onStatusChange(listener);
```

Renderer 永远不能获得：

```text
ipcRenderer
child_process
fs
process.env
原始 JsonRpcConnection
原始 initialize Result
原始 AgentEvent
Tool 参数和完整 Tool Result
App Server stderr
Provider Key
```

## 七、UI 状态模型

React 使用强类型 Reducer，不通过解析提示文字推断状态。

```text
RuntimeState
connecting → connected → failed / closed

ThreadState
loading → ready → switching / failed

TurnState
idle
→ starting
→ thinking
→ searching / running_tool / awaiting_permission
→ answering
→ completed / failed / cancelled / timed_out
```

同一个 Tool/Search 按 `callId` 更新同一条 Activity；Reasoning Summary 使用 `turnId + round + summaryIndex` 隔离多轮模型调用。公开 Summary、Runtime Activity 与 Assistant Answer 三条流不得混合。

## 八、分切片实施计划

### Electron 02：Codex 风格可用聊天核心（下一切片）

这是下一次实现的唯一范围。完成后必须已经是一个能使用的聊天客户端，而不是静态壳。

#### 目标

- 安装已授权的 React/Vite 依赖；
- 把 Renderer 迁移到 React + TypeScript；
- 完成 Codex 风格主布局、任务侧栏、消息区和 Composer；
- 恢复任务列表与 User/Assistant 历史消息；
- 新建和切换 Thread；
- 真实执行 `turn/start / turn/run`；
- 实时展示 `assistant/delta`；
- 支持停止当前 Turn；
- 单 Agent 同时只运行一个 Turn；
- Permission UI 未完成前固定安全 deny；
- 关闭窗口时取消 active Turn 并确保 App Server 无残留。

#### 预计新增文件

| 文件 | 用途 |
|---|---|
| `vite.config.ts` | Renderer 的本地生产构建配置 |
| `src/runtime/thread-history.ts` | 定义并校验受控 Thread 历史结果 |
| `src/electron/desktop-types.ts` | Main/Preload/Renderer 安全 DTO |
| `src/electron/chat-controller.ts` | Main 内的 Thread、Turn 和单 active Turn 控制 |
| `src/electron/renderer/main.tsx` | React 入口 |
| `src/electron/renderer/App.tsx` | 桌面页面与状态装配 |
| `src/electron/renderer/desktop-reducer.ts` | 强类型 UI 状态机 |
| `src/electron/renderer/components/Sidebar.tsx` | 新任务和最近任务 |
| `src/electron/renderer/components/ChatTimeline.tsx` | 历史和流式消息区 |
| `src/electron/renderer/components/Composer.tsx` | 输入、发送和停止 |
| `src/electron/renderer/components/RuntimeBanner.tsx` | 连接失败等安全状态 |
| `tests/thread-history-test.ts` | Thread 历史业务接口测试 |
| `tests/electron-chat-controller-test.ts` | Thread/Turn/Cancel 主链测试 |
| `tests/electron-desktop-types-test.ts` | IPC DTO 白名单与脱敏测试 |
| `tests/electron-desktop-reducer-test.ts` | 流式事件和 UI 状态机测试 |

#### 预计修改文件

| 文件 | 用途 |
|---|---|
| `package.json` / `package-lock.json` | 增加已授权依赖和 Renderer 构建命令 |
| `tsconfig.electron.json` | 纳入安全桥接代码，保持 Main 构建边界 |
| `src/app-server/handlers.ts` | 增加只读 `thread/history` |
| `src/electron/app-server-client.ts` | 增加业务请求、事件订阅、取消和 Permission deny |
| `src/electron/main.cjs` | 注册桌面业务 IPC 与安全关闭 |
| `src/electron/preload.cjs` | 暴露最小 desktop API 并二次校验 DTO |
| `src/electron/renderer/index.html` | Vite/React 入口和 CSP |
| `src/electron/renderer/styles.css` | Codex 风格设计 Token 与布局 |
| `scripts/build-electron.mjs` | 合并 TypeScript、Vite 与静态资源输出 |
| `tests/app-server-handlers-test.ts` | `thread/history` RPC 回归 |
| `tests/electron-app-server-client-test.ts` | 握手、聊天与关闭回归 |

最终以实现前源码复核为准；没有实际职责的文件不为了凑结构创建。

#### 验证命令

```powershell
cd D:\练手\agent-learn
npm run check
npm test
npm run electron:build
npm run test:electron
node bin/god-agent.js --version
npm run electron:dev
```

桌面人工验收：

- 新建任务；
- 发送真实消息并看到流式回复；
- 运行中停止；
- 切换任务并恢复历史消息；
- Runtime 失败时只显示安全错误；
- 关闭窗口后 Launcher、Electron Main、App Server 均退出；
- 对照官方截图检查布局、间距、字号、颜色和交互状态。

#### 回滚点

- Electron 01 的握手实现记录与既有测试是行为回滚基准；
- Renderer 迁移不删除 App Server、CLI、Runtime、Skill 或 MCP；
- Vite 输出只进入 `dist`，源码输出路径与 Runtime 持久化目录隔离；
- 如果 React Renderer 构建失败，可恢复旧 `renderer` 静态资源与旧 build 脚本，不需要回滚 Runtime；
- 不使用 Git 回滚命令；如需回退，先列出本切片文件并征得用户确认后手工恢复。

### Electron 03：真实 Thinking 与 Activity

目标：把现有真实 AgentEvent 映射成 Codex 风格可折叠执行轨迹。

- `reasoning/summary_*` → 公开 Thinking Summary；
- `web_search/*` → Search Activity；
- `tool/*` → Tool Activity；
- `citation/url_added` → Sources；
- `context/compacted` → 脱敏上下文维护状态；
- Answer 开始后自动折叠，用户手动展开后尊重用户选择；
- 没有 Summary 时只显示“Thinking…”，不得编造隐藏思维链。

验证重点：Summary、Activity、Answer 不混流，多 Model Round 不串线，Tool/Search 按 `callId` 原位更新。

### Electron 04：Permission 与设置入口

目标：实现真实 Permission 弹窗和最小设置页。

- Tool 请求只显示经过 Main 脱敏的工具名、动作摘要和风险等级；
- Allow/Deny 有超时，窗口关闭或失联默认 Deny；
- 设置页只操作明确允许的产品配置；
- Key 仍不进入 Renderer，不显示、不回传、不写测试快照；
- MCP 设置属于独立子切片，不能与 Permission 一次混做。

涉及本机配置写入前必须再次向用户说明文件与影响并获得授权。

### Electron 05：视觉精修与桌面产品化

- 按用户提供的官方截图逐状态做视觉比对；
- 深色主题、窄窗口折叠侧栏、键盘导航和无障碍；
- Markdown、代码块、复制按钮和 Sources 交互；
- Windows 打包、图标、应用数据目录和升级策略；
- 真实 Electron 启停、异常关闭和孤儿进程专项验收。

Windows 打包和自动更新会引入新的依赖与产物，届时单独说明并授权，不在 Electron 02 顺带安装。

## 九、安全边界

1. Renderer 只负责 UI，不直接访问 Node、文件系统、环境变量或 JSON-RPC。
2. Main 持有 App Server 子进程、Connection、active Thread 和 active Turn。
3. Main 与 Preload 对所有跨边界值各做一次校验。
4. 所有文本有类型、长度和枚举限制；未知事件直接丢弃并留在 Main 诊断边界。
5. 错误映射为固定安全错误码，不把原始 Error 发送到 Renderer。
6. URL 只允许 `http:` 和 `https:`；Renderer 不自动打开未知协议。
7. Permission 未实现或超时时默认 Deny。
8. App Server stdout 继续只承载 JSONL，stderr 不进入 IPC。
9. 不读取、记录、展示、修改或输出 Key。
10. 不修改默认 CLI 与 `--debug` 行为。

## 十、视觉参考与“一样”的验收口径

没有 Codex Desktop 私有源码，不能承诺源代码级一模一样。可以承诺的是，在获得足够官方界面截图后，按以下维度做高保真同构实现：

- 窗口尺寸和区域比例；
- 侧栏宽度、任务行高度与选中态；
- 消息最大宽度和垂直节奏；
- Composer 高度、圆角、边框和按钮位置；
- 字号、字重、色阶和图标尺寸；
- Empty、Hover、Focus、Streaming、Failed、Cancelled 等状态；
- Thinking 与 Activity 的展开/折叠时机。

建议提供或允许获取以下官方截图，均使用 100% 系统缩放并隐藏隐私：

1. 新任务空状态；
2. 普通对话完成状态；
3. 正在流式回答；
4. Thinking 展开与折叠；
5. Tool/Search Activity；
6. Permission 弹窗；
7. 侧栏任务选中与 Hover；
8. 设置页；
9. 浅色与深色主题。

每完成一个 UI 切片，使用相同窗口尺寸截取 god-agent 页面，与参考图逐项核对。视觉差异记录到对应实现记录 MD，而不是只凭“看起来差不多”验收。

## 十一、范围外内容

本路线仍然是单 Agent Desktop，不借 UI 重构扩展以下内容：

- Multi-Agent 编排；
- MCP Streamable HTTP、Resources、Prompts、Sampling、Elicitation 或 OAuth；
- 重写 Agent Loop、Context、Compaction、Skill 或 stdio MCP；
- 删除或替换 god-agent CLI；
- 将金额计算交给 LLM；
- 把隐藏 Chain of Thought 暴露到 UI；
- 复制 Codex 商标、Logo、私有代码或打包资源；
- 未经单独授权的 Git、commit、push、PR、merge、分支或 Worktree 操作。

## 十二、本方案的确认点

用户确认后，下一步只实施 **Electron 02：Codex 风格可用聊天核心**。

开始实施意味着：

- 可以安装本文第三节列出的七个 npm 包；
- 可以修改 Electron 02 表格内的项目文件；
- 可以运行构建、测试和本地 Electron 启动验收；
- 不代表授权 Git 操作；
- 不代表授权读取 Key；
- 不代表授权直接进入 Electron 03、04 或 05。

确认口令建议：

```text
确认方案，你来实现 Electron 02：Codex 风格可用聊天核心。
```
