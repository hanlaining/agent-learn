import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AppServerClient,
  resolveToolPermissionRequest,
} from "../src/electron/app-server-client.js";
import {
  isDesktopSkillDistillResult,
} from "../src/electron/desktop-types.js";

test("Electron Client 的沉淀响应校验拒绝非法结构", () => {
  assert.equal(isDesktopSkillDistillResult({
    status: "created",
    skill: { name: "safe-skill", description: "安全 Skill" },
    capabilities: {
      llm: true, models: [], webSearch: false, tools: [], skills: [], mcpServers: [],
    },
  }), true);
  assert.equal(isDesktopSkillDistillResult({
    status: "created",
    skill: { name: "safe-skill", description: "安全 Skill", secret: "private" },
    capabilities: { llm: true },
  }), false);
  assert.equal(isDesktopSkillDistillResult({
    status: "overwritten",
    skill: { name: "safe-skill", description: "安全 Skill" },
    capabilities: {
      llm: true, models: [], webSearch: false, tools: [], skills: [], mcpServers: [],
    },
  }), false);
});

test("Electron Client 把合法权限请求交给 UI 并回传允许", async () => {
  const seen: unknown[] = [];
  const decision = await resolveToolPermissionRequest({
    turnId: "turn-1",
    callId: "call-1",
    toolName: "read_file",
    description: "读取工作区文件",
    riskLevel: "read",
    arguments: { privatePath: "must-not-cross-boundary" },
  }, async (request) => {
    seen.push(request);
    return { decision: "allow", scope: "once" };
  });

  assert.deepEqual(decision, { decision: "allow", scope: "once" });
  assert.deepEqual(seen, [{
    turnId: "turn-1",
    callId: "call-1",
    toolName: "read_file",
    description: "读取工作区文件",
    riskLevel: "read",
  }]);
  assert.doesNotMatch(JSON.stringify(seen), /privatePath/);
});

test("Electron Client 没有权限 UI 时固定拒绝", async () => {
  const decision = await resolveToolPermissionRequest({
    turnId: "turn-1",
    callId: "call-1",
    toolName: "run_command",
  });

  assert.equal(decision.decision, "deny");
});

test("Electron Client 拒绝非法权限请求且不调用 UI", async () => {
  let called = false;
  await assert.rejects(
    () => resolveToolPermissionRequest({
      turnId: "turn-1",
      callId: "",
      toolName: "read_file",
    }, async () => {
      called = true;
      return { decision: "allow", scope: "once" };
    }),
    /Invalid tool permission request/,
  );
  assert.equal(called, false);
});

test("Electron Client 完成 App Server 握手并安全关闭子进程", async (t) => {
  const stateDirectory = await mkdtemp(
    join(tmpdir(), "god-agent-electron-client-"),
  );
  t.after(() => rm(stateDirectory, {
    recursive: true,
    force: true,
  }));

  const states: string[] = [];
  const client = new AppServerClient({
    command: process.execPath,
    args: ["--import", "tsx", "src/app-server/main.ts"],
    cwd: process.cwd(),
    env: createTestEnvironment(
      join(stateDirectory, "runtime-state.json"),
    ),
  });
  client.onStatusChange((status) => {
    states.push(status.state);
  });

  const connected = await client.start();
  const childPid = client.getChildPid();

  assert.equal(connected.state, "connected");
  assert.deepEqual(states, ["connecting", "connected"]);
  assert.equal(typeof childPid, "number");
  assert.equal(isProcessAlive(childPid!), true);

  const capabilities = await client.getCapabilities();
  assert.equal(capabilities.llm, false);
  assert.ok(capabilities.tools.some(
    (tool) => tool.name === "finance_monthly_summary",
  ));

  const thread = await client.startThread();
  const history = await client.readThreadHistory(thread.id);
  assert.equal(history.thread.id, thread.id);
  assert.deepEqual(history.messages, []);

  await client.close();

  assert.equal(client.getStatus().state, "closed");
  assert.equal(isProcessAlive(childPid!), false);
  assert.deepEqual(states, [
    "connecting",
    "connected",
    "closed",
  ]);
});

test("App Server 启动失败时只产生固定安全状态", async () => {
  const missingCommand = join(
    tmpdir(),
    "missing-private-runtime-command.exe",
  );
  const client = new AppServerClient({
    command: missingCommand,
    args: [],
    cwd: process.cwd(),
    env: createTestEnvironment(
      join(tmpdir(), "unused-runtime-state.json"),
    ),
    handshakeTimeoutMs: 200,
    shutdownTimeoutMs: 200,
  });

  const status = await client.start();

  assert.equal(status.state, "failed");
  assert.equal(
    status.state === "failed" ? status.code : undefined,
    "start_failed",
  );
  assert.equal(
    status.message,
    "Runtime 启动失败，请关闭后重试",
  );
  assert.doesNotMatch(status.message, /missing-private/);
  assert.doesNotMatch(JSON.stringify(status), /runtime-state\.json/);

  await client.close();
  assert.equal(client.getStatus().state, "closed");
});

function createTestEnvironment(
  statePath: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    AGENT_STATE_PATH: statePath,
  };

  // 测试只继承启动 Node/tsx 所需的系统变量，不继承 Provider Key。
  for (const name of [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
  ]) {
    const value = process.env[name];

    if (value !== undefined) {
      environment[name] = value;
    }
  }

  return environment;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
