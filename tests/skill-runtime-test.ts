import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SkillRuntime } from "../src/skills/skill-runtime.js";
import { createReadSkillTool } from "../src/tools/read-skill-tool.js";
import { ScriptedLlmProvider } from "./helpers/scripted-llm.js";

test("创建后热刷新目录和 read_skill，后续 Job 可冻结新目录提示", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "skill-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = await SkillRuntime.create({
    roots: [root],
    writableRoot: root,
  });
  const readSkill = createReadSkillTool(() => runtime.getLoader());
  const beforeJobInstructions = runtime.createCatalogInstructions();

  const result = await runtime.distillThread(
    new ScriptedLlmProvider([{
      id: "response-1",
      text: JSON.stringify({
        name: "runtime-recovery",
        description: "恢复 Runtime 连接，用于桌面端连接中断时。",
        instructions: "# Runtime 恢复\n\n1. 检查服务。\n2. 验证连接与历史恢复。",
      }),
      functionCalls: [],
    }]),
    [
      { role: "user", text: "请整理经过验证、能够重复执行的 Runtime 恢复流程。" },
      { role: "assistant", text: "最终结论：检查服务后验证连接与历史恢复。" },
    ],
  );

  assert.equal(result.status, "created");
  assert.deepEqual(runtime.list(), [{
    name: "runtime-recovery",
    description: "恢复 Runtime 连接，用于桌面端连接中断时。",
  }]);
  const afterJobInstructions = runtime.createCatalogInstructions();
  assert.equal(beforeJobInstructions, "");
  assert.match(afterJobInstructions, /runtime-recovery/u);
  assert.equal(beforeJobInstructions, "");

  const definition = readSkill.definition.parameters as {
    properties: { name: { enum: string[] } };
  };
  assert.deepEqual(definition.properties.name.enum, ["runtime-recovery"]);
  const execution = await readSkill.execute(
    JSON.stringify({ name: "runtime-recovery" }),
    { signal: new AbortController().signal },
  );
  assert.deepEqual(execution.result, {
    name: "runtime-recovery",
    description: "恢复 Runtime 连接，用于桌面端连接中断时。",
    instructions: "# Runtime 恢复\n\n1. 检查服务。\n2. 验证连接与历史恢复。",
  });
});
