# Electron 02：Codex 风格单 Agent 桌面客户端实现记录

> 日期：2026-08-06  
> 项目：`D:\练手\agent-learn`  
> 本文只记录已经落地并完成验证的内容，不把占位界面写成已实现能力。

## 1. 本切片目标与完成范围

Electron 01 已经完成最小桌面壳、App Server 子进程启动、`initialize / initialized` 握手和连接状态展示。Electron 02 在不重写 Runtime、Skill、MCP 和 CLI 的前提下，把 Renderer 升级为 Codex Desktop 风格的单 Agent 工作台。

本切片实际完成：

- 使用 React、Vite 和 Lucide React 重建 Renderer；
- 左侧展示真实历史任务，支持新建、搜索和切换任务；
- 左侧提供 Tools、Skills、MCP、Search、终端等功能入口；
- 中央展示真实历史消息，支持发送消息、流式增量、停止当前 Turn；
- 展示真实 Reasoning、Tool、Search、Sources 等 Activity；
- 右侧提供变更、活动、终端、扩展四个检查器标签；
- Activity 和 Extensions 读取真实 Runtime 数据；
- 左右侧栏都可收缩，展开状态使用 `localStorage` 保存；
- Main 和 Preload 继续使用双层白名单与安全 DTO；
- 窗口关闭时取消活动 Turn，并安全关闭 App Server 子进程；
- 新增 `thread/history` 与 `runtime/capabilities` 两个安全 RPC；
- 现有 `god-agent` CLI 保持并列 Client，不删除、不重写。

明确未完成：

- Changes 仍是诚实占位，没有擅自执行 `git diff`；
- Terminal 仍是诚实占位，没有向 Renderer 暴露任意 Shell；
- Permission 弹窗尚未实现，在安全 UI 完成前请求固定拒绝；
- 未实现 MCP 设置页、Multi-Agent、打包发布或 MCP 协议扩展。

## 2. 最终界面结构

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ 左侧导航                         中央任务区                    右侧检查器     │
├───────────────────┬──────────────────────────────────┬──────────────────────┤
│ ＋ 新任务          │ 当前任务标题 / Runtime 状态       │ 变更 活动 终端 扩展   │
│ 搜索任务           │                                  │                      │
│                   │ 用户消息                          │ 真实 Activity         │
│ 历史任务列表       │ Assistant 流式回复                │ 或安全占位说明         │
│                   │ Thinking / Tool / Search / Source │                      │
│ 功能入口           │                                  │                      │
│ Tools / Skills     │ 输入框                    发送/停止│                      │
│ MCP / Search       │                                  │                      │
│ Terminal           │                                  │                      │
└───────────────────┴──────────────────────────────────┴──────────────────────┘
        ⇦ 可收缩                                               可收缩 ⇨
```

## 3. 架构和数据流

四层职责保持严格分离：

1. Renderer：只负责 React UI 和本地显示状态，不能访问 Node、文件系统、环境变量、子进程或原始 JSON-RPC。
2. Preload：通过 `contextBridge` 暴露最小白名单 API，并对参数和返回 DTO 再次清洗。
3. Electron Main：持有 IPC、`DesktopController` 和 `AppServerClient`，负责窗口生命周期与安全关闭。
4. App Server：持有现有 Runtime、LifecycleStore、Agent Loop、Tools、Skills 和 MCP，通过 stdin/stdout JSONL 通信。

```text
React Renderer
  │ window.godAgent.desktop（安全 DTO）
  ▼
Preload 白名单 + 参数/返回值清洗
  │ Electron IPC（固定 channel）
  ▼
Main Process / DesktopController
  │ JsonRpcConnection over stdin/stdout JSONL
  ▼
App Server 子进程
  │
  └─ Runtime / LifecycleStore / Agent Loop / Tool / Skill / MCP
```

典型消息链路：

```text
用户点击发送
→ Renderer 调用 desktop.sendMessage(text)
→ Preload 校验 text，并调用固定 IPC channel
→ DesktopController 调用 thread/create 或 turn/start
→ App Server 驱动现有 Agent Loop
→ assistant/delta、reasoning、tool、search 等事件回到 Main
→ Main 转换成安全 DesktopEvent
→ Preload 清洗 DTO
→ React reducer 更新消息和 Activity
```

## 4. 新增依赖与构建方式

本阶段新增前端依赖：

- 运行时：`react`、`react-dom`、`lucide-react`；
- 开发与构建：`vite`、`@vitejs/plugin-react`、`@types/react`、`@types/react-dom`。

Electron 仍由现有 Main Process 启动，Vite 只构建 Renderer 静态资源，不向 Renderer 开放 Node 能力。

关键命令：

```powershell
npm run check
npm test
npm run electron:build
npm run electron:dev
node bin/god-agent.js --version
```

## 5. 文件与用途

### Runtime / App Server

- `src/runtime/thread-history.ts`：把 LifecycleStore 中的 Thread、Turn、Item 转换为桌面端可消费的历史消息 DTO。
- `src/app-server/runtime-capabilities.ts`：集中生成 Runtime 能力目录，供扩展区展示真实能力。
- `src/app-server/handlers.ts`：注册 `thread/history` 和 `runtime/capabilities` 请求处理器。
- `src/app-server/main.ts`：把能力目录注入 App Server handler。

### Electron Main / Preload

- `src/electron/app-server-client.ts`：管理 App Server 子进程、握手、JSON-RPC 请求和通知。
- `src/electron/desktop-types.ts`：定义 Renderer 可见的安全 DTO 和事件联合类型。
- `src/electron/desktop-controller.ts`：编排任务列表、历史记录、Turn、Activity、取消和关闭流程。
- `src/electron/main.cjs`：创建安全 BrowserWindow，注册固定 IPC，启动和关闭 App Server。
- `src/electron/preload.cjs`：通过 `contextBridge` 暴露最小 API，并清洗所有跨边界数据。

### React Renderer

- `src/electron/renderer/App.tsx`：Codex 风格三栏工作台、输入区、历史任务和检查器。
- `src/electron/renderer/desktop-reducer.ts`：把快照与流式事件归并为可渲染 UI 状态。
- `src/electron/renderer/main.tsx`：React 入口。
- `src/electron/renderer/styles.css`：窗口布局、收缩机制、消息和 Activity 视觉样式。
- `vite.config.ts`：Renderer 构建配置。

### 测试

- `tests/thread-history-test.ts`：历史 DTO、消息顺序和数据清洗测试。
- `tests/electron-desktop-controller-test.ts`：桌面编排、发送、事件、取消和关闭测试。
- `tests/app-server-handlers-test.ts`：扩展新 RPC 的 handler 测试。
- `tests/electron-app-server-client-test.ts`：扩展客户端请求与事件测试。

## 6. 极核心代码

以下代码只保留架构关键点，完整实现以源码为准。

### 6.1 App Server 只暴露桌面端需要的查询

```ts
connection.onRequest("thread/history", (params) => {
  requireInitialized();
  const request = parseThreadHistoryParams(params);
  return readThreadHistory(lifecycleStore, request.threadId);
});

connection.onRequest("runtime/capabilities", () => {
  requireInitialized();
  return cloneRuntimeCapabilities(runtimeCapabilities);
});
```

关键点：Renderer 不读取持久化文件，也不接触 LifecycleStore；历史记录和能力目录必须经过 App Server 的受控接口。

### 6.2 BrowserWindow 的安全基线

```js
webPreferences: {
  preload: join(__dirname, "preload.cjs"),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
}
```

同时禁止新窗口和外部导航，避免页面离开本地受控壳。

### 6.3 Preload 只暴露最小白名单

```js
contextBridge.exposeInMainWorld("godAgent", {
  runtime: {
    getStatus: async () => sanitizeRuntimeStatus(
      await ipcRenderer.invoke(GET_RUNTIME_STATUS_CHANNEL),
    ),
    onStatusChange: (listener) => {
      const handler = (_event, value) => {
        listener(sanitizeRuntimeStatus(value));
      };
      ipcRenderer.on(RUNTIME_STATUS_CHANGED_CHANNEL, handler);
      return () => ipcRenderer.removeListener(
        RUNTIME_STATUS_CHANGED_CHANNEL,
        handler,
      );
    },
  },
  desktop: {
    getSnapshot: async () => sanitizeSnapshot(
      await invoke(DESKTOP_GET_SNAPSHOT_CHANNEL),
    ),
    // createThread / selectThread / sendMessage / cancelTurn / onEvent
  },
});
```

关键点：不暴露 `ipcRenderer`、channel 字符串、`process.env` 或 JsonRpcConnection；参数和返回值都经过白名单校验。

### 6.4 左右栏状态只保存在 Renderer 本地

```ts
const [leftOpen, setLeftOpen] = useStoredBoolean(
  "god-agent:left-open",
  true,
);
const [rightOpen, setRightOpen] = useStoredBoolean(
  "god-agent:right-open",
  true,
);
```

它只保存 UI 偏好，不保存 Key、消息正文或 Runtime 私密状态。

### 6.5 未接入能力必须明确说明

```tsx
{inspectorTab === "changes" && (
  <DeferredPanel title="变更检查尚未接入">
    客户端不会偷偷执行 git diff；后续通过只读 Workspace Adapter 实现。
  </DeferredPanel>
)}

{inspectorTab === "terminal" && (
  <DeferredPanel title="桌面终端尚未接入">
    任意终端需要独立安全设计。
  </DeferredPanel>
)}
```

关键点：界面可以先有信息架构，但不能伪造数据或突破本轮 Git、Shell 授权边界。

## 7. 安全边界

- Key 只允许存在于 Main/App Server 环境，不进入 Renderer、IPC payload、日志、快照或文档；
- App Server stdout 继续只承载 JSONL，诊断信息写 stderr；
- Renderer 无法访问 `child_process`、文件系统、`process.env` 和原始 JSON-RPC；
- IPC channel 在 Main 与 Preload 两侧固定声明，Renderer 不能自由拼接；
- Preload 对入参、返回值和事件做运行时清洗；
- Permission UI 完成前采用 fail-closed：权限请求固定拒绝；
- Changes 不偷偷调用 Git；Terminal 不提供任意命令执行；
- 退出时先取消活动 Turn，再关闭连接和子进程，避免残留 App Server；
- CLI 与 Electron 是两个并列 Client，默认 CLI 和 `--debug` 行为保持不变。

## 8. 验证结果

2026-08-06 的实际基线：

- `npm run check`：通过；
- `npm test`：172/172 通过；
- `npm run electron:build`：通过；
- `node bin/god-agent.js --version`：输出 `god-agent 1.0.0`；
- 隔离 Electron 实例可以启动；
- 本轮启动的 Electron/App Server 进程关闭后剩余 0；
- 用户原有 Electron 窗口未被擅自关闭；
- 未执行 Git、commit、push、PR 或 merge；
- 未读取、修改或输出 Key。

测试数量由 Electron 01 交接时的 167 增至 172。更早的 165 是 MCP 收尾基线，不能再写成当前基线。

## 9. 回滚点

如果只回滚 Electron 02，应只撤销本阶段新增的 Renderer、DesktopController、新 RPC 与对应测试；不要回滚 Electron 01 握手、现有 Runtime、CLI、Skill 或 MCP。由于仓库含有用户未提交修改，任何回滚都必须先获得明确授权，不能使用破坏性 Git 命令。

## 10. 下一切片建议

> 本节是 2026-08-06 完成 Electron 02 时的历史建议。2026-08-12 的当前执行顺序已调整为先完成 Runtime 02.2，再进入 Runtime 03；见第 11 节。

Electron 03 建议只做“受控工作区交互”：

1. Permission 请求弹窗和明确的 allow/deny 决策；
2. 右侧 Changes 的真实只读数据源；
3. 预注册命令面板，而不是任意 Shell；
4. 保持 Main/Preload/Renderer 三层白名单和 fail-closed 默认值。

下一切片不扩展 MCP、不实现 Multi-Agent，也不把权限弹窗、Changes 和 Terminal 混成一个不可验收的大切片。

## 11. 2026-08-12 当前对齐调整

Runtime 02 的基础 UI 已完成，但实际验收发现：现有界面只能展示模型碰巧输出的 Commentary 和结构化 Activity，没有稳定产生 Codex 式“排查目标 → 阶段发现 → 根因判断 → 验证计划”，并且当前折叠只覆盖 Activity，不能压缩整个公开过程。

因此 Electron 03 之前新增：

```text
Runtime 02.2A 公开 Commentary 协议
→ Runtime 02.2B 整体过程压缩
→ Runtime 02.2C 操作组与终态验收
→ 等待确认
→ Runtime 03 历史持久化
```

详细计划：

- [`Electron-02.2-Codex式根因排查Commentary与过程压缩计划.md`](./Electron-02.2-Codex式根因排查Commentary与过程压缩计划.md)

Runtime 02.2 只调整公开 Commentary 和 Renderer 压缩体验，不进入 Permission、Changes、Terminal、持久化、MCP 或 Multi-Agent。
