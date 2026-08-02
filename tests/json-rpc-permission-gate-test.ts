import assert from "node:assert/strict";
import test from "node:test";

import {
  JsonRpcPermissionGate,
} from "../src/permissions/json-rpc-permission-gate.js";
import {
  JsonRpcConnection,
} from "../src/protocol/connection.js";

function createConnectionPair() {
  const clientToServer: string[] = [];
  const serverToClient: string[] = [];

  const client = new JsonRpcConnection((data) => {
    clientToServer.push(data);
  });
  const server = new JsonRpcConnection((data) => {
    serverToClient.push(data);
  });

  async function flushPermissionRequest(): Promise<void> {
    await client.receive(serverToClient.shift()!);
    await server.receive(clientToServer.shift()!);
  }

  return {
    client,
    server,
    serverToClient,
    flushPermissionRequest,
  };
}

const permissionRequest = {
  turnId: "turn-1",
  callId: "call-1",
  toolName: "finance_monthly_summary",
  arguments: '{"period":"2026-07"}',
};

test("JSON-RPC PermissionGate 接受 Client allow", async () => {
  const pair = createConnectionPair();
  const gate = new JsonRpcPermissionGate(pair.server);

  pair.client.onRequest(
    "tool/request-permission",
    (params) => {
      // 审批界面只需要身份信息，不跨进程暴露原始 Tool 参数。
      assert.deepEqual(params, {
        turnId: "turn-1",
        callId: "call-1",
        toolName: "finance_monthly_summary",
      });

      return { decision: "allow" };
    },
  );

  const decisionPromise = gate.request(permissionRequest);
  await pair.flushPermissionRequest();

  assert.deepEqual(await decisionPromise, {
    decision: "allow",
  });
});

test("JSON-RPC PermissionGate 保留 Client deny 原因", async () => {
  const pair = createConnectionPair();
  const gate = new JsonRpcPermissionGate(pair.server);

  pair.client.onRequest(
    "tool/request-permission",
    () => ({
      decision: "deny",
      reason: "user denied",
    }),
  );

  const decisionPromise = gate.request(permissionRequest);
  await pair.flushPermissionRequest();

  assert.deepEqual(await decisionPromise, {
    decision: "deny",
    reason: "user denied",
  });
});

test("JSON-RPC PermissionGate 拒绝非法 Client 响应", async () => {
  const pair = createConnectionPair();
  const gate = new JsonRpcPermissionGate(pair.server);

  pair.client.onRequest(
    "tool/request-permission",
    () => ({ decision: "allow_once" }),
  );

  const decisionPromise = gate.request(permissionRequest);
  const rejectionPromise = assert.rejects(
    decisionPromise,
    /Invalid tool permission response/,
  );

  await pair.flushPermissionRequest();
  await rejectionPromise;
});
