import type { LifecycleStore } from "./lifecycle-store.js";
import type { ModelInvocation } from "./model-invocation.js";
import type { ModelInvocationStore } from "./model-invocation-store.js";
import {
  createToolArgumentsDigest,
  createToolInvocationId,
} from "./tool-invocation.js";
import type { ToolInvocationStore } from "./tool-invocation-store.js";

export type ModelInvocationStartupRecoveryAction =
  | "replayed_response"
  | "completed_turn"
  | "blocked"
  | "skipped";

export interface ModelInvocationStartupRecoveryResult {
  turnId: string;
  action: ModelInvocationStartupRecoveryAction;
  invocationId?: string;
  diagnosticCode?: string;
}

export interface ModelInvocationStartupRecoveryOptions {
  lifecycleStore: LifecycleStore;
  modelInvocationStore: ModelInvocationStore;
  toolInvocationStore?: ToolInvocationStore;
  persist: () => void | Promise<void>;
  canReplayTurn?: (turnId: string) => boolean;
}

/**
 * 调度器只依据已经持久化的 Model/Tool 结果作决定，不直接请求 Provider。
 * 只有最终 Assistant 或终态提交能够在启动阶段确定性补交；任何仍需新模型轮
 * 的状态都保持 interrupted，等待用户显式 turn/run。
 */
export class ModelInvocationStartupRecovery {
  private readonly inFlight = new Map<
    string,
    Promise<ModelInvocationStartupRecoveryResult>
  >();

  constructor(
    private readonly options: ModelInvocationStartupRecoveryOptions,
  ) {}

  recover(
    turnIds: readonly string[],
  ): Promise<ModelInvocationStartupRecoveryResult[]> {
    return Promise.all(
      [...new Set(turnIds)].map((turnId) => this.recoverTurn(turnId)),
    );
  }

  recoverTurn(
    turnId: string,
  ): Promise<ModelInvocationStartupRecoveryResult> {
    const existing = this.inFlight.get(turnId);
    if (existing !== undefined) return existing;
    const recovery = this.recoverTurnOnce(turnId).finally(() => {
      if (this.inFlight.get(turnId) === recovery) {
        this.inFlight.delete(turnId);
      }
    });
    this.inFlight.set(turnId, recovery);
    return recovery;
  }

  private async recoverTurnOnce(
    turnId: string,
  ): Promise<ModelInvocationStartupRecoveryResult> {
    const turn = this.options.lifecycleStore.getTurn(turnId);
    if (turn === undefined) {
      return { turnId, action: "skipped", diagnosticCode: "turn_not_found" };
    }
    const invocation = latestInvocationForTurn(
      this.options.modelInvocationStore.list(),
      turnId,
    );
    if (invocation === undefined) {
      return { turnId, action: "skipped", diagnosticCode: "invocation_not_found" };
    }

    if (invocation.status === "submitted") {
      this.options.modelInvocationStore.markOutcomeUnknown(
        invocation.invocationId,
        "startup_recovery_blocked_after_submit",
      );
      await this.options.persist();
      return blocked(
        turnId,
        invocation,
        "submitted_outcome_unknown",
      );
    }
    if (invocation.status === "outcome_unknown") {
      return blocked(turnId, invocation, "outcome_unknown_requires_explicit_resolution");
    }
    if (
      this.options.canReplayTurn !== undefined &&
      !this.options.canReplayTurn(turnId)
    ) {
      return blocked(turnId, invocation, "turn_owned_by_execution_recovery");
    }
    if (invocation.status === "response_received") {
      if (invocation.purpose === "compaction") {
        return explicitResumeRequired(turnId, invocation);
      }
      return this.replayResponse(turnId, invocation);
    }
    if (invocation.status === "committed") {
      return invocation.targetCommitKey === `turn:${turnId}:assistant`
        ? this.completeCommittedTurn(turnId, invocation)
        : explicitResumeRequired(turnId, invocation);
    }
    return blocked(
      turnId,
      invocation,
      `startup_recovery_blocked_${invocation.status}`,
    );
  }

  private async replayResponse(
    turnId: string,
    invocation: ModelInvocation,
  ): Promise<ModelInvocationStartupRecoveryResult> {
    const result = invocation.normalizedResult;
    if (result === undefined || invocation.providerResponseId === undefined) {
      return blocked(turnId, invocation, "response_received_incomplete");
    }
    if (result.functionCalls.length > 0) {
      return this.continueToolBackedResponse(turnId, invocation);
    }
    if (result.text.length === 0) {
      return blocked(turnId, invocation, "response_received_has_no_assistant_text");
    }
    const turn = this.options.lifecycleStore.getTurn(turnId);
    if (turn?.status !== "interrupted") {
      return blocked(turnId, invocation, `turn_status_${turn?.status ?? "missing"}`);
    }

    this.options.lifecycleStore.resumeInterruptedTurn(turnId);
    this.options.lifecycleStore.appendItem(
      turnId,
      "assistant_message",
      { text: result.text },
    );
    this.options.lifecycleStore.completeTurn(turnId);
    this.options.modelInvocationStore.markCommitted(
      invocation.invocationId,
      `turn:${turnId}:assistant`,
    );
    await this.options.persist();
    return {
      turnId,
      action: "replayed_response",
      invocationId: invocation.invocationId,
    };
  }

  private async continueToolBackedResponse(
    turnId: string,
    invocation: ModelInvocation,
  ): Promise<ModelInvocationStartupRecoveryResult> {
    const modelResult = invocation.normalizedResult!;
    const toolStore = this.options.toolInvocationStore;
    if (toolStore === undefined) {
      return blocked(
        turnId,
        invocation,
        "response_received_requires_tool_wal",
      );
    }
    for (const call of modelResult.functionCalls) {
      const toolInvocationId = createToolInvocationId({
        modelInvocationId: invocation.invocationId,
        callId: call.callId,
        toolName: call.name,
        argumentsDigest: createToolArgumentsDigest(call.arguments),
      });
      const toolInvocation = toolStore.get(toolInvocationId);
      if (toolInvocation === undefined) {
        return blocked(
          turnId,
          invocation,
          "tool_invocation_missing",
        );
      }
      if (toolInvocation.status === "executing") {
        toolStore.markOutcomeUnknown(
          toolInvocationId,
          "process_recovered_during_tool_execution",
        );
        await this.options.persist();
        return blocked(
          turnId,
          invocation,
          "tool_invocation_outcome_unknown",
        );
      }
      if (toolInvocation.status === "prepared") {
        return blocked(
          turnId,
          invocation,
          "tool_invocation_not_executed",
        );
      }
      if (toolInvocation.status === "outcome_unknown") {
        return blocked(
          turnId,
          invocation,
          "tool_invocation_outcome_unknown",
        );
      }
      if (
        toolInvocation.result === undefined ||
        toolInvocation.output === undefined
      ) {
        return blocked(
          turnId,
          invocation,
          "tool_invocation_result_incomplete",
        );
      }
    }
    return explicitResumeRequired(turnId, invocation);
  }

  private async completeCommittedTurn(
    turnId: string,
    invocation: ModelInvocation,
  ): Promise<ModelInvocationStartupRecoveryResult> {
    if (invocation.targetCommitKey !== `turn:${turnId}:assistant`) {
      return blocked(turnId, invocation, "committed_without_assistant_commit");
    }
    const hasAssistant = this.options.lifecycleStore
      .getItemsForTurn(turnId)
      .some((item) => item.type === "assistant_message");
    if (!hasAssistant) {
      return blocked(turnId, invocation, "committed_assistant_item_missing");
    }
    this.options.lifecycleStore.completeInterruptedTurn(turnId);
    await this.options.persist();
    return {
      turnId,
      action: "completed_turn",
      invocationId: invocation.invocationId,
    };
  }
}

function latestInvocationForTurn(
  invocations: readonly ModelInvocation[],
  turnId: string,
): ModelInvocation | undefined {
  return invocations
    .filter((invocation) => invocation.turnId === turnId)
    .sort((left, right) =>
      left.round - right.round ||
      left.updatedAt.localeCompare(right.updatedAt))
    .at(-1);
}

function blocked(
  turnId: string,
  invocation: ModelInvocation,
  diagnosticCode: string,
): ModelInvocationStartupRecoveryResult {
  return {
    turnId,
    action: "blocked",
    invocationId: invocation.invocationId,
    diagnosticCode,
  };
}

function explicitResumeRequired(
  turnId: string,
  invocation: ModelInvocation,
): ModelInvocationStartupRecoveryResult {
  return blocked(turnId, invocation, "explicit_resume_required");
}
