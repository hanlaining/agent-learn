import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  WorkspaceSandbox,
} from "../src/sandbox/workspace-sandbox.js";

test("搜索文件只返回工作区内的普通文件并忽略敏感与构建目录", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  await mkdir(join(fixture.workspace, "node_modules", "demo"), { recursive: true });
  await writeFile(join(fixture.workspace, "node_modules", "demo", "index.ts"), "ignored", "utf8");
  await writeFile(join(fixture.workspace, ".env.local"), "SECRET=value", "utf8");
  await symlink(fixture.outside, join(fixture.workspace, "outside-link"), "junction");
  const sandbox = await WorkspaceSandbox.create(fixture.workspace);

  const result = await sandbox.searchFiles("read", { maxResults: 10 });
  assert.deepEqual(result.paths, ["docs/README.md"]);
  assert.equal(result.truncated, false);
  assert.deepEqual(await sandbox.searchFiles("", { maxResults: 1 }), {
    query: "", paths: ["docs/README.md"], truncated: false,
  });
  await assert.rejects(() => sandbox.validateFilePath(".env.local"), /Sensitive/);
  await assert.rejects(() => sandbox.validateFilePath("node_modules/demo/index.ts"), /Sensitive/);
  assert.equal(await sandbox.validateFilePath("docs/README.md"), "docs/README.md");
});

test("文件搜索限制结果、深度、控制字符并规范化 Windows 查询", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  await mkdir(join(fixture.workspace, "a", "b", "c"), { recursive: true });
  await writeFile(join(fixture.workspace, "a", "one.ts"), "1", "utf8");
  await writeFile(join(fixture.workspace, "a", "two.ts"), "2", "utf8");
  await writeFile(join(fixture.workspace, "a", "b", "c", "deep.ts"), "3", "utf8");
  const sandbox = await WorkspaceSandbox.create(fixture.workspace);

  assert.deepEqual((await sandbox.searchFiles("a\\one", { maxResults: 10 })).paths, ["a/one.ts"]);
  assert.deepEqual(await sandbox.searchFiles(".ts", { maxResults: 1 }), {
    query: ".ts", paths: ["a/b/c/deep.ts"], truncated: true,
  });
  assert.deepEqual((await sandbox.searchFiles("deep", { maxResults: 10, maxDepth: 2 })).paths, []);
  await assert.rejects(() => sandbox.searchFiles("bad\nquery"), /Invalid/);
  await assert.rejects(() => sandbox.searchFiles("x".repeat(241)), /Invalid/);
  await assert.rejects(() => sandbox.searchFiles("ok", { maxResults: 0 }), /positive/);
});

async function createFixture() {
  const parent = await mkdtemp(
    join(tmpdir(), "agent-sandbox-"),
  );
  const workspace = join(parent, "workspace");
  const outside = join(parent, "outside");

  await mkdir(join(workspace, "docs"), {
    recursive: true,
  });
  await mkdir(outside);
  await writeFile(
    join(workspace, "docs", "README.md"),
    "# Demo Workspace\n",
    "utf8",
  );
  await writeFile(
    join(outside, "secret.txt"),
    "outside secret",
    "utf8",
  );

  return {
    parent,
    workspace,
    outside,
  };
}

test("读取 Workspace 内文本并返回规范化相对路径", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.parent, {
    recursive: true,
    force: true,
  }));
  const sandbox = await WorkspaceSandbox.create(
    fixture.workspace,
  );

  const result = await sandbox.readTextFile(
    "docs\\README.md",
  );

  assert.deepEqual(result, {
    path: "docs/README.md",
    text: "# Demo Workspace\n",
    sizeBytes: 17,
  });
});

test("拒绝通过 .. 读取 Workspace 外文件", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.parent, {
    recursive: true,
    force: true,
  }));
  const sandbox = await WorkspaceSandbox.create(
    fixture.workspace,
  );

  await assert.rejects(
    () => sandbox.readTextFile("../outside/secret.txt"),
    /Path escapes workspace/,
  );
});

test("拒绝跟随指向 Workspace 外的目录链接", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.parent, {
    recursive: true,
    force: true,
  }));
  await symlink(
    fixture.outside,
    join(fixture.workspace, "outside-link"),
    "junction",
  );
  const sandbox = await WorkspaceSandbox.create(
    fixture.workspace,
  );

  await assert.rejects(
    () => sandbox.readTextFile(
      "outside-link/secret.txt",
    ),
    /Path escapes workspace through symbolic link/,
  );
});

test("拒绝超过大小限制的文件和二进制文件", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.parent, {
    recursive: true,
    force: true,
  }));
  await writeFile(
    join(fixture.workspace, "large.txt"),
    "12345",
    "utf8",
  );
  await writeFile(
    join(fixture.workspace, "binary.bin"),
    Buffer.from([65, 0, 66]),
  );
  const sandbox = await WorkspaceSandbox.create(
    fixture.workspace,
    { maxFileBytes: 4 },
  );

  await assert.rejects(
    () => sandbox.readTextFile("large.txt"),
    /File exceeds 4 byte limit/,
  );

  const binarySandbox = await WorkspaceSandbox.create(
    fixture.workspace,
  );
  await assert.rejects(
    () => binarySandbox.readTextFile("binary.bin"),
    /Binary file is not allowed/,
  );
});

test("列出目录时限制返回数量", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.parent, {
    recursive: true,
    force: true,
  }));
  await writeFile(
    join(fixture.workspace, "a.txt"),
    "a",
    "utf8",
  );
  await writeFile(
    join(fixture.workspace, "b.txt"),
    "b",
    "utf8",
  );
  const sandbox = await WorkspaceSandbox.create(
    fixture.workspace,
    { maxListEntries: 2 },
  );

  const result = await sandbox.listFiles(".");

  assert.equal(result.entries.length, 2);
  assert.equal(result.truncated, true);
  assert.deepEqual(
    result.entries.map((entry) => entry.path),
    ["a.txt", "b.txt"],
  );
});

test("Sandbox 构造与文件/目录边界全部 fail closed", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  const plainFile = join(fixture.parent, "plain.txt");
  await writeFile(plainFile, "plain", "utf8");
  await assert.rejects(() => WorkspaceSandbox.create(plainFile), /Workspace must be a directory/);
  await assert.rejects(() => WorkspaceSandbox.create(fixture.workspace, { maxFileBytes: 0 }), /maxFileBytes must be a positive integer/);
  await assert.rejects(() => WorkspaceSandbox.create(fixture.workspace, { maxListEntries: -1 }), /maxListEntries must be a positive integer/);

  const sandbox = await WorkspaceSandbox.create(fixture.workspace);
  await assert.rejects(() => sandbox.readTextFile("docs"), /Sandbox path is not a file/);
  await assert.rejects(() => sandbox.listFiles("docs/README.md"), /Sandbox path is not a directory/);
  await assert.rejects(() => sandbox.readTextFile(""), /Path escapes workspace/);
  await assert.rejects(() => sandbox.readTextFile(plainFile), /Path escapes workspace/);
});

test("目录列表保留工作区内链接并静默排除越界链接", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.parent, { recursive: true, force: true }));
  await symlink(join(fixture.workspace, "docs"), join(fixture.workspace, "docs-link"), "junction");
  await symlink(fixture.outside, join(fixture.workspace, "outside-link"), "junction");
  const sandbox = await WorkspaceSandbox.create(fixture.workspace);
  const listed = await sandbox.listFiles(".");
  assert.equal(listed.entries.some((entry) => entry.path === "docs-link" && entry.type === "symbolic_link"), true);
  assert.equal(listed.entries.some((entry) => entry.path === "outside-link"), false);
});
