import {
  isItem,
  isTurn,
  type Item,
  type ThreadId,
  type Turn,
} from "./lifecycle.js";

export interface TurnStartParams {
  threadId: ThreadId;
  input: string;
  mentions: Array<{ kind: "file"; path: string }>;
  explicitSkills: string[];
}

export interface TurnStartResult {
  turn: Turn;
  userMessage: Item;
}

const MAX_INPUT_CHARACTERS = 32_000;
const MAX_CONTEXT_ITEMS = 20;
const MAX_CONTEXT_VALUE_CHARACTERS = 500;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** JSON-RPC 参数是不可信输入，所有字段必须在进入 Store 前独立校验。 */
export function parseTurnStartParams(value: unknown): TurnStartParams {
  if (!isRecord(value)) {
    throw new Error("turn/start params must be an object");
  }
  if (Object.keys(value).some((key) =>
    key !== "threadId" && key !== "input" && key !== "mentions" && key !== "explicitSkills"
  )) {
    throw new Error("turn/start params contain unknown fields");
  }
  if (typeof value.threadId !== "string" || value.threadId.trim().length === 0 ||
    value.threadId.length > MAX_CONTEXT_VALUE_CHARACTERS || hasControlCharacters(value.threadId)) {
    throw new Error("turn/start threadId must be a valid non-empty string");
  }
  if (typeof value.input !== "string" || value.input.trim().length === 0) {
    throw new Error("turn/start input must be a non-empty string");
  }
  if ([...value.input].length > MAX_INPUT_CHARACTERS) {
    throw new Error(`turn/start input exceeds ${MAX_INPUT_CHARACTERS} characters`);
  }
  return {
    threadId: value.threadId,
    input: value.input,
    mentions: readFileMentions(value.mentions),
    explicitSkills: readExplicitSkills(value.explicitSkills),
  };
}

function readFileMentions(value: unknown): Array<{ kind: "file"; path: string }> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CONTEXT_ITEMS) {
    throw new Error("turn/start mentions must be an array of at most 20 items");
  }
  return value.map((mention) => {
    if (!isRecord(mention) || mention.kind !== "file" ||
      typeof mention.path !== "string" || mention.path.trim().length === 0 ||
      mention.path.length > MAX_CONTEXT_VALUE_CHARACTERS || hasControlCharacters(mention.path) ||
      Object.keys(mention).some((key) => key !== "kind" && key !== "path")) {
      throw new Error("turn/start contains an invalid file mention");
    }
    return { kind: "file", path: mention.path };
  });
}

function readExplicitSkills(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CONTEXT_ITEMS ||
    !value.every((name) => typeof name === "string" && name.length <= 200 &&
      SKILL_NAME_PATTERN.test(name) && !hasControlCharacters(name))) {
    throw new Error("turn/start explicitSkills must be an array of at most 20 valid names");
  }
  return value as string[];
}

export function isTurnStartResult(value: unknown): value is TurnStartResult {
  if (!isRecord(value) || !isTurn(value.turn) || !isItem(value.userMessage)) return false;
  return value.userMessage.type === "user_message" &&
    value.userMessage.threadId === value.turn.threadId &&
    value.userMessage.turnId === value.turn.id &&
    value.turn.itemIds.includes(value.userMessage.id);
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
