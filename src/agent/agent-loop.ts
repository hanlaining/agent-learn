import type {
  LlmCreateResponseRequest,
  LlmFunctionOutput,
  LlmMessage,
  LlmProvider,
  LlmStreamEvent,
} from "../llm/types.js";
import type {
  TurnId,
} from "../runtime/lifecycle.js";
import {
  ContextBuilder,
} from "../runtime/context-builder.js";
import {
  ContextCompactor,
} from "../runtime/context-compactor.js";
import {
  ContextCheckpointStore,
} from "../runtime/context-checkpoint-store.js";
import {
  TokenBudget,
} from "../runtime/token-budget.js";
import type {
  LifecycleStore,
} from "../runtime/lifecycle-store.js";
import type {
  TurnRunResult,
} from "../runtime/turn-run.js";
import {
  financeMonthlySummaryAgentTool,
} from "../tools/finance-monthly-summary-tool.js";
import {
  ToolRegistry,
} from "../tools/tool-registry.js";
import {
  ALLOW_ALL_PERMISSION_GATE,
  type PermissionGate,
} from "../permissions/permission-gate.js";
import {
  NOOP_AGENT_EVENT_SINK,
  type AgentEventSink,
} from "./events.js";

const AGENT_INSTRUCTIONS = `
你是一个谨慎、简洁的个人财务助手。

目标：根据用户问题给出有数据依据的中文财务回答。

约束：
- 所有收入、支出、净现金流和分类金额必须来自工具结果。
- 不要自行计算、猜测或编造账本金额。
- 工具中的 Money.display 已由确定性代码换算为人民币元；回答时必须原样复制 display，禁止自行换算 minorUnits。
- 如果问题需要月度财务数据，调用 finance_monthly_summary。
- 最终回答先给结论，再列出关键数字；金额使用人民币元展示。
`.trim();

export interface AgentLoopOptions {
  lifecycleStore: LifecycleStore;
  llm: LlmProvider;
  events?: AgentEventSink;
  maxToolRounds?: number;
  tokenBudget?: TokenBudget;
  contextCompactor?: ContextCompactor;
  contextCheckpointStore?: ContextCheckpointStore;
  toolRegistry?: ToolRegistry;
  permissionGate?: PermissionGate;
  turnTimeoutMs?: number;
}

export class TurnCancelledError extends Error {
  constructor(readonly turnId: TurnId) {
    super(`Turn cancelled: ${turnId}`);
    this.name = "TurnCancelledError";
  }
}

export class TurnTimeoutError extends Error {
  constructor(
    readonly turnId: TurnId,
    readonly timeoutMs: number,
  ) {
    super(`Turn timed out after ${timeoutMs}ms: ${turnId}`);
    this.name = "TurnTimeoutError";
  }
}

/**
 * 最小 Agent Loop：Model → Tool → Model，直到得到最终文本。
 */
export class AgentLoop {
  private readonly lifecycleStore: LifecycleStore;
  private readonly contextBuilder: ContextBuilder;
  private readonly tokenBudget: TokenBudget;
  private readonly contextCompactor: ContextCompactor;
  private readonly contextCheckpointStore: ContextCheckpointStore;
  private readonly toolRegistry: ToolRegistry;
  private readonly permissionGate: PermissionGate;
  private readonly llm: LlmProvider;
  private readonly events: AgentEventSink;
  private readonly maxToolRounds: number;
  private readonly turnTimeoutMs: number;
  private readonly activeTurns = new Map<
    TurnId,
    AbortController
  >();

  constructor(options: AgentLoopOptions) {
    this.lifecycleStore = options.lifecycleStore;
    this.contextCheckpointStore =
      options.contextCheckpointStore ??
      new ContextCheckpointStore();
    this.contextBuilder = new ContextBuilder(
      options.lifecycleStore,
      this.contextCheckpointStore,
    );
    this.tokenBudget =
      options.tokenBudget ??
      new TokenBudget({
        maxContextTokens: 128_000,
        compactThresholdTokens: 96_000,
      });
    this.contextCompactor =
      options.contextCompactor ??
      new ContextCompactor({
        llm: options.llm,
        recentMessageTokens: 20_000,
      });
    this.toolRegistry =
      options.toolRegistry ??
      new ToolRegistry([
        financeMonthlySummaryAgentTool,
      ]);
    this.permissionGate =
      options.permissionGate ?? ALLOW_ALL_PERMISSION_GATE;
    this.llm = options.llm;
    this.events = options.events ?? NOOP_AGENT_EVENT_SINK;
    this.maxToolRounds = options.maxToolRounds ?? 3;
    this.turnTimeoutMs = options.turnTimeoutMs ?? 120_000;

    if (
      !Number.isInteger(this.turnTimeoutMs) ||
      this.turnTimeoutMs <= 0
    ) {
      throw new Error(
        "turnTimeoutMs must be a positive integer",
      );
    }
  }

  async run(turnId: TurnId): Promise<TurnRunResult> {
    if (this.activeTurns.has(turnId)) {
      throw new Error(`Turn is already running: ${turnId}`);
    }

    const controller = new AbortController();
    this.activeTurns.set(turnId, controller);
    const timeout = setTimeout(() => {
      controller.abort(
        new TurnTimeoutError(turnId, this.turnTimeoutMs),
      );
    }, this.turnTimeoutMs);

    try {
      return await this.runActiveTurn(
        turnId,
        controller.signal,
      );
    } finally {
      clearTimeout(timeout);
      this.activeTurns.delete(turnId);
    }
  }

  cancel(turnId: TurnId): boolean {
    const controller = this.activeTurns.get(turnId);

    if (controller === undefined) {
      return false;
    }

    controller.abort(new TurnCancelledError(turnId));
    return true;
  }

  private async runActiveTurn(
    turnId: TurnId,
    signal: AbortSignal,
  ): Promise<TurnRunResult> {
    try {
      signal.throwIfAborted();
      let input = this.contextBuilder.build(turnId);
      const budget = this.tokenBudget.assess(input);
      let checkpointMessages: LlmMessage[] | undefined;
      let compactedTokens: number | undefined;

      if (budget.shouldCompact) {
        input = await this.contextCompactor.compact(
          input,
          signal,
        );
        checkpointMessages = input;
        compactedTokens =
          this.tokenBudget.assess(input).estimatedTokens;

        this.events.emit({
          type: "context/compacted",
          turnId,
          beforeTokens: budget.estimatedTokens,
          afterTokens: compactedTokens,
        });
      }

      let response = await this.requestModel(turnId, 0, {
        instructions: AGENT_INSTRUCTIONS,
        input,
        tools: this.toolRegistry.getDefinitions(),
        signal,
      });

      for (
        let round = 0;
        round <= this.maxToolRounds;
        round += 1
      ) {
        if (response.functionCalls.length === 0) {
          if (response.text.length === 0) {
            throw new Error(
              "LLM returned no final assistant text",
            );
          }

          const assistantMessage =
            this.lifecycleStore.appendItem(
              turnId,
              "assistant_message",
              {
                text: response.text,
              },
            );

          const turn =
            this.lifecycleStore.completeTurn(turnId);

          if (
            checkpointMessages !== undefined &&
            compactedTokens !== undefined
          ) {
            // 只在 Turn 成功后安装窗口，失败 Turn 不污染后续 Context。
            this.contextCheckpointStore.record({
              threadId: turn.threadId,
              throughTurnId: turn.id,
              replacementMessages: checkpointMessages,
              beforeTokens: budget.estimatedTokens,
              afterTokens: compactedTokens,
            });
          }

          this.events.emit({
            type: "turn/completed",
            turnId,
          });

          return {
            turn,
            assistantMessage,
          };
        }

        if (round === this.maxToolRounds) {
          throw new Error(
            `Agent exceeded ${this.maxToolRounds} tool rounds`,
          );
        }

        const toolOutputs: LlmFunctionOutput[] = [];

        for (const functionCall of response.functionCalls) {
          const permissionDescription =
            this.toolRegistry.getPermissionDescription(
              functionCall.name,
              functionCall.arguments,
            );

          this.lifecycleStore.appendItem(
            turnId,
            "tool_call",
            {
              callId: functionCall.callId,
              name: functionCall.name,
              arguments: functionCall.arguments,
            },
          );

          this.events.emit({
            type: "permission/requested",
            turnId,
            callId: functionCall.callId,
            toolName: functionCall.name,
          });

          const permission = await waitForAbortable(
            this.permissionGate.request({
              turnId,
              callId: functionCall.callId,
              toolName: functionCall.name,
              arguments: functionCall.arguments,
              ...(permissionDescription === undefined
                ? {}
                : { description: permissionDescription }),
            }),
            signal,
          );

          this.events.emit({
            type: "permission/decided",
            turnId,
            callId: functionCall.callId,
            toolName: functionCall.name,
            decision: permission.decision,
            ...(permission.decision === "deny" &&
            permission.reason !== undefined
              ? { reason: permission.reason }
              : {}),
          });

          if (permission.decision === "deny") {
            const denialResult = {
              status: "denied",
              reason:
                permission.reason ?? "Permission denied",
            };

            this.lifecycleStore.appendItem(
              turnId,
              "tool_result",
              {
                callId: functionCall.callId,
                name: functionCall.name,
                result: denialResult,
              },
            );

            toolOutputs.push({
              callId: functionCall.callId,
              name: functionCall.name,
              arguments: functionCall.arguments,
              output: JSON.stringify(denialResult),
            });

            continue;
          }

          this.events.emit({
            type: "tool/started",
            turnId,
            callId: functionCall.callId,
            toolName: functionCall.name,
          });

          const execution = await this.toolRegistry.execute(
            functionCall.name,
            functionCall.arguments,
            signal,
          );

          this.lifecycleStore.appendItem(
            turnId,
            "tool_result",
            {
              callId: functionCall.callId,
              name: functionCall.name,
              result: execution.result,
            },
          );

          this.events.emit({
            type: "tool/completed",
            turnId,
            callId: functionCall.callId,
            toolName: functionCall.name,
          });

          toolOutputs.push({
            callId: functionCall.callId,
            name: functionCall.name,
            arguments: functionCall.arguments,
            output: execution.output,
          });
        }

        // previous_response_id 让模型在原推理上下文中读取 Tool 结果。
        response = await this.requestModel(
          turnId,
          round + 1,
          {
            instructions: AGENT_INSTRUCTIONS,
            input: toolOutputs,
            previousResponseId: response.id,
            tools: this.toolRegistry.getDefinitions(),
            signal,
          },
        );
      }

      throw new Error("Agent loop ended unexpectedly");
    } catch (error) {
      const turn = this.lifecycleStore.getTurn(turnId);
      const cancellation =
        signal.aborted &&
        signal.reason instanceof TurnCancelledError
          ? signal.reason
          : undefined;
      const timeout =
        signal.aborted &&
        signal.reason instanceof TurnTimeoutError
          ? signal.reason
          : undefined;

      if (turn?.status === "in_progress") {
        if (timeout !== undefined) {
          this.lifecycleStore.timeoutTurn(turnId);
        } else if (cancellation === undefined) {
          this.lifecycleStore.failTurn(turnId);
        } else {
          this.lifecycleStore.interruptTurn(turnId);
        }
      }

      if (cancellation !== undefined) {
        this.events.emit({
          type: "turn/interrupted",
          turnId,
          message: cancellation.message,
        });

        throw cancellation;
      }

      if (timeout !== undefined) {
        this.events.emit({
          type: "turn/timed_out",
          turnId,
          message: timeout.message,
        });

        throw timeout;
      }

      this.events.emit({
        type: "turn/failed",
        turnId,
        message:
          error instanceof Error
            ? error.message
            : "Unknown agent error",
      });

      throw error;
    }
  }

  private async requestModel(
    turnId: TurnId,
    round: number,
    request: Omit<LlmCreateResponseRequest, "onEvent">,
  ) {
    this.events.emit({
      type: "model/started",
      turnId,
      round,
    });

    const response = await this.llm.createResponse({
      ...request,
      onEvent: (event) => {
        this.handleModelStreamEvent(turnId, event);
      },
    });

    this.events.emit({
      type: "model/completed",
      turnId,
      round,
      functionCallCount: response.functionCalls.length,
    });

    return response;
  }

  private handleModelStreamEvent(
    turnId: TurnId,
    event: LlmStreamEvent,
  ): void {
    if (event.type === "reasoning_summary_delta") {
      this.events.emit({
        type: "reasoning/summary_delta",
        turnId,
        delta: event.delta,
      });
      return;
    }

    this.events.emit({
      type: "assistant/delta",
      turnId,
      delta: event.delta,
    });
  }

}

function waitForAbortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }

  return new Promise<T>((resolve, reject) => {
    const handleAbort = () => reject(signal.reason);

    signal.addEventListener("abort", handleAbort, {
      once: true,
    });

    void promise.then(
      (value) => {
        signal.removeEventListener("abort", handleAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", handleAbort);
        reject(error);
      },
    );
  });
}
