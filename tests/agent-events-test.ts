import assert from "node:assert/strict";
import test from "node:test";

import {
  isAgentEvent,
} from "../src/agent/events.js";

test("识别 Tool 进度事件", () => {
  assert.equal(
    isAgentEvent({
      type: "tool/started",
      turnId: "turn-1",
      callId: "call-1",
      toolName: "finance_monthly_summary",
    }),
    true,
  );
});

test("拒绝字段不完整的 Agent Event", () => {
  assert.equal(
    isAgentEvent({
      type: "model/output_text_delta",
      turnId: "turn-1",
    }),
    false,
  );
});

test("识别 Permission 决策事件", () => {
  assert.equal(
    isAgentEvent({
      type: "permission/decided",
      turnId: "turn-1",
      callId: "call-1",
      toolName: "finance_monthly_summary",
      decision: "deny",
      reason: "user denied",
    }),
    true,
  );

  assert.equal(
    isAgentEvent({
      type: "permission/decided",
      turnId: "turn-1",
      callId: "call-1",
      toolName: "finance_monthly_summary",
      decision: "maybe",
    }),
    false,
  );
});

test("识别推理摘要完成事件", () => {
  assert.equal(
    isAgentEvent({
      type: "reasoning/summary_completed",
      turnId: "turn-1",
      round: 0,
    }),
    true,
  );
});

test("识别带分段序号的公开推理摘要事件", () => {
  assert.equal(
    isAgentEvent({
      type: "reasoning/summary_part_added",
      turnId: "turn-1",
      round: 0,
      summaryIndex: 0,
    }),
    true,
  );

  assert.equal(
    isAgentEvent({
      type: "reasoning/summary_delta",
      turnId: "turn-1",
      round: 2,
      summaryIndex: 1,
      delta: "核对结果",
    }),
    true,
  );

  assert.equal(
    isAgentEvent({
      type: "reasoning/summary_delta",
      turnId: "turn-1",
      round: 0,
      delta: "缺少 summaryIndex",
    }),
    false,
  );
});

test("识别 Web Search 生命周期事件", () => {
  assert.equal(
    isAgentEvent({
      type: "web_search/started",
      turnId: "turn-1",
      callId: "ws-1",
    }),
    true,
  );

  assert.equal(
    isAgentEvent({
      type: "web_search/completed",
      turnId: "turn-1",
      callId: "ws-1",
      query: "OpenAI Responses API",
    }),
    true,
  );

  assert.equal(
    isAgentEvent({
      type: "web_search/searching",
      turnId: "turn-1",
    }),
    false,
  );
});

test("只识别安全的 URL Citation 事件", () => {
  assert.equal(
    isAgentEvent({
      type: "citation/url_added",
      turnId: "turn-1",
      title: "OpenAI Developers",
      url: "https://developers.openai.com/",
      startIndex: 0,
      endIndex: 10,
    }),
    true,
  );

  assert.equal(
    isAgentEvent({
      type: "citation/url_added",
      turnId: "turn-1",
      title: "unsafe",
      url: "javascript:alert(1)",
      startIndex: 0,
      endIndex: 10,
    }),
    false,
  );
});
