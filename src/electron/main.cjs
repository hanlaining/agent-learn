const { join } = require("node:path");
const {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  shell,
} = require("electron");
const { PreviewServer } = require("./preview-server.cjs");
const { BrowserManager } = require("./browser-manager.cjs");

const GET_RUNTIME_STATUS_CHANNEL = "runtime:get-status";
const RUNTIME_STATUS_CHANGED_CHANNEL =
  "runtime:status-changed";
const DESKTOP_GET_SNAPSHOT_CHANNEL = "desktop:get-snapshot";
const DESKTOP_RESOLVE_OUTCOME_UNKNOWN_CHANNEL = "desktop:resolve-outcome-unknown";
const DESKTOP_CREATE_THREAD_CHANNEL = "desktop:create-thread";
const DESKTOP_SELECT_THREAD_CHANNEL = "desktop:select-thread";
const DESKTOP_SELECT_AGENT_THREAD_CHANNEL = "desktop:select-agent-thread";
const DESKTOP_CONFIRM_REQUIREMENT_CHANNEL = "desktop:confirm-requirement";
const DESKTOP_ADVANCE_FIXED_PRODUCT_CHANNEL = "desktop:advance-fixed-product";
const DESKTOP_OPEN_PLAN_CHANNEL = "desktop:open-plan";
const PREVIEW_GET_STATUS_CHANNEL = "preview:get-status";
const PREVIEW_START_CHANNEL = "preview:start";
const PREVIEW_STOP_CHANNEL = "preview:stop";
const PREVIEW_OPEN_EXTERNAL_CHANNEL = "preview:open-external";
const BROWSER_GET_STATE_CHANNEL = "browser:get-state";
const BROWSER_CREATE_TAB_CHANNEL = "browser:create-tab";
const BROWSER_CLOSE_TAB_CHANNEL = "browser:close-tab";
const BROWSER_ACTIVATE_TAB_CHANNEL = "browser:activate-tab";
const BROWSER_NAVIGATE_CHANNEL = "browser:navigate";
const BROWSER_GO_BACK_CHANNEL = "browser:go-back";
const BROWSER_GO_FORWARD_CHANNEL = "browser:go-forward";
const BROWSER_RELOAD_CHANNEL = "browser:reload";
const BROWSER_STOP_CHANNEL = "browser:stop";
const BROWSER_OPEN_EXTERNAL_CHANNEL = "browser:open-external";
const BROWSER_SET_BOUNDS_CHANNEL = "browser:set-bounds";
const BROWSER_STATE_CHANGED_CHANNEL = "browser:state-changed";
const BROWSER_COMMAND_CHANNEL = "browser:command";
const DESKTOP_SEND_MESSAGE_CHANNEL = "desktop:send-message";
const DESKTOP_SEARCH_WORKSPACE_FILES_CHANNEL = "desktop:search-workspace-files";
const DESKTOP_CANCEL_TURN_CHANNEL = "desktop:cancel-turn";
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
let browserManager;
let shutdownPromise;
let quitAllowed = false;
const pendingPermissions = new Map();
const previewServer = new PreviewServer(join(app.getAppPath(), "examples", "today-fortune"));

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

  browserManager = new BrowserManager({
    BrowserViewClass: WebContentsView,
    window,
    shell,
    onStateChange: (state) => {
      if (!window.isDestroyed()) window.webContents.send(BROWSER_STATE_CHANGED_CHANNEL, state);
    },
    onCommand: (command) => {
      if (!window.isDestroyed()) window.webContents.send(BROWSER_COMMAND_CHANNEL, command);
    },
  });

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
    browserManager?.destroy();
    browserManager = undefined;
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
    browserManager?.destroy();
    browserManager = undefined;
    await previewServer.stop();
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

ipcMain.handle(DESKTOP_RESOLVE_OUTCOME_UNKNOWN_CHANNEL, (_event, input) =>
  desktopCall(
    () => {
      if (!isSafeOutcomeUnknownResolutionInput(input)) {
        throw new Error("Invalid outcome-unknown resolution");
      }
      return desktopController?.resolveOutcomeUnknown(input);
    },
    "处置已失效或无权限，请刷新后重试",
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
ipcMain.handle(DESKTOP_SELECT_AGENT_THREAD_CHANNEL, (_event, threadId) => desktopCall(
  () => desktopController?.selectAgentThread(typeof threadId === "string" ? threadId : undefined),
  "无法打开子 Agent 对话",
));
ipcMain.handle(DESKTOP_CONFIRM_REQUIREMENT_CHANNEL, () => desktopCall(
  () => desktopController?.confirmRequirement(),
  "无法确认并执行当前需求",
));
ipcMain.handle(DESKTOP_ADVANCE_FIXED_PRODUCT_CHANNEL, (_event, expectedStage) => desktopCall(() => {
  const stages = ["ready_first_return", "first_return_ready", "rework", "second_return_ready", "engineering_ready", "engineering_return_ready", "quality_ready", "quality_return_ready", "lead_return_ready", "completed"];
  if (typeof expectedStage !== "string" || !stages.includes(expectedStage)) throw new Error("Invalid fixed product stage");
  return desktopController?.advanceFixedProduct(expectedStage);
}, "无法推进产品双轮验收"));
ipcMain.handle(DESKTOP_OPEN_PLAN_CHANNEL, async (_event, path) => {
  if (typeof path !== "string" || !path.toLowerCase().endsWith(".md")) throw new Error("Invalid plan path");
  const result = await shell.openPath(path);
  if (result) throw new Error("无法打开计划文档");
  return true;
});
ipcMain.handle(PREVIEW_GET_STATUS_CHANNEL, () => previewServer.getStatus());
ipcMain.handle(PREVIEW_START_CHANNEL, () => desktopCall(() => previewServer.start(), "无法启动本地项目预览"));
ipcMain.handle(PREVIEW_STOP_CHANNEL, () => desktopCall(() => previewServer.stop(), "无法停止本地项目预览"));
ipcMain.handle(PREVIEW_OPEN_EXTERNAL_CHANNEL, () => desktopCall(async () => {
  const status = previewServer.getStatus();
  if (status.state !== "running") throw new Error("Preview is not running");
  await shell.openExternal(status.url); return true;
}, "无法在外部浏览器打开项目"));

ipcMain.handle(BROWSER_GET_STATE_CHANNEL, () => desktopCall(
  () => browserManager?.getState(),
  "无法读取浏览器状态",
));
ipcMain.handle(BROWSER_CREATE_TAB_CHANNEL, (_event, url) => desktopCall(
  () => browserManager?.createTab(typeof url === "string" ? url : undefined),
  "无法新建浏览器标签",
));
ipcMain.handle(BROWSER_CLOSE_TAB_CHANNEL, (_event, id) => desktopCall(
  () => browserManager?.closeTab(id),
  "无法关闭浏览器标签",
));
ipcMain.handle(BROWSER_ACTIVATE_TAB_CHANNEL, (_event, id) => desktopCall(
  () => browserManager?.activateTab(id),
  "无法切换浏览器标签",
));
ipcMain.handle(BROWSER_NAVIGATE_CHANNEL, (_event, value) => desktopCall(
  () => browserManager?.navigate(value?.id, value?.url),
  "无法打开该网页，请检查地址后重试",
));
ipcMain.handle(BROWSER_GO_BACK_CHANNEL, (_event, id) => desktopCall(
  () => browserManager?.goBack(id),
  "当前网页无法后退",
));
ipcMain.handle(BROWSER_GO_FORWARD_CHANNEL, (_event, id) => desktopCall(
  () => browserManager?.goForward(id),
  "当前网页无法前进",
));
ipcMain.handle(BROWSER_RELOAD_CHANNEL, (_event, id) => desktopCall(
  () => browserManager?.reload(id),
  "无法刷新当前网页",
));
ipcMain.handle(BROWSER_STOP_CHANNEL, (_event, id) => desktopCall(
  () => browserManager?.stop(id),
  "无法停止加载当前网页",
));
ipcMain.handle(BROWSER_OPEN_EXTERNAL_CHANNEL, (_event, id) => desktopCall(
  () => browserManager?.openExternal(id),
  "当前网页无法在外部浏览器打开",
));
ipcMain.on(BROWSER_SET_BOUNDS_CHANNEL, (event, bounds) => {
  if (mainWindow === undefined || event.sender !== mainWindow.webContents) return;
  browserManager?.setBounds(bounds);
});

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
  (_event, input) => desktopCall(
    () => {
      if (!isSafeMessageInput(input)) {
        throw new Error("Invalid message");
      }

      return desktopController?.sendMessage(input);
    },
    "Agent 执行失败，请重试",
  ),
);

ipcMain.handle(
  DESKTOP_SEARCH_WORKSPACE_FILES_CHANNEL,
  (_event, query) => desktopCall(
    () => {
      if (typeof query !== "string" || query.length > 240) throw new Error("Invalid workspace file query");
      return desktopController?.searchWorkspaceFiles(query);
    },
    "无法搜索工作区文件",
  ),
);

function isSafeMessageInput(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || typeof value.text !== "string") return false;
  if (Object.keys(value).some((key) => !["text", "mentions", "explicitSkills"].includes(key))) return false;
  if (value.text.trim().length === 0 || [...value.text].length > 32_000) return false;
  return (value.mentions === undefined || (
    Array.isArray(value.mentions) && value.mentions.length <= 20 && value.mentions.every((mention) =>
      mention !== null && typeof mention === "object" && !Array.isArray(mention) &&
      mention.kind === "file" && typeof mention.path === "string" && mention.path.trim().length > 0 &&
      mention.path.length <= 500 && !/[\u0000-\u001f\u007f]/u.test(mention.path) &&
      Object.keys(mention).every((key) => key === "kind" || key === "path")
    )
  )) && (value.explicitSkills === undefined || (
    Array.isArray(value.explicitSkills) && value.explicitSkills.length <= 20 &&
    value.explicitSkills.every((name) => typeof name === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name))
  ));
}

function isSafeOutcomeUnknownResolutionInput(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some((key) => !["resolutionId", "expectedVersion", "idempotencyKey", "resolution"].includes(key)) ||
    typeof value.resolutionId !== "string" || !Number.isInteger(value.expectedVersion) ||
    typeof value.idempotencyKey !== "string" || value.resolution === null ||
    typeof value.resolution !== "object" || Array.isArray(value.resolution) ||
    typeof value.resolution.action !== "string" || typeof value.resolution.reason !== "string") return false;
  const allowed = value.resolution.action === "confirm_not_executed_retry"
    ? ["action", "reason", "toolSideEffectConfirmed"]
    : value.resolution.action === "record_external_result"
      ? ["action", "reason", "externalResult"]
      : ["action", "reason"];
  if (Object.keys(value.resolution).some((key) => !allowed.includes(key))) return false;
  if (value.resolution.action === "confirm_not_executed_retry") {
    return value.resolution.toolSideEffectConfirmed === undefined || typeof value.resolution.toolSideEffectConfirmed === "boolean";
  }
  if (value.resolution.action === "record_external_result") {
    const result = value.resolution.externalResult;
    return result !== null && typeof result === "object" && !Array.isArray(result) &&
      Object.keys(result).every((key) => key === "summary" || key === "value") &&
      typeof result.summary === "string" && Object.hasOwn(result, "value");
  }
  return value.resolution.action === "mark_manual_required" || value.resolution.action === "abandon";
}

ipcMain.handle(DESKTOP_CANCEL_TURN_CHANNEL, () =>
  desktopCall(
    () => {
      denyPendingPermissions("Turn cancelled in Electron");
      return desktopController?.cancelTurn();
    },
    "无法停止当前任务，请稍后重试",
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
