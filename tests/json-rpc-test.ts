import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyJsonRpcMessage,
  isJsonRpcErrorResponse,
  isJsonRpcMessage,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcSuccessResponse,
} from "../src/protocol/json-rpc.js";

test("识别 Request", () => {
  const input: unknown = {
    id: 1,
    method: "initialize",
    params: {},
  };

  assert.equal(isJsonRpcRequest(input), true);
  assert.equal(classifyJsonRpcMessage(input), "request");
});

test("识别 Notification", () => {
  const input: unknown = {
    method: "initialized",
    params: {},
  };

  assert.equal(isJsonRpcNotification(input), true);
  assert.equal(classifyJsonRpcMessage(input), "notification");
});

test("识别 Success Response", () => {
  const input: unknown = {
    id: 1,
    result: {
      initialized: true,
    },
  };

  assert.equal(isJsonRpcSuccessResponse(input), true);
  assert.equal(classifyJsonRpcMessage(input), "success-response");
});

test("识别 Error Response", () => {
  const input: unknown = {
    id: 1,
    error: {
      code: -32600,
      message: "Invalid Request",
    },
  };

  assert.equal(isJsonRpcErrorResponse(input), true);
  assert.equal(classifyJsonRpcMessage(input), "error-response");
});

test("拒绝未知消息", () => {
  const input: unknown = {
    name: "invalid message",
  };

  assert.equal(classifyJsonRpcMessage(input), "invalid");
});

test("带有 method 和 result 的冲突消息应判定为无效", () => {
  const input: unknown = {
    id: 1,
    method: "initialize",
    result: {},
  };

  assert.equal(classifyJsonRpcMessage(input), "invalid");
});

test("JSON-RPC 四类守卫拒绝空值、数组、非法 id 和冲突字段", () => {
  const valid = [
    { id: "request", method: "ping" },
    { method: "notify" },
    { id: 1, result: null },
    { id: 2, error: { code: -1, message: "failed" } },
  ];
  for (const value of valid) {
    assert.equal(isJsonRpcMessage(value), true);
  }
  const invalid: unknown[] = [
    null,
    [],
    {},
    { id: null, method: "ping" },
    { id: true, method: "ping" },
    { id: 1, method: 2 },
    { method: 2 },
    { id: 1, method: "ping", error: {} },
    { id: 1, result: {}, method: "ping" },
    { id: 1, result: {}, error: {} },
    { id: 1, error: null },
    { id: 1, error: { code: "-1", message: "failed" } },
    { id: 1, error: { code: -1, message: 1 } },
    { id: 1, error: { code: -1, message: "failed" }, result: null },
  ];
  for (const value of invalid) {
    assert.equal(isJsonRpcMessage(value), false, JSON.stringify(value));
    assert.equal(classifyJsonRpcMessage(value), "invalid");
  }
});
