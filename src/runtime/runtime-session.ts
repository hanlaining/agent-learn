import type {
  TurnId,
} from "./lifecycle.js";

export type RuntimeSessionStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

interface RuntimeItemBase {
  id: string;
  turnId: TurnId;
}

export interface RuntimePendingOutput extends RuntimeItemBase {
  kind: "pending_output";
  round: number;
  status: "streaming";
  markdown: string;
}

export interface RuntimeCommentary extends RuntimeItemBase {
  kind: "commentary";
  round: number;
  status: "completed";
  markdown: string;
}

export interface RuntimeAssistant extends RuntimeItemBase {
  kind: "assistant";
  round: number;
  status: "completed";
  markdown: string;
}

export interface RuntimeReasoningSummary extends RuntimeItemBase {
  kind: "reasoning_summary";
  round: number;
  summaryIndex: number;
  status: "streaming" | "completed";
  markdown: string;
}

export type RuntimeActivityKind =
  | "planning"
  | "searched"
  | "read"
  | "ran"
  | "edited"
  | "context"
  | "permission";

export interface RuntimeActivity extends RuntimeItemBase {
  kind: "activity";
  activityKind: RuntimeActivityKind;
  round: number;
  status:
    | "running"
    | "completed"
    | "failed"
    | "cancelled";
  title: string;
  summary?: string;
  safeDetails?: string[];
}

export interface RuntimeSafeError extends RuntimeItemBase {
  kind: "error";
  code: string;
  title: string;
  safeMessage: string;
  retryable: boolean;
}

export type RuntimeContent =
  | RuntimePendingOutput
  | RuntimeCommentary
  | RuntimeAssistant
  | RuntimeReasoningSummary
  | RuntimeActivity
  | RuntimeSafeError;

export interface RuntimeSession {
  turnId: TurnId;
  status: RuntimeSessionStatus;
  startedAt: string;
  completedAt?: string;
  items: RuntimeContent[];
}

/** 同 ID 更新原条目，同时保持它第一次出现时的真实事件顺序。 */
export function upsertRuntimeContent(
  items: readonly RuntimeContent[],
  incoming: RuntimeContent,
): RuntimeContent[] {
  const index = items.findIndex((item) => item.id === incoming.id);

  if (index === -1) {
    return [...items, incoming];
  }

  const next = [...items];
  next[index] = incoming;
  return next;
}

export function cloneRuntimeSession(
  session: RuntimeSession,
): RuntimeSession {
  return structuredClone(session);
}

export function isRuntimeSession(value: unknown): value is RuntimeSession {
  return (
    isRecord(value) &&
    typeof value.turnId === "string" &&
    ["running", "completed", "failed", "cancelled", "timed_out"]
      .includes(String(value.status)) &&
    typeof value.startedAt === "string" &&
    (value.completedAt === undefined ||
      typeof value.completedAt === "string") &&
    Array.isArray(value.items) &&
    value.items.every(isRuntimeContent)
  );
}

function isRuntimeContent(value: unknown): boolean {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.turnId !== "string" ||
    typeof value.kind !== "string"
  ) {
    return false;
  }

  if (
    value.kind === "pending_output" ||
    value.kind === "commentary" ||
    value.kind === "assistant"
  ) {
    return (
      isNonNegativeInteger(value.round) &&
      typeof value.markdown === "string" &&
      (value.kind === "pending_output"
        ? value.status === "streaming"
        : value.status === "completed")
    );
  }

  if (value.kind === "reasoning_summary") {
    return (
      isNonNegativeInteger(value.round) &&
      isNonNegativeInteger(value.summaryIndex) &&
      (value.status === "streaming" || value.status === "completed") &&
      typeof value.markdown === "string"
    );
  }

  if (value.kind === "activity") {
    return (
      ["planning", "searched", "read", "ran", "edited", "context", "permission"]
        .includes(String(value.activityKind)) &&
      isNonNegativeInteger(value.round) &&
      ["running", "completed", "failed", "cancelled"]
        .includes(String(value.status)) &&
      typeof value.title === "string" &&
      (value.summary === undefined || typeof value.summary === "string") &&
      (value.safeDetails === undefined ||
        (Array.isArray(value.safeDetails) &&
          value.safeDetails.every((item) => typeof item === "string")))
    );
  }

  return value.kind === "error" &&
    typeof value.code === "string" &&
    typeof value.title === "string" &&
    typeof value.safeMessage === "string" &&
    typeof value.retryable === "boolean";
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
