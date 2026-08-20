import assert from "node:assert/strict";
import test from "node:test";

import {
  assertRuntimeCausationId,
  assertRuntimeCorrelation,
  createRuntimeCorrelation,
  deriveLegacyUnattributedCorrelationId,
  deriveRuntimeCorrelationId,
} from "../src/runtime/runtime-correlation.js";

test("C02 同一 Job 的 Task/Run 使用同一稳定 correlationId", () => {
  const first = createRuntimeCorrelation({
    threadId: "thread-1",
    turnId: "turn-1",
    jobId: "job-1",
    jobAttempt: 1,
    taskId: "task-1",
    taskAttempt: 1,
    runId: "run-1",
  });
  const second = createRuntimeCorrelation({
    threadId: "thread-1",
    turnId: "turn-1",
    jobId: "job-1",
    jobAttempt: 1,
    taskId: "task-2",
    taskAttempt: 1,
    runId: "run-2",
  });
  assert.equal(first.correlationId, "job:job-1");
  assert.equal(second.correlationId, first.correlationId);
  assert.equal(Object.isFrozen(first), true);
});

test("C02 不同 Job 不相关，普通 Chat Turn 使用 turn namespace", () => {
  assert.notEqual(
    deriveRuntimeCorrelationId({ jobId: "job-a", turnId: "turn-1" }),
    deriveRuntimeCorrelationId({ jobId: "job-b", turnId: "turn-1" }),
  );
  assert.equal(deriveRuntimeCorrelationId({ turnId: "turn-chat" }), "turn:turn-chat");
  assert.throws(() => deriveRuntimeCorrelationId({}), /requires jobId or turnId/);
});

test("C02 Legacy 无法回填时使用确定性 namespace 并明确降级归因", () => {
  const correlationId = deriveLegacyUnattributedCorrelationId("return", "return-old-1");
  const first = createRuntimeCorrelation({
    threadId: "thread-old",
    correlationId,
    attribution: "legacy_unattributed",
  });
  const second = createRuntimeCorrelation({
    threadId: "thread-old",
    correlationId: deriveLegacyUnattributedCorrelationId("return", "return-old-1"),
    attribution: "legacy_unattributed",
  });
  assert.equal(first.correlationId, "legacy:return:return-old-1");
  assert.deepEqual(second, first);
  assert.throws(
    () => createRuntimeCorrelation({ threadId: "thread-old", correlationId: "random", attribution: "legacy_unattributed" }),
    /canonical encoding/,
  );
});

test("C02 Legacy canonical 编码拒绝冒号分段碰撞", () => {
  const left = deriveLegacyUnattributedCorrelationId("return:a", "b");
  const right = deriveLegacyUnattributedCorrelationId("return", "a:b");
  assert.equal(left, "legacy:return%3Aa:b");
  assert.equal(right, "legacy:return:a%3Ab");
  assert.notEqual(left, right);
  assert.throws(
    () => assertRuntimeCorrelation({
      schemaVersion: 1,
      correlationId: "legacy:return:a:b",
      threadId: "thread-old",
      attribution: "legacy_unattributed",
    }),
    /canonical encoding/,
  );
});

test("C02 严格拒绝未知字段、空白 ID 和伪造 correlationId", () => {
  const valid = createRuntimeCorrelation({ threadId: "thread-1", turnId: "turn-1" });
  assert.throws(
    () => assertRuntimeCorrelation({ ...valid, unexpected: true }),
    /unknown fields: unexpected/,
  );
  assert.throws(
    () => createRuntimeCorrelation({ threadId: " thread-1", turnId: "turn-1" }),
    /threadId/,
  );
  assert.throws(
    () => assertRuntimeCorrelation({ ...valid, correlationId: "turn:other" }),
    /does not match/,
  );
});

test("C02 Task、Run、Model、Tool 和 Workflow lineage 缺条件字段时 fail-closed", () => {
  assert.throws(
    () => createRuntimeCorrelation({
      threadId: "thread-1",
      turnId: "turn-1",
      jobId: "job-1",
      jobAttempt: 1,
      taskId: "task-1",
    }),
    /Task correlation is incomplete/,
  );
  assert.throws(
    () => createRuntimeCorrelation({ threadId: "thread-1", turnId: "turn-1", runId: "run-1" }),
    /Run correlation is incomplete/,
  );
  assert.throws(
    () => createRuntimeCorrelation({ threadId: "thread-1", turnId: "turn-1", toolInvocationId: "tool-1" }),
    /Tool Invocation correlation is incomplete/,
  );
  assert.throws(
    () => createRuntimeCorrelation({
      threadId: "thread-1",
      turnId: "turn-1",
      jobId: "job-1",
      jobAttempt: 1,
      stageId: "quality",
    }),
    /Workflow correlation is incomplete/,
  );
});

test("C02 native Job lineage 必须绑定 attempt，Legacy attribution 显式保留降级", () => {
  assert.throws(
    () => createRuntimeCorrelation({
      threadId: "thread-1",
      turnId: "turn-1",
      jobId: "job-1",
      runId: "run-1",
    }),
    /requires jobAttempt/,
  );
  assert.throws(
    () => createRuntimeCorrelation({
      threadId: "thread-1",
      turnId: "turn-1",
      jobId: "job-1",
      taskId: "task-1",
      taskAttempt: 1,
    }),
    /requires jobAttempt/,
  );
  const legacy = createRuntimeCorrelation({
    threadId: "thread-old",
    turnId: "turn-old",
    jobId: "job-old",
    runId: "run-old",
    attribution: "legacy_derived",
  });
  assert.equal(legacy.correlationId, "job:job-old");
  assert.equal(legacy.jobAttempt, undefined);
  assert.equal(legacy.attribution, "legacy_derived");
});

test("C02 causationId 根事件统一接受 null，非根引用必须是安全 Event ID", () => {
  assert.doesNotThrow(() => assertRuntimeCausationId(null));
  assert.doesNotThrow(() => assertRuntimeCausationId("event-previous"));
  assert.throws(() => assertRuntimeCausationId(undefined), /causationId/);
  assert.throws(() => assertRuntimeCausationId(" event-previous"), /causationId/);
});

test("C02 Lease correlation 必须绑定资源类型、资源 ID 与对应 lineage", () => {
  const valid = createRuntimeCorrelation({
    threadId: "thread-1",
    turnId: "turn-1",
    jobId: "job-1",
    jobAttempt: 1,
    leaseResourceType: "job",
    leaseResourceId: "job-1",
  });
  assert.equal(valid.leaseResourceId, "job-1");
  assert.throws(
    () => createRuntimeCorrelation({
      threadId: "thread-1",
      turnId: "turn-1",
      jobId: "job-1",
      jobAttempt: 1,
      leaseResourceType: "job",
      leaseResourceId: "job-other",
    }),
    /does not match Runtime lineage/,
  );
  assert.throws(
    () => createRuntimeCorrelation({
      threadId: "thread-1",
      turnId: "turn-1",
      leaseResourceType: "turn",
    }),
    /Lease correlation is incomplete/,
  );
});
