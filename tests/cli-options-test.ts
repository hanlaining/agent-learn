import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCliOptions,
} from "../src/cli/options.js";
import type { ActionDefinition } from "../src/shortcuts/action-types.js";
import { CLI_COMMAND_REGISTRY } from "../src/shortcuts/builtins.js";
import { CommandRegistry } from "../src/shortcuts/command-registry.js";

test("解析 god-agent CLI 参数", () => {
  assert.deepEqual(parseCliOptions([]), {
    debug: false,
    help: false,
    version: false,
  });
  assert.deepEqual(
    parseCliOptions(["--debug", "--help"]),
    {
      debug: true,
      help: true,
      version: false,
    },
  );
  assert.deepEqual(parseCliOptions(["--version"]), {
    debug: false,
    help: false,
    version: true,
  });
});

test("拒绝未知 CLI 参数", () => {
  assert.throws(
    () => parseCliOptions(["--unknown"]),
    /Unknown option: --unknown/,
  );
});

test("内置 CLI 命令由 Registry 统一解析", () => {
  const resolved = CLI_COMMAND_REGISTRY.resolve("  /status  ");

  assert.equal(resolved.kind, "matched");
  if (resolved.kind === "matched") {
    assert.equal(resolved.action.id, "session.status");
  }
  assert.deepEqual(CLI_COMMAND_REGISTRY.resolve("hello"), {
    kind: "not-command",
  });
  assert.deepEqual(CLI_COMMAND_REGISTRY.resolve("/unknown"), {
    kind: "unknown",
    input: "/unknown",
  });
});

test("运行中命令列表只包含显式可用动作", () => {
  assert.deepEqual(
    CLI_COMMAND_REGISTRY.listAvailable("running")
      .map((action) => action.slashCommand),
    ["/status", "/cancel", "/exit"],
  );
  assert.equal(
    CLI_COMMAND_REGISTRY.formatAvailableCommands("running"),
    "/status、/cancel、/exit",
  );
});

test("帮助由 Registry 元数据生成", () => {
  const help = CLI_COMMAND_REGISTRY.formatHelp();

  assert.match(help, /^命令：/);
  for (const action of CLI_COMMAND_REGISTRY.list()) {
    assert.ok(
      action.slashCommand !== undefined &&
      help.includes(action.slashCommand),
    );
    assert.ok(help.includes(action.description));
  }
});

test("Registry 拒绝重复标识和无效元数据", () => {
  const first = createAction("app.first", "/first");

  assert.throws(
    () => new CommandRegistry([
      first,
      createAction("app.first", "/second"),
    ]),
    /Duplicate Action id/,
  );
  assert.throws(
    () => new CommandRegistry([
      first,
      createAction("app.second", "/first"),
    ]),
    /Duplicate slash command/,
  );
  assert.throws(
    () => new CommandRegistry([
      createAction("INVALID", "/valid"),
    ]),
    /Invalid Action id/,
  );
  assert.throws(
    () => new CommandRegistry([
      createAction("app.valid", "/Invalid"),
    ]),
    /Invalid slash command/,
  );
});

function createAction(
  id: string,
  slashCommand: `/${string}`,
): ActionDefinition {
  return {
    id,
    label: id,
    description: id,
    category: "app",
    risk: "local-ui",
    userBindable: true,
    surfaces: ["cli"],
    slashCommand,
    cliAvailability: ["idle"],
  };
}
