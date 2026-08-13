import assert from "node:assert/strict";
import {
  mkdtemp,
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
