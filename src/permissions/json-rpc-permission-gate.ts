import type {
  JsonRpcConnection,
} from "../protocol/connection.js";
import type {
  PermissionGate,
  ToolPermissionDecision,
  ToolPermissionRequest,
  ToolRiskLevel,
} from "./permission-gate.js";
import type { AgentAccessMode } from "../agents/agent-runtime.js";

export interface JsonRpcPermissionGateOptions {
  resolveAccessMode?: (
    request: ToolPermissionRequest,
  ) => AgentAccessMode | undefined;
}

export interface ToolPermissionPrompt {
  turnId: string;
  threadId?: string;
  jobId?: string;
  agentId?: string;
  agentName?: string;
  taskId?: string;
  taskTitle?: string;
  callId: string;
  toolName: string;
  description?: string;
  riskLevel?: ToolRiskLevel;
}

/**
 * 把 Runtime 内部的 PermissionGate 接口适配成 App Server → Client 的反向 RPC。
 */
export class JsonRpcPermissionGate implements PermissionGate {
  private readonly sessionApprovals = new Set<string>();

  constructor(
    private readonly connection: JsonRpcConnection,
    private readonly options: JsonRpcPermissionGateOptions = {},
  ) {}

  async request(
    request: ToolPermissionRequest,
  ): Promise<ToolPermissionDecision> {
    const accessMode = this.options.resolveAccessMode?.(request) ?? "workspace";
    if (shouldAutomaticallyAllowTool(accessMode, request)) {
      return { decision: "allow" };
    }

    const prompt: ToolPermissionPrompt = {
      turnId: request.turnId,
      ...(request.threadId === undefined ? {} : { threadId: request.threadId }),
      ...(request.jobId === undefined ? {} : { jobId: request.jobId }),
      ...(request.agentId === undefined ? {} : { agentId: request.agentId }),
      ...(request.agentName === undefined ? {} : { agentName: request.agentName }),
      ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
      ...(request.taskTitle === undefined ? {} : { taskTitle: request.taskTitle }),
      callId: request.callId,
      toolName: request.toolName,
      ...(request.description === undefined
        ? {}
        : { description: request.description }),
      ...(request.riskLevel === undefined
        ? {}
        : { riskLevel: request.riskLevel }),
    };
    const sessionKey = createSessionApprovalKey(prompt);

    if (this.sessionApprovals.has(sessionKey)) {
      return { decision: "allow", scope: "session" };
    }

    // 原始 arguments 留在可信 Runtime 内；审批 Client 第一版只展示 Tool 名称。
    const response = await this.connection.sendRequest(
      "tool/request-permission",
      prompt,
    );

    const decision = parseToolPermissionDecision(response);

    if (
      decision.decision === "allow" &&
      decision.scope === "session"
    ) {
      this.sessionApprovals.add(sessionKey);
    }

    return decision;
  }
}

/**
 * Chat 的访问等级只决定普通操作是否免确认；敏感操作始终交给用户。
 * workspace 模式只自动放行 Runtime 已固定配方且受 WorkspaceSandbox 约束的命令。
 */
export function shouldAutomaticallyAllowTool(
  accessMode: AgentAccessMode,
  request: Pick<ToolPermissionRequest, "toolName" | "riskLevel">,
): boolean {
  const riskLevel = request.riskLevel ?? "sensitive";
  if (riskLevel === "sensitive") return false;
  if (riskLevel === "read") return true;
  if (accessMode === "full_access") return true;
  return accessMode === "workspace" && request.toolName === "run_command";
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
    if (
      value.scope !== undefined &&
      value.scope !== "once" &&
      value.scope !== "session"
    ) {
      throw new Error("Invalid tool permission response");
    }

    return value.scope === undefined
      ? { decision: "allow" }
      : { decision: "allow", scope: value.scope };
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
      !isNonEmptyString(value.description)) ||
    (value.riskLevel !== undefined &&
      value.riskLevel !== "read" &&
      value.riskLevel !== "execute" &&
      value.riskLevel !== "sensitive")
  ) {
    throw new Error("Invalid tool permission request");
  }

  return {
    turnId: value.turnId,
    ...(typeof value.threadId === "string" ? { threadId: value.threadId } : {}),
    ...(typeof value.jobId === "string" ? { jobId: value.jobId } : {}),
    ...(typeof value.agentId === "string" ? { agentId: value.agentId } : {}),
    ...(typeof value.agentName === "string" ? { agentName: value.agentName } : {}),
    ...(typeof value.taskId === "string" ? { taskId: value.taskId } : {}),
    ...(typeof value.taskTitle === "string" ? { taskTitle: value.taskTitle } : {}),
    callId: value.callId,
    toolName: value.toolName,
    ...(value.description === undefined
      ? {}
      : { description: value.description }),
    ...(value.riskLevel === undefined
      ? {}
      : { riskLevel: value.riskLevel }),
  };
}

function createSessionApprovalKey(
  prompt: ToolPermissionPrompt,
): string {
  return JSON.stringify([
    prompt.jobId ?? prompt.turnId,
    prompt.taskId ?? "",
    prompt.toolName,
    prompt.description ?? "",
    prompt.riskLevel ?? "sensitive",
  ]);
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
