import type {
  TurnId,
} from "../runtime/lifecycle.js";

export interface ToolPermissionRequest {
  turnId: TurnId;
  callId: string;
  toolName: string;
  arguments: string;
  description?: string;
}

export type ToolPermissionDecision =
  | {
      decision: "allow";
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
