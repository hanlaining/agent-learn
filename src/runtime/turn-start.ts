import {
  isItem,
  isTurn,
  type Item,
  type ThreadId,
  type Turn,
} from "./lifecycle.js";

/**
 * Client 调用 turn/start 时传入的参数。
 * Runtime Core 只接收通用文本，不在这里写死金融领域字段。
 */
export interface TurnStartParams {
  threadId: ThreadId;
  input: string;
}

/**
 * turn/start 同时返回新 Turn 和作为第一个 Item 保存的用户消息。
 */
export interface TurnStartResult {
  turn: Turn;
  userMessage: Item;
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

/**
 * JSON-RPC params 来自进程外部，只有验证完成后才能进入 Store。
 */
export function parseTurnStartParams(
  value: unknown,
): TurnStartParams {
  if (!isRecord(value)) {
    throw new Error(
      "turn/start params must be an object",
    );
  }

  if (
    typeof value.threadId !== "string" ||
    value.threadId.trim().length === 0
  ) {
    throw new Error(
      "turn/start threadId must be a non-empty string",
    );
  }

  if (
    typeof value.input !== "string" ||
    value.input.trim().length === 0
  ) {
    throw new Error(
      "turn/start input must be a non-empty string",
    );
  }

  return {
    threadId: value.threadId,
    input: value.input,
  };
}

/**
 * 校验响应结构，并进一步校验 Turn 与 userMessage 的关联关系。
 */
export function isTurnStartResult(
  value: unknown,
): value is TurnStartResult {
  if (!isRecord(value)) {
    return false;
  }

  if (
    !isTurn(value.turn) ||
    !isItem(value.userMessage)
  ) {
    return false;
  }

  return (
    value.userMessage.type === "user_message" &&
    value.userMessage.threadId ===
      value.turn.threadId &&
    value.userMessage.turnId === value.turn.id &&
    value.turn.itemIds.includes(
      value.userMessage.id,
    )
  );
}
