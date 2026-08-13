import assert from "node:assert/strict";
import test from "node:test";

import type {
  DesktopEvent,
} from "../src/electron/desktop-types.js";
import type {
  RuntimeContent,
  RuntimeSession,
} from "../src/runtime/runtime-session.js";
import {
  coalesceDesktopEvents,
  formatElapsed,
  getActivityGroupStatus,
  groupConsecutiveActivities,
  isNearBottom,
  isRuntimeItemAnimated,
  parseSafeInline,
  parseSafeMarkdown,
  shouldAutoCollapseProcess,
  splitRuntimeTimelineItems,
  summarizeActivityGroup,
  summarizeActivities,
  summarizeRuntimeStatus,
} from "../src/electron/renderer/runtime-ui.js";
import {
  desktopReducer,
  INITIAL_DESKTOP_UI_STATE,
} from "../src/electron/renderer/desktop-reducer.js";
import {
  filterCommandPaletteItems,
  findLatestAssistantOutput,
  movePaletteSelection,
  resolveDesktopShortcut,
} from "../src/electron/renderer/command-palette.js";
import { DESKTOP_COMMAND_REGISTRY } from "../src/shortcuts/builtins.js";
import {
  createComposerMessageInput,
  filterComposerSuggestions,
  findComposerToken,
  moveComposerSelection,
  replaceComposerToken,
  type ComposerSuggestion,
} from "../src/electron/renderer/composer-suggestions.js";

test("Composer 只在安全 token 边界识别 / @ $", () => {
  assert.deepEqual(findComposerToken("请检查 @src/app", 12), {
    kind: "file", trigger: "@", query: "src/app", start: 4, end: 12,
  });
  assert.equal(findComposerToken("mail@example.com", 16), undefined);
  assert.equal(findComposerToken("https://example.com", 8), undefined);
  assert.equal(findComposerToken("`$finance`", 8), undefined);
  assert.deepEqual(findComposerToken("/$skill", 7), {
    kind: "slash", trigger: "/", query: "$skill", start: 0, end: 7,
  });
});

test("Composer 建议支持检索、上限、循环选择和完整 token 替换", () => {
  const suggestions: ComposerSuggestion[] = [
    { id: "a", kind: "skill", value: "$finance", label: "finance-analysis", description: "财务分析" },
    { id: "b", kind: "skill", value: "$writer", label: "writer", description: "内容写作" },
  ];
  assert.deepEqual(filterComposerSuggestions(suggestions, "财务").map((item) => item.id), ["a"]);
  assert.equal(moveComposerSelection(0, -1, 2), 1);
  assert.equal(moveComposerSelection(1, 1, 2), 0);
  assert.deepEqual(
    replaceComposerToken("使用 $finace-now 完成", {
      kind: "skill", trigger: "$", query: "fin", start: 3, end: 14,
    }, "$finance-analysis"),
    { text: "使用 $finance-analysis 完成", cursor: 20 },
  );
});

test("Composer token 覆盖多行、光标中部、空触发符和代码边界", () => {
  assert.deepEqual(findComposerToken("第一行\n@src/app.ts 后续", 8), {
    kind: "file", trigger: "@", query: "src", start: 4, end: 15,
  });
  assert.deepEqual(findComposerToken("使用 $", 4), {
    kind: "skill", trigger: "$", query: "", start: 3, end: 4,
  });
  assert.equal(findComposerToken("foo/@src", 8), undefined);
  assert.equal(findComposerToken("escaped `code` @src", 19)?.kind, "file");
  assert.equal(findComposerToken("escaped \\` $skill", 17)?.kind, "skill");
  assert.equal(findComposerToken("text", -1), undefined);
  assert.equal(findComposerToken("text", 5), undefined);
});

test("Composer 建议大小写不敏感、遵守上限并安全处理零上限", () => {
  const suggestions: ComposerSuggestion[] = Array.from({ length: 15 }, (_, index) => ({
    id: String(index), kind: "file", value: `@src/File${index}.ts`,
    label: `src/File${index}.ts`, description: index === 13 ? "SPECIAL MATCH" : "workspace",
  }));
  assert.equal(filterComposerSuggestions(suggestions, "file").length, 12);
  assert.deepEqual(filterComposerSuggestions(suggestions, "special match").map((item) => item.id), ["13"]);
  assert.deepEqual(filterComposerSuggestions(suggestions, "", 0), []);
  assert.equal(moveComposerSelection(0, 1, 0), -1);
  assert.deepEqual(replaceComposerToken("@old", {
    kind: "file", trigger: "@", query: "old", start: 0, end: 4,
  }, "@new"), { text: "@new ", cursor: 5 });
});

test("Composer 发送只保留仍存在的完整显式 token", () => {
  assert.deepEqual(createComposerMessageInput(
    "检查 @src/app.ts 使用 $code-review",
    ["src/app.ts", "src/app.ts", "removed.ts"],
    ["code-review", "removed-skill"],
  ), {
    text: "检查 @src/app.ts 使用 $code-review",
    mentions: [{ kind: "file", path: "src/app.ts" }],
    explicitSkills: ["code-review"],
  });
  assert.deepEqual(createComposerMessageInput(
    "检查 @src/app.ts.bak 使用 $code-review-extra",
    ["src/app.ts"],
    ["code-review"],
  ), {
    text: "检查 @src/app.ts.bak 使用 $code-review-extra",
    mentions: [],
    explicitSkills: [],
  });
  assert.deepEqual(createComposerMessageInput(
    "检查 @docs/My Report 中文.ts\n然后继续",
    ["docs/My Report 中文.ts"],
    [],
  ).mentions, [{ kind: "file", path: "docs/My Report 中文.ts" }]);
});

test("命令面板按名称、描述、Slash 和快捷键过滤", () => {
  const items = DESKTOP_COMMAND_REGISTRY.list().map((action) => ({
    action,
    enabled: true,
  }));

  assert.deepEqual(
    filterCommandPaletteItems(items, "模型").map((item) => item.action.id),
    ["session.model"],
  );
  assert.deepEqual(
    filterCommandPaletteItems(items, "/permissions").map((item) => item.action.id),
    ["session.permissions"],
  );
  assert.deepEqual(
    filterCommandPaletteItems(items, "primary+k").map((item) => item.action.id),
    ["chat.search"],
  );
});

test("命令面板选择循环移动且空列表安全", () => {
  assert.equal(movePaletteSelection(0, 1, 3), 1);
  assert.equal(movePaletteSelection(2, 1, 3), 0);
  assert.equal(movePaletteSelection(0, -1, 3), 2);
  assert.equal(movePaletteSelection(0, 1, 0), -1);
});

test("桌面快捷键支持 Ctrl/Cmd 且忽略输入法和 Alt", () => {
  assert.equal(resolveDesktopShortcut(keyboard("p", { ctrlKey: true, shiftKey: true })), "composer.commandPalette");
  assert.equal(resolveDesktopShortcut(keyboard("k", { metaKey: true })), "chat.search");
  assert.equal(resolveDesktopShortcut(keyboard("n", { ctrlKey: true })), "chat.new");
  assert.equal(resolveDesktopShortcut(keyboard("o", { ctrlKey: true })), "output.copyLatest");
  assert.equal(resolveDesktopShortcut(keyboard("n", { ctrlKey: true, isComposing: true })), undefined);
  assert.equal(resolveDesktopShortcut(keyboard("k", { ctrlKey: true, altKey: true })), undefined);
});

test("复制优先使用当前 Runtime 的完整回答", () => {
  const completed = session("completed");
  completed.items.push({
    id: "answer-1",
    turnId: completed.turnId,
    kind: "assistant",
    round: 0,
    status: "completed",
    markdown: "Runtime 最新回答",
  });

  assert.equal(findLatestAssistantOutput([
    { id: "m1", turnId: "old", role: "assistant", text: "历史回答", createdAt: new Date().toISOString() },
  ], completed), "Runtime 最新回答");
});

test("安全 Markdown 支持常用块并把原始 HTML 保留为文本", () => {
  const blocks = parseSafeMarkdown([
    "## 结果",
    "",
    "- 第一项",
    "- 第二项",
    "",
    "```ts",
    "const value = '<script>alert(1)</script>';",
    "```",
    "",
    "<img src=x onerror=alert(1)>",
  ].join("\n"));

  assert.deepEqual(blocks, [
    { kind: "heading", level: 2, text: "结果" },
    { kind: "unordered_list", items: ["第一项", "第二项"] },
    {
      kind: "code",
      language: "ts",
      text: "const value = '<script>alert(1)</script>';",
    },
    { kind: "paragraph", text: "<img src=x onerror=alert(1)>" },
  ]);
});

test("安全 Markdown 只允许无凭据的 HTTP 和 HTTPS 链接", () => {
  const tokens = parseSafeInline([
    "[安全](https://example.com/path)",
    "[脚本](javascript:alert(1))",
    "[凭据](https://user:secret@example.com/path)",
  ].join(" "));
  const links = tokens.filter((token) => token.kind === "link");

  assert.equal(links[0]?.kind === "link" ? links[0].href : undefined,
    "https://example.com/path");
  assert.equal(links[1]?.kind === "link" ? links[1].href : undefined, undefined);
  assert.equal(links[2]?.kind === "link" ? links[2].href : undefined, undefined);
});

test("同一动画帧合并文本 Delta 并只保留最新 RuntimeSession", () => {
  const running = session("running");
  const completed = { ...running, status: "completed" as const };
  const events: DesktopEvent[] = [
    { type: "runtime/session", threadId: "thread-1", session: running },
    {
      type: "message/user",
      threadId: "thread-1",
      message: {
        id: "message-1",
        turnId: "turn-1",
        role: "user",
        text: "开始",
        createdAt: "2026-08-12T00:00:00.000Z",
      },
    },
    {
      type: "assistant/delta",
      threadId: "thread-1",
      turnId: "turn-1",
      delta: "你",
    },
    {
      type: "assistant/delta",
      threadId: "thread-1",
      turnId: "turn-1",
      delta: "好",
    },
    { type: "runtime/session", threadId: "thread-1", session: completed },
  ];

  const result = coalesceDesktopEvents(events);
  assert.equal(result[0]?.type, "message/user");
  assert.deepEqual(result[1], {
    type: "assistant/delta",
    threadId: "thread-1",
    turnId: "turn-1",
    delta: "你好",
  });
  assert.deepEqual(result[2], {
    type: "runtime/session",
    threadId: "thread-1",
    session: completed,
  });
});

test("同一帧只有初始会话与用户消息时仍最后应用会话快照", () => {
  const running = session("running");
  const result = coalesceDesktopEvents([
    { type: "runtime/session", threadId: "thread-1", session: running },
    {
      type: "message/user",
      threadId: "thread-1",
      message: {
        id: "message-1",
        turnId: "turn-1",
        role: "user",
        text: "开始",
        createdAt: "2026-08-12T00:00:00.000Z",
      },
    },
  ]);

  assert.equal(result[0]?.type, "message/user");
  assert.deepEqual(result[1], {
    type: "runtime/session",
    threadId: "thread-1",
    session: running,
  });
});

test("已处理时间覆盖秒、分钟和固定完成时间", () => {
  const start = "2026-08-12T00:00:00.000Z";
  assert.equal(formatElapsed(start, undefined, Date.parse(start) + 31_000),
    "已处理 31 秒");
  assert.equal(formatElapsed(start, undefined, Date.parse(start) + 120_000),
    "已处理 2 分钟");
  assert.equal(formatElapsed(
    start,
    "2026-08-12T00:01:05.000Z",
    Date.parse(start) + 999_000,
  ), "已处理 1 分 5 秒");
});

test("活动摘要按类型计数且同 ID 更新不需要重复 UI 条目", () => {
  const items = session("completed").items;
  assert.equal(summarizeActivities(items), "读取 1 项 · 搜索 1 项");
});

test("Activity 只在相邻且同一轮时分组，不跨 Commentary 或轮次重排", () => {
  const items: RuntimeContent[] = [
    activity("read-1", 0, "read", "completed"),
    activity("search-1", 0, "searched", "completed"),
    commentary("commentary-1", 0),
    activity("run-1", 0, "ran", "completed"),
    {
      id: "reasoning-1",
      turnId: "turn-1",
      kind: "reasoning_summary",
      round: 0,
      summaryIndex: 0,
      status: "completed",
      markdown: "公开推理摘要",
    },
    activity("run-2", 0, "ran", "completed"),
    activity("edit-1", 1, "edited", "running"),
    activity("read-2", 1, "read", "completed"),
  ];

  const grouped = groupConsecutiveActivities(items);
  assert.deepEqual(grouped.map((item) => item.kind), [
    "activity_group",
    "commentary",
    "activity_group",
    "reasoning_summary",
    "activity_group",
    "activity_group",
  ]);

  const groups = grouped.filter((item) => item.kind === "activity_group");
  assert.deepEqual(groups.map((group) => group.activities.map((item) => item.id)), [
    ["read-1", "search-1"],
    ["run-1"],
    ["run-2"],
    ["edit-1", "read-2"],
  ]);
});

test("Activity 操作组摘要和状态只由结构化字段派生", () => {
  const [group] = groupConsecutiveActivities([
    activity("read-1", 0, "read", "completed"),
    activity("search-1", 0, "searched", "failed"),
  ]);
  assert.equal(group?.kind, "activity_group");
  if (group?.kind !== "activity_group") return;

  assert.equal(summarizeActivityGroup(group), "读取 1 项 · 搜索 1 项");
  assert.equal(getActivityGroupStatus(group), "failed");
});

test("Activity 操作组运行态优先，并在全部完成后显示完成", () => {
  const [runningGroup] = groupConsecutiveActivities([
    activity("failed-1", 0, "ran", "failed"),
    activity("running-1", 0, "edited", "running"),
  ]);
  const [completedGroup] = groupConsecutiveActivities([
    activity("read-1", 0, "read", "completed"),
  ]);

  assert.equal(
    runningGroup?.kind === "activity_group" ? getActivityGroupStatus(runningGroup) : undefined,
    "running",
  );
  assert.equal(
    completedGroup?.kind === "activity_group" ? getActivityGroupStatus(completedGroup) : undefined,
    "completed",
  );
});

test("过程摘要为每种 Runtime 终态提供安全固定文案", () => {
  assert.equal(summarizeRuntimeStatus("running"), "正在处理");
  assert.equal(summarizeRuntimeStatus("completed"), "处理完成");
  assert.equal(summarizeRuntimeStatus("failed"), "请求未完成");
  assert.equal(summarizeRuntimeStatus("cancelled"), "已取消");
  assert.equal(summarizeRuntimeStatus("timed_out"), "已超时");
});

test("公开过程与最终结果按协议类型拆分并分别保持原始顺序", () => {
  const items: RuntimeContent[] = [
    {
      id: "commentary-1",
      turnId: "turn-1",
      kind: "commentary",
      round: 0,
      status: "completed",
      markdown: "正在排查",
    },
    {
      id: "assistant-1",
      turnId: "turn-1",
      kind: "assistant",
      round: 0,
      status: "completed",
      markdown: "最终回答",
    },
    {
      id: "reasoning-1",
      turnId: "turn-1",
      kind: "reasoning_summary",
      round: 0,
      summaryIndex: 0,
      status: "completed",
      markdown: "公开推理摘要",
    },
    {
      id: "error-1",
      turnId: "turn-1",
      kind: "error",
      code: "SAFE_ERROR",
      title: "请求失败",
      safeMessage: "请稍后重试",
      retryable: true,
    },
    {
      id: "activity-1",
      turnId: "turn-1",
      kind: "activity",
      activityKind: "read",
      round: 0,
      status: "completed",
      title: "读取实现",
    },
  ];

  const sections = splitRuntimeTimelineItems(items);
  assert.deepEqual(sections.process.map((item) => item.id), [
    "commentary-1",
    "reasoning-1",
    "activity-1",
  ]);
  assert.deepEqual(sections.outcome.map((item) => item.id), [
    "assistant-1",
    "error-1",
  ]);
});

test("只有成功完成会自动压缩公开过程，其他状态默认保持展开", () => {
  assert.equal(shouldAutoCollapseProcess("completed"), true);
  for (const status of ["running", "failed", "cancelled", "timed_out"] as const) {
    assert.equal(shouldAutoCollapseProcess(status), false);
  }
});

test("空时间线可以安全拆分为空过程和空结果", () => {
  assert.deepEqual(splitRuntimeTimelineItems([]), { process: [], outcome: [] });
});

test("滚动锁只在接近底部时自动跟随", () => {
  assert.equal(isNearBottom({ scrollHeight: 1000, scrollTop: 440, clientHeight: 500 }), true);
  assert.equal(isNearBottom({ scrollHeight: 1000, scrollTop: 300, clientHeight: 500 }), false);
});

test("失败、取消和超时完成态不会保留任何 running 动画", () => {
  for (const status of ["failed", "cancelled", "timed_out"] as const) {
    const value = session(status);
    for (const item of value.items) {
      assert.equal(isRuntimeItemAnimated(value, item), false);
    }
  }

  const running = session("running");
  assert.equal(isRuntimeItemAnimated(running, running.items[0]!), true);
});

test("桌面快照恢复仍在运行的 RuntimeSession", () => {
  const runtimeSession = session("running");
  const state = desktopReducer(INITIAL_DESKTOP_UI_STATE, {
    type: "snapshot",
    snapshot: {
      threads: [],
      messages: [],
      capabilities: {
        llm: true,
        models: [],
        webSearch: false,
        tools: [],
        skills: [],
        mcpServers: [],
      },
      turnState: "thinking",
      agentConfig: {
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        agentProfileId: "orchestrator",
      },
      agentRuns: [],
      runtimeSession,
    },
  });

  assert.deepEqual(state.runtimeSession, runtimeSession);
});

function session(status: RuntimeSession["status"]): RuntimeSession {
  return {
    turnId: "turn-1",
    status,
    startedAt: "2026-08-12T00:00:00.000Z",
    ...(status === "running"
      ? {}
      : { completedAt: "2026-08-12T00:00:31.000Z" }),
    items: [
      {
        id: "read-1",
        turnId: "turn-1",
        kind: "activity",
        activityKind: "read",
        round: 0,
        status: status === "running" ? "running" : "completed",
        title: "读取实现",
      },
      {
        id: "search-1",
        turnId: "turn-1",
        kind: "activity",
        activityKind: "searched",
        round: 0,
        status: "completed",
        title: "搜索调用点",
      },
    ],
  };
}

function activity(
  id: string,
  round: number,
  activityKind: Extract<RuntimeContent, { kind: "activity" }>["activityKind"],
  status: Extract<RuntimeContent, { kind: "activity" }>["status"],
): Extract<RuntimeContent, { kind: "activity" }> {
  return {
    id,
    turnId: "turn-1",
    kind: "activity",
    activityKind,
    round,
    status,
    title: `安全标题 ${id}`,
  };
}

function commentary(
  id: string,
  round: number,
): Extract<RuntimeContent, { kind: "commentary" }> {
  return {
    id,
    turnId: "turn-1",
    kind: "commentary",
    round,
    status: "completed",
    markdown: "阶段说明",
  };
}

function keyboard(
  key: string,
  overrides: Partial<Pick<KeyboardEvent,
    "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "isComposing"
  >> = {},
): Pick<KeyboardEvent,
  "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "isComposing"
> {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    ...overrides,
  };
}
