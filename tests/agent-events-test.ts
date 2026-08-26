import assert from "node:assert/strict";
import test from "node:test";

import {
  NOOP_AGENT_EVENT_SINK,
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

test("覆盖所有公开 Agent Event 正向分支", () => {
  const events: unknown[] = [
    { type: "agent/run_updated", threadId: "thread-1", turnId: "turn-1", run: { id: "run-1", status: "running" } },
    { type: "turn/started", threadId: "thread-1", turnId: "turn-1" },
    { type: "model/started", turnId: "turn-1", round: 0 },
    { type: "model/completed", turnId: "turn-1", round: 1, functionCallCount: 2 },
    { type: "context/compacted", turnId: "turn-1", beforeTokens: 100, afterTokens: 40 },
    { type: "reasoning/summary_part_added", turnId: "turn-1", round: 0, summaryIndex: 0 },
    { type: "reasoning/summary_delta", turnId: "turn-1", round: 0, summaryIndex: 0, delta: "检查完成" },
    { type: "reasoning/summary_completed", turnId: "turn-1", round: 0 },
    { type: "web_search/started", turnId: "turn-1", callId: "call-1" },
    { type: "web_search/searching", turnId: "turn-1", callId: "call-1" },
    { type: "web_search/completed", turnId: "turn-1", callId: "call-1" },
    { type: "citation/url_added", turnId: "turn-1", title: "Docs", url: "http://example.test", startIndex: 0, endIndex: 0 },
    { type: "tool/started", turnId: "turn-1", callId: "call-1", toolName: "read_file" },
    { type: "permission/requested", turnId: "turn-1", callId: "call-1", toolName: "write_file" },
    { type: "permission/decided", turnId: "turn-1", callId: "call-1", toolName: "write_file", decision: "allow" },
    { type: "tool/completed", turnId: "turn-1", callId: "call-1", toolName: "read_file" },
    { type: "model/output_text_delta", turnId: "turn-1", round: 0, delta: "结果" },
    { type: "model/output_text_completed", turnId: "turn-1", round: 0, classification: "commentary", text: "过程" },
    { type: "model/output_text_completed", turnId: "turn-1", round: 0, classification: "assistant", text: "答案" },
    { type: "turn/completed", turnId: "turn-1" },
    { type: "turn/failed", turnId: "turn-1", message: "失败" },
    { type: "turn/interrupted", turnId: "turn-1", message: "中断" },
    { type: "turn/timed_out", turnId: "turn-1", message: "超时" },
  ];
  for (const event of events) assert.equal(isAgentEvent(event), true, JSON.stringify(event));
  assert.doesNotThrow(() => NOOP_AGENT_EVENT_SINK.emit(events[0] as never));
});

test("Agent Event 对 null、数组、负数和错误字段 fail closed", () => {
  const invalid: unknown[] = [
    null,
    [],
    {},
    { type: 1 },
    { type: "unknown", turnId: "turn-1" },
    { type: "agent/run_updated", threadId: "thread-1", turnId: "turn-1", run: {} },
    { type: "agent/run_updated", threadId: "thread-1", turnId: "turn-1", run: { id: 1, status: "running" } },
    { type: "turn/started", threadId: "thread-1" },
    { type: "model/started", turnId: "turn-1", round: 1.2 },
    { type: "model/completed", turnId: "turn-1", round: 1 },
    { type: "context/compacted", turnId: "turn-1", beforeTokens: "100", afterTokens: 1 },
    { type: "reasoning/summary_part_added", turnId: "turn-1", round: -1, summaryIndex: 0 },
    { type: "reasoning/summary_part_added", turnId: "turn-1", round: 0, summaryIndex: -1 },
    { type: "reasoning/summary_delta", turnId: "turn-1", round: 0, summaryIndex: 0, delta: 1 },
    { type: "reasoning/summary_completed", turnId: "turn-1", round: -1 },
    { type: "web_search/completed", turnId: "turn-1", callId: "call-1", query: 1 },
    { type: "citation/url_added", turnId: "turn-1", title: "x", url: "ftp://example.test", startIndex: 0, endIndex: 1 },
    { type: "citation/url_added", turnId: "turn-1", title: "x", url: "https://example.test", startIndex: -1, endIndex: 1 },
    { type: "citation/url_added", turnId: "turn-1", title: "x", url: "https://example.test", startIndex: 2, endIndex: 1 },
    { type: "tool/started", turnId: "turn-1", callId: "call-1" },
    { type: "permission/requested", turnId: "turn-1", callId: "call-1", toolName: 1 },
    { type: "permission/decided", turnId: "turn-1", callId: "call-1", toolName: "x", decision: "maybe" },
    { type: "permission/decided", turnId: "turn-1", callId: "call-1", toolName: "x", decision: "deny", reason: 1 },
    { type: "model/output_text_delta", turnId: "turn-1", round: -1, delta: "x" },
    { type: "model/output_text_completed", turnId: "turn-1", round: 0, classification: "hidden", text: "x" },
    { type: "turn/completed" },
    { type: "turn/failed", turnId: "turn-1", message: 1 },
  ];
  for (const event of invalid) assert.equal(isAgentEvent(event), false, JSON.stringify(event));
});
