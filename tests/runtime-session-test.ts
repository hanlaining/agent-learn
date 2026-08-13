import assert from "node:assert/strict";
import test from "node:test";

import {
  cloneRuntimeSession,
  isRuntimeSession,
  upsertRuntimeContent,
  type RuntimeContent,
  type RuntimeSession,
} from "../src/runtime/runtime-session.js";

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
