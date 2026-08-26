import assert from "node:assert/strict";
import test from "node:test";

import {
  distillChatToSkill,
  parseDistilledSkillDraft,
  prepareDistillationInput,
  SkillDistillationError,
} from "../src/skills/chat-skill-distiller.js";
import { ScriptedLlmProvider } from "./helpers/scripted-llm.js";

test("过滤进度、个人信息和机器路径后调用现有 LLM Provider", async () => {
  const llm = new ScriptedLlmProvider([
    response(JSON.stringify({
      name: "Resolve_Runtime Connection",
      description: "处理 Runtime 连接问题，用于桌面端无法连接时。",
      instructions: "# Runtime 连接\n\n## 执行流程\n\n1. 检查服务状态。\n2. 验证连接恢复。",
    })),
  ]);

  const result = await distillChatToSkill({
    llm,
    messages: [
      { role: "user", text: "请总结 D:\\Users\\alice\\temp 下的 Runtime 连接修复流程，联系 alice@example.com。" },
      { role: "assistant", text: "我正在检查项目。\n最终确认：先检查服务状态，再验证连接恢复并记录验收结果。" },
    ],
  });

  assert.equal(result.name, "resolve-runtime-connection");
  assert.equal(llm.requests.length, 1);
  assert.equal(llm.requests[0]?.allowHostedTools, false);
  assert.deepEqual(llm.requests[0]?.tools, []);
  assert.doesNotMatch(String(llm.requests[0]?.input), /alice@example\.com/u);
  assert.doesNotMatch(String(llm.requests[0]?.input), /D:\\Users/u);
  assert.doesNotMatch(String(llm.requests[0]?.input), /我正在检查/u);
});

test("模型调用前拒绝高风险秘密且错误不回显秘密", () => {
  const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";

  assert.throws(
    () => prepareDistillationInput([
      { role: "user", text: `请保存 API key=${secret} 并总结这段很长的可复用流程。` },
    ]),
    (error) => {
      assert.ok(error instanceof SkillDistillationError);
      assert.equal(error.code, "sensitive_content");
      assert.doesNotMatch(error.message, new RegExp(secret, "u"));
      return true;
    },
  );
});

test("拒绝空内容、额外字段、路径逃逸、敏感输出和整段复制", async () => {
  assert.throws(
    () => prepareDistillationInput([{ role: "user", text: "你好" }]),
    /没有足够的可复用知识/u,
  );
  assert.throws(
    () => parseDistilledSkillDraft(JSON.stringify({
      name: "safe-skill",
      description: "能力及触发场景。",
      instructions: "执行安全流程。",
      extra: true,
    })),
    /合规/u,
  );
  assert.throws(
    () => parseDistilledSkillDraft(JSON.stringify({
      name: "../escape",
      description: "能力及触发场景。",
      instructions: "执行安全流程。",
    })),
    /合规/u,
  );
  assert.throws(
    () => parseDistilledSkillDraft(JSON.stringify({
      name: "unsafe-output",
      description: "读取用户 alice@example.com 的配置时执行。",
      instructions: "执行安全流程。",
    })),
    /安全检查/u,
  );

  const copied = "这是已经确认的完整聊天内容，包含一套需要按顺序执行的流程。".repeat(8);
  const llm = new ScriptedLlmProvider([
    response(JSON.stringify({
      name: "copied-chat",
      description: "复制聊天，用于测试。",
      instructions: copied,
    })),
  ]);
  await assert.rejects(
    () => distillChatToSkill({
      llm,
      messages: [{ role: "user", text: copied }],
    }),
    /合规/u,
  );
});

test("只接受严格 JSON，不接受 Markdown 围栏", () => {
  assert.throws(
    () => parseDistilledSkillDraft('```json\n{"name":"x","description":"y","instructions":"z"}\n```'),
    /合规/u,
  );
});

function response(text: string) {
  return { id: "response-1", text, functionCalls: [] };
}
