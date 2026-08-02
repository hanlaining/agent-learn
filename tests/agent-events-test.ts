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
      type: "assistant/delta",
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
