import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { JsonRpcConnection } from "../protocol/connection.js";
import {
  AgentLoop,
} from "../agent/agent-loop.js";
import type {
  AgentEventSink,
} from "../agent/events.js";
import {
  loadConfiguredLlmProvider,
} from "../llm/provider-bootstrap.js";
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
import { OutcomeUnknownResolutionStore } from "../runtime/outcome-unknown-resolution-store.js";
import {
  OutcomeUnknownResolutionService,
  type OutcomeUnknownRuntimeSources,
} from "../runtime/outcome-unknown-resolution-service.js";
import {
  ItemBudget,
} from "../runtime/item-budget.js";
import {
  ModelInvocationStartupRecovery,
} from "../runtime/model-invocation-startup-recovery.js";
import { PersistentRuntimeLeaseStore } from "../runtime/persistent-runtime-lease-store.js";
import {
  ExecutionLeaseCoordinator,
  ExecutionLeaseUnavailableError,
} from "../runtime/execution-lease-coordinator.js";
import {
  WorkspaceSandbox,
} from "../sandbox/workspace-sandbox.js";
import {
  WorkspaceCommandRunner,
} from "../sandbox/workspace-command-runner.js";
import { SkillRuntime } from "../skills/skill-runtime.js";
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
  assertWorkspacePathWithinTaskScope,
} from "../tools/workspace-tools.js";
import {
  applyAgentModeToTools,
  applyRequirementGateToTools,
  buildParentAgentInstructions,
  registerAppServerHandlers,
  routeTeamConfigForExecutionKind,
} from "./handlers.js";
import { DEFAULT_AGENT_TEAM_CONFIG } from "../agents/agent-runtime.js";
import { AgentRegistry } from "../agents/agent-registry.js";
import { AgentRunStore } from "../agents/agent-run-store.js";
import { MultiAgentScheduler } from "../agents/multi-agent-scheduler.js";
import { AgentRuntimeCoordinator } from "../agents/agent-runtime-coordinator.js";
import { ensureFixedSoftwareTeam } from "../agents/fixed-software-team.js";
import { WorkflowTeamCoordinator } from "../execution/workflow-team-coordinator.js";
import { WorkflowTemplateRegistry } from "../execution/workflows/workflow-template.js";
import { SOFTWARE_PRODUCT_DELIVERY_TEMPLATE, SOFTWARE_PRODUCT_DELIVERY_V3_TEMPLATE } from "../execution/workflows/software-product-delivery.js";
import { DynamicAgentExecutionEngine } from "../execution/dynamic-agent-execution-engine.js";
import { TeamWorkflowExecutionEngine } from "../execution/team-workflow-execution-engine.js";
import { ExecutionEngineRouter } from "../execution/execution-engine-router.js";
import { RuntimeMetricsLedger } from "../observability/runtime-metrics.js";
import { createRunAgentTool } from "../tools/run-agent-tool.js";
import { createSharedBoardTools } from "../tools/shared-board-tools.js";
import { createPrepareRequirementPlanTool } from "../tools/prepare-requirement-plan-tool.js";
import { RequirementPlanWriter } from "../requirements/requirement-plan-writer.js";
import { RequirementDesignWriter } from "../requirements/requirement-design-writer.js";
import { isDesignConfirmed, isRequirementConfirmed } from "../requirements/requirement.js";
import { V3ProductDeliveryCoordinator } from "../execution/v3-product-delivery-coordinator.js";
import type {
  RuntimeCapabilities,
  RuntimeModelCapability,
  RuntimeToolCapability,
} from "./runtime-capabilities.js";

const connection = new JsonRpcConnection((data) => {
  // stdout 只能输出 JSONL 协议消息
  process.stdout.write(data);
});

const mcpConfigPath = process.env.AGENT_MCP_CONFIG;

// 默认状态进入用户数据目录，不在项目仓库产生运行时文件。
const defaultStateRoot =
  process.env.LOCALAPPDATA ??
  join(homedir(), ".local", "share");
const runtimeStatePath = process.env.AGENT_STATE_PATH ??
  join(defaultStateRoot, "god-agent", "runtime-state.json");
const runtimePersistence = new JsonFileRuntimePersistence(
  runtimeStatePath,
);
// Lease 与 Runtime 快照同属本地用户状态，但使用独立文件，绝不进入仓库。
const runtimeLeaseStore = new PersistentRuntimeLeaseStore(
  join(dirname(runtimeStatePath), "runtime-leases.json"),
);
const executionLeaseCoordinator = new ExecutionLeaseCoordinator(
  runtimeLeaseStore,
);
const outcomeUnknownResolutionStore = await OutcomeUnknownResolutionStore.open({
  statePath: process.env.AGENT_OUTCOME_UNKNOWN_STATE_PATH ??
    join(defaultStateRoot, "god-agent", "outcome-unknown-resolutions.json"),
});
const outcomeUnknownResolutionService = new OutcomeUnknownResolutionService(
  outcomeUnknownResolutionStore,
);
type OptionalInvocationRuntimeState = {
  modelInvocationStore?: { list(status?: string): OutcomeUnknownRuntimeSources["modelInvocations"] };
  toolInvocationStore?: { list(status?: string): OutcomeUnknownRuntimeSources["toolInvocations"] };
};
const loadedRuntimeState = await runtimePersistence.load();
const {
  lifecycleStore,
  contextCheckpointStore,
  agentRunStore,
  agentRuntimeStore,
  requirementStore,
  modelInvocationStore,
  toolInvocationStore,
} = loadedRuntimeState;
const threadConfigs = new Map(
  loadedRuntimeState.threadConfigs.map((config) => [config.threadId, config]),
);
const runtimeSessions = new Map(
  loadedRuntimeState.runtimeSessions.map((session) => [session.threadId, session]),
);
const persistRuntimeStateUnfenced = () => {
  replaceArrayContents(loadedRuntimeState.threadConfigs, [...threadConfigs.values()]);
  replaceArrayContents(
    loadedRuntimeState.agentProfiles,
    agentRegistry?.list?.() ?? loadedRuntimeState.agentProfiles,
  );
  replaceArrayContents(loadedRuntimeState.runtimeSessions, [...runtimeSessions.values()]);
  return runtimePersistence.save(loadedRuntimeState);
};
const persistRuntimeState = () => executionLeaseCoordinator.withActiveFencedCommit(
  "runtime_state",
  () => persistRuntimeStateUnfenced(),
);
const persistModelInvocationState = () => executionLeaseCoordinator.withActiveFencedCommit(
  "model_commit",
  () => persistRuntimeStateUnfenced(),
);
const persistToolInvocationState = () => executionLeaseCoordinator.withActiveFencedCommit(
  "tool_commit",
  () => persistRuntimeStateUnfenced(),
);
const persistWorkflowState = () => executionLeaseCoordinator.withActiveFencedCommit(
  "workflow_stage",
  () => persistRuntimeStateUnfenced(),
);
const persistParentContinuationState = () => executionLeaseCoordinator.withActiveFencedCommit(
  "parent_continuation",
  () => persistRuntimeStateUnfenced(),
);

// 与当前 Codex 客户端的已验证配置对齐；仍可用 OPENAI_MODEL 覆盖。
const defaultModel = "gpt-5.6-sol";
const defaultModelCatalog: RuntimeModelCapability[] = [
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-5.5", label: "GPT-5.5", reasoningEfforts: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", reasoningEfforts: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.2", label: "GPT-5.2", reasoningEfforts: ["low", "medium", "high", "xhigh"] },
];
const defaultBaseUrl = "https://llmapi.lovbrowser.com";

// Runtime 估算与 Provider 最终断言共用同一输入策略，避免无状态回放成本漂移。
const providerInputPolicy = {
  usePreviousResponseId: false,
  maxInputItems: 128,
  compactThresholdItems: 120,
  functionOutputItemCost: 2 as const,
};

const configuredProvider = await loadConfiguredLlmProvider({
  defaultModel,
  defaultBaseUrl,
  defaultModels: defaultModelCatalog,
  inputPolicy: providerInputPolicy,
});
const llmProvider = configuredProvider.provider;
const configuredModel = configuredProvider.profile.model;
const modelCatalog: RuntimeModelCapability[] =
  configuredProvider.models.map((model) => ({
    id: model.id,
    label: model.label ?? model.id,
    ...(model.reasoningEfforts === undefined
      ? {}
      : { reasoningEfforts: [...model.reasoningEfforts] }),
  }));
const resolveConfiguredModel = (preferredModel?: string): string => {
  const normalized = preferredModel?.trim();

  if (
    normalized !== undefined &&
    modelCatalog.some((candidate) => candidate.id === normalized)
  ) {
    return normalized;
  }

  return llmProvider?.getModel() ?? configuredModel;
};

const workspacePath =
  process.env.AGENT_WORKSPACE ?? process.cwd();
const configuredSkillRoots =
  process.env.AGENT_SKILLS_PATH
    ?.split(delimiter)
    .map((path) => path.trim())
    .filter((path) => path.length > 0) ??
  [
    join(workspacePath, "skills"),
    // 默认发现当前用户已有的个人 Skills；项目同名项优先。
    join(homedir(), ".codex", "skills"),
  ];
const skillRuntime = await SkillRuntime.create({
  roots: configuredSkillRoots,
  writableRoot: configuredSkillRoots[0] ?? join(workspacePath, "skills"),
  sopWritableRoot: join(workspacePath, "docs", "generated-sops"),
  allowMissingRoots: true,
  loaderOptions: {
    duplicatePolicy: "keep_first",
    tolerateInvalidRoots: [join(homedir(), ".codex", "skills")],
    legacyEncodingRoots: [join(homedir(), ".codex", "skills")],
  },
});
const skillLoader = skillRuntime.getLoader();
const skillCatalogInstructions = skillRuntime.createCatalogInstructions();
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
  persist: persistParentContinuationState,
  executionLeases: executionLeaseCoordinator,
});

if (llmProvider !== undefined) {
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
    ...createWorkspaceTools(workspaceSandbox, {
      authorizeWrite: ({ turnId, path }) => {
        if (turnId === undefined) return;
        const run = agentRunStore.getByTurn(turnId);
        const task = run?.taskId === undefined ? undefined : agentRuntimeStore.getTask(run.taskId);
        const job = run === undefined ? undefined : agentRuntimeStore.getJob(run.jobId);
        if (job?.workflowVersion !== "software_product_delivery_v3") return;
        const requirement = job.requirementId === undefined ? undefined : requirementStore.get(job.requirementId);
        if (!isDesignConfirmed(requirement)) throw new Error("Design confirmation is required before write_file");
        if (task === undefined) throw new Error("V3 write_file requires a bound Task");
        assertWorkspacePathWithinTaskScope(path, task.scope);
      },
    }),
    createRunCommandTool(commandRunner),
  );

  if (skillLoader.list().length > 0) {
    workspaceTools.push(createReadSkillTool(skillLoader));
  }
}

// MCP Server 只从用户指定的静态配置启动；没有模型时不创建无消费者的子进程。
const mcpManager =
  llmProvider === undefined || mcpConfigPath === undefined
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
  llmProvider === undefined
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
        modelInvocationWal: {
          store: modelInvocationStore,
          persist: persistModelInvocationState,
          provider: configuredProvider.invocationProvider,
          defaultModel: configuredModel,
        },
        toolInvocationWal: {
          store: toolInvocationStore,
          persist: persistToolInvocationState,
        },
        executionLeases: executionLeaseCoordinator,
        continueAfterAgentReturns: (turnId, childRunIds, continuation) =>
          runtimeCoordinator.continueParent(turnId, childRunIds, continuation),
        resolveExecutionContext: (turnId) => {
          const run = agentRunStore.getByTurn(turnId);
          const turn = lifecycleStore.getTurn(turnId);
          const task = run?.taskId === undefined ? undefined : agentRuntimeStore.getTask(run.taskId);
          const job = run === undefined ? undefined : agentRuntimeStore.getJob(run.jobId);
          const profile = run === undefined ? undefined : agentRegistry.list().find((item) => item.id === run.agentProfileId);
          return { ...(turn === undefined ? {} : { threadId: turn.threadId }), ...(run === undefined ? {} : {
            jobId: run.jobId, agentId: run.id, agentName: profile?.name ?? run.agentProfileId,
          }), ...(job === undefined ? {} : { jobAttempt: job.attempt, workflowVersion: job.workflowVersion }),
            ...(task === undefined ? {} : { taskId: task.id, taskTitle: task.title }) };
        },
      });

const workflowTemplates = new WorkflowTemplateRegistry();
workflowTemplates.register(SOFTWARE_PRODUCT_DELIVERY_TEMPLATE);
workflowTemplates.register(SOFTWARE_PRODUCT_DELIVERY_V3_TEMPLATE);
const runtimeMetrics = new RuntimeMetricsLedger((metric) => agentRuntimeStore.recordStageMetric(metric));
const workflowTeamCoordinator = agentLoop === undefined ? undefined : new WorkflowTeamCoordinator({
  runStore: agentRunStore,
  runtimeStore: agentRuntimeStore,
  template: SOFTWARE_PRODUCT_DELIVERY_TEMPLATE,
  metrics: runtimeMetrics,
  execute: async ({ threadId, profileId, prompt, allowedTools, formatRepair,
    jobId, jobAttempt, workflowVersion, stageId, stageAttempt }) => {
    const profile = agentRegistry.require(profileId);
    const job = agentRuntimeStore.getJob(jobId);
    const ownsRootTurn = profileId === "orchestrator" && stageId === "return_god";
    const turn = ownsRootTurn && job !== undefined
      ? lifecycleStore.getTurn(job.rootTurnId)
      : lifecycleStore.createTurn(threadId);
    if (turn === undefined) throw new Error("Workflow execution Turn is unavailable");
    if (!ownsRootTurn) lifecycleStore.appendItem(turn.id, "user_message", { text: prompt });
    const result = await agentLoop.run(turn.id, {
      model: resolveConfiguredModel(profile.defaultModel),
      reasoningEffort: profile.reasoningEffort,
      instructions: ownsRootTurn
        ? `${profile.instructions}\n\n你是 Workflow 的唯一最终交付者。只根据下面已验收的负责人 Return 回答用户一次；不得重新执行、委派或调用工具。\n\n${prompt}`
        : `${profile.instructions}\n\n你是版本化 Workflow Template 中的叶子阶段 Agent。不得创建子 Agent，不得越过当前阶段职责；${formatRepair ? "本轮只修复结构化格式，不得调用工具。" : "只使用 Runtime 明确授予的工具。"}`,
      allowedTools,
      allowedSkills: formatRepair ? [] : intersectCapabilities(
        profile.allowedSkills,
        job?.configSnapshot.allowedSkills,
      ),
      modelInvocationPurpose: formatRepair ? "format_repair" : "initial",
      invocationContext: {
        threadId,
        jobId,
        jobAttempt,
        workflowVersion,
        stageId,
        stageAttempt,
      },
    });
    const content = result.assistantMessage.content;
    return { turnId: turn.id, summary: typeof content === "object" && content !== null && "text" in content && typeof content.text === "string" ? content.text : "",
      toolCalls: result.turn.itemIds.filter((itemId) => lifecycleStore.getItem(itemId)?.type === "tool_call").length,
      toolReceipts: collectToolReceipts(result.turn.itemIds) };
  },
  recoverModelExecution: (input) => {
    const invocation = modelInvocationStore.list()
      .filter((item) => item.jobId === input.jobId && item.jobAttempt === input.jobAttempt &&
        item.workflowVersion === input.workflowVersion && item.stageId === input.stageId &&
        item.stageAttempt === input.stageAttempt &&
        ["response_received", "committed"].includes(item.status) &&
        item.normalizedResult !== undefined && item.normalizedResult.functionCalls.length === 0 &&
        item.normalizedResult.text.trim().length > 0)
      .sort((left, right) => left.round - right.round || left.updatedAt.localeCompare(right.updatedAt))
      .at(-1);
    return invocation?.normalizedResult === undefined ? undefined : {
      turnId: invocation.turnId,
      summary: invocation.normalizedResult.text,
      ...(invocation.status === "response_received" ? { invocationId: invocation.invocationId } : {}),
    };
  },
  commitRecoveredModelExecution: (invocationId, targetCommitKey) => {
    modelInvocationStore.markCommitted(invocationId, targetCommitKey);
  },
  modelInfo: (profileId) => {
    const profile = agentRegistry.require(profileId);
    return { model: resolveConfiguredModel(profile.defaultModel), ...(profile.reasoningEffort === undefined ? {} : { reasoningEffort: profile.reasoningEffort }) };
  },
  onRunUpdated: (runId) => {
    const run = agentRunStore.get(runId); const root = run === undefined ? undefined : agentRunStore.getRoot(runId);
    if (run !== undefined && root !== undefined) events.emit({ type: "agent/run_updated", threadId: root.threadId, turnId: root.turnId, run });
  },
  onCompleted: (jobId) => {
    const requirementId = agentRuntimeStore.getJob(jobId)?.requirementId;
    if (requirementId !== undefined) requirementStore.setStatus(requirementId, "completed");
  },
  requirement: (jobId) => {
    const job = agentRuntimeStore.getJob(jobId);
    const requirement = job?.requirementId === undefined ? undefined : requirementStore.get(job.requirementId);
    if (requirement === undefined || requirement.revision !== job?.requirementRevision) throw new Error("Frozen Requirement is unavailable");
    const prompt = JSON.stringify({
      requirementId: requirement.id,
      revision: requirement.revision,
      executionKind: requirement.executionKind,
      contentHash: requirement.planArtifact.contentHash,
      title: requirement.title,
      objective: requirement.objective,
      scope: requirement.scope,
      nonGoals: requirement.nonGoals,
      constraints: requirement.constraints,
      deliverables: requirement.deliverables,
      acceptanceCriteria: requirement.acceptanceCriteria,
      testCases: requirement.testCases,
      executionSteps: requirement.executionSteps,
    });
    return { objective: requirement.objective, scope: requirement.scope, nonGoals: requirement.nonGoals,
      deliverables: requirement.deliverables, acceptanceCriteria: requirement.acceptanceCriteria, prompt };
  },
  feedback: (jobId) => {
    const job = agentRuntimeStore.getJob(jobId);
    if (job === undefined) return undefined;
    const item = lifecycleStore.getItemsForTurn(job.rootTurnId)
      .filter((candidate) => candidate.type === "user_message")
      .at(-1);
    const text = typeof item?.content === "object" && item.content !== null &&
      "text" in item.content && typeof item.content.text === "string"
      ? item.content.text
      : undefined;
    return text === undefined ? undefined : { turnId: job.rootTurnId, text };
  },
  persist: persistWorkflowState,
});
const requirementDesignWriter = new RequirementDesignWriter(
  process.env.AGENT_PLANS_PATH ?? join(defaultStateRoot, "god-agent", "plans"),
);
const v3ProductDeliveryCoordinator = agentLoop === undefined ? undefined : new V3ProductDeliveryCoordinator({
  runStore: agentRunStore,
  runtimeStore: agentRuntimeStore,
  template: SOFTWARE_PRODUCT_DELIVERY_V3_TEMPLATE,
  execute: async ({ threadId, profileId, prompt, allowedTools, formatRepair,
    jobId, jobAttempt, workflowVersion, stageId, stageAttempt, taskId, runId }) => {
    const profile = agentRegistry.require(profileId);
    const job = agentRuntimeStore.getJob(jobId);
    const ownsRootTurn = profileId === "orchestrator" && stageId === "return_god";
    const turn = ownsRootTurn && job !== undefined
      ? lifecycleStore.getTurn(job.rootTurnId)
      : lifecycleStore.createTurn(threadId);
    if (turn === undefined) throw new Error("V3 Workflow execution Turn is unavailable");
    if (!ownsRootTurn) lifecycleStore.appendItem(turn.id, "user_message", { text: prompt });
    agentRunStore.rebindAttempt(runId, turn.id, agentRuntimeStore.getTask(taskId)?.attempt ?? 1);
    const result = await agentLoop.run(turn.id, {
      model: profile.defaultModel,
      reasoningEffort: profile.reasoningEffort,
      instructions: ownsRootTurn
        ? `${profile.instructions}\n\n你是 Workflow 的唯一最终交付者，只根据已验收证据回答一次，不得重新执行或委派。`
        : `${profile.instructions}\n\n你是 God-Agent v3 的当前阶段 Chat，不得创建子 Agent或越过文件边界；${formatRepair ? "本轮只修复 JSON，禁止工具。" : "只使用 Runtime 授予的工具。"}`,
      allowedTools,
      allowedSkills: formatRepair ? [] : intersectCapabilities(
        profile.allowedSkills,
        job?.configSnapshot.allowedSkills,
      ),
      modelInvocationPurpose: formatRepair ? "format_repair" : "initial",
      invocationContext: { threadId, jobId, jobAttempt, workflowVersion, stageId, stageAttempt,
        taskId, agentId: runId, ...(agentRuntimeStore.getTask(taskId)?.title === undefined ? {} : { taskTitle: agentRuntimeStore.getTask(taskId)!.title }) },
    });
    const content = result.assistantMessage.content;
    return { turnId: turn.id, summary: typeof content === "object" && content !== null && "text" in content && typeof content.text === "string" ? content.text : "",
      toolCalls: result.turn.itemIds.filter((itemId) => lifecycleStore.getItem(itemId)?.type === "tool_call").length,
      toolReceipts: collectToolReceipts(result.turn.itemIds) };
  },
  requirement: (jobId) => {
    const job = agentRuntimeStore.getJob(jobId);
    const requirement = job?.requirementId === undefined ? undefined : requirementStore.get(job.requirementId);
    if (requirement === undefined || requirement.revision !== job?.requirementRevision) throw new Error("Frozen V3 Requirement is unavailable");
    return { objective: requirement.objective, scope: requirement.scope, nonGoals: requirement.nonGoals,
      deliverables: requirement.deliverables, acceptanceCriteria: requirement.acceptanceCriteria,
      artifacts: {
        requirementPlanPath: requirement.planArtifact.path,
        requirementPlanHash: requirement.planArtifact.contentHash,
        ...(requirement.designArtifact === undefined ? {} : {
          designPath: requirement.designArtifact.path,
          designHash: requirement.designArtifact.contentHash,
          ...(requirement.designArtifact.mockPreview === undefined ? {} : { mockPath: requirement.designArtifact.mockPreview }),
        }),
      },
      ...(requirement.designFeedback === undefined ? {} : { designFeedback: requirement.designFeedback }),
      prompt: JSON.stringify({ requirementId: requirement.id, revision: requirement.revision, title: requirement.title,
        objective: requirement.objective, scope: requirement.scope, nonGoals: requirement.nonGoals,
        constraints: requirement.constraints, deliverables: requirement.deliverables,
        acceptanceCriteria: requirement.acceptanceCriteria, testCases: requirement.testCases }) };
  },
  designConfirmed: (jobId) => {
    const job = agentRuntimeStore.getJob(jobId);
    return isDesignConfirmed(job?.requirementId === undefined ? undefined : requirementStore.get(job.requirementId));
  },
  writeDesignArtifact: async (jobId, productDesign, mockPreview) => {
    const job = agentRuntimeStore.getJob(jobId);
    const requirement = job?.requirementId === undefined ? undefined : requirementStore.get(job.requirementId);
    if (requirement === undefined) throw new Error("V3 Requirement is unavailable");
    return requirementDesignWriter.write({ requirement, productDesign, mockPreview });
  },
  markDesignDraft: (jobId, artifact) => {
    const job = agentRuntimeStore.getJob(jobId);
    if (job?.requirementId === undefined || job.requirementRevision === undefined) throw new Error("V3 Requirement binding is unavailable");
    requirementStore.markDesignDraft(job.requirementId, job.requirementRevision, artifact);
  },
  requestDesignRevision: (jobId, feedback) => {
    const job = agentRuntimeStore.getJob(jobId);
    if (job?.requirementId === undefined || job.requirementRevision === undefined) throw new Error("V3 Requirement binding is unavailable");
    requirementStore.requestDesignRevision(job.requirementId, job.requirementRevision, feedback);
  },
  persist: persistWorkflowState,
  onRunUpdated: (runId) => {
    const run = agentRunStore.get(runId); const root = run === undefined ? undefined : agentRunStore.getRoot(runId);
    if (run !== undefined && root !== undefined) events.emit({ type: "agent/run_updated", threadId: root.threadId, turnId: root.turnId, run });
  },
  onCompleted: (jobId) => {
    const requirementId = agentRuntimeStore.getJob(jobId)?.requirementId;
    if (requirementId !== undefined) requirementStore.setStatus(requirementId, "completed");
  },
  onFailed: (jobId) => {
    const requirementId = agentRuntimeStore.getJob(jobId)?.requirementId;
    if (requirementId !== undefined) requirementStore.setStatus(requirementId, "failed_retryable");
  },
});
const dynamicExecutionEngine = new DynamicAgentExecutionEngine(agentRuntimeStore, {
  runStore: agentRunStore,
  ownership: executionLeaseCoordinator,
  persist: (boundary) => executionLeaseCoordinator.withRequiredActiveFencedCommit(
    boundary,
    () => persistRuntimeStateUnfenced(),
  ),
  cancelTurn: (turnId) => agentLoop?.cancel(turnId) ?? false,
  cancelScheduler: (jobId) => multiAgentScheduler?.cancelJob(jobId),
  cancelChildren: (turnId) => multiAgentScheduler?.cancelChildren(turnId, (childTurnId) => agentLoop?.cancel(childTurnId) ?? false) ?? 0,
  recoverScheduler: (jobId) => multiAgentScheduler?.recoverJob(jobId),
});
const executionEngineRouter = workflowTeamCoordinator === undefined || v3ProductDeliveryCoordinator === undefined ? undefined : new ExecutionEngineRouter([
  dynamicExecutionEngine,
  new TeamWorkflowExecutionEngine(agentRuntimeStore, workflowTeamCoordinator, (context) => {
    const job = agentRuntimeStore.getJob(context.jobId);
    if (job === undefined) throw new Error("Execution Job is unavailable");
    const version = job.workflowVersion === "software_product_delivery_v3" ? "v3" : "v2";
    workflowTemplates.requireForExecution(job.executionKind, "software_product_delivery", version, job.configSnapshot.allowedTools ?? ["*"]);
    const rootRun = agentRunStore.get(context.rootRunId);
    if (rootRun === undefined) throw new Error("Root Agent Run is unavailable");
    ensureFixedSoftwareTeam(lifecycleStore, agentRunStore, rootRun, job.workflowVersion);
  }, (allowedTools, workflowVersion) => {
    const version = workflowVersion === "software_product_delivery_v2" ? "v2" : "v3";
    workflowTemplates.requireForExecution("software_product_delivery", "software_product_delivery", version, allowedTools);
  }, executionLeaseCoordinator, persistWorkflowState, v3ProductDeliveryCoordinator),
]);

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
            model: resolveConfiguredModel(profile.defaultModel),
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
    persist: persistRuntimeState,
  });
  sharedToolRegistry.register(createRunAgentTool(() => multiAgentScheduler!));
}

const runtimeCapabilities: RuntimeCapabilities = {
  llm: agentLoop !== undefined,
  ...(llmProvider === undefined ? {} : { currentModel: llmProvider.getModel() }),
  models: llmProvider === undefined ? [] : modelCatalog,
  ...(llmProvider === undefined ? {} : {
    llmAdapter: {
      id: configuredProvider.adapterId,
      ...configuredProvider.capabilities,
    },
  }),
  webSearch:
    agentLoop !== undefined &&
    configuredProvider.capabilities.hostedWebSearch,
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

const modelInvocationStartupRecovery = new ModelInvocationStartupRecovery({
  lifecycleStore,
  modelInvocationStore,
  toolInvocationStore,
  persist: persistRuntimeState,
  canReplayTurn: (turnId) => {
    const turn = lifecycleStore.getTurn(turnId);
    const thread = turn === undefined ? undefined : lifecycleStore.getThread(turn.threadId);
    return thread?.kind !== "agent_internal";
  },
});
const durableInterruptedTurnIds = [...new Set(
  modelInvocationStore.list()
    .filter((invocation) => lifecycleStore.getTurn(invocation.turnId)?.status === "interrupted")
    .map((invocation) => invocation.turnId),
)].filter((turnId) => !loadedRuntimeState.recoveredTurnIds.includes(turnId));
const startupRecoveryPromise = modelInvocationStartupRecovery
  .recover(loadedRuntimeState.recoveredTurnIds)
  .then(async (results) => [
    ...results,
    ...await modelInvocationStartupRecovery.recover(durableInterruptedTurnIds),
  ])
  .then((results) => {
    for (const result of results) {
      if (result.action === "blocked") {
        process.stderr.write(
          `[app-server] model invocation recovery blocked for ${result.turnId}: ` +
            `${result.diagnosticCode ?? "unknown"}\n`,
        );
      }
    }
  });

registerAppServerHandlers(connection, {
  lifecycleStore,
  events,
  ...(agentLoop === undefined ? {} : { agentLoop }),
  runtimeCapabilities,
  ...(llmProvider === undefined ? {} : {
    selectModel: (model: string) => {
      if (!modelCatalog.some((candidate) => candidate.id === model)) {
        throw new Error(`Model is not available in the active LLM profile: ${model}`);
      }
      llmProvider.setModel(model);
      runtimeCapabilities.currentModel = model;
      return runtimeCapabilities;
    },
    resolveModel: resolveConfiguredModel,
  }),
  ...(configuredProvider.unavailableReason === undefined
    ? {}
    : { llmUnavailableReason: configuredProvider.unavailableReason }),
  agentRunStore,
  agentRuntimeStore,
  agentRegistry,
  threadConfigs,
  runtimeSessions,
  requirementStore,
  outcomeUnknownResolutionService,
  // App Server 仅由本机桌面 Main Process 拉起；操作者身份由服务端固定，RPC 参数不能覆盖。
  resolveOutcomeUnknownActor: () => ({
    id: "local-desktop-operator",
    permissions: ["invocation:view", "invocation:resolve"],
  }),
  refreshOutcomeUnknownFromRuntime: async () => {
    // 兼容上一阶段 WAL 独立合入：当前基线没有这些 Store，合入后自动只读同步。
    const invocationState = loadedRuntimeState as typeof loadedRuntimeState & OptionalInvocationRuntimeState;
    if (invocationState.modelInvocationStore === undefined || invocationState.toolInvocationStore === undefined) return;
    await outcomeUnknownResolutionService.syncFromRuntimeSources({
      modelInvocations: invocationState.modelInvocationStore.list(),
      toolInvocations: invocationState.toolInvocationStore.list(),
    });
  },
  workspaceSandbox,
  skillNames: skillLoader.list().map((skill) => skill.name),
  ...(llmProvider === undefined ? {} : {
    distillThreadKnowledge: async (messages: readonly import("../skills/chat-skill-distiller.js").DistillableChatMessage[], kind: import("../skills/skill-runtime.js").KnowledgeOutputKind) => {
      const result = await skillRuntime.distillThreadKnowledge(llmProvider, messages, kind);
      runtimeCapabilities.skills = skillRuntime.list();
      return { ...result, capabilities: runtimeCapabilities };
    },
  }),
  waitForStartupRecovery: () => startupRecoveryPromise,
  ...(executionEngineRouter === undefined ? {} : { executionEngineRouter }),
  softwareProductDeliveryWorkflowVersion: process.env.AGENT_SOFTWARE_PRODUCT_DELIVERY_WORKFLOW_VERSION === "software_product_delivery_v2"
    ? "software_product_delivery_v2"
    : "software_product_delivery_v3",
  executionOwnership: executionLeaseCoordinator,
  ...(multiAgentScheduler === undefined ? {} : {
    cancelChildAgentRuns: (turnId: string) =>
      multiAgentScheduler.cancelChildren(
        turnId,
        (childTurnId) => agentLoop?.cancel(childTurnId) ?? false,
      ),
  }),
  saveState: persistRuntimeState,
  // 日志写 stderr，避免污染 stdout 上的 JSONL 协议数据。
  log: (message) => process.stderr.write(message),
});

await startupRecoveryPromise;

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

for (const job of agentRuntimeStore.listJobs()) {
  try {
    await executionLeaseCoordinator.withJob(job.id, async () => {
      const terminal = ["completed", "partial", "failed", "cancelled"].includes(job.status);
      if (terminal) {
        agentRunStore.closeActiveForJob(job.id, job.status === "failed" || job.status === "partial" ? "failed" : "cancelled",
          "Runtime 恢复时关闭终态 Job 遗留的 Agent", job.failureCode);
        agentRuntimeStore.closeActiveTasks(job.id, job.status === "failed" || job.status === "partial" ? "failed" : "cancelled");
        if (job.requirementId !== undefined && requirementStore.get(job.requirementId) !== undefined) {
          requirementStore.setExecutionState(job.requirementId,
            job.status === "completed" ? "completed" : job.status === "cancelled" ? "cancelled" : "failed_retryable");
        }
        await executionLeaseCoordinator.withRequiredActiveFencedCommit(
          "runtime_state",
          () => persistRuntimeStateUnfenced(),
        );
        return;
      }

      const interruptedRuntime = agentRuntimeStore.recoverInterruptedWork(undefined, job.id);
      if (interruptedRuntime.lostTasks.length > 0 || interruptedRuntime.pendingReturns.length > 0) {
        await executionLeaseCoordinator.withRequiredActiveFencedCommit(
          "runtime_state",
          () => persistRuntimeStateUnfenced(),
        );
        process.stderr.write(`[app-server] recovered ${interruptedRuntime.lostTasks.length} lost Task lease(s) and ${interruptedRuntime.pendingReturns.length} pending Return(s) for ${job.id}\n`);
      }
      if (executionEngineRouter !== undefined) {
        await executionEngineRouter.recover(job.executionKind, job.id);
      } else if (job.workflowVersion === "dynamic_v1") {
        await dynamicExecutionEngine.recover(job.id);
      }
    });
  } catch (error) {
    if (!(error instanceof ExecutionLeaseUnavailableError)) throw error;
    process.stderr.write(`[app-server] ${job.id} waiting for active execution owner; startup recovery deferred\n`);
  }
}

const isTeamWorkflowReturn = (item: { jobId: string }): boolean => {
  const job = agentRuntimeStore.getJob(item.jobId);
  return job?.executionKind === "software_product_delivery" &&
    ["software_product_delivery_v2", "software_product_delivery_v3"].includes(job.workflowVersion);
};
const pendingDynamicReturnCount = agentRuntimeStore.listReturns().filter((item) =>
  item.status === "ready" && !isTeamWorkflowReturn(item)).length;

if (pendingDynamicReturnCount > 0) {
  process.stderr.write(
    `[app-server] ${pendingDynamicReturnCount} dynamic Return(s) await explicit turn/run resume\n`,
  );
}

if (agentLoop === undefined) {
  process.stderr.write(
    `[app-server] ${configuredProvider.unavailableReason ??
      "LLM provider unavailable"}; turn/run disabled\n`,
  );
} else {
  process.stderr.write(
    `[app-server] LLM profile ${configuredProvider.profile.id} ready via ` +
      `${configuredProvider.adapterId}\n`,
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

function collectToolReceipts(itemIds: readonly string[]): Array<{ name: string; ok: boolean; exitCode?: number }> {
  return itemIds.flatMap((itemId) => {
    const item = lifecycleStore.getItem(itemId);
    if (item?.type !== "tool_result" || typeof item.content !== "object" || item.content === null || Array.isArray(item.content)) return [];
    const content = item.content as Record<string, unknown>;
    if (typeof content.name !== "string") return [];
    const result = typeof content.result === "object" && content.result !== null && !Array.isArray(content.result)
      ? content.result as Record<string, unknown>
      : undefined;
    const denied = result?.status === "denied";
    const exitCode = typeof result?.exitCode === "number" ? result.exitCode : undefined;
    return [{ name: content.name, ok: !denied && (exitCode === undefined || exitCode === 0),
      ...(exitCode === undefined ? {} : { exitCode }) }];
  });
}

function replaceArrayContents<T>(target: T[], source: readonly T[]): void {
  target.splice(0, target.length, ...source);
}
