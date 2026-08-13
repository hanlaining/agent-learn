import assert from "node:assert/strict";
import test from "node:test";

import {
  registerCliPermissionHandler,
} from "../src/cli/permission-handler.js";
import {
  JsonRpcConnection,
} from "../src/protocol/connection.js";
import {
  JsonRpcRemoteError,
} from "../src/protocol/request-map.js";

function createConnectionPair() {
  const clientToServer: string[] = [];
  const serverToClient: string[] = [];

  const client = new JsonRpcConnection((data) => {
    clientToServer.push(data);
  });
  const server = new JsonRpcConnection((data) => {
    serverToClient.push(data);
  });

  async function flushServerRequest(): Promise<void> {
    await client.receive(serverToClient.shift()!);
    await server.receive(clientToServer.shift()!);
  }

  return {
    client,
    server,
    flushServerRequest,
  };
}

const rpcParams = {
  turnId: "turn-1",
  callId: "call-1",
  toolName: "finance_monthly_summary",
};

test("CLI 输入 y 或 yes 时允许 Tool", async () => {
  for (const answer of ["y", " YES "]) {
    const pair = createConnectionPair();
    const prompts: string[] = [];

    registerCliPermissionHandler(
      pair.client,
      async (prompt) => {
        prompts.push(prompt);
        return answer;
      },
    );

    const resultPromise = pair.server.sendRequest(
      "tool/request-permission",
      rpcParams,
    );
    await pair.flushServerRequest();

    assert.deepEqual(await resultPromise, {
      decision: "allow",
      scope: "once",
    });
    assert.match(
      prompts[0]!,
      /finance_monthly_summary/,
    );
    assert.doesNotMatch(prompts[0]!, /period/);
  }
});

test("CLI 输入 a 时允许本会话复用审批", async () => {
  const pair = createConnectionPair();

  registerCliPermissionHandler(
    pair.client,
    async () => "a",
  );

  const resultPromise = pair.server.sendRequest(
    "tool/request-permission",
    {
      ...rpcParams,
      riskLevel: "read",
    },
  );
  await pair.flushServerRequest();

  assert.deepEqual(await resultPromise, {
    decision: "allow",
    scope: "session",
  });
});

test("CLI 非确认输入默认拒绝 Tool", async () => {
  const pair = createConnectionPair();

  registerCliPermissionHandler(
    pair.client,
    async () => "n",
  );

  const resultPromise = pair.server.sendRequest(
    "tool/request-permission",
    rpcParams,
  );
  await pair.flushServerRequest();

  assert.deepEqual(await resultPromise, {
    decision: "deny",
    reason: "user denied",
  });
});

test("CLI 优先展示 Tool 生成的安全审批描述", async () => {
  const pair = createConnectionPair();
  let capturedPrompt = "";

  registerCliPermissionHandler(
    pair.client,
    async (prompt) => {
      capturedPrompt = prompt;
      return "n";
    },
  );

  const resultPromise = pair.server.sendRequest(
    "tool/request-permission",
    {
      ...rpcParams,
      toolName: "run_command",
      description: "运行受控命令：npm run check",
    },
  );
  await pair.flushServerRequest();
  await resultPromise;

  assert.match(capturedPrompt, /npm run check/);
});

test("CLI 拒绝非法 Tool 审批请求", async () => {
  const pair = createConnectionPair();

  registerCliPermissionHandler(
    pair.client,
    async () => "y",
  );

  const resultPromise = pair.server.sendRequest(
    "tool/request-permission",
    {
      turnId: "turn-1",
      callId: "call-1",
    },
  );
  const rejectionPromise = assert.rejects(
    resultPromise,
    (error: unknown) => {
      assert.ok(error instanceof JsonRpcRemoteError);
      assert.match(
        error.message,
        /Invalid tool permission request/,
      );
      return true;
    },
  );

  await pair.flushServerRequest();
  await rejectionPromise;
});
