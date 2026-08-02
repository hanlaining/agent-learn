import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyJsonRpcMessage,
  type JsonRpcMessage,
} from "../src/protocol/json-rpc.js";

import {
  decodeJsonRpcLine,
  encodeJsonRpcMessage,
} from "../src/protocol/jsonl.js";

test("编码 JSON-RPC 消息时添加换行符", () => {
  const message: JsonRpcMessage = {
    id: 1,
    method: "initialize",
    params: {},
  };

  const encoded = encodeJsonRpcMessage(message);

  assert.equal(
    encoded,
    '{"id":1,"method":"initialize","params":{}}\n',
  );
});

test("解码 JSONL Request", () => {
  const line =
    '{"id":1,"method":"initialize","params":{}}\n';

  const message = decodeJsonRpcLine(line);

  assert.equal(classifyJsonRpcMessage(message), "request");
});

test("连续消息可以通过换行符分开", () => {
  const request: JsonRpcMessage = {
    id: 1,
    method: "initialize",
  };

  const notification: JsonRpcMessage = {
    method: "initialized",
  };

  const stream =
    encodeJsonRpcMessage(request) +
    encodeJsonRpcMessage(notification);

  const lines = stream.trimEnd().split("\n");

  assert.equal(lines.length, 2);

  assert.equal(
    classifyJsonRpcMessage(decodeJsonRpcLine(lines[0]!)),
    "request",
  );

  assert.equal(
    classifyJsonRpcMessage(decodeJsonRpcLine(lines[1]!)),
    "notification",
  );
});

test("拒绝不合法的 JSON", () => {
  assert.throws(
    () => decodeJsonRpcLine("{ invalid json"),
    /Invalid JSON/,
  );
});

test("拒绝不符合 JSON-RPC 结构的 JSON", () => {
  assert.throws(
    () => decodeJsonRpcLine('{"name":"hello"}'),
    /Invalid JSON-RPC message/,
  );
});
