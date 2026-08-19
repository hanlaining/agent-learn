import assert from "node:assert/strict";
import test from "node:test";

import {
  applyAgentModeToTools,
  applyRequirementGateToTools,
  buildParentAgentInstructions,
  selectInitialChildProfile,
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
import type { AgentRunResult } from "../src/agents/agent-run.js";
import type { PersistedThreadConfig } from "../src/runtime/json-file-runtime-persistence.js";
import { DEFAULT_AGENT_TEAM_CONFIG } from "../src/agents/agent-runtime.js";
import { AgentRegistry } from "../src/agents/agent-registry.js";
import { AgentRunStore } from "../src/agents/agent-run-store.js";
import { AgentRuntimeStore } from "../src/agents/agent-runtime-store.js";
import { RequirementStore } from "../src/requirements/requirement-store.js";
import { ExecutionEngineRouter } from "../src/execution/execution-engine-router.js";
import { DynamicAgentExecutionEngine } from "../src/execution/dynamic-agent-execution-engine.js";
import { TeamWorkflowExecutionEngine } from "../src/execution/team-workflow-execution-engine.js";
import { WorkflowTeamCoordinator } from "../src/execution/workflow-team-coordinator.js";
import { SOFTWARE_PRODUCT_DELIVERY_TEMPLATE } from "../src/execution/workflows/software-product-delivery.js";
import { ensureFixedSoftwareTeam } from "../src/agents/fixed-software-team.js";
import { STAGE_RESULT_CONTRACT_VERSION } from "../src/execution/stage-contract.js";
import {
  isThreadHistoryResult,
} from "../src/runtime/thread-history.js";
import {
  isRuntimeCapabilities,
  type RuntimeCapabilities,
} from "../src/app-server/runtime-capabilities.js";
import { OutcomeUnknownResolutionStore } from "../src/runtime/outcome-unknown-resolution-store.js";
import { OutcomeUnknownResolutionService } from "../src/runtime/outcome-unknown-resolution-service.js";
import type { OutcomeUnknownActor } from "../src/runtime/outcome-unknown-resolution.js";

function createTestAppServer(options: {
  lifecycleStore?: LifecycleStore;
  saveState?: () => void | Promise<void>;
  agentLoop?: Pick<AgentLoop, "run" | "cancel">;
  runtimeCapabilities?: RuntimeCapabilities;
  selectModel?: (model: string) => RuntimeCapabilities;
  threadConfigs?: Map<string, PersistedThreadConfig>;
  agentRegistry?: AgentRegistry;
  workspaceSandbox?: {
    searchFiles(query: string): Promise<{ query: string; paths: string[]; truncated: boolean }>;
    validateFilePath(path: string): Promise<string>;
  };
  skillNames?: string[];
  outcomeUnknownResolutionService?: OutcomeUnknownResolutionService;
  resolveOutcomeUnknownActor?: () => OutcomeUnknownActor | undefined;
  agentRunStore?: AgentRunStore;
  agentRuntimeStore?: AgentRuntimeStore;
  requirementStore?: RequirementStore;
  executionEngineRouter?: ExecutionEngineRouter;
} = {}) {
  const clientToServer: string[] = [];
  const serverToClient: string[] = [];

  const client = new JsonRpcConnection((data) => {
    clientToServer.push(data);
  });

  const server = new JsonRpcConnection((data) => {
    serverToClient.push(data);
  });

  const idSequence = {
    thread: 0,
    turn: 0,
    item: 0,
  };

  const store = options.lifecycleStore ?? new LifecycleStore({
    now: () => "2026-08-01T09:00:00.000Z",
    createId: (prefix) => {
      idSequence[prefix] += 1;
      return `${prefix}-test-${idSequence[prefix]}`;
    },
  });

  registerAppServerHandlers(server, {
    lifecycleStore: store,
    ...(options.saveState === undefined
      ? {}
      : { saveState: options.saveState }),
    ...(options.agentLoop === undefined
      ? {}
      : { agentLoop: options.agentLoop }),
    ...(options.runtimeCapabilities === undefined
      ? {}
      : { runtimeCapabilities: options.runtimeCapabilities }),
    ...(options.selectModel === undefined
      ? {}
      : { selectModel: options.selectModel }),
    ...(options.threadConfigs === undefined
      ? {}
      : { threadConfigs: options.threadConfigs }),
    ...(options.agentRegistry === undefined
      ? {}
      : { agentRegistry: options.agentRegistry }),
    ...(options.workspaceSandbox === undefined ? {} : { workspaceSandbox: options.workspaceSandbox }),
    ...(options.skillNames === undefined ? {} : { skillNames: options.skillNames }),
    ...(options.outcomeUnknownResolutionService === undefined
      ? {}
      : { outcomeUnknownResolutionService: options.outcomeUnknownResolutionService }),
    ...(options.resolveOutcomeUnknownActor === undefined
      ? {}
      : { resolveOutcomeUnknownActor: options.resolveOutcomeUnknownActor }),
    ...(options.agentRunStore === undefined ? {} : { agentRunStore: options.agentRunStore }),
    ...(options.agentRuntimeStore === undefined ? {} : { agentRuntimeStore: options.agentRuntimeStore }),
    ...(options.requirementStore === undefined ? {} : { requirementStore: options.requirementStore }),
    ...(options.executionEngineRouter === undefined ? {} : { executionEngineRouter: options.executionEngineRouter }),
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

test("outcome_unknown API 只接受服务端 resolutionId/version，不允许伪造 Invocation identity 或 digest", async () => {
  const resolutionStore = new OutcomeUnknownResolutionStore();
  const resolutionService = new OutcomeUnknownResolutionService(resolutionStore);
  await resolutionService.registerFromRuntime({
    invocationKind: "model",
    invocationId: "model-invocation-api-1",
    requestDigest: `sha256:${"b".repeat(64)}`,
    identity: {
      threadId: "thread-api-1",
      turnId: "turn-api-1",
      displayName: "生成回复",
      provider: "openai",
      model: "gpt-5.6-sol",
    },
    sideEffectRisk: "none",
  });
  const actor: OutcomeUnknownActor = {
    id: "desktop-user",
    permissions: ["invocation:view", "invocation:resolve"],
  };
  const app = createTestAppServer({
    outcomeUnknownResolutionService: resolutionService,
    resolveOutcomeUnknownActor: () => actor,
  });
  await completeHandshake(app);

  const listPromise = app.client.sendRequest("invocation/outcome-unknown/list", { threadId: "thread-api-1" });
  await app.flushClientRequest();
  const records = await listPromise as Array<{ resolutionId: string; version: number; audit: unknown[] }>;
  assert.equal(records.length, 1);

  const forged = app.client.sendRequest("invocation/outcome-unknown/resolve", {
    resolutionId: records[0]!.resolutionId,
    expectedVersion: records[0]!.version,
    idempotencyKey: "forged-api-request",
    invocationId: "forged",
    requestDigest: `sha256:${"0".repeat(64)}`,
    resolution: { action: "abandon", reason: "非法字段" },
  });
  const forgedRejected = assert.rejects(forged);
  await app.flushClientRequest();
  await forgedRejected;
  assert.equal(resolutionService.list(actor)[0]?.audit.length, 0);

  const resolvePromise = app.client.sendRequest("invocation/outcome-unknown/resolve", {
    resolutionId: records[0]!.resolutionId,
    expectedVersion: records[0]!.version,
    idempotencyKey: "valid-api-request",
    resolution: { action: "abandon", reason: "人工决定停止" },
  });
  await app.flushClientRequest();
  const resolved = await resolvePromise as { state: string; audit: unknown[] };
  assert.equal(resolved.state, "abandoned");
  assert.equal(resolved.audit.length, 1);
});

test("outcome_unknown API 使用服务端操作者权限并拒绝无权限请求", async () => {
  const resolutionService = new OutcomeUnknownResolutionService(new OutcomeUnknownResolutionStore());
  await resolutionService.registerFromRuntime({
    invocationKind: "tool",
    invocationId: "tool-invocation-api-1",
    requestDigest: `sha256:${"c".repeat(64)}`,
    identity: {
      threadId: "thread-api-2",
      turnId: "turn-api-2",
      displayName: "写入外部系统",
      toolName: "external_write",
      callId: "call-api-2",
    },
    sideEffectRisk: "known",
  });
  const app = createTestAppServer({
    outcomeUnknownResolutionService: resolutionService,
    resolveOutcomeUnknownActor: () => ({ id: "viewer", permissions: ["invocation:view"] }),
  });
  await completeHandshake(app);
  const [record] = resolutionService.list({ id: "operator", permissions: ["invocation:view"] });
  assert.ok(record);
  const request = app.client.sendRequest("invocation/outcome-unknown/resolve", {
    resolutionId: record.resolutionId,
    expectedVersion: record.version,
    idempotencyKey: "denied-api-request",
    resolution: { action: "abandon", reason: "无权限" },
  });
  const rejected = assert.rejects(request);
  await app.flushClientRequest();
  await rejected;
});

test("turn/start 直接 RPC 拒绝未知字段、超长输入和非法 Skill 名", async () => {
  const app = createTestAppServer();
  await completeHandshake(app);
  const threadPromise = app.client.sendRequest("thread/start");
  await app.flushClientRequest();
  const thread = await threadPromise;
  assert.ok(isThread(thread));

  const invalidParams = [
    { threadId: thread.id, input: "ok", unknown: true },
    { threadId: thread.id, input: "x".repeat(32_001) },
    { threadId: thread.id, input: "ok", explicitSkills: ["Bad Skill"] },
    { threadId: thread.id, input: "ok", mentions: [{ kind: "file", path: "safe.ts\n" }] },
  ];
  for (const params of invalidParams) {
    const request = app.client.sendRequest("turn/start", params);
    const rejected = assert.rejects(request);
    await app.flushClientRequest();
    await rejected;
  }
  assert.deepEqual(app.store.getThread(thread.id)?.turnIds, []);
});

test("turn/start 对重复显式上下文去重后再持久化", async () => {
  const app = createTestAppServer({
    workspaceSandbox: {
      searchFiles: async (query) => ({ query, paths: [], truncated: false }),
      validateFilePath: async (path) => path,
    },
    skillNames: ["code-review"],
  });
  await completeHandshake(app);
  const threadPromise = app.client.sendRequest("thread/start");
  await app.flushClientRequest();
  const thread = await threadPromise;
  assert.ok(isThread(thread));
  const request = app.client.sendRequest("turn/start", {
    threadId: thread.id,
    input: "检查",
    mentions: [{ kind: "file", path: "src/app.ts" }, { kind: "file", path: "src/app.ts" }],
    explicitSkills: ["code-review", "code-review"],
  });
  await app.flushClientRequest();
  const result = await request;
  assert.ok(isTurnStartResult(result));
  const content = result.userMessage.content as { mentions: unknown[]; explicitSkills: string[]; modelText: string };
  assert.equal(content.mentions.length, 1);
  assert.deepEqual(content.explicitSkills, ["code-review"]);
  assert.equal(content.modelText.match(/workspace file/g)?.length, 1);
  assert.equal(content.modelText.match(/Skill: code-review/g)?.length, 1);
});

test("工作区候选与显式文件和 Skill 在 App Server 边界再次验证", async () => {
  const app = createTestAppServer({
    workspaceSandbox: {
      searchFiles: async (query) => ({ query, paths: ["src/app.ts"], truncated: false }),
      validateFilePath: async (path) => {
        if (path !== "src/app.ts") throw new Error("Path escapes workspace");
        return path;
      },
    },
    skillNames: ["finance-analysis"],
  });
  await completeHandshake(app);
  const searchPromise = app.client.sendRequest("workspace/search-files", { query: "app" });
  await app.flushClientRequest();
  assert.deepEqual(await searchPromise, { query: "app", paths: ["src/app.ts"], truncated: false });
  const threadPromise = app.client.sendRequest("thread/start");
  await app.flushClientRequest();
  const thread = await threadPromise;
  assert.ok(isThread(thread));
  const turnPromise = app.client.sendRequest("turn/start", {
    threadId: thread.id,
    input: "请检查 @src/app.ts 并使用 $finance-analysis",
    mentions: [{ kind: "file", path: "src/app.ts" }],
    explicitSkills: ["finance-analysis"],
  });
  await app.flushClientRequest();
  const result = await turnPromise;
  assert.ok(isTurnStartResult(result));
  assert.deepEqual(result.userMessage.content, {
    text: "请检查 @src/app.ts 并使用 $finance-analysis",
    modelText: "请检查 @src/app.ts 并使用 $finance-analysis\n\n[用户显式选择的上下文；仅按列出的相对路径与 Skill 名称处理]\n- workspace file: src/app.ts\n- Skill: finance-analysis（先调用 read_skill 读取完整说明）",
    mentions: [{ kind: "file", path: "src/app.ts" }],
    explicitSkills: ["finance-analysis"],
  });
});

test("确认硬门与子 Agent 开关共同控制执行工具和父 Agent 合同", () => {
  assert.deepEqual(applyAgentModeToTools(["*"], "off"), ["*", "!run_agent"]);
  assert.deepEqual(applyAgentModeToTools(["read_file", "run_agent"], "off"), ["read_file"]);
  assert.deepEqual(applyAgentModeToTools(["*"], "auto"), ["*"]);

  assert.deepEqual(applyRequirementGateToTools(["*"], false), ["*", "!run_agent", "!run_command", "!write_file", "!read_shared_board", "!publish_shared_result"]);
  assert.deepEqual(applyRequirementGateToTools(["read_file", "read_shared_board", "publish_shared_result"], false), ["read_file"]);
  const clarifying = buildParentAgentInstructions("基础指令", "auto");
  assert.match(clarifying, /clarify-before-execute/);
  assert.match(clarifying, /确认前不得执行命令/);

  const disabled = buildParentAgentInstructions("基础指令", "off", undefined, true);
  assert.match(disabled, /必须独立完成/);
  assert.match(disabled, /不得创建或委派子 Agent/);

  const enabled = buildParentAgentInstructions("基础指令", "auto", undefined, true);
  assert.match(enabled, /父 Agent和监工/);
  assert.match(enabled, /委派给子 Agent/);
  assert.match(enabled, /检查 Evidence、验收 Return/);
  assert.match(enabled, /实际执行工作必须委派给子 Agent完成/);

  const delivered = buildParentAgentInstructions("基础指令", "auto", {
    runId: "child-1", status: "completed", summary: "子任务已完成",
  }, true);
  assert.match(delivered, /Runtime 已强制派发首个子 Agent/);
  assert.match(delivered, /子任务已完成/);

  assert.equal(selectInitialChildProfile("修复项目代码", ["coder", "researcher"]), "coder");
  assert.equal(selectInitialChildProfile("查询今年政策", ["coder", "researcher"]), "researcher");
  assert.equal(selectInitialChildProfile("分析这个问题", ["investigator", "coder"]), "investigator");
});

test("开启子 Agent 但需求未确认时不会开放执行工具", async () => {
  const threadConfigs = new Map<string, PersistedThreadConfig>();
  let parentInstructions = "";
  const app = createTestAppServer({
    threadConfigs,
    agentRegistry: new AgentRegistry(),
    agentLoop: {
      cancel: () => false,
      run: async (turnId, options) => {
        parentInstructions = options?.instructions ?? "";
        return {
          turn: { id: turnId, threadId: "thread-test-1", status: "completed", createdAt: "2026-08-01T09:00:00.000Z", completedAt: "2026-08-01T09:00:01.000Z", itemIds: [] },
          assistantMessage: { id: "item-result", threadId: "thread-test-1", turnId, type: "assistant_message", content: { text: "父 Agent 汇总" }, createdAt: "2026-08-01T09:00:01.000Z" },
        };
      },
    },
  });
  await completeHandshake(app);
  const threadPromise = app.client.sendRequest("thread/start");
  await app.flushClientRequest();
  const thread = await threadPromise as { id: string };
  threadConfigs.set(thread.id, {
    threadId: thread.id,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    agentProfileId: "orchestrator",
    agentTeam: { ...DEFAULT_AGENT_TEAM_CONFIG, mode: "auto" },
  });
  const turnPromise = app.client.sendRequest("turn/start", { threadId: thread.id, input: "修复项目代码" });
  await app.flushClientRequest();
  const turn = await turnPromise as { turn: { id: string } };
  const runPromise = app.client.sendRequest("turn/run", { turnId: turn.turn.id });
  await app.flushClientRequest();
  await runPromise;

  assert.match(parentInstructions, /确认前不得执行命令/);
  assert.match(parentInstructions, /prepare_requirement_plan/);
});

test("真实 turn\/run 从 child blocked 返回父级引导，同 Job 吸收用户反馈后恢复且只交付一次", async () => {
  const lifecycle = new LifecycleStore();
  const runs = new AgentRunStore();
  const runtime = new AgentRuntimeStore();
  const requirements = new RequirementStore();
  const stageProfiles: string[] = [];
  const stagePrompts: string[] = [];
  const rootStates: string[] = [];
  let productCalls = 0;
  let engineeringCalls = 0;
  let rootAgentCalls = 0;

  const finalRootAgent: Pick<AgentLoop, "run" | "cancel"> = {
    cancel: () => false,
    run: async (turnId) => {
      rootAgentCalls += 1;
      const before = lifecycle.getTurn(turnId);
      assert.ok(before);
      const assistantMessage = lifecycle.appendItem(turnId, "assistant_message", {
        text: "团队已完成且只交付一次",
      });
      const turn = lifecycle.completeTurn(turnId);
      return { turn, assistantMessage };
    },
  };
  const coordinator = new WorkflowTeamCoordinator({
    runStore: runs,
    runtimeStore: runtime,
    template: SOFTWARE_PRODUCT_DELIVERY_TEMPLATE,
    requirement: () => ({
      objective: "修复父 Agent 监督主链",
      scope: ["src/**"],
      nonGoals: ["不改 UI"],
      deliverables: ["code"],
      acceptanceCriteria: ["tests pass"],
      prompt: "confirmed requirement",
    }),
    feedback: (jobId) => {
      const job = runtime.getJob(jobId);
      const item = job === undefined ? undefined : lifecycle.getItemsForTurn(job.rootTurnId)
        .filter((candidate) => candidate.type === "user_message")
        .at(-1);
      const text = typeof item?.content === "object" && item.content !== null &&
        "text" in item.content && typeof item.content.text === "string"
        ? item.content.text
        : undefined;
      return job === undefined || text === undefined ? undefined : { turnId: job.rootTurnId, text };
    },
    execute: async (input) => {
      stageProfiles.push(input.profileId);
      stagePrompts.push(input.prompt);
      const job = runtime.getJob(input.jobId);
      assert.ok(job);
      rootStates.push(runs.get(job.rootRunId)?.status ?? "missing");
      if (input.profileId === "orchestrator") {
        const delivered = await finalRootAgent.run(job.rootTurnId);
        return { turnId: delivered.turn.id, summary: (delivered.assistantMessage.content as { text: string }).text };
      }
      if (input.profileId === "product_role") productCalls += 1;
      const blocked = input.profileId === "engineering_role" && ++engineeringCalls === 1;
      return {
        turnId: `stage-turn-${stageProfiles.length}`,
        summary: JSON.stringify({
          status: blocked ? "blocked" : "completed",
          summary: blocked ? "需要用户确认 API 兼容范围" : `${input.profileId} complete`,
          deliverables: blocked ? [] : ["artifact"],
          evidence: [blocked ? "missing API compatibility choice" : "verified"],
          blockers: blocked ? ["API compatibility choice is required"] : [],
          nextStageRecommendation: blocked ? "block" : "continue",
          contractVersion: STAGE_RESULT_CONTRACT_VERSION,
        }),
      };
    },
  });
  const router = new ExecutionEngineRouter([
    new DynamicAgentExecutionEngine(runtime),
    new TeamWorkflowExecutionEngine(runtime, coordinator, (context) => {
      const root = runs.get(context.rootRunId);
      assert.ok(root);
      ensureFixedSoftwareTeam(lifecycle, runs, root);
    }),
  ]);
  const app = createTestAppServer({
    lifecycleStore: lifecycle,
    agentLoop: finalRootAgent,
    agentRegistry: new AgentRegistry(),
    agentRunStore: runs,
    agentRuntimeStore: runtime,
    requirementStore: requirements,
    executionEngineRouter: router,
  });

  await completeHandshake(app);
  const threadRequest = app.client.sendRequest("thread/start");
  await app.flushClientRequest();
  const thread = await threadRequest as { id: string };
  const planned = requirements.prepare(thread.id, {
    executionKind: "software_product_delivery",
    title: "P0 Parent Supervisor",
    objective: "修复父 Agent 监督主链",
    scope: ["src/**"],
    nonGoals: ["不改 UI"],
    constraints: ["单一控制面"],
    deliverables: ["code"],
    acceptanceCriteria: ["tests pass"],
    testCases: [{ id: "TC-P0", title: "真实入口", kind: "integration", steps: ["turn/run"], expected: "自动收口" }],
    executionSteps: ["产品", "工程", "测试", "负责人", "交付"],
  }, { path: "D:/plans/p0.md", contentHash: "p0-hash", generatedAt: "2026-08-19T00:00:00.000Z" });
  requirements.confirm(planned.id, planned.revision, planned.planArtifact.contentHash);

  const turnRequest = app.client.sendRequest("turn/start", { threadId: thread.id, input: "确认执行" });
  await app.flushClientRequest();
  const started = await turnRequest as { turn: { id: string } };
  const runRequest = app.client.sendRequest("turn/run", { turnId: started.turn.id });
  await app.flushClientRequest();
  const paused = await runRequest as { assistantMessage: { content: { text: string } } };

  const pausedJob = runtime.getJobByRequirement(planned.id, planned.revision);
  assert.ok(pausedJob);
  assert.match(paused.assistantMessage.content.text, /需要你补充信息/);
  assert.equal(runtime.getJob(pausedJob.id)?.status, "reviewing");
  assert.equal(requirements.get(planned.id)?.executionState, "executing");
  assert.equal(runs.get(pausedJob.rootRunId)?.status, "waiting_children");
  assert.equal(runs.listForJob(pausedJob.id).find((item) => item.agentProfileId === "software_team_lead")?.status, "waiting_children");
  assert.equal(runs.listForJob(pausedJob.id).some((item) => item.status === "failed"), false);
  assert.deepEqual(stageProfiles, ["product_role", "engineering_role"]);
  assert.equal(rootAgentCalls, 0);
  assert.equal(runtime.listJobs().length, 1);
  assert.equal(runs.listForJob(pausedJob.id).length, 5);

  const feedbackText = "补充反馈：保留 v1 API 兼容，新能力放到 v2";
  const feedbackTurnRequest = app.client.sendRequest("turn/start", { threadId: thread.id, input: feedbackText });
  await app.flushClientRequest();
  const feedbackTurn = await feedbackTurnRequest as { turn: { id: string } };
  const resumeRequest = app.client.sendRequest("turn/run", { turnId: feedbackTurn.turn.id });
  await app.flushClientRequest();
  const result = await resumeRequest as { turn: { id: string }; assistantMessage: { content: { text: string } } };

  const completedJob = runtime.getJobByRequirement(planned.id, planned.revision);
  assert.ok(completedJob);
  assert.equal(completedJob.id, pausedJob.id);
  assert.equal(completedJob.rootTurnId, feedbackTurn.turn.id);
  assert.equal(result.turn.id, feedbackTurn.turn.id);
  assert.equal(result.assistantMessage.content.text, "团队已完成且只交付一次");
  assert.deepEqual(stageProfiles, ["product_role", "engineering_role", "engineering_role", "quality_role", "software_team_lead", "orchestrator"]);
  assert.match(stagePrompts[2] ?? "", /保留 v1 API 兼容/);
  assert.equal(productCalls, 1);
  assert.equal(engineeringCalls, 2);
  assert.equal(rootAgentCalls, 1);
  assert.deepEqual(rootStates, [
    "waiting_children",
    "waiting_children",
    "waiting_children",
    "waiting_children",
    "waiting_children",
    "resuming",
  ]);
  assert.equal(runtime.listJobs().length, 1);
  assert.equal(runs.listForJob(completedJob.id).length, 5);
  assert.equal(runtime.getJob(completedJob.id)?.status, "completed");
  assert.equal(runs.get(completedJob.rootRunId)?.status, "completed");
  assert.equal(requirements.get(planned.id)?.executionState, "completed");
});

test("运行中的 Team Workflow 拒绝第二 Turn 且不重绑或复制原 Job 与五角色团队", async () => {
  const lifecycle = new LifecycleStore();
  const runs = new AgentRunStore();
  const runtime = new AgentRuntimeStore();
  const requirements = new RequirementStore();
  let rootAgentCalls = 0;
  const coordinator = new WorkflowTeamCoordinator({
    runStore: runs,
    runtimeStore: runtime,
    template: SOFTWARE_PRODUCT_DELIVERY_TEMPLATE,
    requirement: () => ({
      objective: "保持运行中工作流边界",
      scope: ["src/**"],
      nonGoals: [],
      deliverables: ["code"],
      acceptanceCriteria: ["第二 Turn 不影响原工作流"],
      prompt: "confirmed requirement",
    }),
    execute: async () => {
      throw new Error("busy handler must not drive the existing workflow");
    },
  });
  const router = new ExecutionEngineRouter([
    new DynamicAgentExecutionEngine(runtime),
    new TeamWorkflowExecutionEngine(runtime, coordinator, (context) => {
      const root = runs.get(context.rootRunId);
      assert.ok(root);
      ensureFixedSoftwareTeam(lifecycle, runs, root);
    }),
  ]);
  const app = createTestAppServer({
    lifecycleStore: lifecycle,
    agentLoop: {
      cancel: () => false,
      run: async () => {
        rootAgentCalls += 1;
        throw new Error("busy handler must not call the root Agent");
      },
    },
    agentRegistry: new AgentRegistry(),
    agentRunStore: runs,
    agentRuntimeStore: runtime,
    requirementStore: requirements,
    executionEngineRouter: router,
  });

  await completeHandshake(app);
  const threadRequest = app.client.sendRequest("thread/start");
  await app.flushClientRequest();
  const thread = await threadRequest as { id: string };
  const planned = requirements.prepare(thread.id, {
    executionKind: "software_product_delivery",
    title: "P0 Active Workflow Boundary",
    objective: "保持运行中工作流边界",
    scope: ["src/**"],
    nonGoals: [],
    constraints: ["同一需求只允许一个活动 Job"],
    deliverables: ["code"],
    acceptanceCriteria: ["第二 Turn 不影响原工作流"],
    testCases: [{ id: "TC-P0-BUSY", title: "并发第二 Turn", kind: "integration", steps: ["turn/run"], expected: "非破坏性拒绝" }],
    executionSteps: ["产品", "工程", "测试", "负责人", "交付"],
  }, { path: "D:/plans/active-workflow.md", contentHash: "active-workflow-hash", generatedAt: "2026-08-19T00:00:00.000Z" });
  requirements.confirm(planned.id, planned.revision, planned.planArtifact.contentHash);

  const originalTurnRequest = app.client.sendRequest("turn/start", { threadId: thread.id, input: "确认执行原工作流" });
  await app.flushClientRequest();
  const originalTurn = await originalTurnRequest as { turn: { id: string } };
  const jobId = `job-${planned.id}-v${planned.revision}`;
  const root = runs.ensureRoot(thread.id, originalTurn.turn.id, "orchestrator", jobId);
  const job = runtime.createJob({
    threadId: thread.id,
    rootTurnId: originalTurn.turn.id,
    rootRunId: root.id,
    configSnapshot: DEFAULT_AGENT_TEAM_CONFIG,
    executionKind: "software_product_delivery",
    workflowVersion: "software_product_delivery_v2",
    requirementId: planned.id,
    requirementRevision: planned.revision,
  });
  runtime.setJobStatus(job.id, "running");
  runs.setStatus(root.id, "waiting_children");
  ensureFixedSoftwareTeam(lifecycle, runs, runs.get(root.id)!);
  requirements.attachJob(planned.id, job.id);

  const originalJob = runtime.getJob(job.id);
  const originalRoot = runs.get(root.id);
  const originalTeam = runs.listForJob(job.id);
  const originalTurnFact = lifecycle.getTurn(originalTurn.turn.id);
  assert.ok(originalJob);
  assert.ok(originalRoot);
  assert.equal(originalTeam.length, 5);

  const secondTurnRequest = app.client.sendRequest("turn/start", { threadId: thread.id, input: "运行期间的第二条消息" });
  await app.flushClientRequest();
  const secondTurn = await secondTurnRequest as { turn: { id: string } };
  const secondRunRequest = app.client.sendRequest("turn/run", { turnId: secondTurn.turn.id });
  await app.flushClientRequest();
  const result = await secondRunRequest as { turn: { id: string; status: string }; assistantMessage: { content: { text: string } } };

  assert.equal(result.turn.id, secondTurn.turn.id);
  assert.equal(result.turn.status, "completed");
  assert.match(result.assistantMessage.content.text, /仍在执行/);
  assert.match(result.assistantMessage.content.text, /未进入队列/);
  assert.match(result.assistantMessage.content.text, /完成或暂停后再发送/);
  assert.equal(rootAgentCalls, 0);
  assert.equal(runtime.listJobs().length, 1);
  assert.deepEqual(runtime.getJob(job.id), originalJob);
  assert.deepEqual(runs.get(root.id), originalRoot);
  assert.deepEqual(runs.listForJob(job.id), originalTeam);
  assert.deepEqual(lifecycle.getTurn(originalTurn.turn.id), originalTurnFact);
  assert.equal(runtime.getJob(job.id)?.rootTurnId, originalTurn.turn.id);
  assert.equal(runtime.getJob(job.id)?.rootRunId, root.id);
  assert.equal(runtime.getJob(job.id)?.status, "running");
  assert.equal(runs.list().length, 5);
  assert.equal(runs.listForJob(job.id).some((item) => item.status === "failed"), false);
  assert.equal(requirements.get(planned.id)?.jobId, job.id);
  assert.equal(requirements.get(planned.id)?.executionState, "executing");
});

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
  app.store.createThread("agent_internal");

  await completeHandshake(app);

  const resultPromise = app.client.sendRequest("thread/list");
  await app.flushClientRequest();
  const result = await resultPromise;

  assert.ok(Array.isArray(result));
  assert.equal(result.length, 1);
  assert.ok(isThread(result[0]));
  assert.equal(result[0].id, existingThread.id);
});

test("thread/history 只返回可展示的对话消息", async () => {
  const app = createTestAppServer();
  const thread = app.store.createThread();
  const turn = app.store.createTurn(thread.id);
  app.store.appendItem(turn.id, "user_message", {
    text: "第一条消息",
  });
  app.store.appendItem(turn.id, "tool_result", {
    raw: "hidden tool result",
  });
  app.store.appendItem(turn.id, "assistant_message", {
    text: "第一条回复",
  });
  app.store.completeTurn(turn.id);

  await completeHandshake(app);
  const resultPromise = app.client.sendRequest(
    "thread/history",
    { threadId: thread.id },
  );
  await app.flushClientRequest();
  const result = await resultPromise;

  assert.ok(isThreadHistoryResult(result));
  assert.equal(result.messages.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /hidden tool result/);
});

test("runtime/capabilities 返回安全能力目录", async () => {
  const app = createTestAppServer({
    runtimeCapabilities: {
      llm: true,
      currentModel: "gpt-5.6-sol",
      models: [{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol" }],
      webSearch: true,
      tools: [{
        name: "read_file",
        description: "读取工作区文本",
        source: "workspace",
      }],
      skills: [{
        name: "demo-skill",
        description: "演示 Skill",
      }],
      mcpServers: [{
        name: "demo-mcp",
        protocolVersion: "2026-07-28",
        toolCount: 2,
      }],
    },
  });

  await completeHandshake(app);
  const resultPromise = app.client.sendRequest(
    "runtime/capabilities",
  );
  await app.flushClientRequest();
  const result = await resultPromise;

  assert.ok(isRuntimeCapabilities(result));
  assert.equal(result.tools.length, 1);
  assert.equal(result.skills.length, 1);
  assert.equal(result.mcpServers.length, 1);
});

test("runtime/select-model 只通过受控选择器切换模型", async () => {
  const allowed = new Set(["gpt-5.6-sol", "gpt-5.6-terra"]);
  const selected: string[] = [];
  const app = createTestAppServer({
    selectModel: (model) => {
      if (!allowed.has(model)) {
        throw new Error("Model is not available");
      }
      selected.push(model);
      return {
        llm: true,
        currentModel: model,
        models: [...allowed].map((id) => ({ id, label: id })),
        webSearch: false,
        tools: [],
        skills: [],
        mcpServers: [],
      };
    },
  });
  await completeHandshake(app);

  const validPromise = app.client.sendRequest("runtime/select-model", {
    model: "gpt-5.6-terra",
  });
  await app.flushClientRequest();
  const valid = await validPromise;
  assert.ok(isRuntimeCapabilities(valid));
  assert.equal(valid.currentModel, "gpt-5.6-terra");
  assert.deepEqual(selected, ["gpt-5.6-terra"]);

  const invalidPromise = app.client.sendRequest("runtime/select-model", {
    model: "unlisted-model",
  });
  const rejection = assert.rejects(invalidPromise, /Model is not available/);
  await app.flushClientRequest();
  await rejection;
  assert.deepEqual(selected, ["gpt-5.6-terra"]);
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
