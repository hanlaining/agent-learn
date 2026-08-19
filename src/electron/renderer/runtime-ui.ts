import type {
  RuntimeActivity,
  RuntimeContent,
  RuntimeSession,
  RuntimeSessionStatus,
} from "../../runtime/runtime-session.js";
import type {
  DesktopEvent,
  DesktopAgentRun,
} from "../desktop-types.js";
import { coordinationStatusLabel, deriveAttentionLevel, safeFailureMessage } from "../../agents/agent-presentation.js";

export type SafeInlineToken =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "emphasis"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href?: string };

export type SafeMarkdownBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "blockquote"; text: string }
  | { kind: "unordered_list"; items: string[] }
  | { kind: "ordered_list"; items: string[] }
  | { kind: "code"; language?: string; text: string }
  | { kind: "divider" };

const BLOCK_START = /^(?:#{1,3}\s+|>\s?|[-*+]\s+|\d+\.\s+|```|(?:-{3,}|\*{3,})\s*$)/;

/**
 * 把模型 Markdown 解析成受限结构。Renderer 始终由 React 创建节点，
 * 不使用 innerHTML，因此原始 HTML、脚本和事件属性只会显示成普通文本。
 */
export function parseSafeMarkdown(markdown: string): SafeMarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: SafeMarkdownBlock[] = [];

  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    const fence = /^```([^`]*)$/.exec(line.trim());
    if (fence !== null) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? "")) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      const language = fence[1]?.trim().slice(0, 32);
      blocks.push({
        kind: "code",
        ...(language ? { language } : {}),
        text: code.join("\n"),
      });
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading !== null) {
      blocks.push({
        kind: "heading",
        level: heading[1]!.length as 1 | 2 | 3,
        text: heading[2]!,
      });
      index += 1;
      continue;
    }

    if (/^(?:-{3,}|\*{3,})\s*$/.test(line.trim())) {
      blocks.push({ kind: "divider" });
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index] ?? "")) {
        quote.push((lines[index] ?? "").replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push({ kind: "blockquote", text: quote.join("\n") });
      continue;
    }

    if (/^[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*+]\s+/.test(lines[index] ?? "")) {
        items.push((lines[index] ?? "").replace(/^[-*+]\s+/, ""));
        index += 1;
      }
      blocks.push({ kind: "unordered_list", items });
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+\.\s+/.test(lines[index] ?? "")) {
        items.push((lines[index] ?? "").replace(/^\d+\.\s+/, ""));
        index += 1;
      }
      blocks.push({ kind: "ordered_list", items });
      continue;
    }

    const paragraph = [line];
    index += 1;
    while (
      index < lines.length &&
      (lines[index] ?? "").trim().length > 0 &&
      !BLOCK_START.test(lines[index] ?? "")
    ) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
  }

  return blocks;
}

export function parseSafeInline(text: string): SafeInlineToken[] {
  const tokens: SafeInlineToken[] = [];
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^\s)]+\))/g;
  let cursor = 0;

  for (const match of text.matchAll(pattern)) {
    const offset = match.index ?? 0;
    if (offset > cursor) {
      tokens.push({ kind: "text", text: text.slice(cursor, offset) });
    }

    const value = match[0];
    if (value.startsWith("`")) {
      tokens.push({ kind: "code", text: value.slice(1, -1) });
    } else if (value.startsWith("**")) {
      tokens.push({ kind: "strong", text: value.slice(2, -2) });
    } else if (value.startsWith("*")) {
      tokens.push({ kind: "emphasis", text: value.slice(1, -1) });
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(value);
      const label = link?.[1] ?? value;
      const href = link === null ? undefined : readSafeHttpUrl(link[2]!);
      tokens.push({ kind: "link", text: label, ...(href ? { href } : {}) });
    }
    cursor = offset + value.length;
  }

  if (cursor < text.length) {
    tokens.push({ kind: "text", text: text.slice(cursor) });
  }
  return tokens;
}

export function formatElapsed(
  startedAt: string,
  completedAt: string | undefined,
  nowMs: number,
): string {
  const start = Date.parse(startedAt);
  const end = completedAt === undefined ? nowMs : Date.parse(completedAt);
  const seconds = Number.isFinite(start) && Number.isFinite(end)
    ? Math.max(0, Math.floor((end - start) / 1_000))
    : 0;

  if (seconds < 60) return `已处理 ${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0
    ? `已处理 ${minutes} 分钟`
    : `已处理 ${minutes} 分 ${remainder} 秒`;
}

export function summarizeActivities(items: readonly RuntimeContent[]): string {
  const activities = items.filter(
    (item): item is RuntimeActivity => item.kind === "activity",
  );
  const counts = new Map<RuntimeActivity["activityKind"], number>();
  for (const item of activities) {
    counts.set(item.activityKind, (counts.get(item.activityKind) ?? 0) + 1);
  }

  const parts: string[] = [];
  const labels: Array<[RuntimeActivity["activityKind"], string]> = [
    ["read", "读取"],
    ["searched", "搜索"],
    ["ran", "运行"],
    ["edited", "编辑"],
    ["permission", "权限"],
    ["context", "上下文"],
    ["planning", "计划"],
  ];
  for (const [kind, label] of labels) {
    const count = counts.get(kind);
    if (count !== undefined) parts.push(`${label} ${count} 项`);
  }
  return parts.join(" · ") || "暂无活动";
}

export function isTerminalSession(session: RuntimeSession): boolean {
  return session.status !== "running";
}

export interface RuntimeTimelineSections {
  process: RuntimeContent[];
  outcome: RuntimeContent[];
}

export interface RuntimeActivityGroup {
  kind: "activity_group";
  id: string;
  round: number;
  activities: RuntimeActivity[];
}

export type RuntimeProcessDisplayItem = RuntimeContent | RuntimeActivityGroup;

/**
 * 按协议类型拆分公开过程和最终结果，不根据展示文本或到达顺序猜测语义。
 * 两个区域分别保持原始事件顺序。
 */
export function splitRuntimeTimelineItems(
  items: readonly RuntimeContent[],
): RuntimeTimelineSections {
  const process: RuntimeContent[] = [];
  const outcome: RuntimeContent[] = [];

  for (const item of items) {
    if (item.kind === "assistant" || item.kind === "error") {
      outcome.push(item);
    } else {
      process.push(item);
    }
  }

  return { process, outcome };
}

export function shouldAutoCollapseProcess(
  status: RuntimeSessionStatus,
): boolean {
  return status === "completed";
}

/** 只合并相邻且属于同一模型轮次的 Activity，任何其他内容都会形成分组边界。 */
export function groupConsecutiveActivities(
  items: readonly RuntimeContent[],
): RuntimeProcessDisplayItem[] {
  const result: RuntimeProcessDisplayItem[] = [];

  for (const item of items) {
    const previous = result.at(-1);
    if (
      item.kind === "activity" &&
      previous?.kind === "activity_group" &&
      previous.round === item.round
    ) {
      previous.activities.push(item);
      continue;
    }

    if (item.kind === "activity") {
      result.push({
        kind: "activity_group",
        id: `activity-group-${item.id}`,
        round: item.round,
        activities: [item],
      });
    } else {
      result.push(item);
    }
  }

  return result;
}

export function summarizeActivityGroup(
  group: RuntimeActivityGroup,
): string {
  return summarizeActivities(group.activities);
}

export function summarizeRuntimeStatus(status: RuntimeSessionStatus): string {
  if (status === "running") return "正在处理";
  if (status === "completed") return "处理完成";
  if (status === "failed") return "请求未完成";
  if (status === "cancelled") return "已取消";
  return "已超时";
}

export interface AgentPresentation {
  label: string;
  attention: import("../../agents/agent-run.js").AgentAttentionLevel;
  message?: string;
}

export function getAgentPresentation(run: DesktopAgentRun): AgentPresentation {
  const statusLabels: Record<DesktopAgentRun["status"], string> = {
    queued: "排队中", running: "运行中", waiting_children: "等待子 Agent",
    resuming: "自动续跑", completed: "已返回", failed: "失败", cancelled: "已停止", timed_out: "超时",
  };
  const rawMessage = run.statusMessage ?? run.safeError;
  const message = rawMessage === undefined ? undefined
    : /^[a-z][a-z0-9_]+$/u.test(rawMessage) ? safeFailureMessage(rawMessage) : rawMessage;
  return {
    label: run.coordinationStatus === undefined ? statusLabels[run.status] : coordinationStatusLabel(run.coordinationStatus),
    attention: deriveAttentionLevel(run.status, run.coordinationStatus, run.attentionLevel),
    ...(message === undefined ? {} : { message }),
  };
}

export function getActivityGroupStatus(
  group: RuntimeActivityGroup,
): RuntimeActivity["status"] {
  if (group.activities.some((item) => item.status === "running")) return "running";
  if (group.activities.some((item) => item.status === "failed")) return "failed";
  if (group.activities.some((item) => item.status === "cancelled")) return "cancelled";
  return "completed";
}

export function isNearBottom(
  metrics: { scrollHeight: number; scrollTop: number; clientHeight: number },
  threshold = 72,
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
}

export function isRuntimeItemAnimated(
  session: RuntimeSession,
  item: RuntimeContent,
): boolean {
  if (session.status !== "running") return false;
  return (
    (item.kind === "activity" && item.status === "running") ||
    (item.kind === "reasoning_summary" && item.status === "streaming") ||
    item.kind === "pending_output"
  );
}

/** 把同一动画帧内的文本增量合并，RuntimeSession 只保留最新快照。 */
export function coalesceDesktopEvents(
  events: readonly DesktopEvent[],
): DesktopEvent[] {
  const result: DesktopEvent[] = [];
  const latestSessions = new Map<string, DesktopEvent & { type: "runtime/session" }>();

  for (const event of events) {
    if (event.type === "runtime/session") {
      latestSessions.delete(event.session.turnId);
      latestSessions.set(event.session.turnId, event);
      continue;
    }

    if (event.type === "assistant/delta") {
      const index = result.findIndex((item) =>
        item.type === "assistant/delta" &&
        item.threadId === event.threadId &&
        item.turnId === event.turnId
      );
      if (index === -1) result.push(event);
      else {
        const existing = result[index]!;
        if (existing.type === "assistant/delta") {
          result[index] = { ...existing, delta: existing.delta + event.delta };
        }
      }
      continue;
    }

    if (event.type === "reasoning/delta") {
      const index = result.findIndex((item) =>
        item.type === "reasoning/delta" &&
        item.turnId === event.turnId &&
        item.summaryIndex === event.summaryIndex
      );
      if (index === -1) result.push(event);
      else {
        const existing = result[index]!;
        if (existing.type === "reasoning/delta") {
          result[index] = { ...existing, delta: existing.delta + event.delta };
        }
      }
      continue;
    }

    result.push(event);
  }

  return [...result, ...latestSessions.values()];
}

function readSafeHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username.length === 0 &&
      url.password.length === 0
    )
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}
