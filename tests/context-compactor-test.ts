import assert from "node:assert/strict";
import test from "node:test";

import {
  ContextCompactor,
} from "../src/runtime/context-compactor.js";
import {
  ScriptedLlmProvider,
} from "./helpers/scripted-llm.js";

test("把旧消息压缩为 Handoff Summary 并保留最近消息", async () => {
  const llm = new ScriptedLlmProvider([
    {
      id: "response-compaction",
      text: "用户正在分析 2026 年 7 月财务。",
      functionCalls: [],
    },
  ]);
  const compactor = new ContextCompactor({
    llm,
    recentMessageTokens: 5,
  });
  const messages = [
    {
      role: "user" as const,
      text: "甲",
    },
    {
      role: "assistant" as const,
      text: "乙",
    },
    {
      role: "user" as const,
      text: "丙",
    },
  ];

  const compacted = await compactor.compact(messages);

  assert.deepEqual(llm.requests[0]?.input, [
    messages[0],
    messages[1],
  ]);
  assert.deepEqual(llm.requests[0]?.tools, []);
  assert.deepEqual(compacted, [
    {
      role: "assistant",
      text:
        "[Context checkpoint]\n" +
        "用户正在分析 2026 年 7 月财务。",
    },
    messages[2],
  ]);
});

test("没有旧消息时不调用模型", async () => {
  const llm = new ScriptedLlmProvider([]);
  const compactor = new ContextCompactor({
    llm,
    recentMessageTokens: 10,
  });
  const messages = [
    {
      role: "user" as const,
      text: "当前问题",
    },
  ];

  const compacted = await compactor.compact(messages);

  assert.deepEqual(compacted, messages);
  assert.equal(llm.requests.length, 0);
});

test("摘要模型返回 Tool Call 时拒绝生成 Checkpoint", async () => {
  const llm = new ScriptedLlmProvider([
    {
      id: "response-invalid-compaction",
      text: "",
      functionCalls: [
        {
          callId: "call-not-allowed",
          name: "finance_monthly_summary",
          arguments: "{}",
        },
      ],
    },
  ]);
  const compactor = new ContextCompactor({
    llm,
    recentMessageTokens: 5,
  });

  await assert.rejects(
    () => compactor.compact([
      {
        role: "user",
        text: "旧消息",
      },
      {
        role: "user",
        text: "当前消息",
      },
    ]),
    /Compaction model must return summary text only/,
  );
});
