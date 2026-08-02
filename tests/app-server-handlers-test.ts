import assert from "node:assert/strict";
import test from "node:test";

import {
  registerAppServerHandlers,
} from "../src/app-server/handlers.js";
import {
  JsonRpcConnection,
} from "../src/protocol/connection.js";
import {
  JsonRpcRemoteError,
} from "../src/protocol/request-map.js";
import {
  isThread,
} from "../src/runtime/lifecycle.js";
import {
  LifecycleStore,
} from "../src/runtime/lifecycle-store.js";
import {
  isTurnStartResult,
} from "../src/runtime/turn-start.js";
import {
  isTurnCancelResult,
} from "../src/runtime/turn-cancel.js";
import type {
  AgentLoop,
} from "../src/agent/agent-loop.js";

function createTestAppServer(options: {
  saveState?: () => void | Promise<void>;
  agentLoop?: Pick<AgentLoop, "run" | "cancel">;
} = {}) {
  const clientToServer: string[] = [];
  const serverToClient: string[] = [];

  const client = new JsonRpcConnection((data) => {
    clientToServer.push(data);
  });

  const server = new JsonRpcConnection((data) => {
    serverToClient.push(data);
  });

  const store = new LifecycleStore({
    now: () => "2026-08-01T09:00:00.000Z",
    createId: (prefix) => `${prefix}-test-1`,
  });

  registerAppServerHandlers(server, {
    lifecycleStore: store,
    ...(options.saveState === undefined
      ? {}
      : { saveState: options.saveState }),
    ...(options.agentLoop === undefined
      ? {}
      : { agentLoop: options.agentLoop }),
  });

  // 测试中手动搬运 JSONL，模拟真实的 Client ↔ App Server 双向通道。
  async function flushClientRequest(): Promise<void> {
    await server.receive(clientToServer.shift()!);
    await client.receive(serverToClient.shift()!);
  }

  return {
    client,
    server,
    store,
    clientToServer,
    flushClientRequest,
  };
}

type TestAppServer =
  ReturnType<typeof createTestAppServer>;

async function completeHandshake(
  app: TestAppServer,
): Promise<void> {
  const initializePromise = app.client.sendRequest(
    "initialize",
    {
      clientName: "test-client",
      protocolVersion: 1,
    },
  );

  await app.flushClientRequest();
  await initializePromise;

  app.client.sendNotification("initialized");

  // Notification 没有 Response，因此这里只送到 Server。
  await app.server.receive(
    app.clientToServer.shift()!,
  );
}

test("握手后可以通过 thread/start 创建 Thread", async () => {
  const app = createTestAppServer();

  await completeHandshake(app);

  const threadPromise = app.client.sendRequest("thread/start");
  await app.flushClientRequest();

  const result = await threadPromise;

  assert.ok(isThread(result));
  assert.equal(result.id, "thread-test-1");
  assert.equal(result.status, "active");
  assert.deepEqual(result.turnIds, []);
  // JSONL 跨进程传递的是序列化后的数据，不会保留对象引用。
  assert.deepEqual(app.store.getThread(result.id), result);
});

test("Thread 和 Turn 在 RPC 返回前保存状态", async () => {
  let saveCount = 0;
  const app = createTestAppServer({
    saveState: async () => {
      saveCount += 1;
    },
  });

  await completeHandshake(app);

  const threadPromise = app.client.sendRequest("thread/start");
  await app.flushClientRequest();
  const thread = await threadPromise;
  assert.ok(isThread(thread));
  assert.equal(saveCount, 1);

  const turnPromise = app.client.sendRequest("turn/start", {
    threadId: thread.id,
    input: "持久化这一轮",
  });
  await app.flushClientRequest();
  await turnPromise;

  assert.equal(saveCount, 2);
});

test("turn/cancel 取消指定的运行中 Turn", async () => {
  let cancelledTurnId: string | undefined;
  const app = createTestAppServer({
    agentLoop: {
      run: async () => {
        throw new Error("not used");
      },
      cancel: (turnId) => {
        cancelledTurnId = turnId;
        return true;
      },
    },
  });

  await completeHandshake(app);

  const resultPromise = app.client.sendRequest(
    "turn/cancel",
    { turnId: "turn-running" },
  );
  await app.flushClientRequest();
  const result = await resultPromise;

  assert.ok(isTurnCancelResult(result));
  assert.equal(cancelledTurnId, "turn-running");
});

test("thread/list 返回可恢复的 Thread", async () => {
  const app = createTestAppServer();
  const existingThread = app.store.createThread();

  await completeHandshake(app);

  const resultPromise = app.client.sendRequest("thread/list");
  await app.flushClientRequest();
  const result = await resultPromise;

  assert.ok(Array.isArray(result));
  assert.equal(result.length, 1);
  assert.ok(isThread(result[0]));
  assert.equal(result[0].id, existingThread.id);
});

test("握手完成前拒绝 thread/start", async () => {
  const app = createTestAppServer();

  const threadPromise = app.client.sendRequest("thread/start");
  const rejectionPromise = assert.rejects(
    threadPromise,
    (error: unknown) => {
      assert.ok(error instanceof JsonRpcRemoteError);
      assert.match(error.message, /initialize handshake/);
      return true;
    },
  );

  await app.flushClientRequest();
  await rejectionPromise;
});

test("turn/start 创建 Turn 和 user_message Item", async () => {
  const app = createTestAppServer();

  await completeHandshake(app);

  const threadPromise = app.client.sendRequest("thread/start");
  await app.flushClientRequest();

  const threadResult = await threadPromise;
  assert.ok(isThread(threadResult));

  const turnPromise = app.client.sendRequest(
    "turn/start",
    {
      threadId: threadResult.id,
      input: "分析 2026 年 7 月的财务情况",
    },
  );

  await app.flushClientRequest();

  const result = await turnPromise;

  assert.ok(isTurnStartResult(result));
  assert.equal(result.turn.id, "turn-test-1");
  assert.equal(result.turn.threadId, threadResult.id);
  assert.equal(result.turn.status, "in_progress");
  assert.deepEqual(result.turn.itemIds, ["item-test-1"]);
  assert.equal(result.userMessage.id, "item-test-1");
  assert.equal(result.userMessage.type, "user_message");
  assert.deepEqual(result.userMessage.content, {
    text: "分析 2026 年 7 月的财务情况",
  });
  assert.deepEqual(
    app.store.getTurn(result.turn.id),
    result.turn,
  );
  assert.deepEqual(
    app.store.getItem(result.userMessage.id),
    result.userMessage,
  );
});

test("不存在的 Thread 不能启动 Turn", async () => {
  const app = createTestAppServer();

  await completeHandshake(app);

  const turnPromise = app.client.sendRequest(
    "turn/start",
    {
      threadId: "missing-thread",
      input: "分析财务情况",
    },
  );

  const rejectionPromise = assert.rejects(
    turnPromise,
    (error: unknown) => {
      assert.ok(error instanceof JsonRpcRemoteError);
      assert.match(error.message, /Thread not found/);
      return true;
    },
  );

  await app.flushClientRequest();
  await rejectionPromise;
});

test("turn/start 拒绝空输入", async () => {
  const app = createTestAppServer();

  await completeHandshake(app);

  const turnPromise = app.client.sendRequest(
    "turn/start",
    {
      threadId: "thread-test-1",
      input: "   ",
    },
  );

  const rejectionPromise = assert.rejects(
    turnPromise,
    (error: unknown) => {
      assert.ok(error instanceof JsonRpcRemoteError);
      assert.match(
        error.message,
        /input must be a non-empty string/,
      );
      return true;
    },
  );

  await app.flushClientRequest();
  await rejectionPromise;
});
