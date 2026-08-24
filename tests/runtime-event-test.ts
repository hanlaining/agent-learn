import assert from "node:assert/strict";
import test from "node:test";

import {
  createRuntimeCorrelation,
} from "../src/runtime/runtime-correlation.js";
import {
  AGGREGATE_GENERATION_DOMAIN,
  canonicalRuntimeEventJson,
  createAggregateGeneration,
  assertRuntimeEventEnvelope,
  assertRuntimeEventPredecessor,
  createRuntimeEvent,
  digestRuntimeEventEnvelope,
  parseRuntimeEventEnvelope,
  type RuntimeEventPayload,
} from "../src/runtime/runtime-event.js";

function validTaskEvent(payload: RuntimeEventPayload = { status: "running" }) {
  return createRuntimeEvent({
    eventId: "event-task-1-g1",
    eventType: "task.status_changed",
    aggregateType: "task",
    aggregateId: "task-1",
    authorityWriter: "AgentRuntimeStore",
    generationDomain: AGGREGATE_GENERATION_DOMAIN,
    generation: createAggregateGeneration(1),
    correlation: createRuntimeCorrelation({
      threadId: "thread-1",
      turnId: "turn-1",
      jobId: "job-1",
      jobAttempt: 1,
      taskId: "task-1",
      taskAttempt: 1,
      runId: "run-1",
    }),
    causationId: null,
    occurredAt: "2026-08-20T08:00:00.000Z",
    producer: { component: "MultiAgentScheduler", instanceId: "app-1" },
    payload,
  });
}

test("C03 Event Envelope v1 严格 JSON round-trip 并保留完整 lineage", () => {
  const original = validTaskEvent();
  const restored = parseRuntimeEventEnvelope(JSON.parse(JSON.stringify(original)));
  assert.deepEqual(restored, original);
  assert.equal(restored.schemaVersion, 1);
  assert.equal(restored.payloadSchemaVersion, 1);
  assert.equal(restored.correlation.correlationId, "job:job-1");
  assert.equal(Object.isFrozen(restored), true);
});

test("C03 canonical Event JSON 对递归对象键排序且数组保序", () => {
  const first = validTaskEvent({
    zeta: { second: 2, first: 1 },
    alpha: [{ right: true, left: false }, 3],
  });
  const second = validTaskEvent({
    alpha: [{ left: false, right: true }, 3],
    zeta: { first: 1, second: 2 },
  });
  assert.equal(canonicalRuntimeEventJson(first), canonicalRuntimeEventJson(second));
  assert.equal(digestRuntimeEventEnvelope(first), digestRuntimeEventEnvelope(second));
  assert.match(digestRuntimeEventEnvelope(first), /^[0-9a-f]{64}$/u);
});

test("C03 Event digest 绑定完整 Envelope，任一字段变化都会改变摘要", () => {
  const original = validTaskEvent();
  const changed = createRuntimeEvent({
    ...original,
    eventId: "event-task-1-g1-changed",
  });
  assert.notEqual(digestRuntimeEventEnvelope(original), digestRuntimeEventEnvelope(changed));
  assert.equal("digest" in original, false);
});

test("C03 Event digest 对非法 Envelope fail-closed", () => {
  const valid = validTaskEvent();
  assert.throws(
    () => digestRuntimeEventEnvelope({ ...valid, authorityWriter: "LifecycleStore" }),
    /not allowed for task/,
  );
});

test("C03 拒绝字段漂移、空 ID、非法时间和负 generation", () => {
  const valid = validTaskEvent();
  assert.throws(() => assertRuntimeEventEnvelope({ ...valid, unknown: true }), /unknown fields: unknown/);
  assert.throws(() => assertRuntimeEventEnvelope({ ...valid, eventId: "" }), /eventId/);
  assert.throws(() => assertRuntimeEventEnvelope({ ...valid, occurredAt: "2026-08-20 08:00:00Z" }), /canonical UTC/);
  assert.throws(() => assertRuntimeEventEnvelope({ ...valid, generation: -1 }), /aggregate generation/);
  assert.throws(
    () => assertRuntimeEventEnvelope({ ...valid, producer: { ...valid.producer, unknown: true } }),
    /producer has unknown fields/,
  );
});

test("C03 根事件 causationId 为 null，后继事件引用直接前驱 Event ID", () => {
  const root = validTaskEvent();
  assert.equal(root.causationId, null);
  const next = createRuntimeEvent({
    ...root,
    eventId: "event-task-1-g2",
    generation: createAggregateGeneration(2),
    causationId: root.eventId,
  }, root);
  assert.equal(next.causationId, root.eventId);
  assert.throws(() => assertRuntimeEventEnvelope({ ...next, causationId: undefined }), /causationId/);
});

test("C03 aggregate 与 correlation 错投或缺少条件归属时拒绝", () => {
  const valid = validTaskEvent();
  assert.throws(
    () => assertRuntimeEventEnvelope({ ...valid, aggregateId: "task-other" }),
    /task is misrouted/,
  );
  const chatCorrelation = createRuntimeCorrelation({ threadId: "thread-1", turnId: "turn-1" });
  assert.throws(
    () => assertRuntimeEventEnvelope({ ...valid, aggregateType: "return", aggregateId: "return-1", correlation: chatCorrelation }),
    /return requires Job correlation/,
  );
  assert.throws(
    () => assertRuntimeEventEnvelope({
      ...valid,
      aggregateType: "turn",
      aggregateId: "turn-other",
      authorityWriter: "LifecycleStore",
    }),
    /turn is misrouted/,
  );
  assert.throws(
    () => assertRuntimeEventEnvelope({ ...valid, authorityWriter: "LifecycleStore" }),
    /not allowed for task/,
  );
});

test("C03 factory 深拷贝并冻结 Payload/Correlation，拒绝循环和非 JSON 值", () => {
  const payload = { nested: { values: [1, 2] } };
  const event = validTaskEvent(payload);
  payload.nested.values.push(3);
  assert.deepEqual(event.payload, { nested: { values: [1, 2] } });
  assert.equal(Object.isFrozen(event.payload), true);
  assert.equal(Object.isFrozen((event.payload.nested as { values: number[] }).values), true);

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => validTaskEvent(cyclic as RuntimeEventPayload), /cyclic value/);
  assert.throws(() => validTaskEvent({ invalid: Number.NaN }), /non-finite number/);
  assert.throws(() => validTaskEvent({ invalid: undefined } as unknown as RuntimeEventPayload), /JSON values only/);
  const unsafe = JSON.parse(JSON.stringify(event)) as { payload: unknown };
  unsafe.payload = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.throws(() => parseRuntimeEventEnvelope(unsafe), /unsafe object key/);
});

test("C03 Event generation 仅采用 aggregate-local 值，不混用 Snapshot/Lease/Fencing 版本", () => {
  const event = validTaskEvent({
    snapshotGeneration: 99,
    leaseVersion: 12,
    fencingToken: 7,
  });
  assert.equal(event.generation, 1);
  assert.equal(event.generationDomain, "aggregate");
  assert.deepEqual(event.payload, {
    snapshotGeneration: 99,
    leaseVersion: 12,
    fencingToken: 7,
  });
  assert.throws(
    () => assertRuntimeEventEnvelope({ ...event, generation: "99" }),
    /aggregate generation/,
  );
  assert.throws(
    () => assertRuntimeEventEnvelope({ ...event, generationDomain: "snapshot" }),
    /generation domain/,
  );

  if (false) {
    // @ts-expect-error Public factory requires a branded aggregate generation.
    createRuntimeEvent({ ...event, generation: 99 });
  }
});

test("C03 factory 对 causation 执行 self、错误前驱、跨 correlation 与同 aggregate 单调校验", () => {
  const root = validTaskEvent();
  assert.throws(
    () => createRuntimeEvent({
      ...root,
      causationId: root.eventId,
    }, root),
    /cannot cause itself/,
  );
  assert.throws(
    () => createRuntimeEvent({
      ...root,
      eventId: "event-task-1-wrong-predecessor",
      generation: createAggregateGeneration(2),
      causationId: "event-not-root",
    }, root),
    /does not match predecessor/,
  );
  const otherCorrelation = createRuntimeEvent({
    ...root,
    eventId: "event-task-other-root",
    aggregateId: "task-other",
    correlation: createRuntimeCorrelation({
      threadId: "thread-2",
      turnId: "turn-2",
      jobId: "job-2",
      jobAttempt: 1,
      taskId: "task-other",
      taskAttempt: 1,
    }),
  });
  assert.throws(
    () => createRuntimeEvent({
      ...root,
      eventId: "event-task-1-cross",
      generation: createAggregateGeneration(2),
      causationId: otherCorrelation.eventId,
    }, otherCorrelation),
    /another correlation/,
  );
  assert.throws(
    () => createRuntimeEvent({
      ...root,
      eventId: "event-task-1-stale-generation",
      generation: createAggregateGeneration(1),
      causationId: root.eventId,
    }, root),
    /generation must advance/,
  );
});

test("C03 parse 只验证单事件语法，causation 语义由显式 predecessor API 验证", () => {
  const root = validTaskEvent();
  const serialized = JSON.parse(JSON.stringify({
    ...root,
    eventId: "event-task-1-g2",
    generation: 2,
    causationId: root.eventId,
  }));
  const parsed = parseRuntimeEventEnvelope(serialized);
  assert.equal(parsed.causationId, root.eventId);
  assert.doesNotThrow(() => assertRuntimeEventPredecessor(parsed, root));
});

test("C03 Stage、Context 与多态 Runtime Lease 使用精确归属规则", () => {
  const stageCorrelation = createRuntimeCorrelation({
    threadId: "thread-1",
    turnId: "turn-1",
    jobId: "job-1",
    jobAttempt: 1,
    workflowId: "software-product-delivery",
    workflowVersion: "v2",
    stageId: "quality",
    stageAttempt: 1,
  });
  const stage = createRuntimeEvent({
    eventId: "event-stage-quality-1",
    eventType: "stage.checkpointed",
    aggregateType: "stage_checkpoint",
    aggregateId: "quality",
    authorityWriter: "AgentRuntimeStore",
    generationDomain: AGGREGATE_GENERATION_DOMAIN,
    generation: createAggregateGeneration(1),
    correlation: stageCorrelation,
    causationId: null,
    occurredAt: "2026-08-20T08:00:00.000Z",
    producer: { component: "WorkflowTeamCoordinator" },
    payload: { status: "running" },
  });
  assert.equal(stage.aggregateId, "quality");
  assert.throws(
    () => assertRuntimeEventEnvelope({ ...stage, aggregateId: "engineering" }),
    /stage_checkpoint is misrouted/,
  );

  const chatOnly = createRuntimeCorrelation({ threadId: "thread-1", turnId: "turn-1" });
  const context = createRuntimeEvent({
    eventId: "event-context-1",
    eventType: "context.checkpointed",
    aggregateType: "context_checkpoint",
    aggregateId: "checkpoint-1",
    authorityWriter: "ContextCheckpointStore",
    generationDomain: AGGREGATE_GENERATION_DOMAIN,
    generation: createAggregateGeneration(1),
    correlation: chatOnly,
    causationId: null,
    occurredAt: "2026-08-20T08:00:00.000Z",
    producer: { component: "ContextCheckpointStore" },
    payload: {},
  });
  assert.equal(context.correlation.turnId, "turn-1");
  assert.throws(
    () => assertRuntimeEventEnvelope({
      ...context,
      correlation: createRuntimeCorrelation({
        threadId: "thread-1",
        correlationId: "legacy:context:checkpoint-legacy",
        attribution: "legacy_unattributed",
      }),
    }),
    /requires Turn correlation/,
  );

  const leaseCorrelation = createRuntimeCorrelation({
    threadId: "thread-1",
    turnId: "turn-1",
    jobId: "job-1",
    jobAttempt: 1,
    leaseResourceType: "job",
    leaseResourceId: "job-1",
  });
  const lease = createRuntimeEvent({
    eventId: "event-lease-job-1",
    eventType: "lease.acquired",
    aggregateType: "runtime_lease",
    aggregateId: "job-1",
    authorityWriter: "PersistentRuntimeLeaseStore",
    generationDomain: AGGREGATE_GENERATION_DOMAIN,
    generation: createAggregateGeneration(1),
    correlation: leaseCorrelation,
    causationId: null,
    occurredAt: "2026-08-20T08:00:00.000Z",
    producer: { component: "PersistentRuntimeLeaseStore" },
    payload: { ownerId: "app-1" },
  });
  assert.equal(lease.correlation.leaseResourceType, "job");
  assert.throws(
    () => assertRuntimeEventEnvelope({ ...lease, aggregateId: "job-other" }),
    /exact resource correlation/,
  );
});
