const {
  contextBridge,
  ipcRenderer,
} = require("electron");

const GET_RUNTIME_STATUS_CHANNEL = "runtime:get-status";
const RUNTIME_STATUS_CHANGED_CHANNEL =
  "runtime:status-changed";
const DESKTOP_GET_SNAPSHOT_CHANNEL = "desktop:get-snapshot";
const DESKTOP_RESOLVE_OUTCOME_UNKNOWN_CHANNEL = "desktop:resolve-outcome-unknown";
const DESKTOP_CREATE_THREAD_CHANNEL = "desktop:create-thread";
const DESKTOP_SELECT_THREAD_CHANNEL = "desktop:select-thread";
const DESKTOP_SELECT_AGENT_THREAD_CHANNEL = "desktop:select-agent-thread";
const DESKTOP_CONFIRM_REQUIREMENT_CHANNEL = "desktop:confirm-requirement";
const DESKTOP_CONFIRM_DESIGN_CHANNEL = "desktop:confirm-design";
const DESKTOP_DESIGN_FEEDBACK_CHANNEL = "desktop:design-feedback";
const DESKTOP_ENGINEERING_REWORK_CHANNEL = "desktop:engineering-rework";
const DESKTOP_ADVANCE_FIXED_PRODUCT_CHANNEL = "desktop:advance-fixed-product";
const DESKTOP_OPEN_PLAN_CHANNEL = "desktop:open-plan";
const PREVIEW_GET_STATUS_CHANNEL = "preview:get-status";
const PREVIEW_START_CHANNEL = "preview:start";
const PREVIEW_STOP_CHANNEL = "preview:stop";
const PREVIEW_OPEN_EXTERNAL_CHANNEL = "preview:open-external";
const BROWSER_GET_STATE_CHANNEL = "browser:get-state";
const BROWSER_CREATE_TAB_CHANNEL = "browser:create-tab";
const BROWSER_CLOSE_TAB_CHANNEL = "browser:close-tab";
const BROWSER_ACTIVATE_TAB_CHANNEL = "browser:activate-tab";
const BROWSER_NAVIGATE_CHANNEL = "browser:navigate";
const BROWSER_GO_BACK_CHANNEL = "browser:go-back";
const BROWSER_GO_FORWARD_CHANNEL = "browser:go-forward";
const BROWSER_RELOAD_CHANNEL = "browser:reload";
const BROWSER_STOP_CHANNEL = "browser:stop";
const BROWSER_OPEN_EXTERNAL_CHANNEL = "browser:open-external";
const BROWSER_SET_BOUNDS_CHANNEL = "browser:set-bounds";
const BROWSER_STATE_CHANGED_CHANNEL = "browser:state-changed";
const BROWSER_COMMAND_CHANNEL = "browser:command";
const DESKTOP_SEND_MESSAGE_CHANNEL = "desktop:send-message";
const DESKTOP_SEARCH_WORKSPACE_FILES_CHANNEL = "desktop:search-workspace-files";
const DESKTOP_CANCEL_TURN_CHANNEL = "desktop:cancel-turn";
const DESKTOP_SELECT_MODEL_CHANNEL = "desktop:select-model";
const DESKTOP_SELECT_REASONING_CHANNEL = "desktop:select-reasoning";
const DESKTOP_SELECT_MODEL_SETTINGS_CHANNEL = "desktop:select-model-settings";
const DESKTOP_UPDATE_AGENT_TEAM_CHANNEL = "desktop:update-agent-team";
const DESKTOP_RENAME_THREAD_CHANNEL = "desktop:rename-thread";
const DESKTOP_DELETE_THREADS_CHANNEL = "desktop:delete-threads";
const DESKTOP_RESTORE_THREAD_CHANNEL = "desktop:restore-thread";
const DESKTOP_PERMISSION_REQUESTED_CHANNEL = "desktop:permission-requested";
const DESKTOP_RESPOND_PERMISSION_CHANNEL = "desktop:respond-permission";
const DESKTOP_EVENT_CHANNEL = "desktop:event";

const SAFE_STATUS_BY_STATE = Object.freeze({
  connecting: Object.freeze({
    state: "connecting",
    message: "Runtime 正在连接…",
  }),
  connected: Object.freeze({
    state: "connected",
    message: "Runtime 已连接",
  }),
  closed: Object.freeze({
    state: "closed",
    message: "Runtime 已关闭",
  }),
});
const SAFE_FAILURE_MESSAGES = Object.freeze({
  start_failed: "Runtime 启动失败，请关闭后重试",
  handshake_failed: "Runtime 连接失败，请关闭后重试",
  unexpected_exit: "Runtime 意外关闭，请关闭后重试",
});
const SAFE_FALLBACK_STATUS = Object.freeze({
  state: "failed",
  code: "handshake_failed",
  message: SAFE_FAILURE_MESSAGES.handshake_failed,
});

/**
 * Preload 再做一次白名单校验，Renderer 永远拿不到任意 IPC Payload。
 */
function sanitizeRuntimeStatus(value) {
  if (
    value !== null &&
    typeof value === "object" &&
    Object.hasOwn(SAFE_STATUS_BY_STATE, value.state)
  ) {
    return SAFE_STATUS_BY_STATE[value.state];
  }

  if (
    value !== null &&
    typeof value === "object" &&
    value.state === "failed" &&
    [
      "start_failed",
      "handshake_failed",
      "unexpected_exit",
    ].includes(value.code)
  ) {
    return Object.freeze({
      state: "failed",
      code: value.code,
      message: SAFE_FAILURE_MESSAGES[value.code],
    });
  }

  return SAFE_FALLBACK_STATUS;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeText(value, maxLength = 32_000) {
  return typeof value === "string"
    ? value.slice(0, maxLength)
    : "";
}

function sanitizeSnapshot(value) {
  if (!isRecord(value)) {
    throw new Error("桌面会话数据无效");
  }

  const threads = Array.isArray(value.threads)
    ? value.threads.flatMap((thread) => {
        if (
          !isRecord(thread) ||
          typeof thread.id !== "string" ||
          (thread.status !== "active" && thread.status !== "closed") ||
          typeof thread.createdAt !== "string" ||
          !Number.isInteger(thread.messageCount)
        ) {
          return [];
        }

        return [{
          id: safeText(thread.id, 200),
          title: safeText(thread.title, 160) || "新任务",
          status: thread.status,
          createdAt: safeText(thread.createdAt, 80),
          lastActivityAt: safeText(thread.lastActivityAt, 80) || safeText(thread.createdAt, 80),
          messageCount: Math.max(0, thread.messageCount),
          turnState: [
            "idle", "starting", "thinking", "searching", "running_tool",
            "answering", "cancelling", "completed", "failed", "cancelled",
            "timed_out",
          ].includes(thread.turnState) ? thread.turnState : "idle",
          model: safeText(thread.model, 120),
          reasoningEffort: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
            .includes(thread.reasoningEffort) ? thread.reasoningEffort : "high",
        }];
      })
    : [];
  const messages = Array.isArray(value.messages)
    ? value.messages.flatMap((message) => {
        if (
          !isRecord(message) ||
          typeof message.id !== "string" ||
          typeof message.turnId !== "string" ||
          (message.role !== "user" && message.role !== "assistant") ||
          typeof message.text !== "string" ||
          typeof message.createdAt !== "string"
        ) {
          return [];
        }

        return [{
          id: safeText(message.id, 200),
          turnId: safeText(message.turnId, 200),
          role: message.role,
          text: safeText(message.text),
          createdAt: safeText(message.createdAt, 80),
        }];
      })
    : [];

  const runtimeSession = sanitizeRuntimeSession(value.runtimeSession);

  return Object.freeze({
    threads,
    ...(typeof value.activeThreadId === "string"
      ? { activeThreadId: safeText(value.activeThreadId, 200) }
      : {}),
    ...(typeof value.activeAgentThreadId === "string"
      ? { activeAgentThreadId: safeText(value.activeAgentThreadId, 200) }
      : {}),
    messages,
    capabilities: sanitizeCapabilities(value.capabilities),
    turnState: [
      "idle", "starting", "thinking", "searching", "running_tool",
      "answering", "cancelling", "completed", "failed", "cancelled",
      "timed_out",
    ].includes(value.turnState) ? value.turnState : "idle",
    ...(runtimeSession === undefined ? {} : { runtimeSession }),
    agentConfig: sanitizeAgentConfig(value.agentConfig, value.capabilities),
    agentRuns: Array.isArray(value.agentRuns)
      ? value.agentRuns.slice(0, 100).flatMap(sanitizeAgentRun)
      : [],
    trash: Array.isArray(value.trash) ? value.trash.slice(0, 500).flatMap((thread) => isRecord(thread) && typeof thread.id === "string" && typeof thread.deletedAt === "string" && typeof thread.trashExpiresAt === "string" ? [{ id: safeText(thread.id, 200), title: safeText(thread.title, 160) || "未命名 Chat", deletedAt: safeText(thread.deletedAt, 80), trashExpiresAt: safeText(thread.trashExpiresAt, 80), ...(typeof thread.deleteBatchId === "string" ? { deleteBatchId: safeText(thread.deleteBatchId, 200) } : {}) }] : []) : [],
    ...(isRecord(value.agentRuntime) ? { agentRuntime: sanitizeAgentRuntime(value.agentRuntime) } : {}),
    ...(isRecord(value.requirement) ? { requirement: JSON.parse(JSON.stringify(value.requirement)) } : {}),
    outcomeUnknownInvocations: Array.isArray(value.outcomeUnknownInvocations)
      ? value.outcomeUnknownInvocations.slice(0, 200).flatMap((record) => {
          const safe = sanitizeOutcomeUnknownResolution(record);
          return safe === undefined ? [] : [safe];
        })
      : [],
  });
}

function sanitizeOutcomeUnknownResolution(value) {
  const states = ["outcome_unknown", "retry_authorized", "external_result_recorded", "manual_required", "abandoned"];
  if (!isRecord(value) || typeof value.resolutionId !== "string" ||
    !["model", "tool"].includes(value.invocationKind) || typeof value.invocationId !== "string" ||
    typeof value.requestDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.requestDigest) ||
    !isRecord(value.identity) || typeof value.identity.threadId !== "string" ||
    typeof value.identity.turnId !== "string" || typeof value.identity.displayName !== "string" ||
    !["none", "possible", "known"].includes(value.sideEffectRisk) || !states.includes(value.state) ||
    !Number.isInteger(value.version) || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") return undefined;
  const identity = {
    threadId: safeText(value.identity.threadId, 200),
    turnId: safeText(value.identity.turnId, 200),
    displayName: safeText(value.identity.displayName, 500),
    ...(typeof value.identity.provider === "string" ? { provider: safeText(value.identity.provider, 120) } : {}),
    ...(typeof value.identity.model === "string" ? { model: safeText(value.identity.model, 120) } : {}),
    ...(typeof value.identity.toolName === "string" ? { toolName: safeText(value.identity.toolName, 120) } : {}),
    ...(typeof value.identity.callId === "string" ? { callId: safeText(value.identity.callId, 200) } : {}),
  };
  const audit = Array.isArray(value.audit) ? value.audit.slice(-100).flatMap((item) =>
    isRecord(item) && typeof item.id === "string" &&
      ["confirm_not_executed_retry", "record_external_result", "mark_manual_required", "abandon"].includes(item.action) &&
      typeof item.actorId === "string" && typeof item.reason === "string" && states.includes(item.fromState) &&
      states.includes(item.toState) && Number.isInteger(item.version) && typeof item.occurredAt === "string"
      ? [{
          id: safeText(item.id, 200), action: item.action, actorId: safeText(item.actorId, 200),
          reason: safeText(item.reason, 2_000), fromState: item.fromState, toState: item.toState,
          version: item.version, occurredAt: safeText(item.occurredAt, 80),
        }]
      : []) : [];
  return {
    resolutionId: safeText(value.resolutionId, 200), invocationKind: value.invocationKind,
    invocationId: safeText(value.invocationId, 200), requestDigest: value.requestDigest,
    identity, sideEffectRisk: value.sideEffectRisk, state: value.state, version: value.version,
    ...(typeof value.unknownReasonCode === "string" ? { unknownReasonCode: safeText(value.unknownReasonCode, 200) } : {}),
    ...(isRecord(value.externalResult) && typeof value.externalResult.summary === "string"
      ? { externalResult: { summary: safeText(value.externalResult.summary, 2_000), value: sanitizeJsonValue(value.externalResult.value) } }
      : {}),
    ...(isRecord(value.retryTicket) && typeof value.retryTicket.id === "string" && value.retryTicket.automaticReplay === false
      ? { retryTicket: { id: safeText(value.retryTicket.id, 200), automaticReplay: false } }
      : {}),
    createdAt: safeText(value.createdAt, 80), updatedAt: safeText(value.updatedAt, 80), audit,
  };
}

function sanitizeJsonValue(value) {
  const text = JSON.stringify(value);
  if (text === undefined || text.length > 256_000) throw new TypeError("JSON value is too large");
  return JSON.parse(text);
}

function sanitizeAgentRuntime(value) {
  const clean = (item) => JSON.parse(JSON.stringify(item, (_key, nested) => typeof nested === "string" ? safeText(nested, 8000) : nested));
  return {
    ...(isRecord(value.job) ? { job: clean(value.job) } : {}),
    tasks: Array.isArray(value.tasks) ? value.tasks.slice(0, 100).map(clean) : [],
    edges: Array.isArray(value.edges) ? value.edges.slice(0, 300).map(clean) : [],
    evidence: Array.isArray(value.evidence) ? value.evidence.slice(0, 500).map(clean) : [],
    board: Array.isArray(value.board) ? value.board.slice(0, 500).map(clean) : [],
    returns: Array.isArray(value.returns) ? value.returns.slice(0, 100).map(clean) : [],
    ...(["ready_first_return", "first_return_ready", "rework", "second_return_ready", "engineering_ready", "engineering_return_ready", "quality_ready", "quality_return_ready", "lead_return_ready", "completed", "product_design_ready", "mock_preview_ready", "design_confirmation", "engineering_fanout", "engineering_fanout_ready", "integration_review", "quality_review", "lead_acceptance"].includes(value.fixedProductStage) ? { fixedProductStage: value.fixedProductStage } : {}),
  };
}

function sanitizeAgentRun(value) {
  const statuses = [
    "queued", "running", "waiting_children", "resuming",
    "completed", "failed", "cancelled", "timed_out",
  ];
  if (!isRecord(value) || typeof value.id !== "string" ||
    typeof value.threadId !== "string" || typeof value.turnId !== "string" ||
    typeof value.agentProfileId !== "string" || !statuses.includes(value.status) ||
    typeof value.task !== "string" || !Number.isInteger(value.depth)) {
    return [];
  }
  return [{
    id: safeText(value.id, 200),
    jobId: safeText(value.jobId, 200),
    rootRunId: safeText(value.rootRunId, 200),
    ...(typeof value.taskId === "string" ? { taskId: safeText(value.taskId, 200) } : {}),
    attempt: Number.isInteger(value.attempt) ? Math.max(1, value.attempt) : 1,
    threadId: safeText(value.threadId, 200),
    turnId: safeText(value.turnId, 200),
    agentProfileId: safeText(value.agentProfileId, 120),
    ...(typeof value.parentRunId === "string"
      ? { parentRunId: safeText(value.parentRunId, 200) }
      : {}),
    status: value.status,
    task: safeText(value.task, 8_000),
    depth: Math.max(0, value.depth),
    ...(typeof value.safeError === "string"
      ? { safeError: safeText(value.safeError, 1_000) }
      : {}),
  }];
}

function sanitizeAgentConfig(value, capabilities) {
  const fallbackModel = isRecord(capabilities) && typeof capabilities.currentModel === "string"
    ? safeText(capabilities.currentModel, 120)
    : "";
  return Object.freeze({
    model: isRecord(value) ? safeText(value.model, 120) || fallbackModel : fallbackModel,
    reasoningEffort: isRecord(value) &&
      ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(value.reasoningEffort)
      ? value.reasoningEffort : "high",
    agentProfileId: isRecord(value) ? safeText(value.agentProfileId, 120) || "orchestrator" : "orchestrator",
    agentTeam: sanitizeAgentTeam(isRecord(value) ? value.agentTeam : undefined),
  });
}

function sanitizeAgentTeam(value) {
  const maxSubagents = isRecord(value) && Number.isInteger(value.maxSubagents) ? Math.max(1, Math.min(10, value.maxSubagents)) : 10;
  return {
    version: 1, mode: isRecord(value) && ["off", "auto", "manual"].includes(value.mode) ? value.mode : "auto",
    maxSubagents, maxConcurrent: isRecord(value) && Number.isInteger(value.maxConcurrent) ? Math.max(1, Math.min(maxSubagents, value.maxConcurrent)) : Math.min(4, maxSubagents),
    maxDepth: isRecord(value) && Number.isInteger(value.maxDepth) ? Math.max(1, Math.min(3, value.maxDepth)) : 3,
    allowedProfiles: isRecord(value) && Array.isArray(value.allowedProfiles) ? value.allowedProfiles.filter((item) => ["investigator", "researcher", "coder", "tester", "reviewer"].includes(item)) : ["investigator", "researcher", "coder", "tester", "reviewer"],
    scheduling: isRecord(value) && value.scheduling === "independent_only" ? "independent_only" : "dependency_graph",
    accessMode: isRecord(value) && ["read_only", "workspace", "full_access"].includes(value.accessMode) ? value.accessMode : "workspace",
    permissionMode: isRecord(value) && value.permissionMode === "inherit_chat" ? "inherit_chat" : "least_privilege",
    shareBoard: !isRecord(value) || value.shareBoard !== false, independentReview: !isRecord(value) || value.independentReview !== false,
    modelRouting: isRecord(value) && value.modelRouting === "role_based" ? "role_based" : "inherit_chat",
    allowedTools: isRecord(value) && Array.isArray(value.allowedTools) ? value.allowedTools.filter((item) => typeof item === "string").slice(0, 100) : ["*"],
    allowedSkills: isRecord(value) && Array.isArray(value.allowedSkills) ? value.allowedSkills.filter((item) => typeof item === "string").slice(0, 100) : ["*"],
  };
}

function sanitizeCapabilities(value) {
  if (!isRecord(value)) {
    return Object.freeze({
      llm: false,
      models: [],
      webSearch: false,
      tools: [],
      skills: [],
      mcpServers: [],
    });
  }

  const tools = Array.isArray(value.tools)
    ? value.tools.flatMap((tool) =>
        isRecord(tool) &&
        typeof tool.name === "string" &&
        typeof tool.description === "string" &&
        ["builtin", "workspace", "mcp"].includes(tool.source)
          ? [{
              name: safeText(tool.name, 120),
              description: safeText(tool.description, 500),
              source: tool.source,
            }]
          : [],
      )
    : [];
  const models = Array.isArray(value.models)
    ? value.models.flatMap((model) =>
        isRecord(model) && typeof model.id === "string" && typeof model.label === "string"
          ? [{
              id: safeText(model.id, 120),
              label: safeText(model.label, 120),
              reasoningEfforts: Array.isArray(model.reasoningEfforts)
                ? model.reasoningEfforts.filter((item) =>
                    ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(item))
                : [],
            }]
          : [],
      )
    : [];
  const skills = Array.isArray(value.skills)
    ? value.skills.flatMap((skill) =>
        isRecord(skill) &&
        typeof skill.name === "string" &&
        typeof skill.description === "string"
          ? [{
              name: safeText(skill.name, 120),
              description: safeText(skill.description, 500),
            }]
          : [],
      )
    : [];
  const mcpServers = Array.isArray(value.mcpServers)
    ? value.mcpServers.flatMap((server) =>
        isRecord(server) &&
        typeof server.name === "string" &&
        typeof server.protocolVersion === "string" &&
        Number.isInteger(server.toolCount)
          ? [{
              name: safeText(server.name, 120),
              protocolVersion: safeText(server.protocolVersion, 80),
              toolCount: Math.max(0, server.toolCount),
            }]
          : [],
      )
    : [];

  return Object.freeze({
    llm: value.llm === true,
    ...(typeof value.currentModel === "string"
      ? { currentModel: safeText(value.currentModel, 120) }
      : {}),
    models,
    webSearch: value.webSearch === true,
    tools,
    skills,
    mcpServers,
    agents: Array.isArray(value.agents) ? value.agents.flatMap((agent) =>
      isRecord(agent) && typeof agent.id === "string" && typeof agent.name === "string"
        ? [{ id: safeText(agent.id, 120), name: safeText(agent.name, 120), description: safeText(agent.description, 500) }]
        : []) : [],
    ...(isRecord(value.multiAgent) ? { multiAgent: {
      maxConcurrentRuns: Number.isInteger(value.multiAgent.maxConcurrentRuns) ? value.multiAgent.maxConcurrentRuns : 1,
      maxDepth: Number.isInteger(value.multiAgent.maxDepth) ? value.multiAgent.maxDepth : 1,
      maxChildrenPerRun: Number.isInteger(value.multiAgent.maxChildrenPerRun) ? value.multiAgent.maxChildrenPerRun : 1,
    } } : {}),
  });
}

function sanitizeDesktopEvent(value) {
  if (!isRecord(value) || typeof value.type !== "string") {
    return undefined;
  }

  if (value.type === "agent/run_updated") {
    const [run] = sanitizeAgentRun(value.run);
    return run === undefined ? undefined : {
      type: value.type,
      threadId: safeText(value.threadId, 200),
      turnId: safeText(value.turnId, 200),
      run,
    };
  }

  if (value.type === "runtime/session") {
    const session = sanitizeRuntimeSession(value.session);
    return session === undefined
      ? undefined
      : {
          type: value.type,
          threadId: safeText(value.threadId, 200),
          session,
        };
  }

  if (value.type === "message/user" && isRecord(value.message)) {
    return {
      type: value.type,
      threadId: safeText(value.threadId, 200),
      message: {
        id: safeText(value.message.id, 200),
        turnId: safeText(value.message.turnId, 200),
        role: "user",
        text: safeText(value.message.text),
        createdAt: safeText(value.message.createdAt, 80),
      },
    };
  }

  if (value.type === "thread/updated" && isRecord(value.thread)) {
    return {
      type: value.type,
      thread: {
        id: safeText(value.thread.id, 200),
        title: safeText(value.thread.title, 160) || "新任务",
        status: value.thread.status === "closed" ? "closed" : "active",
        createdAt: safeText(value.thread.createdAt, 80),
        messageCount: Number.isInteger(value.thread.messageCount)
          ? Math.max(0, value.thread.messageCount)
          : 0,
        turnState: [
          "idle", "starting", "thinking", "searching", "running_tool",
          "answering", "cancelling", "completed", "failed", "cancelled",
          "timed_out",
        ].includes(value.thread.turnState) ? value.thread.turnState : "idle",
        model: safeText(value.thread.model, 120),
        reasoningEffort: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
          .includes(value.thread.reasoningEffort) ? value.thread.reasoningEffort : "high",
      },
    };
  }

  if (value.type === "assistant/delta" || value.type === "assistant/completed") {
    return {
      type: value.type,
      threadId: safeText(value.threadId, 200),
      turnId: safeText(value.turnId, 200),
      ...(value.type === "assistant/delta"
        ? { delta: safeText(value.delta) }
        : { text: safeText(value.text) }),
    };
  }

  if (value.type === "reasoning/delta") {
    return {
      type: value.type,
      threadId: safeText(value.threadId, 200),
      turnId: safeText(value.turnId, 200),
      summaryIndex: Number.isInteger(value.summaryIndex) ? value.summaryIndex : 0,
      delta: safeText(value.delta),
    };
  }

  if (value.type === "activity/upsert" && isRecord(value.activity)) {
    return {
      type: value.type,
      threadId: safeText(value.threadId, 200),
      turnId: safeText(value.turnId, 200),
      activity: {
        id: safeText(value.activity.id, 200),
        kind: ["thinking", "tool", "search", "permission", "context"].includes(value.activity.kind)
          ? value.activity.kind
          : "thinking",
        status: ["running", "completed", "denied"].includes(value.activity.status)
          ? value.activity.status
          : "running",
        label: safeText(value.activity.label, 500),
      },
    };
  }

  if (value.type === "source/added") {
    return {
      type: value.type,
      threadId: safeText(value.threadId, 200),
      turnId: safeText(value.turnId, 200),
      title: safeText(value.title, 500),
      url: safeText(value.url, 2_000),
    };
  }

  if (value.type === "turn/state") {
    const states = [
      "idle", "starting", "thinking", "searching", "running_tool",
      "answering", "cancelling", "completed", "failed", "cancelled",
      "timed_out",
    ];
    return {
      type: value.type,
      threadId: safeText(value.threadId, 200),
      turnId: safeText(value.turnId, 200),
      state: states.includes(value.state) ? value.state : "failed",
      ...(typeof value.message === "string"
        ? { message: safeText(value.message, 500) }
        : {}),
    };
  }

  return undefined;
}

function sanitizeRuntimeSession(value) {
  if (
    !isRecord(value) ||
    typeof value.turnId !== "string" ||
    !["running", "completed", "failed", "cancelled", "timed_out"]
      .includes(value.status) ||
    typeof value.startedAt !== "string" ||
    !Array.isArray(value.items)
  ) {
    return undefined;
  }

  const items = value.items.slice(0, 500).flatMap(sanitizeRuntimeContent);
  return {
    turnId: safeText(value.turnId, 200),
    ...(typeof value.threadId === "string" ? { threadId: safeText(value.threadId, 200) } : {}),
    ...(typeof value.jobId === "string" ? { jobId: safeText(value.jobId, 200) } : {}),
    ...(typeof value.agentId === "string" ? { agentId: safeText(value.agentId, 200) } : {}),
    ...(typeof value.agentName === "string" ? { agentName: safeText(value.agentName, 120) } : {}),
    ...(typeof value.taskId === "string" ? { taskId: safeText(value.taskId, 200) } : {}),
    ...(typeof value.taskTitle === "string" ? { taskTitle: safeText(value.taskTitle, 500) } : {}),
    ...(typeof value.threadId === "string" ? { threadId: safeText(value.threadId, 200) } : {}),
    ...(typeof value.agentName === "string" ? { agentName: safeText(value.agentName, 120) } : {}),
    status: value.status,
    startedAt: safeText(value.startedAt, 80),
    ...(typeof value.completedAt === "string"
      ? { completedAt: safeText(value.completedAt, 80) }
      : {}),
    items,
  };
}

function sanitizeRuntimeContent(value) {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.turnId !== "string" ||
    typeof value.kind !== "string"
  ) {
    return [];
  }

  const base = {
    id: safeText(value.id, 200),
    turnId: safeText(value.turnId, 200),
  };
  if (["pending_output", "commentary", "assistant"].includes(value.kind)) {
    if (!Number.isInteger(value.round) || typeof value.markdown !== "string") {
      return [];
    }
    return [{
      ...base,
      kind: value.kind,
      round: Math.max(0, value.round),
      status: value.kind === "pending_output" ? "streaming" : "completed",
      markdown: safeText(value.markdown),
    }];
  }

  if (value.kind === "reasoning_summary") {
    if (!Number.isInteger(value.round) || !Number.isInteger(value.summaryIndex)) {
      return [];
    }
    return [{
      ...base,
      kind: value.kind,
      round: Math.max(0, value.round),
      summaryIndex: Math.max(0, value.summaryIndex),
      status: value.status === "completed" ? "completed" : "streaming",
      markdown: safeText(value.markdown),
    }];
  }

  if (value.kind === "activity") {
    const activityKinds = [
      "planning", "searched", "read", "ran", "edited", "context", "permission",
    ];
    const statuses = ["running", "completed", "failed", "cancelled"];
    if (!activityKinds.includes(value.activityKind) || !Number.isInteger(value.round)) {
      return [];
    }
    return [{
      ...base,
      kind: value.kind,
      activityKind: value.activityKind,
      round: Math.max(0, value.round),
      status: statuses.includes(value.status) ? value.status : "failed",
      title: safeText(value.title, 500),
      ...(typeof value.summary === "string"
        ? { summary: safeText(value.summary, 2_000) }
        : {}),
      ...(Array.isArray(value.safeDetails)
        ? { safeDetails: value.safeDetails.slice(0, 20).map((item) => safeText(item, 500)) }
        : {}),
    }];
  }

  if (value.kind === "error") {
    return [{
      ...base,
      kind: value.kind,
      code: safeText(value.code, 100),
      title: safeText(value.title, 500),
      safeMessage: safeText(value.safeMessage, 2_000),
      retryable: value.retryable === true,
    }];
  }

  return [];
}

function sanitizePermissionRequest(value) {
  if (
    !isRecord(value) || typeof value.turnId !== "string" ||
    typeof value.callId !== "string" || typeof value.toolName !== "string"
  ) {
    return undefined;
  }
  return {
    turnId: safeText(value.turnId, 200),
    callId: safeText(value.callId, 200),
    toolName: safeText(value.toolName, 120),
    ...(typeof value.description === "string"
      ? { description: safeText(value.description, 500) }
      : {}),
    riskLevel: ["read", "execute", "sensitive"].includes(value.riskLevel)
      ? value.riskLevel
      : "sensitive",
  };
}

async function invoke(channel, ...args) {
  const envelope = await ipcRenderer.invoke(channel, ...args);

  if (!isRecord(envelope) || envelope.ok !== true) {
    throw new Error(
      isRecord(envelope) && typeof envelope.message === "string"
        ? safeText(envelope.message, 500)
        : "桌面操作失败，请稍后重试",
    );
  }

  return envelope.value;
}

function sanitizeMessageInput(value) {
  if (!isRecord(value) || typeof value.text !== "string" ||
    Object.keys(value).some((key) => !["text", "mentions", "explicitSkills"].includes(key))) {
    throw new TypeError("Message input is invalid");
  }
  if (value.text.trim().length === 0 || [...value.text].length > 32_000) {
    throw new TypeError("Message text is empty or too long");
  }
  const mentions = value.mentions === undefined ? [] : value.mentions;
  const explicitSkills = value.explicitSkills === undefined ? [] : value.explicitSkills;
  if (!Array.isArray(mentions) || mentions.length > 20 || !mentions.every((mention) =>
    isRecord(mention) && mention.kind === "file" && typeof mention.path === "string" &&
    mention.path.trim().length > 0 && mention.path.length <= 500 && !/[\u0000-\u001f\u007f]/u.test(mention.path) &&
    Object.keys(mention).every((key) => key === "kind" || key === "path")
  )) throw new TypeError("Message mentions are invalid");
  if (!Array.isArray(explicitSkills) || explicitSkills.length > 20 ||
    !explicitSkills.every((name) => typeof name === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name))) {
    throw new TypeError("Message Skills are invalid");
  }
  return {
    text: value.text,
    ...(mentions.length === 0 ? {} : { mentions: mentions.map((mention) => ({ kind: "file", path: safeText(mention.path, 500) })) }),
    ...(explicitSkills.length === 0 ? {} : { explicitSkills: explicitSkills.map((name) => safeText(name, 200)) }),
  };
}

contextBridge.exposeInMainWorld("godAgent", {
  runtime: {
    getStatus: async () => sanitizeRuntimeStatus(
      await ipcRenderer.invoke(GET_RUNTIME_STATUS_CHANNEL),
    ),
    onStatusChange: (listener) => {
      if (typeof listener !== "function") {
        throw new TypeError("Runtime status listener must be a function");
      }

      const handler = (_event, value) => {
        listener(sanitizeRuntimeStatus(value));
      };

      ipcRenderer.on(RUNTIME_STATUS_CHANGED_CHANNEL, handler);

      // 只返回精确移除当前 Handler 的函数，不暴露 ipcRenderer 本身。
      return () => {
        ipcRenderer.removeListener(
          RUNTIME_STATUS_CHANGED_CHANNEL,
          handler,
        );
      };
    },
  },
  desktop: {
    getSnapshot: async () => sanitizeSnapshot(
      await invoke(DESKTOP_GET_SNAPSHOT_CHANNEL),
    ),
    resolveOutcomeUnknown: async (input) => {
      if (!isRecord(input) || typeof input.resolutionId !== "string" ||
        !Number.isInteger(input.expectedVersion) || typeof input.idempotencyKey !== "string" ||
        !isRecord(input.resolution) || typeof input.resolution.action !== "string" ||
        typeof input.resolution.reason !== "string") throw new TypeError("Invalid outcome-unknown resolution");
      const resolution = input.resolution.action === "record_external_result"
        ? {
            action: "record_external_result",
            reason: safeText(input.resolution.reason, 2_000),
            externalResult: {
              summary: safeText(input.resolution.externalResult?.summary, 2_000),
              value: sanitizeJsonValue(input.resolution.externalResult?.value),
            },
          }
        : input.resolution.action === "confirm_not_executed_retry"
          ? {
              action: "confirm_not_executed_retry",
              reason: safeText(input.resolution.reason, 2_000),
              ...(input.resolution.toolSideEffectConfirmed === true ? { toolSideEffectConfirmed: true } : {}),
            }
          : ["mark_manual_required", "abandon"].includes(input.resolution.action)
            ? { action: input.resolution.action, reason: safeText(input.resolution.reason, 2_000) }
            : undefined;
      if (resolution === undefined) throw new TypeError("Invalid outcome-unknown resolution action");
      const safe = sanitizeOutcomeUnknownResolution(await invoke(DESKTOP_RESOLVE_OUTCOME_UNKNOWN_CHANNEL, {
        resolutionId: safeText(input.resolutionId, 200), expectedVersion: input.expectedVersion,
        idempotencyKey: safeText(input.idempotencyKey, 200), resolution,
      }));
      if (safe === undefined) throw new Error("处置结果无效");
      return safe;
    },
    createThread: async () => sanitizeSnapshot(
      await invoke(DESKTOP_CREATE_THREAD_CHANNEL),
    ),
    selectThread: async (threadId) => {
      if (typeof threadId !== "string") {
        throw new TypeError("Thread id must be a string");
      }
      return sanitizeSnapshot(
        await invoke(DESKTOP_SELECT_THREAD_CHANNEL, threadId),
      );
    },
    selectAgentThread: async (threadId) => sanitizeSnapshot(
      await invoke(DESKTOP_SELECT_AGENT_THREAD_CHANNEL, threadId),
    ),
    confirmRequirement: async () => {
      const value = await invoke(DESKTOP_CONFIRM_REQUIREMENT_CHANNEL);
      if (!isRecord(value) || typeof value.turnId !== "string") throw new Error("确认执行返回无效结果");
      return { turnId: safeText(value.turnId, 200) };
    },
    confirmDesign: async () => sanitizeSnapshot(await invoke(DESKTOP_CONFIRM_DESIGN_CHANNEL)),
    submitDesignFeedback: async (feedback) => {
      if (typeof feedback !== "string" || feedback.trim().length === 0 || feedback.length > 4000) throw new TypeError("Invalid design feedback");
      return sanitizeSnapshot(await invoke(DESKTOP_DESIGN_FEEDBACK_CHANNEL, feedback));
    },
    reworkEngineeringChat: async (taskId, reason) => {
      if (typeof taskId !== "string" || typeof reason !== "string" || reason.length > 4000) throw new TypeError("Invalid engineering rework request");
      return sanitizeSnapshot(await invoke(DESKTOP_ENGINEERING_REWORK_CHANNEL, taskId, reason));
    },
    advanceFixedProduct: async (expectedStage) => {
      const stages = ["ready_first_return", "first_return_ready", "rework", "second_return_ready", "engineering_ready", "engineering_return_ready", "quality_ready", "quality_return_ready", "lead_return_ready", "completed", "product_design_ready", "mock_preview_ready", "design_confirmation", "engineering_fanout", "engineering_fanout_ready", "integration_review", "quality_review", "lead_acceptance"];
      if (typeof expectedStage !== "string" || !stages.includes(expectedStage)) throw new TypeError("Invalid fixed product stage");
      return sanitizeSnapshot(await invoke(DESKTOP_ADVANCE_FIXED_PRODUCT_CHANNEL, expectedStage));
    },
    openPlan: async (path) => {
      if (typeof path !== "string") throw new TypeError("Plan path must be a string");
      return Boolean(await invoke(DESKTOP_OPEN_PLAN_CHANNEL, path));
    },
    sendMessage: async (input) => {
      const safeInput = sanitizeMessageInput(input);
      const value = await invoke(DESKTOP_SEND_MESSAGE_CHANNEL, safeInput);
      if (!isRecord(value) || typeof value.turnId !== "string") {
        throw new Error("桌面操作返回无效结果");
      }
      return { turnId: safeText(value.turnId, 200) };
    },
    searchWorkspaceFiles: async (query) => {
      if (typeof query !== "string" || query.length > 240) throw new TypeError("Query must be a short string");
      const value = await invoke(DESKTOP_SEARCH_WORKSPACE_FILES_CHANNEL, query);
      if (!isRecord(value) || typeof value.query !== "string" || !Array.isArray(value.paths) ||
        !value.paths.every((path) => typeof path === "string") || typeof value.truncated !== "boolean") {
        throw new Error("工作区文件搜索返回无效结果");
      }
      return {
        query: safeText(value.query, 240),
        paths: value.paths.slice(0, 20).map((path) => safeText(path, 500)),
        truncated: value.truncated,
      };
    },
    cancelTurn: async () =>
      Boolean(await invoke(DESKTOP_CANCEL_TURN_CHANNEL)),
    selectModel: async (model) => {
      if (typeof model !== "string") throw new TypeError("Model must be a string");
      return sanitizeSnapshot(await invoke(DESKTOP_SELECT_MODEL_CHANNEL, model));
    },
    selectReasoningEffort: async (effort) => {
      if (typeof effort !== "string") throw new TypeError("Effort must be a string");
      return sanitizeSnapshot(await invoke(DESKTOP_SELECT_REASONING_CHANNEL, effort));
    },
    selectModelSettings: async (settings) => {
      if (
        !isRecord(settings) || typeof settings.model !== "string" ||
        typeof settings.reasoningEffort !== "string"
      ) throw new TypeError("Model settings must include model and reasoning effort");
      return sanitizeSnapshot(await invoke(DESKTOP_SELECT_MODEL_SETTINGS_CHANNEL, settings));
    },
    updateAgentTeam: async (config) => sanitizeSnapshot(await invoke(DESKTOP_UPDATE_AGENT_TEAM_CHANNEL, config)),
    renameThread: async (threadId, title) => sanitizeSnapshot(await invoke(DESKTOP_RENAME_THREAD_CHANNEL, { threadId, title })),
    deleteThreads: async (threadIds, batchDeleteId) => sanitizeSnapshot(await invoke(DESKTOP_DELETE_THREADS_CHANNEL, { threadIds, batchDeleteId })),
    restoreThread: async (threadId) => sanitizeSnapshot(await invoke(DESKTOP_RESTORE_THREAD_CHANNEL, threadId)),
    respondPermission: async (callId, decision, scope) => {
      if (typeof callId !== "string") throw new TypeError("Call id must be a string");
      if (decision !== "allow" && decision !== "deny") {
        throw new TypeError("Invalid permission decision");
      }
      return Boolean(await invoke(DESKTOP_RESPOND_PERMISSION_CHANNEL, {
        callId,
        decision,
        ...(decision === "allow" ? { scope: scope === "session" ? "session" : "once" } : {}),
      }));
    },
    onPermissionRequest: (listener) => {
      if (typeof listener !== "function") {
        throw new TypeError("Permission listener must be a function");
      }
      const handler = (_event, value) => {
        const request = sanitizePermissionRequest(value);
        if (request !== undefined) listener(request);
      };
      ipcRenderer.on(DESKTOP_PERMISSION_REQUESTED_CHANNEL, handler);
      return () => ipcRenderer.removeListener(DESKTOP_PERMISSION_REQUESTED_CHANNEL, handler);
    },
    onEvent: (listener) => {
      if (typeof listener !== "function") {
        throw new TypeError("Desktop event listener must be a function");
      }
      const handler = (_event, value) => {
        const safeEvent = sanitizeDesktopEvent(value);
        if (safeEvent !== undefined) {
          listener(safeEvent);
        }
      };
      ipcRenderer.on(DESKTOP_EVENT_CHANNEL, handler);
      return () => ipcRenderer.removeListener(DESKTOP_EVENT_CHANNEL, handler);
    },
  },
  preview: {
    getStatus: async () => sanitizePreviewStatus(await ipcRenderer.invoke(PREVIEW_GET_STATUS_CHANNEL)),
    start: async () => sanitizePreviewStatus(await invoke(PREVIEW_START_CHANNEL)),
    stop: async () => sanitizePreviewStatus(await invoke(PREVIEW_STOP_CHANNEL)),
    openExternal: async () => Boolean(await invoke(PREVIEW_OPEN_EXTERNAL_CHANNEL)),
  },
  browser: {
    getState: async () => sanitizeBrowserState(await invoke(BROWSER_GET_STATE_CHANNEL)),
    createTab: async (url) => sanitizeBrowserState(await invoke(
      BROWSER_CREATE_TAB_CHANNEL,
      typeof url === "string" ? safeText(url, 4_096) : undefined,
    )),
    closeTab: async (id) => sanitizeBrowserState(await invoke(BROWSER_CLOSE_TAB_CHANNEL, safeBrowserTabId(id))),
    activateTab: async (id) => sanitizeBrowserState(await invoke(BROWSER_ACTIVATE_TAB_CHANNEL, safeBrowserTabId(id))),
    navigate: async (id, url) => sanitizeBrowserState(await invoke(BROWSER_NAVIGATE_CHANNEL, {
      id: safeBrowserTabId(id),
      url: safeText(url, 4_096),
    })),
    goBack: async (id) => sanitizeBrowserState(await invoke(BROWSER_GO_BACK_CHANNEL, safeBrowserTabId(id))),
    goForward: async (id) => sanitizeBrowserState(await invoke(BROWSER_GO_FORWARD_CHANNEL, safeBrowserTabId(id))),
    reload: async (id) => sanitizeBrowserState(await invoke(BROWSER_RELOAD_CHANNEL, safeBrowserTabId(id))),
    stop: async (id) => sanitizeBrowserState(await invoke(BROWSER_STOP_CHANNEL, safeBrowserTabId(id))),
    openExternal: async (id) => Boolean(await invoke(BROWSER_OPEN_EXTERNAL_CHANNEL, safeBrowserTabId(id))),
    setBounds: (bounds) => {
      if (!isRecord(bounds)) return;
      const safeDimension = (value) => Math.max(0, Math.min(20_000, Math.round(Number(value) || 0)));
      ipcRenderer.send(BROWSER_SET_BOUNDS_CHANNEL, {
        x: safeDimension(bounds.x),
        y: safeDimension(bounds.y),
        width: safeDimension(bounds.width),
        height: safeDimension(bounds.height),
        visible: bounds.visible === true,
      });
    },
    onStateChange: (listener) => {
      if (typeof listener !== "function") throw new TypeError("Browser state listener must be a function");
      const handler = (_event, value) => listener(sanitizeBrowserState(value));
      ipcRenderer.on(BROWSER_STATE_CHANGED_CHANNEL, handler);
      return () => ipcRenderer.removeListener(BROWSER_STATE_CHANGED_CHANNEL, handler);
    },
    onCommand: (listener) => {
      if (typeof listener !== "function") throw new TypeError("Browser command listener must be a function");
      const handler = (_event, value) => {
        if (value === "focus_address") listener(value);
      };
      ipcRenderer.on(BROWSER_COMMAND_CHANNEL, handler);
      return () => ipcRenderer.removeListener(BROWSER_COMMAND_CHANNEL, handler);
    },
  },
});

function safeBrowserTabId(value) {
  if (typeof value !== "string" || !/^browser-tab-\d+$/.test(value)) {
    throw new TypeError("浏览器标签无效");
  }
  return value;
}

function sanitizeBrowserState(value) {
  if (!isRecord(value) || !Array.isArray(value.tabs) || typeof value.activeTabId !== "string") {
    throw new Error("浏览器状态无效");
  }
  const tabs = value.tabs.slice(0, 50).map((tab) => {
    if (!isRecord(tab)) throw new Error("浏览器标签状态无效");
    const id = safeBrowserTabId(tab.id);
    const url = safeText(tab.url, 4_096);
    if (url !== "" && !/^https?:\/\//i.test(url)) throw new Error("浏览器网址无效");
    const faviconUrl = safeText(tab.faviconUrl, 8_192);
    return Object.freeze({
      id,
      title: safeText(tab.title, 240) || "新标签页",
      url,
      ...(faviconUrl !== "" && (/^https?:\/\//i.test(faviconUrl) || /^data:image\//i.test(faviconUrl))
        ? { faviconUrl }
        : {}),
      isLoading: tab.isLoading === true,
      canGoBack: tab.canGoBack === true,
      canGoForward: tab.canGoForward === true,
      ...(typeof tab.error === "string" ? { error: safeText(tab.error, 160) } : {}),
    });
  });
  const activeTabId = safeBrowserTabId(value.activeTabId);
  if (!tabs.some((tab) => tab.id === activeTabId)) throw new Error("活动浏览器标签无效");
  return Object.freeze({ tabs: Object.freeze(tabs), activeTabId });
}

function sanitizePreviewStatus(value) {
  if (!isRecord(value) || (value.state !== "running" && value.state !== "stopped")) {
    throw new Error("项目预览状态无效");
  }
  if (value.state === "stopped") return { state: "stopped" };
  if (typeof value.url !== "string" || !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(value.url)) {
    throw new Error("项目预览地址无效");
  }
  return { state: "running", url: value.url };
}
