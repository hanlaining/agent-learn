import assert from "node:assert/strict";
import test from "node:test";

import { ModelInvocationStore } from "../src/runtime/model-invocation-store.js";
import {
  createModelInvocationId,
  createModelRequestDigest,
} from "../src/runtime/model-invocation.js";

const fixedNow = () => "2026-08-18T12:00:00.000Z";

const baseIdentity = () => ({
  threadId: "thread-1",
  turnId: "turn-1",
  round: 0,
  purpose: "workflow_stage",
  jobId: "job-1",
  jobAttempt: 1,
  stageId: "product",
  stageAttempt: 1,
});

const baseRequest = () => ({
  input: [{ role: "user", content: "build the product plan" }],
  reasoning: { effort: "high" },
  tools: [{ name: "read_file", arguments: { path: "README.md" } }],
});

const baseInput = () => ({
  ...baseIdentity(),
  requestDigest: createModelRequestDigest(baseRequest()),
  provider: "openai",
  model: "gpt-5.6",
});

const normalizedResult = () => ({
  text: "normalized final result",
  functionCalls: [{ callId: "call-1", name: "read_file", arguments: "{\"path\":\"README.md\"}" }],
});

test("invocationId 与 requestDigest 对同一幂等请求稳定，且不受创建顺序和对象键顺序影响", () => {
  const reorderedIdentity = {
    stageAttempt: 1,
    stageId: "product",
    jobAttempt: 1,
    jobId: "job-1",
    purpose: "workflow_stage",
    round: 0,
    turnId: "turn-1",
    threadId: "thread-1",
  };
  const reorderedRequest = {
    tools: [{ arguments: { path: "README.md" }, name: "read_file" }],
    reasoning: { effort: "high" },
    input: [{ content: "build the product plan", role: "user" }],
  };
  assert.equal(createModelInvocationId(baseIdentity()), createModelInvocationId(reorderedIdentity));
  assert.equal(createModelRequestDigest(baseRequest()), createModelRequestDigest(reorderedRequest));

  const left = new ModelInvocationStore(fixedNow);
  left.prepare({ ...baseInput(), purpose: "unrelated" });
  const leftTarget = left.prepare(baseInput());
  const right = new ModelInvocationStore(fixedNow);
  const rightTarget = right.prepare({
    ...reorderedIdentity,
    requestDigest: createModelRequestDigest(reorderedRequest),
    provider: "openai",
    model: "gpt-5.6",
  });

  assert.equal(leftTarget.invocationId, rightTarget.invocationId);
  assert.equal(leftTarget.requestDigest, rightTarget.requestDigest);
  assert.match(leftTarget.requestDigest, /^sha256:[a-f0-9]{64}$/);
  assert.ok(leftTarget.invocationId.length > 0);
});

test("合法主路径严格按 prepared -> submitted -> response_received -> committed 推进", () => {
  const store = new ModelInvocationStore(fixedNow);
  const prepared = store.prepare(baseInput());
  assert.equal(prepared.status, "prepared");

  const submitted = store.markSubmitted(prepared.invocationId);
  assert.equal(submitted.status, "submitted");

  const received = store.recordResponse(prepared.invocationId, {
    providerResponseId: "provider-response-1",
    normalizedResult: normalizedResult(),
  });
  assert.equal(received.status, "response_received");
  assert.deepEqual(received.normalizedResult, normalizedResult());

  const committed = store.markCommitted(prepared.invocationId);
  assert.equal(committed.status, "committed");
  assert.deepEqual(committed.normalizedResult, normalizedResult());
});
test("submitted 在无法确认远端结果时只能进入 outcome_unknown", () => {
  const store = new ModelInvocationStore(fixedNow);
  const invocation = store.prepare(baseInput());
  store.markSubmitted(invocation.invocationId);

  const unknown = store.markOutcomeUnknown(invocation.invocationId, "transport_disconnected_after_submit");

  assert.equal(unknown.status, "outcome_unknown");
  assert.equal(unknown.lastErrorCode, "transport_disconnected_after_submit");
  assert.equal(unknown.normalizedResult, undefined);
});

test("状态机拒绝倒退、跨级 commit 和 outcome_unknown 跨级 committed", () => {
  const store = new ModelInvocationStore(fixedNow);
  const first = store.prepare(baseInput());
  store.markSubmitted(first.invocationId);
  assert.throws(() => store.markCommitted(first.invocationId), /transition|state/i);
  store.recordResponse(first.invocationId, {
    providerResponseId: "provider-response-1",
    normalizedResult: normalizedResult(),
  });
  assert.throws(() => store.markSubmitted(first.invocationId), /transition|state/i);
  assert.throws(
    () => store.markOutcomeUnknown(first.invocationId, "late_disconnect"),
    /transition|state/i,
  );
  store.markCommitted(first.invocationId);
  assert.throws(
    () => store.recordResponse(first.invocationId, {
      providerResponseId: "provider-response-2",
      normalizedResult: normalizedResult(),
    }),
    /transition|state/i,
  );

  const second = store.prepare({ ...baseInput(), purpose: "quality_stage", stageId: "quality" });
  store.markSubmitted(second.invocationId);
  store.markOutcomeUnknown(second.invocationId, "timeout_after_submit");
  assert.throws(() => store.markCommitted(second.invocationId), /transition|state/i);
});

test("重复 prepare 与重复 markCommitted 幂等，不生成第二条 Invocation 或改变已提交事实", () => {
  const store = new ModelInvocationStore(fixedNow);
  const first = store.prepare(baseInput());
  const duplicate = store.prepare(baseInput());
  assert.deepEqual(duplicate, first);
  assert.equal(store.list().length, 1);

  store.markSubmitted(first.invocationId);
  store.recordResponse(first.invocationId, {
    providerResponseId: "provider-response-1",
    normalizedResult: normalizedResult(),
  });
  const committed = store.markCommitted(first.invocationId);
  const committedSnapshot = store.exportSnapshot();

  assert.deepEqual(store.markCommitted(first.invocationId), committed);
  assert.deepEqual(store.exportSnapshot(), committedSnapshot);
  assert.equal(store.list().length, 1);
});

test("snapshot 永不持久化 authorization、apiKey 或其秘密值", () => {
  const store = new ModelInvocationStore(fixedNow);
  const unsafeInput = {
    ...baseInput(),
    authorization: "Bearer top-level-secret",
    apiKey: "sk-top-level-secret",
  } as Parameters<ModelInvocationStore["prepare"]>[0];
  store.prepare(unsafeInput);

  const serialized = JSON.stringify(store.exportSnapshot());
  assert.doesNotMatch(serialized, /authorization|apiKey/i);
  assert.doesNotMatch(serialized, /top-level-secret/);
});

test("snapshot 可导出恢复，并兼容旧 Runtime 中缺失的空 ModelInvocation snapshot", () => {
  const emptyLegacy = ModelInvocationStore.fromSnapshot(undefined);
  assert.deepEqual(emptyLegacy.list(), []);

  const store = new ModelInvocationStore(fixedNow);
  const invocation = store.prepare(baseInput());
  store.markSubmitted(invocation.invocationId);
  const snapshot = store.exportSnapshot();
  const restored = ModelInvocationStore.fromSnapshot(snapshot);

  assert.deepEqual(restored.exportSnapshot(), snapshot);
  assert.deepEqual(restored.get(invocation.invocationId), store.get(invocation.invocationId));
});

test("response_received snapshot 重启后保留 normalizedResult，可直接重放并 commit", () => {
  const store = new ModelInvocationStore(fixedNow);
  const invocation = store.prepare(baseInput());
  store.markSubmitted(invocation.invocationId);
  store.recordResponse(invocation.invocationId, {
    providerResponseId: "provider-response-1",
    normalizedResult: normalizedResult(),
  });

  const restored = ModelInvocationStore.fromSnapshot(store.exportSnapshot());
  const replayable = restored.get(invocation.invocationId);

  assert.equal(replayable?.status, "response_received");
  assert.deepEqual(replayable?.normalizedResult, normalizedResult());
  const committed = restored.markCommitted(invocation.invocationId);
  assert.equal(committed.status, "committed");
  assert.deepEqual(committed.normalizedResult, normalizedResult());
});
