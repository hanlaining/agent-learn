import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("Preload 仅暴露结构化发送与文件搜索白名单并清洗返回值", async () => {
  const source = await readFile("src/electron/preload.cjs", "utf8");
  const invocations: Array<{ channel: string; args: unknown[] }> = [];
  let exposed: unknown;
  const ipcRenderer = {
    invoke: async (channel: string, ...args: unknown[]) => {
      invocations.push({ channel, args });
      if (channel === "desktop:send-message") return { ok: true, value: { turnId: "turn-1" } };
      if (channel === "desktop:search-workspace-files") {
        return { ok: true, value: { query: "app", paths: ["src/app.ts", ...Array.from({ length: 25 }, (_, index) => `src/${index}.ts`)], truncated: true } };
      }
      return { ok: true, value: undefined };
    },
    on() {},
    removeListener() {},
  };
  vm.runInNewContext(source, {
    require: (name: string) => {
      assert.equal(name, "electron");
      return {
        contextBridge: { exposeInMainWorld: (_name: string, value: unknown) => { exposed = value; } },
        ipcRenderer,
      };
    },
    URL,
    structuredClone,
  }, { filename: "preload.cjs" });

  const api = exposed as {
    desktop: {
      sendMessage(input: unknown): Promise<{ turnId: string }>;
      searchWorkspaceFiles(query: string): Promise<{ paths: string[]; truncated: boolean }>;
    };
  };
  const sent = await api.desktop.sendMessage({
    text: "检查 @src/app.ts",
    mentions: [{ kind: "file", path: "src/app.ts" }],
    explicitSkills: ["code-review"],
  });
  assert.equal(sent.turnId, "turn-1");
  assert.equal(invocations[0]?.channel, "desktop:send-message");
  assert.equal(JSON.stringify(invocations[0]?.args), JSON.stringify([{
    text: "检查 @src/app.ts",
    mentions: [{ kind: "file", path: "src/app.ts" }],
    explicitSkills: ["code-review"],
  }]));
  const search = await api.desktop.searchWorkspaceFiles("app");
  assert.equal(search.paths.length, 20);
  assert.equal(search.truncated, true);
  assert.equal(invocations[1]?.channel, "desktop:search-workspace-files");
});

test("Preload 在 IPC 前拒绝未知字段、空文本、超长文本和非法上下文", async () => {
  const { api, invocations } = await loadPreloadForRejectionTests();
  const invalidValues: unknown[] = [
    "plain text",
    { text: " " },
    { text: "x".repeat(32_001) },
    { text: "ok", unknown: true },
    { text: "ok", mentions: [{ kind: "file", path: "" }] },
    { text: "ok", mentions: [{ kind: "file", path: "safe.ts\n" }] },
    { text: "ok", mentions: Array.from({ length: 21 }, () => ({ kind: "file", path: "safe.ts" })) },
    { text: "ok", explicitSkills: ["Invalid Skill"] },
    { text: "ok", explicitSkills: Array.from({ length: 21 }, () => "code-review") },
  ];
  for (const value of invalidValues) await assert.rejects(() => api.desktop.sendMessage(value));
  await assert.rejects(() => api.desktop.searchWorkspaceFiles("x".repeat(241)), /short string/);
  assert.deepEqual(invocations, []);
});

test("Main IPC 自己拒绝非法发送和非法搜索，不调用 DesktopController", async () => {
  const source = await readFile("src/electron/main.cjs", "utf8");
  const handlers = new Map<string, (_event: unknown, value: unknown) => Promise<unknown>>();
  const inertPromise = { then() { return this; }, catch() { return this; } };
  vm.runInNewContext(source, {
    require: (name: string) => {
      if (name === "electron") return {
        app: { getAppPath: () => "D:/app", on() {}, whenReady: () => inertPromise },
        BrowserWindow: class {},
        WebContentsView: class {},
        ipcMain: {
          handle: (channel: string, handler: (_event: unknown, value: unknown) => Promise<unknown>) => handlers.set(channel, handler),
          on() {},
        },
        shell: {},
      };
      if (name === "node:path") return { join: (...parts: string[]) => parts.join("/") };
      if (name === "./preview-server.cjs") return { PreviewServer: class {} };
      if (name === "./browser-manager.cjs") return { BrowserManager: class {} };
      return undefined;
    },
    __dirname: "D:/app",
    process: { env: {}, execPath: "node", stderr: { write() {} } },
  }, { filename: "main.cjs" });

  const send = handlers.get("desktop:send-message")!;
  const search = handlers.get("desktop:search-workspace-files")!;
  for (const invalid of [
    "text", { text: "" }, { text: "x".repeat(32_001) }, { text: "ok", extra: 1 },
    { text: "ok", mentions: [{ kind: "file", path: "bad\npath" }] },
    { text: "ok", explicitSkills: ["Bad Skill"] },
  ]) {
    const result = await send(undefined, invalid) as { ok: boolean };
    assert.equal(result.ok, false);
  }
  const result = await search(undefined, "x".repeat(241)) as { ok: boolean };
  assert.equal(result.ok, false);
});

async function loadPreloadForRejectionTests(): Promise<{
  api: { desktop: { sendMessage(value: unknown): Promise<unknown>; searchWorkspaceFiles(query: string): Promise<unknown> } };
  invocations: unknown[];
}> {
  const source = await readFile("src/electron/preload.cjs", "utf8");
  const invocations: unknown[] = [];
  let exposed: unknown;
  vm.runInNewContext(source, {
    require: () => ({
      contextBridge: { exposeInMainWorld: (_name: string, value: unknown) => { exposed = value; } },
      ipcRenderer: { invoke: async (...args: unknown[]) => { invocations.push(args); return { ok: true, value: {} }; }, on() {}, removeListener() {} },
    }),
    URL,
    structuredClone,
  }, { filename: "preload.cjs" });
  return { api: exposed as never, invocations };
}
