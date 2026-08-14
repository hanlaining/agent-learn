import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import { JsonRpcConnection } from "../protocol/connection.js";
import {
  AgentLoop,
} from "../agent/agent-loop.js";
import type {
  AgentEventSink,
} from "../agent/events.js";
import {
  OpenAiResponsesProvider,
} from "../llm/openai-responses.js";
import {
  loadMcpServerConfigs,
} from "../mcp/mcp-config.js";
import {
  McpManager,
} from "../mcp/mcp-manager.js";
import {
  JsonRpcPermissionGate,
} from "../permissions/json-rpc-permission-gate.js";
import {
  JsonFileRuntimePersistence,
} from "../runtime/json-file-runtime-persistence.js";
import {
  ItemBudget,
} from "../runtime/item-budget.js";
import {
  WorkspaceSandbox,
} from "../sandbox/workspace-sandbox.js";
import {
  WorkspaceCommandRunner,
} from "../sandbox/workspace-command-runner.js";
import {
  SkillLoader,
} from "../skills/skill-loader.js";
import {
  financeMonthlySummaryAgentTool,
} from "../tools/finance-monthly-summary-tool.js";
import {
  ToolRegistry,
  type AgentTool,
} from "../tools/tool-registry.js";
import {
  createRunCommandTool,
} from "../tools/run-command-tool.js";
import {
  createReadSkillTool,
} from "../tools/read-skill-tool.js";
import {
  createWorkspaceTools,
} from "../tools/workspace-tools.js";
import {
  registerAppServerHandlers,
} from "./handlers.js";
import { AgentRegistry } from "../agents/agent-registry.js";
import { AgentRunStore } from "../agents/agent-run-store.js";
import { MultiAgentScheduler } from "../agents/multi-agent-scheduler.js";
import { AgentRuntimeCoordinator } from "../agents/agent-runtime-coordinator.js";
import { FixedSoftwareTeamCoordinator } from "../agents/fixed-software-team-coordinator.js";
import { createRunAgentTool } from "../tools/run-agent-tool.js";
import { createSharedBoardTools } from "../tools/shared-board-tools.js";
import { createPrepareRequirementPlanTool } from "../tools/prepare-requirement-plan-tool.js";
import { RequirementPlanWriter } from "../requirements/requirement-plan-writer.js";
import type {
  RuntimeCapabilities,
  RuntimeModelCapability,
  RuntimeToolCapability,
} from "./runtime-capabilities.js";

const connection = new JsonRpcConnection((data) => {
  // stdout 只能输出 JSONL 协议消息
  process.stdout.write(data);
});

const apiKey = process.env.OPENAI_API_KEY;
const mcpConfigPath = process.env.AGENT_MCP_CONFIG;

// 默认状态进入用户数据目录，不在项目仓库产生运行时文件。
const defaultStateRoot =
  process.env.LOCALAPPDATA ??
  join(homedir(), ".local", "share");
const runtimePersistence = new JsonFileRuntimePersistence(
  process.env.AGENT_STATE_PATH ??
    join(defaultStateRoot, "god-agent", "runtime-state.json"),
);
const loadedRuntimeState = await runtimePersistence.load();
const {
  lifecycleStore,
  contextCheckpointStore,
  agentRunStore,
  agentRuntimeStore,
  requirementStore,
} = loadedRuntimeState;
const threadConfigs = new Map(
  loadedRuntimeState.threadConfigs.map((config) => [config.threadId, config]),
);
const runtimeSessions = new Map(
  loadedRuntimeState.runtimeSessions.map((session) => [session.threadId, session]),
);
const persistRuntimeState = () => runtimePersistence.save(
  lifecycleStore, contextCheckpointStore, agentRunStore,
  [...threadConfigs.values()], agentRegistry?.list?.() ?? loadedRuntimeState.agentProfiles,
  [...runtimeSessions.values()], agentRuntimeStore, requirementStore,
);

// 与当前 Codex 客户端的已验证配置对齐；仍可用 OPENAI_MODEL 覆盖。
const defaultModel = "gpt-5.6-sol";
const modelCatalog: RuntimeModelCapability[] = [
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-5.5", label: "GPT-5.5", reasoningEfforts: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", reasoningEfforts: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.2", label: "GPT-5.2", reasoningEfforts: ["low", "medium", "high", "xhigh"] },
];
const configuredModel = process.env.OPENAI_MODEL ?? defaultModel;
if (!modelCatalog.some((model) => model.id === configuredModel)) {
  modelCatalog.push({ id: configuredModel, label: configuredModel });
}
const defaultBaseUrl = "https://llmapi.lovbrowser.com";

// Runtime 估算与 Provider 最终断言共用同一输入策略，避免无状态回放成本漂移。
const providerInputPolicy = {
  usePreviousResponseId: false,
  maxInputItems: 128,
  compactThresholdItems: 120,
  functionOutputItemCost: 2 as const,
};

const configuredBaseUrl = (
  process.env.OPENAI_BASE_URL ?? defaultBaseUrl
).replace(/\/+$/, "");

// 用户填写站点根地址即可；这里统一补成 OpenAI 兼容的 /v1 地址。
const apiBaseUrl = configuredBaseUrl.endsWith("/v1")
  ? configuredBaseUrl
  : `${configuredBaseUrl}/v1`;

const workspacePath =
  process.env.AGENT_WORKSPACE ?? process.cwd();
const configuredSkillRoots =
  process.env.AGENT_SKILLS_PATH
    ?.split(delimiter)
    .map((path) => path.trim())
    .filter((path) => path.length > 0) ??
  [join(workspacePath, "skills")];
const skillLoader = await SkillLoader.create({
  roots: configuredSkillRoots,
  allowMissingRoots: true,
});
const skillCatalogInstructions =
  skillLoader.createCatalogInstructions();
const workspaceSandbox = await WorkspaceSandbox.create(workspacePath);
const workspaceTools: AgentTool[] = [];
const agentRegistry = new AgentRegistry(
  loadedRuntimeState.agentProfiles,
);
if (JSON.stringify(agentRegistry.list()) !== JSON.stringify(loadedRuntimeState.agentProfiles)) {
  await persistRuntimeState();
}
const runtimeCoordinator = new AgentRuntimeCoordinator({
  store: agentRuntimeStore,
  persist: () => persistRuntimeState(),
});

if (apiKey !== undefined) {
  const npmExecutable =
    process.platform === "win32" ? "npm.cmd" : "npm";
  const commandRunner = await WorkspaceCommandRunner.create(
    workspacePath,
    {
      recipes: {
        check: {
          executable: npmExecutable,
          arguments: ["run", "check"],
          display: "npm run check",
        },
        test: {
          executable: npmExecutable,
          arguments: ["test"],
          display: "npm test",
        },
      },
    },
  );

  workspaceTools.push(
    ...createWorkspaceTools(workspaceSandbox),
    createRunCommandTool(commandRunner),
  );

  if (skillLoader.list().length > 0) {
    workspaceTools.push(createReadSkillTool(skillLoader));
  }
}

// MCP Server 只从用户指定的静态配置启动；没有模型时不创建无消费者的子进程。
const mcpManager =
  apiKey === undefined || mcpConfigPath === undefined
    ? undefined
    : await McpManager.start(
        await loadMcpServerConfigs(mcpConfigPath),
      );
const mcpTools = mcpManager?.getAgentTools() ?? [];
const mcpStatuses = mcpManager?.getStatuses() ?? [];

function toToolCapabilities(
  tools: readonly AgentTool[],
  source: RuntimeToolCapability["source"],
): RuntimeToolCapability[] {
  return tools.map((tool) => ({
    name: tool.definition.name,
    description: tool.definition.description,
    source,
  }));
}

// Runtime 事件通过反向 JSON-RPC Notification 实时推给 Client。
const events: AgentEventSink = {
  emit: (event) => {
    connection.sendNotification("agent/event", event);
  },
};

// 没有 Key 时协议和 Runtime 仍可启动，只有 turn/run 会明确报错。
const llmProvider = apiKey === undefined
  ? undefined
  : new OpenAiResponsesProvider({
      apiKey,
      model: configuredModel,
      baseUrl: apiBaseUrl,
      usePreviousResponseId: providerInputPolicy.usePreviousResponseId,
      maxInputItems: providerInputPolicy.maxInputItems,
      webSearch: {
        externalWebAccess: true,
        searchContextSize: "low",
      },
    });
let multiAgentScheduler: MultiAgentScheduler | undefined;
const sharedToolRegistry = new ToolRegistry([
  financeMonthlySummaryAgentTool,
  ...workspaceTools,
  ...mcpTools,
  ...createSharedBoardTools(agentRuntimeStore, agentRunStore),
  createPrepareRequirementPlanTool({
    lifecycleStore,
    requirementStore,
    writer: new RequirementPlanWriter(process.env.AGENT_PLANS_PATH ?? join(defaultStateRoot, "god-agent", "plans")),
    persist: () => persistRuntimeState(),
  }),
]);
const agentLoop =
  apiKey === undefined
    ? undefined
    : new AgentLoop({
        lifecycleStore,
        events,
        ...(skillCatalogInstructions.length === 0
          ? {}
          : { additionalInstructions: skillCatalogInstructions }),
        // Tool 真正执行前，通过同一条双向 JSON-RPC 连接向 CLI 请求审批。
        permissionGate: new JsonRpcPermissionGate(connection, {
          resolveAccessMode: (request) => {
            const jobId = request.jobId ??
              agentRunStore.getByTurn(request.turnId)?.jobId;
            return jobId === undefined
              ? "workspace"
              : agentRuntimeStore.getJob(jobId)?.configSnapshot.accessMode ?? "workspace";
          },
        }),
        contextCheckpointStore,
        itemBudget: new ItemBudget({
          maxInputItems: providerInputPolicy.maxInputItems,
          compactThresholdItems:
            providerInputPolicy.compactThresholdItems,
          functionOutputItemCost:
            providerInputPolicy.functionOutputItemCost,
        }),
        toolRegistry: sharedToolRegistry,
        llm: llmProvider!,
        continueAfterAgentReturns: (turnId, childRunIds, continuation) =>
          runtimeCoordinator.continueParent(turnId, childRunIds, continuation),
        resolveExecutionContext: (turnId) => {
          const run = agentRunStore.getByTurn(turnId);
          const turn = lifecycleStore.getTurn(turnId);
          const task = run?.taskId === undefined ? undefined : agentRuntimeStore.getTask(run.taskId);
          const profile = run === undefined ? undefined : agentRegistry.list().find((item) => item.id === run.agentProfileId);
          return { ...(turn === undefined ? {} : { threadId: turn.threadId }), ...(run === undefined ? {} : {
            jobId: run.jobId, agentId: run.id, agentName: profile?.name ?? run.agentProfileId,
          }), ...(task === undefined ? {} : { taskId: task.id, taskTitle: task.title }) };
        },
      });

const fixedSoftwareTeamCoordinator = agentLoop === undefined ? undefined : new FixedSoftwareTeamCoordinator({
  runStore: agentRunStore,
  runtimeStore: agentRuntimeStore,
  execute: async ({ threadId, profileId, prompt }) => {
    const profile = agentRegistry.require(profileId);
    const turn = lifecycleStore.createTurn(threadId);
    lifecycleStore.appendItem(turn.id, "user_message", { text: prompt });
    const result = await agentLoop.run(turn.id, {
      model: profile.defaultModel,
      reasoningEffort: profile.reasoningEffort,
      instructions: `${profile.instructions}\n\n这是固定团队 ST-B2 的受控叶子流程。不得创建子 Agent、不得调用工具，只返回当前职责所需的简洁可验收内容。`,
      allowedTools: [], allowedSkills: [],
    });
    const content = result.assistantMessage.content;
    return { turnId: turn.id, summary: typeof content === "object" && content !== null && "text" in content && typeof content.text === "string" ? content.text : "固定团队阶段已完成" };
  },
  onRunUpdated: (runId) => {
    const run = agentRunStore.get(runId); const root = run === undefined ? undefined : agentRunStore.getRoot(runId);
    if (run !== undefined && root !== undefined) events.emit({ type: "agent/run_updated", threadId: root.threadId, turnId: root.turnId, run });
  },
  onCompleted: (jobId) => {
    const requirementId = agentRuntimeStore.getJob(jobId)?.requirementId;
    if (requirementId !== undefined) requirementStore.setStatus(requirementId, "completed");
  },
  persist: () => persistRuntimeState(),
});
fixedSoftwareTeamCoordinator?.recoverPersistedCheckpoints();

if (agentLoop !== undefined) {
  multiAgentScheduler = new MultiAgentScheduler({
    registry: agentRegistry,
    store: agentRunStore,
    runtimeStore: agentRuntimeStore,
    enableAutomaticReview: true,
    resolveParent: (turnId) => {
      const turn = lifecycleStore.getTurn(turnId);
      const config = turn === undefined ? undefined : threadConfigs.get(turn.threadId);
      return turn === undefined ? undefined : {
        threadId: turn.threadId,
        ...(config?.agentTeam === undefined ? {} : { teamConfig: config.agentTeam }),
      };
    },
    prepare: (profile, task, parentRunId, taskId, attempt) => {
      const parentRun = agentRunStore.get(parentRunId);
      const reusableThreadId = parentRun === undefined ? undefined :
        agentRunStore.findWorkerThread(parentRun.jobId, taskId);
      const thread = reusableThreadId === undefined
        ? lifecycleStore.createThread("agent_internal")
        : lifecycleStore.getThread(reusableThreadId);
      if (thread === undefined) throw new Error("Reusable Agent Thread is unavailable");
      if (attempt > 1 && reusableThreadId === undefined) throw new Error("Rework Agent Thread is unavailable");
      const turn = lifecycleStore.createTurn(thread.id);
      lifecycleStore.appendItem(turn.id, "user_message", { text: task });
      return {
        threadId: thread.id,
        turnId: turn.id,
        execute: async () => {
          const result = await agentLoop.run(turn.id, {
            model: profile.defaultModel,
            reasoningEffort: profile.reasoningEffort,
            instructions: profile.id === "reviewer"
              ? `${profile.instructions}\n\n你是叶子审查 Agent。输入已经包含验收所需的任务、条件和 Worker 结论；不得调用任何工具，也不得创建子 Agent。只返回一个 JSON 对象：{\"verdict\":\"pass\"|\"fail\",\"severity\":null|\"P0\"|\"P1\"|\"P2\"|\"P3\",\"summary\":\"可验证的审查结论\"}。`
              : `${profile.instructions}\n\n你是父 Agent 分派的叶子执行 Agent，不得再创建子 Agent。共享板是可选能力：仅在任务确实需要已有事实时读取，仅在产生可复用结果时发布；用户或任务明确要求不调用工具时不得调用。不得共享隐藏推理、完整上下文、密钥、Token、Cookie 或环境变量。`,
            allowedTools: profile.id === "reviewer"
              ? []
              : [...intersectCapabilities(profile.allowedTools, agentRuntimeStore.getJob(agentRunStore.getByTurn(turn.id)?.jobId ?? "")?.configSnapshot.allowedTools), "!run_agent"],
            allowedSkills: intersectCapabilities(profile.allowedSkills, agentRuntimeStore.getJob(agentRunStore.getByTurn(turn.id)?.jobId ?? "")?.configSnapshot.allowedSkills),
          });
          const content = result.assistantMessage.content;
          return typeof content === "object" && content !== null &&
            "text" in content && typeof content.text === "string"
            ? content.text
            : "子 Agent 已完成";
        },
      };
    },
    onRunUpdated: (threadId, turnId, runId) => {
      const run = agentRunStore.get(runId);
      if (run !== undefined) events.emit({ type: "agent/run_updated", threadId, turnId, run });
    },
    persist: () => runtimePersistence.save(lifecycleStore, contextCheckpointStore,
      agentRunStore, [...threadConfigs.values()], agentRegistry.list(), [...runtimeSessions.values()], agentRuntimeStore, requirementStore),
  });
  sharedToolRegistry.register(createRunAgentTool(() => multiAgentScheduler!));
}

const runtimeCapabilities: RuntimeCapabilities = {
  llm: agentLoop !== undefined,
  ...(llmProvider === undefined ? {} : { currentModel: llmProvider.getModel() }),
  models: llmProvider === undefined ? [] : modelCatalog,
  webSearch: agentLoop !== undefined,
  tools: [
    ...toToolCapabilities(
      [financeMonthlySummaryAgentTool],
      "builtin",
    ),
    ...toToolCapabilities(workspaceTools, "workspace"),
    ...toToolCapabilities(mcpTools, "mcp"),
  ],
  skills: skillLoader.list(),
  mcpServers: mcpStatuses,
  agents: agentRegistry.list().map(({ id, name, description }) => ({ id, name, description })),
  ...(multiAgentScheduler === undefined ? {} : {
    multiAgent: {
      maxConcurrentRuns: multiAgentScheduler.maxConcurrentRuns,
      maxDepth: multiAgentScheduler.maxDepth,
      maxChildrenPerRun: multiAgentScheduler.maxChildrenPerRun,
    },
  }),
};

registerAppServerHandlers(connection, {
  lifecycleStore,
  events,
  ...(agentLoop === undefined ? {} : { agentLoop }),
  runtimeCapabilities,
  agentRunStore,
  agentRuntimeStore,
  agentRegistry,
  threadConfigs,
  runtimeSessions,
  requirementStore,
  ...(fixedSoftwareTeamCoordinator === undefined ? {} : { fixedSoftwareTeamCoordinator }),
  workspaceSandbox,
  skillNames: skillLoader.list().map((skill) => skill.name),
  ...(multiAgentScheduler === undefined ? {} : {
    cancelChildAgentRuns: (turnId: string) =>
      multiAgentScheduler.cancelChildren(
        turnId,
        (childTurnId) => agentLoop?.cancel(childTurnId) ?? false,
      ),
  }),
  saveState: () => runtimePersistence.save(
    lifecycleStore,
    contextCheckpointStore,
    agentRunStore,
    [...threadConfigs.values()],
    agentRegistry.list(),
    [...runtimeSessions.values()],
    agentRuntimeStore,
    requirementStore,
  ),
  // 日志写 stderr，避免污染 stdout 上的 JSONL 协议数据。
  log: (message) => process.stderr.write(message),
});

if (loadedRuntimeState.restored) {
  process.stderr.write(
    "[app-server] runtime state restored\n",
  );
}

if (loadedRuntimeState.recoveredTurnIds.length > 0) {
  process.stderr.write(
    `[app-server] recovered ${loadedRuntimeState.recoveredTurnIds.length} ` +
      "interrupted turn(s)\n",
  );
}

agentRuntimeStore.reconcilePersistedJobs();
await persistRuntimeState();
const interruptedRuntime = agentRuntimeStore.recoverInterruptedWork();
if (interruptedRuntime.lostTasks.length > 0 || interruptedRuntime.pendingReturns.length > 0) {
  await persistRuntimeState();
  process.stderr.write(`[app-server] recovered ${interruptedRuntime.lostTasks.length} lost Task lease(s) and ${interruptedRuntime.pendingReturns.length} pending Return(s)\n`);
}

if (agentLoop !== undefined && interruptedRuntime.pendingReturns.some((item) => !item.idempotencyKey.includes(":fixed:"))) {
  void runtimeCoordinator.recoverPendingReturns(async (job, returns) => {
    const turn = lifecycleStore.createTurn(job.threadId);
    lifecycleStore.appendItem(turn.id, "runtime_message", { text: `Runtime 重启恢复：以下子 Agent 结果已经持久化并等待你自动继续。请直接综合并完成原任务，不要询问用户是否继续。\n${returns.map((item) => `- ${item.result.status}: ${item.result.summary}`).join("\n")}` });
    const profile = agentRegistry.require("orchestrator");
    const result = await agentLoop.run(turn.id, {
      model: profile.defaultModel,
      reasoningEffort: profile.reasoningEffort,
      instructions: `${profile.instructions}\nRuntime 正在恢复已经持久化的 Return。只汇总这些结果，不得创建新任务或调用 run_agent。`,
      allowedTools: ["*", "!run_agent"],
    });
    await persistRuntimeState(); return result;
  }, (item) => !item.idempotencyKey.includes(":fixed:"));
}

if (agentLoop === undefined) {
  process.stderr.write(
    "[app-server] OPENAI_API_KEY missing; turn/run disabled\n",
  );
}

if (skillLoader.list().length > 0) {
  process.stderr.write(
    `[app-server] loaded ${skillLoader.list().length} skill(s)\n`,
  );
}

if (mcpManager !== undefined) {
  for (const status of mcpStatuses) {
    process.stderr.write(
      `[app-server] MCP ${status.name} ready: ` +
        `${status.protocolVersion}, ${status.toolCount} tool(s)\n`,
    );
  }
}

process.stdin.setEncoding("utf8");

process.stdin.on("data", (chunk: string) => {
  void connection.receive(chunk).catch((error: unknown) => {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    process.stderr.write(
      `[app-server] protocol error: ${message}\n`,
    );
  });
});

let shutdownStarted = false;

async function shutdown(): Promise<void> {
  if (shutdownStarted) {
    return;
  }

  shutdownStarted = true;
  connection.close();
  await mcpManager?.close();

  process.stderr.write(
    "[app-server] connection closed\n",
  );
}

process.stdin.on("end", () => {
  void shutdown().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : String(error);

    process.stderr.write(
      `[app-server] shutdown error: ${message}\n`,
    );
    process.exitCode = 1;
  });
});

process.stderr.write("[app-server] ready\n");

function intersectCapabilities(left: readonly string[], right: readonly string[] | undefined): string[] {
  const actualRight = right ?? ["*"];
  if (left.includes("*")) return [...actualRight];
  if (actualRight.includes("*")) return [...left];
  return left.filter((item) => actualRight.includes(item));
}
