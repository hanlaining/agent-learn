import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  NOOP_AGENT_EVENT_SINK,
  isAgentEvent,
} from "../src/agent/events.js";
import type { AgentRunStore } from "../src/agents/agent-run-store.js";
import type { AgentRuntimeStore } from "../src/agents/agent-runtime-store.js";
import type { SharedBoardEntry } from "../src/agents/agent-runtime.js";
import {
  filterCommandPaletteItems,
  formatDesktopBinding,
  findLatestAssistantOutput,
  movePaletteSelection,
  resolveDesktopShortcut,
} from "../src/electron/renderer/command-palette.js";
import {
  createComposerMessageInput,
  filterComposerSuggestions,
  findComposerToken,
  moveComposerSelection,
  replaceComposerToken,
  type ComposerSuggestion,
} from "../src/electron/renderer/composer-suggestions.js";
import { loadMcpServerConfigs } from "../src/mcp/mcp-config.js";
import {
  classifyJsonRpcMessage,
  isJsonRpcErrorResponse,
  isJsonRpcMessage,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcSuccessResponse,
} from "../src/protocol/json-rpc.js";
import {
  cloneRuntimeSession,
  isRuntimeSession,
  upsertRuntimeContent,
  type RuntimeContent,
  type RuntimeSession,
} from "../src/runtime/runtime-session.js";
import { createSharedBoardTools } from "../src/tools/shared-board-tools.js";
import { isThread, isTurn, isItem } from "../src/runtime/lifecycle.js";
import { EMPTY_RUNTIME_CAPABILITIES, cloneRuntimeCapabilities, isRuntimeCapabilities, type RuntimeCapabilities } from "../src/app-server/runtime-capabilities.js";
import { CONNECTING_RUNTIME_STATUS, CONNECTED_RUNTIME_STATUS, CLOSED_RUNTIME_STATUS, createSafeRuntimeFailure } from "../src/electron/runtime-status.js";
import { assertExecutionContext } from "../src/execution/execution-context.js";
import { ALLOW_ALL_PERMISSION_GATE } from "../src/permissions/permission-gate.js";
import { isRequirementConfirmed, isDesignConfirmed, type Requirement } from "../src/requirements/requirement.js";
import { CLI_VERSION, CLI_USAGE, parseCliOptions } from "../src/cli/options.js";
import { registerCliInterruptHandler } from "../src/cli/interrupt-handler.js";
import { ExecutionEngineRouter, type StageAdvancingExecutionEngine } from "../src/execution/execution-engine-router.js";
import type { RequirementExecutionKind } from "../src/requirements/requirement.js";
import type { FixedProductStage } from "../src/agents/fixed-software-team-coordinator.js";
import {
  assertExecutionEngineSnapshot,
  assertExecutionFeedback,
} from "../src/execution/execution-engine.js";
import { TokenBudget, estimateMessagesTokens, estimateTextTokens } from "../src/runtime/token-budget.js";
import { ToolOutputLimiter } from "../src/runtime/tool-output-limiter.js";
import { parseTurnRunParams, isTurnRunResult } from "../src/runtime/turn-run.js";
import { parseTurnCancelParams, isTurnCancelResult } from "../src/runtime/turn-cancel.js";
import { createToolArgumentsDigest, createToolInvocationId } from "../src/runtime/tool-invocation.js";
import { assertRuntimeLease, assertRuntimeLeaseResource, runtimeLeaseResourceKey } from "../src/runtime/runtime-lease.js";
import { normalizeAgentTeamConfig } from "../src/agents/agent-runtime.js";
import { ToolRegistry, type AgentTool } from "../src/tools/tool-registry.js";

const NOW = "2026-08-24T00:00:00.000Z";

test("MCP 配置只接受预声明的安全字段并规范化启动边界", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "god-agent-validation-"));
  const configPath = join(directory, "mcp.json");
  context.after(() => rm(directory, { recursive: true, force: true }));

  await writeFile(configPath, JSON.stringify({
    mcpServers: {
      minimal: { command: "node" },
      absolute: {
        command: "node",
        args: ["server.mjs", "--stdio"],
        cwd: resolve(directory, "workspace"),
        requestTimeoutMs: 1_500,
      },
    },
  }), "utf8");

  assert.deepEqual(await loadMcpServerConfigs(configPath), [
    { name: "minimal", command: "node", args: [] },
    {
      name: "absolute",
      command: "node",
      args: ["server.mjs", "--stdio"],
      cwd: resolve(directory, "workspace"),
      requestTimeoutMs: 1_500,
    },
  ]);

  await assert.rejects(
    () => loadMcpServerConfigs("   "),
    /AGENT_MCP_CONFIG must not be empty/,
  );
  await assert.rejects(
    () => loadMcpServerConfigs(join(directory, "missing.json")),
    (error) => error instanceof Error &&
      /Failed to read MCP config/.test(error.message) &&
      error.cause instanceof Error,
  );

  await writeFile(configPath, "{not-json", "utf8");
  await assert.rejects(
    () => loadMcpServerConfigs(configPath),
    /Failed to read MCP config/,
  );

  for (const [value, expected] of [
    [null, /Invalid MCP config root/],
    [[], /Invalid MCP config root/],
    [{ extra: true }, /unsupported field: extra/],
    [{}, /requires mcpServers object/],
    [{ mcpServers: [] }, /requires mcpServers object/],
  ] as const) {
    await writeFile(configPath, JSON.stringify(value), "utf8");
    await assert.rejects(() => loadMcpServerConfigs(configPath), expected);
  }

  for (const [server, expected] of [
    [null, /Invalid MCP Server config: broken/],
    [{}, /command is required: broken/],
    [{ command: "  " }, /command is required: broken/],
    [{ command: 7 }, /command is required: broken/],
    [{ command: "node", args: "--stdio" }, /Invalid MCP Server args: broken/],
    [{ command: "node", args: ["ok", 1] }, /Invalid MCP Server args: broken/],
    [{ command: "node", cwd: "" }, /Invalid MCP Server cwd: broken/],
    [{ command: "node", cwd: 1 }, /Invalid MCP Server cwd: broken/],
    [{ command: "node", requestTimeoutMs: 0 }, /Invalid MCP Server requestTimeoutMs: broken/],
    [{ command: "node", requestTimeoutMs: 1.5 }, /Invalid MCP Server requestTimeoutMs: broken/],
    [{ command: "node", requestTimeoutMs: "1000" }, /Invalid MCP Server requestTimeoutMs: broken/],
  ] as const) {
    await writeFile(configPath, JSON.stringify({ mcpServers: { broken: server } }), "utf8");
    await assert.rejects(() => loadMcpServerConfigs(configPath), expected);
  }
});

test("Composer 建议只识别显式标记并保持替换与选择语义", () => {
  assert.equal(findComposerToken("`code $finance`", 14), undefined);
  assert.equal(findComposerToken("plain text", 4.5), undefined);
  assert.deepEqual(findComposerToken("请读 @src/app.ts 后续", 11), {
    kind: "file",
    trigger: "@",
    query: "src/app",
    start: 3,
    end: 14,
  });

  const suggestions: ComposerSuggestion[] = [
    { id: "one", kind: "skill", value: "finance", label: "Finance", description: "月度汇总", searchText: "money" },
    { id: "two", kind: "skill", value: "review", label: "Reviewer", description: "独立验收" },
  ];
  assert.deepEqual(filterComposerSuggestions(suggestions, " MONEY "), [suggestions[0]]);
  assert.deepEqual(filterComposerSuggestions(suggestions, "", -1), []);

  const token = findComposerToken("运行 $fin 后续", 6);
  assert.ok(token);
  assert.deepEqual(replaceComposerToken("运行 $fin 后续", token, "$finance"), {
    text: "运行 $finance 后续",
    cursor: 11,
  });
  assert.equal(moveComposerSelection(0, -1, 2), 1);
  assert.equal(moveComposerSelection(3, 1, 0), -1);

  assert.deepEqual(createComposerMessageInput(
    "@src/app.ts 与 x@secret，并使用 $review；随后 $review",
    ["src/app.ts", "secret", "src/app.ts"],
    ["review", "review"],
  ), {
    text: "@src/app.ts 与 x@secret，并使用 $review；随后 $review",
    mentions: [{ kind: "file", path: "src/app.ts" }],
    explicitSkills: ["review"],
  });
});

test("Agent Event 在每个公开事件族上 fail closed", () => {
  NOOP_AGENT_EVENT_SINK.emit({ type: "turn/completed", turnId: "turn-1" });

  for (const invalid of [null, [], {}, { type: 1 }]) {
    assert.equal(isAgentEvent(invalid), false);
  }

  const valid = [
    { type: "agent/run_updated", threadId: "thread-1", turnId: "turn-1", run: { id: "run-1", status: "running" } },
    { type: "turn/started", threadId: "thread-1", turnId: "turn-1" },
    { type: "model/started", turnId: "turn-1", round: 0 },
    { type: "model/completed", turnId: "turn-1", round: 1, functionCallCount: 2 },
    { type: "context/compacted", turnId: "turn-1", beforeTokens: 8_000, afterTokens: 4_000 },
    { type: "reasoning/summary_part_added", turnId: "turn-1", round: 0, summaryIndex: 0 },
    { type: "reasoning/summary_delta", turnId: "turn-1", round: 0, summaryIndex: 0, delta: "核验" },
    { type: "reasoning/summary_completed", turnId: "turn-1", round: 0 },
    { type: "web_search/started", turnId: "turn-1", callId: "search-1" },
    { type: "web_search/searching", turnId: "turn-1", callId: "search-1" },
    { type: "web_search/completed", turnId: "turn-1", callId: "search-1" },
    { type: "citation/url_added", turnId: "turn-1", title: "Source", url: "https://example.test", startIndex: 0, endIndex: 4 },
    { type: "tool/started", turnId: "turn-1", callId: "call-1", toolName: "read_file" },
    { type: "tool/completed", turnId: "turn-1", callId: "call-1", toolName: "read_file" },
    { type: "permission/requested", turnId: "turn-1", callId: "call-1", toolName: "write_file" },
    { type: "permission/decided", turnId: "turn-1", callId: "call-1", toolName: "write_file", decision: "allow" },
    { type: "model/output_text_delta", turnId: "turn-1", round: 0, delta: "part" },
    { type: "model/output_text_completed", turnId: "turn-1", round: 0, classification: "assistant", text: "done" },
    { type: "turn/completed", turnId: "turn-1" },
    { type: "turn/failed", turnId: "turn-1", message: "safe" },
    { type: "turn/interrupted", turnId: "turn-1", message: "safe" },
    { type: "turn/timed_out", turnId: "turn-1", message: "safe" },
  ];
  for (const event of valid) assert.equal(isAgentEvent(event), true, String(event.type));

  for (const invalid of [
    { type: "model/completed", turnId: "turn-1", round: 1, functionCallCount: 1.5 },
    { type: "context/compacted", turnId: "turn-1", beforeTokens: 8_000, afterTokens: "4000" },
    { type: "web_search/completed", turnId: "turn-1", callId: "search-1", query: 1 },
    { type: "citation/url_added", turnId: "turn-1", title: "Source", url: "://bad", startIndex: 0, endIndex: 4 },
    { type: "citation/url_added", turnId: "turn-1", title: "Source", url: "https://example.test", startIndex: 5, endIndex: 4 },
    { type: "permission/decided", turnId: "turn-1", callId: "call-1", toolName: "write_file", decision: "allow", reason: 1 },
    { type: "unknown", turnId: "turn-1" },
  ]) assert.equal(isAgentEvent(invalid), false);
});

test("Runtime Session 校验全部内容族且克隆与 upsert 不共享可变状态", () => {
  const items: RuntimeContent[] = [
    { id: "pending", turnId: "turn-1", kind: "pending_output", round: 0, status: "streaming", markdown: "流式" },
    { id: "commentary", turnId: "turn-1", kind: "commentary", round: 0, status: "completed", markdown: "过程" },
    { id: "assistant", turnId: "turn-1", kind: "assistant", round: 0, status: "completed", markdown: "答案" },
    { id: "reasoning", turnId: "turn-1", kind: "reasoning_summary", round: 0, summaryIndex: 0, status: "completed", markdown: "摘要" },
    { id: "activity", turnId: "turn-1", kind: "activity", activityKind: "permission", round: 0, status: "cancelled", title: "等待审批", summary: "已取消", safeDetails: ["用户未批准"] },
    { id: "error", turnId: "turn-1", kind: "error", code: "SAFE", title: "未完成", safeMessage: "请重试", retryable: true },
  ];
  const session: RuntimeSession = { turnId: "turn-1", status: "completed", startedAt: NOW, completedAt: NOW, items };
  assert.equal(isRuntimeSession(session), true);

  const clone = cloneRuntimeSession(session);
  assert.notEqual(clone, session);
  assert.notEqual(clone.items, session.items);
  clone.items[4] = { ...(clone.items[4] as Extract<RuntimeContent, { kind: "activity" }>), safeDetails: ["changed"] };
  assert.deepEqual((session.items[4] as Extract<RuntimeContent, { kind: "activity" }>).safeDetails, ["用户未批准"]);

  const pending = items[0] as Extract<RuntimeContent, { kind: "pending_output" }>;
  const safeError = items[5] as Extract<RuntimeContent, { kind: "error" }>;
  const replacement: RuntimeContent = { ...pending, markdown: "最终流式" };
  assert.deepEqual(upsertRuntimeContent(items, replacement).map((item) => item.id), items.map((item) => item.id));
  assert.equal((upsertRuntimeContent(items, replacement)[0] as Extract<RuntimeContent, { kind: "pending_output" }>).markdown, "最终流式");
  assert.equal(upsertRuntimeContent(items, { ...safeError, id: "new-error" }).length, items.length + 1);

  for (const invalid of [
    { ...session, items: [{ ...items[0], status: "completed" }] },
    { ...session, items: [{ ...items[1], status: "streaming" }] },
    { ...session, items: [{ ...items[3], summaryIndex: -1 }] },
    { ...session, items: [{ ...items[4], activityKind: "network" }] },
    { ...session, items: [{ ...items[4], safeDetails: ["safe", 1] }] },
    { ...session, items: [{ ...items[5], retryable: "yes" }] },
  ]) assert.equal(isRuntimeSession(invalid), false);
});

test("JSON-RPC 分类器拒绝字段冲突、非法 ID 与畸形错误对象", () => {
  const request = { id: "request-1", method: "initialize", params: {} };
  const notification = { method: "initialized", params: {} };
  const success = { id: 0, result: false };
  const failure = { id: "request-1", error: { code: -32_600, message: "Invalid Request", data: { safe: true } } };

  assert.equal(isJsonRpcRequest(request), true);
  assert.equal(isJsonRpcNotification(notification), true);
  assert.equal(isJsonRpcSuccessResponse(success), true);
  assert.equal(isJsonRpcErrorResponse(failure), true);
  for (const message of [request, notification, success, failure]) {
    assert.equal(isJsonRpcMessage(message), true);
  }
  assert.deepEqual([request, notification, success, failure].map(classifyJsonRpcMessage), [
    "request", "notification", "success-response", "error-response",
  ]);

  for (const invalid of [
    null,
    [],
    { id: true, method: "bad-id" },
    { id: 1, method: "conflict", error: { code: -1, message: "bad" } },
    { id: 1, result: {}, error: { code: -1, message: "bad" } },
    { id: 1, error: null },
    { id: 1, error: { code: "-1", message: "bad" } },
    { id: 1, error: { code: -1, message: 7 } },
    { id: 1, error: { code: -1, message: "bad" }, method: "conflict" },
  ]) {
    assert.equal(isJsonRpcMessage(invalid), false);
    assert.equal(classifyJsonRpcMessage(invalid), "invalid");
  }
});

test("命令面板按全部词项过滤并优先读取当前 Runtime 最终输出", () => {
  const items = [
    {
      action: {
        id: "chat.search",
        label: "Search chat",
        description: "查找历史消息",
        category: "chat" as const,
        risk: "read" as const,
        userBindable: true,
        surfaces: ["desktop" as const],
        slashCommand: "/search" as const,
        defaultBindings: ["Primary+K"],
      },
      enabled: true,
    },
    {
      action: {
        id: "chat.new",
        label: "New chat",
        description: "新建任务",
        category: "chat" as const,
        risk: "local-ui" as const,
        userBindable: true,
        surfaces: ["desktop" as const],
      },
      enabled: true,
    },
  ];
  assert.deepEqual(filterCommandPaletteItems(items, " search primary "), [items[0]]);
  assert.deepEqual(filterCommandPaletteItems(items, "   "), items);
  assert.equal(movePaletteSelection(-1, -1, 2), 1);
  assert.equal(movePaletteSelection(4, 1, 2), 0);
  assert.equal(movePaletteSelection(0, 1, 0), -1);

  const messages = [
    { id: "m1", turnId: "t1", role: "assistant" as const, text: "历史答案", createdAt: NOW },
    { id: "m2", turnId: "t1", role: "assistant" as const, text: "  ", createdAt: NOW },
  ];
  const session: RuntimeSession = {
    turnId: "t1",
    status: "completed",
    startedAt: NOW,
    completedAt: NOW,
    items: [
      { id: "blank", turnId: "t1", kind: "assistant", round: 0, status: "completed", markdown: " " },
      { id: "latest", turnId: "t1", kind: "assistant", round: 0, status: "completed", markdown: "当前答案" },
    ],
  };
  assert.equal(findLatestAssistantOutput(messages, session), "当前答案");
  assert.equal(findLatestAssistantOutput(messages, undefined), "历史答案");
  assert.equal(findLatestAssistantOutput([], undefined), undefined);
});

test("Renderer 快捷键与 Composer token 覆盖平台、组合键和边界语义", () => {
  const base = { key: "k", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, isComposing: false };
  assert.equal(resolveDesktopShortcut(base), "chat.search");
  assert.equal(resolveDesktopShortcut({ ...base, key: "n" }), "chat.new");
  assert.equal(resolveDesktopShortcut({ ...base, key: "o" }), "output.copyLatest");
  assert.equal(resolveDesktopShortcut({ ...base, key: "p", shiftKey: true }), "composer.commandPalette");
  for (const event of [
    { ...base, ctrlKey: false, metaKey: false },
    { ...base, altKey: true },
    { ...base, isComposing: true },
    { ...base, shiftKey: true },
    { ...base, key: "x" },
  ]) assert.equal(resolveDesktopShortcut(event), undefined);

  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "Win32" } });
    assert.equal(formatDesktopBinding("Primary+K"), "Ctrl + K");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "MacIntel" } });
    assert.equal(formatDesktopBinding("Primary+Shift+P"), "⌘ + Shift + P");
  } finally {
    if (previousNavigator === undefined) delete (globalThis as { navigator?: unknown }).navigator;
    else Object.defineProperty(globalThis, "navigator", previousNavigator);
  }

  assert.deepEqual(findComposerToken("/help", 5), {
    kind: "slash", trigger: "/", query: "help", start: 0, end: 5,
  });
  assert.equal(findComposerToken("x@file", 6), undefined);
  assert.equal(findComposerToken("`$code`", 5), undefined);
  assert.equal(findComposerToken("$skill", -1), undefined);
  assert.equal(findComposerToken("plain", 99), undefined);
  const slash = findComposerToken("$skill", 3);
  assert.ok(slash);
  assert.deepEqual(replaceComposerToken("$skill", slash, "$review"), {
    text: "$review ", cursor: 8,
  });
  const skillWithSpace = findComposerToken("$ski next", 4);
  assert.ok(skillWithSpace);
  assert.deepEqual(replaceComposerToken("$ski next", skillWithSpace, "$skill"), {
    text: "$skill next", cursor: 6,
  });
  const suggestions: ComposerSuggestion[] = Array.from({ length: 3 }, (_, index) => ({
    id: String(index), kind: "skill", value: `v${index}`, label: `Label ${index}`,
    description: "same", searchText: "extra",
  }));
  assert.equal(filterComposerSuggestions(suggestions, "same", 2).length, 2);
  assert.deepEqual(filterComposerSuggestions(suggestions, "", -1), []);
});

test("共享面板只暴露 Job 可见项并在发布前校验全部字段", async () => {
  const visibleToJob = boardEntry("job-visible", "run-other", "job");
  const visibleToParent = boardEntry("parent-visible", "run-parent", "parent_only");
  const hiddenSibling = boardEntry("sibling-hidden", "run-sibling", "parent_only");
  let jobExists = true;
  let shareBoard = true;
  let publishedInput: Record<string, unknown> | undefined;

  const runtime = {
    getJob: () => jobExists ? { configSnapshot: { shareBoard } } : undefined,
    listBoard: () => [visibleToJob, visibleToParent, hiddenSibling],
    publishBoard: (input: Record<string, unknown>) => {
      publishedInput = input;
      return { id: "published", createdAt: NOW, ...input };
    },
  } as unknown as AgentRuntimeStore;
  const runs = {
    getByTurn: (turnId: string) => turnId === "turn-child" ? {
      id: "run-child",
      jobId: "job-1",
      parentRunId: "run-parent",
    } : undefined,
  } as unknown as AgentRunStore;

  const [readBoard, publishResult] = createSharedBoardTools(runtime, runs);
  assert.ok(readBoard);
  assert.ok(publishResult);
  assert.equal(readBoard.definition.name, "read_shared_board");
  assert.equal(publishResult.definition.name, "publish_shared_result");
  assert.equal(readBoard.requiresPermission, false);
  assert.equal(publishResult.riskLevel, "read");

  const context = { signal: new AbortController().signal, turnId: "turn-child" };
  const read = await readBoard.execute("{}", context);
  assert.deepEqual(read.result, [visibleToJob, visibleToParent]);
  assert.deepEqual(read.modelOutput, [visibleToJob, visibleToParent]);

  const value = {
    kind: "test_result",
    title: "覆盖率门禁",
    summary: "确定性测试已通过",
    confidence: "confirmed",
    visibility: "job",
  };
  const published = await publishResult.execute(JSON.stringify(value), context);
  assert.deepEqual(publishedInput, {
    jobId: "job-1",
    producerRunId: "run-child",
    ...value,
  });
  assert.deepEqual(published.result, {
    id: "published",
    createdAt: NOW,
    jobId: "job-1",
    producerRunId: "run-child",
    ...value,
  });
  assert.deepEqual(published.modelOutput, published.result);

  await assert.rejects(
    async () => readBoard.execute("{}", { signal: context.signal }),
    /requires an active Agent Turn/,
  );
  await assert.rejects(
    async () => readBoard.execute("{}", { ...context, turnId: "missing" }),
    /Agent Run is unavailable/,
  );
  shareBoard = false;
  await assert.rejects(
    async () => readBoard.execute("{}", context),
    /Shared Board is disabled/,
  );
  shareBoard = true;
  jobExists = false;
  await assert.rejects(
    async () => readBoard.execute("{}", context),
    /Shared Board is disabled/,
  );
  jobExists = true;

  await assert.rejects(
    async () => publishResult.execute("{bad-json", context),
    SyntaxError,
  );
  for (const invalid of [
    null,
    [],
    { ...value, kind: "secret" },
    { ...value, title: " " },
    { ...value, title: 1 },
    { ...value, summary: "" },
    { ...value, summary: 1 },
    { ...value, confidence: "guessed" },
    { ...value, visibility: "private" },
  ]) {
    await assert.rejects(
      async () => publishResult.execute(JSON.stringify(invalid), context),
      /Invalid publish_shared_result arguments/,
    );
  }
});

function boardEntry(
  id: string,
  producerRunId: string,
  visibility: SharedBoardEntry["visibility"],
): SharedBoardEntry {
  return {
    id,
    jobId: "job-1",
    producerRunId,
    kind: "fact",
    title: id,
    summary: `summary:${id}`,
    confidence: "supported",
    visibility,
    createdAt: NOW,
  };
}

test("Execution Engine boundary validators cover valid, optional and malformed snapshots", () => {
  assert.doesNotThrow(() => assertExecutionFeedback({ turnId: "turn-1", text: "继续" }));
  for (const invalid of [null, [], {}, { turnId: "turn-1" }, { text: "继续" }, { turnId: " ", text: "继续" }, { turnId: "turn-1", text: " " }, { turnId: "turn-1", text: "继续", extra: true }]) {
    assert.throws(() => assertExecutionFeedback(invalid), /Invalid execution feedback/);
  }

  const valid = {
    engine: "workflow",
    jobId: "job-1",
    workflowVersion: "v3",
    stage: "quality",
    terminal: false,
    phase: "executing",
    recoveryAction: "resume",
    reason: "retryable",
    deadlineAt: "2026-08-24T00:00:00.000Z",
  };
  assert.doesNotThrow(() => assertExecutionEngineSnapshot(valid, { engine: "workflow", jobId: "job-1" }));
  assert.doesNotThrow(() => assertExecutionEngineSnapshot({ engine: "workflow", jobId: "job-1" }, { engine: "workflow", jobId: "job-1" }));
  for (const [value, expected] of [
    [null, { engine: "workflow", jobId: "job-1" }],
    [{ ...valid, engine: "other" }, { engine: "workflow", jobId: "job-1" }],
    [{ ...valid, jobId: "other" }, { engine: "workflow", jobId: "job-1" }],
    [{ ...valid, workflowVersion: " " }, { engine: "workflow", jobId: "job-1" }],
    [{ ...valid, stage: 1 }, { engine: "workflow", jobId: "job-1" }],
    [{ ...valid, terminal: "false" }, { engine: "workflow", jobId: "job-1" }],
    [{ ...valid, deadlineAt: "not-a-date" }, { engine: "workflow", jobId: "job-1" }],
    [{ ...valid, extra: true }, { engine: "workflow", jobId: "job-1" }],
    [{ ...valid, engine: " " }, { engine: " ", jobId: "job-1" }],
  ] as const) {
    assert.throws(() => assertExecutionEngineSnapshot(value, expected), /Invalid execution engine snapshot/);
  }
});

test("Lifecycle 与 Runtime capability/status 边界全部 fail closed", () => {
  const thread = { id: "thread-1", status: "active", kind: "user_chat", createdAt: "now", turnIds: ["turn-1"] };
  const turn = { id: "turn-1", threadId: "thread-1", status: "in_progress", createdAt: "now", itemIds: ["item-1"] };
  const item = { id: "item-1", threadId: "thread-1", turnId: "turn-1", type: "user_message", content: null, createdAt: "now" };
  assert.equal(isThread(thread), true);
  assert.equal(isThread({
    ...thread,
    status: "closed",
    kind: "agent_internal",
    lastActivityAt: "later",
    title: "内部恢复",
    deletedAt: "deleted",
    trashExpiresAt: "expires",
    deleteBatchId: "batch-1",
  }), true);
  assert.equal(isTurn(turn), true);
  assert.equal(isTurn({ ...turn, status: "completed", completedAt: "done" }), true);
  assert.equal(isItem(item), true);
  for (const type of ["assistant_message", "runtime_message", "tool_call", "tool_result"] as const) {
    assert.equal(isItem({ ...item, type }), true, type);
  }
  for (const value of [null, [], { ...thread, status: "bad" }, { ...thread, turnIds: [1] }, { ...thread, kind: "bad" }, { ...thread, deletedAt: 1 }]) assert.equal(isThread(value), false);
  for (const value of [null, [], { ...turn, status: "bad" }, { ...turn, completedAt: 1 }, { ...turn, itemIds: [1] }]) assert.equal(isTurn(value), false);
  const missingContent = { ...item } as Record<string, unknown>;
  delete missingContent.content;
  for (const value of [null, [], { ...item, type: "bad" }, missingContent, { ...item, createdAt: 1 }]) assert.equal(isItem(value), false);

  const capabilities: RuntimeCapabilities = {
    llm: true,
    currentModel: "model",
    models: [{ id: "model", label: "Model", reasoningEfforts: ["low"] }],
    webSearch: true,
    tools: [{ name: "read", description: "read", source: "builtin" }],
    skills: [{ name: "review", description: "review" }],
    mcpServers: [{ name: "mcp", protocolVersion: "1", toolCount: 0 }],
    agents: [{ id: "a", name: "Agent", description: "agent" }],
    multiAgent: { maxConcurrentRuns: 1, maxDepth: 2, maxChildrenPerRun: 3 },
  };
  assert.equal(isRuntimeCapabilities(EMPTY_RUNTIME_CAPABILITIES), true);
  assert.equal(isRuntimeCapabilities(capabilities), true);
  const cloned = cloneRuntimeCapabilities(capabilities);
  cloned.models[0]!.reasoningEfforts!.push("high");
  cloned.tools[0]!.description = "changed";
  assert.deepEqual(capabilities.models[0]!.reasoningEfforts, ["low"]);
  assert.equal(capabilities.tools[0]!.description, "read");
  for (const value of [null, [], { ...capabilities, llm: "yes" }, { ...capabilities, models: [{ id: "", label: "x" }] }, { ...capabilities, tools: [{ name: "x", description: "x", source: "bad" }] }, { ...capabilities, mcpServers: [{ name: "x", protocolVersion: "1", toolCount: -1 }] }, { ...capabilities, multiAgent: { maxConcurrentRuns: 1.5, maxDepth: 0, maxChildrenPerRun: 0 } }]) assert.equal(isRuntimeCapabilities(value), false);
  assert.deepEqual(CONNECTING_RUNTIME_STATUS, { state: "connecting", message: "Runtime 正在连接…" });
  assert.deepEqual(CONNECTED_RUNTIME_STATUS, { state: "connected", message: "Runtime 已连接" });
  assert.deepEqual(CLOSED_RUNTIME_STATUS, { state: "closed", message: "Runtime 已关闭" });
  for (const code of ["start_failed", "handshake_failed", "unexpected_exit"] as const) {
    const status = createSafeRuntimeFailure(code);
    assert.equal(status.state, "failed");
    assert.equal(status.code, code);
    assert.doesNotMatch(status.message, /secret|path|token|undefined/i);
  }
});

test("ExecutionContext、PermissionGate 和 Requirement confirmation 保护边界", async () => {
  const context = { jobId: "job", threadId: "thread", rootRunId: "run", executionKind: "software_change", workflowVersion: "v1" };
  assert.doesNotThrow(() => assertExecutionContext(context));
  assert.doesNotThrow(() => assertExecutionContext({ ...context, drive: async () => ({ output: "ok" }) }));
  for (const value of [null, [], { ...context, jobId: " " }, { ...context, executionKind: "bad" }, { ...context, workflowVersion: " " }, { ...context, extra: true }, { ...context, drive: "not-a-function" }]) assert.throws(() => assertExecutionContext(value), /Invalid execution context/);
  assert.deepEqual(await ALLOW_ALL_PERMISSION_GATE.request({ turnId: "turn", callId: "call", toolName: "read", arguments: "{}" }), { decision: "allow" });

  const base = {
    id: "req", parentThreadId: "thread", revision: 1, status: "confirmed" as const, executionState: "not_started" as const,
    executionKind: "software_change" as const, title: "title", objective: "objective", scope: [], nonGoals: [], constraints: [], deliverables: [], acceptanceCriteria: [], testCases: [], executionSteps: [],
    planArtifact: { path: "plan.md", contentHash: "hash", generatedAt: "now" }, createdAt: "now", updatedAt: "now", confirmedRevision: 1, confirmedContentHash: "hash", confirmedAt: "now",
  } satisfies Requirement;
  assert.equal(isRequirementConfirmed(base), true);
  for (const value of [undefined, { ...base, status: "planned" as const }, { ...base, status: "clarifying" as const }, { ...base, status: "cancelled" as const }, { ...base, confirmedRevision: 2 }, { ...base, confirmedContentHash: "other" }]) assert.equal(isRequirementConfirmed(value), false);
  assert.equal(isDesignConfirmed(base), false);
  const design = { ...base, executionKind: "software_product_delivery" as const, designStatus: "confirmed" as const, designArtifact: { path: "mock", contentHash: "design", generatedAt: "now" }, designConfirmedRevision: 1, designConfirmedContentHash: "design", designConfirmedAt: "now" } satisfies Requirement;
  assert.equal(isDesignConfirmed(design), true);
  const withoutArtifact = { ...design } as Record<string, unknown>;
  delete withoutArtifact.designArtifact;
  for (const value of [{ ...design, designStatus: "draft_ready" as const }, { ...design, designConfirmedRevision: 2 }, { ...design, designConfirmedContentHash: "other" }, withoutArtifact]) assert.equal(isDesignConfirmed(value as unknown as Requirement), false);
});

test("CLI 选项和 Ctrl+C 路由覆盖重复选项、空闲退出与取消竞态", async () => {
  assert.equal(CLI_VERSION, "1.0.0");
  assert.match(CLI_USAGE, /--debug/);
  assert.deepEqual(parseCliOptions([]), { debug: false, help: false, version: false });
  assert.deepEqual(parseCliOptions(["--debug", "--help", "--version", "--debug"]), {
    debug: true,
    help: true,
    version: true,
  });
  assert.throws(() => parseCliOptions(["--unknown"]), /Unknown option: --unknown/);

  let listener: (() => void) | undefined;
  const idleCalls: string[] = [];
  registerCliInterruptHandler({ on: (_event, callback) => { listener = callback; } }, {
    hasActiveTurn: () => false,
    denyPendingPermission: () => idleCalls.push("deny"),
    cancelActiveTurn: () => { idleCalls.push("cancel"); },
    exitIdle: () => idleCalls.push("exit"),
    reportError: (error) => idleCalls.push(`error:${String(error)}`),
  });
  assert.ok(listener);
  listener();
  assert.deepEqual(idleCalls, ["exit"]);

  let rejectCancel: ((reason?: unknown) => void) | undefined;
  const activeCalls: string[] = [];
  registerCliInterruptHandler({ on: (_event, callback) => { listener = callback; } }, {
    hasActiveTurn: () => true,
    denyPendingPermission: () => activeCalls.push("deny"),
    cancelActiveTurn: () => new Promise<void>((_resolve, reject) => { rejectCancel = reject; }),
    exitIdle: () => activeCalls.push("exit"),
    reportError: (error) => activeCalls.push(`error:${String(error)}`),
  });
  listener!();
  assert.deepEqual(activeCalls, ["deny"]);
  rejectCancel!(new Error("cancel failed"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(activeCalls, ["deny", "error:Error: cancel failed"]);
});

test("ExecutionEngineRouter 覆盖唯一路由、反馈、恢复、快照和阶段能力边界", async () => {
  const calls: string[] = [];
  const make = (id: string, supported: string[], stages = true): StageAdvancingExecutionEngine => ({
    id, control: "engine", supports: (kind: RequirementExecutionKind) => supported.includes(kind),
    start: async () => { calls.push(`${id}:start`); return {}; }, resume: async (job: string) => { calls.push(`${id}:resume:${job}`); return {}; }, cancel: async () => undefined, recover: async () => undefined,
    isActive: () => true, provideFeedback: async () => true, validateStart: () => undefined,
    snapshot: (jobId: string) => ({ engine: id, jobId, terminal: false }),
    ...(stages ? { advance: async (_jobId: string, _expectedStage: FixedProductStage) => ({ stage: "lead_return_ready" as const, changed: true }), requestEngineeringRework: async () => undefined } : {}),
  } as unknown as StageAdvancingExecutionEngine);
  const dynamic = make("dynamic", ["software_change"]);
  const product = make("product", ["software_product_delivery"]);
  const router = new ExecutionEngineRouter([dynamic, product]);
  assert.equal(router.control("software_change"), "engine");
  await router.start({ jobId: "job", threadId: "thread", rootRunId: "run", executionKind: "software_change", workflowVersion: "v1" });
  assert.equal(router.isActive("software_change", "job"), true);
  assert.equal(await router.provideFeedback("software_change", "job", { turnId: "turn", text: "feedback" }), true);
  router.validateStart("software_change", []);
  await router.resume("software_change", "job");
  await router.cancel("software_change", "job");
  await router.recover("software_change", "job");
  assert.deepEqual(router.snapshot("software_change", "job"), { engine: "dynamic", jobId: "job", terminal: false });
  assert.deepEqual(await router.advance("software_product_delivery", "job", "lead_return_ready"), { stage: "lead_return_ready", changed: true });
  await router.requestEngineeringRework("software_product_delivery", "job", "task", "fix");
  assert.throws(() => new ExecutionEngineRouter([dynamic]), /requires independent/);
  const ambiguous = new ExecutionEngineRouter([make("a", ["analysis_only"]), make("b", ["analysis_only"])]);
  assert.throws(() => ambiguous.route("analysis_only"), /must be unique/);
  const noStages = new ExecutionEngineRouter([make("n", ["analysis_only"], false), product]);
  assert.equal(await noStages.provideFeedback("analysis_only", "job", { turnId: "turn", text: "x" }), true);
  assert.throws(() => noStages.advance("analysis_only", "job", "lead_return_ready"), /does not expose stages/);
  assert.ok(calls.includes("dynamic:start"));
});

test("Runtime 参数解析、预算、Tool 输出和 Lease 细边界保持 fail closed", () => {
  assert.deepEqual(parseTurnRunParams({ turnId: "turn-1", model: "  ", reasoningEffort: "high" }), {
    turnId: "turn-1", reasoningEffort: "high",
  });
  assert.deepEqual(parseTurnRunParams({ turnId: "turn-1", model: "gpt", reasoningEffort: "unknown" }), {
    turnId: "turn-1", model: "gpt",
  });
  for (const value of [null, [], {}, { turnId: " " }]) assert.throws(() => parseTurnRunParams(value), /turn\/run turnId/);
  assert.equal(isTurnRunResult(null), false);

  assert.deepEqual(parseTurnCancelParams({ turnId: "turn-1" }), { turnId: "turn-1" });
  assert.equal(isTurnCancelResult({ turnId: "turn-1", cancelled: true }), true);
  for (const value of [null, [], {}, { turnId: "turn-1", cancelled: false }, { turnId: 1, cancelled: true }]) {
    assert.equal(isTurnCancelResult(value), false);
  }
  for (const value of [null, [], {}, { turnId: " " }]) assert.throws(() => parseTurnCancelParams(value), /turn\/cancel turnId/);

  const budget = new TokenBudget({ maxContextTokens: 4, compactThresholdTokens: 3, tokenCounter: {
    countText: (value) => value.length,
    countMessages: (messages) => messages.reduce((sum, message) => sum + message.text.length, 0),
  } });
  assert.deepEqual(budget.assess([{ role: "user", text: "abcd" }]), {
    estimatedTokens: 4, remainingTokens: 0, maxContextTokens: 4, compactThresholdTokens: 3, shouldCompact: true,
  });
  assert.throws(() => new TokenBudget({ maxContextTokens: 1, compactThresholdTokens: 2 }), /must not exceed/);
  assert.throws(() => new TokenBudget({ maxContextTokens: 0 }), /positive integer/);
  assert.ok(estimateMessagesTokens([{ role: "user", text: "hello" }]) > 0);
  assert.ok(estimateTextTokens("hello") > 0);

  const limiter = new ToolOutputLimiter({ maxOutputTokens: 2, tokenCounter: {
    countText: (value) => value.length,
    countMessages: () => 0,
  } });
  const untouched = { callId: "a", name: "tool", arguments: "{}", output: "ok" };
  const limited = limiter.limit([untouched, { ...untouched, callId: "b", output: "012345" }]);
  assert.equal(limited[0]?.output, "ok");
  assert.notEqual(limited[1]?.output, "012345");
  assert.throws(() => new ToolOutputLimiter({ maxOutputTokens: 0 }), /positive integer/);

  assert.equal(createToolArgumentsDigest('{"b":2,"a":1}'), createToolArgumentsDigest({ a: 1, b: 2 }));
  assert.notEqual(createToolArgumentsDigest("not-json"), "");
  assert.throws(() => createToolInvocationId({ modelInvocationId: "m", callId: "c", argumentsDigest: "d" }), /toolName/);
  assert.match(createToolInvocationId({ modelInvocationId: "m", callId: "c", name: "tool", argumentsDigest: "d" }), /^tool-invocation-/);

  assert.equal(runtimeLeaseResourceKey({ type: "turn", id: "turn-1" }), "turn\u0000turn-1");
  assert.doesNotThrow(() => assertRuntimeLeaseResource({ type: "job", id: "job-1" }));
  assert.throws(() => assertRuntimeLeaseResource({ type: "bad", id: "x" } as never), /Invalid Runtime lease resource/);
  assert.doesNotThrow(() => assertRuntimeLease({ resource: { type: "turn", id: "turn-1" }, ownerId: "owner", leaseVersion: 1, fencingToken: 1, expiresAt: NOW }));
  assert.throws(() => assertRuntimeLease({ resource: { type: "turn", id: "turn-1" }, ownerId: "", leaseVersion: 1, fencingToken: 1, expiresAt: NOW }), /Invalid Runtime lease/);
});

test("Agent Team 配置对并发、深度、访问模式和空白输入做确定性归一化", async () => {
  const normalized = normalizeAgentTeamConfig({
    maxSubagents: 99,
    maxConcurrent: 0,
    engineeringChatCount: 1,
    maxDepth: 99,
    accessMode: "full_access",
    allowedProfiles: ["coder"],
  });
  assert.equal(normalized.maxSubagents, 10);
  assert.equal(normalized.maxConcurrent, 1);
  assert.equal(normalized.engineeringChatCount, 3);
  assert.equal(normalized.maxDepth, 3);
  assert.equal(normalized.accessMode, "full_access");
  assert.deepEqual(normalized.allowedProfiles, ["coder"]);

  const fallback = normalizeAgentTeamConfig({
    maxSubagents: 1.5,
    maxConcurrent: 5,
    maxDepth: -1,
    accessMode: "unknown" as never,
  });
  assert.equal(fallback.maxSubagents, 10);
  assert.equal(fallback.maxConcurrent, 5);
  assert.equal(fallback.maxDepth, 1);
  assert.equal(fallback.accessMode, "workspace");
});

test("Ctrl+C 活跃 Turn 成功取消时先拒绝挂起权限且不误报错误", async () => {
  let listener: (() => void) | undefined;
  const calls: string[] = [];
  registerCliInterruptHandler({ on: (_event, callback) => { listener = callback; } }, {
    hasActiveTurn: () => true,
    denyPendingPermission: () => { calls.push("deny"); },
    cancelActiveTurn: async () => { calls.push("cancel"); },
    exitIdle: () => { calls.push("exit"); },
    reportError: () => { calls.push("error"); },
  });
  listener!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["deny", "cancel"]);
});

test("Tool Registry 覆盖审批描述、风险默认值、取消和不可序列化输出", async () => {
  const described: AgentTool = {
    definition: { name: "described", description: "d", parameters: {} },
    describePermission: () => "  ",
    execute: () => ({ result: true, modelOutput: true }),
  };
  const registry = new ToolRegistry([described]);
  assert.throws(() => registry.getPermissionDescription("described", "{}"), /description is empty/);
  assert.equal(registry.getRiskLevel("described"), "sensitive");
  assert.equal(registry.requiresPermission("described"), true);

  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(() => registry.execute("described", "{}", controller.signal), /cancelled/);

  const undefinedOutput: AgentTool = {
    definition: { name: "undefined-output", description: "u", parameters: {} },
    requiresPermission: false,
    execute: () => ({ result: true, modelOutput: undefined }),
  };
  const second = new ToolRegistry([undefinedOutput]);
  await assert.rejects(() => second.execute("undefined-output", "{}"), /not JSON serializable/);
});
