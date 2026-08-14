const { app, BrowserWindow, WebContentsView, shell } = require("electron");
const { BrowserManager } = require("../src/electron/browser-manager.cjs");

function waitForMainFrame(contents, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("联网网页加载超时")), timeoutMs);
    const onFinish = () => finish();
    const onFail = (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) finish(new Error(`联网网页加载失败：${description}`));
    };
    const finish = (error) => {
      clearTimeout(timeout);
      contents.removeListener("did-stop-loading", onFinish);
      contents.removeListener("did-fail-load", onFail);
      if (error) reject(error); else resolve();
    };
    contents.once("did-stop-loading", onFinish);
    contents.on("did-fail-load", onFail);
  });
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 900, height: 640 });
  const manager = new BrowserManager({ BrowserViewClass: WebContentsView, window, shell });
  try {
    manager.setBounds({ x: 0, y: 0, width: 900, height: 640, visible: true });
    const firstId = manager.getState().activeTabId;
    const firstContents = manager.tabs.get(firstId).view.webContents;
    const firstLoad = waitForMainFrame(firstContents);
    manager.navigate(firstId, "https://example.com/");
    await firstLoad;

    manager.createTab();
    const secondId = manager.getState().activeTabId;
    const secondContents = manager.tabs.get(secondId).view.webContents;
    const secondLoad = waitForMainFrame(secondContents);
    manager.navigate(secondId, "https://www.iana.org/help/example-domains");
    await secondLoad;

    const state = manager.getState();
    if (state.tabs.length !== 2 || !state.tabs.every((tab) => tab.url.startsWith("https://"))) {
      throw new Error(`联网多标签状态不正确：${JSON.stringify(state)}`);
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      tabs: state.tabs.map((tab) => ({ title: tab.title, url: tab.url, isLoading: tab.isLoading })),
      activeTabId: state.activeTabId,
    })}\n`);
  } finally {
    manager.destroy();
    window.destroy();
    app.quit();
  }
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "联网浏览器验收失败"}\n`);
  app.exit(1);
});
