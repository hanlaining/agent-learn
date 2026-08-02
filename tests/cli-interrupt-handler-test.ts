import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  registerCliInterruptHandler,
} from "../src/cli/interrupt-handler.js";

test("运行中 Ctrl+C 先拒绝审批再取消 Turn", async () => {
  const source = new EventEmitter();
  const actions: string[] = [];

  registerCliInterruptHandler(source, {
    hasActiveTurn: () => true,
    denyPendingPermission: () => {
      actions.push("deny");
    },
    cancelActiveTurn: async () => {
      actions.push("cancel");
    },
    exitIdle: () => {
      actions.push("exit");
    },
    reportError: () => undefined,
  });

  source.emit("SIGINT");
  await Promise.resolve();

  assert.deepEqual(actions, ["deny", "cancel"]);
});

test("空闲时 Ctrl+C 安全退出", () => {
  const source = new EventEmitter();
  let exited = false;

  registerCliInterruptHandler(source, {
    hasActiveTurn: () => false,
    denyPendingPermission: () => undefined,
    cancelActiveTurn: async () => undefined,
    exitIdle: () => {
      exited = true;
    },
    reportError: () => undefined,
  });

  source.emit("SIGINT");

  assert.equal(exited, true);
});
