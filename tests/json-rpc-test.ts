import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyJsonRpcMessage,
  isJsonRpcErrorResponse,
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
