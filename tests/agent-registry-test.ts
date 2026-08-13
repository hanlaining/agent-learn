import assert from "node:assert/strict";
import test from "node:test";

import { AgentRegistry } from "../src/agents/agent-registry.js";

test("旧持久化角色不能覆盖内置角色且会自动补齐新版角色", () => {
  const registry = new AgentRegistry([{
    id: "investigator",
    name: "旧排查角色",
    description: "legacy",
    instructions: "legacy",
    defaultModel: "legacy-model",
    reasoningEffort: "low",
    allowedTools: ["*"],
    allowedSkills: ["*"],
  }, {
    id: "custom-auditor",
    name: "自定义审计",
    description: "custom",
    instructions: "custom",
    defaultModel: "gpt-5.6-terra",
    reasoningEffort: "medium",
    allowedTools: ["read_file"],
    allowedSkills: [],
  }]);

  assert.equal(registry.require("reviewer").name, "审查 Agent");
  assert.equal(registry.require("researcher").name, "资料 Agent");
  assert.equal(registry.require("investigator").name, "排查 Agent");
  assert.notDeepEqual(registry.require("investigator").allowedTools, ["*"]);
  assert.equal(registry.require("custom-auditor").name, "自定义审计");
});

test("角色一致性校验会在 Job 执行前报告缺失角色", () => {
  const registry = new AgentRegistry();
  assert.doesNotThrow(() => registry.requireAll([
    "investigator", "researcher", "coder", "tester", "reviewer",
  ]));
  assert.throws(() => registry.requireAll(["missing-profile"]), /Unknown agent profile/);
});
