import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { PreviewServer } = require("../src/electron/preview-server.cjs") as {
  PreviewServer: new (rootPath: string) => {
    getStatus(): { state: "stopped" } | { state: "running"; url: string };
    start(): Promise<{ state: "running"; url: string }>;
    stop(): Promise<{ state: "stopped" }>;
  };
};

test("预览服务只绑定本机动态端口，重复启动幂等，停止后释放服务", async () => {
  const root = await mkdtemp(join(tmpdir(), "god-agent-preview-"));
  await writeFile(join(root, "index.html"), "<!doctype html><title>preview</title>", "utf8");
  const server = new PreviewServer(root);
  try {
    const [first, second] = await Promise.all([server.start(), server.start()]);
    assert.match(first.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal(second.url, first.url);
    assert.equal((await fetch(first.url)).status, 200);
    assert.equal((await server.stop()).state, "stopped");
    await assert.rejects(fetch(first.url));
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("预览服务拒绝目录遍历，且允许 Electron 受限 iframe 嵌入", async () => {
  const parent = await mkdtemp(join(tmpdir(), "god-agent-preview-security-"));
  const root = join(parent, "site");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(root);
  await writeFile(join(root, "index.html"), "safe", "utf8");
  await writeFile(join(parent, "secret.txt"), "secret", "utf8");
  const server = new PreviewServer(root);
  try {
    const status = await server.start();
    const escaped = await fetch(`${status.url}%2e%2e%2fsecret.txt`);
    assert.equal(escaped.status, 403);
    const response = await fetch(status.url);
    assert.doesNotMatch(response.headers.get("content-security-policy") ?? "", /frame-ancestors/);
    assert.equal(await response.text(), "safe");
  } finally {
    await server.stop();
    await rm(parent, { recursive: true, force: true });
  }
});

test("今日运势签通过受限本地服务作为真实浏览器标签打开", async () => {
  const app = await readFile(resolve("src/electron/renderer/App.tsx"), "utf8");
  const preload = await readFile(resolve("src/electron/preload.cjs"), "utf8");
  const browserManager = await readFile(resolve("src/electron/browser-manager.cjs"), "utf8");
  const html = await readFile(resolve("examples/today-fortune/index.html"), "utf8");
  const script = await readFile(resolve("examples/today-fortune/app.js"), "utf8");
  const styles = await readFile(resolve("examples/today-fortune/styles.css"), "utf8");

  assert.match(preload, /\^http:\\\/\\\/127\\\.0\\\.0\\\.1:\\d\+\\\/\$/);
  assert.match(app, /setInspectorTab\("browser"\)/);
  assert.match(app, /browser\.createTab\(status\.url\)/);
  assert.match(app, /在新标签打开今日运势签/);
  assert.doesNotMatch(app, /<iframe/);
  assert.match(browserManager, /nodeIntegration: false/);
  assert.match(browserManager, /sandbox: true/);
  assert.match(html, /今日运势签/);
  assert.match(html, /value="事业"/);
  assert.match(html, /value="感情"/);
  assert.match(html, /value="财运"/);
  assert.equal((script.match(/上签:/g) ?? []).length, 3);
  assert.equal((script.match(/中签:/g) ?? []).length, 3);
  assert.equal((script.match(/下签:/g) ?? []).length, 3);
  assert.match(script, /setTimeout\([\s\S]*?, 1000\)/);
  assert.doesNotMatch(script, /localStorage|sessionStorage|indexedDB|document\.cookie/);
  assert.match(styles, /overflow-x:hidden/);
  assert.match(styles, /@media\(max-width:430px\)/);
  assert.doesNotMatch(styles, /#(?:f00|ff0000|dc2626)|\bred\b/i);
});
