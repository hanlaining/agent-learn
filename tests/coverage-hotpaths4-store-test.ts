import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createModelRequestDigest,
  type ModelInvocationSnapshot,
} from "../src/runtime/model-invocation.js";
import { ModelInvocationStore } from "../src/runtime/model-invocation-store.js";
import {
  LifecycleStore,
  type LifecycleSnapshot,
} from "../src/runtime/lifecycle-store.js";
import {
  createToolArgumentsDigest,
  type ToolInvocationSnapshot,
} from "../src/runtime/tool-invocation.js";
import { ToolInvocationStore } from "../src/runtime/tool-invocation-store.js";
import { RequirementStore } from "../src/requirements/requirement-store.js";
import type { RequirementDraft } from "../src/requirements/requirement.js";
import { RequirementDesignWriter, renderRequirementDesign } from "../src/requirements/requirement-design-writer.js";

const NOW = "2026-08-24T08:00:00.000Z";
const DIGEST = `sha256:${"a".repeat(64)}`;

const requirementDraft: RequirementDraft = {
  executionKind: "analysis_only", title: "coverage", objective: "close state boundaries",
  scope: ["src/**"], nonGoals: ["scope widening"], constraints: ["confirmed only"],
  deliverables: ["evidence"], acceptanceCriteria: ["terminal mapping"],
  testCases: [{ id: "TC-R", title: "state", kind: "permission", steps: ["prepare"], expected: "closed" }],
  executionSteps: ["prepare", "confirm", "execute"],
};

function modelInput() {
  return {
    threadId: "thread-coverage-4",
    turnId: "turn-coverage-4",
    round: 0,
    purpose: "workflow_stage",
    jobId: "job-coverage-4",
    jobAttempt: 1,
    stageId: "engineering",
    stageAttempt: 1,
    requestDigest: createModelRequestDigest({ input: "deterministic" }),
    provider: "offline-test-provider",
    model: "deterministic-model",
  };
}

function toolInput() {
  return {
    modelInvocationId: "model-invocation-coverage-4",
    callId: "call-coverage-4",
    toolName: "read_file",
    argumentsDigest: createToolArgumentsDigest({ path: "README.md" }),
  };
}

test("ModelInvocationStore 对身份、租约、响应和状态转换统一 fail closed", () => {
  assert.throws(
    () => ModelInvocationStore.fromSnapshot({ version: 2, invocations: [] } as unknown as ModelInvocationSnapshot),
    /Invalid model invocation snapshot/,
  );

  const store = new ModelInvocationStore(() => NOW);
  const prepared = store.prepare(modelInput());
  assert.equal(store.get("missing"), undefined);
  assert.throws(() => store.markSubmitted("missing"), /not found/);
  assert.throws(
    () => store.prepare({ ...modelInput(), invocationId: "forged" }),
    /stable invocation identity/,
  );
  assert.throws(
    () => store.prepare({ ...modelInput(), provider: "different-provider" }),
    /prepared facts mismatch/,
  );
  assert.throws(() => store.acquireLease(prepared.invocationId, "", 1), /leaseOwner/);
  assert.throws(() => store.acquireLease(prepared.invocationId, "owner-a", 0), /positive integer/);
  const leased = store.acquireLease(prepared.invocationId, "owner-a", 1_000);
  assert.equal(leased.leaseOwner, "owner-a");
  assert.throws(
    () => store.acquireLease(prepared.invocationId, "owner-b", 1_000),
    /already held/,
  );
  assert.throws(() => store.releaseLease(prepared.invocationId, "owner-b"), /owner mismatch/);
  assert.equal(store.releaseLease(prepared.invocationId, "owner-a").leaseOwner, undefined);

  store.markSubmitted(prepared.invocationId);
  assert.throws(
    () => store.recordResponse(prepared.invocationId, {
      providerResponseId: "",
      normalizedResult: { text: "", functionCalls: [] },
    }),
    /providerResponseId/,
  );
  assert.throws(
    () => store.recordResponse(prepared.invocationId, {
      providerResponseId: "response-bad",
      normalizedResult: { text: "ok", functionCalls: [{}] } as never,
    }),
    /normalized result/,
  );
  const received = store.recordResponse(prepared.invocationId, {
    providerResponseId: "response-good",
    normalizedResult: {
      text: "ok",
      functionCalls: [{ callId: "call-1", name: "read_file", arguments: "not-json" }],
    },
  });
  assert.equal(received.normalizedResult?.functionCalls[0]?.arguments, "not-json");
  assert.throws(
    () => store.markCommitted(prepared.invocationId, ""),
    /targetCommitKey/,
  );
});

test("ModelInvocationStore 拒绝损坏、重复和自相矛盾的持久化快照", () => {
  const store = new ModelInvocationStore(() => NOW);
  const prepared = store.prepare(modelInput());
  const valid = store.exportSnapshot();
  const entry = valid.invocations[0]!;

  assert.throws(
    () => ModelInvocationStore.fromSnapshot({ version: 1, invocations: [entry, entry] }),
    /Duplicate model invocation ID/,
  );
  for (const candidate of [
    null,
    { ...entry, status: "impossible" },
    { ...entry, dispatchAttempts: -1 },
    { ...entry, requestDigest: "sha256:bad" },
    { ...entry, invocationId: "forged" },
    { ...entry, submittedAt: "not-a-timestamp" },
    { ...entry, normalizedResult: { text: 1, functionCalls: [] } },
    { ...entry, jobAttempt: -1 },
  ]) {
    assert.throws(
      () => ModelInvocationStore.fromSnapshot({ version: 1, invocations: [candidate] } as unknown as ModelInvocationSnapshot),
    );
  }

  assert.throws(() => new ModelInvocationStore().prepare({ ...modelInput(), round: -1 }), /round/);
  assert.throws(() => new ModelInvocationStore().prepare({ ...modelInput(), purpose: "" }), /purpose/);
  assert.throws(() => new ModelInvocationStore().prepare({ ...modelInput(), requestDigest: DIGEST.slice(0, -1) }), /requestDigest/);
  assert.throws(() => new ModelInvocationStore().prepare({ ...modelInput(), stageAttempt: -1 }), /stageAttempt/);
  assert.equal(prepared.status, "prepared");
});

test("ToolInvocationStore 对稳定身份、提交键、结果和终态统一 fail closed", () => {
  assert.throws(
    () => ToolInvocationStore.fromSnapshot({ version: 2, invocations: [] } as unknown as ToolInvocationSnapshot),
    /Invalid tool invocation snapshot/,
  );

  const store = new ToolInvocationStore(() => NOW);
  const prepared = store.prepare(toolInput());
  assert.equal(store.get("missing"), undefined);
  assert.throws(() => store.markExecuting("missing"), /not found/);
  assert.throws(
    () => store.prepare({ ...toolInput(), toolInvocationId: "forged" }),
    /stable tool invocation identity/,
  );
  assert.throws(
    () => store.prepare({ ...toolInput(), targetCommitKey: "turn:1" }),
    /prepared facts mismatch/,
  );
  assert.throws(() => new ToolInvocationStore().prepare({ ...toolInput(), toolName: "" }), /toolName/);
  assert.throws(() => new ToolInvocationStore().prepare({ ...toolInput(), argumentsDigest: DIGEST.slice(0, -1) }), /argumentsDigest/);

  store.markExecuting(prepared.toolInvocationId);
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.throws(
    () => store.recordResult(prepared.toolInvocationId, { result: cyclic, output: "{}" }),
    /JSON-compatible/,
  );
  assert.throws(
    () => store.recordResult(prepared.toolInvocationId, { result: {}, output: 1 } as never),
    /normalized result/,
  );
  const received = store.recordResult(prepared.toolInvocationId, {
    result: { ok: true },
    output: "not-json",
  });
  assert.equal(received.output, "not-json");
  assert.throws(() => store.markCommitted(prepared.toolInvocationId), /target commit key is required/);
  const committed = store.markCommitted(prepared.toolInvocationId, "turn:1");
  assert.equal(committed.status, "committed");
  assert.throws(
    () => store.markCommitted(prepared.toolInvocationId, "turn:2"),
    /target commit key mismatch/,
  );
  assert.throws(() => store.markExecuting(prepared.toolInvocationId), /Invalid tool invocation transition/);

  const unknownStore = new ToolInvocationStore(() => NOW);
  const unknown = unknownStore.prepare({ ...toolInput(), callId: "call-unknown" });
  unknownStore.markExecuting(unknown.toolInvocationId);
  const first = unknownStore.markOutcomeUnknown(unknown.toolInvocationId, "crash");
  assert.deepEqual(unknownStore.markOutcomeUnknown(unknown.toolInvocationId), first);
});

test("ToolInvocationStore 拒绝损坏、重复和不完整的持久化快照", () => {
  const store = new ToolInvocationStore(() => NOW);
  store.prepare(toolInput());
  const valid = store.exportSnapshot();
  const entry = valid.invocations[0]!;

  assert.throws(
    () => ToolInvocationStore.fromSnapshot({ version: 1, invocations: [entry, entry] }),
    /Duplicate tool invocation ID/,
  );
  for (const candidate of [
    null,
    { ...entry, status: "impossible" },
    { ...entry, toolInvocationId: "forged" },
    { ...entry, executionAttempts: -1 },
    { ...entry, status: "result_received", result: undefined, output: undefined },
    { ...entry, status: "committed", result: {}, output: "{}", targetCommitKey: undefined },
    { ...entry, executingAt: "not-a-timestamp" },
    { ...entry, lastErrorCode: "" },
  ]) {
    assert.throws(
      () => ToolInvocationStore.fromSnapshot({ version: 1, invocations: [candidate] } as unknown as ToolInvocationSnapshot),
    );
  }
});

test("LifecycleStore 的终态操作和缺失引用保持 fail closed", () => {
  const store = new LifecycleStore({ now: () => NOW });
  const closed = store.createThread();
  closed.status = "closed";
  assert.throws(() => store.createTurn(closed.id), /not active/);

  const thread = store.createThread();
  const completed = store.createTurn(thread.id);
  store.completeTurn(completed.id);
  assert.throws(() => store.completeTurn(completed.id), /cannot be completed/);
  assert.throws(() => store.resumeInterruptedTurn(completed.id), /cannot be resumed/);

  const failed = store.createTurn(thread.id);
  store.failTurn(failed.id);
  assert.throws(() => store.failTurn(failed.id), /cannot be failed/);
  assert.throws(() => store.completeInterruptedTurn(failed.id), /cannot be recovered/);

  const interrupted = store.createTurn(thread.id);
  store.interruptTurn(interrupted.id);
  assert.throws(() => store.interruptTurn(interrupted.id), /cannot be interrupted/);

  const timedOut = store.createTurn(thread.id);
  store.timeoutTurn(timedOut.id);
  assert.throws(() => store.timeoutTurn(timedOut.id), /cannot time out/);
  assert.throws(() => store.getItemsForTurn("missing-turn"), /Turn not found/);

  const active = store.createTurn(thread.id);
  active.itemIds.push("missing-item");
  assert.throws(() => store.getItemsForTurn(active.id), /Item not found/);
});

test("LifecycleStore 快照拒绝重复和孤儿引用并过滤非法删除批次", () => {
  const store = new LifecycleStore({ now: () => NOW });
  const thread = store.createThread();
  const turn = store.createTurn(thread.id);
  const item = store.appendItem(turn.id, "user_message", { text: "stable" });
  const valid = store.exportSnapshot();

  assert.throws(
    () => LifecycleStore.fromSnapshot({
      ...valid,
      threads: [{ ...valid.threads[0]!, turnIds: [turn.id, turn.id] }],
    }),
    /Invalid lifecycle snapshot/,
  );
  assert.throws(
    () => LifecycleStore.fromSnapshot({
      ...valid,
      threads: [{ ...valid.threads[0]!, turnIds: [] }],
      turns: [],
    }),
    /Invalid lifecycle snapshot/,
  );
  assert.throws(
    () => LifecycleStore.fromSnapshot({
      ...valid,
      threads: [valid.threads[0]!, { ...valid.threads[0]!, turnIds: [] }],
    }),
    /Invalid lifecycle snapshot/,
  );

  const restored = LifecycleStore.fromSnapshot({
    ...valid,
    deleteBatches: [
      { id: "valid-batch", threadIds: [thread.id], createdAt: NOW, status: "completed" },
      { id: "invalid-batch", threadIds: [1], createdAt: NOW, status: "completed" },
    ],
  } as unknown as LifecycleSnapshot);
  assert.deepEqual(restored.listDeleteBatches().map((batch) => batch.id), ["valid-batch"]);
  assert.equal(restored.getItem(item.id)?.id, item.id);
});

test("RequirementStore 快照、设计硬门、筛选与全部执行状态保持 fail closed", () => {
  assert.deepEqual(RequirementStore.fromSnapshot(undefined).list(), []);
  assert.throws(() => RequirementStore.fromSnapshot({ version: 2 } as never), /Invalid requirement snapshot/);
  let tick = 0;
  const store = new RequirementStore(() => `2026-08-24T09:00:${String(tick++).padStart(2, "0")}.000Z`);
  const artifact = { path: "D:/plans/coverage.md", contentHash: "b".repeat(64), generatedAt: NOW };
  const planned = store.prepare("chat-r", requirementDraft, artifact);
  assert.throws(() => store.attachJob(planned.id, "job-early"), /not confirmed/);
  assert.throws(() => store.confirmDesign(planned.id, planned.revision, artifact.contentHash), /changed or is unavailable/);
  assert.throws(() => store.requestDesignRevision(planned.id, planned.revision, "change"), /unavailable/);
  store.confirm(planned.id, planned.revision, artifact.contentHash);
  const design = { path: "D:/plans/design.md", contentHash: "c".repeat(64), generatedAt: NOW };
  store.markDesignDraft(planned.id, planned.revision, design);
  assert.throws(() => store.requestDesignRevision(planned.id, planned.revision, "  "), /feedback is required/);
  assert.throws(() => store.markDesignDraft(planned.id, planned.revision + 1, design), /must be confirmed/);

  assert.equal(store.setStatus(planned.id, "executing").executionState, "executing");
  assert.equal(store.setStatus(planned.id, "completed").executionState, "completed");
  assert.equal(store.setStatus(planned.id, "failed_retryable").executionState, "failed_retryable");
  assert.equal(store.setStatus(planned.id, "cancelled").executionState, "cancelled");
  assert.equal(store.getActive("chat-r"), undefined);
  assert.equal(store.setExecutionState(planned.id, "not_started").status, "confirmed");
  assert.equal(store.setExecutionState(planned.id, "executing").status, "executing");

  const second = store.prepare("chat-s", { ...requirementDraft, title: "second" }, { ...artifact, contentHash: "d".repeat(64) });
  assert.deepEqual(store.list("chat-s").map((item) => item.id), [second.id]);
  assert.equal(store.get("missing"), undefined);
  assert.throws(() => store.confirm("missing", 1, artifact.contentHash), /Requirement not found/);
  const snapshot = store.exportSnapshot();
  delete (snapshot.requirements[0] as Partial<(typeof snapshot.requirements)[number]>).executionKind;
  delete (snapshot.requirements[0] as Partial<(typeof snapshot.requirements)[number]>).executionState;
  const restored = RequirementStore.fromSnapshot(snapshot);
  snapshot.requirements[0]!.title = "tampered";
  assert.equal(restored.get(planned.id)?.executionKind, "software_change");
  assert.equal(restored.get(planned.id)?.executionState, "executing");
  assert.notEqual(restored.get(planned.id)?.title, "tampered");
});

test("RequirementDesignWriter 只渲染受限结构化 Mock，非法或重复页面安全退回文本原型", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "god-design-writer-coverage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new RequirementStore(() => NOW);
  const artifact = { path: join(root, "plan.md"), contentHash: "f".repeat(64), generatedAt: NOW };
  const planned = store.prepare("chat-design", { ...requirementDraft, title: ' <产品> / "安全" ' }, artifact);
  const requirement = store.confirm(planned.id, planned.revision, artifact.contentHash);
  const mockSpec = `prefix MOCK_SPEC:${JSON.stringify({
    initialScreen: "home",
    screens: [
      null,
      { id: "home", title: "", description: 7, states: ["默认 <safe>", 9], actions: [
        null, { label: "打开详情", to: "detail", feedback: "已打开 & 验证", state: "ready" }, { label: "   " },
      ] },
      { id: "detail", title: "详情页", description: "含有 \"引号\"", states: [], actions: [{ label: "仅反馈", feedback: "done" }] },
    ],
  })} trailing text`;
  const writer = new RequirementDesignWriter(root, () => NOW);
  const written = await writer.write({ requirement, productDesign: "  安全产品原稿  ", mockPreview: mockSpec });
  assert.match(written.contentHash, /^[a-f0-9]{64}$/);
  assert.match(written.path, /产品.*安全.*requirement-1-v1-设计稿与Mock\.md$/);
  const markdown = await readFile(written.path, "utf8");
  const html = await readFile(written.mockPreview!, "utf8");
  assert.equal(markdown, renderRequirementDesign(requirement, "  安全产品原稿  ", mockSpec));
  assert.match(html, /&lt;产品&gt;/);
  assert.match(html, /data-screen="0"/);
  assert.match(html, /data-to="1"/);
  assert.match(html, /data-feedback="已打开 &amp; 验证"/);
  assert.match(html, /页面 1\/2/);
  assert.doesNotMatch(html, /<safe>/);

  for (const [suffix, preview, expected] of [
    ["duplicate", 'MOCK_SPEC:{"initialScreen":"x","screens":[{"id":"x"},{"id":"x"}]}', /等待补充|MOCK_SPEC/],
    ["malformed", "MOCK_SPEC:{not-json}", /MOCK_SPEC:\{not-json\}/],
    ["missing-object", "MOCK_SPEC: no object", /MOCK_SPEC: no object/],
    ["empty", "   ", /等待补充交互说明/],
  ] as const) {
    const fallbackRequirement = { ...requirement, id: `requirement-${suffix}`, title: suffix };
    const fallback = await writer.write({ requirement: fallbackRequirement, productDesign: "draft", mockPreview: preview });
    assert.match(await readFile(fallback.mockPreview!, "utf8"), expected);
  }
});
