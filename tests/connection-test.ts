import assert from "node:assert/strict";
import test from "node:test";

import { JsonRpcConnection } from "../src/protocol/connection.js";
import { JsonRpcRemoteError } from "../src/protocol/request-map.js";

function createConnectionPair() {
  const clientToServer: string[] = [];
  const serverToClient: string[] = [];

  const client = new JsonRpcConnection((data) => {
    clientToServer.push(data);
  });

  const server = new JsonRpcConnection((data) => {
    serverToClient.push(data);
  });

  return {
    client,
    server,
    clientToServer,
    serverToClient,
  };
}

test("Client 可以请求 App Server", async () => {
  const {
    client,
    server,
    clientToServer,
    serverToClient,
  } = createConnectionPair();

  server.onRequest("initialize", (params) => {
    assert.deepEqual(params, {
      clientName: "agent-learn",
    });

    return {
      ready: true,
      serverName: "agent-app-server",
    };
  });

  const resultPromise = client.sendRequest(
    "initialize",
    {
      clientName: "agent-learn",
    },
  );

  // Client → App Server
  assert.equal(clientToServer.length, 1);

  await server.receive(clientToServer.shift()!);

  // App Server → Client Response
  assert.equal(serverToClient.length, 1);

  await client.receive(serverToClient.shift()!);

  const result = await resultPromise;

  assert.deepEqual(result, {
    ready: true,
    serverName: "agent-app-server",
  });
});

test("App Server 可以反向请求 Client 审批", async () => {
  const {
    client,
    server,
    clientToServer,
    serverToClient,
  } = createConnectionPair();

  client.onRequest("approval/request", (params) => {
    assert.deepEqual(params, {
      command: "npm test",
    });

    return {
      decision: "allow_once",
    };
  });

  const approvalPromise = server.sendRequest(
    "approval/request",
    {
      command: "npm test",
    },
  );

  // App Server → Client Approval Request
  assert.equal(serverToClient.length, 1);

  await client.receive(serverToClient.shift()!);

  // Client → App Server Approval Response
  assert.equal(clientToServer.length, 1);

  await server.receive(clientToServer.shift()!);

  const result = await approvalPromise;

  assert.deepEqual(result, {
    decision: "allow_once",
  });
});

test("Notification 不产生 Response", async () => {
  const {
    client,
    server,
    clientToServer,
    serverToClient,
  } = createConnectionPair();

  let receivedParams: unknown;

  server.onNotification("initialized", (params) => {
    receivedParams = params;
  });

  client.sendNotification("initialized", {
    ready: true,
  });

  await server.receive(clientToServer.shift()!);

  assert.deepEqual(receivedParams, {
    ready: true,
  });

  assert.equal(serverToClient.length, 0);
});

test("未知方法返回 Method not found", async () => {
  const {
    client,
    server,
    clientToServer,
    serverToClient,
  } = createConnectionPair();

  const resultPromise = client.sendRequest(
    "unknown/method",
  );

  const rejectionPromise = assert.rejects(
    resultPromise,
    (error: unknown) => {
      assert.ok(error instanceof JsonRpcRemoteError);
      assert.equal(error.code, -32601);
      assert.match(error.message, /Method not found/);

      return true;
    },
  );

  await server.receive(clientToServer.shift()!);
  await client.receive(serverToClient.shift()!);

  await rejectionPromise;
});