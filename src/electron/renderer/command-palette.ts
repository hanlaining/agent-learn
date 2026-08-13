import type { ActionDefinition } from "../../shortcuts/action-types.js";
import type { DesktopMessage } from "../desktop-types.js";
import type { RuntimeSession } from "../../runtime/runtime-session.js";

export interface CommandPaletteItem {
  action: ActionDefinition;
  enabled: boolean;
  disabledReason?: string;
}

export type DesktopShortcutActionId =
  | "composer.commandPalette"
  | "chat.search"
  | "chat.new"
  | "output.copyLatest";

export function filterCommandPaletteItems(
  items: readonly CommandPaletteItem[],
  query: string,
): CommandPaletteItem[] {
  const terms = normalize(query).split(/\s+/).filter(Boolean);

  return items.filter(({ action }) => {
    if (terms.length === 0) return true;
    const haystack = normalize([
      action.label,
      action.description,
      action.slashCommand,
      ...(action.defaultBindings ?? []),
    ].filter(Boolean).join(" "));
    return terms.every((term) => haystack.includes(term));
  });
}

export function movePaletteSelection(
  currentIndex: number,
  direction: 1 | -1,
  itemCount: number,
): number {
  if (itemCount <= 0) return -1;
  if (currentIndex < 0 || currentIndex >= itemCount) {
    return direction === 1 ? 0 : itemCount - 1;
  }
  return (currentIndex + direction + itemCount) % itemCount;
}

export function resolveDesktopShortcut(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "isComposing">,
): DesktopShortcutActionId | undefined {
  if (event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey)) {
    return undefined;
  }

  const key = event.key.toLocaleLowerCase();
  if (key === "p" && event.shiftKey) return "composer.commandPalette";
  if (event.shiftKey) return undefined;
  if (key === "k") return "chat.search";
  if (key === "n") return "chat.new";
  if (key === "o") return "output.copyLatest";
  return undefined;
}

export function formatDesktopBinding(binding: string): string {
  const primary = navigator.platform.toLocaleLowerCase().includes("mac")
    ? "⌘"
    : "Ctrl";
  return binding.replace("Primary", primary).replaceAll("+", " + ");
}

export function findLatestAssistantOutput(
  messages: readonly DesktopMessage[],
  session: RuntimeSession | undefined,
): string | undefined {
  const runtimeOutput = session?.items.findLast(
    (item) => item.kind === "assistant" && item.markdown.trim().length > 0,
  );
  if (runtimeOutput?.kind === "assistant") return runtimeOutput.markdown;

  return messages.findLast(
    (message) => message.role === "assistant" && message.text.trim().length > 0,
  )?.text;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}
