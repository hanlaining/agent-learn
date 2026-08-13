import type {
  TurnId,
} from "./lifecycle.js";

export interface TurnCancelParams {
  turnId: TurnId;
}

export interface TurnCancelResult {
  turnId: TurnId;
  cancelled: true;
}

export function parseTurnCancelParams(
  value: unknown,
): TurnCancelParams {
  if (
    !isRecord(value) ||
    typeof value.turnId !== "string" ||
    value.turnId.trim().length === 0
  ) {
    throw new Error(
      "turn/cancel turnId must be a non-empty string",
    );
  }

  return { turnId: value.turnId };
}

export function isTurnCancelResult(
  value: unknown,
): value is TurnCancelResult {
  return (
    isRecord(value) &&
    typeof value.turnId === "string" &&
    value.cancelled === true
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
