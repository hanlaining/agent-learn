import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { BrowserManager, normalizeBrowserInput } = require("../src/electron/browser-manager.cjs") as {
  BrowserManager: new (options: Record<string, unknown>) => BrowserManagerLike;
  normalizeBrowserInput: (value: string) => string;
};

test("联网浏览器地址栏只生成 HTTP/HTTPS 导航", () => {
  assert.equal(normalizeBrowserInput("example.com"), "https://example.com/");
  assert.equal(normalizeBrowserInput("127.0.0.1:4312/demo"), "http://127.0.0.1:4312/demo");
  assert.equal(normalizeBrowserInput("查找 God Agent"), "https://www.bing.com/search?q=%E6%9F%A5%E6%89%BE%20God%20Agent");
  assert.throws(() => normalizeBrowserInput("file:///C:/secret.txt"), /HTTP\/HTTPS/);
  assert.throws(() => normalizeBrowserInput("javascript:alert(1)"), /HTTP\/HTTPS/);
});

test("多标签浏览器隔离网页权限、切换视图并把弹窗转成标签", async () => {
  const window = new FakeWindow();
  const external: string[] = [];
  const states: BrowserStateLike[] = [];
  const commands: string[] = [];
  const manager = new BrowserManager({
    BrowserViewClass: FakeWebContentsView,
    window,
    shell: { openExternal: async (url: string) => { external.push(url); } },
    onStateChange: (state: BrowserStateLike) => states.push(state),
    onCommand: (command: string) => commands.push(command),
  });

  manager.setBounds({ x: 700, y: 180, width: 420, height: 500, visible: true });
  assert.equal(window.contentView.children.size, 1);
  const first = manager.getState().tabs[0];
  assert.ok(first);
  assert.equal(first.url, "");

  manager.navigate(first.id, "https://example.com/path");
  await Promise.resolve();
  assert.equal(manager.getState().tabs[0]?.url, "https://example.com/path");

  const firstView = [...FakeWebContentsView.instances][0];
  assert.ok(firstView);
  assert.equal(firstView.options.webPreferences.sandbox, true);
  assert.equal(firstView.options.webPreferences.contextIsolation, true);
  assert.equal(firstView.options.webPreferences.nodeIntegration, false);
  assert.equal(firstView.options.webPreferences.webSecurity, true);
  let allowed: boolean | undefined;
  firstView.webContents.session.permissionRequestHandler?.(undefined, "camera", (value: boolean) => { allowed = value; });
  assert.equal(allowed, false);

  firstView.webContents.windowOpenHandler?.({ url: "https://open.example/new" });
  await Promise.resolve();
  assert.equal(manager.getState().tabs.length, 2);
  assert.equal(window.contentView.children.size, 1);
  assert.equal(manager.getState().tabs[1]?.url, "https://open.example/new");

  firstView.webContents.emit("before-input-event", { preventDefault() {} }, {
    type: "keyDown", key: "l", control: true,
  });
  assert.deepEqual(commands, ["focus_address"]);

  await manager.openExternal(manager.getState().activeTabId);
  assert.deepEqual(external, ["https://open.example/new"]);
  manager.closeTab(manager.getState().activeTabId);
  assert.equal(manager.getState().tabs.length, 1);
  assert.equal(window.contentView.children.size, 1);
  assert.ok(states.length > 0);
  manager.destroy();
});

interface BrowserStateLike {
  tabs: Array<{ id: string; url: string }>;
  activeTabId: string;
}

interface BrowserManagerLike {
  getState(): BrowserStateLike;
  createTab(url?: string): BrowserStateLike;
  closeTab(id: string): BrowserStateLike;
  navigate(id: string, url: string): BrowserStateLike;
  setBounds(bounds: { x: number; y: number; width: number; height: number; visible: boolean }): void;
  openExternal(id: string): Promise<boolean>;
  destroy(): void;
}

class FakeSession extends EventEmitter {
  permissionRequestHandler: ((contents: unknown, permission: string, callback: (allowed: boolean) => void) => void) | undefined;
  setPermissionCheckHandler(_handler: () => boolean) {}
  setPermissionRequestHandler(handler: FakeSession["permissionRequestHandler"]) {
    this.permissionRequestHandler = handler;
  }
}

class FakeWebContents extends EventEmitter {
  readonly session = sharedSession;
  windowOpenHandler: ((details: { url: string }) => { action: string }) | undefined;
  currentUrl = "about:blank";
  loading = false;
  closed = false;
  setWindowOpenHandler(handler: FakeWebContents["windowOpenHandler"]) { this.windowOpenHandler = handler; }
  async loadURL(url: string) {
    this.loading = true;
    this.emit("did-start-loading");
    this.currentUrl = url;
    this.emit("did-navigate", {}, url);
    this.loading = false;
    this.emit("did-stop-loading");
  }
  canGoBack() { return false; }
  canGoForward() { return false; }
  goBack() {}
  goForward() {}
  reload() { this.emit("did-start-loading"); this.emit("did-stop-loading"); }
  stop() { this.loading = false; this.emit("did-stop-loading"); }
  close() { this.closed = true; }
  isDestroyed() { return this.closed; }
}

const sharedSession = new FakeSession();

class FakeWebContentsView {
  static instances = new Set<FakeWebContentsView>();
  readonly webContents = new FakeWebContents();
  bounds?: { x: number; y: number; width: number; height: number };
  constructor(readonly options: Record<string, any>) { FakeWebContentsView.instances.add(this); }
  setBounds(bounds: { x: number; y: number; width: number; height: number }) { this.bounds = bounds; }
}

class FakeWindow {
  readonly contentView = {
    children: new Set<FakeWebContentsView>(),
    addChildView: (view: FakeWebContentsView) => this.contentView.children.add(view),
    removeChildView: (view: FakeWebContentsView) => this.contentView.children.delete(view),
  };
}
