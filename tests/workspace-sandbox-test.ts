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
