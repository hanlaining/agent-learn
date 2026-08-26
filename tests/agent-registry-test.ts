import assert from "node:assert/strict";
import test from "node:test";

import { AgentRegistry } from "../src/agents/agent-registry.js";
import { coordinationStatusLabel, deriveAttentionLevel, failureOriginForCode, safeFailureMessage } from "../src/agents/agent-presentation.js";

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

test("Agent 展示层完整映射失败来源、安全文案和注意级别", () => {
  for (const [code, origin] of [["provider_timeout", "provider"], ["tool_execution_failed", "tool"], ["stage_contract_failed", "contract"]] as const) {
    assert.equal(failureOriginForCode(code), origin);
    assert.notEqual(safeFailureMessage(code), "任务未完成，请查看诊断详情");
  }
  assert.equal(failureOriginForCode("unknown"), "runtime");
  assert.equal(safeFailureMessage("unknown"), "任务未完成，请查看诊断详情");
  for (const status of ["waiting_assignment", "waiting_parent", "waiting_children", "waiting_review", "feedback_required", "rework_required", "upstream_blocked", "skipped"] as const) {
    assert.notEqual(coordinationStatusLabel(status), undefined);
    assert.notEqual(coordinationStatusLabel(status), "");
  }
  assert.equal(deriveAttentionLevel("queued"), "neutral");
  assert.equal(deriveAttentionLevel("running"), "active");
  assert.equal(deriveAttentionLevel("resuming"), "active");
  assert.equal(deriveAttentionLevel("completed"), "success");
  assert.equal(deriveAttentionLevel("failed"), "error");
  assert.equal(deriveAttentionLevel("timed_out"), "error");
  assert.equal(deriveAttentionLevel("queued", "rework_required"), "feedback");
  assert.equal(deriveAttentionLevel("failed", undefined, "neutral"), "neutral");
});
