import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

test("父 Chat 接收失败子 Agent 更新并保留安全错误", () => {
  const base = desktopReducer(INITIAL_DESKTOP_UI_STATE, {
    type: "snapshot",
    snapshot: {
      threads: [], activeThreadId: "thread-parent", messages: [],
      capabilities: { llm: true, models: [], webSearch: false, tools: [], skills: [], mcpServers: [] },
      turnState: "failed",
      agentConfig: { model: "gpt-5.6-sol", reasoningEffort: "high", agentProfileId: "orchestrator" },
      agentRuns: [],
    },
  });
  const state = desktopReducer(base, {
    type: "event",
    event: {
      type: "agent/run_updated",
      threadId: "thread-parent",
      turnId: "turn-parent",
      run: {
        id: "run-child", jobId: "job-parent", rootRunId: "run-root",
        attempt: 1, threadId: "thread-internal", turnId: "turn-child",
        agentProfileId: "reviewer", parentRunId: "run-worker",
        status: "failed", task: "独立验收", depth: 2,
        safeError: "Reviewer configuration is unavailable",
      },
    },
  });

  assert.equal(state.snapshot?.agentRuns[0]?.agentProfileId, "reviewer");
  assert.equal(state.snapshot?.agentRuns[0]?.safeError, "Reviewer configuration is unavailable");
});

test("固定软件团队 UI 展示 God、负责人、三角色和真实 Thread 返回入口", () => {
  const source = readFileSync(new URL("../src/electron/renderer/App.tsx", import.meta.url), "utf8");
  assert.match(source, /软件产品演示团队/);
  assert.match(source, /软件团队负责人/);
  assert.match(source, /产品角色 Agent/);
  assert.match(source, /工程角色 Agent/);
  assert.match(source, /测试角色 Agent/);
  assert.match(source, /selectAgentThread\(run\?\.threadId\)/);
  assert.match(source, /← 返回 God/);
});

test("产品双轮 Return 使用受控阶段按钮且返工状态不标红", () => {
  const appSource = readFileSync(resolve("src/electron/renderer/App.tsx"), "utf8");
  const cssSource = readFileSync(resolve("src/electron/renderer/styles.css"), "utf8");
  const preloadSource = readFileSync(resolve("src/electron/preload.cjs"), "utf8");
  assert.match(appSource, /产品生成第一轮 Return/);
  assert.match(appSource, /原产品 Thread 返工（Attempt 2）/);
  assert.match(appSource, /God 接收并单次汇总/);
  assert.match(appSource, /工程角色实现项目/);
  assert.match(appSource, /测试角色独立验收/);
  assert.match(preloadSource, /desktop:advance-fixed-product/);
  assert.match(cssSource, /fixed-product-advance/);
  assert.doesNotMatch(cssSource, /rework[^}]*var\(--negative\)/s);
});

test("真实 Agent 对话提示仅在安全错误存在时使用错误色", () => {
  const appSource = readFileSync(
    resolve("src/electron/renderer/App.tsx"),
    "utf8",
  );
  const styles = readFileSync(
    resolve("src/electron/renderer/styles.css"),
    "utf8",
  );

  assert.match(
    appSource,
    /run\.safeError === undefined \? "" : " is-error"/,
  );
  assert.match(
    styles,
    /\.history-agent-detail \{[^}]*color: var\(--faint-text\)/,
  );
  assert.match(
    styles,
    /\.history-agent-detail\.is-error \{ color: var\(--negative\)/,
  );
});

test("可恢复 Runtime 错误使用琥珀色而不是红色", () => {
  const timeline = readFileSync(resolve("src/electron/renderer/RuntimeTimeline.tsx"), "utf8");
  const styles = readFileSync(resolve("src/electron/renderer/styles.css"), "utf8");
  assert.match(timeline, /data-retryable=\{item\.retryable\}/);
  assert.match(styles, /\.runtime-error\[data-retryable="true"\]/);
  assert.match(styles, /color: #8a5a12/);
});

test("三栏支持小手拖拽、联动边界、宽度记忆与双击复位", () => {
  const app = readFileSync(resolve("src/electron/renderer/App.tsx"), "utf8");
  const styles = readFileSync(resolve("src/electron/renderer/styles.css"), "utf8");
  assert.match(app, /className="left-sidebar-resizer pane-resizer"/);
  assert.match(app, /className="right-inspector-resizer pane-resizer"/);
  assert.match(app, /role="separator"/);
  assert.match(app, /onPointerDown=\{startLeftSidebarResize\}/);
  assert.match(app, /onPointerDown=\{startRightInspectorResize\}/);
  assert.match(app, /onDoubleClick=\{resetThreePaneWidths\}/);
  assert.match(app, /god-agent:left-sidebar-width/);
  assert.match(app, /god-agent:right-workbench-width/);
  assert.match(app, /visibleRightInspectorWidth = clamp/);
  assert.match(app, /MIN_WORKSPACE_WIDTH/);
  assert.match(app, /window\.addEventListener\("resize", updateViewportWidth\)/);
  assert.match(styles, /\.pane-resizer \{[\s\S]*?cursor: grab/);
  assert.match(styles, /cursor: grabbing/);
  assert.match(styles, /var\(--left-sidebar-width, 236px\)/);
  assert.match(styles, /var\(--right-inspector-width, 520px\)/);
});

test("右侧浏览器使用 Codex 风格多标签、真实地址栏与隔离网页区域", () => {
  const app = readFileSync(resolve("src/electron/renderer/App.tsx"), "utf8");
  const styles = readFileSync(resolve("src/electron/renderer/styles.css"), "utf8");
  const main = readFileSync(resolve("src/electron/main.cjs"), "utf8");
  const browserManager = readFileSync(resolve("src/electron/browser-manager.cjs"), "utf8");
  assert.match(app, /className="browser-tab-strip"/);
  assert.match(app, /className="browser-tabs"/);
  assert.match(app, /className="browser-navigation"/);
  assert.match(app, /className="browser-address"/);
  assert.match(app, /aria-label="地址栏"/);
  assert.match(app, /aria-label="新建标签页"/);
  assert.match(app, /aria-label="后退"/);
  assert.match(app, /aria-label="前进"/);
  assert.match(app, /activeTab\.isLoading \? "停止加载" : "刷新"/);
  assert.match(app, /aria-label="外部打开"/);
  assert.match(app, /className="browser-surface"/);
  assert.doesNotMatch(app, /<iframe/);
  assert.match(main, /WebContentsView/);
  assert.match(browserManager, /sandbox: true/);
  assert.match(browserManager, /contextIsolation: true/);
  assert.match(browserManager, /nodeIntegration: false/);
  assert.match(browserManager, /setWindowOpenHandler/);
  assert.match(browserManager, /before-input-event/);
  assert.match(app, /browser\.onCommand/);
  assert.match(styles, /\.browser-workbench \{[\s\S]*grid-template-rows: 40px 40px minmax\(0, 1fr\)/);
  assert.doesNotMatch(styles, /\.right-inspector \{[^}]*position: absolute/s);
});

test("中间工作区内容按自身容器安全换行且不撑破三栏", () => {
  const styles = readFileSync(resolve("src/electron/renderer/styles.css"), "utf8");
  assert.match(styles, /\.main-workspace \{[\s\S]*container-name: workspace;[\s\S]*container-type: inline-size;/);
  assert.match(styles, /\.message > div,[\s\S]*\.safe-markdown \{ min-width: 0; max-width: 100%; \}/);
  assert.match(styles, /\.message-copy \{[\s\S]*overflow-wrap: anywhere;[\s\S]*word-break: break-word;/);
  assert.match(styles, /\.runtime-timeline \{[\s\S]*max-width: calc\(100% - 31px\)/);
  assert.match(styles, /\.safe-markdown table \{ display: block; max-width: 100%; overflow-x: auto; \}/);
  assert.match(styles, /@container workspace \(max-width: 560px\) \{[\s\S]*\.runtime-summary \{ flex-wrap: wrap;/);
  assert.match(styles, /\.agent-acceptance-summary > div \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
});

test("输入工具栏与左栏按各自容器切换紧凑模式", () => {
  const app = readFileSync(resolve("src/electron/renderer/App.tsx"), "utf8");
  const styles = readFileSync(resolve("src/electron/renderer/styles.css"), "utf8");
  assert.match(app, /const MIN_LEFT_SIDEBAR_WIDTH = 108/);
  assert.match(app, /className="control-label-short">权限</);
  assert.match(app, /className="control-label-short">模型</);
  assert.match(app, /className="control-label-short">子 Agent</);
  assert.match(styles, /\.left-sidebar \{[\s\S]*container-name: sidebar;[\s\S]*container-type: inline-size;/);
  assert.match(styles, /\.composer-toolbar \{[\s\S]*flex-wrap: wrap;/);
  assert.match(styles, /@container sidebar \(max-width: 210px\)/);
  assert.match(styles, /@container sidebar \(max-width: 140px\)/);
});

test("右侧浏览器按容器降级且三栏不再组合出横向最小宽度", () => {
  const app = readFileSync(resolve("src/electron/renderer/App.tsx"), "utf8");
  const styles = readFileSync(resolve("src/electron/renderer/styles.css"), "utf8");
  assert.match(app, /const MIN_RIGHT_INSPECTOR_WIDTH = 240/);
  assert.match(app, /const MIN_WORKSPACE_WIDTH = 280/);
  assert.match(app, /className="browser-history-action"/);
  assert.match(app, /className="browser-secondary-action"/);
  assert.match(styles, /\.right-inspector \{[\s\S]*container-name: inspector;[\s\S]*container-type: inline-size;/);
  assert.match(styles, /grid-template-columns: minmax\(0, var\(--left-sidebar-width, 236px\)\) minmax\(0, 1fr\) minmax\(0, var\(--right-inspector-width, 520px\)\)/);
  assert.match(styles, /\.browser-tabs \{[\s\S]*overflow-x: auto;/);
  assert.match(styles, /\.browser-surface \{ width: 100%; height: 100%; min-width: 0;/);
  assert.match(styles, /\.browser-address input \{ width: 100%; min-width: 0;/);
  assert.match(styles, /@container inspector \(max-width: 300px\)/);
  assert.doesNotMatch(styles, /@media \(max-width: 900px\)[\s\S]*\.desktop-layout \{ min-width:/);
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
