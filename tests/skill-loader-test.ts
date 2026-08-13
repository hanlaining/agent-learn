import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SkillLoader,
} from "../src/skills/skill-loader.js";

test("发现 Skill 目录并按需读取完整说明", async (t) => {
  const root = await createTempDirectory(t);
  await writeSkill(
    root,
    "finance-analysis",
    "分析确定性金融数据",
    "必须调用金融 Tool。",
  );
  await writeSkill(
    root,
    "code-review",
    "检查代码风险",
    "先读取改动，再给出结论。",
  );

  const loader = await SkillLoader.create({ roots: [root] });

  assert.deepEqual(loader.list(), [
    { name: "code-review", description: "检查代码风险" },
    { name: "finance-analysis", description: "分析确定性金融数据" },
  ]);
  assert.deepEqual(loader.read("finance-analysis"), {
    name: "finance-analysis",
    description: "分析确定性金融数据",
    instructions: "必须调用金融 Tool。",
  });
  assert.match(loader.createCatalogInstructions(), /read_skill/);
  assert.doesNotMatch(
    loader.createCatalogInstructions(),
    /必须调用金融 Tool/,
  );
});

test("允许配置一个尚不存在的可选 Skill 根目录", async (t) => {
  const root = await createTempDirectory(t);
  const loader = await SkillLoader.create({
    roots: [join(root, "missing")],
    allowMissingRoots: true,
  });

  assert.deepEqual(loader.list(), []);
  assert.equal(loader.createCatalogInstructions(), "");
});

test("拒绝目录名与 Skill name 不一致", async (t) => {
  const root = await createTempDirectory(t);
  await writeSkill(
    root,
    "finance-analysis",
    "分析金融数据",
    "说明",
    "another-name",
  );

  await assert.rejects(
    () => SkillLoader.create({ roots: [root] }),
    /Skill name must match directory/,
  );
});

test("拒绝通过目录链接逃出 Skill 根目录", async (t) => {
  const root = await createTempDirectory(t);
  const outside = await createTempDirectory(t);
  await writeSkill(
    outside,
    "outside-skill",
    "外部 Skill",
    "不能读取。",
  );
  const target = join(outside, "outside-skill");
  const link = join(root, "outside-skill");

  await symlink(
    target,
    link,
    process.platform === "win32" ? "junction" : "dir",
  );

  await assert.rejects(
    () => SkillLoader.create({ roots: [root] }),
    /escapes Skill root/,
  );
});

async function createTempDirectory(
  t: test.TestContext,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "skill-loader-"));

  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writeSkill(
  root: string,
  directoryName: string,
  description: string,
  instructions: string,
  metadataName = directoryName,
): Promise<void> {
  const directory = join(root, directoryName);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    [
      "---",
      `name: ${metadataName}`,
      `description: ${description}`,
      "---",
      "",
      instructions,
      "",
    ].join("\n"),
    "utf8",
  );
}
