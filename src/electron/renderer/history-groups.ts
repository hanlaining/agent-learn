import type { DesktopThreadSummary } from "../desktop-types.js";

export type HistoryDateGroup = "今天" | "昨天" | "历史";

const DAY_IN_MILLISECONDS = 86_400_000;

export function groupThreads(
  threads: DesktopThreadSummary[],
  activeThreadId?: string,
  now = new Date(),
): Array<[HistoryDateGroup, DesktopThreadSummary[]]> {
  const groups = new Map<HistoryDateGroup, DesktopThreadSummary[]>();
  for (const thread of threads) {
    const label = dateGroup(thread, activeThreadId, now);
    groups.set(label, [...(groups.get(label) ?? []), thread]);
  }
  return [...groups.entries()];
}

export function dateGroup(
  thread: Pick<DesktopThreadSummary, "id" | "createdAt" | "lastActivityAt">,
  activeThreadId?: string,
  now = new Date(),
): HistoryDateGroup {
  const date = firstValidDate(thread.lastActivityAt, thread.createdAt);
  if (date === undefined) return thread.id === activeThreadId ? "今天" : "历史";

  const days = Math.round(
    (localCalendarDay(now) - localCalendarDay(date)) / DAY_IN_MILLISECONDS,
  );
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  return "历史";
}

export function shouldAutoOpenToday(
  threads: DesktopThreadSummary[],
  activeThreadId: string | undefined,
  previousThreadIds: ReadonlySet<string>,
  now = new Date(),
): boolean {
  if (activeThreadId === undefined || previousThreadIds.has(activeThreadId)) return false;
  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  return activeThread !== undefined && dateGroup(activeThread, activeThreadId, now) === "今天";
}

function firstValidDate(...values: string[]): Date | undefined {
  for (const value of values) {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return new Date(timestamp);
  }
  return undefined;
}

function localCalendarDay(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}
