import type {
  TurnId,
} from "../runtime/lifecycle.js";

export interface ToolPermissionRequest {
  turnId: TurnId;
  threadId?: string;
  jobId?: string;
  agentId?: string;
  agentName?: string;
  taskId?: string;
  taskTitle?: string;
  callId: string;
  toolName: string;
  arguments: string;
  description?: string;
  riskLevel?: ToolRiskLevel;
}

export type ToolRiskLevel = "read" | "execute" | "sensitive";
export type ToolPermissionScope = "once" | "session";

export type ToolPermissionDecision =
  | {
      decision: "allow";
      scope?: ToolPermissionScope;
    }
  | {
      decision: "deny";
      reason?: string;
    };

export interface PermissionGate {
  request(
    request: ToolPermissionRequest,
  ): Promise<ToolPermissionDecision>;
}

/**
 * 兼容当前行为的默认 Gate。App Server 下一切片会注入真实反向审批。
 */
export const ALLOW_ALL_PERMISSION_GATE: PermissionGate = {
  request: async () => ({ decision: "allow" }),
};
