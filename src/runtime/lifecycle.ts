export type ThreadId = string;
export type TurnId = string;
export type ItemId = string;

export type ThreadStatus =
  | "active"
  | "closed";

export type TurnStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "interrupted"
  | "timed_out";

export type ItemType =
  | "user_message"
  | "assistant_message"
  | "tool_call"
  | "tool_result";

export interface Thread {
  id: ThreadId;
  status: ThreadStatus;
  createdAt: string;
  lastActivityAt?: string;
  title?: string;
  deletedAt?: string;
  trashExpiresAt?: string;
  deleteBatchId?: string;
  turnIds: TurnId[];
}

export interface Turn {
  id: TurnId;
  threadId: ThreadId;
  status: TurnStatus;
  createdAt: string;
  completedAt?: string;
  itemIds: ItemId[];
}

export interface Item {
  id: ItemId;
  threadId: ThreadId;
  turnId: TurnId;
  type: ItemType;
  content: unknown;
  createdAt: string;
}

export interface LifecycleState {
  threads: Map<ThreadId, Thread>;
  turns: Map<TurnId, Turn>;
  items: Map<ItemId, Item>;
}

export interface ThreadDeleteBatch {
  id: string;
  threadIds: string[];
  createdAt: string;
  status: "completed" | "restored";
  restoredAt?: string;
}

/**
 * typeof null 也等于 "object"。
 * 校验普通对象时必须单独排除 null 和数组。
 */
function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

/**
 * RPC 返回值在 Client 一侧是 unknown。
 * 只有通过类型守卫后，TypeScript 才允许安全访问 Thread 字段。
 */
export function isThread(value: unknown): value is Thread {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    (value.status === "active" ||
      value.status === "closed") &&
    typeof value.createdAt === "string" &&
    (value.lastActivityAt === undefined || typeof value.lastActivityAt === "string") &&
    (value.title === undefined || typeof value.title === "string") &&
    (value.deletedAt === undefined || typeof value.deletedAt === "string") &&
    (value.trashExpiresAt === undefined || typeof value.trashExpiresAt === "string") &&
    (value.deleteBatchId === undefined || typeof value.deleteBatchId === "string") &&
    Array.isArray(value.turnIds) &&
    value.turnIds.every(
      (turnId) => typeof turnId === "string",
    )
  );
}

/**
 * 校验通过 JSON-RPC 返回的 Turn。
 */
export function isTurn(value: unknown): value is Turn {
  if (!isRecord(value)) {
    return false;
  }

  const validStatus =
    value.status === "pending" ||
    value.status === "in_progress" ||
    value.status === "completed" ||
    value.status === "failed" ||
    value.status === "interrupted" ||
    value.status === "timed_out";

  const validCompletedAt =
    value.completedAt === undefined ||
    typeof value.completedAt === "string";

  return (
    typeof value.id === "string" &&
    typeof value.threadId === "string" &&
    validStatus &&
    typeof value.createdAt === "string" &&
    validCompletedAt &&
    Array.isArray(value.itemIds) &&
    value.itemIds.every(
      (itemId) => typeof itemId === "string",
    )
  );
}

/**
 * 校验通过 JSON-RPC 返回的 Item。
 * content 可以是任意数据，因此只检查它是否真实存在。
 */
export function isItem(value: unknown): value is Item {
  if (!isRecord(value)) {
    return false;
  }

  const validType =
    value.type === "user_message" ||
    value.type === "assistant_message" ||
    value.type === "tool_call" ||
    value.type === "tool_result";

  return (
    typeof value.id === "string" &&
    typeof value.threadId === "string" &&
    typeof value.turnId === "string" &&
    validType &&
    "content" in value &&
    typeof value.createdAt === "string"
  );
}
