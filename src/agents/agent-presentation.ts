import type {
  AgentAttentionLevel, AgentCoordinationStatus, AgentFailureOrigin, AgentRunStatus,
} from "./agent-run.js";

export function failureOriginForCode(code: string): AgentFailureOrigin {
  if (code.startsWith("provider_")) return "provider";
  if (code.startsWith("tool_")) return "tool";
  if (["stage_contract_failed", "stage_retry_exhausted", "review_false_reject", "review_false_accept"].includes(code)) return "contract";
  return "runtime";
}

export function safeFailureMessage(code: string): string {
  const messages: Record<string, string> = {
    provider_timeout: "模型服务响应超时，请稍后重试",
    provider_rate_limited: "模型服务当前繁忙，请稍后重试",
    provider_network_error: "模型服务网络连接失败",
    tool_permission_denied: "工具权限不足，任务未能继续",
    tool_round_limit: "工具调用已达到安全上限",
    tool_execution_failed: "工具执行失败，请查看诊断详情",
    empty_model_output: "Agent 未返回有效内容",
    invalid_structured_output: "Agent 输出格式需要修复",
    stage_contract_failed: "阶段输出未满足交付要求",
    stage_retry_exhausted: "阶段输出仍需补充或调整",
    return_delivery_failed: "Agent 结果回传失败",
    runtime_recovery_failed: "任务恢复失败，请重新启动该阶段",
  };
  return messages[code] ?? "任务未完成，请查看诊断详情";
}

export function coordinationStatusLabel(status: AgentCoordinationStatus): string {
  return ({
    waiting_assignment: "等待负责人分派",
    waiting_parent: "等待负责人继续引导",
    waiting_children: "等待子 Agent 返回",
    waiting_review: "等待验收",
    feedback_required: "待处理反馈",
    rework_required: "需要返工",
    upstream_blocked: "上游未完成，本角色未启动",
    skipped: "本阶段未执行",
  })[status];
}

export function deriveAttentionLevel(
  status: AgentRunStatus,
  coordinationStatus?: AgentCoordinationStatus,
  explicit?: AgentAttentionLevel,
): AgentAttentionLevel {
  if (explicit !== undefined) return explicit;
  if (["feedback_required", "rework_required", "upstream_blocked"].includes(coordinationStatus ?? "")) return "feedback";
  if (status === "failed" || status === "timed_out") return "error";
  if (status === "completed") return "success";
  if (status === "running" || status === "resuming") return "active";
  return "neutral";
}
