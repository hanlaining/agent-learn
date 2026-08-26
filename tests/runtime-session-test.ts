import assert from "node:assert/strict";
import test from "node:test";

import {
  cloneRuntimeSession,
  isRuntimeSession,
  upsertRuntimeContent,
  type RuntimeContent,
  type RuntimeSession,
} from "../src/runtime/runtime-session.js";
import {
  isItem,
  isThread,
  isTurn,
} from "../src/runtime/lifecycle.js";

test("RuntimeContent 更新原条目且保持首次出现顺序", () => {
  const planning: RuntimeContent = {
    id: "planning-0",
    turnId: "turn-1",
    kind: "activity",
    activityKind: "planning",
    round: 0,
    status: "running",
    title: "正在处理",
  };
  const commentary: RuntimeContent = {
    id: "output-0",
    turnId: "turn-1",
    kind: "commentary",
    round: 0,
    status: "completed",
    markdown: "先检查实现。",
  };
  const completedPlanning: RuntimeContent = {
    ...planning,
    status: "completed",
    title: "已选择工具",
  };

  const initial = upsertRuntimeContent([], planning);
  const withCommentary = upsertRuntimeContent(initial, commentary);
  const updated = upsertRuntimeContent(
    withCommentary,
    completedPlanning,
  );

  assert.deepEqual(
    updated.map((item) => item.id),
    ["planning-0", "output-0"],
  );
  assert.deepEqual(updated[0], completedPlanning);
});

test("RuntimeSession 校验 round、summaryIndex 和安全错误字段", () => {
  const session: RuntimeSession = {
    turnId: "turn-1",
    status: "failed",
    startedAt: "2026-08-12T00:00:00.000Z",
    completedAt: "2026-08-12T00:00:01.000Z",
    items: [
      {
        id: "reasoning-0-1",
        turnId: "turn-1",
        kind: "reasoning_summary",
        round: 0,
        summaryIndex: 1,
        status: "completed",
        markdown: "公开摘要",
      },
      {
        id: "safe-error",
        turnId: "turn-1",
        kind: "error",
        code: "agent_failed",
        title: "请求未能完成",
        safeMessage: "请重试",
        retryable: true,
      },
    ],
  };

  assert.equal(isRuntimeSession(session), true);
  assert.equal(
    isRuntimeSession({
      ...session,
      items: [{ ...session.items[0], round: -1 }],
    }),
    false,
  );
});

test("cloneRuntimeSession 不共享可变 items", () => {
  const session: RuntimeSession = {
    turnId: "turn-1",
    status: "running",
    startedAt: "2026-08-12T00:00:00.000Z",
    items: [],
  };
  const cloned = cloneRuntimeSession(session);
  cloned.items.push({
    id: "output-0",
    turnId: "turn-1",
    kind: "pending_output",
    round: 0,
    status: "streaming",
    markdown: "实时文本",
  });

  assert.equal(session.items.length, 0);
  assert.equal(cloned.items.length, 1);
});

test("RuntimeSession 接受全部内容类型和终态", () => {
  const base = { turnId: "turn-1", startedAt: "2026-08-12T00:00:00.000Z" };
  const items: RuntimeContent[] = [
    { id: "pending", turnId: "turn-1", kind: "pending_output", round: 0, status: "streaming", markdown: "" },
    { id: "commentary", turnId: "turn-1", kind: "commentary", round: 1, status: "completed", markdown: "过程" },
    { id: "assistant", turnId: "turn-1", kind: "assistant", round: 1, status: "completed", markdown: "答案" },
    { id: "reasoning", turnId: "turn-1", kind: "reasoning_summary", round: 1, summaryIndex: 0, status: "streaming", markdown: "摘要" },
    { id: "activity", turnId: "turn-1", kind: "activity", activityKind: "permission", round: 1, status: "failed", title: "审批", summary: "拒绝", safeDetails: ["detail"] },
    { id: "error", turnId: "turn-1", kind: "error", code: "x", title: "错误", safeMessage: "可重试", retryable: true },
  ];
  for (const status of ["running", "completed", "failed", "cancelled", "interrupted", "timed_out"] as const) {
    assert.equal(isRuntimeSession({ ...base, status, completedAt: status === "running" ? undefined : base.startedAt, items }), true, status);
  }
});

test("RuntimeSession 对每种非法内容和边界值 fail closed", () => {
  const base = { turnId: "turn-1", status: "running", startedAt: "now", items: [] };
  const invalidItems: unknown[] = [
    null,
    {},
    { id: "x", turnId: "turn-1", kind: "pending_output", round: -1, status: "streaming", markdown: "x" },
    { id: "x", turnId: "turn-1", kind: "pending_output", round: 0, status: "completed", markdown: "x" },
    { id: "x", turnId: "turn-1", kind: "commentary", round: 0, status: "streaming", markdown: "x" },
    { id: "x", turnId: "turn-1", kind: "reasoning_summary", round: 0, summaryIndex: -1, status: "completed", markdown: "x" },
    { id: "x", turnId: "turn-1", kind: "reasoning_summary", round: 0, summaryIndex: 0, status: "bad", markdown: "x" },
    { id: "x", turnId: "turn-1", kind: "activity", activityKind: "unknown", round: 0, status: "running", title: "x" },
    { id: "x", turnId: "turn-1", kind: "activity", activityKind: "planning", round: 0, status: "running", title: 1 },
    { id: "x", turnId: "turn-1", kind: "activity", activityKind: "planning", round: 0, status: "running", title: "x", safeDetails: [1] },
    { id: "x", turnId: "turn-1", kind: "error", code: "x", title: "x", safeMessage: "x", retryable: "yes" },
    { id: "x", turnId: "turn-1", kind: "unknown", code: "x" },
  ];
  for (const item of invalidItems) assert.equal(isRuntimeSession({ ...base, items: [item] }), false, JSON.stringify(item));
  assert.equal(isRuntimeSession(null), false);
  assert.equal(isRuntimeSession([]), false);
  assert.equal(isRuntimeSession({ ...base, status: "unknown" }), false);
  assert.equal(isRuntimeSession({ ...base, completedAt: 1 }), false);
  assert.equal(isRuntimeSession({ ...base, items: {} }), false);
});

test("Runtime lifecycle 类型守卫覆盖真实字段、可选字段和边界值", () => {
  const thread = {
    id: "thread-1",
    status: "active",
    kind: "user_chat",
    createdAt: "2026-08-12T00:00:00.000Z",
    lastActivityAt: "2026-08-12T00:00:01.000Z",
    title: "对话",
    deletedAt: undefined,
    trashExpiresAt: undefined,
    deleteBatchId: undefined,
    turnIds: ["turn-1"],
  };
  assert.equal(isThread(thread), true);
  assert.equal(isThread({ ...thread, status: "closed", kind: "agent_internal" }), true);
  assert.equal(isThread(null), false);
  assert.equal(isThread([]), false);
  assert.equal(isThread({ ...thread, id: 1 }), false);
  assert.equal(isThread({ ...thread, kind: "unsupported" }), false);
  assert.equal(isThread({ ...thread, turnIds: [1] }), false);

  const turn = {
    id: "turn-1",
    threadId: "thread-1",
    status: "in_progress",
    createdAt: "2026-08-12T00:00:00.000Z",
    completedAt: undefined,
    itemIds: ["item-1"],
  };
  assert.equal(isTurn(turn), true);
  for (const status of ["pending", "completed", "failed", "interrupted", "timed_out"] as const) {
    assert.equal(isTurn({ ...turn, status, completedAt: status === "pending" ? undefined : turn.createdAt }), true, status);
  }
  assert.equal(isTurn({ ...turn, status: "unknown" }), false);
  assert.equal(isTurn({ ...turn, completedAt: 1 }), false);
  assert.equal(isTurn({ ...turn, itemIds: [null] }), false);

  const item = {
    id: "item-1",
    threadId: "thread-1",
    turnId: "turn-1",
    type: "assistant_message",
    content: { text: "完成" },
    createdAt: "2026-08-12T00:00:00.000Z",
  };
  assert.equal(isItem(item), true);
  for (const type of ["user_message", "runtime_message", "tool_call", "tool_result"] as const) {
    assert.equal(isItem({ ...item, type }), true, type);
  }
  assert.equal(isItem({ ...item, type: "unknown" }), false);
  assert.equal(isItem({ ...item, content: undefined }), true, "content may be any present value");
  assert.equal(isItem({ ...item, createdAt: 1 }), false);
});
