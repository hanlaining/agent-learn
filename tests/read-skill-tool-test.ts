import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SkillLoader,
} from "../src/skills/skill-loader.js";
import {
  createReadSkillTool,
} from "../src/tools/read-skill-tool.js";
import {
  ToolRegistry,
} from "../src/tools/tool-registry.js";

test("read_skill 只按已发现名称返回完整说明", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "read-skill-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skillDirectory = join(root, "finance-analysis");
  await mkdir(skillDirectory);
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    [
      "---",
      "name: finance-analysis",
      "description: 分析金融数据",
      "---",
      "",
      "金额必须来自确定性 Tool。",
    ].join("\n"),
    "utf8",
  );
  const loader = await SkillLoader.create({ roots: [root] });
  const tool = createReadSkillTool(loader);
  const registry = new ToolRegistry([tool]);

  assert.equal(tool.requiresPermission, false);
  assert.deepEqual(
    tool.definition.parameters.properties,
    {
      name: {
        type: "string",
        enum: ["finance-analysis"],
        description: "要读取的 Skill 名称。",
      },
    },
  );

  const execution = await registry.execute(
    "read_skill",
    '{"name":"finance-analysis"}',
  );

  assert.match(execution.output, /确定性 Tool/);
  await assert.rejects(
    () => registry.execute(
      "read_skill",
      '{"name":"unknown"}',
    ),
    /Unknown Skill/,
  );
});
