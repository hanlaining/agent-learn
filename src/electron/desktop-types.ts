import type {
  RuntimeCapabilities,
} from "../app-server/runtime-capabilities.js";
import {
  isRuntimeSession,
  type RuntimeSession,
} from "../runtime/runtime-session.js";

export interface DesktopThreadSummary {
  id: string;
  title: string;
  status: "active" | "closed";
  createdAt: string;
  lastActivityAt: string;
  messageCount: number;
  turnState: DesktopTurnState;
  model: string;
  reasoningEffort: DesktopReasoningEffort;
}

export type DesktopReasoningEffort =
  | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface DesktopAgentConfig {
  model: string;
  reasoningEffort: DesktopReasoningEffort;
  agentProfileId: string;
  agentTeam?: import("../agents/agent-runtime.js").AgentTeamConfig;
}

export interface DesktopModelSettings {
  model: string;
  reasoningEffort: DesktopReasoningEffort;
}

export interface DesktopMessage {
  id: string;
  turnId: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

export interface DesktopMessageInput {
  text: string;
  mentions?: Array<{ kind: "file"; path: string }>;
  explicitSkills?: string[];
}

export interface DesktopWorkspaceSearchResult {
  query: string;
  paths: string[];
  truncated: boolean;
}

export type DesktopTurnState =
  | "idle"
  | "starting"
  | "thinking"
  | "searching"
  | "running_tool"
  | "answering"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export type DesktopActivityKind =
  | "thinking"
  | "tool"
  | "search"
  | "permission"
  | "context";

export interface DesktopActivity {
  id: string;
  kind: DesktopActivityKind;
  status: "running" | "completed" | "denied";
  label: string;
}

export interface DesktopSnapshot {
  threads: DesktopThreadSummary[];
  activeThreadId?: string;
  activeAgentThreadId?: string;
  messages: DesktopMessage[];
  capabilities: RuntimeCapabilities;
  turnState: DesktopTurnState;
  runtimeSession?: RuntimeSession;
  agentConfig: DesktopAgentConfig;
  agentRuns: DesktopAgentRun[];
  trash?: DesktopTrashThread[];
  agentRuntime?: DesktopAgentRuntimeView;
  requirement?: import("../requirements/requirement.js").Requirement;
  outcomeUnknownInvocations?: DesktopOutcomeUnknownResolution[];
}

export type DesktopOutcomeUnknownState =
  | "outcome_unknown"
  | "retry_authorized"
  | "external_result_recorded"
  | "manual_required"
  | "abandoned";

export interface DesktopOutcomeUnknownResolution {
  resolutionId: string;
  invocationKind: "model" | "tool";
  invocationId: string;
  requestDigest: string;
  identity: {
    threadId: string;
    turnId: string;
    displayName: string;
    provider?: string;
    model?: string;
    toolName?: string;
    callId?: string;
  };
  sideEffectRisk: "none" | "possible" | "known";
  state: DesktopOutcomeUnknownState;
  version: number;
  unknownReasonCode?: string;
  externalResult?: { summary: string; value: unknown };
  retryTicket?: { id: string; automaticReplay: false };
  createdAt: string;
  updatedAt: string;
  audit: Array<{
    id: string;
    action: "confirm_not_executed_retry" | "record_external_result" | "mark_manual_required" | "abandon";
    actorId: string;
    reason: string;
    fromState: DesktopOutcomeUnknownState;
    toState: DesktopOutcomeUnknownState;
    version: number;
    occurredAt: string;
  }>;
}

export interface DesktopResolveOutcomeUnknownInput {
  resolutionId: string;
  expectedVersion: number;
  idempotencyKey: string;
  resolution:
    | { action: "confirm_not_executed_retry"; reason: string; toolSideEffectConfirmed?: boolean }
    | { action: "record_external_result"; reason: string; externalResult: { summary: string; value: unknown } }
    | { action: "mark_manual_required"; reason: string }
    | { action: "abandon"; reason: string };
}

export interface DesktopTrashThread { id: string; title: string; deletedAt: string; trashExpiresAt: string; deleteBatchId?: string; }
export interface DesktopAgentRuntimeView {
  job?: import("../agents/agent-runtime.js").AgentJob;
  tasks: import("../agents/agent-runtime.js").AgentTask[];
  edges: import("../agents/agent-runtime.js").AgentTaskEdge[];
  evidence: import("../agents/agent-runtime.js").AgentEvidence[];
  board: import("../agents/agent-runtime.js").SharedBoardEntry[];
  returns: import("../agents/agent-runtime.js").AgentReturnEnvelope[];
  fixedProductStage?: import("../agents/fixed-software-team-coordinator.js").FixedProductStage;
}

export interface DesktopAgentRun {
  id: string;
  jobId: string;
  rootRunId: string;
  taskId?: string;
  attempt: number;
  threadId: string;
  turnId: string;
  agentProfileId: string;
  parentRunId?: string;
  status: "queued" | "running" | "waiting_children" | "resuming" | "completed" | "failed" | "cancelled" | "timed_out";
  coordinationStatus?: import("../agents/agent-run.js").AgentCoordinationStatus;
  attentionLevel?: import("../agents/agent-run.js").AgentAttentionLevel;
  statusMessage?: string;
  failureOrigin?: import("../agents/agent-run.js").AgentFailureOrigin;
  task: string;
  depth: number;
  safeError?: string;
}

export type DesktopEvent =
  | {
      type: "agent/run_updated";
      threadId: string;
      turnId: string;
      run: DesktopAgentRun;
    }
  | {
      type: "runtime/session";
      threadId: string;
      session: RuntimeSession;
    }
  | {
      type: "thread/updated";
      thread: DesktopThreadSummary;
    }
  | {
      type: "message/user";
      threadId: string;
      message: DesktopMessage;
    }
  | {
      type: "assistant/delta";
      threadId: string;
      turnId: string;
      delta: string;
    }
  | {
      type: "assistant/completed";
      threadId: string;
      turnId: string;
      text: string;
    }
  | {
      type: "reasoning/delta";
      threadId: string;
      turnId: string;
      summaryIndex: number;
      delta: string;
    }
  | {
      type: "activity/upsert";
      threadId: string;
      turnId: string;
      activity: DesktopActivity;
    }
  | {
      type: "source/added";
      threadId: string;
      turnId: string;
      title: string;
      url: string;
    }
  | {
      type: "turn/state";
      threadId: string;
      turnId: string;
      state: DesktopTurnState;
      message?: string;
    };

export interface DesktopSendResult {
  turnId: string;
}

export interface DesktopPermissionRequest {
  turnId: string;
  threadId?: string;
  agentName?: string;
  jobId?: string;
  agentId?: string;
  taskId?: string;
  taskTitle?: string;
  callId: string;
  toolName: string;
  description?: string;
  riskLevel: "read" | "execute" | "sensitive";
}

export type DesktopPermissionDecision =
  | { decision: "allow"; scope: "once" | "session" }
  | { decision: "deny" };

export function isDesktopMessageInput(value: unknown): value is DesktopMessageInput {
  if (!isRecord(value) || typeof value.text !== "string") return false;
  const keys = Object.keys(value);
  if (keys.some((key) => !["text", "mentions", "explicitSkills"].includes(key))) return false;
  return (value.mentions === undefined || (
    Array.isArray(value.mentions) && value.mentions.length <= 20 && value.mentions.every((mention) =>
      isRecord(mention) && mention.kind === "file" && typeof mention.path === "string" &&
      Object.keys(mention).every((key) => key === "kind" || key === "path")
    )
  )) && (value.explicitSkills === undefined || (
    Array.isArray(value.explicitSkills) && value.explicitSkills.length <= 20 &&
    value.explicitSkills.every((name) => typeof name === "string")
  ));
}

export function isDesktopWorkspaceSearchResult(
  value: unknown,
): value is DesktopWorkspaceSearchResult {
  return isRecord(value) && typeof value.query === "string" &&
    Array.isArray(value.paths) && value.paths.every((path) => typeof path === "string") &&
    typeof value.truncated === "boolean";
}

export function isDesktopSnapshot(
  value: unknown,
): value is DesktopSnapshot {
  return (
    isRecord(value) &&
    Array.isArray(value.threads) &&
    value.threads.every(isDesktopThreadSummary) &&
    (value.activeThreadId === undefined ||
      typeof value.activeThreadId === "string") &&
    (value.activeAgentThreadId === undefined || typeof value.activeAgentThreadId === "string") &&
    Array.isArray(value.messages) &&
    value.messages.every(isDesktopMessage) &&
    isRuntimeCapabilitiesLike(value.capabilities) &&
    isDesktopTurnState(value.turnState) &&
    (value.runtimeSession === undefined ||
      isRuntimeSession(value.runtimeSession)) &&
    isDesktopAgentConfig(value.agentConfig)
    && Array.isArray(value.agentRuns)
    && value.agentRuns.every(isDesktopAgentRun)
    && (value.trash === undefined || Array.isArray(value.trash))
    && (value.outcomeUnknownInvocations === undefined || (
      Array.isArray(value.outcomeUnknownInvocations) &&
      value.outcomeUnknownInvocations.every(isDesktopOutcomeUnknownResolution)
    ))
  );
}

export function isDesktopOutcomeUnknownResolution(value: unknown): value is DesktopOutcomeUnknownResolution {
  const states = ["outcome_unknown", "retry_authorized", "external_result_recorded", "manual_required", "abandoned"];
  return isRecord(value) && typeof value.resolutionId === "string" &&
    (value.invocationKind === "model" || value.invocationKind === "tool") &&
    typeof value.invocationId === "string" && /^sha256:[a-f0-9]{64}$/u.test(String(value.requestDigest)) &&
    isRecord(value.identity) && typeof value.identity.threadId === "string" &&
    typeof value.identity.turnId === "string" && typeof value.identity.displayName === "string" &&
    (value.sideEffectRisk === "none" || value.sideEffectRisk === "possible" || value.sideEffectRisk === "known") &&
    states.includes(String(value.state)) && Number.isInteger(value.version) &&
    typeof value.createdAt === "string" && typeof value.updatedAt === "string" && Array.isArray(value.audit);
}

export function isDesktopEvent(value: unknown): value is DesktopEvent {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  if (value.type === "agent/run_updated") {
    return typeof value.threadId === "string" && typeof value.turnId === "string" &&
      isDesktopAgentRun(value.run);
  }

  if (value.type === "runtime/session") {
    return typeof value.threadId === "string" &&
      isRuntimeSession(value.session);
  }

  if (value.type === "thread/updated") {
    return isDesktopThreadSummary(value.thread);
  }

  if (value.type === "message/user") {
    return (
      typeof value.threadId === "string" &&
      isDesktopMessage(value.message) &&
      value.message.role === "user"
    );
  }

  if (
    value.type === "assistant/delta" ||
    value.type === "assistant/completed"
  ) {
    return (
      typeof value.threadId === "string" &&
      typeof value.turnId === "string" &&
      typeof (value.type === "assistant/delta"
        ? value.delta
        : value.text) === "string"
    );
  }

  if (value.type === "reasoning/delta") {
    return (
      typeof value.threadId === "string" &&
      typeof value.turnId === "string" &&
      Number.isInteger(value.summaryIndex) &&
      typeof value.delta === "string"
    );
  }

  if (value.type === "activity/upsert") {
    return (
      typeof value.threadId === "string" &&
      typeof value.turnId === "string" &&
      isDesktopActivity(value.activity)
    );
  }

  if (value.type === "source/added") {
    return (
      typeof value.threadId === "string" &&
      typeof value.turnId === "string" &&
      typeof value.title === "string" &&
      typeof value.url === "string" &&
      isHttpUrl(value.url)
    );
  }

  if (value.type === "turn/state") {
    return (
      typeof value.threadId === "string" &&
      typeof value.turnId === "string" &&
      isDesktopTurnState(value.state) &&
      (value.message === undefined ||
        typeof value.message === "string")
    );
  }

  return false;
}

function isDesktopThreadSummary(
  value: unknown,
): value is DesktopThreadSummary {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    (value.status === "active" || value.status === "closed") &&
    typeof value.createdAt === "string" &&
    typeof value.lastActivityAt === "string" &&
    Number.isInteger(value.messageCount) &&
    (value.messageCount as number) >= 0 &&
    isDesktopTurnState(value.turnState)
    && typeof value.model === "string"
    && isReasoningEffort(value.reasoningEffort)
  );
}

function isDesktopAgentConfig(value: unknown): value is DesktopAgentConfig {
  return isRecord(value) && typeof value.model === "string" &&
    isReasoningEffort(value.reasoningEffort) &&
    typeof value.agentProfileId === "string" && (value.agentTeam === undefined || isRecord(value.agentTeam));
}

function isDesktopAgentRun(value: unknown): value is DesktopAgentRun {
  return isRecord(value) && typeof value.id === "string" &&
    typeof value.jobId === "string" && typeof value.rootRunId === "string" &&
    Number.isInteger(value.attempt) &&
    typeof value.threadId === "string" && typeof value.turnId === "string" &&
    typeof value.agentProfileId === "string" &&
    (value.parentRunId === undefined || typeof value.parentRunId === "string") &&
    ["queued", "running", "waiting_children", "resuming", "completed", "failed", "cancelled", "timed_out"]
      .includes(String(value.status)) && typeof value.task === "string" &&
    Number.isInteger(value.depth) && (value.depth as number) >= 0 &&
    (value.coordinationStatus === undefined || ["waiting_assignment", "waiting_parent", "waiting_children", "waiting_review", "feedback_required", "rework_required", "upstream_blocked", "skipped"].includes(String(value.coordinationStatus))) &&
    (value.attentionLevel === undefined || ["neutral", "active", "success", "feedback", "error"].includes(String(value.attentionLevel))) &&
    (value.statusMessage === undefined || typeof value.statusMessage === "string") &&
    (value.failureOrigin === undefined || ["self", "parent", "dependency", "runtime", "provider", "tool", "contract"].includes(String(value.failureOrigin))) &&
    (value.safeError === undefined || typeof value.safeError === "string");
}

function isReasoningEffort(value: unknown): value is DesktopReasoningEffort {
  return ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
    .includes(String(value));
}

function isDesktopMessage(value: unknown): value is DesktopMessage {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.turnId === "string" &&
    (value.role === "user" || value.role === "assistant") &&
    typeof value.text === "string" &&
    typeof value.createdAt === "string"
  );
}

function isDesktopActivity(value: unknown): value is DesktopActivity {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.kind === "thinking" ||
      value.kind === "tool" ||
      value.kind === "search" ||
      value.kind === "permission" ||
      value.kind === "context") &&
    (value.status === "running" ||
      value.status === "completed" ||
      value.status === "denied") &&
    typeof value.label === "string"
  );
}

function isDesktopTurnState(value: unknown): value is DesktopTurnState {
  return [
    "idle",
    "starting",
    "thinking",
    "searching",
    "running_tool",
    "answering",
    "cancelling",
    "completed",
    "failed",
    "cancelled",
    "timed_out",
  ].includes(String(value));
}

function isRuntimeCapabilitiesLike(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.llm === "boolean" &&
    typeof value.webSearch === "boolean" &&
    Array.isArray(value.tools) &&
    Array.isArray(value.skills) &&
    Array.isArray(value.mcpServers)
  );
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}
