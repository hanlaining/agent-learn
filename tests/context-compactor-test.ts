import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_COMPACTION_PROMPT,
  CODEX_SUMMARY_PREFIX,
  ContextCompactor,
} from "../src/runtime/context-compactor.js";
import {
  ScriptedLlmProvider,
} from "./helpers/scripted-llm.js";
import type {
  TokenCounter,
} from "../src/runtime/token-counter.js";

const ONE_TOKEN_PER_MESSAGE_COUNTER: TokenCounter = {
  countText: () => 1,
  countMessages: (messages) => messages.length,
};

test("按 Codex 顺序用全历史生成摘要，并把摘要放在替换历史最后", async () => {
  const llm = new ScriptedLlmProvider([
    {
      id: "response-compaction",
      text: "用户正在分析 2026 年 7 月财务。",
      functionCalls: [],
    },
  ]);
  const compactor = new ContextCompactor({
    llm,
    retainedUserMessageTokens: 1,
    tokenCounter: ONE_TOKEN_PER_MESSAGE_COUNTER,
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
    ...messages,
    {
      role: "user",
      text: CODEX_COMPACTION_PROMPT,
    },
  ]);
  assert.deepEqual(llm.requests[0]?.tools, []);
  assert.equal(llm.requests[0]?.allowHostedTools, false);
  assert.deepEqual(compacted, [
    messages[2],
    {
      role: "user",
      text:
        `${CODEX_SUMMARY_PREFIX}\n` +
        "用户正在分析 2026 年 7 月财务。",
    },
  ]);
});

test("单条消息也执行显式压缩，而不是静默跳过", async () => {
  const llm = new ScriptedLlmProvider([
    {
      id: "response-single-message-compaction",
      text: "用户要求继续当前问题。",
      functionCalls: [],
    },
  ]);
  const compactor = new ContextCompactor({
    llm,
    tokenCounter: ONE_TOKEN_PER_MESSAGE_COUNTER,
  });
  const messages = [
    {
      role: "user" as const,
      text: "当前问题",
    },
  ];

  const compacted = await compactor.compact(messages);

  assert.equal(llm.requests.length, 1);
  assert.equal(compacted.at(-1)?.role, "user");
  assert.equal(
    compacted.at(-1)?.text.startsWith(
      `${CODEX_SUMMARY_PREFIX}\n`,
    ),
    true,
  );
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
    tokenCounter: ONE_TOKEN_PER_MESSAGE_COUNTER,
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

test("压缩前限制超大消息和摘要输入总预算", async () => {
  const characterCounter: TokenCounter = {
    countText: (text) => [...text].length,
    countMessages: (messages) =>
      messages.reduce(
        (total, message) =>
          total + [...message.text].length,
        0,
      ),
  };
  const llm = new ScriptedLlmProvider([
    {
      id: "response-limited-compaction",
      text: "受限摘要",
      functionCalls: [],
    },
  ]);
  const maxSummaryInputTokens =
    [...CODEX_COMPACTION_PROMPT].length + 70;
  const compactor = new ContextCompactor({
    llm,
    maxSummaryInputTokens,
    maxMessageTokens: 60,
    tokenCounter: characterCounter,
  });

  await compactor.compact([
    { role: "user", text: "旧".repeat(100) },
    { role: "assistant", text: "较新事实" },
    { role: "user", text: "当前问题" },
  ]);

  const summaryInput = llm.requests[0]?.input;

  assert.ok(Array.isArray(summaryInput));
  assert.equal(
    characterCounter.countMessages(summaryInput) <=
      maxSummaryInputTokens,
    true,
  );
  assert.equal(
    summaryInput.at(-1)?.text,
    CODEX_COMPACTION_PROMPT,
  );
  assert.equal(
    summaryInput.some((message) =>
      "text" in message &&
      message.text.includes("message truncated"),
    ),
    true,
  );
});

test("大量短消息的摘要请求最多包含 120 个 items", async () => {
  const llm = new ScriptedLlmProvider([
    {
      id: "response-item-limited-compaction",
      text: "短消息摘要",
      functionCalls: [],
    },
  ]);
  const compactor = new ContextCompactor({
    llm,
    maxSummaryInputItems: 120,
    tokenCounter: ONE_TOKEN_PER_MESSAGE_COUNTER,
  });
  const messages = Array.from(
    { length: 129 },
    (_, index) => ({
      role: index % 2 === 0
        ? "user" as const
        : "assistant" as const,
      text: `message-${index}`,
    }),
  );

  await compactor.compact(messages);

  const summaryInput = llm.requests[0]?.input;
  assert.ok(Array.isArray(summaryInput));
  assert.equal(summaryInput.length, 120);
  assert.equal(
    summaryInput.at(-1)?.text,
    CODEX_COMPACTION_PROMPT,
  );
  assert.equal(summaryInput[0]?.text, "message-10");
  assert.equal(summaryInput.at(-2)?.text, "message-128");
});

test("替换历史从最新往前保留用户消息，并截断预算边界消息", async () => {
  const characterCounter: TokenCounter = {
    countText: (text) => [...text].length,
    countMessages: (messages) => messages.length,
  };
  const llm = new ScriptedLlmProvider([
    {
      id: "response-retained-users",
      text: "用户消息摘要",
      functionCalls: [],
    },
  ]);
  const compactor = new ContextCompactor({
    llm,
    retainedUserMessageTokens: 8,
    tokenCounter: characterCounter,
  });

  const compacted = await compactor.compact([
    { role: "user", text: "AAAAAA" },
    { role: "assistant", text: "不直接保留" },
    { role: "user", text: "BBBB" },
  ]);

  assert.deepEqual(compacted.slice(0, -1), [
    { role: "user", text: "AAAA" },
    { role: "user", text: "BBBB" },
  ]);
});

test("再次压缩时不把旧的 Codex 摘要当成真实用户消息保留", async () => {
  const llm = new ScriptedLlmProvider([
    {
      id: "response-second-compaction",
      text: "第二窗口摘要",
      functionCalls: [],
    },
  ]);
  const compactor = new ContextCompactor({
    llm,
    retainedUserMessageTokens: 10,
    tokenCounter: ONE_TOKEN_PER_MESSAGE_COUNTER,
  });
  const oldSummary = {
    role: "user" as const,
    text: `${CODEX_SUMMARY_PREFIX}\n第一窗口摘要`,
  };

  const compacted = await compactor.compact([
    { role: "user", text: "第一问" },
    oldSummary,
    { role: "assistant", text: "第一答" },
    { role: "user", text: "第二问" },
  ]);

  assert.equal(
    compacted.some((message) => message.text === oldSummary.text),
    false,
  );
  assert.deepEqual(
    compacted.slice(0, -1).map((message) => message.text),
    ["第一问", "第二问"],
  );
});

test("替换历史最多保留最近 32 条真实用户消息和一条摘要", async () => {
  const llm = new ScriptedLlmProvider([
    {
      id: "response-retained-item-limit",
      text: "最近目标摘要",
      functionCalls: [],
    },
  ]);
  const compactor = new ContextCompactor({
    llm,
    retainedUserMessageTokens: 100,
    maxRetainedUserMessages: 32,
    tokenCounter: ONE_TOKEN_PER_MESSAGE_COUNTER,
  });
  const messages = Array.from(
    { length: 40 },
    (_, index) => ({
      role: "user" as const,
      text: `用户目标-${index}`,
    }),
  );

  const compacted = await compactor.compact(messages);

  assert.equal(compacted.length, 33);
  assert.deepEqual(
    compacted.slice(0, -1).map((message) => message.text),
    messages.slice(-32).map((message) => message.text),
  );
  assert.equal(compacted.at(-2)?.text, "用户目标-39");
  assert.equal(
    compacted.at(-1)?.text,
    `${CODEX_SUMMARY_PREFIX}\n最近目标摘要`,
  );
});

test("Item 上限配置必须为正整数", () => {
  const llm = new ScriptedLlmProvider([]);

  assert.throws(
    () => new ContextCompactor({
      llm,
      maxSummaryInputItems: 0,
    }),
    /maxSummaryInputItems must be a positive integer/,
  );
  assert.throws(
    () => new ContextCompactor({
      llm,
      maxRetainedUserMessages: 0,
    }),
    /maxRetainedUserMessages must be a positive integer/,
  );
});
