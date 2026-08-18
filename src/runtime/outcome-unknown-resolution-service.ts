import type {
  OutcomeUnknownActor,
  OutcomeUnknownResolutionRecord,
  RegisterOutcomeUnknownInput,
  ResolveOutcomeUnknownInput,
} from "./outcome-unknown-resolution.js";
import { OutcomeUnknownResolutionError } from "./outcome-unknown-resolution.js";
import type { OutcomeUnknownResolutionStore } from "./outcome-unknown-resolution-store.js";

export class OutcomeUnknownResolutionService {
  constructor(private readonly store: OutcomeUnknownResolutionStore) {}

  /** 仅供 Runtime/WAL 适配器调用；外部 API 不注册 Invocation，避免伪造 identity/digest。 */
  registerFromRuntime(input: RegisterOutcomeUnknownInput): Promise<OutcomeUnknownResolutionRecord> {
    return this.store.register(input);
  }

  async syncFromRuntimeSources(sources: OutcomeUnknownRuntimeSources): Promise<void> {
    const modelById = new Map(sources.modelInvocations.map((item) => [item.invocationId, item]));
    for (const invocation of sources.modelInvocations) {
      if (invocation.status !== "outcome_unknown") continue;
      await this.registerFromRuntime({
        invocationKind: "model",
        invocationId: invocation.invocationId,
        requestDigest: invocation.requestDigest,
        identity: {
          threadId: invocation.threadId,
          turnId: invocation.turnId,
          displayName: `Model · ${invocation.purpose}`,
          provider: invocation.provider,
          model: invocation.model,
        },
        sideEffectRisk: "none",
        ...(invocation.lastErrorCode === undefined ? {} : { unknownReasonCode: invocation.lastErrorCode }),
      });
    }
    for (const invocation of sources.toolInvocations) {
      if (invocation.status !== "outcome_unknown") continue;
      const parent = modelById.get(invocation.modelInvocationId);
      if (parent === undefined) continue;
      await this.registerFromRuntime({
        invocationKind: "tool",
        invocationId: invocation.toolInvocationId,
        requestDigest: invocation.argumentsDigest,
        identity: {
          threadId: parent.threadId,
          turnId: parent.turnId,
          displayName: `Tool · ${invocation.toolName}`,
          toolName: invocation.toolName,
          callId: invocation.callId,
        },
        // 当前 Tool WAL 没有稳定的只读/写入能力字段；缺失信息必须按最保守风险处理。
        sideEffectRisk: "known",
        ...(invocation.lastErrorCode === undefined ? {} : { unknownReasonCode: invocation.lastErrorCode }),
      });
    }
  }

  list(actor: OutcomeUnknownActor, threadId?: string): OutcomeUnknownResolutionRecord[] {
    requirePermission(actor, "invocation:view", threadId);
    return this.store.list(threadId);
  }

  resolve(actor: OutcomeUnknownActor, input: ResolveOutcomeUnknownInput): Promise<OutcomeUnknownResolutionRecord> {
    const record = this.store.get(input.resolutionId);
    if (record === undefined) {
      throw new OutcomeUnknownResolutionError("NOT_FOUND", "Outcome-unknown invocation was not found");
    }
    requirePermission(actor, "invocation:resolve", record.identity.threadId);
    return this.store.resolve(input, actor.id);
  }
}

export interface OutcomeUnknownRuntimeSources {
  modelInvocations: ReadonlyArray<{
    invocationId: string;
    requestDigest: string;
    threadId: string;
    turnId: string;
    purpose: string;
    provider: string;
    model: string;
    status: string;
    lastErrorCode?: string;
  }>;
  toolInvocations: ReadonlyArray<{
    toolInvocationId: string;
    modelInvocationId: string;
    callId: string;
    toolName: string;
    argumentsDigest: string;
    status: string;
    lastErrorCode?: string;
  }>;
}

function requirePermission(
  actor: OutcomeUnknownActor,
  permission: "invocation:view" | "invocation:resolve",
  threadId?: string,
): void {
  if (!actor.permissions.includes(permission) ||
    (threadId !== undefined && actor.allowedThreadIds !== undefined && !actor.allowedThreadIds.includes(threadId))) {
    throw new OutcomeUnknownResolutionError("FORBIDDEN", `Actor is not allowed to ${permission}`);
  }
}
