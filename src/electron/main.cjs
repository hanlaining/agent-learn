const { join } = require("node:path");
const {
  app,
  BrowserWindow,
  ipcMain,
} = require("electron");

const GET_RUNTIME_STATUS_CHANNEL = "runtime:get-status";
const RUNTIME_STATUS_CHANGED_CHANNEL =
  "runtime:status-changed";
const DESKTOP_GET_SNAPSHOT_CHANNEL = "desktop:get-snapshot";
const DESKTOP_CREATE_THREAD_CHANNEL = "desktop:create-thread";
const DESKTOP_SELECT_THREAD_CHANNEL = "desktop:select-thread";
const DESKTOP_SEND_MESSAGE_CHANNEL = "desktop:send-message";
const DESKTOP_CANCEL_TURN_CHANNEL = "desktop:cancel-turn";
const DESKTOP_DISTILL_THREAD_SKILL_CHANNEL = "desktop:distill-thread-skill";
const DESKTOP_SELECT_MODEL_CHANNEL = "desktop:select-model";
const DESKTOP_SELECT_REASONING_CHANNEL = "desktop:select-reasoning";
const DESKTOP_SELECT_MODEL_SETTINGS_CHANNEL = "desktop:select-model-settings";
const DESKTOP_UPDATE_AGENT_TEAM_CHANNEL = "desktop:update-agent-team";
const DESKTOP_RENAME_THREAD_CHANNEL = "desktop:rename-thread";
const DESKTOP_DELETE_THREADS_CHANNEL = "desktop:delete-threads";
const DESKTOP_RESTORE_THREAD_CHANNEL = "desktop:restore-thread";
const DESKTOP_PERMISSION_REQUESTED_CHANNEL = "desktop:permission-requested";
const DESKTOP_RESPOND_PERMISSION_CHANNEL = "desktop:respond-permission";
const DESKTOP_EVENT_CHANNEL = "desktop:event";
const CLOSED_RUNTIME_STATUS = Object.freeze({
  state: "closed",
  message: "Runtime 已关闭",
});

let mainWindow;
let runtimeClient;
let desktopController;
let shutdownPromise;
let quitAllowed = false;
const pendingPermissions = new Map();

function requestDesktopPermission(request) {
  if (mainWindow === undefined || mainWindow.isDestroyed()) {
    return Promise.resolve({ decision: "deny", reason: "Electron window is unavailable" });
  }
  return new Promise((resolve) => {
    const previous = pendingPermissions.get(request.callId);
    previous?.({ decision: "deny", reason: "Permission request replaced" });
    pendingPermissions.set(request.callId, resolve);
    const permissionContext = desktopController?.getPermissionContext(request.turnId) ?? { agentName: "Agent" };
    mainWindow.webContents.send(DESKTOP_PERMISSION_REQUESTED_CHANNEL, {
      turnId: request.turnId,
      ...permissionContext,
      ...(request.threadId === undefined ? {} : { threadId: request.threadId }),
      ...(request.jobId === undefined ? {} : { jobId: request.jobId }),
      ...(request.agentId === undefined ? {} : { agentId: request.agentId }),
      ...(request.agentName === undefined ? {} : { agentName: request.agentName }),
      ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
      ...(request.taskTitle === undefined ? {} : { taskTitle: request.taskTitle }),
      callId: request.callId,
      toolName: request.toolName,
      ...(request.description === undefined ? {} : { description: request.description }),
      riskLevel: request.riskLevel ?? "sensitive",
    });
  });
}

function denyPendingPermissions(reason) {
  for (const resolve of pendingPermissions.values()) {
    resolve({ decision: "deny", reason });
  }
  pendingPermissions.clear();
}

function createMainWindow() {
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    show: false,
    title: "god-agent",
    backgroundColor: "#f6f7f9",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.removeMenu();

  // Electron 01 没有外部导航能力，阻止页面创建新窗口或离开本地壳。
  window.webContents.setWindowOpenHandler(() => ({
    action: "deny",
  }));
  window.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });

  window.once("ready-to-show", () => {
    window.show();
  });
  window.on("close", (event) => {
    if (quitAllowed) {
      return;
    }

    event.preventDefault();
    void shutdownAndQuit();
  });
  window.once("closed", () => {
    if (mainWindow === window) {
      mainWindow = undefined;
    }
  });

  void window.loadFile(
    join(__dirname, "renderer", "index.html"),
  );

  return window;
}

function createRuntimeClient(AppServerClient) {
  const appServerEntry = join(
    app.getAppPath(),
    "src",
    "app-server",
    "main.ts",
  );

  return new AppServerClient({
    // Electron 自带 Node Runtime；子进程通过该开关进入普通 Node 模式。
    command: process.execPath,
    args: ["--import", "tsx", appServerEntry],
    cwd: app.getAppPath(),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
    },
    onDiagnostic: (message) => {
      // App Server stdout 继续只承载 JSONL；诊断信息仅留在 Main stderr。
      process.stderr.write(message);
    },
    onPermissionRequest: requestDesktopPermission,
  });
}

async function shutdownAndQuit() {
  if (shutdownPromise !== undefined) {
    return shutdownPromise;
  }

  shutdownPromise = (async () => {
    denyPendingPermissions("Electron client closed");
    if (desktopController !== undefined) {
      await desktopController.close();
    } else {
      await runtimeClient?.close();
    }
    quitAllowed = true;
    app.quit();
  })();

  return shutdownPromise;
}

ipcMain.handle(GET_RUNTIME_STATUS_CHANNEL, () => {
  return runtimeClient?.getStatus() ?? CLOSED_RUNTIME_STATUS;
});

function desktopCall(action, fallbackMessage) {
  return Promise.resolve()
    .then(action)
    .then((value) => ({ ok: true, value }))
    .catch(() => ({ ok: false, message: fallbackMessage }));
}

ipcMain.handle(DESKTOP_GET_SNAPSHOT_CHANNEL, () =>
  desktopCall(
    () => desktopController?.getSnapshot(),
    "无法读取桌面会话，请稍后重试",
  ),
);

ipcMain.handle(DESKTOP_CREATE_THREAD_CHANNEL, () =>
  desktopCall(
    () => desktopController?.createThread(),
    "无法新建任务，请稍后重试",
  ),
);

ipcMain.handle(
  DESKTOP_SELECT_THREAD_CHANNEL,
  (_event, threadId) => desktopCall(
    () => {
      if (typeof threadId !== "string") {
        throw new Error("Invalid thread id");
      }

      return desktopController?.selectThread(threadId);
    },
    "无法切换任务，请稍后重试",
  ),
);

ipcMain.handle(
  DESKTOP_RESPOND_PERMISSION_CHANNEL,
  (_event, response) => desktopCall(() => {
    if (
      response === null || typeof response !== "object" ||
      typeof response.callId !== "string" ||
      (response.decision !== "allow" && response.decision !== "deny")
    ) {
      throw new Error("Invalid permission decision");
    }
    const resolve = pendingPermissions.get(response.callId);
    if (resolve === undefined) return false;
    pendingPermissions.delete(response.callId);
    if (response.decision === "deny") {
      resolve({ decision: "deny", reason: "User denied in Electron" });
    } else {
      if (response.scope !== "once" && response.scope !== "session") {
        throw new Error("Invalid permission scope");
      }
      resolve({ decision: "allow", scope: response.scope });
    }
    return true;
  }, "权限请求已失效"),
);

ipcMain.handle(
  DESKTOP_SEND_MESSAGE_CHANNEL,
  (_event, text) => desktopCall(
    () => {
      if (typeof text !== "string") {
        throw new Error("Invalid message");
      }

      return desktopController?.sendMessage(text);
    },
    "Agent 执行失败，请重试",
  ),
);

ipcMain.handle(DESKTOP_CANCEL_TURN_CHANNEL, () =>
  desktopCall(
    () => {
      denyPendingPermissions("Turn cancelled in Electron");
      return desktopController?.cancelTurn();
    },
    "无法停止当前任务，请稍后重试",
  ),
);

ipcMain.handle(DESKTOP_DISTILL_THREAD_SKILL_CHANNEL, () =>
  desktopCall(
    () => desktopController?.distillActiveThreadToSkill(),
    "沉淀失败，请检查 Chat 是否包含可复用知识后重试",
  ),
);

ipcMain.handle(
  DESKTOP_SELECT_MODEL_CHANNEL,
  (_event, model) => desktopCall(
    () => {
      if (typeof model !== "string") throw new Error("Invalid model");
      return desktopController?.selectModel(model);
    },
    "无法切换模型，请稍后重试",
  ),
);

ipcMain.handle(
  DESKTOP_SELECT_REASONING_CHANNEL,
  (_event, effort) => desktopCall(
    () => {
      if (typeof effort !== "string") throw new Error("Invalid reasoning effort");
      return desktopController?.selectReasoningEffort(effort);
    },
    "无法切换推理强度，请稍后重试",
  ),
);

ipcMain.handle(
  DESKTOP_SELECT_MODEL_SETTINGS_CHANNEL,
  (_event, settings) => desktopCall(
    () => {
      if (
        settings === null || typeof settings !== "object" ||
        typeof settings.model !== "string" ||
        typeof settings.reasoningEffort !== "string"
      ) throw new Error("Invalid model settings");
      return desktopController?.selectModelSettings(settings);
    },
    "无法更新模型与推理强度，请稍后重试",
  ),
);

ipcMain.handle(DESKTOP_UPDATE_AGENT_TEAM_CHANNEL, (_event, config) => desktopCall(() => desktopController?.updateAgentTeam(config ?? {}), "无法更新 Agent 配置"));
ipcMain.handle(DESKTOP_RENAME_THREAD_CHANNEL, (_event, value) => desktopCall(() => desktopController?.renameThread(value?.threadId, value?.title), "无法重命名 Chat"));
ipcMain.handle(DESKTOP_DELETE_THREADS_CHANNEL, (_event, value) => desktopCall(() => desktopController?.softDeleteThreads(value?.threadIds, value?.batchDeleteId), "无法删除 Chat"));
ipcMain.handle(DESKTOP_RESTORE_THREAD_CHANNEL, (_event, threadId) => desktopCall(() => desktopController?.restoreThread(threadId), "无法恢复 Chat"));

app.on("before-quit", (event) => {
  if (quitAllowed) {
    return;
  }

  event.preventDefault();
  void shutdownAndQuit();
});

app.whenReady()
  .then(async () => {
    const { AppServerClient } = await import(
      "./app-server-client.js"
    );
    const { DesktopController } = await import(
      "./desktop-controller.js"
    );

    runtimeClient = createRuntimeClient(AppServerClient);
    desktopController = new DesktopController(runtimeClient);
    desktopController.onEvent((event) => {
      // DesktopController 已把 AgentEvent 映射成 Renderer 白名单事件。
      mainWindow?.webContents.send(
        DESKTOP_EVENT_CHANNEL,
        event,
      );
    });
    runtimeClient.onStatusChange((status) => {
      if (status.state === "failed" || status.state === "closed") {
        denyPendingPermissions("Runtime is unavailable");
      }
      // IPC 只传递 runtime-status.ts 定义的固定安全对象。
      mainWindow?.webContents.send(
        RUNTIME_STATUS_CHANGED_CHANNEL,
        status,
      );
    });

    // start() 会在第一次 await 前同步进入 connecting，避免页面先看到 closed。
    void runtimeClient.start();
    mainWindow = createMainWindow();
  })
  .catch(() => {
    // 启动入口也不打印原始异常，避免意外泄露本机路径或环境信息。
    process.stderr.write(
      "[electron-main] desktop startup failed\n",
    );
    app.exit(1);
  });
