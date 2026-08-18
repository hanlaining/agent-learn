export const RUNTIME_FAILURE_CODES = [
  "provider_timeout",
  "provider_rate_limited",
  "provider_network_error",
  "empty_model_output",
  "invalid_structured_output",
  "tool_permission_denied",
  "tool_round_limit",
  "tool_execution_failed",
  "stage_contract_failed",
  "review_false_reject",
  "review_false_accept",
  "stage_retry_exhausted",
  "stale_evidence",
  "return_delivery_failed",
  "terminal_state_inconsistent",
  "runtime_recovery_failed",
  "user_cancelled",
] as const;

export type RuntimeFailureCode = typeof RUNTIME_FAILURE_CODES[number];

export class RuntimeFailure extends Error {
  constructor(
    public readonly code: RuntimeFailureCode,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "RuntimeFailure";
  }
}

export function classifyRuntimeFailure(error: unknown): RuntimeFailureCode {
  if (error instanceof RuntimeFailure) return error.code;
  const record = typeof error === "object" && error !== null ? error as Record<string, unknown> : undefined;
  const explicitCode = typeof record?.code === "string" ? record.code : undefined;
  if (explicitCode !== undefined && (RUNTIME_FAILURE_CODES as readonly string[]).includes(explicitCode)) {
    return explicitCode as RuntimeFailureCode;
  }
  const status = typeof record?.status === "number" ? record.status : undefined;
  const name = typeof record?.name === "string" ? record.name.toLowerCase() : "";
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (status === 429 || /rate.?limit|too many requests/.test(message)) return "provider_rate_limited";
  if (name.includes("timeout") || /timed? ?out|deadline/.test(message)) return "provider_timeout";
  if (/network|econn|enotfound|socket|fetch failed/.test(message)) return "provider_network_error";
  if (/permission|denied|not allowed/.test(message)) return "tool_permission_denied";
  if (/tool round|round limit|budget exhausted/.test(message)) return "tool_round_limit";
  if (/empty (model )?(output|response)/.test(message)) return "empty_model_output";
  if (/return/.test(message)) return "return_delivery_failed";
  if (/recover|checkpoint/.test(message)) return "runtime_recovery_failed";
  return "tool_execution_failed";
}
