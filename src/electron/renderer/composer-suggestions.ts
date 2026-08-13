export type ComposerSuggestionKind = "slash" | "file" | "skill";

export interface ComposerToken {
  kind: ComposerSuggestionKind;
  trigger: "/" | "@" | "$";
  query: string;
  start: number;
  end: number;
}

export interface ComposerSuggestion {
  id: string;
  kind: ComposerSuggestionKind;
  value: string;
  label: string;
  description: string;
  searchText?: string;
  disabled?: boolean;
  disabledReason?: string;
}

export interface ComposerReplacement {
  text: string;
  cursor: number;
}

export interface ComposerMessageInput {
  text: string;
  mentions: Array<{ kind: "file"; path: string }>;
  explicitSkills: string[];
}

const TRIGGER_KIND = {
  "/": "slash",
  "@": "file",
  "$": "skill",
} as const;

/**
 * 只识别光标所在的显式 token。触发符必须位于文本开头或空白之后，
 * 因而不会把 URL、邮箱和普通代码片段误判成快捷入口。
 */
export function findComposerToken(
  text: string,
  cursor: number,
): ComposerToken | undefined {
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > text.length) {
    return undefined;
  }

  let start = cursor - 1;
  while (start >= 0 && !isWhitespace(text[start])) {
    start -= 1;
  }
  start += 1;

  const trigger = text[start] as keyof typeof TRIGGER_KIND | undefined;
  if (trigger === undefined || TRIGGER_KIND[trigger] === undefined) {
    return undefined;
  }
  if (start > 0 && !isWhitespace(text[start - 1])) {
    return undefined;
  }
  if (isInsideBacktickCode(text, start)) {
    return undefined;
  }

  let end = cursor;
  while (end < text.length && !isWhitespace(text[end])) {
    end += 1;
  }

  return {
    kind: TRIGGER_KIND[trigger],
    trigger,
    query: text.slice(start + 1, cursor),
    start,
    end,
  };
}

export function filterComposerSuggestions(
  suggestions: readonly ComposerSuggestion[],
  query: string,
  limit = 12,
): ComposerSuggestion[] {
  const normalized = normalizeSearch(query);
  return suggestions
    .filter((suggestion) => normalized.length === 0 || normalizeSearch([
      suggestion.label,
      suggestion.value,
      suggestion.description,
      suggestion.searchText ?? "",
    ].join(" ")).includes(normalized))
    .slice(0, Math.max(0, limit));
}

export function replaceComposerToken(
  text: string,
  token: ComposerToken,
  value: string,
): ComposerReplacement {
  const needsSpace = token.end >= text.length || !isWhitespace(text[token.end]);
  const replacement = `${value}${needsSpace ? " " : ""}`;
  return {
    text: `${text.slice(0, token.start)}${replacement}${text.slice(token.end)}`,
    cursor: token.start + replacement.length,
  };
}

export function moveComposerSelection(
  current: number,
  delta: number,
  count: number,
): number {
  if (count <= 0) return -1;
  return ((current + delta) % count + count) % count;
}

export function createComposerMessageInput(
  text: string,
  selectedFiles: readonly string[],
  selectedSkills: readonly string[],
): ComposerMessageInput {
  return {
    text,
    mentions: [...new Set(selectedFiles)]
      .filter((path) => containsExplicitMarker(text, `@${path}`))
      .map((path) => ({ kind: "file", path })),
    explicitSkills: [...new Set(selectedSkills)]
      .filter((name) => containsExplicitMarker(text, `$${name}`)),
  };
}

function containsExplicitMarker(text: string, marker: string): boolean {
  let offset = 0;
  while (offset <= text.length - marker.length) {
    const index = text.indexOf(marker, offset);
    if (index < 0) return false;
    const before = index === 0 ? undefined : text[index - 1];
    const afterIndex = index + marker.length;
    const after = afterIndex >= text.length ? undefined : text[afterIndex];
    if ((before === undefined || /\s/u.test(before)) &&
      (after === undefined || /\s/u.test(after))) return true;
    offset = index + 1;
  }
  return false;
}

function normalizeSearch(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function isWhitespace(value: string | undefined): boolean {
  return value !== undefined && /\s/u.test(value);
}

function isInsideBacktickCode(text: string, position: number): boolean {
  let open = false;
  for (let index = 0; index < position; index += 1) {
    if (text[index] === "`" && text[index - 1] !== "\\") {
      open = !open;
    }
  }
  return open;
}
