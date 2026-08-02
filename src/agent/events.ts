import type {
  ThreadId,
  TurnId,
} from "../runtime/lifecycle.js";

/**
 * Runtime 对外公开的执行轨迹。
 * 这里展示真实状态和模型提供的推理摘要，不包含隐藏思维链。
 */
export type AgentEvent =
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
      type: "reasoning/summary_delta";
      turnId: TurnId;
      delta: string;
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
      type: "tool/completed";
      turnId: TurnId;
      callId: string;
      toolName: string;
    }
  | {
      type: "assistant/delta";
      turnId: TurnId;
      delta: string;
    }
  | {
      type: "turn/completed";
      turnId: TurnId;
    }
  | {
      type: "turn/failed";
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

  if (
    value.type === "reasoning/summary_delta" ||
    value.type === "assistant/delta"
  ) {
    return (
      typeof value.turnId === "string" &&
      typeof value.delta === "string"
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

  if (value.type === "turn/completed") {
    return typeof value.turnId === "string";
  }

  if (value.type === "turn/failed") {
    return (
      typeof value.turnId === "string" &&
      typeof value.message === "string"
    );
  }

  return false;
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
