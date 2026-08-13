import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  writeDistilledSkill,
} from "../src/skills/skill-writer.js";
import { SkillLoader } from "../src/skills/skill-loader.js";

const baseDraft = {
  name: "resolve-runtime-connection",
  description: "处理 Runtime 连接问题，用于桌面端无法恢复连接时。",
  instructions: "# Runtime 连接\n\n1. 检查服务状态。\n2. 验证连接恢复。",
};

test("原子写入后可由 SkillLoader 重新加载", async (t) => {
  const root = await createTempDirectory(t);
  const result = await writeDistilledSkill(root, baseDraft);

  assert.deepEqual(result, {
    status: "created",
    skill: {
      name: baseDraft.name,
      description: baseDraft.description,
    },
  });
  const loader = await SkillLoader.create({ roots: [root] });
  assert.deepEqual(loader.read(baseDraft.name), baseDraft);
  assert.deepEqual(await readdir(root), [baseDraft.name]);
});

test("同名同内容幂等，同名不同内容使用后缀且绝不覆盖", async (t) => {
  const root = await createTempDirectory(t);
  const [first, concurrentDuplicate] = await Promise.all([
    writeDistilledSkill(root, baseDraft),
    writeDistilledSkill(root, baseDraft),
  ]);

  assert.deepEqual(
    [first.status, concurrentDuplicate.status].sort(),
    ["already_exists", "created"],
  );

  const changed = {
    ...baseDraft,
    instructions: "# Runtime 连接\n\n执行另一套已经验证的恢复流程。",
  };
  const second = await writeDistilledSkill(root, changed);
  const duplicateSecond = await writeDistilledSkill(root, changed);

  assert.equal(second.status, "created");
  assert.equal(second.skill.name, `${baseDraft.name}-2`);
  assert.equal(duplicateSecond.status, "already_exists");
  assert.equal(duplicateSecond.skill.name, `${baseDraft.name}-2`);

  const loader = await SkillLoader.create({ roots: [root] });
  assert.equal(loader.read(baseDraft.name).instructions, baseDraft.instructions);
  assert.equal(loader.read(`${baseDraft.name}-2`).instructions, changed.instructions);
});

test("独立拒绝路径逃逸和写入前敏感内容，失败不留临时目录", async (t) => {
  const root = await createTempDirectory(t);

  await assert.rejects(
    () => writeDistilledSkill(root, { ...baseDraft, name: "../escape" }),
    /合规/u,
  );
  await assert.rejects(
    () => writeDistilledSkill(root, {
      ...baseDraft,
      instructions: "使用 Authorization: Bearer abcdefghijklmnopqrstuvwxyz 完成操作。",
    }),
    /安全检查/u,
  );
  assert.deepEqual(await readdir(root), []);
});

test("拒绝通过已有符号链接目标逃逸且不改写外部文件", async (t) => {
  const root = await createTempDirectory(t);
  const outside = await createTempDirectory(t);
  const outsideFile = join(outside, "sentinel.txt");
  await writeFile(outsideFile, "untouched", "utf8");
  await symlink(
    outside,
    join(root, baseDraft.name),
    process.platform === "win32" ? "junction" : "dir",
  );

  await assert.rejects(
    () => writeDistilledSkill(root, baseDraft),
    /symbolic link/u,
  );
  assert.equal(await readFile(outsideFile, "utf8"), "untouched");
  assert.deepEqual(await readdir(outside), ["sentinel.txt"]);
});

test("64 字符名称发生冲突时截短基础名并追加数字后缀", async (t) => {
  const root = await createTempDirectory(t);
  const longName = "a".repeat(64);
  await writeDistilledSkill(root, { ...baseDraft, name: longName });
  const result = await writeDistilledSkill(root, {
    ...baseDraft,
    name: longName,
    instructions: "# 另一流程\n\n执行另一套已确认流程。",
  });

  assert.equal(result.status, "created");
  assert.equal(result.skill.name.length, 64);
  assert.match(result.skill.name, /-2$/u);
  const loader = await SkillLoader.create({ roots: [root] });
  assert.equal(loader.list().length, 2);
});

test("拒绝把 Skills 根目录本身配置为符号链接", async (t) => {
  const parent = await createTempDirectory(t);
  const outside = await createTempDirectory(t);
  const linkedRoot = join(parent, "linked-skills");
  await symlink(
    outside,
    linkedRoot,
    process.platform === "win32" ? "junction" : "dir",
  );

  await assert.rejects(
    () => writeDistilledSkill(linkedRoot, baseDraft),
    /root must not be a symbolic link/u,
  );
  assert.deepEqual(await readdir(outside), []);
});

async function createTempDirectory(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "skill-writer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
