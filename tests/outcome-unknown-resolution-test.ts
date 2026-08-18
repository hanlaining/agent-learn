import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { OutcomeUnknownResolutionService } from "../src/runtime/outcome-unknown-resolution-service.js";
import { OutcomeUnknownResolutionStore } from "../src/runtime/outcome-unknown-resolution-store.js";
import { OutcomeUnknownResolutionError, type OutcomeUnknownActor } from "../src/runtime/outcome-unknown-resolution.js";

const operator: OutcomeUnknownActor = {
  id: "desktop-user",
  permissions: ["invocation:view", "invocation:resolve"],
};

test("重复点击使用同一幂等键只产生一条审计和一张重试票据", async () => {
  const { service } = await seededService("model", "none");
  const [record] = service.list(operator);
  assert.ok(record);
  const request = {
    resolutionId: record.resolutionId,
    expectedVersion: record.version,
    idempotencyKey: "retry-click-1",
    resolution: {
      action: "confirm_not_executed_retry" as const,
      reason: "已从 Provider 控制台确认没有执行",
    },
  };

  const first = await service.resolve(operator, request);
  const repeated = await service.resolve(operator, request);

  assert.equal(first.state, "retry_authorized");
  assert.equal(first.audit.length, 1);
  assert.equal(repeated.audit.length, 1);
  assert.equal(repeated.retryTicket?.id, first.retryTicket?.id);
  assert.equal(repeated.retryTicket?.automaticReplay, false);
});

test("过期版本冲突且非法终态转换被拒绝", async () => {
  const { service } = await seededService("model", "none");
  const [record] = service.list(operator);
  assert.ok(record);
  await assert.rejects(
    service.resolve(operator, {
      resolutionId: record.resolutionId,
      expectedVersion: record.version + 1,
      idempotencyKey: "stale-version",
      resolution: { action: "abandon", reason: "版本冲突测试" },
    }),
    errorCode("VERSION_CONFLICT"),
  );
  const resolved = await service.resolve(operator, {
    resolutionId: record.resolutionId,
    expectedVersion: record.version,
    idempotencyKey: "abandon-once",
    resolution: { action: "abandon", reason: "确认不再继续" },
  });
  await assert.rejects(
    service.resolve(operator, {
      resolutionId: record.resolutionId,
      expectedVersion: resolved.version,
      idempotencyKey: "illegal-transition",
      resolution: { action: "mark_manual_required", reason: "不允许复活终态" },
    }),
    errorCode("INVALID_STATE"),
  );
});

test("无查看或处置权限均拒绝，且线程权限不能越界", async () => {
  const { service } = await seededService("model", "none");
  const [record] = service.list(operator);
  assert.ok(record);
  const denied: OutcomeUnknownActor = { id: "viewer", permissions: [] };
  assert.throws(() => service.list(denied), errorCode("FORBIDDEN"));
  assert.throws(
    () => service.resolve({ id: "viewer", permissions: ["invocation:view"] }, {
      resolutionId: record.resolutionId,
      expectedVersion: record.version,
      idempotencyKey: "forbidden",
      resolution: { action: "abandon", reason: "无权操作" },
    }),
    errorCode("FORBIDDEN"),
  );
  assert.throws(
    () => service.list({ ...operator, allowedThreadIds: ["another-thread"] }, "thread-1"),
    errorCode("FORBIDDEN"),
  );
});

test("Tool 潜在副作用必须显式确认未发生后才签发非自动重放票据", async () => {
  const { service } = await seededService("tool", "known");
  const [record] = service.list(operator);
  assert.ok(record);
  await assert.rejects(
    service.resolve(operator, {
      resolutionId: record.resolutionId,
      expectedVersion: record.version,
      idempotencyKey: "tool-retry-without-confirmation",
      resolution: {
        action: "confirm_not_executed_retry",
        reason: "准备重试",
      },
    }),
    errorCode("TOOL_SIDE_EFFECT_CONFIRMATION_REQUIRED"),
  );
  const resolved = await service.resolve(operator, {
    resolutionId: record.resolutionId,
    expectedVersion: record.version,
    idempotencyKey: "tool-retry-confirmed",
    resolution: {
      action: "confirm_not_executed_retry",
      reason: "外部系统确认没有写入",
      toolSideEffectConfirmed: true,
    },
  });
  assert.equal(resolved.retryTicket?.automaticReplay, false);
  assert.equal(resolved.audit[0]?.toolSideEffectConfirmed, true);
});

test("录入外部结果后不生成重试票据并对敏感字段脱敏", async () => {
  const { service } = await seededService("tool", "possible");
  const [record] = service.list(operator);
  assert.ok(record);
  const resolved = await service.resolve(operator, {
    resolutionId: record.resolutionId,
    expectedVersion: record.version,
    idempotencyKey: "external-result-1",
    resolution: {
      action: "record_external_result",
      reason: "从外部作业日志取得最终结果",
      externalResult: {
        summary: "订单创建成功",
        value: { orderId: "order-1", apiToken: "must-not-persist" },
      },
    },
  });
  assert.equal(resolved.state, "external_result_recorded");
  assert.equal(resolved.retryTicket, undefined);
  assert.deepEqual(resolved.externalResult?.value, { orderId: "order-1", apiToken: "[REDACTED]" });
  assert.match(resolved.audit[0]?.externalResultDigest ?? "", /^sha256:/u);
});

test("重启后 outcome_unknown、处置状态、版本和审计完整保留", async () => {
  const directory = await mkdtemp(join(tmpdir(), "god-agent-outcome-resolution-"));
  const statePath = join(directory, "state.json");
  try {
    const firstStore = await OutcomeUnknownResolutionStore.open({ statePath });
    const firstService = new OutcomeUnknownResolutionService(firstStore);
    await register(firstService, "model", "none");
    const [record] = firstService.list(operator);
    assert.ok(record);
    await firstService.resolve(operator, {
      resolutionId: record.resolutionId,
      expectedVersion: record.version,
      idempotencyKey: "persist-manual",
      resolution: { action: "mark_manual_required", reason: "等待供应商人工核对" },
    });

    const restarted = new OutcomeUnknownResolutionService(
      await OutcomeUnknownResolutionStore.open({ statePath }),
    );
    const [restored] = restarted.list(operator);
    assert.equal(restored?.state, "manual_required");
    assert.equal(restored?.version, 2);
    assert.equal(restored?.audit[0]?.idempotencyKey, "persist-manual");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("WAL 只读同步由 Runtime 派生身份与 digest，Tool 默认按最高副作用风险处理", async () => {
  const service = new OutcomeUnknownResolutionService(new OutcomeUnknownResolutionStore());
  await service.syncFromRuntimeSources({
    modelInvocations: [{
      invocationId: "model-wal-1", requestDigest: `sha256:${"1".repeat(64)}`,
      threadId: "thread-wal", turnId: "turn-wal", purpose: "tool_continuation",
      provider: "openai_responses", model: "gpt-5.6-sol", status: "outcome_unknown",
    }],
    toolInvocations: [{
      toolInvocationId: "tool-wal-1", modelInvocationId: "model-wal-1", callId: "call-wal-1",
      toolName: "write_file", argumentsDigest: `sha256:${"2".repeat(64)}`,
      status: "outcome_unknown",
    }],
  });
  const records = service.list(operator, "thread-wal");
  assert.equal(records.length, 2);
  assert.equal(records.find((item) => item.invocationKind === "model")?.requestDigest, `sha256:${"1".repeat(64)}`);
  assert.equal(records.find((item) => item.invocationKind === "tool")?.sideEffectRisk, "known");
  assert.equal(records.find((item) => item.invocationKind === "tool")?.identity.toolName, "write_file");
});

async function seededService(
  kind: "model" | "tool",
  risk: "none" | "possible" | "known",
): Promise<{ store: OutcomeUnknownResolutionStore; service: OutcomeUnknownResolutionService }> {
  let id = 0;
  const store = new OutcomeUnknownResolutionStore({
    now: () => "2026-08-18T08:00:00.000Z",
    createId: (prefix) => `${prefix}-${++id}`,
  });
  const service = new OutcomeUnknownResolutionService(store);
  await register(service, kind, risk);
  return { store, service };
}

function register(
  service: OutcomeUnknownResolutionService,
  kind: "model" | "tool",
  risk: "none" | "possible" | "known",
) {
  return service.registerFromRuntime({
    invocationKind: kind,
    invocationId: `${kind}-invocation-1`,
    requestDigest: `sha256:${"a".repeat(64)}`,
    identity: {
      threadId: "thread-1",
      turnId: "turn-1",
      displayName: kind === "tool" ? "创建订单" : "生成回复",
      ...(kind === "tool" ? { toolName: "create_order", callId: "call-1" } : { provider: "openai", model: "gpt-5.6-sol" }),
    },
    sideEffectRisk: risk,
    unknownReasonCode: "connection_lost_after_dispatch",
  });
}

function errorCode(code: OutcomeUnknownResolutionError["code"]) {
  return (error: unknown) => error instanceof OutcomeUnknownResolutionError && error.code === code;
}
