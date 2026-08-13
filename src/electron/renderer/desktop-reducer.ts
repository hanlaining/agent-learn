import type {
  DesktopActivity,
  DesktopEvent,
  DesktopSnapshot,
} from "../desktop-types.js";
import type {
  RuntimeSession,
} from "../../runtime/runtime-session.js";

export interface DesktopUiState {
  snapshot?: DesktopSnapshot;
  activities: DesktopActivity[];
  reasoning: string;
  sources: Array<{ title: string; url: string }>;
  runtimeSession?: RuntimeSession;
  error?: string;
}

export type DesktopUiAction =
  | { type: "snapshot"; snapshot: DesktopSnapshot }
  | { type: "event"; event: DesktopEvent }
  | { type: "error"; message: string }
  | { type: "clear-error" };

export const INITIAL_DESKTOP_UI_STATE: DesktopUiState = {
  activities: [],
  reasoning: "",
  sources: [],
};

/**
 * UI 只根据强类型事件演进，不通过提示文字猜测 Runtime 状态。
 */
export function desktopReducer(
  state: DesktopUiState,
  action: DesktopUiAction,
): DesktopUiState {
  if (action.type === "snapshot") {
    return {
      snapshot: action.snapshot,
      activities: [],
      reasoning: "",
      sources: [],
      ...(action.snapshot.runtimeSession === undefined
        ? {}
        : { runtimeSession: action.snapshot.runtimeSession }),
    };
  }

  if (action.type === "error") {
    return { ...state, error: action.message };
  }

  if (action.type === "clear-error") {
    const { error: _error, ...next } = state;
    return next;
  }

  if (state.snapshot === undefined) {
    return state;
  }

  const event = action.event;

  switch (event.type) {
    case "agent/run_updated": {
      if (event.threadId !== state.snapshot.activeThreadId) return state;
      const index = state.snapshot.agentRuns.findIndex((run) => run.id === event.run.id);
      const agentRuns = [...state.snapshot.agentRuns];
      if (index === -1) agentRuns.push(event.run);
      else agentRuns[index] = event.run;
      return { ...state, snapshot: { ...state.snapshot, agentRuns } };
    }
    case "runtime/session":
      if (event.threadId !== state.snapshot.activeThreadId) {
        return state;
      }
      return {
        ...state,
        runtimeSession: event.session,
      };

    case "thread/updated": {
      const existing = state.snapshot.threads.find(
        (thread) => thread.id === event.thread.id,
      );
      const thread = existing === undefined
        ? event.thread
        : {
            ...existing,
            title: event.thread.title,
            messageCount: Math.max(
              existing.messageCount,
              event.thread.messageCount,
            ),
          };

      return {
        ...state,
        snapshot: {
          ...state.snapshot,
          threads: [
            thread,
            ...state.snapshot.threads.filter(
              (item) => item.id !== event.thread.id,
            ),
          ],
        },
      };
    }

    case "message/user":
      if (event.threadId !== state.snapshot.activeThreadId) {
        return state;
      }
      {
        const {
          error: _error,
          runtimeSession: _runtimeSession,
          ...stateWithoutTransient
        } = state;
      return {
        ...stateWithoutTransient,
        activities: [],
        reasoning: "",
        sources: [],
        snapshot: {
          ...state.snapshot,
          messages: [...state.snapshot.messages, event.message],
        },
      };
      }

    case "assistant/delta": {
      if (event.threadId !== state.snapshot.activeThreadId) {
        return state;
      }
      const messageId = `assistant-stream-${event.turnId}`;
      const existingIndex = state.snapshot.messages.findIndex(
        (message) => message.id === messageId,
      );
      const messages = [...state.snapshot.messages];

      if (existingIndex === -1) {
        messages.push({
          id: messageId,
          turnId: event.turnId,
          role: "assistant",
          text: event.delta,
          createdAt: new Date().toISOString(),
        });
      } else {
        const existing = messages[existingIndex]!;
        messages[existingIndex] = {
          ...existing,
          text: existing.text + event.delta,
        };
      }

      return {
        ...state,
        snapshot: { ...state.snapshot, messages },
      };
    }

    case "assistant/completed": {
      if (event.threadId !== state.snapshot.activeThreadId) {
        return state;
      }
      const messageId = `assistant-stream-${event.turnId}`;
      const existingIndex = state.snapshot.messages.findIndex(
        (message) => message.id === messageId,
      );
      const messages = [...state.snapshot.messages];

      if (existingIndex === -1) {
        messages.push({
          id: messageId,
          turnId: event.turnId,
          role: "assistant",
          text: event.text,
          createdAt: new Date().toISOString(),
        });
      } else {
        messages[existingIndex] = {
          ...messages[existingIndex]!,
          text: event.text,
        };
      }

      return {
        ...state,
        snapshot: { ...state.snapshot, messages },
      };
    }

    case "reasoning/delta":
      if (event.threadId !== state.snapshot.activeThreadId) return state;
      return {
        ...state,
        reasoning: state.reasoning + event.delta,
      };

    case "activity/upsert":
      if (event.threadId !== state.snapshot.activeThreadId) return state;
      return {
        ...state,
        activities: upsertActivity(
          state.activities,
          event.activity,
        ),
      };

    case "source/added":
      if (event.threadId !== state.snapshot.activeThreadId) return state;
      if (state.sources.some((source) => source.url === event.url)) {
        return state;
      }
      return {
        ...state,
        sources: [
          ...state.sources,
          { title: event.title, url: event.url },
        ],
      };

    case "turn/state": {
      const active = event.threadId === state.snapshot.activeThreadId;
      return {
        ...state,
        ...(active && event.message !== undefined
          ? { error: event.message }
          : {}),
        snapshot: {
          ...state.snapshot,
          threads: state.snapshot.threads.map((thread) =>
            thread.id === event.threadId
              ? { ...thread, turnState: event.state }
              : thread,
          ),
          turnState: active ? event.state : state.snapshot.turnState,
        },
      };
    }
  }
}

function upsertActivity(
  activities: DesktopActivity[],
  incoming: DesktopActivity,
): DesktopActivity[] {
  const index = activities.findIndex(
    (activity) => activity.id === incoming.id,
  );

  if (index === -1) {
    return [...activities, incoming];
  }

  const next = [...activities];
  next[index] = incoming;
  return next;
}
