# Electron 01：最小桌面壳与 App Server 握手实现记录

> 完成日期：2026-08-05  
> 实现范围：Electron 启动、App Server 握手、四状态页面、安全关闭  
> 最终基线：`npm run check` 通过，`npm test` 167/167 通过

## 一、完成结论

Electron 已经作为 god-agent CLI 的并列 Client 接入现有 App Server：

```text
Electron 启动
→ Main 创建 BrowserWindow
→ Main 启动现有 App Server 子进程
→ JsonRpcConnection 发送 initialize
→ 校验 initialize Result
→ 发送 initialized Notification
→ Renderer 显示 Runtime 已连接
→ 用户关闭窗口
→ Main 关闭 JSON-RPC 并结束 App Server stdin
→ App Server 清理资源并退出
→ Electron 等待子进程退出后关闭
```

本切片没有实现聊天、Thread 侧边栏、Thinking、Tool、Permission、MCP 设置或打包。

## 二、实施步骤

### 步骤 1：定义安全状态模型

文件：`src/electron/runtime-status.ts`

只允许四种状态进入 IPC：

```ts
export type RuntimeConnectionState =
  | "connecting"
  | "connected"
  | "failed"
  | "closed";
```

失败状态只包含固定错误码和固定中文文案，不包含原始 Error、命令、路径、stderr 或环境变量。

### 步骤 2：实现 Main 持有的 App Server Client

文件：`src/electron/app-server-client.ts`

该类只运行在 Electron Main：

- 使用 `shell: false` 启动明确的 App Server；
- 持有子进程和现有 `JsonRpcConnection`；
- App Server stdout 只送入 JSONL Connection；
- stderr 只留在 Main 诊断边界；
- 完成 `initialize / initialized`；
- 握手和关闭都有有界超时；
- 关闭时先结束 stdin，让 App Server 有机会清理 MCP；
- 优雅关闭超时后才终止明确持有的 App Server 进程。

最核心握手代码：

```ts
const initializeResult = await withTimeout(
  connection.sendRequest("initialize", {
    clientName: "god-agent-electron",
    protocolVersion: 1,
  }),
  handshakeTimeoutMs,
  "App Server initialize timed out",
);

if (!isInitializeResult(initializeResult)) {
  throw new Error("Invalid initialize response");
}

connection.sendNotification("initialized");
this.setStatus(CONNECTED_RUNTIME_STATUS);
```

最核心关闭代码：

```ts
this.connection?.close();

if (child.stdin.writable) {
  child.stdin.end();
}

await waitForExit(child);
```

### 步骤 3：实现 Electron Main

文件：`src/electron/main.cjs`

最外层入口使用 CommonJS，避免 Windows + Electron 41 的 ESM Main 启动兼容问题；核心 Client 仍由 TypeScript 编译成 ESM，并在 `app.whenReady()` 后动态导入。

BrowserWindow 的核心安全配置：

```js
webPreferences: {
  preload: join(__dirname, "preload.cjs"),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
}
```

Main 同时阻止外部导航和新窗口。Renderer 无法得到子进程、JSON-RPC、环境变量或 initialize Result。

关闭窗口时先阻止默认退出，等待 Runtime Client 完成清理后再调用 `app.quit()`：

```js
async function shutdownAndQuit() {
  await runtimeClient?.close();
  quitAllowed = true;
  app.quit();
}
```

### 步骤 4：实现最小 Preload 白名单

文件：`src/electron/preload.cjs`

Renderer 只得到两个 API：

```js
window.godAgent.runtime.getStatus();
window.godAgent.runtime.onStatusChange(listener);
```

Preload 不暴露 `ipcRenderer`，并再次白名单校验 Main 发来的状态对象。

### 步骤 5：实现四状态 Renderer

文件：

- `src/electron/renderer/index.html`
- `src/electron/renderer/renderer.js`
- `src/electron/renderer/styles.css`

页面只使用本地静态资源，CSP 设置为：

```text
default-src 'self'
script-src 'self'
style-src 'self'
connect-src 'none'
```

状态文案全部通过 `textContent` 写入，IPC 数据不会被解释成 HTML。

### 步骤 6：增加独立构建与启动入口

文件：

- `tsconfig.electron.json`
- `scripts/build-electron.mjs`
- `scripts/start-electron.mjs`
- `package.json`
- `package-lock.json`

Electron 精确锁定为 `41.6.1`。该版本兼容项目当前 Node 20.19；没有采用要求 Node 22.12 的 Electron 42/43。

启动脚本会在启动桌面 Main 前移除可能由开发环境继承的 `ELECTRON_RUN_AS_NODE`。Main 启动 App Server 时，再只对 App Server 子进程设置该变量。

```text
桌面 Electron：ELECTRON_RUN_AS_NODE 不存在
App Server 子进程：ELECTRON_RUN_AS_NODE=1
```

## 三、进程与安全边界

```text
Renderer
  └─ 纯 HTML / CSS / JS
       ↓ contextBridge：状态快照 + 状态订阅
Preload
  └─ IPC 白名单与 Payload 校验
       ↓ Electron IPC
Main
  ├─ BrowserWindow
  ├─ AppServerClient
  ├─ JsonRpcConnection
  └─ 环境变量边界
       ↓ stdin/stdout JSONL
App Server
  └─ 现有单 Agent Runtime
```

Key 只可能存在于 Main/App Server 环境，不进入 Renderer、IPC Payload、页面、测试快照或本文档。

## 四、文件职责

| 文件 | 职责 |
|---|---|
| `src/electron/runtime-status.ts` | 四状态模型与安全失败文案 |
| `src/electron/app-server-client.ts` | 子进程、JSON-RPC、握手、超时和关闭 |
| `src/electron/main.cjs` | Electron 生命周期、窗口和 IPC |
| `src/electron/preload.cjs` | contextBridge 最小白名单 |
| `src/electron/renderer/*` | 连接状态页面 |
| `tests/electron-app-server-client-test.ts` | 真实握手、失败脱敏和 PID 退出测试 |
| `tsconfig.electron.json` | Electron TypeScript 独立输出配置 |
| `scripts/build-electron.mjs` | 复制 Main/Preload/Renderer 静态资源 |
| `scripts/start-electron.mjs` | 跨环境启动真正的 Electron 桌面模式 |

## 五、自动化验收

执行：

```powershell
npm run check
npm test
npm run electron:build
node bin/god-agent.js --version
```

结果：

```text
npm run check            通过
npm test                 167/167 通过
npm run electron:build   通过
god-agent CLI            god-agent 1.0.0
```

新增测试实际验证：

1. 启动真实 App Server；
2. 完成 `initialize / initialized`；
3. 状态按 `connecting → connected` 变化；
4. 关闭后 App Server PID 不再存在；
5. 不存在的启动命令只返回固定 `start_failed` 安全状态。

## 六、真实桌面启动验收

通过 `scripts/start-electron.mjs` 启动桌面端后确认：

```text
窗口创建成功：是
窗口标题：god-agent
App Server 子进程：已检测
正常关闭窗口：Electron Main 已退出
关闭后 App Server：已退出
启动器进程：已退出
```

## 七、手动验收步骤

在项目根目录执行：

```powershell
npm run electron:dev
```

然后：

1. 等待 `god-agent` 窗口打开；
2. 页面应先显示“Runtime 正在连接…”；
3. 握手完成后显示“Runtime 已连接”；
4. 关闭窗口；
5. 命令行应恢复提示符，桌面端不保留后台进程。

## 八、Electron 02 之前仍不做的内容

```text
聊天输入和消息列表
Thread 侧边栏
Thinking / Reasoning Summary
Tool / Search / Sources
Permission 弹窗
MCP 设置页
Windows 打包
Multi-Agent
```

Electron 02 应继续复用本切片建立的 Main、AppServerClient、Preload 白名单和状态通道，不重新实现 Runtime。

## 九、为保持 CLI 基线补充的幂等修复

多次全量回归暴露了一个 Electron 01 之前已经存在的 CLI 窄竞态：在“Assistant 文本刚输出、Turn 完成回调尚未清空 activeTurn”这一窗口收到 `/exit` 时，CLI 会补发一次 `turn/cancel`，而 App Server 已经完成该 Turn。

为了保持原有 CLI 安全退出基线，`src/cli/main.ts` 增加了最小幂等处理：只有远端明确返回当前 Turn 的 `Turn is not running` 时，才把取消视为已经达到目标；其他取消错误仍保持原行为并向上抛出。没有修改 App Server、Runtime 协议或正常 CLI 输出。
