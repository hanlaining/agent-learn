import type {
  JsonRpcConnection,
} from "../protocol/connection.js";
import type {
  PermissionGate,
  ToolPermissionDecision,
  ToolPermissionRequest,
} from "./permission-gate.js";

export interface ToolPermissionPrompt {
  turnId: string;
  callId: string;
  toolName: string;
  description?: string;
}

/**
 * 把 Runtime 内部的 PermissionGate 接口适配成 App Server → Client 的反向 RPC。
 */
export class JsonRpcPermissionGate implements PermissionGate {
  constructor(
    private readonly connection: JsonRpcConnection,
  ) {}

  async request(
    request: ToolPermissionRequest,
  ): Promise<ToolPermissionDecision> {
    const prompt: ToolPermissionPrompt = {
      turnId: request.turnId,
      callId: request.callId,
      toolName: request.toolName,
      ...(request.description === undefined
        ? {}
        : { description: request.description }),
    };

    // 原始 arguments 留在可信 Runtime 内；审批 Client 第一版只展示 Tool 名称。
    const response = await this.connection.sendRequest(
      "tool/request-permission",
      prompt,
    );

    return parseToolPermissionDecision(response);
  }
}

/**
 * JSON-RPC 的返回值是不可信 unknown，进入 Agent Loop 前必须完整校验。
 */
export function parseToolPermissionDecision(
  value: unknown,
): ToolPermissionDecision {
  if (!isRecord(value)) {
    throw new Error("Invalid tool permission response");
  }

  if (value.decision === "allow") {
    return { decision: "allow" };
  }

  if (
    value.decision === "deny" &&
    (value.reason === undefined ||
      typeof value.reason === "string")
  ) {
    return value.reason === undefined
      ? { decision: "deny" }
      : {
          decision: "deny",
          reason: value.reason,
        };
  }

  throw new Error("Invalid tool permission response");
}

export function parseToolPermissionPrompt(
  value: unknown,
): ToolPermissionPrompt {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.turnId) ||
    !isNonEmptyString(value.callId) ||
    !isNonEmptyString(value.toolName)
    ||
    (value.description !== undefined &&
      !isNonEmptyString(value.description))
  ) {
    throw new Error("Invalid tool permission request");
  }

  return {
    turnId: value.turnId,
    callId: value.callId,
    toolName: value.toolName,
    ...(value.description === undefined
      ? {}
      : { description: value.description }),
  };
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

function isNonEmptyString(
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0
  );
}
