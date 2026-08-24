import assert from "node:assert/strict";
import test from "node:test";

import {
  createFixtureTransport,
  loadProviderSmokeConfig,
  redactProviderSmokeLog,
  runProviderCapabilitySmoke,
  validateLiveProviderSmokeConfig,
} from "../src/llm/provider-capability-smoke.js";

test("默认配置是离线模式且 fixture 不产生真实调用", async () => {
  const config = loadProviderSmokeConfig({ OPENAI_API_KEY: "fixture-key-must-not-be-read" });
  const fixture = createFixtureTransport();
  const report = await runProviderCapabilitySmoke({ config, transport: fixture, now: () => new Date("2026-08-18T00:00:00.000Z") });

  assert.equal(config.mode, "offline");
  assert.equal(config.apiKey, undefined);
  assert.equal(report.status, "completed");
  assert.equal(report.liveCalls, 0);
  assert.equal(report.requests, 5);
  assert.equal(fixture.requests.length, 5);
  assert.ok(fixture.requests.every((request) => request.url.includes("api.openai.com")));
  const retryRequests = fixture.requests.filter((request) => request.operation === "retry");
  assert.equal(retryRequests.length, 2);
  assert.equal(
    new Headers(retryRequests[0]?.init.headers).get("idempotency-key"),
    new Headers(retryRequests[1]?.init.headers).get("idempotency-key"),
  );
});

test("真实模式缺任一闸门时立即阻断且不触发 transport", async () => {
  const config = loadProviderSmokeConfig({
    PROVIDER_SMOKE_LIVE: "1",
    PROVIDER_SMOKE_API_KEY: "sk-live-secret",
    PROVIDER_SMOKE_MODEL: "gpt-5.6-sol",
    PROVIDER_SMOKE_MODEL_ALLOWLIST: "gpt-5.6-sol",
    PROVIDER_SMOKE_OPERATIONS: "create",
    PROVIDER_SMOKE_MAX_REQUESTS: "1",
    PROVIDER_SMOKE_MAX_REQUEST_COST_USD: "0.01",
    // 故意缺少总预算和超时。
  });
  const calls: unknown[] = [];
  const report = await runProviderCapabilitySmoke({
    config,
    transport: { request: async (request) => { calls.push(request); return new Response("{}"); } },
  });

  assert.equal(report.status, "blocked");
  assert.equal(calls.length, 0);
  assert.match(report.reason ?? "", /total budget/);
  assert.match(report.reason ?? "", /timeout/);
  assert.doesNotMatch(report.reason ?? "", /sk-live-secret/);
});

test("真实模式拒绝不在白名单中的模型", () => {
  const config = loadProviderSmokeConfig({
    PROVIDER_SMOKE_LIVE: "1",
    PROVIDER_SMOKE_API_KEY: "secret",
    PROVIDER_SMOKE_MODEL: "gpt-private",
    PROVIDER_SMOKE_MODEL_ALLOWLIST: "gpt-5.6-sol",
    PROVIDER_SMOKE_OPERATIONS: "create",
    PROVIDER_SMOKE_MAX_REQUESTS: "1",
    PROVIDER_SMOKE_MAX_REQUEST_COST_USD: "0.01",
    PROVIDER_SMOKE_MAX_TOTAL_COST_USD: "0.01",
    PROVIDER_SMOKE_TIMEOUT_MS: "1000",
  });
  assert.ok(validateLiveProviderSmokeConfig(config).some((item) => item.includes("allowlist")));
});

test("预算闸门按单次与总额分别生效", async () => {
  const config = loadProviderSmokeConfig({
    PROVIDER_SMOKE_LIVE: "1",
    PROVIDER_SMOKE_API_KEY: "secret",
    PROVIDER_SMOKE_MODEL: "gpt-5.6-sol",
    PROVIDER_SMOKE_MODEL_ALLOWLIST: "gpt-5.6-sol",
    PROVIDER_SMOKE_OPERATIONS: "create,create",
    PROVIDER_SMOKE_MAX_REQUESTS: "2",
    PROVIDER_SMOKE_MAX_REQUEST_COST_USD: "0.01",
    PROVIDER_SMOKE_MAX_TOTAL_COST_USD: "0.01",
    PROVIDER_SMOKE_TIMEOUT_MS: "1000",
  });
  const report = await runProviderCapabilitySmoke({ config, transport: createFixtureTransport() });
  assert.equal(report.status, "blocked");
  assert.match(report.reason ?? "", /worst-case paid attempts/);
  assert.equal(report.requests, 0);
});

test("日志脱敏不会泄漏 key、Bearer 或秘密字段", () => {
  const result = redactProviderSmokeLog({ authorization: "Bearer sk-live-secret", apiKey: "key_abc123", nested: "token=tok_secret", raw: "sk-proj-fixture-secret" });
  assert.doesNotMatch(result, /sk-live-secret|abc123|tok_secret|proj-fixture-secret/);
  assert.match(result, /REDACTED/);
});

test("能力矩阵明确区分未接线能力与 exactly-once 声明", async () => {
  const config = loadProviderSmokeConfig({});
  const report = await runProviderCapabilitySmoke({ config, transport: createFixtureTransport() });
  assert.equal(report.matrix.idempotencyKey, "not-wired");
  assert.equal(report.matrix.requestStatusQuery, "not-wired");
  assert.equal(report.matrix.cancellation, "not-wired");
  assert.equal(report.matrix.exactlyOnceClaim, "not-claimed");
  assert.match(report.matrix.evidence, /Idempotency-Key/);
});

test("openai-compatible Smoke 使用真实 Chat Completions 路径和消息体", async () => {
  const config = loadProviderSmokeConfig({
    PROVIDER_SMOKE_PROVIDER: "openai-compatible",
    PROVIDER_SMOKE_MODEL: "gundam-fixture",
    PROVIDER_SMOKE_BASE_URL: "http://127.0.0.1:18800/v1",
    PROVIDER_SMOKE_OPERATIONS: "create,retry",
  });
  const fixture = createFixtureTransport();
  const report = await runProviderCapabilitySmoke({
    config,
    transport: fixture,
  });

  assert.equal(report.status, "completed");
  assert.equal(report.matrix.requestStatusQuery, "not-wired");
  assert.ok(fixture.requests.every(
    (request) => request.url ===
      "http://127.0.0.1:18800/v1/chat/completions",
  ));
  const body = JSON.parse(String(fixture.requests[0]?.init.body));
  assert.equal(body.model, "gundam-fixture");
  assert.deepEqual(
    body.messages.map((message: { role: string }) => message.role),
    ["system", "user"],
  );
});

test("openai-compatible Live Smoke 明确拒绝不存在的 status/cancel", () => {
  const config = loadProviderSmokeConfig({
    PROVIDER_SMOKE_LIVE: "1",
    PROVIDER_SMOKE_API_KEY: "fixture",
    PROVIDER_SMOKE_PROVIDER: "openai-compatible",
    PROVIDER_SMOKE_MODEL: "gundam-fixture",
    PROVIDER_SMOKE_MODEL_ALLOWLIST: "gundam-fixture",
    PROVIDER_SMOKE_OPERATIONS: "create,status,cancel",
    PROVIDER_SMOKE_MAX_REQUESTS: "3",
    PROVIDER_SMOKE_MAX_REQUEST_COST_USD: "0.01",
    PROVIDER_SMOKE_MAX_TOTAL_COST_USD: "0.01",
    PROVIDER_SMOKE_TIMEOUT_MS: "1000",
  });

  assert.ok(validateLiveProviderSmokeConfig(config).some(
    (error) => error.includes("does not expose status/cancel"),
  ));
});
