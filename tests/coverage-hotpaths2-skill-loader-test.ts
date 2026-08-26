import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SkillLoader } from "../src/skills/skill-loader.js";

async function root(t: test.TestContext): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "coverage-skill-loader-"));
  t.after(() => rm(value, { recursive: true, force: true }));
  return value;
}

async function rawSkill(base: string, name: string, contents: string): Promise<string> {
  const directory = join(base, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), contents);
  return directory;
}

function valid(name: string, description = "description", body = "instructions"): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
}

test("SkillLoader 覆盖根目录、配额、重复项和读取边界", async (t) => {
  const first = await root(t);
  const second = await root(t);
  await writeFile(join(first, "ignored.txt"), "ignored");
  await rawSkill(first, "alpha", valid("alpha"));
  await rawSkill(second, "alpha", valid("alpha"));

  await assert.rejects(() => SkillLoader.create({ roots: [join(first, "missing")] }), /ENOENT/);
  await assert.rejects(() => SkillLoader.create({ roots: [join(first, "ignored.txt")] }), /not a directory/);
  await assert.rejects(() => SkillLoader.create({ roots: [first, second] }), /Duplicate Skill/);
  const projectWins = await SkillLoader.create({ roots: [first, second], duplicatePolicy: "keep_first" });
  assert.equal(projectWins.read("alpha").instructions, "instructions");
  const invalidPersonal = await root(t);
  const invalidDirectory = await rawSkill(invalidPersonal, "legacy", valid("legacy"));
  await writeFile(join(invalidDirectory, "SKILL.md"), Buffer.from([0xff, 0xfe]));
  const tolerant = await SkillLoader.create({ roots: [first, invalidPersonal], tolerateInvalidRoots: [invalidPersonal] });
  assert.deepEqual(tolerant.list().map((item) => item.name), ["alpha"]);
  const legacy = await root(t);
  const legacyDirectory = join(legacy, "legacy-gbk");
  await mkdir(legacyDirectory);
  await writeFile(join(legacyDirectory, "SKILL.md"), Buffer.concat([
    Buffer.from("---\nname: legacy-gbk\ndescription: "),
    Buffer.from([0xcb, 0xb5, 0xc3, 0xf7]),
    Buffer.from("\n---\nbody\n"),
  ]));
  assert.equal((await SkillLoader.create({ roots: [legacy], legacyEncodingRoots: [legacy] })).read("legacy-gbk").description, "说明");
  await assert.rejects(() => SkillLoader.create({ roots: [first], maxSkills: 0 }), /positive integer/);
  await assert.rejects(() => SkillLoader.create({ roots: [first], maxSkillBytes: 1.5 }), /positive integer/);
  await assert.rejects(() => SkillLoader.create({ roots: [first], maxSkills: 0 / 0 }), /positive integer/);

  const duplicateRoot = await SkillLoader.create({ roots: [first, first] });
  assert.deepEqual(duplicateRoot.read("alpha"), {
    name: "alpha", description: "description", instructions: "instructions",
  });
  assert.throws(() => duplicateRoot.read("missing"), /Unknown Skill/);

  await rawSkill(first, "beta", valid("beta"));
  await assert.rejects(() => SkillLoader.create({ roots: [first], maxSkills: 1 }), /count exceeds 1/);
});

test("SkillLoader 拒绝 SKILL.md 文件与字节编码异常", async (t) => {
  const oversized = await root(t);
  await rawSkill(oversized, "large", valid("large", "desc", "0123456789"));
  await assert.rejects(() => SkillLoader.create({ roots: [oversized], maxSkillBytes: 10 }), /byte limit/);

  const nul = await root(t);
  const nulDirectory = await rawSkill(nul, "nul", valid("nul"));
  await writeFile(join(nulDirectory, "SKILL.md"), Buffer.from([45, 45, 45, 10, 0]));
  await assert.rejects(() => SkillLoader.create({ roots: [nul] }), /UTF-8 text/);

  const utf8 = await root(t);
  const utf8Directory = await rawSkill(utf8, "utf", valid("utf"));
  await writeFile(join(utf8Directory, "SKILL.md"), Buffer.from([0xff, 0xfe, 0xfd]));
  await assert.rejects(() => SkillLoader.create({ roots: [utf8] }), /UTF-8 text/);

  const directoryAsFile = await root(t);
  const skillDirectory = join(directoryAsFile, "dir-file");
  await mkdir(join(skillDirectory, "SKILL.md"), { recursive: true });
  await assert.rejects(() => SkillLoader.create({ roots: [directoryAsFile] }), /not a file/);

  const missingDocument = await root(t);
  await mkdir(join(missingDocument, "empty"));
  assert.deepEqual((await SkillLoader.create({ roots: [missingDocument] })).list(), []);
});

test("SkillLoader 严格校验 frontmatter 的结构、引号与正文", async (t) => {
  const cases: Array<[string, string, RegExp]> = [
    ["no-frontmatter", "name: no-frontmatter\n", /must start/],
    ["unclosed", "---\nname: unclosed\n", /not closed/],
    ["bad-line", "---\nname: bad-line\n!bad\n---\nbody", /Invalid .* line/],
    ["duplicate", "---\nname: duplicate\nname: duplicate\ndescription: x\n---\nbody", /Duplicate .* field/],
    ["bad_name", "---\nname: bad_name\ndescription: x\n---\nbody", /Invalid Skill name/],
    ["missing-description", "---\nname: missing-description\n---\nbody", /description is missing/],
    ["empty-body", "---\nname: empty-body\ndescription: x\n---\n   ", /instructions are empty/],
  ];
  for (const [name, contents, expected] of cases) {
    const base = await root(t);
    await rawSkill(base, name, contents);
    await assert.rejects(() => SkillLoader.create({ roots: [base] }), expected);
  }

  const quoted = await root(t);
  await rawSkill(quoted, "quoted", [
    "---", "# comment", "", "name: 'quoted'", "description: \"quoted description\"", "unknown: retained", "---", "body", "",
  ].join("\r\n"));
  assert.deepEqual((await SkillLoader.create({ roots: [quoted] })).read("quoted"), {
    name: "quoted", description: "quoted description", instructions: "body",
  });

  const longDescription = await root(t);
  await rawSkill(longDescription, "long-description", valid("long-description", "x".repeat(501)));
  await assert.rejects(() => SkillLoader.create({ roots: [longDescription] }), /too long/);
});

test("SkillLoader 拒绝 SKILL.md 符号链接越出根目录", async (t) => {
  const base = await root(t);
  const outside = await root(t);
  const directory = join(base, "linked-file");
  await mkdir(directory);
  const external = join(outside, "SKILL.md");
  await writeFile(external, valid("linked-file"));
  try {
    await symlink(external, join(directory, "SKILL.md"), "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("当前 Windows 未授予文件符号链接权限");
      return;
    }
    throw error;
  }
  await assert.rejects(() => SkillLoader.create({ roots: [base] }), /SKILL.md escapes Skill root/);
});
