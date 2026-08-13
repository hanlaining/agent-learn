import assert from "node:assert/strict";
import test from "node:test";

import {
  JsonRpcRemoteError,
  RequestMap,
} from "../src/protocol/request-map.js";

test("成功响应命中对应请求", async () => {
  const requests = new RequestMap();

  const resultPromise = requests.create(1);

  assert.equal(requests.size, 1);

  const handled = requests.handleResponse({
    id: 1,
    result: {
      ready: true,
    },
  });

  assert.equal(handled, true);

  const result = await resultPromise;

  assert.deepEqual(result, {
    ready: true,
  });

  assert.equal(requests.size, 0);
});

test("错误响应拒绝对应请求", async () => {
  const requests = new RequestMap();

  const resultPromise = requests.create("request-1");

  requests.handleResponse({
    id: "request-1",
    error: {
      code: -32600,
      message: "Invalid Request",
    },
  });

  await assert.rejects(
    resultPromise,
    (error: unknown) => {
      assert.ok(error instanceof JsonRpcRemoteError);
      assert.equal(error.code, -32600);
      assert.equal(error.message, "Invalid Request");

      return true;
    },
  );

  assert.equal(requests.size, 0);
});

test("未知响应 ID 返回 false", () => {
  const requests = new RequestMap();

  const handled = requests.handleResponse({
    id: 999,
    result: {},
  });

  assert.equal(handled, false);
});

test("拒绝重复的请求 ID", async () => {
  const requests = new RequestMap();

  const pending = requests.create(1);

  assert.throws(
    () => requests.create(1),
    /Duplicate JSON-RPC id/,
  );

  requests.rejectAll(new Error("Test finished"));

  await assert.rejects(pending, /Test finished/);
});

test("连接关闭时拒绝全部请求", async () => {
  const requests = new RequestMap();

  const first = requests.create(1);
  const second = requests.create(2);

  requests.rejectAll(new Error("Connection closed"));

  await assert.rejects(first, /Connection closed/);
  await assert.rejects(second, /Connection closed/);

  assert.equal(requests.size, 0);
});

test("只拒绝指定请求并保留其他等待项", async () => {
  const requests = new RequestMap();
  const first = requests.create(1);
  const second = requests.create(2);

  assert.equal(
    requests.reject(1, new Error("cancelled")),
    true,
  );
  assert.equal(requests.size, 1);
  assert.equal(
    requests.handleResponse({ id: 2, result: "ok" }),
    true,
  );

  await assert.rejects(first, /cancelled/);
  assert.equal(await second, "ok");
});
