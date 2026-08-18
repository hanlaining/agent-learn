export type OutcomeUnknownInvocationKind = "model" | "tool";

export type OutcomeUnknownResolutionState =
  | "outcome_unknown"
  | "retry_authorized"
  | "external_result_recorded"
  | "manual_required"
  | "abandoned";

export type OutcomeUnknownPermission =
  | "invocation:view"
  | "invocation:resolve";

export interface OutcomeUnknownActor {
  id: string;
  permissions: readonly OutcomeUnknownPermission[];
  allowedThreadIds?: readonly string[];
}

export interface OutcomeUnknownInvocationIdentity {
  threadId: string;
  turnId: string;
  displayName: string;
  provider?: string;
  model?: string;
  toolName?: string;
  callId?: string;
}

export interface OutcomeUnknownExternalResult {
  summary: string;
  value: unknown;
}

export type OutcomeUnknownResolutionAction =
  | {
      action: "confirm_not_executed_retry";
      reason: string;
      toolSideEffectConfirmed?: boolean;
    }
  | {
      action: "record_external_result";
      reason: string;
      externalResult: OutcomeUnknownExternalResult;
    }
  | {
      action: "mark_manual_required";
      reason: string;
    }
  | {
      action: "abandon";
      reason: string;
    };

export interface ResolveOutcomeUnknownInput {
  resolutionId: string;
  expectedVersion: number;
  idempotencyKey: string;
  resolution: OutcomeUnknownResolutionAction;
}

export interface OutcomeUnknownRetryTicket {
  id: string;
  invocationId: string;
  authorizedBy: string;
  authorizedAt: string;
  consumed: false;
  /** API 只签发票据，不调用 Provider/Tool；执行器必须另行显式消费。 */
  automaticReplay: false;
}

export interface OutcomeUnknownAuditRecord {
  id: string;
  resolutionId: string;
  action: OutcomeUnknownResolutionAction["action"];
  actorId: string;
  reason: string;
  idempotencyKey: string;
  requestFingerprint: string;
  fromState: OutcomeUnknownResolutionState;
  toState: OutcomeUnknownResolutionState;
  version: number;
  occurredAt: string;
  externalResultDigest?: string;
  toolSideEffectConfirmed?: boolean;
}

export interface OutcomeUnknownResolutionRecord {
  resolutionId: string;
  invocationKind: OutcomeUnknownInvocationKind;
  invocationId: string;
  requestDigest: string;
  identity: OutcomeUnknownInvocationIdentity;
  sideEffectRisk: "none" | "possible" | "known";
  state: OutcomeUnknownResolutionState;
  version: number;
  unknownReasonCode?: string;
  externalResult?: OutcomeUnknownExternalResult;
  retryTicket?: OutcomeUnknownRetryTicket;
  createdAt: string;
  updatedAt: string;
  audit: OutcomeUnknownAuditRecord[];
}

export interface RegisterOutcomeUnknownInput {
  invocationKind: OutcomeUnknownInvocationKind;
  invocationId: string;
  requestDigest: string;
  identity: OutcomeUnknownInvocationIdentity;
  sideEffectRisk: "none" | "possible" | "known";
  unknownReasonCode?: string;
}

export interface OutcomeUnknownResolutionSnapshot {
  version: 1;
  records: OutcomeUnknownResolutionRecord[];
}

export class OutcomeUnknownResolutionError extends Error {
  constructor(
    readonly code:
      | "FORBIDDEN"
      | "NOT_FOUND"
      | "VERSION_CONFLICT"
      | "INVALID_STATE"
      | "INVALID_INPUT"
      | "IDEMPOTENCY_KEY_REUSED"
      | "TOOL_SIDE_EFFECT_CONFIRMATION_REQUIRED",
    message: string,
  ) {
    super(message);
    this.name = "OutcomeUnknownResolutionError";
  }
}
