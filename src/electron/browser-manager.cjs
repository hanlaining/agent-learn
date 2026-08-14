const BLANK_URL = "about:blank";
const DEFAULT_TITLE = "新标签页";

function normalizeBrowserInput(value) {
  if (typeof value !== "string") throw new TypeError("浏览器地址必须是字符串");
  const input = value.trim();
  if (input.length === 0) return BLANK_URL;

  if (/^https?:\/\//i.test(input)) {
    const parsed = new URL(input);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("仅支持 HTTP/HTTPS 地址");
    }
    return parsed.href;
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(input)) {
    throw new Error("仅支持 HTTP/HTTPS 地址");
  }
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(input)) {
    return new URL(`http://${input}`).href;
  }
  if (!/\s/.test(input) && (/^[\w.-]+\.[a-z]{2,}(?::\d+)?(?:\/|$)/i.test(input))) {
    return new URL(`https://${input}`).href;
  }
  return `https://www.bing.com/search?q=${encodeURIComponent(input)}`;
}

function isAllowedPageUrl(value, allowBlank = false) {
  if (allowBlank && value === BLANK_URL) return true;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

class BrowserManager {
  constructor({ BrowserViewClass, window, shell, partition = "persist:god-agent-browser", onStateChange, onCommand }) {
    this.BrowserViewClass = BrowserViewClass;
    this.window = window;
    this.shell = shell;
    this.partition = partition;
    this.onStateChange = onStateChange;
    this.onCommand = onCommand;
    this.tabs = new Map();
    this.activeTabId = undefined;
    this.nextTabId = 1;
    this.bounds = { x: 0, y: 0, width: 0, height: 0, visible: false };
    this.permissionSession = undefined;
    this.createTab();
  }

  getState() {
    return {
      tabs: [...this.tabs.values()].map((tab) => ({
        id: tab.id,
        title: tab.title,
        url: tab.url === BLANK_URL ? "" : tab.url,
        faviconUrl: tab.faviconUrl,
        isLoading: tab.isLoading,
        canGoBack: this.canGoBack(tab.view.webContents),
        canGoForward: this.canGoForward(tab.view.webContents),
        ...(tab.error === undefined ? {} : { error: tab.error }),
      })),
      activeTabId: this.activeTabId,
    };
  }

  createTab(value = BLANK_URL, options = {}) {
    const url = value === BLANK_URL
      ? BLANK_URL
      : normalizeBrowserInput(value);
    if (!isAllowedPageUrl(url, true)) throw new Error("仅支持 HTTP/HTTPS 地址");

    const id = `browser-tab-${this.nextTabId++}`;
    const view = new this.BrowserViewClass({
      webPreferences: {
        partition: this.partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: false,
      },
    });
    const tab = {
      id,
      view,
      title: DEFAULT_TITLE,
      url,
      faviconUrl: undefined,
      isLoading: url !== BLANK_URL,
      error: undefined,
    };
    this.tabs.set(id, tab);
    this.configureSession(view.webContents.session);
    this.bindTabEvents(tab);
    this.activateTab(id, false);
    if (url !== BLANK_URL) void view.webContents.loadURL(url).catch(() => undefined);
    if (options.emit !== false) this.emitState();
    return this.getState();
  }

  configureSession(browserSession) {
    if (this.permissionSession === browserSession) return;
    this.permissionSession = browserSession;
    browserSession.setPermissionCheckHandler(() => false);
    browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    browserSession.on("will-download", (event) => {
      event.preventDefault();
    });
  }

  bindTabEvents(tab) {
    const contents = tab.view.webContents;
    const updateNavigation = (_event, url) => {
      if (!isAllowedPageUrl(url, true)) return;
      tab.url = url;
      tab.error = undefined;
      this.emitState();
    };

    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedPageUrl(url, true)) this.createTab(url);
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      if (!isAllowedPageUrl(url, true)) event.preventDefault();
    });
    contents.on("will-redirect", (event, url) => {
      if (!isAllowedPageUrl(url, true)) event.preventDefault();
    });
    contents.on("did-start-loading", () => {
      tab.isLoading = true;
      tab.error = undefined;
      this.emitState();
    });
    contents.on("did-stop-loading", () => {
      tab.isLoading = false;
      this.emitState();
    });
    contents.on("did-navigate", updateNavigation);
    contents.on("did-navigate-in-page", updateNavigation);
    contents.on("page-title-updated", (event, title) => {
      event.preventDefault();
      tab.title = typeof title === "string" && title.trim() ? title.trim().slice(0, 240) : DEFAULT_TITLE;
      this.emitState();
    });
    contents.on("page-favicon-updated", (_event, favicons) => {
      tab.faviconUrl = Array.isArray(favicons)
        ? favicons.find((url) => isAllowedPageUrl(url) || /^data:image\//i.test(url))
        : undefined;
      this.emitState();
    });
    contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      tab.isLoading = false;
      tab.error = typeof description === "string" ? description.slice(0, 160) : "网页加载失败";
      if (isAllowedPageUrl(url)) tab.url = url;
      this.emitState();
    });
    contents.on("render-process-gone", () => {
      tab.isLoading = false;
      tab.error = "网页进程已停止，可刷新重试";
      this.emitState();
    });
    contents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      const key = String(input.key).toLowerCase();
      const primary = input.control === true || input.meta === true;
      if (primary && key === "l") {
        event.preventDefault();
        this.emitCommand("focus_address");
      } else if (primary && key === "t" && input.isAutoRepeat !== true) {
        event.preventDefault();
        this.createTab();
        this.emitCommand("focus_address");
      } else if (primary && key === "w" && input.isAutoRepeat !== true) {
        event.preventDefault();
        this.closeTab(tab.id);
      } else if ((primary && key === "r") || key === "f5") {
        event.preventDefault();
        this.reload(tab.id);
      } else if (input.alt === true && key === "arrowleft") {
        event.preventDefault();
        this.goBack(tab.id);
      } else if (input.alt === true && key === "arrowright") {
        event.preventDefault();
        this.goForward(tab.id);
      } else if (primary && key === "tab") {
        event.preventDefault();
        this.activateAdjacentTab(input.shift === true ? -1 : 1);
      }
    });
  }

  activateTab(id, emit = true) {
    const next = this.tabs.get(id);
    if (next === undefined) throw new Error("浏览器标签不存在");
    const previous = this.tabs.get(this.activeTabId);
    if (previous !== undefined && previous !== next) this.detachView(previous.view);
    this.activeTabId = id;
    this.showActiveView();
    if (emit) this.emitState();
    return this.getState();
  }

  closeTab(id) {
    const tab = this.tabs.get(id);
    if (tab === undefined) return this.getState();
    const ids = [...this.tabs.keys()];
    const index = ids.indexOf(id);
    this.detachView(tab.view);
    tab.view.webContents.close();
    this.tabs.delete(id);

    if (this.tabs.size === 0) {
      this.activeTabId = undefined;
      return this.createTab();
    }
    if (this.activeTabId === id) {
      const nextId = ids[index + 1] ?? ids[index - 1];
      this.activeTabId = undefined;
      this.activateTab(nextId, false);
    }
    this.emitState();
    return this.getState();
  }

  navigate(id, value) {
    const tab = this.tabs.get(id ?? this.activeTabId);
    if (tab === undefined) throw new Error("浏览器标签不存在");
    const url = normalizeBrowserInput(value);
    tab.url = url;
    tab.title = url === BLANK_URL ? DEFAULT_TITLE : tab.title;
    tab.error = undefined;
    void tab.view.webContents.loadURL(url).catch(() => undefined);
    this.emitState();
    return this.getState();
  }

  goBack(id) {
    const contents = this.getContents(id);
    if (this.canGoBack(contents)) {
      if (contents.navigationHistory) contents.navigationHistory.goBack();
      else contents.goBack();
    }
    return this.getState();
  }

  goForward(id) {
    const contents = this.getContents(id);
    if (this.canGoForward(contents)) {
      if (contents.navigationHistory) contents.navigationHistory.goForward();
      else contents.goForward();
    }
    return this.getState();
  }

  canGoBack(contents) {
    return contents.navigationHistory
      ? contents.navigationHistory.canGoBack()
      : contents.canGoBack();
  }

  canGoForward(contents) {
    return contents.navigationHistory
      ? contents.navigationHistory.canGoForward()
      : contents.canGoForward();
  }

  reload(id) {
    this.getContents(id).reload();
    return this.getState();
  }

  stop(id) {
    this.getContents(id).stop();
    return this.getState();
  }

  async openExternal(id) {
    const tab = this.tabs.get(id ?? this.activeTabId);
    if (tab === undefined || !isAllowedPageUrl(tab.url)) throw new Error("当前标签没有可打开的网址");
    await this.shell.openExternal(tab.url);
    return true;
  }

  getContents(id) {
    const tab = this.tabs.get(id ?? this.activeTabId);
    if (tab === undefined) throw new Error("浏览器标签不存在");
    return tab.view.webContents;
  }

  activateAdjacentTab(direction) {
    const ids = [...this.tabs.keys()];
    const current = ids.indexOf(this.activeTabId);
    if (ids.length < 2 || current < 0) return this.getState();
    const next = (current + direction + ids.length) % ids.length;
    return this.activateTab(ids[next]);
  }

  setBounds(value) {
    const visible = value?.visible === true;
    const number = (key) => Math.max(0, Math.round(Number(value?.[key]) || 0));
    this.bounds = {
      x: number("x"),
      y: number("y"),
      width: number("width"),
      height: number("height"),
      visible,
    };
    this.showActiveView();
  }

  showActiveView() {
    for (const [id, tab] of this.tabs) {
      if (id !== this.activeTabId) this.detachView(tab.view);
    }
    const tab = this.tabs.get(this.activeTabId);
    if (tab === undefined) return;
    const { x, y, width, height, visible } = this.bounds;
    if (!visible || width < 1 || height < 1) {
      this.detachView(tab.view);
      return;
    }
    this.window.contentView.addChildView(tab.view);
    tab.view.setBounds({ x, y, width, height });
  }

  detachView(view) {
    try {
      this.window.contentView.removeChildView(view);
    } catch {
      // The view may already be detached during a tab switch or shutdown.
    }
  }

  emitState() {
    this.onStateChange?.(this.getState());
  }

  emitCommand(command) {
    this.onCommand?.(command);
  }

  destroy() {
    for (const tab of this.tabs.values()) {
      this.detachView(tab.view);
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
    this.tabs.clear();
    this.activeTabId = undefined;
  }
}

module.exports = {
  BrowserManager,
  normalizeBrowserInput,
};
