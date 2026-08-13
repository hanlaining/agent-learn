import type {
  ThreadId,
  TurnId,
} from "../runtime/lifecycle.js";
import type { AgentRun } from "../agents/agent-run.js";

/**
 * Runtime 对外公开的执行轨迹。
 * 这里展示真实状态和模型提供的推理摘要，不包含隐藏思维链。
 */
export type AgentEvent =
  | {
      type: "agent/run_updated";
      threadId: ThreadId;
      turnId: TurnId;
      run: AgentRun;
    }
  | {
      type: "turn/started";
      threadId: ThreadId;
      turnId: TurnId;
    }
  | {
      type: "model/started";
      turnId: TurnId;
      round: number;
    }
  | {
      type: "context/compacted";
      turnId: TurnId;
      beforeTokens: number;
      afterTokens: number;
    }
  | {
      type: "reasoning/summary_part_added";
      turnId: TurnId;
      round: number;
      summaryIndex: number;
    }
  | {
      type: "reasoning/summary_delta";
      turnId: TurnId;
      round: number;
      summaryIndex: number;
      delta: string;
    }
  | {
      type: "reasoning/summary_completed";
      turnId: TurnId;
      round: number;
    }
  | {
      type: "web_search/started";
      turnId: TurnId;
      callId: string;
    }
  | {
      type: "web_search/searching";
      turnId: TurnId;
      callId: string;
    }
  | {
      type: "web_search/completed";
      turnId: TurnId;
      callId: string;
      query?: string;
    }
  | {
      type: "citation/url_added";
      turnId: TurnId;
      title: string;
      url: string;
      startIndex: number;
      endIndex: number;
    }
  | {
      type: "model/completed";
      turnId: TurnId;
      round: number;
      functionCallCount: number;
    }
  | {
      type: "tool/started";
      turnId: TurnId;
      callId: string;
      toolName: string;
    }
  | {
      type: "permission/requested";
      turnId: TurnId;
      callId: string;
      toolName: string;
    }
  | {
      type: "permission/decided";
      turnId: TurnId;
      callId: string;
      toolName: string;
      decision: "allow" | "deny";
      reason?: string;
    }
  | {
      type: "tool/completed";
      turnId: TurnId;
      callId: string;
      toolName: string;
    }
  | {
      type: "model/output_text_delta";
      turnId: TurnId;
      round: number;
      delta: string;
    }
  | {
      type: "model/output_text_completed";
      turnId: TurnId;
      round: number;
      classification: "commentary" | "assistant";
      text: string;
    }
  | {
      type: "turn/completed";
      turnId: TurnId;
    }
  | {
      type: "turn/failed";
      turnId: TurnId;
      message: string;
    }
  | {
      type: "turn/interrupted";
      turnId: TurnId;
      message: string;
    }
  | {
      type: "turn/timed_out";
      turnId: TurnId;
      message: string;
    };

export interface AgentEventSink {
  emit(event: AgentEvent): void;
}

export const NOOP_AGENT_EVENT_SINK: AgentEventSink = {
  emit: () => undefined,
};

/**
 * Client 收到的 Notification params 是 unknown，展示前必须校验。
 */
export function isAgentEvent(value: unknown): value is AgentEvent {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  if (
    value.type === "agent/run_updated"
  ) {
    return typeof value.threadId === "string" &&
      typeof value.turnId === "string" && isRecord(value.run) &&
      typeof value.run.id === "string" && typeof value.run.status === "string";
  }

  if (
    value.type === "turn/started"
  ) {
    return (
      typeof value.threadId === "string" &&
      typeof value.turnId === "string"
    );
  }

  if (
    value.type === "model/started" ||
    value.type === "model/completed"
  ) {
    return (
      typeof value.turnId === "string" &&
      Number.isInteger(value.round) &&
      (
        value.type === "model/started" ||
        Number.isInteger(value.functionCallCount)
      )
    );
  }

  if (value.type === "context/compacted") {
    return (
      typeof value.turnId === "string" &&
      Number.isInteger(value.beforeTokens) &&
      Number.isInteger(value.afterTokens)
    );
  }

  if (value.type === "reasoning/summary_part_added") {
    return (
      typeof value.turnId === "string" &&
      isNonNegativeInteger(value.round) &&
      Number.isInteger(value.summaryIndex) &&
      (value.summaryIndex as number) >= 0
    );
  }

  if (value.type === "reasoning/summary_delta") {
    return (
      typeof value.turnId === "string" &&
      isNonNegativeInteger(value.round) &&
      Number.isInteger(value.summaryIndex) &&
      (value.summaryIndex as number) >= 0 &&
      typeof value.delta === "string"
    );
  }

  if (value.type === "model/output_text_delta") {
    return (
      typeof value.turnId === "string" &&
      isNonNegativeInteger(value.round) &&
      typeof value.delta === "string"
    );
  }

  if (value.type === "model/output_text_completed") {
    return (
      typeof value.turnId === "string" &&
      isNonNegativeInteger(value.round) &&
      (value.classification === "commentary" ||
        value.classification === "assistant") &&
      typeof value.text === "string"
    );
  }

  if (value.type === "reasoning/summary_completed") {
    return (
      typeof value.turnId === "string" &&
      isNonNegativeInteger(value.round)
    );
  }

  if (
    value.type === "web_search/started" ||
    value.type === "web_search/searching" ||
    value.type === "web_search/completed"
  ) {
    return (
      typeof value.turnId === "string" &&
      typeof value.callId === "string" &&
      (
        value.type !== "web_search/completed" ||
        value.query === undefined ||
        typeof value.query === "string"
      )
    );
  }

  if (value.type === "citation/url_added") {
    return (
      typeof value.turnId === "string" &&
      typeof value.title === "string" &&
      typeof value.url === "string" &&
      isHttpUrl(value.url) &&
      Number.isInteger(value.startIndex) &&
      (value.startIndex as number) >= 0 &&
      Number.isInteger(value.endIndex) &&
      (value.endIndex as number) >=
        (value.startIndex as number)
    );
  }

  if (
    value.type === "tool/started" ||
    value.type === "tool/completed"
  ) {
    return (
      typeof value.turnId === "string" &&
      typeof value.callId === "string" &&
      typeof value.toolName === "string"
    );
  }

  if (value.type === "permission/requested") {
    return (
      typeof value.turnId === "string" &&
      typeof value.callId === "string" &&
      typeof value.toolName === "string"
    );
  }

  if (value.type === "permission/decided") {
    return (
      typeof value.turnId === "string" &&
      typeof value.callId === "string" &&
      typeof value.toolName === "string" &&
      (value.decision === "allow" ||
        value.decision === "deny") &&
      (value.reason === undefined ||
        typeof value.reason === "string")
    );
  }

  if (value.type === "turn/completed") {
    return typeof value.turnId === "string";
  }

  if (
    value.type === "turn/failed" ||
    value.type === "turn/interrupted" ||
    value.type === "turn/timed_out"
  ) {
    return (
      typeof value.turnId === "string" &&
      typeof value.message === "string"
    );
  }

  return false;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
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

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
