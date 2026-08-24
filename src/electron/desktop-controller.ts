import type {
  AgentEvent,
} from "../agent/events.js";
import {
  EMPTY_RUNTIME_CAPABILITIES,
  type RuntimeCapabilities,
} from "../app-server/runtime-capabilities.js";
import type {
  Thread,
} from "../runtime/lifecycle.js";
import type {
  ThreadHistoryResult,
} from "../runtime/thread-history.js";
import type {
  TurnCancelResult,
} from "../runtime/turn-cancel.js";
import type {
  TurnRunResult,
} from "../runtime/turn-run.js";
import {
  cloneRuntimeSession,
  upsertRuntimeContent,
  type RuntimeActivity,
  type RuntimeContent,
  type RuntimeSession,
  type RuntimeSessionStatus,
} from "../runtime/runtime-session.js";
import type {
  TurnStartResult,
} from "../runtime/turn-start.js";
import type {
  DesktopEvent,
  DesktopMessage,
  DesktopMessageInput,
  DesktopOutcomeUnknownResolution,
  DesktopResolveOutcomeUnknownInput,
  DesktopSendResult,
  DesktopSnapshot,
  DesktopAgentConfig,
  DesktopModelSettings,
  DesktopReasoningEffort,
  DesktopThreadSummary,
  DesktopTurnState,
  DesktopWorkspaceSearchResult,
} from "./desktop-types.js";
import { DEFAULT_AGENT_TEAM_CONFIG, normalizeAgentTeamConfig, type AgentTeamConfig } from "../agents/agent-runtime.js";

export interface DesktopRuntimeClient {
  listThreads(): Promise<Thread[]>;
  startThread(): Promise<Thread>;
  renameThread?(threadId: string, title: string): Promise<Thread>;
  softDeleteThreads?(threadIds: string[], batchDeleteId: string): Promise<Thread[]>;
  restoreThread?(threadId: string): Promise<Thread>;
  listTrash?(): Promise<Thread[]>;
  getAgentRuntime?(threadId: string): Promise<unknown>;
  advanceFixedProduct?(threadId: string, expectedStage: import("../agents/fixed-software-team-coordinator.js").FixedProductStage): Promise<unknown>;
  getRequirement?(threadId: string): Promise<import("../requirements/requirement.js").Requirement | undefined>;
  confirmRequirement?(requirementId: string, revision: number, contentHash: string): Promise<import("../requirements/requirement.js").Requirement>;
  confirmDesign?(requirementId: string, revision: number, contentHash: string): Promise<import("../requirements/requirement.js").Requirement>;
  submitDesignFeedback?(requirementId: string, feedback: string): Promise<import("../requirements/requirement.js").Requirement>;
  reworkEngineeringChat?(threadId: string, taskId: string, reason: string): Promise<unknown>;
  readThreadHistory(threadId: string): Promise<ThreadHistoryResult>;
  getCapabilities(): Promise<RuntimeCapabilities>;
  searchWorkspaceFiles?(query: string): Promise<DesktopWorkspaceSearchResult>;
  selectModel(model: string): Promise<RuntimeCapabilities>;
  startTurn(threadId: string, input: string, context?: Omit<DesktopMessageInput, "text">): Promise<TurnStartResult>;
  runTurn(
    turnId: string,
    options?: { model?: string; reasoningEffort?: DesktopReasoningEffort },
  ): Promise<TurnRunResult>;
  listAgentRuns(threadId?: string): Promise<import("../agents/agent-run.js").AgentRun[]>;
  getThreadConfig(threadId: string): Promise<DesktopAgentConfig | undefined>;
  setThreadConfig(threadId: string, config: DesktopAgentConfig): Promise<void>;
  listRuntimeSessions(): Promise<Array<{
    threadId: string; turnState: DesktopTurnState; session: RuntimeSession;
  }>>;
  listOutcomeUnknown?(threadId?: string): Promise<DesktopOutcomeUnknownResolution[]>;
  resolveOutcomeUnknown?(input: DesktopResolveOutcomeUnknownInput): Promise<DesktopOutcomeUnknownResolution>;
  setRuntimeSession(threadId: string, turnState: DesktopTurnState, session: RuntimeSession): Promise<void>;
  cancelTurn(turnId: string): Promise<TurnCancelResult>;
  onAgentEvent(listener: (event: AgentEvent) => void): () => void;
  close(): Promise<void>;
}

type DesktopEventListener = (event: DesktopEvent) => void;

interface DesktopThreadRun {
  turnId: string;
  state: DesktopTurnState;
  round: number;
  session: RuntimeSession;
}

const MAX_INPUT_CHARACTERS = 32_000;
const MAX_TITLE_CHARACTERS = 42;
const DESKTOP_REASONING_EFFORTS = new Set<DesktopReasoningEffort>([
  "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
]);

/**
 * Main Process 内的单 Agent 桌面会话控制器。
 * Renderer 只接触本类生成的安全快照和事件，不接触 Runtime 原始对象。
 */
export class DesktopController {
  private readonly listeners = new Set<DesktopEventListener>();
  private activeThreadId: string | undefined;
  private activeAgentThreadId: string | undefined;
  private newThreadDraft = false;
  private readonly runsByThread = new Map<string, DesktopThreadRun>();
  private readonly threadByTurn = new Map<string, string>();
  private readonly agentNameByTurn = new Map<string, string>();
  private readonly configsByThread = new Map<string, DesktopAgentConfig>();
  private draftConfig: DesktopAgentConfig | undefined;
  private capabilities: RuntimeCapabilities = EMPTY_RUNTIME_CAPABILITIES;
  private capabilitiesLoaded = false;
  private persistentStateLoaded = false;
  private readonly removeAgentListener: () => void;

  constructor(private readonly runtime: DesktopRuntimeClient) {
    this.removeAgentListener = runtime.onAgentEvent((event) => {
      this.handleAgentEvent(event);
    });
  }

  onEvent(listener: DesktopEventListener): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  async getSnapshot(): Promise<DesktopSnapshot> {
    const threads = await this.runtime.listThreads();
    const trashThreads = await this.runtime.listTrash?.() ?? [];
    const histories = await Promise.all(
      threads.map((thread) =>
        this.runtime.readThreadHistory(thread.id),
      ),
    );

    if (!this.capabilitiesLoaded) {
      this.capabilities = await this.runtime.getCapabilities();
      this.capabilitiesLoaded = true;
    }

    if (!this.persistentStateLoaded) {
      const [configs, sessions] = await Promise.all([
        Promise.all(threads.map(async (thread) => ({
          threadId: thread.id,
          config: await this.runtime.getThreadConfig(thread.id),
        }))),
        this.runtime.listRuntimeSessions(),
      ]);
      for (const { threadId, config } of configs) {
        if (config !== undefined) this.configsByThread.set(threadId, config);
      }
      for (const persisted of sessions) {
        this.runsByThread.set(persisted.threadId, {
          turnId: persisted.session.turnId,
          state: isRunningState(persisted.turnState) ? "cancelled" : persisted.turnState,
          round: readLatestRound(persisted.session),
          session: persisted.session.status === "running"
            ? { ...persisted.session, status: "cancelled", completedAt: new Date().toISOString() }
            : persisted.session,
        });
      }
      this.persistentStateLoaded = true;
    }

    const defaultConfig = this.getDefaultConfig();
    for (const history of histories) {
      this.configsByThread.set(
        history.thread.id,
        this.configsByThread.get(history.thread.id) ?? { ...defaultConfig },
      );
    }
    const sorted = histories
      .map((history) => {
        const config = this.configsByThread.get(history.thread.id)!;
        return toThreadSummary(
          history,
          this.runsByThread.get(history.thread.id)?.state ?? "idle",
          config,
        );
      })
      .sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt),
      );

    if (
      !this.newThreadDraft &&
      (
        this.activeThreadId === undefined ||
        !sorted.some((thread) => thread.id === this.activeThreadId)
      )
    ) {
      this.activeThreadId = sorted[0]?.id;
    }

    const parentHistory = histories.find(
      (history) => history.thread.id === this.activeThreadId,
    );
    const activeHistory = this.activeAgentThreadId === undefined
      ? parentHistory
      : await this.runtime.readThreadHistory(this.activeAgentThreadId);

    const activeRun = this.activeThreadId === undefined
      ? undefined
      : this.runsByThread.get(this.activeThreadId);
    const agentRuntime = this.activeThreadId === undefined ? undefined : await this.runtime.getAgentRuntime?.(this.activeThreadId);
    const requirement = this.activeThreadId === undefined ? undefined : await this.runtime.getRequirement?.(this.activeThreadId);
    const outcomeUnknownInvocations = await this.runtime.listOutcomeUnknown?.(this.activeThreadId) ?? [];

    return {
      threads: sorted,
      ...(this.activeThreadId === undefined
        ? {}
        : { activeThreadId: this.activeThreadId }),
      ...(this.activeAgentThreadId === undefined ? {} : { activeAgentThreadId: this.activeAgentThreadId }),
      messages: activeHistory?.messages.map((message) => ({
        ...message,
      })) ?? [],
      capabilities: cloneCapabilities(this.capabilities),
      turnState: activeRun?.state ?? "idle",
      agentConfig: { ...(
        this.activeThreadId === undefined
          ? this.draftConfig ?? defaultConfig
          : this.configsByThread.get(this.activeThreadId) ?? defaultConfig
      ) },
      agentRuns: this.activeThreadId === undefined
        ? []
        : filterCurrentJobRuns(await this.runtime.listAgentRuns(this.activeThreadId), activeRun?.turnId).map((run) => ({
            id: run.id, jobId: run.jobId, rootRunId: run.rootRunId, attempt: run.attempt,
            ...(run.taskId === undefined ? {} : { taskId: run.taskId }), threadId: run.threadId, turnId: run.turnId,
            agentProfileId: run.agentProfileId,
            ...(run.parentRunId === undefined ? {} : { parentRunId: run.parentRunId }),
            status: run.status, task: run.task, depth: run.depth,
            ...(run.coordinationStatus === undefined ? {} : { coordinationStatus: run.coordinationStatus }),
            ...(run.attentionLevel === undefined ? {} : { attentionLevel: run.attentionLevel }),
            ...(run.statusMessage === undefined ? {} : { statusMessage: run.statusMessage }),
            ...(run.failureOrigin === undefined ? {} : { failureOrigin: run.failureOrigin }),
            ...(run.result?.safeError === undefined ? {} : { safeError: run.result.safeError }),
          })),
      trash: trashThreads.map((thread) => ({ id: thread.id, title: thread.title ?? "未命名 Chat", deletedAt: thread.deletedAt!, trashExpiresAt: thread.trashExpiresAt!, ...(thread.deleteBatchId === undefined ? {} : { deleteBatchId: thread.deleteBatchId }) })),
      ...(agentRuntime === undefined ? {} : { agentRuntime: agentRuntime as import("./desktop-types.js").DesktopAgentRuntimeView }),
      ...(requirement === undefined ? {} : { requirement }),
      outcomeUnknownInvocations,
      ...(activeRun === undefined
        ? {}
        : { runtimeSession: cloneRuntimeSession(activeRun.session) }),
    };
  }

  async resolveOutcomeUnknown(input: DesktopResolveOutcomeUnknownInput): Promise<DesktopOutcomeUnknownResolution> {
    if (this.runtime.resolveOutcomeUnknown === undefined) {
      throw new Error("Outcome-unknown resolution is unavailable");
    }
    return this.runtime.resolveOutcomeUnknown(input);
  }

  async createThread(): Promise<DesktopSnapshot> {
    // “新建任务”只进入本地草稿；第一条消息发送时才真正创建并持久化 Thread。
    this.activeThreadId = undefined;
    this.activeAgentThreadId = undefined;
    this.newThreadDraft = true;
    this.draftConfig = { ...this.getDefaultConfig() };
    return this.getSnapshot();
  }

  async selectModel(model: string): Promise<DesktopSnapshot> {
    if (!this.capabilities.models.some((candidate) => candidate.id === model)) {
      throw new Error("Unsupported model");
    }
    const config = this.getActiveConfig();
    config.model = model;
    const efforts = this.capabilities.models.find((item) => item.id === model)
      ?.reasoningEfforts ?? [];
    if (efforts.length > 0 && !efforts.includes(config.reasoningEffort)) {
      config.reasoningEffort = efforts.includes("high")
        ? "high"
        : efforts[0] as DesktopReasoningEffort;
    }
    await this.persistActiveConfig(config);
    return this.getSnapshot();
  }

  async selectReasoningEffort(
    reasoningEffort: DesktopReasoningEffort,
  ): Promise<DesktopSnapshot> {
    const config = this.getActiveConfig();
    const efforts = this.capabilities.models.find((item) => item.id === config.model)
      ?.reasoningEfforts ?? [];
    if (efforts.length > 0 && !efforts.includes(reasoningEffort)) {
      throw new Error("Unsupported reasoning effort");
    }
    config.reasoningEffort = reasoningEffort;
    await this.persistActiveConfig(config);
    return this.getSnapshot();
  }

  async selectModelSettings(
    settings: DesktopModelSettings,
  ): Promise<DesktopSnapshot> {
    if (!DESKTOP_REASONING_EFFORTS.has(settings.reasoningEffort)) {
      throw new Error("Unsupported reasoning effort");
    }
    const model = this.capabilities.models.find(
      (candidate) => candidate.id === settings.model,
    );
    if (model === undefined) {
      throw new Error("Unsupported model");
    }
    const efforts = model.reasoningEfforts ?? [];
    if (efforts.length > 0 && !efforts.includes(settings.reasoningEffort)) {
      throw new Error("Unsupported reasoning effort");
    }
    const config = this.getActiveConfig();
    config.model = settings.model;
    config.reasoningEffort = settings.reasoningEffort;
    await this.persistActiveConfig(config);
    return this.getSnapshot();
  }

  async updateAgentTeam(config: Partial<AgentTeamConfig>): Promise<DesktopSnapshot> {
    const active = this.getActiveConfig();
    active.agentTeam = normalizeAgentTeamConfig({ ...(active.agentTeam ?? DEFAULT_AGENT_TEAM_CONFIG), ...config });
    await this.persistActiveConfig(active);
    return this.getSnapshot();
  }

  async renameThread(threadId: string, title: string): Promise<DesktopSnapshot> {
    if (this.runtime.renameThread === undefined) throw new Error("Thread rename is unavailable");
    await this.runtime.renameThread(threadId, title);
    return this.getSnapshot();
  }

  async softDeleteThreads(threadIds: string[], batchDeleteId: string): Promise<DesktopSnapshot> {
    if (this.runtime.softDeleteThreads === undefined) throw new Error("Thread delete is unavailable");
    await this.runtime.softDeleteThreads([...threadIds], batchDeleteId);
    if (this.activeThreadId !== undefined && threadIds.includes(this.activeThreadId)) {
      this.activeThreadId = undefined; this.newThreadDraft = true; this.draftConfig = this.getDefaultConfig();
    }
    return this.getSnapshot();
  }

  async restoreThread(threadId: string): Promise<DesktopSnapshot> {
    if (this.runtime.restoreThread === undefined) throw new Error("Thread restore is unavailable");
    await this.runtime.restoreThread(threadId);
    return this.getSnapshot();
  }

  async selectThread(threadId: string): Promise<DesktopSnapshot> {

    if (threadId.trim().length === 0) {
      throw new Error("Thread id is required");
    }

    const threads = await this.runtime.listThreads();

    if (!threads.some((thread) => thread.id === threadId)) {
      throw new Error("Thread is unavailable");
    }

    this.activeThreadId = threadId;
    this.activeAgentThreadId = undefined;
    this.newThreadDraft = false;
    return this.getSnapshot();
  }

  async selectAgentThread(threadId?: string): Promise<DesktopSnapshot> {
    if (threadId === undefined) {
      this.activeAgentThreadId = undefined;
      return this.getSnapshot();
    }
    if (this.activeThreadId === undefined) throw new Error("请先选择父 Chat");
    const runs = await this.runtime.listAgentRuns(this.activeThreadId);
    if (!runs.some((run) => run.parentRunId !== undefined && run.threadId === threadId)) {
      throw new Error("该子 Agent 不属于当前 Chat");
    }
    this.activeAgentThreadId = threadId;
    return this.getSnapshot();
  }

  async advanceFixedProduct(expectedStage: import("../agents/fixed-software-team-coordinator.js").FixedProductStage): Promise<DesktopSnapshot> {
    if (this.activeThreadId === undefined || this.runtime.advanceFixedProduct === undefined) throw new Error("当前没有可推进的产品双轮验收");
    await this.runtime.advanceFixedProduct(this.activeThreadId, expectedStage);
    return this.getSnapshot();
  }

  async confirmRequirement(): Promise<DesktopSendResult> {
    if (this.activeThreadId === undefined || this.runtime.confirmRequirement === undefined || this.runtime.getRequirement === undefined) {
      throw new Error("当前没有可确认的需求计划");
    }
    const requirement = await this.runtime.getRequirement(this.activeThreadId);
    if (requirement === undefined || requirement.status !== "planned") throw new Error("当前计划无需确认或尚未生成");
    await this.runtime.confirmRequirement(requirement.id, requirement.revision, requirement.planArtifact.contentHash);
    this.activeAgentThreadId = undefined;
    return this.sendMessage(`确认执行 ${requirement.id} v${requirement.revision}，请严格按已确认计划执行并完成测试验收。`);
  }

  async confirmDesign(): Promise<DesktopSnapshot> {
    if (this.activeThreadId === undefined || this.runtime.confirmDesign === undefined || this.runtime.getRequirement === undefined) {
      throw new Error("当前没有可确认的产品设计");
    }
    const requirement = await this.runtime.getRequirement(this.activeThreadId);
    if (requirement?.designStatus !== "draft_ready" || requirement.designArtifact === undefined) throw new Error("产品原稿与 Mock 尚未就绪");
    await this.runtime.confirmDesign(requirement.id, requirement.revision, requirement.designArtifact.contentHash);
    return this.getSnapshot();
  }

  async submitDesignFeedback(feedback: string): Promise<DesktopSnapshot> {
    if (this.activeThreadId === undefined || this.runtime.submitDesignFeedback === undefined || this.runtime.getRequirement === undefined) {
      throw new Error("当前没有可修改的产品设计");
    }
    const requirement = await this.runtime.getRequirement(this.activeThreadId);
    if (requirement?.designStatus !== "draft_ready") throw new Error("产品原稿与 Mock 尚未就绪");
    await this.runtime.submitDesignFeedback(requirement.id, feedback);
    return this.getSnapshot();
  }

  async reworkEngineeringChat(taskId: string, reason: string): Promise<DesktopSnapshot> {
    if (this.activeThreadId === undefined || this.runtime.reworkEngineeringChat === undefined) throw new Error("当前没有可返工的工程 Chat");
    await this.runtime.reworkEngineeringChat(this.activeThreadId, taskId, reason);
    return this.getSnapshot();
  }

  async searchWorkspaceFiles(query: string): Promise<DesktopWorkspaceSearchResult> {
    if (typeof query !== "string" || query.length > 240) throw new Error("Invalid workspace file query");
    if (this.runtime.searchWorkspaceFiles === undefined) throw new Error("Workspace file search is unavailable");
    return this.runtime.searchWorkspaceFiles(query);
  }

  async sendMessage(input: string | DesktopMessageInput): Promise<DesktopSendResult> {
    const messageInput = typeof input === "string" ? { text: input } : input;
    const text = requireInput(messageInput.text);
    const context = normalizeMessageContext(messageInput, this.capabilities);
    let threadId = this.activeThreadId;
    let run: DesktopThreadRun | undefined;
    if (threadId !== undefined && isRunningState(
      this.runsByThread.get(threadId)?.state ?? "idle",
    )) {
      throw new Error("当前 Chat 仍在运行");
    }

    try {
      if (threadId === undefined) {
        threadId = (await this.runtime.startThread()).id;
        this.activeThreadId = threadId;
        this.configsByThread.set(
          threadId,
          { ...(this.draftConfig ?? this.getDefaultConfig()) },
        );
        await this.runtime.setThreadConfig(threadId, this.configsByThread.get(threadId)!);
        this.draftConfig = undefined;
        this.newThreadDraft = false;
      }

      if (isRunningState(this.runsByThread.get(threadId)?.state ?? "idle")) {
        throw new Error("当前 Chat 仍在运行");
      }
      const historyBeforeTurn = await this.runtime.readThreadHistory(
        threadId,
      );
      const started = await this.runtime.startTurn(threadId, text, context);
      const turnId = started.turn.id;
      run = {
        turnId,
        state: "starting",
        round: 0,
        session: {
          turnId,
          status: "running",
          startedAt: started.turn.createdAt,
          items: [],
        },
      };
      this.runsByThread.set(threadId, run);
      this.threadByTurn.set(turnId, threadId);
      this.emitRuntimeSession(threadId, run);

      const userMessage = toDesktopMessage(started.userMessage);
      this.emit({
        type: "message/user",
        threadId,
        message: userMessage,
      });
      if (historyBeforeTurn.messages.length === 0) {
        this.emit({
          type: "thread/updated",
          thread: {
            id: threadId,
            title: createThreadTitle(text),
            status: historyBeforeTurn.thread.status,
            createdAt: historyBeforeTurn.thread.createdAt,
            lastActivityAt: started.turn.createdAt,
            messageCount: 1,
            turnState: run.state,
            model: this.configsByThread.get(threadId)?.model ?? "",
            reasoningEffort: this.configsByThread.get(threadId)?.reasoningEffort ?? "high",
          },
        });
      }
      this.setTurnState(threadId, run, "thinking");

      const config = this.configsByThread.get(threadId) ?? this.getDefaultConfig();
      const result = await this.runtime.runTurn(turnId, {
        model: config.model,
        reasoningEffort: config.reasoningEffort,
      });
      const finalText = readItemText(result.assistantMessage.content);

      this.emit({
        type: "assistant/completed",
        threadId,
        turnId,
        text: finalText,
      });
      this.setTurnState(threadId, run, "completed");

      return { turnId };
    } catch {
      if (run !== undefined && isCancellationTerminal(run.state)) {
        return { turnId: run.turnId };
      }

      if (run !== undefined) {
        if (run.session.status === "running" && threadId !== undefined) {
          this.finishRuntimeSession(threadId, run, "failed", "failed");
          this.upsertRuntimeItem({
            id: "safe-error",
            turnId: run.turnId,
            kind: "error",
            code: "agent_failed",
            title: "请求未能完成",
            safeMessage: "Agent 执行失败，请重试",
            retryable: true,
          }, threadId, run);
        }
        if (threadId !== undefined) this.setTurnState(
          threadId,
          run,
          "failed",
          "Agent 执行失败，请重试",
        );
      }

      throw new Error("Agent 执行失败，请重试");
    }
  }

  async cancelTurn(): Promise<boolean> {
    const threadId = this.activeThreadId;
    const run = threadId === undefined
      ? undefined
      : this.runsByThread.get(threadId);
    if (threadId === undefined || run === undefined) {
      return false;
    }
    this.setTurnState(threadId, run, "cancelling");

    try {
      await this.runtime.cancelTurn(run.turnId);
      return true;
    } catch {
      // Turn 可能在点击停止和 RPC 到达之间自然结束；对 UI 来说目标已达到。
      return false;
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.runsByThread.values()]
      .filter((run) => isRunningState(run.state)).map(
      (run) => this.runtime.cancelTurn(run.turnId).catch(() => undefined),
    ));
    this.removeAgentListener();
    await this.runtime.close();
  }

  getPermissionContext(turnId: string): { threadId?: string; agentName: string } {
    const threadId = this.threadByTurn.get(turnId);
    return {
      ...(threadId === undefined ? {} : { threadId }),
      agentName: this.agentNameByTurn.get(turnId) ?? "Agent",
    };
  }

  private handleAgentEvent(event: AgentEvent): void {
    if (event.type === "agent/run_updated") {
      this.threadByTurn.set(event.run.turnId, event.threadId);
      this.agentNameByTurn.set(event.run.turnId, event.run.agentProfileId);
      this.emit({
        type: "agent/run_updated",
        threadId: event.threadId,
        turnId: event.turnId,
        run: {
          id: event.run.id, jobId: event.run.jobId, rootRunId: event.run.rootRunId,
          attempt: event.run.attempt, ...(event.run.taskId === undefined ? {} : { taskId: event.run.taskId }),
          threadId: event.run.threadId, turnId: event.run.turnId,
          agentProfileId: event.run.agentProfileId,
          ...(event.run.parentRunId === undefined ? {} : { parentRunId: event.run.parentRunId }),
          status: event.run.status, task: event.run.task, depth: event.run.depth,
          ...(event.run.coordinationStatus === undefined ? {} : { coordinationStatus: event.run.coordinationStatus }),
          ...(event.run.attentionLevel === undefined ? {} : { attentionLevel: event.run.attentionLevel }),
          ...(event.run.statusMessage === undefined ? {} : { statusMessage: event.run.statusMessage }),
          ...(event.run.failureOrigin === undefined ? {} : { failureOrigin: event.run.failureOrigin }),
          ...(event.run.result?.safeError === undefined ? {} : { safeError: event.run.result.safeError }),
        },
      });
      return;
    }
    const threadId = this.threadByTurn.get(event.turnId);
    if (threadId === undefined) return;
    const run = this.runsByThread.get(threadId);
    if (run === undefined || run.turnId !== event.turnId) return;
    const turnId = event.turnId;

    switch (event.type) {
      case "model/started":
        run.round = event.round;
        this.setTurnState(threadId, run, "thinking");
        this.upsertRuntimeItem({
          id: `planning-${event.round}`,
          turnId,
          kind: "activity",
          activityKind: "planning",
          round: event.round,
          status: "running",
          title: `模型第 ${event.round + 1} 轮正在处理`,
        }, threadId, run);
        this.upsertActivity(threadId, run, {
          id: `model-${event.round}`,
          kind: "thinking",
          status: "running",
          label: `模型第 ${event.round + 1} 轮正在思考`,
        });
        return;

      case "model/completed":
        this.upsertRuntimeItem({
          id: `planning-${event.round}`,
          turnId,
          kind: "activity",
          activityKind: "planning",
          round: event.round,
          status: "completed",
          title: event.functionCallCount === 0
            ? "模型已生成最终回答"
            : `模型选择了 ${event.functionCallCount} 个工具`,
        }, threadId, run);
        this.upsertActivity(threadId, run, {
          id: `model-${event.round}`,
          kind: "thinking",
          status: "completed",
          label: event.functionCallCount === 0
            ? "模型已生成最终回答"
            : `模型选择了 ${event.functionCallCount} 个工具`,
        });
        return;

      case "reasoning/summary_delta":
        {
          const id = `reasoning-${event.round}-${event.summaryIndex}`;
          const existing = run.session.items.find(
            (item) => item.id === id,
          );
          this.upsertRuntimeItem({
            id,
            turnId,
            kind: "reasoning_summary",
            round: event.round,
            summaryIndex: event.summaryIndex,
            status: "streaming",
            markdown:
              existing?.kind === "reasoning_summary"
                ? existing.markdown + event.delta
                : event.delta,
          }, threadId, run);
        }
        return;

      case "reasoning/summary_part_added":
        this.upsertRuntimeItem({
          id: `reasoning-${event.round}-${event.summaryIndex}`,
          turnId,
          kind: "reasoning_summary",
          round: event.round,
          summaryIndex: event.summaryIndex,
          status: "streaming",
          markdown: "",
        }, threadId, run);
        return;

      case "reasoning/summary_completed":
        this.completeReasoningForRound(threadId, run, event.round);
        return;

      case "context/compacted":
        this.upsertRuntimeItem({
          id: "context-compaction",
          turnId,
          kind: "activity",
          activityKind: "context",
          round: run.round,
          status: "completed",
          title: "已整理长对话上下文",
        }, threadId, run);
        this.upsertActivity(threadId, run, {
          id: "context-compaction",
          kind: "context",
          status: "completed",
          label: "已整理长对话上下文",
        });
        return;

      case "web_search/started":
      case "web_search/searching":
        this.setTurnState(threadId, run, "searching");
        this.upsertRuntimeItem({
          id: `search-${event.callId}`,
          turnId,
          kind: "activity",
          activityKind: "searched",
          round: run.round,
          status: "running",
          title: "正在联网搜索",
        }, threadId, run);
        this.upsertActivity(threadId, run, {
          id: `search-${event.callId}`,
          kind: "search",
          status: "running",
          label: "正在联网搜索",
        });
        return;

      case "web_search/completed":
        this.upsertRuntimeItem({
          id: `search-${event.callId}`,
          turnId,
          kind: "activity",
          activityKind: "searched",
          round: run.round,
          status: "completed",
          title: event.query === undefined
            ? "联网搜索已完成"
            : `已搜索：${event.query}`,
        }, threadId, run);
        this.upsertActivity(threadId, run, {
          id: `search-${event.callId}`,
          kind: "search",
          status: "completed",
          label: event.query === undefined
            ? "联网搜索已完成"
            : `已搜索：${event.query}`,
        });
        return;

      case "citation/url_added":
        this.emit({
          type: "source/added",
          threadId,
          turnId,
          title: event.title,
          url: event.url,
        });
        return;

      case "tool/started":
        this.setTurnState(threadId, run, "running_tool");
        this.upsertRuntimeItem({
          id: `tool-${event.callId}`,
          turnId,
          kind: "activity",
          activityKind: "ran",
          round: run.round,
          status: "running",
          title: `正在运行 ${event.toolName}`,
        }, threadId, run);
        this.upsertActivity(threadId, run, {
          id: `tool-${event.callId}`,
          kind: "tool",
          status: "running",
          label: `正在运行 ${event.toolName}`,
        });
        return;

      case "tool/completed":
        this.upsertRuntimeItem({
          id: `tool-${event.callId}`,
          turnId,
          kind: "activity",
          activityKind: "ran",
          round: run.round,
          status: "completed",
          title: `${event.toolName} 已完成`,
        }, threadId, run);
        this.upsertActivity(threadId, run, {
          id: `tool-${event.callId}`,
          kind: "tool",
          status: "completed",
          label: `${event.toolName} 已完成`,
        });
        return;

      case "permission/requested":
        this.upsertRuntimeItem({
          id: `permission-${event.callId}`,
          turnId,
          kind: "activity",
          activityKind: "permission",
          round: run.round,
          status: "running",
          title: `${event.toolName} 正在请求权限`,
        }, threadId, run);
        this.upsertActivity(threadId, run, {
          id: `permission-${event.callId}`,
          kind: "permission",
          status: "running",
          label: `${event.toolName} 正在请求权限`,
        });
        return;

      case "permission/decided":
        this.upsertRuntimeItem({
          id: `permission-${event.callId}`,
          turnId,
          kind: "activity",
          activityKind: "permission",
          round: run.round,
          status: "completed",
          title: event.decision === "allow"
            ? `${event.toolName} 已获授权`
            : `${event.toolName} 已安全拒绝`,
        }, threadId, run);
        this.upsertActivity(threadId, run, {
          id: `permission-${event.callId}`,
          kind: "permission",
          status: event.decision === "allow" ? "completed" : "denied",
          label: event.decision === "allow"
            ? `${event.toolName} 已获授权`
            : `${event.toolName} 已安全拒绝`,
        });
        return;

      case "model/output_text_delta":
        this.setTurnState(threadId, run, "answering");
        this.appendRuntimeMarkdown({
          id: `output-${event.round}`,
          turnId,
          kind: "pending_output",
          round: event.round,
          status: "streaming",
        }, event.delta, threadId, run);
        return;

      case "model/output_text_completed":
        this.upsertRuntimeItem({
          id: `output-${event.round}`,
          turnId,
          kind: event.classification,
          round: event.round,
          status: "completed",
          markdown: event.text,
        }, threadId, run);
        return;

      case "turn/interrupted":
        this.finishRuntimeSession(threadId, run, "cancelled", "cancelled");
        this.setTurnState(threadId, run, "cancelled", "Turn 已取消");
        return;

      case "turn/timed_out":
        this.finishRuntimeSession(threadId, run, "timed_out", "failed");
        this.upsertRuntimeItem({
          id: "safe-timeout",
          turnId,
          kind: "error",
          code: "turn_timed_out",
          title: "本轮等待超时",
          safeMessage: "对话过程和已生成文件已保留。可发送“继续完成刚才的任务”，或新建任务重新开始。",
          retryable: true,
        }, threadId, run);
        this.setTurnState(threadId, run, "timed_out", "本轮等待超时，进度已保存，可继续");
        return;

      case "turn/failed":
        this.finishRuntimeSession(threadId, run, "failed", "failed");
        this.upsertRuntimeItem({
          id: "safe-error",
          turnId,
          kind: "error",
          code: "agent_failed",
          title: "请求未能完成",
          safeMessage: "Agent 执行失败，请重试",
          retryable: true,
        }, threadId, run);
        this.setTurnState(threadId, run, "failed", "Agent 执行失败，请重试");
        return;

      case "turn/started":
        return;

      case "turn/completed":
        this.finishRuntimeSession(threadId, run, "completed", "completed");
        return;
    }
  }

  private setTurnState(
    threadId: string,
    run: DesktopThreadRun,
    state: DesktopTurnState,
    message?: string,
  ): void {
    run.state = state;
    this.emit({
      type: "turn/state",
      threadId,
      turnId: run.turnId,
      state,
      ...(message === undefined ? {} : { message }),
    });
  }

  private upsertActivity(
    threadId: string,
    run: DesktopThreadRun,
    activity: Extract<DesktopEvent, {
      type: "activity/upsert";
    }>["activity"],
  ): void {
    this.emit({
      type: "activity/upsert",
      threadId,
      turnId: run.turnId,
      activity,
    });
  }

  private appendRuntimeMarkdown(
    base: Omit<Extract<RuntimeContent, {
      kind: "pending_output";
    }>, "markdown">,
    delta: string,
    threadId: string,
    run: DesktopThreadRun,
  ): void {
    const existing = run.session.items.find(
      (item) => item.id === base.id,
    );
    const markdown =
      existing !== undefined && "markdown" in existing
        ? existing.markdown + delta
        : delta;
    this.upsertRuntimeItem({ ...base, markdown } as RuntimeContent, threadId, run);
  }

  private completeReasoningForRound(
    threadId: string,
    run: DesktopThreadRun,
    round: number,
  ): void {
    const session = run.session;

    session.items = session.items.map((item) =>
      item.kind === "reasoning_summary" && item.round === round
        ? { ...item, status: "completed" }
        : item,
    );
    this.emitRuntimeSession(threadId, run);
  }

  private upsertRuntimeItem(
    item: RuntimeContent,
    threadId: string,
    run: DesktopThreadRun,
  ): void {
    run.session.items = upsertRuntimeContent(
      run.session.items,
      item,
    );
    this.emitRuntimeSession(threadId, run);
  }

  private finishRuntimeSession(
    threadId: string,
    run: DesktopThreadRun,
    status: RuntimeSessionStatus,
    runningStatus: RuntimeActivity["status"],
  ): void {
    const session = run.session;

    session.status = status;
    session.completedAt = new Date().toISOString();
    session.items = session.items.map((item) => {
      if (item.kind === "pending_output") {
        return {
          id: item.id,
          turnId: item.turnId,
          kind: "commentary" as const,
          round: item.round,
          status: "completed" as const,
          markdown: item.markdown,
        };
      }
      if (item.kind === "activity" && item.status === "running") {
        return { ...item, status: runningStatus };
      }
      if (item.kind === "reasoning_summary" && item.status === "streaming") {
        return { ...item, status: "completed" };
      }
      return item;
    });
    this.emitRuntimeSession(threadId, run);
  }

  private emitRuntimeSession(threadId: string, run: DesktopThreadRun): void {
    this.emit({
      type: "runtime/session",
      threadId,
      session: cloneRuntimeSession(run.session),
    });
    void this.runtime.setRuntimeSession(
      threadId,
      run.state,
      cloneRuntimeSession(run.session),
    ).catch(() => undefined);
  }

  private emit(event: DesktopEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private getDefaultConfig(): DesktopAgentConfig {
    return {
      model: this.capabilities.currentModel ?? this.capabilities.models[0]?.id ?? "",
      reasoningEffort: "high",
      agentProfileId: "orchestrator",
      agentTeam: normalizeAgentTeamConfig(DEFAULT_AGENT_TEAM_CONFIG),
    };
  }

  private getActiveConfig(): DesktopAgentConfig {
    if (this.activeThreadId === undefined) {
      this.draftConfig ??= this.getDefaultConfig();
      return this.draftConfig;
    }
    const existing = this.configsByThread.get(this.activeThreadId);
    if (existing !== undefined) return existing;
    const config = this.getDefaultConfig();
    this.configsByThread.set(this.activeThreadId, config);
    return config;
  }

  private async persistActiveConfig(config: DesktopAgentConfig): Promise<void> {
    if (this.activeThreadId !== undefined) {
      await this.runtime.setThreadConfig(this.activeThreadId, config);
    }
  }

}

function toThreadSummary(
  history: ThreadHistoryResult,
  turnState: DesktopTurnState,
  config: DesktopAgentConfig,
): DesktopThreadSummary {
  const firstUserMessage = history.messages.find(
    (message) => message.role === "user",
  );

  return {
    id: history.thread.id,
    title: history.thread.title ?? (firstUserMessage === undefined
      ? "新任务"
      : createThreadTitle(firstUserMessage.text)),
    status: history.thread.status,
    createdAt: history.thread.createdAt,
    lastActivityAt: history.thread.lastActivityAt ?? history.messages.at(-1)?.createdAt ?? history.thread.createdAt,
    messageCount: history.messages.length,
    turnState,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
  };
}

function filterCurrentJobRuns(runs: import("../agents/agent-run.js").AgentRun[], turnId?: string) {
  const root = turnId === undefined
    ? runs.filter((run) => run.parentRunId === undefined).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    : runs.find((run) => run.turnId === turnId && run.parentRunId === undefined);
  return root === undefined ? [] : runs.filter((run) => run.jobId === root.jobId);
}

function createThreadTitle(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();

  if ([...normalized].length <= MAX_TITLE_CHARACTERS) {
    return normalized;
  }

  return `${[...normalized].slice(0, MAX_TITLE_CHARACTERS).join("")}…`;
}

function requireInput(value: string): string {
  if (typeof value !== "string") {
    throw new Error("消息必须是文本");
  }

  const text = value.trim();

  if (text.length === 0) {
    throw new Error("请输入任务内容");
  }

  if ([...text].length > MAX_INPUT_CHARACTERS) {
    throw new Error("消息过长，请缩短后重试");
  }

  return text;
}

function normalizeMessageContext(
  input: DesktopMessageInput,
  capabilities: RuntimeCapabilities,
): Omit<DesktopMessageInput, "text"> {
  const mentions = [...new Map((input.mentions ?? []).map((mention) => {
    if (mention.kind !== "file" || typeof mention.path !== "string" ||
      mention.path.trim().length === 0 || mention.path.length > 500) {
      throw new Error("Invalid workspace file mention");
    }
    return [mention.path, { kind: "file" as const, path: mention.path }];
  })).values()];
  const availableSkills = new Set(capabilities.skills.map((skill) => skill.name));
  const explicitSkills = [...new Set(input.explicitSkills ?? [])];
  if (mentions.length > 20 || explicitSkills.length > 20 ||
    explicitSkills.some((name) => typeof name !== "string" || !availableSkills.has(name))) {
    throw new Error("Invalid explicit message context");
  }
  return {
    ...(mentions.length === 0 ? {} : { mentions }),
    ...(explicitSkills.length === 0 ? {} : { explicitSkills }),
  };
}

function toDesktopMessage(item: TurnStartResult["userMessage"]): DesktopMessage {
  return {
    id: item.id,
    turnId: item.turnId,
    role: "user",
    text: readItemText(item.content),
    createdAt: item.createdAt,
  };
}

function readItemText(value: unknown): string {
  if (
    typeof value !== "object" ||
    value === null ||
    !("text" in value) ||
    typeof value.text !== "string"
  ) {
    throw new Error("Message Item has no text");
  }

  return value.text;
}

function cloneCapabilities(
  capabilities: RuntimeCapabilities,
): RuntimeCapabilities {
  return {
    llm: capabilities.llm,
    ...(capabilities.currentModel === undefined
      ? {}
      : { currentModel: capabilities.currentModel }),
    models: capabilities.models.map((model) => ({ ...model })),
    webSearch: capabilities.webSearch,
    tools: capabilities.tools.map((tool) => ({ ...tool })),
    skills: capabilities.skills.map((skill) => ({ ...skill })),
    mcpServers: capabilities.mcpServers.map((server) => ({ ...server })),
    ...(capabilities.agents === undefined ? {} : { agents: capabilities.agents.map((agent) => ({ ...agent })) }),
    ...(capabilities.multiAgent === undefined ? {} : { multiAgent: { ...capabilities.multiAgent } }),
  };
}

function isCancellationTerminal(
  state: DesktopTurnState,
): boolean {
  return state === "cancelled" || state === "timed_out";
}

function isRunningState(state: DesktopTurnState): boolean {
  return [
    "starting",
    "thinking",
    "searching",
    "running_tool",
    "answering",
    "cancelling",
  ].includes(state);
}

function readLatestRound(session: RuntimeSession): number {
  return session.items.reduce((latest, item) =>
    "round" in item ? Math.max(latest, item.round) : latest, 0);
}
