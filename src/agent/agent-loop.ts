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
  InputItemBudgetExceededError,
  ItemBudget,
} from "../runtime/item-budget.js";
import {
  TokenBudget,
} from "../runtime/token-budget.js";
import {
  ToolOutputLimiter,
} from "../runtime/tool-output-limiter.js";
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

公开排查 Commentary 协议：
- 只要本轮准备调用 Tool、Search 或 Command，先用 1～2 句话面向用户说明准备检查什么，以及这一步要确认什么，再发起调用。
- 读取到关键结果后，如果还要继续调用 Tool、Search 或 Command，先说明已经确认的事实、这个事实意味着什么，以及下一步准备怎样验证。
- 证据不足时使用“目前发现”“当前迹象表明”或“这很可能是”，禁止把猜测写成已确认结论。
- 只有证据已经充分支持时，才使用“已经锁定根因：……”并简要给出依据。
- 开始边界、反例或回归验证前，明确说明准备验证哪些边界，以及成功或失败意味着什么。
- 只在排查目标、关键发现、判断或下一步发生实质变化时更新；不要为每个小操作重复同义状态。每次优先控制在 1～3 个短段落。
- Commentary 是给普通用户看的公开进度，不是完整内部计划、Raw Logs 或私有思维链。不要输出 Chain-of-Thought、隐藏推理、原始 Tool 参数、未限制的 Tool Result、Key、环境变量或完整敏感路径。
- 不要为了展示过程而编造发现、证据或根因。没有新的可靠事实时，只说明正在执行的安全动作。
- 最终回答与 Commentary 分开：先给结论和交付结果，再给关键证据、验证结果与剩余风险；不要逐字重复全部排查过程。

约束：
- 所有收入、支出、净现金流和分类金额必须来自工具结果。
- 不要自行计算、猜测或编造账本金额。
- 工具中的 Money.display 已由确定性代码换算为人民币元；回答时必须原样复制 display，禁止自行换算 minorUnits。
- 如果问题需要月度财务数据，调用 finance_monthly_summary。
- 最终回答先给结论，再列出关键数字；金额使用人民币元展示。
`.trim();

const SAFE_TOOL_COMMENTARY_FALLBACK = "正在检查相关实现……";

export interface AgentLoopOptions {
  lifecycleStore: LifecycleStore;
  llm: LlmProvider;
  events?: AgentEventSink;
  maxToolRounds?: number;
  tokenBudget?: TokenBudget;
  itemBudget?: ItemBudget;
  contextCompactor?: ContextCompactor;
  contextCheckpointStore?: ContextCheckpointStore;
  toolRegistry?: ToolRegistry;
  permissionGate?: PermissionGate;
  toolOutputLimiter?: ToolOutputLimiter;
  additionalInstructions?: string;
  turnTimeoutMs?: number;
  continueAfterAgentReturns?: <T>(turnId: TurnId, childRunIds: string[], continuation: () => Promise<T>) => Promise<T>;
  resolveExecutionContext?: (turnId: TurnId) => {
    threadId?: string; jobId?: string; agentId?: string; agentName?: string;
    taskId?: string; taskTitle?: string;
  } | undefined;
}

export interface AgentRunOptions {
  model?: string;
  reasoningEffort?: LlmCreateResponseRequest["reasoningEffort"];
  instructions?: string;
  allowedTools?: string[];
  allowedSkills?: string[];
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
  private readonly itemBudget: ItemBudget;
  private readonly contextCompactor: ContextCompactor;
  private readonly contextCheckpointStore: ContextCheckpointStore;
  private readonly toolRegistry: ToolRegistry;
  private readonly permissionGate: PermissionGate;
  private readonly toolOutputLimiter: ToolOutputLimiter;
  private readonly llm: LlmProvider;
  private readonly events: AgentEventSink;
  private readonly maxToolRounds: number;
  private readonly turnTimeoutMs: number;
  private readonly instructions: string;
  private readonly continueAfterAgentReturns?: AgentLoopOptions["continueAfterAgentReturns"];
  private readonly resolveExecutionContext?: AgentLoopOptions["resolveExecutionContext"];
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
    this.itemBudget =
      options.itemBudget ??
      new ItemBudget({
        maxInputItems: 128,
        compactThresholdItems: 120,
        // 当前 App Server 使用无状态续接，一个 Tool Output 编码为两个 items。
        functionOutputItemCost: 2,
      });
    this.contextCompactor =
      options.contextCompactor ??
      new ContextCompactor({
        llm: options.llm,
        // 与 Codex 本地压缩默认值一致，只回放最近 20k Token 的真实用户消息。
        retainedUserMessageTokens: 20_000,
      });
    this.toolRegistry =
      options.toolRegistry ??
      new ToolRegistry([
        financeMonthlySummaryAgentTool,
      ]);
    this.permissionGate =
      options.permissionGate ?? ALLOW_ALL_PERMISSION_GATE;
    this.toolOutputLimiter =
      options.toolOutputLimiter ??
      new ToolOutputLimiter({
        maxOutputTokens: 16_000,
      });
    this.llm = options.llm;
    this.events = options.events ?? NOOP_AGENT_EVENT_SINK;
    this.maxToolRounds = options.maxToolRounds ?? 3;
    this.turnTimeoutMs = options.turnTimeoutMs ?? 120_000;
    this.instructions = options.additionalInstructions === undefined
      ? AGENT_INSTRUCTIONS
      : `${AGENT_INSTRUCTIONS}\n\n${options.additionalInstructions.trim()}`;
    this.continueAfterAgentReturns = options.continueAfterAgentReturns;
    this.resolveExecutionContext = options.resolveExecutionContext;

    if (
      !Number.isInteger(this.turnTimeoutMs) ||
      this.turnTimeoutMs <= 0
    ) {
      throw new Error(
        "turnTimeoutMs must be a positive integer",
      );
    }
  }

  async run(
    turnId: TurnId,
    options: AgentRunOptions = {},
  ): Promise<TurnRunResult> {
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
        options,
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
    options: AgentRunOptions,
  ): Promise<TurnRunResult> {
    try {
      signal.throwIfAborted();
      let input = this.contextBuilder.build(turnId);
      const tokenBudget = this.tokenBudget.assess(input);
      const itemBudget = this.itemBudget.assess(input);
      let checkpointMessages: LlmMessage[] | undefined;
      let compactedTokens: number | undefined;

      if (
        tokenBudget.shouldCompact ||
        itemBudget.shouldCompact
      ) {
        input = await this.contextCompactor.compact(
          input,
          signal,
        );
        // Compaction 不是越过硬上限的许可证，替换历史必须重新接受双预算检查。
        this.itemBudget.assertWithinLimit(input);
        checkpointMessages = input;
        compactedTokens =
          this.tokenBudget.assess(input).estimatedTokens;

        this.events.emit({
          type: "context/compacted",
          turnId,
          beforeTokens: tokenBudget.estimatedTokens,
          afterTokens: compactedTokens,
        });
      }

      let response = await this.requestModel(turnId, 0, {
        instructions: options.instructions ?? this.instructions,
        input,
        tools: this.toolRegistry.getDefinitions(options.allowedTools),
        signal,
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: options.reasoningEffort }),
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
              beforeTokens: tokenBudget.estimatedTokens,
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

        // 无状态续轮会把每个逻辑 Tool Output 编码成完整的
        // function_call + function_call_output。必须在权限请求和 Tool 执行前
        // 拒绝必然越过 Provider 硬上限的整轮调用，避免产生任何副作用。
        const functionOutputBudget =
          this.itemBudget.assessFunctionOutputCount(
            response.functionCalls.length,
          );

        if (functionOutputBudget.exceedsLimit) {
          throw new InputItemBudgetExceededError(
            functionOutputBudget.estimatedItems,
            functionOutputBudget.maxInputItems,
          );
        }

        const executeFunctionCall = async (
          functionCall: (typeof response.functionCalls)[number],
        ): Promise<LlmFunctionOutput> => {
          const permissionDescription =
            this.toolRegistry.getPermissionDescription(
              functionCall.name,
              functionCall.arguments,
            );
          const requiresPermission =
            this.toolRegistry.requiresPermission(
              functionCall.name,
            );

          if (!this.toolRegistry.isAllowed(functionCall.name, options.allowedTools)) {
            throw new Error(`Tool is not allowed for this Agent: ${functionCall.name}`);
          }
          if (functionCall.name === "read_skill" && !isSkillAllowed(functionCall.arguments, options.allowedSkills)) {
            throw new Error("Skill is not allowed for this Agent");
          }

          this.lifecycleStore.appendItem(
            turnId,
            "tool_call",
            {
              callId: functionCall.callId,
              name: functionCall.name,
              arguments: functionCall.arguments,
            },
          );

          const permission = requiresPermission
            ? await this.requestToolPermission(
                turnId,
                functionCall.callId,
                functionCall.name,
                functionCall.arguments,
                permissionDescription,
                signal,
                options,
              )
            : { decision: "allow" as const };

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

            return {
              callId: functionCall.callId,
              name: functionCall.name,
              arguments: functionCall.arguments,
              output: JSON.stringify(denialResult),
            };
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
            turnId,
            options.allowedTools,
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

          return {
            callId: functionCall.callId,
            name: functionCall.name,
            arguments: functionCall.arguments,
            output: execution.output,
          };
        };

        // 模型一次委派多个子 Agent 时必须真正并行；普通工具仍保持确定性串行，
        // 避免多个写操作或权限弹窗互相竞争。
        const toolOutputs: LlmFunctionOutput[] =
          response.functionCalls.every((call) => call.name === "run_agent")
            ? await Promise.all(response.functionCalls.map(executeFunctionCall))
            : [];
        if (toolOutputs.length === 0) {
          for (const functionCall of response.functionCalls) {
            toolOutputs.push(await executeFunctionCall(functionCall));
          }
        }

        // previous_response_id 让模型在原推理上下文中读取 Tool 结果。
        const safeToolOutputs =
          this.toolOutputLimiter.limit(toolOutputs);

        const continuationRequest = () => this.requestModel(turnId, round + 1, {
            instructions: options.instructions ?? this.instructions,
            input: safeToolOutputs,
            previousResponseId: response.id,
            tools: this.toolRegistry.getDefinitions(options.allowedTools),
            signal,
            ...(options.model === undefined ? {} : { model: options.model }),
            ...(options.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: options.reasoningEffort }),
          });
        const childRunIds = readAgentReturnRunIds(toolOutputs);
        response = this.continueAfterAgentReturns === undefined
          ? await continuationRequest()
          : await this.continueAfterAgentReturns(turnId, childRunIds, continuationRequest);
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
    // 所有业务模型请求（首次请求和每次 Tool 续轮）共用同一硬断言。
    this.itemBudget.assertWithinLimit(request.input);

    this.events.emit({
      type: "model/started",
      turnId,
      round,
    });

    const response = await this.llm.createResponse({
      ...request,
      onEvent: (event) => {
        this.handleModelStreamEvent(turnId, round, event);
      },
    });

    if (
      response.text.length > 0 ||
      response.functionCalls.length > 0
    ) {
      this.events.emit({
        type: "model/output_text_completed",
        turnId,
        round,
        classification:
          response.functionCalls.length > 0
            ? "commentary"
            : "assistant",
        // 模型直接调用 Tool 时只补动作型状态；不包含 Tool 名、参数、路径、
        // 结果或未经证据支持的发现与根因。
        text: response.text.length > 0
          ? response.text
          : SAFE_TOOL_COMMENTARY_FALLBACK,
      });
    }

    this.events.emit({
      type: "model/completed",
      turnId,
      round,
      functionCallCount: response.functionCalls.length,
    });

    return response;
  }

  private async requestToolPermission(
    turnId: TurnId,
    callId: string,
    toolName: string,
    argumentsJson: string,
    description: string | undefined,
    signal: AbortSignal,
    options: AgentRunOptions,
  ) {
    this.events.emit({
      type: "permission/requested",
      turnId,
      callId,
      toolName,
    });

    const executionContext = this.resolveExecutionContext?.(turnId);
    const permission = await waitForAbortable(
      this.permissionGate.request({
        turnId,
        ...executionContext,
        callId,
        toolName,
        arguments: argumentsJson,
        riskLevel: this.toolRegistry.getRiskLevel(toolName),
        ...(description === undefined
          ? {}
          : { description }),
      }),
      signal,
    );

    this.events.emit({
      type: "permission/decided",
      turnId,
      callId,
      toolName,
      decision: permission.decision,
      ...(permission.decision === "deny" &&
      permission.reason !== undefined
        ? { reason: permission.reason }
        : {}),
    });

    return permission;
  }

  private handleModelStreamEvent(
    turnId: TurnId,
    round: number,
    event: LlmStreamEvent,
  ): void {
    if (event.type === "reasoning_summary_part_added") {
      this.events.emit({
        type: "reasoning/summary_part_added",
        turnId,
        round,
        summaryIndex: event.summaryIndex,
      });
      return;
    }

    if (event.type === "reasoning_summary_completed") {
      this.events.emit({
        type: "reasoning/summary_completed",
        turnId,
        round,
      });
      return;
    }

    if (event.type === "reasoning_summary_delta") {
      this.events.emit({
        type: "reasoning/summary_delta",
        turnId,
        round,
        summaryIndex: event.summaryIndex,
        delta: event.delta,
      });
      return;
    }

    if (event.type === "web_search_started") {
      this.events.emit({
        type: "web_search/started",
        turnId,
        callId: event.callId,
      });
      return;
    }

    if (event.type === "web_search_searching") {
      this.events.emit({
        type: "web_search/searching",
        turnId,
        callId: event.callId,
      });
      return;
    }

    if (event.type === "web_search_completed") {
      this.events.emit({
        type: "web_search/completed",
        turnId,
        callId: event.callId,
        ...(event.query === undefined
          ? {}
          : { query: event.query }),
      });
      return;
    }

    if (event.type === "url_citation_added") {
      this.events.emit({
        type: "citation/url_added",
        turnId,
        title: event.title,
        url: event.url,
        startIndex: event.startIndex,
        endIndex: event.endIndex,
      });
      return;
    }

    this.events.emit({
      type: "model/output_text_delta",
      turnId,
      round,
      delta: event.delta,
    });
  }

}

function isSkillAllowed(argumentsJson: string, allowedSkills: readonly string[] = ["*"]): boolean {
  if (allowedSkills.includes("*")) return true;
  try { const value = JSON.parse(argumentsJson) as { name?: unknown }; return typeof value.name === "string" && allowedSkills.includes(value.name); }
  catch { return false; }
}

function readAgentReturnRunIds(outputs: readonly LlmFunctionOutput[]): string[] {
  const ids: string[] = [];
  for (const output of outputs) {
    try {
      const value = JSON.parse(output.output) as unknown;
      if (typeof value === "object" && value !== null && "type" in value && value.type === "run_return" &&
        "runId" in value && typeof value.runId === "string") ids.push(value.runId);
    } catch {
      // 普通 Tool 输出不是 Agent Return，保持原有 continuation 路径。
    }
  }
  return ids;
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
