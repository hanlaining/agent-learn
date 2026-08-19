import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AppServerClient,
  resolveToolPermissionRequest,
} from "../src/electron/app-server-client.js";
import "./electron-ipc-boundary-test.js";
import { JsonFileRuntimePersistence } from "../src/runtime/json-file-runtime-persistence.js";
import { PersistentRuntimeLeaseStore } from "../src/runtime/persistent-runtime-lease-store.js";
import { DEFAULT_AGENT_TEAM_CONFIG } from "../src/agents/agent-runtime.js";

test("真实 App Server 遇到已占用 Job Lease 时记录等待并继续 ready", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "god-agent-startup-lease-wait-"));
  const statePath = join(root, "runtime-state.json");
  t.after(() => rm(root, { recursive: true, force: true }));
  const persistence = new JsonFileRuntimePersistence(statePath);
  const loaded = await persistence.load();
  const thread = loaded.lifecycleStore.createThread();
  const turn = loaded.lifecycleStore.createTurn(thread.id);
  loaded.lifecycleStore.appendItem(turn.id, "user_message", { text: "recover facts only" });
  const rootRun = loaded.agentRunStore.ensureRoot(thread.id, turn.id, "orchestrator", `job-${turn.id}`);
  const job = loaded.agentRuntimeStore.createJob({
    threadId: thread.id,
    rootTurnId: turn.id,
    rootRunId: rootRun.id,
    configSnapshot: DEFAULT_AGENT_TEAM_CONFIG,
    executionKind: "software_change",
    workflowVersion: "dynamic_v1",
  });
  await persistence.save(loaded);
  const leaseStore = new PersistentRuntimeLeaseStore(join(root, "runtime-leases.json"));
  await leaseStore.acquire({
    resource: { type: "job", id: job.id },
    ownerId: "other-live-app",
    ttlMs: 60_000,
  });
  const diagnostics: string[] = [];
  const client = new AppServerClient({
    command: process.execPath,
    args: ["--import", "tsx", "src/app-server/main.ts"],
    cwd: process.cwd(),
    env: createTestEnvironment(statePath),
    onDiagnostic: (message) => diagnostics.push(message),
  });
  t.after(() => client.close());

  assert.equal((await client.start()).state, "connected");
  assert.ok(diagnostics.some((message) =>
    message.includes(`${job.id} waiting for active execution owner; startup recovery deferred`)));
  assert.equal((await leaseStore.read({ type: "job", id: job.id }))?.ownerId, "other-live-app");
  await client.close();
});

test("真实 App Server 子进程贯通文件搜索、Skill 目录、结构化发送与历史原文", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "god-agent-composer-e2e-"));
  const workspace = join(root, "workspace");
  const skillRoot = join(root, "skills");
  const skillDirectory = join(skillRoot, "code-review");
  await mkdir(join(workspace, "src"), { recursive: true });
  await mkdir(join(workspace, "node_modules", "hidden"), { recursive: true });
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(join(workspace, "src", "app.ts"), "export const app = true;\n", "utf8");
  await writeFile(join(workspace, ".env.local"), "PRIVATE=must-not-leak\n", "utf8");
  await writeFile(join(workspace, "node_modules", "hidden", "index.ts"), "ignored\n", "utf8");
  await writeFile(join(skillDirectory, "SKILL.md"), [
    "---", "name: code-review", "description: 检查代码风险", "---", "先读取文件，再给出结论。", "",
  ].join("\n"), "utf8");
  t.after(() => rm(root, { recursive: true, force: true }));

  const client = new AppServerClient({
    command: process.execPath,
    args: ["--import", "tsx", "src/app-server/main.ts"],
    cwd: process.cwd(),
    env: createTestEnvironment(join(root, "runtime-state.json"), {
      AGENT_WORKSPACE: workspace,
      AGENT_SKILLS_PATH: skillRoot,
    }),
  });
  t.after(() => client.close());
  assert.equal((await client.start()).state, "connected");

  const capabilities = await client.getCapabilities();
  assert.deepEqual(capabilities.skills, [{ name: "code-review", description: "检查代码风险" }]);
  assert.deepEqual(await client.searchWorkspaceFiles("src\\app"), {
    query: "src\\app", paths: ["src/app.ts"], truncated: false,
  });
  assert.deepEqual((await client.searchWorkspaceFiles("")).paths, ["src/app.ts"]);

  const thread = await client.startThread();
  const input = "请检查 @src/app.ts 并使用 $code-review";
  const started = await client.startTurn(thread.id, input, {
    mentions: [{ kind: "file", path: "src/app.ts" }],
    explicitSkills: ["code-review"],
  });
  assert.deepEqual(started.userMessage.content, {
    text: input,
    modelText: `${input}\n\n[用户显式选择的上下文；仅按列出的相对路径与 Skill 名称处理]\n- workspace file: src/app.ts\n- Skill: code-review（先调用 read_skill 读取完整说明）`,
    mentions: [{ kind: "file", path: "src/app.ts" }],
    explicitSkills: ["code-review"],
  });
  assert.deepEqual((await client.readThreadHistory(thread.id)).messages.map((message) => message.text), [input]);
  await client.close();

  const restored = new AppServerClient({
    command: process.execPath,
    args: ["--import", "tsx", "src/app-server/main.ts"],
    cwd: process.cwd(),
    env: createTestEnvironment(join(root, "runtime-state.json"), {
      AGENT_WORKSPACE: workspace,
      AGENT_SKILLS_PATH: skillRoot,
    }),
  });
  t.after(() => restored.close());
  assert.equal((await restored.start()).state, "connected");
  assert.deepEqual((await restored.readThreadHistory(thread.id)).messages.map((message) => message.text), [input]);
  assert.deepEqual(await restored.searchWorkspaceFiles("app.ts"), {
    query: "app.ts", paths: ["src/app.ts"], truncated: false,
  });
  await restored.close();
});

test("真实 App Server 独立拒绝敏感、越界、未知 Skill 与非法结构化输入", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "god-agent-composer-negative-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "safe.ts"), "safe\n", "utf8");
  await writeFile(join(workspace, ".env"), "SECRET=value\n", "utf8");
  await writeFile(join(root, "outside.ts"), "outside\n", "utf8");
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = new AppServerClient({
    command: process.execPath,
    args: ["--import", "tsx", "src/app-server/main.ts"],
    cwd: process.cwd(),
    env: createTestEnvironment(join(root, "runtime-state.json"), { AGENT_WORKSPACE: workspace }),
  });
  t.after(() => client.close());
  assert.equal((await client.start()).state, "connected");
  const thread = await client.startThread();

  await assert.rejects(() => client.startTurn(thread.id, "敏感", { mentions: [{ kind: "file", path: ".env" }] }), /Sensitive/);
  await assert.rejects(() => client.startTurn(thread.id, "越界", { mentions: [{ kind: "file", path: "../outside.ts" }] }), /escapes workspace/);
  await assert.rejects(() => client.startTurn(thread.id, "未知", { explicitSkills: ["unknown-skill"] }), /unavailable Skill/);
  await assert.rejects(() => client.startTurn(thread.id, "控制字符", { mentions: [{ kind: "file", path: "safe.ts\n" }] }), /invalid file mention/);
  await assert.rejects(() => client.startTurn(thread.id, "数量超限", { mentions: Array.from({ length: 21 }, () => ({ kind: "file" as const, path: "safe.ts" })) }), /at most 20/);
  assert.deepEqual((await client.readThreadHistory(thread.id)).messages, []);
  await client.close();
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
  additions: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    AGENT_STATE_PATH: statePath,
    ...additions,
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
