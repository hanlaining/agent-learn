import assert from "node:assert/strict";
import test from "node:test";

import {
  CliInputRouter,
} from "../src/cli/input-router.js";

test("审批输入由唯一 Router 交给等待中的 Handler", async () => {
  const output: string[] = [];
  const router = new CliInputRouter((text) => {
    output.push(text);
  });
  const answerPromise = router.requestPermission(
    "allow? ",
  );

  const routed = router.consumeLine("y");

  assert.deepEqual(routed, {
    handled: true,
    cancelRequested: false,
  });
  assert.equal(await answerPromise, "y");
  assert.deepEqual(output, ["allow? "]);
});

test("审批期间输入 /cancel 会拒绝审批并请求取消 Turn", async () => {
  const router = new CliInputRouter(() => undefined);
  const answerPromise = router.requestPermission(
    "allow? ",
  );

  const routed = router.consumeLine("/cancel");

  assert.deepEqual(routed, {
    handled: true,
    cancelRequested: true,
  });
  assert.equal(await answerPromise, "n");
});

test("没有审批等待时把输入留给 CLI 命令循环", () => {
  const router = new CliInputRouter(() => undefined);

  assert.deepEqual(router.consumeLine("hello"), {
    handled: false,
    cancelRequested: false,
  });
});

test("拒绝同时挂起两个审批问题", async () => {
  const router = new CliInputRouter(() => undefined);
  const first = router.requestPermission("first");

  await assert.rejects(
    () => router.requestPermission("second"),
    /Permission input is already pending/,
  );

  router.close();
  assert.equal(await first, "n");
});

test("Ctrl+C 可单独拒绝挂起审批", async () => {
  const router = new CliInputRouter(() => undefined);
  const answerPromise = router.requestPermission("allow?");

  assert.equal(router.denyPendingPermission(), true);
  assert.equal(await answerPromise, "n");
  assert.equal(router.denyPendingPermission(), false);
});
