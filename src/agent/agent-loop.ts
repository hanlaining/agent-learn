import type {
  LlmCreateResponseRequest,
  LlmFunctionOutput,
  LlmProvider,
  LlmStreamEvent,
} from "../llm/types.js";
import type {
  Item,
  TurnId,
} from "../runtime/lifecycle.js";
import type {
  LifecycleStore,
} from "../runtime/lifecycle-store.js";
import type {
  TurnRunResult,
} from "../runtime/turn-run.js";
import {
  createFinanceSummaryModelOutput,
  executeFinanceMonthlySummaryTool,
  FINANCE_MONTHLY_SUMMARY_TOOL_NAME,
  financeMonthlySummaryTool,
} from "../tools/finance-monthly-summary-tool.js";
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
}

/**
 * 最小 Agent Loop：Model → Tool → Model，直到得到最终文本。
 */
export class AgentLoop {
  private readonly lifecycleStore: LifecycleStore;
  private readonly llm: LlmProvider;
  private readonly events: AgentEventSink;
  private readonly maxToolRounds: number;

  constructor(options: AgentLoopOptions) {
    this.lifecycleStore = options.lifecycleStore;
    this.llm = options.llm;
    this.events = options.events ?? NOOP_AGENT_EVENT_SINK;
    this.maxToolRounds = options.maxToolRounds ?? 3;
  }

  async run(turnId: TurnId): Promise<TurnRunResult> {
    try {
      const input = this.readUserInput(turnId);

      let response = await this.requestModel(turnId, 0, {
        instructions: AGENT_INSTRUCTIONS,
        input,
        tools: [financeMonthlySummaryTool],
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
            type: "tool/started",
            turnId,
            callId: functionCall.callId,
            toolName: functionCall.name,
          });

          if (
            functionCall.name !==
            FINANCE_MONTHLY_SUMMARY_TOOL_NAME
          ) {
            throw new Error(
              `Unknown tool: ${functionCall.name}`,
            );
          }

          const result = executeFinanceMonthlySummaryTool(
            functionCall.arguments,
          );

          this.lifecycleStore.appendItem(
            turnId,
            "tool_result",
            {
              callId: functionCall.callId,
              name: functionCall.name,
              result,
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
            output: JSON.stringify(
              createFinanceSummaryModelOutput(result),
            ),
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
          tools: [financeMonthlySummaryTool],
          },
        );
      }

      throw new Error("Agent loop ended unexpectedly");
    } catch (error) {
      const turn = this.lifecycleStore.getTurn(turnId);

      if (turn?.status === "in_progress") {
        this.lifecycleStore.failTurn(turnId);
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

  private readUserInput(turnId: TurnId): string {
    const userMessage = this.lifecycleStore
      .getItemsForTurn(turnId)
      .find((item) => item.type === "user_message");

    const text = readTextContent(userMessage);

    if (text === undefined) {
      throw new Error(
        `Turn has no valid user message: ${turnId}`,
      );
    }

    return text;
  }
}

function readTextContent(item: Item | undefined): string | undefined {
  if (
    item === undefined ||
    typeof item.content !== "object" ||
    item.content === null ||
    !("text" in item.content) ||
    typeof item.content.text !== "string"
  ) {
    return undefined;
  }

  return item.content.text;
}
