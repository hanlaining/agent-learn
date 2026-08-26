import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import {
  isMonthlyFinanceSummary,
  parseMonthlySummaryRequest,
  summarizeMonthlyTransactions,
} from "../src/domains/finance/summary.js";
import type { Transaction } from "../src/domains/finance/types.js";
import {
  INITIAL_DESKTOP_UI_STATE,
  desktopReducer,
  type DesktopUiState,
} from "../src/electron/renderer/desktop-reducer.js";
import type {
  DesktopActivity,
  DesktopAgentRun,
  DesktopEvent,
  DesktopMessage,
  DesktopSnapshot,
  DesktopThreadSummary,
} from "../src/electron/desktop-types.js";
import {
  isDesktopEvent,
  isDesktopMessageInput,
  isDesktopOutcomeUnknownResolution,
  isDesktopSnapshot,
  isDesktopWorkspaceSearchResult,
} from "../src/electron/desktop-types.js";
import type { RequirementDraft } from "../src/requirements/requirement.js";
import {
  RequirementPlanWriter,
  renderRequirementPlan,
} from "../src/requirements/requirement-plan-writer.js";
import { RequirementStore } from "../src/requirements/requirement-store.js";
import { LifecycleStore } from "../src/runtime/lifecycle-store.js";
import {
  cloneRuntimeSession,
  isRuntimeSession,
  upsertRuntimeContent,
  type RuntimeContent,
  type RuntimeSession,
} from "../src/runtime/runtime-session.js";
import { createPrepareRequirementPlanTool } from "../src/tools/prepare-requirement-plan-tool.js";

const NOW = "2026-08-24T08:00:00.000Z";

test("desktopReducer covers every active-thread event transition and ignores foreign events", () => {
  const withoutSnapshot: DesktopUiState = {
    ...INITIAL_DESKTOP_UI_STATE,
    error: "keep",
  };
  assert.equal(desktopReducer(withoutSnapshot, {
    type: "event",
    event: { type: "reasoning/delta", threadId: "chat", turnId: "turn", summaryIndex: 0, delta: "x" },
  }), withoutSnapshot);

  const initialSnapshot = snapshot();
  let state = desktopReducer(withoutSnapshot, { type: "snapshot", snapshot: initialSnapshot });
  assert.deepEqual(state, {
    snapshot: initialSnapshot,
    activities: [],
    reasoning: "",
    sources: [],
  });

  state = desktopReducer(state, { type: "error", message: "network-safe" });
  assert.equal(state.error, "network-safe");
  state = desktopReducer(state, { type: "clear-error" });
  assert.equal("error" in state, false);

  const outcome = {
    resolutionId: "resolution-1",
    invocationKind: "model" as const,
    invocationId: "invocation-1",
    requestDigest: `sha256:${"a".repeat(64)}`,
    identity: { threadId: "chat", turnId: "turn", displayName: "reply" },
    sideEffectRisk: "none" as const,
    state: "outcome_unknown" as const,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    audit: [],
  };
  state = desktopReducer(state, { type: "outcome-unknown-updated", record: outcome });
  assert.deepEqual(state.snapshot?.outcomeUnknownInvocations, [outcome]);
  state = desktopReducer(state, {
    type: "outcome-unknown-updated",
    record: { ...outcome, state: "abandoned", version: 2 },
  });
  assert.deepEqual(state.snapshot?.outcomeUnknownInvocations?.map(({ state: value, version }) => [value, version]), [["abandoned", 2]]);

  const run = agentRun();
  state = reduceEvent(state, { type: "agent/run_updated", threadId: "chat", turnId: "turn", run });
  assert.deepEqual(state.snapshot?.agentRuns, [run]);
  const updatedRun = { ...run, status: "completed" as const };
  state = reduceEvent(state, { type: "agent/run_updated", threadId: "chat", turnId: "turn", run: updatedRun });
  assert.deepEqual(state.snapshot?.agentRuns, [updatedRun]);
  assertForeignEventIgnored(state, { type: "agent/run_updated", threadId: "other", turnId: "turn", run });

  const runtime = runtimeSession("running");
  state = reduceEvent(state, { type: "runtime/session", threadId: "chat", session: runtime });
  assert.deepEqual(state.runtimeSession, runtime);
  assertForeignEventIgnored(state, { type: "runtime/session", threadId: "other", session: runtime });

  const addedThread = thread("second", 1);
  state = reduceEvent(state, { type: "thread/updated", thread: addedThread });
  assert.deepEqual(state.snapshot?.threads.map(({ id }) => id), ["second", "chat"]);
  state = reduceEvent(state, {
    type: "thread/updated",
    thread: { ...addedThread, title: "renamed", messageCount: 0 },
  });
  assert.equal(state.snapshot?.threads[0]?.title, "renamed");
  assert.equal(state.snapshot?.threads[0]?.messageCount, 1, "a stale update cannot reduce the count");

  state = { ...state, error: "old", reasoning: "old", activities: [activity("old")], sources: [{ title: "old", url: "https://old.test" }] };
  const userMessage = message("user-1", "user", "question");
  state = reduceEvent(state, { type: "message/user", threadId: "chat", message: userMessage });
  assert.equal(state.error, undefined);
  assert.equal(state.runtimeSession, undefined);
  assert.deepEqual(state.activities, []);
  assert.deepEqual(state.sources, []);
  assert.equal(state.snapshot?.messages.at(-1)?.id, "user-1");
  assertForeignEventIgnored(state, { type: "message/user", threadId: "other", message: userMessage });

  state = reduceEvent(state, { type: "assistant/delta", threadId: "chat", turnId: "turn-a", delta: "first" });
  state = reduceEvent(state, { type: "assistant/delta", threadId: "chat", turnId: "turn-a", delta: " second" });
  assert.equal(state.snapshot?.messages.at(-1)?.text, "first second");
  state = reduceEvent(state, { type: "assistant/completed", threadId: "chat", turnId: "turn-a", text: "final" });
  assert.equal(state.snapshot?.messages.at(-1)?.text, "final");
  state = reduceEvent(state, { type: "assistant/completed", threadId: "chat", turnId: "turn-b", text: "standalone" });
  assert.equal(state.snapshot?.messages.at(-1)?.text, "standalone");
  assertForeignEventIgnored(state, { type: "assistant/delta", threadId: "other", turnId: "turn", delta: "ignored" });
  assertForeignEventIgnored(state, { type: "assistant/completed", threadId: "other", turnId: "turn", text: "ignored" });

  state = reduceEvent(state, { type: "reasoning/delta", threadId: "chat", turnId: "turn", summaryIndex: 0, delta: "A" });
  state = reduceEvent(state, { type: "reasoning/delta", threadId: "chat", turnId: "turn", summaryIndex: 1, delta: "B" });
  assert.equal(state.reasoning, "AB");
  assertForeignEventIgnored(state, { type: "reasoning/delta", threadId: "other", turnId: "turn", summaryIndex: 0, delta: "ignored" });

  state = reduceEvent(state, { type: "activity/upsert", threadId: "chat", turnId: "turn", activity: activity("work") });
  state = reduceEvent(state, {
    type: "activity/upsert",
    threadId: "chat",
    turnId: "turn",
    activity: { ...activity("work"), status: "completed" },
  });
  assert.deepEqual(state.activities.map(({ id, status }) => [id, status]), [["work", "completed"]]);
  assertForeignEventIgnored(state, { type: "activity/upsert", threadId: "other", turnId: "turn", activity: activity("ignored") });

  state = reduceEvent(state, { type: "source/added", threadId: "chat", turnId: "turn", title: "one", url: "https://one.test" });
  const sameSourceState = reduceEvent(state, { type: "source/added", threadId: "chat", turnId: "turn", title: "duplicate", url: "https://one.test" });
  assert.equal(sameSourceState, state);
  assertForeignEventIgnored(state, { type: "source/added", threadId: "other", turnId: "turn", title: "ignored", url: "https://ignored.test" });

  state = reduceEvent(state, { type: "turn/state", threadId: "second", turnId: "turn", state: "failed", message: "child failed" });
  assert.equal(state.snapshot?.turnState, "idle");
  assert.equal(state.snapshot?.threads[0]?.turnState, "failed");
  assert.equal(state.error, undefined, "inactive-thread error stays out of the active composer");
  state = reduceEvent(state, { type: "turn/state", threadId: "chat", turnId: "turn", state: "completed" });
  assert.equal(state.snapshot?.turnState, "completed");
  state = reduceEvent(state, { type: "turn/state", threadId: "chat", turnId: "turn", state: "failed", message: "safe failure" });
  assert.equal(state.error, "safe failure");
});

test("snapshot without RuntimeSession clears the previous transient session", () => {
  const prior = { ...INITIAL_DESKTOP_UI_STATE, runtimeSession: runtimeSession("running") };
  const next = desktopReducer(prior, { type: "snapshot", snapshot: snapshot() });
  assert.equal(next.runtimeSession, undefined);
});

test("RuntimeSession accepts every content kind and rejects malformed boundary values", () => {
  const items: RuntimeContent[] = [
    { id: "pending", turnId: "turn", kind: "pending_output", round: 0, status: "streaming", markdown: "partial" },
    { id: "commentary", turnId: "turn", kind: "commentary", round: 1, status: "completed", markdown: "note" },
    { id: "assistant", turnId: "turn", kind: "assistant", round: 1, status: "completed", markdown: "answer" },
    { id: "reasoning", turnId: "turn", kind: "reasoning_summary", round: 1, summaryIndex: 0, status: "streaming", markdown: "summary" },
    { id: "activity", turnId: "turn", kind: "activity", activityKind: "permission", round: 1, status: "cancelled", title: "approval", summary: "closed", safeDetails: ["safe"] },
    { id: "error", turnId: "turn", kind: "error", code: "safe", title: "Failed", safeMessage: "Retry", retryable: false },
  ];
  const base: RuntimeSession = { turnId: "turn", status: "running", startedAt: NOW, items };
  assert.equal(isRuntimeSession(base), true);
  for (const status of ["completed", "failed", "cancelled", "timed_out"] as const) {
    assert.equal(isRuntimeSession({ ...base, status, completedAt: NOW }), true);
  }

  const invalidSessions: unknown[] = [
    null, [], {},
    { ...base, turnId: 1 },
    { ...base, status: "paused" },
    { ...base, startedAt: 1 },
    { ...base, completedAt: 1 },
    { ...base, items: {} },
    { ...base, items: [null] },
    { ...base, items: [{ id: 1, turnId: "turn", kind: "error" }] },
    { ...base, items: [{ id: "x", turnId: 1, kind: "error" }] },
    { ...base, items: [{ id: "x", turnId: "turn", kind: 1 }] },
    { ...base, items: [{ ...items[0], round: -1 }] },
    { ...base, items: [{ ...items[0], round: 0.5 }] },
    { ...base, items: [{ ...items[0], status: "completed" }] },
    { ...base, items: [{ ...items[1], status: "streaming" }] },
    { ...base, items: [{ ...items[2], markdown: 7 }] },
    { ...base, items: [{ ...items[3], summaryIndex: -1 }] },
    { ...base, items: [{ ...items[3], status: "failed" }] },
    { ...base, items: [{ ...items[4], activityKind: "network" }] },
    { ...base, items: [{ ...items[4], status: "timed_out" }] },
    { ...base, items: [{ ...items[4], title: 1 }] },
    { ...base, items: [{ ...items[4], summary: 1 }] },
    { ...base, items: [{ ...items[4], safeDetails: ["safe", 1] }] },
    { ...base, items: [{ ...items[5], code: 1 }] },
    { ...base, items: [{ ...items[5], title: 1 }] },
    { ...base, items: [{ ...items[5], safeMessage: 1 }] },
    { ...base, items: [{ ...items[5], retryable: "yes" }] },
    { ...base, items: [{ id: "x", turnId: "turn", kind: "unknown" }] },
  ];
  for (const invalid of invalidSessions) assert.equal(isRuntimeSession(invalid), false);

  const inserted = upsertRuntimeContent(items, { ...items[0]!, id: "new" });
  assert.equal(inserted.length, items.length + 1);
  assert.notEqual(inserted, items);
  const cloned = cloneRuntimeSession(base);
  (cloned.items[4] as Extract<RuntimeContent, { kind: "activity" }>).safeDetails?.push("changed");
  assert.deepEqual((base.items[4] as Extract<RuntimeContent, { kind: "activity" }>).safeDetails, ["safe"]);
});

test("finance boundary validation, filtering, amount safety and response validation", () => {
  for (const invalid of [null, "2026-08"]) {
    assert.throws(() => parseMonthlySummaryRequest(invalid), /must be an object/u);
  }
  assert.throws(() => parseMonthlySummaryRequest([]), /YYYY-MM/u);
  for (const period of [undefined, "2026-00", "2026-1", "26-01", "2026-13"]) {
    assert.throws(() => parseMonthlySummaryRequest({ period }), /YYYY-MM/u);
  }
  assert.throws(() => parseMonthlySummaryRequest({ period: "2026-08", accountId: 1 }), /accountId/u);
  assert.deepEqual(parseMonthlySummaryRequest({ period: "2026-08" }), { period: "2026-08" });
  assert.deepEqual(parseMonthlySummaryRequest({ period: "2026-08", accountId: "a" }), { period: "2026-08", accountId: "a" });

  const transactions: Transaction[] = [
    transaction("income", { kind: "income", amount: { minorUnits: 1_000, currency: "CNY" } }),
    transaction("expense-a", { kind: "expense", category: "food", amount: { minorUnits: 300, currency: "CNY" } }),
    transaction("expense-b", { kind: "expense", category: "food", amount: { minorUnits: 200, currency: "CNY" } }),
    transaction("expense-c", { kind: "expense", category: "transport", amount: { minorUnits: 700, currency: "CNY" } }),
    transaction("pending", { status: "pending", amount: { minorUnits: -1, currency: "USD" as "CNY" } }),
    transaction("transfer", { kind: "transfer", category: "transfer", amount: { minorUnits: 900, currency: "CNY" } }),
    transaction("other-month", { occurredAt: "2026-07-01T00:00:00.000Z", amount: { minorUnits: -1, currency: "USD" as "CNY" } }),
    transaction("other-account", { accountId: "b", kind: "expense", amount: { minorUnits: 900, currency: "CNY" } }),
  ];
  const summary = summarizeMonthlyTransactions(transactions, { period: "2026-08", accountId: "a" });
  assert.deepEqual(summary, {
    period: "2026-08",
    currency: "CNY",
    totalIncome: { minorUnits: 1_000, currency: "CNY" },
    totalExpense: { minorUnits: 1_200, currency: "CNY" },
    netCashFlow: { minorUnits: -200, currency: "CNY" },
    expensesByCategory: [
      { category: "transport", amount: { minorUnits: 700, currency: "CNY" } },
      { category: "food", amount: { minorUnits: 500, currency: "CNY" } },
    ],
    transactionCount: 4,
  });
  assert.equal(isMonthlyFinanceSummary(summary), true);

  for (const amount of [
    { minorUnits: -1, currency: "CNY" },
    { minorUnits: 1.5, currency: "CNY" },
    { minorUnits: 1, currency: "USD" },
  ]) {
    assert.throws(
      () => summarizeMonthlyTransactions([transaction("bad", { amount: amount as Transaction["amount"] })], { period: "2026-08" }),
      /Invalid amount for transaction: bad/u,
    );
  }

  const invalidSummaries: unknown[] = [
    null, [], {},
    { ...summary, period: 1 },
    { ...summary, currency: "USD" },
    { ...summary, totalIncome: null },
    { ...summary, totalExpense: { minorUnits: 1, currency: "USD" } },
    { ...summary, netCashFlow: { minorUnits: 0.5, currency: "CNY" } },
    { ...summary, transactionCount: 1.5 },
    { ...summary, expensesByCategory: {} },
    { ...summary, expensesByCategory: [{ category: 1, amount: { minorUnits: 1, currency: "CNY" } }] },
    { ...summary, expensesByCategory: [{ category: "food", amount: { minorUnits: "1", currency: "CNY" } }] },
  ];
  for (const invalid of invalidSummaries) assert.equal(isMonthlyFinanceSummary(invalid), false);
});

test("RequirementPlanWriter renders empty sections, sanitizes filenames and returns stable content evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "god-hotpath-plan-"));
  const emptyDraft = draft({
    title: " <>:\"/\\|?* \u0001 ",
    scope: [], nonGoals: [], constraints: [], deliverables: [], acceptanceCriteria: [], executionSteps: [],
  });
  const markdown = renderRequirementPlan("requirement-9", 3, emptyDraft);
  assert.match(markdown, /^# /u);
  assert.equal((markdown.match(/- 无/gu) ?? []).length, 6);
  assert.match(markdown, /TC-01 positive path/u);
  assert.match(markdown, /open → verify/u);

  const writer = new RequirementPlanWriter(root, () => NOW);
  const first = await writer.write({ requirementId: "requirement-9", revision: 3, draft: emptyDraft });
  const second = await writer.write({ requirementId: "requirement-9", revision: 3, draft: emptyDraft });
  assert.equal(first.generatedAt, NOW);
  assert.equal(first.contentHash, second.contentHash);
  assert.equal(basename(first.path), "------------requirement-9-v3.md");
  assert.equal(await readFile(first.path, "utf8"), markdown);

  const fallbackArtifact = await writer.write({ requirementId: "requirement-empty", revision: 1, draft: draft({ title: "   " }) });
  assert.equal(basename(fallbackArtifact.path), "requirement-plan-requirement-empty-v1.md");

  const longTitle = "a".repeat(100);
  const longArtifact = await writer.write({ requirementId: "requirement-10", revision: 1, draft: draft({ title: longTitle }) });
  assert.equal(basename(longArtifact.path).startsWith(`${"a".repeat(60)}-requirement-10-v1.md`), true);
});

test("prepare_requirement_plan enforces parent-turn and strict draft boundaries before persistence", async () => {
  const root = await mkdtemp(join(tmpdir(), "god-hotpath-tool-"));
  const lifecycleStore = new LifecycleStore({ now: () => NOW });
  const requirementStore = new RequirementStore(() => NOW);
  let persistCalls = 0;
  const tool = createPrepareRequirementPlanTool({
    lifecycleStore,
    requirementStore,
    writer: new RequirementPlanWriter(root, () => NOW),
    persist: async () => { persistCalls += 1; },
  });
  const signal = new AbortController().signal;
  assert.equal(tool.definition.name, "prepare_requirement_plan");
  assert.equal(tool.requiresPermission, false);
  assert.equal(tool.riskLevel, "read");
  await assert.rejects(async () => tool.execute(JSON.stringify(draft()), { signal }), /requires a parent Turn/u);
  await assert.rejects(async () => tool.execute(JSON.stringify(draft()), { signal, turnId: "missing" }), /Turn is unavailable/u);

  const internal = lifecycleStore.createThread("agent_internal");
  const internalTurn = lifecycleStore.createTurn(internal.id);
  await assert.rejects(async () => tool.execute(JSON.stringify(draft()), { signal, turnId: internalTurn.id }), /Only the parent Chat/u);

  const parent = lifecycleStore.createThread();
  const turn = lifecycleStore.createTurn(parent.id);
  const invalidDrafts: Array<[string, unknown, RegExp]> = [
    ["invalid JSON", "{", /Invalid requirement plan arguments/u],
    ["array", [], /Invalid requirement plan arguments/u],
    ["execution kind", { ...draft(), executionKind: "execute_everything" }, /executionKind/u],
    ["title type", { ...draft(), title: 1 }, /title/u],
    ["blank objective", { ...draft(), objective: "   " }, /objective/u],
    ["scope type", { ...draft(), scope: ["ok", 1] }, /scope/u],
    ["test cases empty", { ...draft(), testCases: [] }, /testCases/u],
    ["test case scalar", { ...draft(), testCases: [1] }, /testCases/u],
    ["test case id", { ...draft(), testCases: [{ ...draft().testCases[0], id: 1 }] }, /testCases/u],
    ["test case title", { ...draft(), testCases: [{ ...draft().testCases[0], title: 1 }] }, /testCases/u],
    ["test case kind", { ...draft(), testCases: [{ ...draft().testCases[0], kind: "unsafe" }] }, /testCases/u],
    ["test case steps", { ...draft(), testCases: [{ ...draft().testCases[0], steps: [1] }] }, /testCases/u],
    ["test case expected", { ...draft(), testCases: [{ ...draft().testCases[0], expected: 1 }] }, /testCases/u],
  ];
  for (const [label, value, pattern] of invalidDrafts) {
    const input = label === "invalid JSON" ? String(value) : JSON.stringify(value);
    await assert.rejects(async () => tool.execute(input, { signal, turnId: turn.id }), pattern, label);
  }
  assert.equal(persistCalls, 0);

  const execution = await tool.execute(JSON.stringify(draft()), { signal, turnId: turn.id });
  assert.equal(persistCalls, 1);
  assert.deepEqual(execution.modelOutput, {
    status: "awaiting_user_confirmation",
    requirementId: "requirement-1",
    revision: 1,
    planPath: (execution.result as { planArtifact: { path: string } }).planArtifact.path,
    contentHash: (execution.result as { planArtifact: { contentHash: string } }).planArtifact.contentHash,
    testCaseCount: 1,
    message: "计划已保存。等待用户通过确认按钮确认该版本后再执行。",
  });
  assert.equal(requirementStore.getActive(parent.id)?.status, "planned");
});

test("desktop protocol validators accept complete payloads and reject malformed nested boundaries", () => {
  assert.equal(isDesktopMessageInput({ text: "hello" }), true);
  assert.equal(isDesktopMessageInput({
    text: "hello",
    mentions: [{ kind: "file", path: "src/index.ts" }],
    explicitSkills: ["finance"],
  }), true);
  for (const invalid of [
    null, [], {}, { text: 1 }, { text: "x", extra: true },
    { text: "x", mentions: "bad" },
    { text: "x", mentions: Array.from({ length: 21 }, () => ({ kind: "file", path: "x" })) },
    { text: "x", mentions: [null] },
    { text: "x", mentions: [{ kind: "skill", path: "x" }] },
    { text: "x", mentions: [{ kind: "file", path: 1 }] },
    { text: "x", mentions: [{ kind: "file", path: "x", extra: true }] },
    { text: "x", explicitSkills: "bad" },
    { text: "x", explicitSkills: Array.from({ length: 21 }, () => "x") },
    { text: "x", explicitSkills: [1] },
  ]) assert.equal(isDesktopMessageInput(invalid), false);

  assert.equal(isDesktopWorkspaceSearchResult({ query: "a", paths: ["a.ts"], truncated: false }), true);
  for (const invalid of [null, { query: 1, paths: [], truncated: false }, { query: "a", paths: {}, truncated: false }, { query: "a", paths: [1], truncated: false }, { query: "a", paths: [], truncated: "no" }]) {
    assert.equal(isDesktopWorkspaceSearchResult(invalid), false);
  }

  const outcome = validOutcome();
  assert.equal(isDesktopOutcomeUnknownResolution(outcome), true);
  for (const invalid of [
    null,
    { ...outcome, resolutionId: 1 },
    { ...outcome, invocationKind: "command" },
    { ...outcome, invocationId: 1 },
    { ...outcome, requestDigest: "sha256:bad" },
    { ...outcome, identity: null },
    { ...outcome, identity: { ...outcome.identity, threadId: 1 } },
    { ...outcome, identity: { ...outcome.identity, turnId: 1 } },
    { ...outcome, identity: { ...outcome.identity, displayName: 1 } },
    { ...outcome, sideEffectRisk: "impossible" },
    { ...outcome, state: "unknown" },
    { ...outcome, version: 1.5 },
    { ...outcome, createdAt: 1 },
    { ...outcome, updatedAt: 1 },
    { ...outcome, audit: {} },
  ]) assert.equal(isDesktopOutcomeUnknownResolution(invalid), false);

  const completeSnapshot: DesktopSnapshot = {
    ...snapshot(),
    activeAgentThreadId: "child",
    messages: [message("message", "assistant", "answer")],
    runtimeSession: runtimeSession("running"),
    agentConfig: {
      ...snapshot().agentConfig,
      agentTeam: { mode: "off" } as NonNullable<DesktopSnapshot["agentConfig"]["agentTeam"]>,
    },
    agentRuns: [{
      ...agentRun(),
      parentRunId: "parent",
      coordinationStatus: "waiting_review",
      attentionLevel: "active",
      statusMessage: "working",
      failureOrigin: "runtime",
      safeError: "safe",
    }],
    trash: [],
    outcomeUnknownInvocations: [outcome],
  };
  assert.equal(isDesktopSnapshot(completeSnapshot), true);
  const invalidSnapshots: unknown[] = [
    null,
    { ...completeSnapshot, threads: {} },
    { ...completeSnapshot, threads: [{ ...completeSnapshot.threads[0], id: 1 }] },
    { ...completeSnapshot, threads: [{ ...completeSnapshot.threads[0], title: 1 }] },
    { ...completeSnapshot, threads: [{ ...completeSnapshot.threads[0], status: "deleted" }] },
    { ...completeSnapshot, threads: [{ ...completeSnapshot.threads[0], createdAt: 1 }] },
    { ...completeSnapshot, threads: [{ ...completeSnapshot.threads[0], lastActivityAt: 1 }] },
    { ...completeSnapshot, threads: [{ ...completeSnapshot.threads[0], messageCount: -1 }] },
    { ...completeSnapshot, threads: [{ ...completeSnapshot.threads[0], turnState: "unknown" }] },
    { ...completeSnapshot, threads: [{ ...completeSnapshot.threads[0], model: 1 }] },
    { ...completeSnapshot, threads: [{ ...completeSnapshot.threads[0], reasoningEffort: "extreme" }] },
    { ...completeSnapshot, activeThreadId: 1 },
    { ...completeSnapshot, activeAgentThreadId: 1 },
    { ...completeSnapshot, messages: {} },
    { ...completeSnapshot, messages: [{ ...completeSnapshot.messages[0], role: "system" }] },
    { ...completeSnapshot, capabilities: null },
    { ...completeSnapshot, capabilities: { ...completeSnapshot.capabilities, llm: "yes" } },
    { ...completeSnapshot, capabilities: { ...completeSnapshot.capabilities, webSearch: "no" } },
    { ...completeSnapshot, capabilities: { ...completeSnapshot.capabilities, tools: {} } },
    { ...completeSnapshot, capabilities: { ...completeSnapshot.capabilities, skills: {} } },
    { ...completeSnapshot, capabilities: { ...completeSnapshot.capabilities, mcpServers: {} } },
    { ...completeSnapshot, turnState: "unknown" },
    { ...completeSnapshot, runtimeSession: {} },
    { ...completeSnapshot, agentConfig: null },
    { ...completeSnapshot, agentConfig: { ...completeSnapshot.agentConfig, model: 1 } },
    { ...completeSnapshot, agentConfig: { ...completeSnapshot.agentConfig, reasoningEffort: "extreme" } },
    { ...completeSnapshot, agentConfig: { ...completeSnapshot.agentConfig, agentProfileId: 1 } },
    { ...completeSnapshot, agentConfig: { ...completeSnapshot.agentConfig, agentTeam: [] } },
    { ...completeSnapshot, agentRuns: {} },
    { ...completeSnapshot, agentRuns: [{ ...completeSnapshot.agentRuns[0], id: 1 }] },
    { ...completeSnapshot, agentRuns: [{ ...completeSnapshot.agentRuns[0], jobId: 1 }] },
    { ...completeSnapshot, agentRuns: [{ ...completeSnapshot.agentRuns[0], rootRunId: 1 }] },
    { ...completeSnapshot, agentRuns: [{ ...completeSnapshot.agentRuns[0], attempt: 1.5 }] },
    { ...completeSnapshot, agentRuns: [{ ...completeSnapshot.agentRuns[0], threadId: 1 }] },
    { ...completeSnapshot, agentRuns: [{ ...completeSnapshot.agentRuns[0], turnId: 1 }] },
    { ...completeSnapshot, agentRuns: [{ ...completeSnapshot.agentRuns[0], agentProfileId: 1 }] },
    { ...completeSnapshot, agentRuns: [{ ...completeSnapshot.agentRuns[0], parentRunId: 1 }] },
    { ...completeSnapshot, agentRuns: [{ ...completeSnapshot.agentRuns[0], status: "unknown" }] },
    { ...completeSnapshot, agentRuns: [{ ...completeSnapshot.agentRuns[0], task: 1 }] },
    { ...completeSnapshot, agentRuns: [{ ...completeSnapshot.agentRuns[0], depth: -1 }] },
    { ...completeSnapshot, agentRuns: [{ ...completeSnapshot.agentRuns[0], coordinationStatus: "unknown" }] },
    { ...completeSnapshot, agentRuns: [{ ...completeSnapshot.agentRuns[0], attentionLevel: "unknown" }] },
    { ...completeSnapshot, agentRuns: [{ ...completeSnapshot.agentRuns[0], statusMessage: 1 }] },
    { ...completeSnapshot, agentRuns: [{ ...completeSnapshot.agentRuns[0], failureOrigin: "unknown" }] },
    { ...completeSnapshot, agentRuns: [{ ...completeSnapshot.agentRuns[0], safeError: 1 }] },
    { ...completeSnapshot, trash: {} },
    { ...completeSnapshot, outcomeUnknownInvocations: {} },
    { ...completeSnapshot, outcomeUnknownInvocations: [{}] },
  ];
  for (const invalid of invalidSnapshots) assert.equal(isDesktopSnapshot(invalid), false);
});

test("desktop event validator covers each event family, URL safety and nested records", () => {
  const events: DesktopEvent[] = [
    { type: "agent/run_updated", threadId: "chat", turnId: "turn", run: agentRun() },
    { type: "runtime/session", threadId: "chat", session: runtimeSession("running") },
    { type: "thread/updated", thread: thread("chat", 0) },
    { type: "message/user", threadId: "chat", message: message("message", "user", "question") },
    { type: "assistant/delta", threadId: "chat", turnId: "turn", delta: "part" },
    { type: "assistant/completed", threadId: "chat", turnId: "turn", text: "answer" },
    { type: "reasoning/delta", threadId: "chat", turnId: "turn", summaryIndex: 0, delta: "reason" },
    { type: "activity/upsert", threadId: "chat", turnId: "turn", activity: activity("activity") },
    { type: "source/added", threadId: "chat", turnId: "turn", title: "source", url: "https://example.test/path" },
    { type: "turn/state", threadId: "chat", turnId: "turn", state: "thinking" },
    { type: "turn/state", threadId: "chat", turnId: "turn", state: "failed", message: "safe" },
  ];
  for (const event of events) assert.equal(isDesktopEvent(event), true);
  const invalid: unknown[] = [
    null, [], {}, { type: 1 }, { type: "unknown" },
    { ...events[0], threadId: 1 }, { ...events[0], turnId: 1 }, { ...events[0], run: {} },
    { ...events[1], threadId: 1 }, { ...events[1], session: {} },
    { ...events[2], thread: {} },
    { ...events[3], threadId: 1 }, { ...events[3], message: { ...message("x", "assistant", "x") } },
    { ...events[4], threadId: 1 }, { ...events[4], turnId: 1 }, { ...events[4], delta: 1 },
    { ...events[5], text: 1 },
    { ...events[6], summaryIndex: 0.5 }, { ...events[6], delta: 1 },
    { ...events[7], activity: {} },
    { ...events[7], activity: { ...activity("a"), kind: "unknown" } },
    { ...events[7], activity: { ...activity("a"), status: "unknown" } },
    { ...events[7], activity: { ...activity("a"), label: 1 } },
    { ...events[8], url: "file:///secret" }, { ...events[8], url: "not a url" }, { ...events[8], title: 1 },
    { ...events[9], state: "unknown" }, { ...events[9], message: 1 },
  ];
  for (const event of invalid) assert.equal(isDesktopEvent(event), false);
});

function snapshot(): DesktopSnapshot {
  return {
    threads: [thread("chat", 0)],
    activeThreadId: "chat",
    messages: [],
    capabilities: { llm: false, models: [], webSearch: false, tools: [], skills: [], mcpServers: [] },
    turnState: "idle",
    agentConfig: { model: "test-model", reasoningEffort: "high", agentProfileId: "orchestrator" },
    agentRuns: [],
  };
}

function thread(id: string, messageCount: number): DesktopThreadSummary {
  return {
    id, title: id, status: "active", createdAt: NOW, lastActivityAt: NOW,
    messageCount, turnState: "idle", model: "test-model", reasoningEffort: "high",
  };
}

function agentRun(): DesktopAgentRun {
  return {
    id: "run", jobId: "job", rootRunId: "run", attempt: 1, threadId: "child", turnId: "child-turn",
    agentProfileId: "tester", status: "running", task: "verify", depth: 1,
  };
}

function runtimeSession(status: RuntimeSession["status"]): RuntimeSession {
  return { turnId: "turn", status, startedAt: NOW, items: [] };
}

function message(id: string, role: DesktopMessage["role"], text: string): DesktopMessage {
  return { id, turnId: "turn", role, text, createdAt: NOW };
}

function activity(id: string): DesktopActivity {
  return { id, kind: "tool", status: "running", label: id };
}

function validOutcome() {
  return {
    resolutionId: "resolution",
    invocationKind: "model" as const,
    invocationId: "invocation",
    requestDigest: `sha256:${"b".repeat(64)}`,
    identity: { threadId: "chat", turnId: "turn", displayName: "reply" },
    sideEffectRisk: "none" as const,
    state: "outcome_unknown" as const,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    audit: [],
  };
}

function reduceEvent(state: DesktopUiState, event: DesktopEvent): DesktopUiState {
  return desktopReducer(state, { type: "event", event });
}

function assertForeignEventIgnored(state: DesktopUiState, event: DesktopEvent): void {
  assert.equal(reduceEvent(state, event), state);
}

function transaction(id: string, overrides: Partial<Transaction> = {}): Transaction {
  return {
    id,
    accountId: "a",
    kind: "expense",
    status: "posted",
    category: "other",
    amount: { minorUnits: 100, currency: "CNY" },
    description: id,
    occurredAt: "2026-08-01T00:00:00.000Z",
    createdAt: NOW,
    ...overrides,
  };
}

function draft(overrides: Partial<RequirementDraft> = {}): RequirementDraft {
  return {
    executionKind: "analysis_only",
    title: "coverage plan",
    objective: "exercise public behavior",
    scope: ["covered scope"],
    nonGoals: ["no source changes"],
    constraints: ["deterministic"],
    deliverables: ["tests"],
    acceptanceCriteria: ["assertions pass"],
    testCases: [{ id: "TC-01", title: "positive path", kind: "positive", steps: ["open", "verify"], expected: "success" }],
    executionSteps: ["run"],
    ...overrides,
  };
}
