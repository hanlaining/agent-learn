import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  WorkspaceCommandRunner,
} from "../src/sandbox/workspace-command-runner.js";
import {
  createRunCommandTool,
} from "../src/tools/run-command-tool.js";
import {
  ToolRegistry,
} from "../src/tools/tool-registry.js";

test("run_command 只执行 Runner 中的命令配方", async (t) => {
  const workspace = await mkdtemp(
    join(tmpdir(), "agent-command-tool-"),
  );
  t.after(() => rm(workspace, {
    recursive: true,
    force: true,
  }));
  const runner = await WorkspaceCommandRunner.create(
    workspace,
    {
      recipes: {
        check: {
          executable: process.execPath,
          arguments: [
            "-e",
            "process.stdout.write('check passed')",
          ],
        },
      },
    },
  );
  const registry = new ToolRegistry([
    createRunCommandTool(runner),
  ]);

  const execution = await registry.execute(
    "run_command",
    '{"command":"check"}',
  );

  assert.deepEqual(execution.result, {
    command: "check",
    exitCode: 0,
    stdout: "check passed",
    stderr: "",
  });
  assert.match(
    registry.getPermissionDescription(
      "run_command",
      '{"command":"check"}',
    ) ?? "",
    /check/,
  );
});

test("run_command 拒绝额外参数和未知配方", async (t) => {
  const workspace = await mkdtemp(
    join(tmpdir(), "agent-command-tool-"),
  );
  t.after(() => rm(workspace, {
    recursive: true,
    force: true,
  }));
  const runner = await WorkspaceCommandRunner.create(
    workspace,
    {
      recipes: {
        test: {
          executable: process.execPath,
          arguments: ["--version"],
        },
      },
    },
  );
  const registry = new ToolRegistry([
    createRunCommandTool(runner),
  ]);

  await assert.rejects(
    () => registry.execute(
      "run_command",
      '{"command":"test","args":["--dangerous"]}',
    ),
    /unknown fields/,
  );
  await assert.rejects(
    () => registry.execute(
      "run_command",
      '{"command":"missing"}',
    ),
    /Command recipe is not allowed/,
  );
});
