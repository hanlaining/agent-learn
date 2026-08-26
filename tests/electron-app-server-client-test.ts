import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  AppServerClient,
  resolveToolPermissionRequest,
} from "../src/electron/app-server-client.js";
import "./electron-ipc-boundary-test.js";
import { JsonFileRuntimePersistence } from "../src/runtime/json-file-runtime-persistence.js";
import { PersistentRuntimeLeaseStore } from "../src/runtime/persistent-runtime-lease-store.js";
import { DEFAULT_AGENT_TEAM_CONFIG } from "../src/agents/agent-runtime.js";
import { createModelRequestDigest } from "../src/runtime/model-invocation.js";
import { createToolArgumentsDigest } from "../src/runtime/tool-invocation.js";
import { runProcessChaosGate40CaseHarness } from "../research/runtime-e2e-benchmarks/src/process-chaos-harness.js";
import {
  PROCESS_CHAOS_MODEL_RESPONSE_COMMIT_WINDOW_ID,
  PROCESS_CHAOS_PROOF_COMMIT_WINDOW_ID,
  PROCESS_CHAOS_RECEIPT_COMMIT_WINDOW_ID,
} from "../research/runtime-e2e-benchmarks/src/process-chaos-schema.js";

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

test("App Server 只在完整 test-only 配置下注册 Process Chaos 本地 Tool", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "god-agent-process-chaos-config-"));
  const statePath = join(root, "runtime-state.json");
  const experimentDirectory = join(root, "experiment");
  await mkdir(experimentDirectory, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  const configured = new AppServerClient({
    command: process.execPath,
    args: ["--import", "tsx", "src/app-server/main.ts"],
    cwd: process.cwd(),
    env: createTestEnvironment(statePath, {
      NODE_ENV: "test",
      PROCESS_CHAOS_TEST_ONLY_EFFECT_HELPER_URL: "http://127.0.0.1:32123",
      PROCESS_CHAOS_TEST_ONLY_EXPERIMENT_DIRECTORY: experimentDirectory,
    }),
  });
  t.after(() => configured.close());
  assert.equal((await configured.start()).state, "connected");
  const capabilities = await configured.getCapabilities();
  // Test-only effect Tool 只进入内部 Registry，不越过能力面暴露给 Renderer。
  assert.equal(capabilities.tools.some((tool) => tool.name === "process_chaos_local_effect"), false);
  await configured.close();

  const incomplete = new AppServerClient({
    command: process.execPath,
    args: ["--import", "tsx", "src/app-server/main.ts"],
    cwd: process.cwd(),
    env: createTestEnvironment(join(root, "incomplete-state.json"), {
      NODE_ENV: "test",
      PROCESS_CHAOS_TEST_ONLY_EFFECT_HELPER_URL: "http://127.0.0.1:32123",
    }),
  });
  t.after(() => incomplete.close());
  assert.equal((await incomplete.start()).state, "failed");
  assert.equal(incomplete.getStatus().message, "Runtime 连接失败，请关闭后重试");

  const testWithoutEffectConfig = new AppServerClient({
    command: process.execPath,
    args: ["--import", "tsx", "src/app-server/main.ts"],
    cwd: process.cwd(),
    env: createTestEnvironment(join(root, "test-without-effect-state.json"), {
      NODE_ENV: "test",
    }),
  });
  t.after(() => testWithoutEffectConfig.close());
  assert.equal((await testWithoutEffectConfig.start()).state, "connected");
  await testWithoutEffectConfig.close();
});

test("test-only Process Chaos model-response 窗口通过真实 App Server 子进程恢复", async (t) => {
  const output = await mkdtemp(join(tmpdir(), "god-agent-process-chaos-main-coverage-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const report = await runProcessChaosGate40CaseHarness(
    output,
    "coverage-main-model-response",
    PROCESS_CHAOS_MODEL_RESPONSE_COMMIT_WINDOW_ID,
  );
  if (report.schemaVersion !== "process-chaos-boundary-report-v1"
    || report.windowId !== PROCESS_CHAOS_MODEL_RESPONSE_COMMIT_WINDOW_ID) {
    throw new Error("unexpected Process Chaos model-response report shape");
  }
  assert.equal(report.schemaVersion, "process-chaos-boundary-report-v1");
  assert.equal(report.evidence.providerRequestsBeforeKill, 1);
  assert.equal(report.evidence.finalProviderRequests, 1);
  assert.equal(report.evidence.assistantMessageCount, 1);
  assert.equal(report.oracle.providerRequestNotRepeated, true);
  assert.equal(report.oracle.assistantCommittedOnce, true);
});

test("test-only Process Chaos receipt/proof 窗口恢复副作用凭据且不重复提交", async (t) => {
  for (const [windowId, seed] of [
    [PROCESS_CHAOS_RECEIPT_COMMIT_WINDOW_ID, "coverage-main-receipt"],
    [PROCESS_CHAOS_PROOF_COMMIT_WINDOW_ID, "coverage-main-proof"],
  ] as const) {
    const output = await mkdtemp(join(tmpdir(), `god-agent-process-chaos-${windowId.toLowerCase()}-`));
    t.after(() => rm(output, { recursive: true, force: true }));
    const report = await runProcessChaosGate40CaseHarness(output, seed, windowId);
    if (report.schemaVersion !== "process-chaos-boundary-report-v1" || report.windowId !== windowId) {
      throw new Error(`unexpected Process Chaos report shape for ${windowId}`);
    }
    assert.equal(report.schemaVersion, "process-chaos-boundary-report-v1");
    assert.equal(report.environment.provider.realApiCalls, false);
    if (report.windowId === PROCESS_CHAOS_RECEIPT_COMMIT_WINDOW_ID) {
      assert.equal(report.oracle.successorBoundPersistedReceipt, true);
    } else if (report.windowId === PROCESS_CHAOS_PROOF_COMMIT_WINDOW_ID) {
      assert.equal(report.oracle.proofDigestStable, true);
    } else {
      throw new Error(`unexpected Process Chaos effect window ${windowId}`);
    }
  }
});

test("App Server 启动时把持久化的 Process Chaos executing Tool 恢复为 result_received", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "god-agent-process-chaos-reconcile-"));
  const statePath = join(root, "runtime-state.json");
  const experimentDirectory = join(root, "experiment");
  await mkdir(experimentDirectory, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  const operationId = "recover-op-1";
  const payload = "recover-payload";
  const effectDigest = `sha256:${createHash("sha256").update(JSON.stringify({ operationId, payload }), "utf8").digest("hex")}`;
  const record = {
    operationId,
    payload,
    effectId: `effect-${effectDigest.slice(7, 39)}`,
    effectDigest,
    receipt: { receiptId: "receipt-recover", receiptDigest: `sha256:${"b".repeat(64)}`, receiptMac: `hmac-sha256:${"c".repeat(64)}` },
    proof: { proofId: "proof-recover", proofDigest: `sha256:${"d".repeat(64)}`, proofMac: `hmac-sha256:${"e".repeat(64)}` },
    effectApplyCount: 1 as const,
  };
  const helper = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(record));
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    helper.once("error", rejectPromise);
    helper.listen(0, "127.0.0.1", () => resolvePromise());
  });
  t.after(() => new Promise<void>((resolvePromise, rejectPromise) => {
    helper.close((error) => error === undefined ? resolvePromise() : rejectPromise(error));
  }));
  const address = helper.address();
  assert.ok(address !== null && typeof address !== "string");
  const helperUrl = `http://127.0.0.1:${address.port}`;

  const persistence = new JsonFileRuntimePersistence(statePath);
  const loaded = await persistence.load();
  const thread = loaded.lifecycleStore.createThread();
  const turn = loaded.lifecycleStore.createTurn(thread.id);
  loaded.lifecycleStore.appendItem(turn.id, "user_message", { text: "recover effect" });
  const argumentsJson = JSON.stringify({ action: "create_effect", operationId, payload });
  const model = loaded.modelInvocationStore.prepare({
    threadId: thread.id,
    turnId: turn.id,
    round: 0,
    purpose: "tool_round",
    requestDigest: createModelRequestDigest({ input: "recover" }),
    provider: "fake",
    model: "fake-model",
  });
  loaded.modelInvocationStore.markSubmitted(model.invocationId);
  loaded.modelInvocationStore.recordResponse(model.invocationId, {
    providerResponseId: "response-recover",
    normalizedResult: {
      text: "",
      functionCalls: [{ callId: "call-recover", name: "process_chaos_local_effect", arguments: argumentsJson }],
    },
  });
  loaded.modelInvocationStore.markCommitted(model.invocationId, `turn:${turn.id}:tool-round:0`);
  const tool = loaded.toolInvocationStore.prepare({
    modelInvocationId: model.invocationId,
    callId: "call-recover",
    toolName: "process_chaos_local_effect",
    argumentsDigest: createToolArgumentsDigest(argumentsJson),
    targetCommitKey: `turn:${turn.id}:tool:call-recover`,
  });
  loaded.toolInvocationStore.markExecuting(tool.toolInvocationId);
  await persistence.save(loaded);

  const client = new AppServerClient({
    command: process.execPath,
    args: ["--import", "tsx", "src/app-server/main.ts"],
    cwd: process.cwd(),
    env: createTestEnvironment(statePath, {
      NODE_ENV: "test",
      PROCESS_CHAOS_TEST_ONLY_EFFECT_HELPER_URL: helperUrl,
      PROCESS_CHAOS_TEST_ONLY_EXPERIMENT_DIRECTORY: experimentDirectory,
    }),
  });
  t.after(() => client.close());
  assert.equal((await client.start()).state, "connected");
  await client.close();

  const restored = await persistence.load();
  assert.equal(restored.toolInvocationStore.list()[0]?.status, "result_received");
  assert.equal(restored.toolInvocationStore.list()[0]?.result &&
    (restored.toolInvocationStore.list()[0]?.result as { action?: string }).action, "effect_created");
});

test("App Server 未指定 Skill 根时使用工作区和用户目录默认发现并安全 ready", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "god-agent-default-skill-roots-"));
  const statePath = join(root, "runtime-state.json");
  await mkdir(join(root, "workspace"), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = createTestEnvironment(statePath, { AGENT_WORKSPACE: join(root, "workspace") });
  delete env.AGENT_SKILLS_PATH;
  const diagnostics: string[] = [];
  const client = new AppServerClient({
    command: process.execPath,
    args: ["--import", "tsx", "src/app-server/main.ts"],
    cwd: process.cwd(),
    env,
    onDiagnostic: (message) => diagnostics.push(message),
  });
  t.after(() => client.close());
  const status = await client.start();
  assert.equal(status.state, "connected", diagnostics.join("\n"));
  assert.equal((await client.getCapabilities()).llm, false);
  await client.close();
});

test("真实 App Server 启动恢复同时收口终态 Job、过期 Task 与待投递 Return", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "god-agent-startup-reconcile-"));
  const statePath = join(root, "runtime-state.json");
  t.after(() => rm(root, { recursive: true, force: true }));
  const persistence = new JsonFileRuntimePersistence(statePath);
  const loaded = await persistence.load();

  const terminalThread = loaded.lifecycleStore.createThread();
  const terminalTurn = loaded.lifecycleStore.createTurn(terminalThread.id);
  const terminalRun = loaded.agentRunStore.ensureRoot(terminalThread.id, terminalTurn.id, "orchestrator", "job-terminal-startup");
  const plan = { path: join(root, "plan.md"), contentHash: "a".repeat(64), generatedAt: "2026-08-24T00:00:00.000Z" };
  const draft = { executionKind: "software_change" as const, title: "startup terminal", objective: "recover terminal",
    scope: ["src/**"], nonGoals: [], constraints: [], deliverables: ["state"], acceptanceCriteria: ["closed"],
    testCases: [{ id: "TC-1", title: "recover", kind: "recovery" as const, steps: ["restart"], expected: "closed" }], executionSteps: ["recover"] };
  const planned = loaded.requirementStore.prepare(terminalThread.id, draft, plan);
  loaded.requirementStore.confirm(planned.id, planned.revision, plan.contentHash);
  const terminalJob = loaded.agentRuntimeStore.createJob({ threadId: terminalThread.id, rootTurnId: terminalTurn.id,
    rootRunId: terminalRun.id, configSnapshot: DEFAULT_AGENT_TEAM_CONFIG, executionKind: "software_change",
    workflowVersion: "dynamic_v1", requirementId: planned.id, requirementRevision: planned.revision });
  loaded.requirementStore.attachJob(planned.id, terminalJob.id);
  const terminalTask = loaded.agentRuntimeStore.createTask({ jobId: terminalJob.id, rootRunId: terminalRun.id,
    ownerRunId: terminalRun.id, profileId: "coder", title: "leftover", objective: "leftover",
    scope: { allowedPaths: [], deniedPaths: [], nonGoals: [] }, requiredOutputs: [], acceptanceCriteria: [], fileClaims: [], maxAttempts: 1 });
  loaded.agentRuntimeStore.setJobStatus(terminalJob.id, "completed");

  const activeThread = loaded.lifecycleStore.createThread();
  const activeTurn = loaded.lifecycleStore.createTurn(activeThread.id);
  const activeRun = loaded.agentRunStore.ensureRoot(activeThread.id, activeTurn.id, "orchestrator", "job-active-startup");
  const activeJob = loaded.agentRuntimeStore.createJob({ threadId: activeThread.id, rootTurnId: activeTurn.id,
    rootRunId: activeRun.id, configSnapshot: DEFAULT_AGENT_TEAM_CONFIG, executionKind: "software_change", workflowVersion: "dynamic_v1" });
  const activeTask = loaded.agentRuntimeStore.createTask({ jobId: activeJob.id, rootRunId: activeRun.id,
    ownerRunId: activeRun.id, profileId: "coder", title: "expired", objective: "recover",
    scope: { allowedPaths: [], deniedPaths: [], nonGoals: [] }, requiredOutputs: [], acceptanceCriteria: [], fileClaims: [], maxAttempts: 2 });
  loaded.agentRuntimeStore.claimTask(activeTask.id, activeRun.id, 1);
  const pending = loaded.agentRuntimeStore.createReturn({ jobId: activeJob.id, rootRunId: activeRun.id,
    parentRunId: activeRun.id, childRunId: activeRun.id, taskId: activeTask.id, sequence: 1,
    result: { status: "completed", summary: "ready", evidenceIds: [], boardEntryIds: [] }, idempotencyKey: `${activeJob.id}:pending` });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await persistence.save(loaded);

  const diagnostics: string[] = [];
  const client = new AppServerClient({ command: process.execPath, args: ["--import", "tsx", "src/app-server/main.ts"],
    cwd: process.cwd(), env: createTestEnvironment(statePath), onDiagnostic: (message) => diagnostics.push(message) });
  t.after(() => client.close());
  assert.equal((await client.start()).state, "connected");
  assert.ok(diagnostics.some((message) => message.includes("recovered 1 lost Task lease(s) and 1 pending Return(s)")));
  await client.close();

  const restored = await persistence.load();
  assert.equal(restored.agentRuntimeStore.getTask(terminalTask.id)?.status, "cancelled");
  assert.equal(restored.requirementStore.get(planned.id)?.executionState, "completed");
  assert.equal(restored.agentRuntimeStore.getTask(activeTask.id)?.status, "lost");
  assert.equal(restored.agentRuntimeStore.listReturns(activeJob.id).find((item) => item.id === pending.id)?.status, "ready");
});

test("真实 App Server 在有 Provider 时恢复 V2 Job 并加载安全 Skill 工具", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "god-agent-startup-workflow-"));
  const statePath = join(root, "runtime-state.json");
  const skillRoot = join(root, "skills");
  await mkdir(join(skillRoot, "safe-review"), { recursive: true });
  await writeFile(join(skillRoot, "safe-review", "SKILL.md"), [
    "---", "name: safe-review", "description: startup recovery skill", "---", "Review safely.", "",
  ].join("\n"), "utf8");
  t.after(() => rm(root, { recursive: true, force: true }));
  const persistence = new JsonFileRuntimePersistence(statePath);
  const loaded = await persistence.load();
  const thread = loaded.lifecycleStore.createThread();
  const turn = loaded.lifecycleStore.createTurn(thread.id);
  const run = loaded.agentRunStore.ensureRoot(thread.id, turn.id, "orchestrator", "job-v2-startup");
  const job = loaded.agentRuntimeStore.createJob({ threadId: thread.id, rootTurnId: turn.id, rootRunId: run.id,
    configSnapshot: DEFAULT_AGENT_TEAM_CONFIG, executionKind: "software_product_delivery", workflowVersion: "software_product_delivery_v2" });
  await persistence.save(loaded);
  const client = new AppServerClient({ command: process.execPath, args: ["--import", "tsx", "src/app-server/main.ts"], cwd: process.cwd(),
    env: createTestEnvironment(statePath, { AGENT_SKILLS_PATH: skillRoot, OPENAI_API_KEY: "test-only-key",
      OPENAI_BASE_URL: "http://127.0.0.1:1", OPENAI_MODEL: "custom-startup-model" }) });
  t.after(() => client.close());
  assert.equal((await client.start()).state, "connected");
  const capabilities = await client.getCapabilities();
  assert.equal(capabilities.llm, true);
  assert.ok(capabilities.models.some((model) => model.id === "custom-startup-model"));
  assert.deepEqual(capabilities.skills, [{ name: "safe-review", description: "startup recovery skill" }]);
  assert.equal((await client.getAgentRuntime(thread.id) as { job?: { id: string } }).job?.id, job.id);
  await client.close();
});

test("真实 App Server 动态 Job 贯通根 Agent、子 Agent、独立 Reviewer 与父续跑", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "god-agent-live-dynamic-team-"));
  const statePath = join(root, "runtime-state.json");
  t.after(() => rm(root, { recursive: true, force: true }));
  const persistence = new JsonFileRuntimePersistence(statePath);
  const loaded = await persistence.load();
  const thread = loaded.lifecycleStore.createThread();
  const plan = { path: join(root, "plan.md"), contentHash: "b".repeat(64), generatedAt: "2026-08-24T00:00:00.000Z" };
  const requirement = loaded.requirementStore.prepare(thread.id, {
    executionKind: "software_change", title: "dynamic team", objective: "delegate and verify",
    scope: ["tests/**"], nonGoals: [], constraints: [], deliverables: ["verified result"],
    acceptanceCriteria: ["review passed"], testCases: [{ id: "TC-1", title: "team", kind: "positive",
      steps: ["delegate", "review", "resume"], expected: "completed" }], executionSteps: ["delegate"],
  }, plan);
  loaded.requirementStore.confirm(requirement.id, requirement.revision, plan.contentHash);
  await persistence.save(loaded);

  let requestCount = 0;
  const server = createServer((request, response) => {
    void readRequest(request).then(() => {
      requestCount += 1;
      const output = requestCount === 1
        ? [{ type: "function_call", call_id: "call-live-child", name: "run_agent",
            arguments: JSON.stringify({ profileId: "coder", task: "implement verified child",
              taskId: null, dependsOnTaskIds: [], fileClaims: [] }) }]
        : requestCount === 2
          ? [{ type: "message", content: [{ type: "output_text", text: "child implementation completed" }] }]
          : requestCount === 3
            ? [{ type: "message", content: [{ type: "output_text",
                text: JSON.stringify({ verdict: "pass", severity: null, summary: "independent review passed" }) }] }]
            : [{ type: "message", content: [{ type: "output_text", text: "parent accepted reviewed child" }] }];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: `response-live-${requestCount}`, output }));
    });
  });
  const baseUrl = await listen(server);
  t.after(() => closeServer(server));
  const client = new AppServerClient({ command: process.execPath, args: ["--import", "tsx", "src/app-server/main.ts"], cwd: process.cwd(),
    env: createTestEnvironment(statePath, { OPENAI_API_KEY: "test-only-key", OPENAI_BASE_URL: baseUrl }) });
  t.after(() => client.close());
  assert.equal((await client.start()).state, "connected");
  const turn = await client.startTurn(thread.id, "execute confirmed dynamic requirement");
  const result = await client.runTurn(turn.turn.id);
  assert.equal((result.assistantMessage.content as { text: string }).text, "parent accepted reviewed child");
  assert.equal(requestCount, 4);
  const runtime = await client.getAgentRuntime(thread.id) as { job?: { status: string }; tasks: Array<{ profileId: string; status: string }> };
  assert.equal(runtime.job?.status, "completed");
  assert.equal(runtime.tasks.some((task) => task.profileId === "coder" && task.status === "completed"), true);
  assert.equal(runtime.tasks.some((task) => task.profileId === "reviewer" && task.status === "completed"), true);
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

test("真实 App Server 收敛畸形输入并在 stdin 结束时安全关闭", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "god-agent-protocol-error-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, ["--import", "tsx", "src/app-server/main.ts"], {
    cwd: process.cwd(),
    env: createTestEnvironment(join(root, "runtime-state.json")),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  await waitFor(() => stderr.includes("[app-server] ready"), 5_000);

  child.stdin.write("{not-json\n");
  await waitFor(() => stderr.includes("[app-server] protocol error:"), 5_000);

  child.stdin.end();
  const [exitCode] = await once(child, "exit") as [number | null, string | null];
  assert.equal(exitCode, 0);
  assert.match(stderr, /\[app-server\] connection closed/);
});

test("真实 App Server RPC 生命周期与错误分支保持 fail-closed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "god-agent-rpc-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = new AppServerClient({
    command: process.execPath,
    args: ["--import", "tsx", "src/app-server/main.ts"],
    cwd: process.cwd(),
    env: createTestEnvironment(join(root, "runtime-state.json")),
    handshakeTimeoutMs: 5_000,
    shutdownTimeoutMs: 1_000,
  });
  t.after(() => client.close());

  assert.equal((await client.start()).state, "connected");
  const capabilities = await client.getCapabilities();
  assert.equal(capabilities.llm, false);
  assert.deepEqual(await client.listThreads(), []);

  const thread = await client.startThread();
  assert.equal(thread.status, "active");
  assert.equal((await client.listThreads()).length, 1);
  assert.equal((await client.renameThread(thread.id, "RPC lifecycle")).title, "RPC lifecycle");
  assert.equal((await client.readThreadHistory(thread.id)).thread.id, thread.id);
  assert.deepEqual(await client.getAgentRuntime(thread.id), {
    tasks: [], edges: [], evidence: [], board: [], returns: [],
  });
  assert.deepEqual(await client.listAgentRuns(thread.id), []);
  assert.deepEqual(await client.listRuntimeSessions(), []);
  const search = await client.searchWorkspaceFiles("package.json");
  assert.ok(Array.isArray(search.paths));
  await assert.rejects(
    () => client.selectModel("gpt-5.6-sol"),
    /Invalid model selection|model/i,
  );

  await assert.rejects(
    () => client.startTurn(thread.id, ""),
    /input|empty|Invalid|failed/i,
  );
  await assert.rejects(
    () => client.runTurn("missing-turn"),
    /not found|不存在|Invalid|failed|LLM is unavailable/i,
  );
  await assert.rejects(
    () => client.renameThread("missing-thread", "x"),
    /not found|不存在|Invalid|failed/i,
  );
});

function createTestEnvironment(
  statePath: string,
  additions: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    AGENT_STATE_PATH: statePath,
    AGENT_SKILLS_PATH: join(dirname(statePath), "skills"),
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

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for App Server diagnostic");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function readRequest(request: IncomingMessage): Promise<string> {
  request.setEncoding("utf8");
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return body;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
