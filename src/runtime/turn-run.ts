import {
  isItem,
  isTurn,
  type Item,
  type Turn,
  type TurnId,
} from "./lifecycle.js";

export interface TurnRunParams {
  turnId: TurnId;
  model?: string;
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
}

export interface TurnRunResult {
  turn: Turn;
  assistantMessage: Item;
}

export function parseTurnRunParams(
  value: unknown,
): TurnRunParams {
  if (
    !isRecord(value) ||
    typeof value.turnId !== "string" ||
    value.turnId.trim().length === 0
  ) {
    throw new Error(
      "turn/run turnId must be a non-empty string",
    );
  }

  const reasoningEffort = [
    "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
  ].find((candidate) => candidate === value.reasoningEffort) as
    TurnRunParams["reasoningEffort"];

  return {
    turnId: value.turnId,
    ...(typeof value.model === "string" && value.model.trim().length > 0
      ? { model: value.model }
      : {}),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  };
}

export function isTurnRunResult(
  value: unknown,
): value is TurnRunResult {
  if (
    !isRecord(value) ||
    !isTurn(value.turn) ||
    !isItem(value.assistantMessage)
  ) {
    return false;
  }

  return (
    value.turn.status === "completed" &&
    value.assistantMessage.type === "assistant_message" &&
    value.assistantMessage.turnId === value.turn.id &&
    value.assistantMessage.threadId === value.turn.threadId &&
    value.turn.itemIds.includes(value.assistantMessage.id)
  );
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
