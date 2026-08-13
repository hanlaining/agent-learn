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
import { DEFAULT_AGENT_TEAM_CONFIG, normalizeAgentTeamConfig } from "../agents/agent-runtime.js";
import type {
  PersistedRuntimeSession,
  PersistedThreadConfig,
} from "../runtime/json-file-runtime-persistence.js";

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
  runInitialChildAgent?: (request: {
    parentTurnId: string;
    profileId: string;
    task: string;
  }) => Promise<AgentRunResult>;
  threadConfigs?: Map<string, PersistedThreadConfig>;
  runtimeSessions?: Map<string, PersistedRuntimeSession>;
  workspaceSandbox?: Pick<WorkspaceSandbox, "searchFiles" | "validateFilePath">;
  skillNames?: readonly string[];
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
    runInitialChildAgent,
    threadConfigs = new Map(),
    runtimeSessions = new Map(),
    workspaceSandbox,
    skillNames = [],
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

  connection.onRequest("thread/start", async () => {
    requireInitialized();

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
      (thread) => thread.deletedAt === undefined && agentRunStore?.isChildThread(thread.id) !== true,
    );
  });

  connection.onRequest("thread/trash/list", () => {
    requireInitialized();
    return lifecycleStore.listThreads().filter((thread) => thread.deletedAt !== undefined && agentRunStore?.isChildThread(thread.id) !== true);
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
    return { job, tasks, edges: agentRuntimeStore!.listEdges(job.id), evidence: tasks.flatMap((task) => agentRuntimeStore!.listEvidence(task.id)), board: agentRuntimeStore!.listBoard(job.id), returns: agentRuntimeStore!.listReturns(job.id) };
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

    if (agentLoop === undefined) {
      throw new Error(
        "LLM is unavailable: set OPENAI_API_KEY",
      );
    }

    const request = parseTurnRunParams(params);
    const turnFact = lifecycleStore.getTurn(request.turnId);
    const threadConfig = turnFact === undefined ? undefined : threadConfigs.get(turnFact.threadId);
    const profile = agentRegistry?.require(threadConfig?.agentProfileId ?? "orchestrator");
    const teamConfig = threadConfig?.agentTeam ?? DEFAULT_AGENT_TEAM_CONFIG;
    const rootRun = turnFact === undefined
      ? undefined
      : agentRunStore?.ensureRoot(turnFact.threadId, request.turnId, profile?.id);
    const job = rootRun === undefined || turnFact === undefined ? undefined
      : agentRuntimeStore?.createJob({ threadId: turnFact.threadId, rootTurnId: request.turnId,
          rootRunId: rootRun.rootRunId, configSnapshot: threadConfig?.agentTeam ?? DEFAULT_AGENT_TEAM_CONFIG });
    if (rootRun !== undefined) agentRunStore?.setStatus(rootRun.id, "running");
    if (job !== undefined) agentRuntimeStore?.setJobStatus(job.id, "running");

    try {
      const initialChildResult = threadConfig?.agentTeam?.mode !== "auto" || runInitialChildAgent === undefined
        ? undefined
        : await runInitialChildAgent({
            parentTurnId: request.turnId,
            profileId: selectInitialChildProfile(
              readTurnUserInput(lifecycleStore, request.turnId),
              teamConfig.allowedProfiles,
            ),
            task: readTurnUserInput(lifecycleStore, request.turnId),
          });
      if (job !== undefined && initialChildResult !== undefined) {
        agentRuntimeStore?.setJobStatus(job.id, "reviewing");
      }
      const result = await agentLoop.run(request.turnId, {
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: request.reasoningEffort }),
        ...(profile === undefined ? {} : { instructions: buildParentAgentInstructions(
          profile.instructions,
          teamConfig.mode,
          initialChildResult,
        ) }),
        ...(profile === undefined ? {} : { allowedTools: applyAgentModeToTools(intersectCapabilities(profile.allowedTools, teamConfig.allowedTools), teamConfig.mode),
          allowedSkills: intersectCapabilities(profile.allowedSkills, teamConfig.allowedSkills) }),
      });

      log(
        `[app-server] turn completed: ${result.turn.id}\n`,
      );

      if (rootRun !== undefined) {
        agentRunStore?.complete(rootRun.id, {
          runId: rootRun.id,
          status: "completed",
          summary: "主 Agent 已完成任务",
        });
      }
      if (job !== undefined) agentRuntimeStore?.setJobStatus(job.id, "completed");

      return result;
    } catch (error) {
      if (rootRun !== undefined) {
        agentRunStore?.complete(rootRun.id, {
          runId: rootRun.id,
          status: lifecycleStore.getTurn(request.turnId)?.status === "timed_out"
            ? "timed_out"
            : lifecycleStore.getTurn(request.turnId)?.status === "interrupted"
              ? "cancelled"
              : "failed",
          summary: "主 Agent 未完成任务",
          safeError: "Agent 执行失败",
        });
      }
      if (job !== undefined) agentRuntimeStore?.setJobStatus(job.id,
        lifecycleStore.getTurn(request.turnId)?.status === "interrupted" ? "cancelled" : "failed");
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
): string {
  if (mode === "off") {
    return `${base}\n当前 Chat 已关闭子 Agent。你必须独立完成本轮任务，不得创建或委派子 Agent。`;
  }
  const delivered = initialChildResult === undefined
    ? ""
    : `\nRuntime 已强制派发首个子 Agent并完成独立验收。Return 状态：${initialChildResult.status}。Return 摘要：${initialChildResult.summary}\n你必须以父 Agent身份检查这份 Return，结合原始用户需求给出最终答复；不要重复执行已委派的工作。若证据不足，可继续委派补充子任务。`;
  return `${base}\n当前 Chat 已开启子 Agent。你是父 Agent和监工：实际执行工作必须委派给子 Agent完成；你负责跟踪进度、检查 Evidence、验收 Return、要求必要返工，并在全部结果可用后统一给用户最终答复。${delivered}`;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
