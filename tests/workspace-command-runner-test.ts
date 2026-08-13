import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, {
  type TestContext,
} from "node:test";

import {
  CommandOutputLimitError,
  CommandTimeoutError,
  WorkspaceCommandRunner,
} from "../src/sandbox/workspace-command-runner.js";

async function createRunner(
  t: TestContext,
  options: {
    timeoutMs?: number;
    maxOutputBytes?: number;
  } = {},
) {
  const workspace = await mkdtemp(
    join(tmpdir(), "agent-command-"),
  );
  t.after(() => rm(workspace, {
    recursive: true,
    force: true,
  }));

  return WorkspaceCommandRunner.create(workspace, {
    recipes: {
      print: {
        executable: process.execPath,
        arguments: [
          "-e",
          "process.stdout.write('command ok')",
        ],
      },
      wait: {
        executable: process.execPath,
        arguments: ["-e", "setInterval(() => {}, 1000)"],
      },
      large: {
        executable: process.execPath,
        arguments: [
          "-e",
          "process.stdout.write('x'.repeat(100))",
        ],
      },
    },
    ...options,
  });
}

test("在固定 Workspace 中执行预注册命令配方", async (t) => {
  const runner = await createRunner(t);

  const result = await runner.run(
    "print",
    new AbortController().signal,
  );

  assert.deepEqual(result, {
    command: "print",
    exitCode: 0,
    stdout: "command ok",
    stderr: "",
  });
});

test("拒绝未注册命令", async (t) => {
  const runner = await createRunner(t);

  await assert.rejects(
    () => runner.run(
      "rm everything",
      new AbortController().signal,
    ),
    /Command recipe is not allowed/,
  );
});

test("命令超过时限时终止子进程", async (t) => {
  const runner = await createRunner(t, {
    timeoutMs: 20,
  });

  await assert.rejects(
    () => runner.run(
      "wait",
      new AbortController().signal,
    ),
    (error: unknown) => error instanceof CommandTimeoutError,
  );
});

test("命令输出超过上限时终止子进程", async (t) => {
  const runner = await createRunner(t, {
    maxOutputBytes: 10,
  });

  await assert.rejects(
    () => runner.run(
      "large",
      new AbortController().signal,
    ),
    (error: unknown) =>
      error instanceof CommandOutputLimitError,
  );
});

test("Runtime 取消时终止命令子进程", async (t) => {
  const runner = await createRunner(t, {
    timeoutMs: 1_000,
  });
  const controller = new AbortController();
  const reason = new Error("turn cancelled");
  const resultPromise = runner.run("wait", controller.signal);

  controller.abort(reason);

  await assert.rejects(
    resultPromise,
    (error: unknown) => error === reason,
  );
});
