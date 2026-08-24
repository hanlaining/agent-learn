import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, {
  type TestContext,
} from "node:test";

import {
  WorkspaceSandbox,
} from "../src/sandbox/workspace-sandbox.js";
import {
  assertWorkspacePathWithinTaskScope,
  createWorkspaceTools,
} from "../src/tools/workspace-tools.js";
import {
  ToolRegistry,
} from "../src/tools/tool-registry.js";

async function createRegistry(t: TestContext) {
  const workspace = await mkdtemp(
    join(tmpdir(), "agent-workspace-tools-"),
  );
  t.after(() => rm(workspace, {
    recursive: true,
    force: true,
  }));
  await writeFile(
    join(workspace, "README.md"),
    "Workspace guide",
    "utf8",
  );
  const sandbox = await WorkspaceSandbox.create(workspace);

  return new ToolRegistry(createWorkspaceTools(sandbox));
}

test("read_file 通过 Sandbox 读取文本", async (t) => {
  const registry = await createRegistry(t);

  const execution = await registry.execute(
    "read_file",
    '{"path":"README.md"}',
  );

  assert.deepEqual(execution.result, {
    path: "README.md",
    text: "Workspace guide",
    sizeBytes: 15,
  });
  assert.equal(
    execution.output,
    '{"path":"README.md","text":"Workspace guide","sizeBytes":15}',
  );
});

test("list_files 返回受数量限制的目录结果", async (t) => {
  const registry = await createRegistry(t);
  const definition = registry.getDefinitions().find(
    (candidate) => candidate.name === "list_files",
  );

  assert.deepEqual(definition?.parameters.required, ["path"]);

  const execution = await registry.execute(
    "list_files",
    '{"path":"."}',
  );

  assert.deepEqual(execution.result, {
    path: ".",
    entries: [
      {
        path: "README.md",
        type: "file",
      },
    ],
    truncated: false,
  });
});

test("read_file 不能绕过 Workspace 边界", async (t) => {
  const registry = await createRegistry(t);

  await assert.rejects(
    () => registry.execute(
      "read_file",
      '{"path":"../secret.txt"}',
    ),
    /Path escapes workspace/,
  );
});

test("Workspace Tool 拒绝非法 JSON 参数", async (t) => {
  const registry = await createRegistry(t);

  await assert.rejects(
    () => registry.execute("read_file", "not-json"),
    /read_file arguments must be valid JSON/,
  );
});

test("write_file 只能在 Workspace 内写入 UTF-8 文本", async (t) => {
  const registry = await createRegistry(t);
  const execution = await registry.execute("write_file", JSON.stringify({ path: "result.txt", text: "done" }));
  assert.deepEqual(execution.result, { path: "result.txt", sizeBytes: 4 });
  assert.deepEqual((await registry.execute("read_file", '{"path":"result.txt"}')).result, {
    path: "result.txt", text: "done", sizeBytes: 4,
  });
  await assert.rejects(() => registry.execute("write_file", JSON.stringify({ path: "../outside.txt", text: "no" })), /Path escapes workspace/);
});

test("v3 Task 文件边界在 write_file 真正执行前拒绝越界路径", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "agent-v3-boundary-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const sandbox = await WorkspaceSandbox.create(workspace);
  await mkdir(join(workspace, "src", "electron"), { recursive: true });
  const scopes = new Map<string, { allowedPaths: string[]; deniedPaths: string[] }>([
    ["front-turn", { allowedPaths: ["src/electron"], deniedPaths: ["src/app-server"] }],
    ["back-turn", { allowedPaths: ["src/app-server"], deniedPaths: ["src/electron"] }],
    ["integration-turn", { allowedPaths: ["tests"], deniedPaths: ["src/electron", "src/app-server"] }],
  ]);
  const registry = new ToolRegistry(createWorkspaceTools(sandbox, { authorizeWrite: ({ turnId, path }) => {
    const scope = turnId === undefined ? undefined : scopes.get(turnId);
    if (scope === undefined) throw new Error("Task scope unavailable");
    assertWorkspacePathWithinTaskScope(path, scope);
  } }));
  await registry.execute("write_file", JSON.stringify({ path: "src/electron/App.tsx", text: "ok" }), undefined, "front-turn");
  await assert.rejects(() => registry.execute("write_file", JSON.stringify({ path: "src/app-server/main.ts", text: "no" }), undefined, "front-turn"), /file boundary rejected/);
  await assert.rejects(() => registry.execute("write_file", JSON.stringify({ path: "src/electron/../app-server/main.ts", text: "no" }), undefined, "front-turn"), /non-canonical path/);
  await assert.rejects(() => registry.execute("write_file", JSON.stringify({ path: "src\\electron\\..\\app-server\\main.ts", text: "no" }), undefined, "front-turn"), /non-canonical path/);
  await assert.rejects(() => registry.execute("write_file", JSON.stringify({ path: "src/electron/./App.tsx", text: "no" }), undefined, "front-turn"), /non-canonical path/);
  await registry.execute("write_file", JSON.stringify({ path: "src//electron//Nested.tsx", text: "ok" }), undefined, "front-turn");
  await assert.rejects(() => registry.execute("write_file", JSON.stringify({ path: "src/electron/App.tsx", text: "no" }), undefined, "back-turn"), /file boundary rejected/);
  await assert.rejects(() => registry.execute("write_file", JSON.stringify({ path: "src/app-server/main.ts", text: "no" }), undefined, "integration-turn"), /file boundary rejected/);
});
