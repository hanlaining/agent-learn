import type {
  LlmCreateResponseRequest,
  LlmFunctionOutput,
  LlmMessage,
  LlmProvider,
  LlmResponse,
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
  createModelRequestDigest,
  type ModelInvocation,
  type ModelInvocationNormalizedResult,
} from "../runtime/model-invocation.js";
import type {
  ModelInvocationStore,
} from "../runtime/model-invocation-store.js";
import {
  createToolArgumentsDigest,
  createToolInvocationId,
} from "../runtime/tool-invocation.js";
import type {
  ToolInvocation,
  ToolInvocationNormalizedResult,
} from "../runtime/tool-invocation.js";
import type {
  ToolInvocationStore,
} from "../runtime/tool-invocation-store.js";
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
const TOOL_ROUND_FINALIZATION_INSTRUCTIONS = `工具预算已经用尽。不得再调用任何工具；必须只依据当前对话中已有的 Return、Evidence 和工具结果，直接给用户输出完整最终答复。不要声称执行了尚未执行的工具。`;

interface ModelRequestResult {
  response: LlmResponse;
  invocationId?: string;
}

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
    taskId?: string; taskTitle?: string; jobAttempt?: number;
    workflowVersion?: string; stageId?: string; stageAttempt?: number;
  } | undefined;
  modelInvocationWal?: {
    store: ModelInvocationStore;
    persist: () => Promise<void>;
    provider: string;
    defaultModel: string;
  };
  toolInvocationWal?: {
    store: ToolInvocationStore;
    persist: () => Promise<void>;
  };
}

export interface AgentInvocationContext {
  threadId?: string;
  jobId?: string;
  agentId?: string;
  agentName?: string;
  taskId?: string;
  taskTitle?: string;
  jobAttempt?: number;
  workflowVersion?: string;
  stageId?: string;
  stageAttempt?: number;
}

export interface AgentRunOptions {
  model?: string;
  reasoningEffort?: LlmCreateResponseRequest["reasoningEffort"];
  instructions?: string;
  allowedTools?: string[];
  allowedSkills?: string[];
  modelInvocationPurpose?: string;
  invocationContext?: AgentInvocationContext;
  finalResponseGuard?: {
    reject: (text: string) => string | undefined;
    repairInstructions: string;
    maxRepairAttempts?: number;
  };
}

export class ModelInvocationOutcomeUnknownError extends Error {
  constructor(readonly invocationId: string, options?: ErrorOptions) {
    super(`Model invocation outcome_unknown: ${invocationId}`, options);
    this.name = "ModelInvocationOutcomeUnknownError";
  }
}

export class ToolInvocationOutcomeUnknownError extends Error {
  constructor(readonly toolInvocationId: string, options?: ErrorOptions) {
    super(`Tool invocation outcome_unknown: ${toolInvocationId}`, options);
    this.name = "ToolInvocationOutcomeUnknownError";
  }
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
  private readonly modelInvocationWal?: AgentLoopOptions["modelInvocationWal"];
  private readonly toolInvocationWal?: AgentLoopOptions["toolInvocationWal"];
  private readonly activeTurns = new Map<
    TurnId,
    AbortController
  >();
  private readonly toolInvocationInFlight = new Map<
    string,
    Promise<LlmFunctionOutput>
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
    this.modelInvocationWal = options.modelInvocationWal;
    this.toolInvocationWal = options.toolInvocationWal;
    if (this.toolInvocationWal !== undefined && this.modelInvocationWal === undefined) {
      throw new Error("Tool invocation WAL requires model invocation WAL");
    }

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
    const committedTurn = this.replayCommittedTurn(turnId);
    if (committedTurn !== undefined) return committedTurn;
    if (this.activeTurns.has(turnId)) {
      throw new Error(`Turn is already running: ${turnId}`);
    }
    if (this.lifecycleStore.getTurn(turnId)?.status === "interrupted") {
      this.lifecycleStore.resumeInterruptedTurn(turnId);
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

  private replayCommittedTurn(turnId: TurnId): TurnRunResult | undefined {
    if (this.modelInvocationWal === undefined) return undefined;
    const turn = this.lifecycleStore.getTurn(turnId);
    if (turn?.status !== "completed") return undefined;
    const hasCommittedAssistant = this.modelInvocationWal.store
      .list("committed")
      .some((invocation) => invocation.turnId === turnId &&
        invocation.targetCommitKey === `turn:${turnId}:assistant`);
    if (!hasCommittedAssistant) return undefined;
    const assistantMessage = this.lifecycleStore.getItemsForTurn(turnId)
      .findLast((item) => item.type === "assistant_message");
    if (assistantMessage === undefined) {
      throw new Error(`Committed model invocation has no Assistant item: ${turnId}`);
    }
    return { turn, assistantMessage };
  }

  private async runActiveTurn(
    turnId: TurnId,
    signal: AbortSignal,
    options: AgentRunOptions,
  ): Promise<TurnRunResult> {
    try {
      signal.throwIfAborted();
      let modelInvocationRound = this.nextModelInvocationRound(turnId);
      const invokeModel = (
        eventRound: number,
        purpose: string,
        request: Omit<LlmCreateResponseRequest, "onEvent">,
      ) => this.requestModel(
        turnId,
        eventRound,
        () => modelInvocationRound++,
        purpose,
        request,
        options.invocationContext,
      );
      let input = this.contextBuilder.build(turnId);
      const tokenBudget = this.tokenBudget.assess(input);
      const itemBudget = this.itemBudget.assess(input);
      let checkpointMessages: LlmMessage[] | undefined;
      let compactedTokens: number | undefined;

      if (
        tokenBudget.shouldCompact ||
        itemBudget.shouldCompact
      ) {
        let compactionModelResult: ModelRequestResult | undefined;
        input = this.modelInvocationWal === undefined
          ? await this.contextCompactor.compact(input, signal)
          : await this.contextCompactor.compact(input, signal, async (request) => {
              compactionModelResult = await invokeModel(0, "compaction", request);
              return compactionModelResult.response;
            });
        if (compactionModelResult !== undefined) {
          await this.commitModelInvocation(
            compactionModelResult,
            `turn:${turnId}:compaction`,
          );
        }
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

      let currentModelInput: readonly import("../llm/types.js").LlmInputItem[] = input;
      let currentPreviousResponseId: string | undefined;
      let modelResult = await invokeModel(0, options.modelInvocationPurpose ?? "initial", {
        instructions: options.instructions ?? this.instructions,
        input: currentModelInput,
        tools: this.toolRegistry.getDefinitions(options.allowedTools),
        signal,
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: options.reasoningEffort }),
      });
      let response = modelResult.response;
      let finalResponseRepairAttempts = 0;

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

          const finalResponseGuard = options.finalResponseGuard;
          const rejection = finalResponseGuard?.reject(response.text);
          if (rejection !== undefined && finalResponseGuard !== undefined) {
            const maxRepairAttempts = finalResponseGuard.maxRepairAttempts ?? 1;
            if (finalResponseRepairAttempts >= maxRepairAttempts) {
              throw new Error("LLM repeatedly returned an invalid final response");
            }
            finalResponseRepairAttempts += 1;
            await this.commitModelInvocation(
              modelResult,
              `turn:${turnId}:format-rejected:${finalResponseRepairAttempts}`,
            );
            modelResult = await invokeModel(round, "format_repair", {
              instructions: `${options.instructions ?? this.instructions}\n\n${finalResponseGuard.repairInstructions}\n上一份候选答复未通过检查：${rejection}`,
              input: currentModelInput,
              ...(currentPreviousResponseId === undefined
                ? {}
                : { previousResponseId: currentPreviousResponseId }),
              tools: this.toolRegistry.getDefinitions(options.allowedTools),
              signal,
              ...(options.model === undefined ? {} : { model: options.model }),
              ...(options.reasoningEffort === undefined
                ? {}
                : { reasoningEffort: options.reasoningEffort }),
            });
            response = modelResult.response;
            round -= 1;
            continue;
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

          await this.commitModelInvocation(
            modelResult,
            `turn:${turnId}:assistant`,
          );

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
          const skippedOutputs = response.functionCalls.map((functionCall) => {
            const failure = {
              status: "failed" as const,
              errorCode: "tool_round_limit",
              message: "工具轮次预算已用尽，本次调用未执行。",
              retryable: false,
            };
            this.ensureToolCallItem(turnId, functionCall);
            this.ensureToolResultItem(turnId, functionCall, failure);
            return {
              callId: functionCall.callId,
              name: functionCall.name,
              arguments: functionCall.arguments,
              output: JSON.stringify(failure),
            } satisfies LlmFunctionOutput;
          });
          const safeSkippedOutputs = this.toolOutputLimiter.limit(skippedOutputs);
          currentModelInput = safeSkippedOutputs;
          currentPreviousResponseId = response.id;
          await this.commitModelInvocation(
            modelResult,
            `turn:${turnId}:tool-round:${round}`,
          );
          modelResult = await invokeModel(round + 1, "tool_continuation", {
            instructions: `${options.instructions ?? this.instructions}\n\n${TOOL_ROUND_FINALIZATION_INSTRUCTIONS}`,
            input: currentModelInput,
            ...(currentPreviousResponseId === undefined
              ? {}
              : { previousResponseId: currentPreviousResponseId }),
            tools: [],
            signal,
            ...(options.model === undefined ? {} : { model: options.model }),
            ...(options.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: options.reasoningEffort }),
          });
          response = modelResult.response;
          if (response.functionCalls.length > 0 || response.text.length === 0) {
            throw new Error("Agent finalization failed after tool round limit");
          }
          round -= 1;
          continue;
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

        const executeFunctionCallLegacy = async (
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

        const executeFunctionCall = (
          functionCall: (typeof response.functionCalls)[number],
        ): Promise<LlmFunctionOutput> => {
          if (this.toolInvocationWal === undefined) {
            return executeFunctionCallLegacy(functionCall);
          }
          if (modelResult.invocationId === undefined) {
            throw new Error("Tool invocation WAL requires a durable model invocation ID");
          }
          return this.executeFunctionCallWithWal({
            turnId,
            modelInvocationId: modelResult.invocationId,
            functionCall,
            signal,
            options,
          });
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

        currentModelInput = safeToolOutputs;
        currentPreviousResponseId = response.id;

        await this.commitModelInvocation(
          modelResult,
          `turn:${turnId}:tool-round:${round}`,
        );

        const continuationRequest = () => invokeModel(round + 1, "tool_continuation", {
            instructions: options.instructions ?? this.instructions,
            input: currentModelInput,
            ...(currentPreviousResponseId === undefined
              ? {}
              : { previousResponseId: currentPreviousResponseId }),
            tools: this.toolRegistry.getDefinitions(options.allowedTools),
            signal,
            ...(options.model === undefined ? {} : { model: options.model }),
            ...(options.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: options.reasoningEffort }),
          });
        const childRunIds = readAgentReturnRunIds(toolOutputs);
        modelResult = this.continueAfterAgentReturns === undefined
          ? await continuationRequest()
          : await this.continueAfterAgentReturns(turnId, childRunIds, continuationRequest);
        response = modelResult.response;
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
    eventRound: number,
    allocateInvocationRound: () => number,
    purpose: string,
    request: Omit<LlmCreateResponseRequest, "onEvent">,
    invocationContext?: AgentInvocationContext,
  ): Promise<ModelRequestResult> {
    // 所有业务模型请求（首次请求和每次 Tool 续轮）共用同一硬断言。
    this.itemBudget.assertWithinLimit(request.input);

    this.events.emit({
      type: "model/started",
      turnId,
      round: eventRound,
    });

    const wal = this.modelInvocationWal;
    const providerRequest = request;
    let invocationId: string | undefined;
    let response: LlmResponse;

    if (wal === undefined) {
      response = await this.createProviderResponse(turnId, eventRound, providerRequest);
    } else {
      const turn = this.lifecycleStore.getTurn(turnId);
      if (turn === undefined) throw new Error(`Turn not found: ${turnId}`);
      const executionContext = invocationContext ?? this.resolveExecutionContext?.(turnId);
      const model = providerRequest.model ?? wal.defaultModel;
      const requestDigest = createModelRequestDigest(modelRequestDigestInput(providerRequest, model));
      const persisted = wal.store.list()
        .filter((candidate) => candidate.turnId === turnId && candidate.purpose === purpose &&
          candidate.requestDigest === requestDigest && candidate.provider === wal.provider &&
          candidate.model === model && candidate.previousResponseId === providerRequest.previousResponseId)
        .sort((left, right) => right.round - left.round)[0];
      const prepared = persisted ?? wal.store.prepare({
        threadId: turn.threadId,
        turnId,
        round: allocateInvocationRound(),
        purpose,
        ...(executionContext?.jobId === undefined ? {} : { jobId: executionContext.jobId }),
        ...(executionContext?.jobAttempt === undefined ? {} : { jobAttempt: executionContext.jobAttempt }),
        ...(executionContext?.taskId === undefined ? {} : { taskId: executionContext.taskId }),
        ...(executionContext?.agentId === undefined ? {} : { runId: executionContext.agentId }),
        ...(executionContext?.workflowVersion === undefined ? {} : { workflowVersion: executionContext.workflowVersion }),
        ...(executionContext?.stageId === undefined ? {} : { stageId: executionContext.stageId }),
        ...(executionContext?.stageAttempt === undefined ? {} : { stageAttempt: executionContext.stageAttempt }),
        requestDigest,
        provider: wal.provider,
        model,
        ...(providerRequest.previousResponseId === undefined
          ? {}
          : { previousResponseId: providerRequest.previousResponseId }),
      });
      invocationId = prepared.invocationId;
      if (persisted === undefined) await wal.persist();

      if (prepared.status === "submitted") {
        wal.store.markOutcomeUnknown(invocationId, "process_recovered_after_submit");
        await wal.persist();
        throw new ModelInvocationOutcomeUnknownError(invocationId);
      }
      if (prepared.status === "outcome_unknown") {
        throw new ModelInvocationOutcomeUnknownError(invocationId);
      }
      if (prepared.status === "failed_terminal") {
        throw new Error(`Model invocation is terminal: ${invocationId}`);
      }
      if (prepared.status === "response_received" || prepared.status === "committed") {
        response = replayModelResponse(prepared);
      } else {
        wal.store.markSubmitted(invocationId);
        await wal.persist();
        try {
          response = await this.createProviderResponse(turnId, eventRound, providerRequest);
        } catch (error) {
          wal.store.markOutcomeUnknown(invocationId, "provider_call_outcome_unknown");
          await wal.persist();
          throw new ModelInvocationOutcomeUnknownError(invocationId, { cause: error });
        }
        wal.store.recordResponse(invocationId, {
          providerResponseId: response.id,
          normalizedResult: normalizeModelResponse(response),
        });
        await wal.persist();
      }
    }

    if (
      response.text.length > 0 ||
      response.functionCalls.length > 0
    ) {
      this.events.emit({
        type: "model/output_text_completed",
        turnId,
        round: eventRound,
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
      round: eventRound,
      functionCallCount: response.functionCalls.length,
    });

    return {
      response,
      ...(invocationId === undefined ? {} : { invocationId }),
    };
  }

  private createProviderResponse(
    turnId: TurnId,
    eventRound: number,
    request: Omit<LlmCreateResponseRequest, "onEvent">,
  ): Promise<LlmResponse> {
    return this.llm.createResponse({
      ...request,
      onEvent: (event) => this.handleModelStreamEvent(turnId, eventRound, event),
    });
  }

  private nextModelInvocationRound(turnId: TurnId): number {
    if (this.modelInvocationWal === undefined) return 0;
    const rounds = this.modelInvocationWal.store.list()
      .filter((invocation) => invocation.turnId === turnId)
      .map((invocation) => invocation.round);
    return rounds.length === 0 ? 0 : Math.max(...rounds) + 1;
  }

  private async commitModelInvocation(
    result: ModelRequestResult,
    targetCommitKey: string,
  ): Promise<void> {
    if (this.modelInvocationWal === undefined || result.invocationId === undefined) return;
    this.modelInvocationWal.store.markCommitted(result.invocationId, targetCommitKey);
    await this.modelInvocationWal.persist();
  }

  private executeFunctionCallWithWal(input: {
    turnId: TurnId;
    modelInvocationId: string;
    functionCall: { callId: string; name: string; arguments: string };
    signal: AbortSignal;
    options: AgentRunOptions;
  }): Promise<LlmFunctionOutput> {
    const identity = {
      modelInvocationId: input.modelInvocationId,
      callId: input.functionCall.callId,
      toolName: input.functionCall.name,
      argumentsDigest: createToolArgumentsDigest(input.functionCall.arguments),
    };
    const toolInvocationId = createToolInvocationId(identity);
    const existing = this.toolInvocationInFlight.get(toolInvocationId);
    if (existing !== undefined) return existing;
    const execution = this.executeFunctionCallWithWalOnce({
      ...input,
      identity,
      toolInvocationId,
    }).finally(() => {
      if (this.toolInvocationInFlight.get(toolInvocationId) === execution) {
        this.toolInvocationInFlight.delete(toolInvocationId);
      }
    });
    this.toolInvocationInFlight.set(toolInvocationId, execution);
    return execution;
  }

  private async executeFunctionCallWithWalOnce(input: {
    turnId: TurnId;
    modelInvocationId: string;
    functionCall: { callId: string; name: string; arguments: string };
    identity: {
      modelInvocationId: string;
      callId: string;
      toolName: string;
      argumentsDigest: string;
    };
    toolInvocationId: string;
    signal: AbortSignal;
    options: AgentRunOptions;
  }): Promise<LlmFunctionOutput> {
    const wal = this.toolInvocationWal!;
    const targetCommitKey = `turn:${input.turnId}:tool:${input.functionCall.callId}`;
    let invocation = wal.store.get(input.toolInvocationId);

    if (invocation === undefined) {
      const denied = await this.authorizeToolInvocation(input);
      if (denied !== undefined) return denied;
      this.ensureToolCallItem(input.turnId, input.functionCall);
      invocation = wal.store.prepare({ ...input.identity, targetCommitKey });
      await wal.persist();
    } else {
      invocation = wal.store.prepare({ ...input.identity, targetCommitKey });
    }

    if (invocation.status === "executing") {
      wal.store.markOutcomeUnknown(
        invocation.toolInvocationId,
        "process_recovered_during_tool_execution",
      );
      await wal.persist();
      throw new ToolInvocationOutcomeUnknownError(invocation.toolInvocationId);
    }
    if (invocation.status === "outcome_unknown") {
      throw new ToolInvocationOutcomeUnknownError(invocation.toolInvocationId);
    }
    if (invocation.status === "committed") {
      return replayToolResult(invocation, input.functionCall);
    }
    if (invocation.status === "result_received") {
      const output = replayToolResult(invocation, input.functionCall);
      this.ensureToolCallItem(input.turnId, input.functionCall);
      this.ensureToolResultItem(input.turnId, input.functionCall, invocation.result);
      wal.store.markCommitted(invocation.toolInvocationId, targetCommitKey);
      await wal.persist();
      return output;
    }

    this.ensureToolCallItem(input.turnId, input.functionCall);
    wal.store.markExecuting(invocation.toolInvocationId);
    await wal.persist();
    this.events.emit({
      type: "tool/started",
      turnId: input.turnId,
      callId: input.functionCall.callId,
      toolName: input.functionCall.name,
    });

    let normalizedResult: ToolInvocationNormalizedResult;
    try {
      const result = await this.toolRegistry.execute(
        input.functionCall.name,
        input.functionCall.arguments,
        input.signal,
        input.turnId,
        input.options.allowedTools,
      );
      normalizedResult = { result: result.result, output: result.output };
    } catch (error) {
      wal.store.markOutcomeUnknown(
        invocation.toolInvocationId,
        "tool_execution_outcome_unknown",
      );
      await wal.persist();
      throw new ToolInvocationOutcomeUnknownError(
        invocation.toolInvocationId,
        { cause: error },
      );
    }

    invocation = wal.store.recordResult(invocation.toolInvocationId, normalizedResult);
    await wal.persist();
    this.ensureToolResultItem(input.turnId, input.functionCall, invocation.result);
    wal.store.markCommitted(invocation.toolInvocationId, targetCommitKey);
    await wal.persist();
    this.events.emit({
      type: "tool/completed",
      turnId: input.turnId,
      callId: input.functionCall.callId,
      toolName: input.functionCall.name,
    });
    return replayToolResult(invocation, input.functionCall);
  }

  private async authorizeToolInvocation(input: {
    turnId: TurnId;
    functionCall: { callId: string; name: string; arguments: string };
    signal: AbortSignal;
    options: AgentRunOptions;
  }): Promise<LlmFunctionOutput | undefined> {
    const call = input.functionCall;
    if (!this.toolRegistry.isAllowed(call.name, input.options.allowedTools)) {
      throw new Error(`Tool is not allowed for this Agent: ${call.name}`);
    }
    if (call.name === "read_skill" && !isSkillAllowed(call.arguments, input.options.allowedSkills)) {
      throw new Error("Skill is not allowed for this Agent");
    }
    const permission = this.toolRegistry.requiresPermission(call.name)
      ? await this.requestToolPermission(
          input.turnId,
          call.callId,
          call.name,
          call.arguments,
          this.toolRegistry.getPermissionDescription(call.name, call.arguments),
          input.signal,
          input.options,
        )
      : { decision: "allow" as const };
    if (permission.decision === "allow") return undefined;
    const denial = { status: "denied", reason: permission.reason ?? "Permission denied" };
    this.ensureToolCallItem(input.turnId, call);
    this.ensureToolResultItem(input.turnId, call, denial);
    return {
      callId: call.callId,
      name: call.name,
      arguments: call.arguments,
      output: JSON.stringify(denial),
    };
  }

  private ensureToolCallItem(
    turnId: TurnId,
    functionCall: { callId: string; name: string; arguments: string },
  ): void {
    const exists = this.lifecycleStore.getItemsForTurn(turnId).some((item) =>
      item.type === "tool_call" && hasCallId(item.content, functionCall.callId));
    if (!exists) {
      this.lifecycleStore.appendItem(turnId, "tool_call", {
        callId: functionCall.callId,
        name: functionCall.name,
        arguments: functionCall.arguments,
      });
    }
  }

  private ensureToolResultItem(
    turnId: TurnId,
    functionCall: { callId: string; name: string },
    result: unknown,
  ): void {
    const exists = this.lifecycleStore.getItemsForTurn(turnId).some((item) =>
      item.type === "tool_result" && hasCallId(item.content, functionCall.callId));
    if (!exists) {
      this.lifecycleStore.appendItem(turnId, "tool_result", {
        callId: functionCall.callId,
        name: functionCall.name,
        result,
      });
    }
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

function modelRequestDigestInput(
  request: Omit<LlmCreateResponseRequest, "onEvent">,
  model: string,
): unknown {
  return {
    model,
    instructions: request.instructions,
    input: request.input,
    tools: request.tools,
    allowHostedTools: request.allowHostedTools ?? true,
    reasoningEffort: request.reasoningEffort ?? null,
    previousResponseId: request.previousResponseId ?? null,
  };
}

function normalizeModelResponse(response: LlmResponse): ModelInvocationNormalizedResult {
  return {
    text: response.text,
    functionCalls: response.functionCalls.map((call) => ({
      callId: call.callId,
      name: call.name,
      arguments: call.arguments,
    })),
  };
}

function replayModelResponse(invocation: ModelInvocation): LlmResponse {
  if (invocation.providerResponseId === undefined || invocation.normalizedResult === undefined) {
    throw new Error(`Model invocation response is incomplete: ${invocation.invocationId}`);
  }
  return {
    id: invocation.providerResponseId,
    text: invocation.normalizedResult.text,
    functionCalls: invocation.normalizedResult.functionCalls.map((call) => ({ ...call })),
  };
}

function replayToolResult(
  invocation: Pick<ToolInvocation, "result" | "output" | "toolInvocationId">,
  functionCall: { callId: string; name: string; arguments: string },
): LlmFunctionOutput {
  if (invocation.output === undefined || invocation.result === undefined) {
    throw new Error(`Tool invocation result is incomplete: ${invocation.toolInvocationId}`);
  }
  return {
    callId: functionCall.callId,
    name: functionCall.name,
    arguments: functionCall.arguments,
    output: invocation.output,
  };
}

function hasCallId(value: unknown, callId: string): boolean {
  return typeof value === "object" && value !== null &&
    "callId" in value && value.callId === callId;
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
