import type {
  LifecycleStore,
} from "./lifecycle-store.js";
import {
  isThread,
  type Thread,
} from "./lifecycle.js";

export interface ThreadHistoryParams {
  threadId: string;
}

export interface ThreadHistoryMessage {
  id: string;
  turnId: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

export interface ThreadHistoryResult {
  thread: Thread;
  messages: ThreadHistoryMessage[];
}

/**
 * 历史接口只公开对话事实，不把 Tool 参数、Tool Result 或内部快照交给 Client。
 */
export function readThreadHistory(
  store: LifecycleStore,
  threadId: string,
): ThreadHistoryResult {
  const thread = store.getThread(threadId);

  if (thread === undefined) {
    throw new Error(`Thread not found: ${threadId}`);
  }

  const messages: ThreadHistoryMessage[] = [];

  for (const turnId of thread.turnIds) {
    const turn = store.getTurn(turnId);

    if (turn === undefined) {
      throw new Error(`Turn not found: ${turnId}`);
    }

    for (const item of store.getItemsForTurn(turnId)) {
      if (
        item.type !== "user_message" &&
        item.type !== "assistant_message"
      ) {
        continue;
      }

      const text = readMessageText(item.content);
      messages.push({
        id: item.id,
        turnId: item.turnId,
        role: item.type === "user_message" ? "user" : "assistant",
        text,
        createdAt: item.createdAt,
      });
    }
  }

  return {
    thread: {
      ...thread,
      turnIds: [...thread.turnIds],
    },
    messages,
  };
}

export function parseThreadHistoryParams(
  value: unknown,
): ThreadHistoryParams {
  if (
    !isRecord(value) ||
    typeof value.threadId !== "string" ||
    value.threadId.trim().length === 0
  ) {
    throw new Error(
      "thread/history threadId must be a non-empty string",
    );
  }

  return { threadId: value.threadId };
}

export function isThreadHistoryResult(
  value: unknown,
): value is ThreadHistoryResult {
  return (
    isRecord(value) &&
    isThread(value.thread) &&
    Array.isArray(value.messages) &&
    value.messages.every(isThreadHistoryMessage)
  );
}

function isThreadHistoryMessage(
  value: unknown,
): value is ThreadHistoryMessage {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.turnId === "string" &&
    (value.role === "user" || value.role === "assistant") &&
    typeof value.text === "string" &&
    typeof value.createdAt === "string"
  );
}

function readMessageText(value: unknown): string {
  if (
    !isRecord(value) ||
    typeof value.text !== "string"
  ) {
    throw new Error("Message Item has no text");
  }

  return value.text;
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
