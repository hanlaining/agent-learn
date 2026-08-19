import {
  sampleTransactions,
} from "../domains/finance/fixtures.js";
import {
  parseMonthlySummaryRequest,
  summarizeMonthlyTransactions,
} from "../domains/finance/summary.js";
import type {
  JsonRpcConnection,
} from "../protocol/connection.js";
import type {
  LifecycleStore,
} from "../runtime/lifecycle-store.js";
import {
  parseTurnStartParams,
  type TurnStartResult,
} from "../runtime/turn-start.js";
import {
  parseTurnRunParams,
  type TurnRunResult,
} from "../runtime/turn-run.js";
import {
  parseTurnCancelParams,
  type TurnCancelResult,
} from "../runtime/turn-cancel.js";
import type {
  AgentLoop,
} from "../agent/agent-loop.js";
import {
  NOOP_AGENT_EVENT_SINK,
  type AgentEventSink,
} from "../agent/events.js";
import {
  parseThreadHistoryParams,
  readThreadHistory,
} from "../runtime/thread-history.js";
import {
  cloneRuntimeCapabilities,
  EMPTY_RUNTIME_CAPABILITIES,
  type RuntimeCapabilities,
} from "./runtime-capabilities.js";
import type { AgentRunStore } from "../agents/agent-run-store.js";
import type { AgentRunResult } from "../agents/agent-run.js";
import type { AgentRuntimeStore } from "../agents/agent-runtime-store.js";
import type { AgentRegistry } from "../agents/agent-registry.js";
import type { WorkspaceSandbox } from "../sandbox/workspace-sandbox.js";
import { DEFAULT_AGENT_TEAM_CONFIG, normalizeAgentTeamConfig, type AgentJobStatus, type AgentTeamConfig } from "../agents/agent-runtime.js";
import type {
  PersistedRuntimeSession,
  PersistedThreadConfig,
} from "../runtime/json-file-runtime-persistence.js";
import type { RequirementStore } from "../requirements/requirement-store.js";
import { isRequirementConfirmed, type RequirementExecutionKind, type RequirementExecutionState } from "../requirements/requirement.js";
import type { FixedProductStage } from "../agents/fixed-software-team-coordinator.js";
import type { ExecutionEngineRouter } from "../execution/execution-engine-router.js";
import type { OutcomeUnknownResolutionService } from "../runtime/outcome-unknown-resolution-service.js";
import type {
  OutcomeUnknownActor,
  ResolveOutcomeUnknownInput,
} from "../runtime/outcome-unknown-resolution.js";

export interface AppServerDependencies {
  lifecycleStore: LifecycleStore;
  agentLoop?: Pick<AgentLoop, "run" | "cancel">;
  events?: AgentEventSink;
  runtimeCapabilities?: RuntimeCapabilities;
  selectModel?: (model: string) => RuntimeCapabilities;
  saveState?: () => void | Promise<void>;
  log?: (message: string) => void;
  agentRunStore?: AgentRunStore;
  agentRuntimeStore?: AgentRuntimeStore;
  agentRegistry?: AgentRegistry;
  cancelChildAgentRuns?: (parentTurnId: string) => number;
  threadConfigs?: Map<string, PersistedThreadConfig>;
  runtimeSessions?: Map<string, PersistedRuntimeSession>;
  requirementStore?: RequirementStore;
  workspaceSandbox?: Pick<WorkspaceSandbox, "searchFiles" | "validateFilePath">;
  skillNames?: readonly string[];
  executionEngineRouter?: ExecutionEngineRouter;
  outcomeUnknownResolutionService?: OutcomeUnknownResolutionService;
  resolveOutcomeUnknownActor?: () => OutcomeUnknownActor | undefined;
  refreshOutcomeUnknownFromRuntime?: () => void | Promise<void>;
  waitForStartupRecovery?: () => Promise<void>;
}

/**
 * 把业务处理器注册到 Connection。
 *
 * Connection 只理解 JSON-RPC；LifecycleStore 只管理运行时状态。
 * 这个函数位于两者中间，负责把 RPC method 翻译成具体业务动作。
 */
export function registerAppServerHandlers(
  connection: JsonRpcConnection,
  dependencies: AppServerDependencies,
): void {
  const {
    lifecycleStore,
    agentLoop,
    events = NOOP_AGENT_EVENT_SINK,
    runtimeCapabilities = EMPTY_RUNTIME_CAPABILITIES,
    selectModel,
    saveState = () => undefined,
    log = () => undefined,
    agentRunStore,
    agentRuntimeStore,
    agentRegistry,
    cancelChildAgentRuns = () => 0,
    threadConfigs = new Map(),
    runtimeSessions = new Map(),
    requirementStore,
    workspaceSandbox,
    skillNames = [],
    executionEngineRouter,
    outcomeUnknownResolutionService,
    resolveOutcomeUnknownActor = () => undefined,
    refreshOutcomeUnknownFromRuntime = () => undefined,
    waitForStartupRecovery = async () => undefined,
  } = dependencies;

  let clientInitialized = false;

  function requireInitialized(): void {
    if (!clientInitialized) {
      throw new Error(
        "Client must complete initialize handshake first",
      );
    }
  }

  connection.onRequest("initialize", (params) => {
    log(`[app-server] initialize: ${JSON.stringify(params)}\n`);

    return {
      serverName: "agent-app-server",
      protocolVersion: 1,
      capabilities: {
        bidirectionalRequests: true,
        notifications: true,
        threads: true,
        turns: true,
        cancellation: agentLoop !== undefined,
        llm: agentLoop !== undefined,
      },
    };
  });

  connection.onNotification("initialized", () => {
    // Client 明确确认握手完成后，才开放 Runtime 和业务方法。
    clientInitialized = true;
    log("[app-server] client initialized\n");
  });

  connection.onRequest("invocation/outcome-unknown/list", async (params) => {
    requireInitialized();
    if (outcomeUnknownResolutionService === undefined) return [];
    const actor = resolveOutcomeUnknownActor();
    if (actor === undefined) throw new Error("Outcome-unknown operator is unavailable");
    if (!isRecord(params) || Object.keys(params).some((key) => key !== "threadId") ||
      (params.threadId !== undefined && typeof params.threadId !== "string")) {
      throw new Error("Invalid outcome-unknown list request");
    }
    await refreshOutcomeUnknownFromRuntime();
    return outcomeUnknownResolutionService.list(actor, params.threadId as string | undefined);
  });

  connection.onRequest("invocation/outcome-unknown/resolve", async (params) => {
    requireInitialized();
    if (outcomeUnknownResolutionService === undefined) {
      throw new Error("Outcome-unknown resolution is unavailable");
    }
    const actor = resolveOutcomeUnknownActor();
    if (actor === undefined) throw new Error("Outcome-unknown operator is unavailable");
    await refreshOutcomeUnknownFromRuntime();
    return outcomeUnknownResolutionService.resolve(actor, parseOutcomeUnknownResolutionRequest(params));
  });

  connection.onRequest("thread/start", async () => {
    requireInitialized();
    await waitForStartupRecovery();

    // Thread 是持久会话容器；这里只创建容器，还没有启动 Turn。
    const thread = lifecycleStore.createThread();

    // RPC 成功返回前完成落盘，避免 Client 看见一个只存在于内存的 Thread。
    await saveState();

    log(`[app-server] thread started: ${thread.id}\n`);
    return thread;
  });

  connection.onRequest("thread/list", () => {
    requireInitialized();

    // Map 不跨协议暴露；按创建顺序返回可恢复的 Thread 数组。
    return lifecycleStore.listThreads().filter(
      (thread) => thread.deletedAt === undefined && thread.kind !== "agent_internal" && agentRunStore?.isChildThread(thread.id) !== true,
    );
  });

  connection.onRequest("thread/trash/list", () => {
    requireInitialized();
    return lifecycleStore.listThreads().filter((thread) => thread.deletedAt !== undefined && thread.kind !== "agent_internal" && agentRunStore?.isChildThread(thread.id) !== true);
  });
  connection.onRequest("thread/delete-batch/list", () => lifecycleStore.listDeleteBatches());
  connection.onRequest("thread/delete-batch/restore", async (params) => {
    requireInitialized(); if (!isRecord(params) || typeof params.batchDeleteId !== "string") throw new Error("Invalid batch restore");
    const result = lifecycleStore.restoreDeleteBatch(params.batchDeleteId); await saveState(); return result;
  });

  connection.onRequest("thread/rename", async (params) => {
    requireInitialized();
    if (!isRecord(params) || typeof params.threadId !== "string" || typeof params.title !== "string") throw new Error("Invalid thread rename");
    const thread = lifecycleStore.renameThread(params.threadId, params.title); await saveState(); return thread;
  });

  connection.onRequest("thread/soft-delete", async (params) => {
    requireInitialized();
    if (!isRecord(params) || !Array.isArray(params.threadIds) || !params.threadIds.every((id) => typeof id === "string") || typeof params.batchDeleteId !== "string") throw new Error("Invalid thread soft delete");
    for (const threadId of params.threadIds) {
      const running = lifecycleStore.getThread(threadId)?.turnIds.map((id) => lifecycleStore.getTurn(id)).find((turn) => turn?.status === "in_progress");
      if (running !== undefined) { cancelChildAgentRuns(running.id); agentLoop?.cancel(running.id); agentRuntimeStore?.cancelJob(`job-${running.id}`); }
    }
    const result = lifecycleStore.softDeleteThreads(params.threadIds, params.batchDeleteId); await saveState(); return result;
  });

  connection.onRequest("thread/restore", async (params) => {
    requireInitialized();
    if (!isRecord(params) || typeof params.threadId !== "string") throw new Error("Invalid thread restore");
    const thread = lifecycleStore.restoreThread(params.threadId); await saveState(); return thread;
  });

  connection.onRequest("thread/history", (params) => {
    requireInitialized();
    const request = parseThreadHistoryParams(params);

    return readThreadHistory(
      lifecycleStore,
      request.threadId,
    );
  });
  connection.onRequest("agent/runtime", (params) => {
    if (!isRecord(params) || typeof params.threadId !== "string") throw new Error("Invalid agent runtime request");
    const job = agentRuntimeStore?.listJobs(params.threadId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (job === undefined) return { tasks: [], edges: [], evidence: [], board: [], returns: [] };
    const tasks = agentRuntimeStore!.listTasks(job.id);
    const engine = executionEngineRouter?.snapshot(job.executionKind, job.id);
    return { job, tasks, edges: agentRuntimeStore!.listEdges(job.id), evidence: tasks.flatMap((task) => agentRuntimeStore!.listEvidence(task.id)), board: agentRuntimeStore!.listBoard(job.id), returns: agentRuntimeStore!.listReturns(job.id), stageCheckpoints: agentRuntimeStore!.listStageCheckpoints(job.id), stageMetrics: agentRuntimeStore!.listStageMetrics(job.id), fixedProductStage: engine?.stage, engine };
  });

  connection.onRequest("agent/fixed-product/advance", async (params) => {
    requireInitialized();
    await waitForStartupRecovery();
    if (executionEngineRouter === undefined || agentRuntimeStore === undefined ||
      !isRecord(params) || typeof params.threadId !== "string" || typeof params.expectedStage !== "string" ||
      !["ready_first_return", "first_return_ready", "rework", "second_return_ready", "engineering_ready", "engineering_return_ready", "quality_ready", "quality_return_ready", "lead_return_ready", "completed"].includes(params.expectedStage)) {
      throw new Error("Invalid fixed product advance request");
    }
    const job = agentRuntimeStore.listJobs(params.threadId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (job === undefined || job.threadId !== params.threadId) throw new Error("Fixed product Job is unavailable");
    return executionEngineRouter.advance(job.executionKind, job.id, params.expectedStage as FixedProductStage);
  });

  connection.onRequest("requirement/get", (params) => {
    requireInitialized();
    if (!isRecord(params) || typeof params.threadId !== "string") throw new Error("Invalid requirement request");
    return requirementStore?.getActive(params.threadId) ?? null;
  });

  connection.onRequest("requirement/confirm", async (params) => {
    requireInitialized();
    if (requirementStore === undefined || !isRecord(params) || typeof params.requirementId !== "string" ||
      !Number.isInteger(params.revision) || typeof params.contentHash !== "string") {
      throw new Error("Invalid requirement confirmation");
    }
    const requirement = requirementStore.confirm(params.requirementId, Number(params.revision), params.contentHash);
    await saveState();
    return requirement;
  });

  connection.onRequest("runtime/capabilities", () => {
    requireInitialized();

    // 返回克隆对象，避免 Client 侧引用影响 Main 中的能力目录。
    return cloneRuntimeCapabilities(runtimeCapabilities);
  });

  connection.onRequest("workspace/search-files", async (params) => {
    requireInitialized();
    if (workspaceSandbox === undefined || !isRecord(params) ||
      typeof params.query !== "string") {
      throw new Error("Invalid workspace file search");
    }
    return workspaceSandbox.searchFiles(params.query, { maxResults: 20, maxDepth: 6 });
  });

  connection.onRequest("agent-run/list", (params) => {
    requireInitialized();
    const threadId = isRecord(params) && typeof params.threadId === "string"
      ? params.threadId : undefined;
    return threadId === undefined
      ? agentRunStore?.list() ?? []
      : agentRunStore?.listForThread(threadId) ?? [];
  });

  connection.onRequest("thread/config/get", (params) => {
    requireInitialized();
    if (!isRecord(params) || typeof params.threadId !== "string") {
      throw new Error("Invalid thread config request");
    }
    return threadConfigs.get(params.threadId) ?? null;
  });

  connection.onRequest("thread/config/set", async (params) => {
    requireInitialized();
    if (!isRecord(params) || typeof params.threadId !== "string" ||
      typeof params.model !== "string" || typeof params.reasoningEffort !== "string" ||
      typeof params.agentProfileId !== "string") {
      throw new Error("Invalid thread config");
    }
    const config: PersistedThreadConfig = {
      threadId: params.threadId, model: params.model,
      reasoningEffort: params.reasoningEffort, agentProfileId: params.agentProfileId,
      agentTeam: normalizeAgentTeamConfig(isRecord(params.agentTeam) ? params.agentTeam : {}),
    };
    threadConfigs.set(config.threadId, config);
    await saveState();
    return config;
  });

  connection.onRequest("runtime-session/list", (params) => {
    requireInitialized();
    const threadId = isRecord(params) && typeof params.threadId === "string"
      ? params.threadId : undefined;
    return threadId === undefined
      ? [...runtimeSessions.values()]
      : runtimeSessions.get(threadId) ?? null;
  });

  connection.onRequest("runtime-session/set", async (params) => {
    requireInitialized();
    if (!isRecord(params) || typeof params.threadId !== "string" ||
      typeof params.turnState !== "string" || !isRecord(params.session)) {
      throw new Error("Invalid runtime session");
    }
    const value = params as unknown as PersistedRuntimeSession;
    runtimeSessions.set(value.threadId, structuredClone(value));
    await saveState();
    return true;
  });

  connection.onRequest("runtime/select-model", (params) => {
    requireInitialized();
    if (
      selectModel === undefined ||
      typeof params !== "object" ||
      params === null ||
      !("model" in params) ||
      typeof params.model !== "string" ||
      params.model.trim().length === 0
    ) {
      throw new Error("Invalid model selection");
    }
    return cloneRuntimeCapabilities(selectModel(params.model));
  });

  connection.onRequest("turn/start", async (params) => {
    requireInitialized();
    await waitForStartupRecovery();

    // 第一道边界：验证来自 JSON-RPC 的不可信参数。
    const request = parseTurnStartParams(params);

    // 第二道边界：Store 验证 Thread 存在且仍然 active。
    const uniqueMentions = [...new Map(request.mentions.map((mention) => [mention.path, mention])).values()];
    const validatedMentions = await Promise.all(uniqueMentions.map(async (mention) => ({
      kind: "file" as const,
      path: await requireWorkspaceSandbox(workspaceSandbox).validateFilePath(mention.path),
    })));
    const knownSkillNames = new Set(skillNames);
    const explicitSkills = [...new Set(request.explicitSkills)];
    if (explicitSkills.some((name) => !knownSkillNames.has(name))) {
      throw new Error("turn/start contains an unavailable Skill");
    }
    const modelText = appendExplicitContext(request.input, validatedMentions, explicitSkills);

    const turn = lifecycleStore.createTurn(
      request.threadId,
    );

    // 用户输入是这个 Turn 产生的第一个 Item。
    const userMessage = lifecycleStore.appendItem(
      turn.id,
      "user_message",
      {
        text: request.input,
        ...(modelText === request.input ? {} : { modelText }),
        ...(validatedMentions.length === 0 ? {} : { mentions: validatedMentions }),
        ...(explicitSkills.length === 0 ? {} : { explicitSkills }),
      },
    );

    const result: TurnStartResult = {
      turn,
      userMessage,
    };

    await saveState();

    events.emit({
      type: "turn/started",
      threadId: turn.threadId,
      turnId: turn.id,
    });

    log(
      `[app-server] turn started: ${turn.id} ` +
        `for thread: ${turn.threadId}\n`,
    );

    return result;
  });

  connection.onRequest("turn/run", async (params) => {
    requireInitialized();
    await waitForStartupRecovery();

    if (agentLoop === undefined) {
      throw new Error(
        "LLM is unavailable: set OPENAI_API_KEY",
      );
    }

    const request = parseTurnRunParams(params);
    const turnFact = lifecycleStore.getTurn(request.turnId);
    const turnUserInput = readTurnUserInput(lifecycleStore, request.turnId);
    const threadConfig = turnFact === undefined ? undefined : threadConfigs.get(turnFact.threadId);
    const profile = agentRegistry?.require(threadConfig?.agentProfileId ?? "orchestrator");
    const teamConfig = threadConfig?.agentTeam ?? DEFAULT_AGENT_TEAM_CONFIG;
    const requirement = turnFact === undefined ? undefined : requirementStore?.getActive(turnFact.threadId);
    const executionKind = requirement?.executionKind ?? "software_change";
    const jobTeamConfig = routeTeamConfigForExecutionKind(teamConfig, executionKind);
    const executionConfirmed = isRequirementConfirmed(requirement);
    const retryRequested = requirement?.executionState === "failed_retryable" &&
      isExplicitRequirementRetry(turnUserInput);
    const executionRequested = executionConfirmed && requirement !== undefined &&
      (requirement.executionState === "not_started" || requirement.executionState === "executing" || retryRequested);
    const existingRequirementJob = requirement === undefined ? undefined :
      agentRuntimeStore?.getJobByRequirement(requirement.id, requirement.revision);
    agentRegistry?.requireAll(jobTeamConfig.allowedProfiles);
    if (jobTeamConfig.independentReview) agentRegistry?.require("reviewer");
    if (executionRequested) executionEngineRouter?.validateStart(executionKind, jobTeamConfig.allowedTools ?? ["*"]);
    const rootRun = turnFact === undefined || requirement === undefined || !executionRequested
      ? undefined
      : agentRunStore?.ensureRoot(turnFact.threadId, request.turnId, profile?.id,
          existingRequirementJob?.id ?? `job-${requirement.id}-v${requirement.revision}`);
    let job = rootRun === undefined || turnFact === undefined || requirement === undefined ? undefined
      : agentRuntimeStore?.createJob({ threadId: turnFact.threadId, rootTurnId: request.turnId,
          rootRunId: rootRun.rootRunId, configSnapshot: jobTeamConfig, executionKind,
          workflowVersion: executionKind === "software_product_delivery" ? "software_product_delivery_v2" : "dynamic_v1",
          requirementId: requirement.id, requirementRevision: requirement.revision });
    if (job !== undefined && rootRun !== undefined && retryRequested && job.rootTurnId !== request.turnId) {
      job = agentRuntimeStore?.startJobAttempt(job.id, request.turnId, rootRun.rootRunId);
      if (job !== undefined) agentRunStore?.rebindAttempt(rootRun.id, request.turnId, job.attempt);
    }
    if (job !== undefined && requirement !== undefined) requirementStore?.attachJob(requirement.id, job.id);
    const executionControl = job === undefined || executionEngineRouter === undefined
      ? "turn_agent" as const
      : executionEngineRouter.control(job.executionKind);

    try {
      if (job?.executionKind === "software_product_delivery" && executionEngineRouter === undefined) {
        throw new Error("Team Workflow engine is unavailable");
      }
      if (rootRun !== undefined) {
        agentRunStore?.setStatus(rootRun.id,
          executionControl === "workflow" ? "waiting_children" : "running");
      }
      if (job !== undefined) agentRuntimeStore?.setJobStatus(job.id, "running");
      if (job !== undefined && rootRun !== undefined && executionEngineRouter !== undefined) {
        await executionEngineRouter.start({ jobId: job.id, threadId: job.threadId, rootRunId: rootRun.id,
          executionKind: job.executionKind, workflowVersion: job.workflowVersion });
      }

      const result: TurnRunResult = executionControl === "workflow"
        ? readCompletedTurnResult(lifecycleStore, request.turnId)
        : await agentLoop.run(request.turnId, {
            ...(request.model === undefined ? {} : { model: request.model }),
            ...(request.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: request.reasoningEffort }),
            ...(profile === undefined ? {} : { instructions: buildParentAgentInstructions(
              profile.instructions,
              teamConfig.mode,
              undefined,
              executionConfirmed,
              requirement,
            ) }),
            ...(profile === undefined ? {} : { allowedTools: applyRequirementGateToTools(applyAgentModeToTools(intersectCapabilities(profile.allowedTools, jobTeamConfig.allowedTools), teamConfig.mode), executionConfirmed),
              allowedSkills: intersectCapabilities(profile.allowedSkills, teamConfig.allowedSkills) }),
          });

      log(
        `[app-server] turn completed: ${result.turn.id}\n`,
      );

      if (rootRun !== undefined && executionControl === "turn_agent") {
        agentRunStore?.complete(rootRun.id, {
          runId: rootRun.id,
          status: "completed",
          summary: "主 Agent 已完成任务",
        });
      }
      if (job !== undefined) {
        const status = agentRuntimeStore?.reconcileJobStatus(job.id);
        const requirementState = requirementExecutionStateForJobStatus(status);
        if (requirementState !== undefined && requirement !== undefined) {
          requirementStore?.setExecutionState(requirement.id, requirementState);
          const unfinishedTerminal = requirementState === "failed_retryable" ? "failed" : "cancelled";
          agentRunStore?.closeActiveForJob(job.id, unfinishedTerminal,
            "Job 已进入终态，未完成 Agent 已安全关闭");
          agentRuntimeStore?.closeActiveTasks(job.id, unfinishedTerminal);
        }
      }

      return result;
    } catch (error) {
      const terminalStatus = lifecycleStore.getTurn(request.turnId)?.status === "timed_out"
        ? "timed_out" as const
        : lifecycleStore.getTurn(request.turnId)?.status === "interrupted"
          ? "cancelled" as const
          : "failed" as const;
      if (rootRun !== undefined) {
        agentRunStore?.complete(rootRun.id, {
          runId: rootRun.id,
          status: terminalStatus,
          summary: "主 Agent 未完成任务",
          safeError: "Agent 执行失败",
        });
      }
      if (job !== undefined) {
        agentRunStore?.closeActiveForJob(job.id,
          terminalStatus, "Job 已终结，未完成 Agent 已安全关闭", "父 Agent 未完成任务");
        agentRuntimeStore?.closeActiveTasks(job.id,
          terminalStatus === "cancelled" ? "cancelled" : "failed");
        agentRuntimeStore?.failJob(job.id,
          terminalStatus === "cancelled" ? "cancelled" : "failed", terminalStatus);
        if (requirement !== undefined) {
          requirementStore?.setExecutionState(requirement.id,
            terminalStatus === "cancelled" ? "cancelled" : "failed_retryable");
        }
      }
      if (turnFact !== undefined) {
        const persisted = runtimeSessions.get(turnFact.threadId);
        if (persisted?.session.turnId === request.turnId) {
          runtimeSessions.set(turnFact.threadId, {
            threadId: turnFact.threadId,
            turnState: terminalStatus,
            session: {
              ...structuredClone(persisted.session),
              status: terminalStatus,
              completedAt: new Date().toISOString(),
            },
          });
        }
      }
      throw error;
    } finally {
      // completed、failed 都是需要恢复的终态；Checkpoint 也在这里一起保存。
      await saveState();
    }
  });

  connection.onRequest("turn/cancel", (params) => {
    requireInitialized();

    if (agentLoop === undefined) {
      throw new Error("Agent runtime is unavailable");
    }

    const request = parseTurnCancelParams(params);

    cancelChildAgentRuns(request.turnId);

    if (!agentLoop.cancel(request.turnId)) {
      throw new Error(
        `Turn is not running: ${request.turnId}`,
      );
    }

    const result: TurnCancelResult = {
      turnId: request.turnId,
      cancelled: true,
    };

    return result;
  });

  connection.onRequest(
    "finance/monthly-summary",
    (params) => {
      requireInitialized();

      // RPC params 属于不可信边界，先校验再进入金融计算。
      const request = parseMonthlySummaryRequest(params);

      // 金额由确定性代码汇总，未来的 LLM 只能解释这个结果。
      const summary = summarizeMonthlyTransactions(
        sampleTransactions,
        request,
      );

      log(
        `[app-server] finance summary ready: ${request.period}\n`,
      );

      return summary;
    },
  );
}

function requireWorkspaceSandbox(
  sandbox: AppServerDependencies["workspaceSandbox"],
): NonNullable<AppServerDependencies["workspaceSandbox"]> {
  if (sandbox === undefined) throw new Error("Workspace file mentions are unavailable");
  return sandbox;
}

function appendExplicitContext(
  text: string,
  mentions: Array<{ kind: "file"; path: string }>,
  explicitSkills: string[],
): string {
  if (mentions.length === 0 && explicitSkills.length === 0) return text;
  return [
    text,
    "",
    "[用户显式选择的上下文；仅按列出的相对路径与 Skill 名称处理]",
    ...mentions.map((mention) => `- workspace file: ${mention.path}`),
    ...explicitSkills.map((name) => `- Skill: ${name}（先调用 read_skill 读取完整说明）`),
  ].join("\n");
}

function intersectCapabilities(left: readonly string[], right: readonly string[] | undefined): string[] {
  const actualRight = right ?? ["*"];
  if (left.includes("*")) return [...actualRight];
  if (actualRight.includes("*")) return [...left];
  return left.filter((item) => actualRight.includes(item));
}

export function applyAgentModeToTools(tools: string[], mode: import("../agents/agent-runtime.js").AgentCollaborationMode): string[] {
  if (mode !== "off") return tools;
  return tools.includes("*")
    ? ["*", "!run_agent"]
    : tools.filter((tool) => tool !== "run_agent");
}

export function buildParentAgentInstructions(
  base: string,
  mode: import("../agents/agent-runtime.js").AgentCollaborationMode,
  initialChildResult?: AgentRunResult,
  executionConfirmed = false,
  requirement?: import("../requirements/requirement.js").Requirement,
): string {
  if (!executionConfirmed) {
    const plan = requirement === undefined ? "当前尚未生成计划。" : `当前计划为 ${requirement.id} v${requirement.revision}：${requirement.planArtifact.path}。`;
    return `${base}\n你必须遵循内置 clarify-before-execute 工作流：在父 Chat 中持续聊清一个完整需求，不得把每条用户消息当成新任务。确认前不得执行命令、修改业务文件、发布内容或创建子 Agent。需求完整时调用 prepare_requirement_plan 生成测试用例和 Markdown 计划，并显式选择 executionKind：只读分析使用 analysis_only，修改现有软件使用 software_change，完整产品团队交付使用 software_product_delivery；然后等待用户点击“确认执行”。${plan}`;
  }
  if (mode === "off") {
    return `${base}\n当前 Chat 已关闭子 Agent。你必须独立完成本轮任务，不得创建或委派子 Agent。`;
  }
  const delivered = initialChildResult === undefined
    ? ""
    : `\nRuntime 已强制派发首个子 Agent并完成独立验收。Return 状态：${initialChildResult.status}。Return 摘要：${initialChildResult.summary}\n你必须以父 Agent身份检查这份 Return，结合原始用户需求给出最终答复；不要重复执行已委派的工作。若证据不足，可继续委派补充子任务。`;
  return `${base}\n当前 Chat 已开启子 Agent。你是父 Agent和监工：实际执行工作必须委派给子 Agent完成；每个任务只委派一个合适的执行 Agent，不要先创建只负责转派的 Agent，也不要显式委派 reviewer——Runtime 会在执行 Agent返回后自动创建一个独立 Reviewer。你负责跟踪进度、检查 Evidence、验收 Return、要求必要返工，并在全部结果可用后统一给用户最终答复。${delivered}`;
}

export function applyRequirementGateToTools(tools: string[], confirmed: boolean): string[] {
  if (confirmed) return tools;
  const blocked = ["run_agent", "run_command", "write_file", "read_shared_board", "publish_shared_result"];
  if (tools.includes("*")) return ["*", ...blocked.map((tool) => `!${tool}`)];
  return tools.filter((tool) => !blocked.includes(tool));
}

export function routeTeamConfigForExecutionKind(
  config: AgentTeamConfig,
  executionKind: RequirementExecutionKind,
): AgentTeamConfig {
  const normalized = normalizeAgentTeamConfig(config);
  if (executionKind === "software_product_delivery") return normalized;
  const workerProfiles = executionKind === "analysis_only"
    ? ["investigator", "researcher"]
    : ["coder", "tester", "investigator"];
  const allowedProfiles = normalized.allowedProfiles.filter((profile) => workerProfiles.includes(profile));
  if (normalized.independentReview && !allowedProfiles.includes("reviewer")) allowedProfiles.push("reviewer");
  return {
    ...normalized,
    allowedProfiles,
    ...(executionKind === "analysis_only" ? {
      accessMode: "read_only" as const,
      allowedTools: applyCapabilityExclusions(normalized.allowedTools ?? ["*"], ["write_file", "run_command"]),
    } : {}),
  };
}

export function shouldCreateFixedSoftwareTeam(executionKind: RequirementExecutionKind | undefined): boolean {
  return executionKind === "software_product_delivery";
}

export function requirementExecutionStateForJobStatus(
  status: AgentJobStatus | undefined,
): RequirementExecutionState | undefined {
  if (status === "completed") return "completed";
  if (status === "failed" || status === "partial") return "failed_retryable";
  if (status === "cancelled") return "cancelled";
  return undefined;
}

export function isExplicitRequirementRetry(value: string): boolean {
  const normalized = value.replace(/\s+/g, "").replace(/[。！!]$/, "");
  return ["重试", "重新执行", "再次执行"].includes(normalized);
}

function applyCapabilityExclusions(tools: string[], excluded: string[]): string[] {
  if (tools.includes("*")) {
    return [...tools.filter((tool) => !excluded.includes(tool.replace(/^!/, ""))), ...excluded.map((tool) => `!${tool}`)];
  }
  return tools.filter((tool) => !excluded.includes(tool));
}

export function selectInitialChildProfile(
  input: string,
  allowedProfiles: readonly string[],
): string {
  const candidates = /代码|实现|开发|修复|bug|测试|构建|编译|文件|项目/i.test(input)
    ? ["coder", "investigator", "researcher", "tester", "reviewer"]
    : /搜索|查询|政策|资料|调研|研究|新闻|规则/i.test(input)
      ? ["researcher", "investigator", "coder", "tester", "reviewer"]
      : ["investigator", "researcher", "coder", "tester", "reviewer"];
  return candidates.find((profile) => allowedProfiles.includes(profile))
    ?? allowedProfiles[0]
    ?? "investigator";
}

function readTurnUserInput(lifecycleStore: LifecycleStore, turnId: string): string {
  const item = lifecycleStore.getItemsForTurn(turnId).find((candidate) => candidate.type === "user_message");
  return typeof item?.content === "object" && item.content !== null &&
    "text" in item.content && typeof item.content.text === "string"
    ? item.content.text
    : "执行用户当前任务并返回可验证结果";
}

function readCompletedTurnResult(lifecycleStore: LifecycleStore, turnId: string): TurnRunResult {
  const turn = lifecycleStore.getTurn(turnId);
  const assistantMessage = lifecycleStore.getItemsForTurn(turnId)
    .filter((item) => item.type === "assistant_message")
    .at(-1);
  if (turn?.status !== "completed" || assistantMessage === undefined) {
    throw new Error("Team Workflow finished without a committed root-turn delivery");
  }
  return { turn, assistantMessage };
}

function parseOutcomeUnknownResolutionRequest(value: unknown): ResolveOutcomeUnknownInput {
  if (!isRecord(value) || !hasOnlyKeys(value, ["resolutionId", "expectedVersion", "idempotencyKey", "resolution"]) ||
    typeof value.resolutionId !== "string" || !Number.isInteger(value.expectedVersion) ||
    typeof value.idempotencyKey !== "string" || !isRecord(value.resolution) ||
    typeof value.resolution.action !== "string" || typeof value.resolution.reason !== "string") {
    throw new Error("Invalid outcome-unknown resolution request");
  }
  const base = {
    resolutionId: value.resolutionId,
    expectedVersion: value.expectedVersion as number,
    idempotencyKey: value.idempotencyKey,
  };
  switch (value.resolution.action) {
    case "confirm_not_executed_retry":
      if (!hasOnlyKeys(value.resolution, ["action", "reason", "toolSideEffectConfirmed"]) ||
        (value.resolution.toolSideEffectConfirmed !== undefined && typeof value.resolution.toolSideEffectConfirmed !== "boolean")) {
        throw new Error("Invalid outcome-unknown retry resolution");
      }
      return {
        ...base,
        resolution: {
          action: "confirm_not_executed_retry",
          reason: value.resolution.reason,
          ...(value.resolution.toolSideEffectConfirmed === undefined
            ? {}
            : { toolSideEffectConfirmed: value.resolution.toolSideEffectConfirmed }),
        },
      };
    case "record_external_result":
      if (!hasOnlyKeys(value.resolution, ["action", "reason", "externalResult"]) ||
        !isRecord(value.resolution.externalResult) ||
        !hasOnlyKeys(value.resolution.externalResult, ["summary", "value"]) ||
        typeof value.resolution.externalResult.summary !== "string" ||
        !("value" in value.resolution.externalResult)) {
        throw new Error("Invalid outcome-unknown external result");
      }
      return {
        ...base,
        resolution: {
          action: "record_external_result",
          reason: value.resolution.reason,
          externalResult: {
            summary: value.resolution.externalResult.summary,
            value: value.resolution.externalResult.value,
          },
        },
      };
    case "mark_manual_required":
    case "abandon":
      if (!hasOnlyKeys(value.resolution, ["action", "reason"])) {
        throw new Error("Invalid outcome-unknown terminal resolution");
      }
      return {
        ...base,
        resolution: {
          action: value.resolution.action,
          reason: value.resolution.reason,
        },
      };
    default:
      throw new Error("Invalid outcome-unknown resolution action");
  }
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
