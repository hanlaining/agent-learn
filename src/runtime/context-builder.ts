import type {
  LlmMessage,
} from "../llm/types.js";
import type {
  Item,
  Turn,
  TurnId,
} from "./lifecycle.js";
import {
  LifecycleError,
  type LifecycleStore,
} from "./lifecycle-store.js";
import type {
  ContextCheckpointStore,
} from "./context-checkpoint-store.js";

/**
 * 从 Runtime 事实记录中派生一次模型调用需要的消息历史。
 *
 * LifecycleStore 继续保存全部 Item；ContextBuilder 只决定哪些消息
 * 在当前切片中可以进入模型 Context。
 */
export class ContextBuilder {
  constructor(
    private readonly lifecycleStore: LifecycleStore,
    private readonly checkpointStore?: ContextCheckpointStore,
  ) {}

  build(currentTurnId: TurnId): LlmMessage[] {
    const currentTurn = this.requireTurn(currentTurnId);

    if (currentTurn.status !== "in_progress") {
      throw new LifecycleError(
        `Current Turn is not in progress: ${currentTurnId}`,
      );
    }

    const thread = this.lifecycleStore.getThread(
      currentTurn.threadId,
    );

    if (thread === undefined) {
      throw new LifecycleError(
        `Thread not found: ${currentTurn.threadId}`,
      );
    }

    const checkpoint = this.checkpointStore?.getLatest(
      thread.id,
    );

    if (checkpoint !== undefined) {
      return this.buildFromCheckpoint(
        currentTurn,
        thread.turnIds,
        checkpoint.throughTurnId,
        checkpoint.replacementMessages,
      );
    }

    const messages: LlmMessage[] = [];

    // turnIds 和 itemIds 就是 Runtime 的确定性插入顺序。
    // 不按 createdAt 排序，因为多个 Item 可能拥有相同时间戳。
    for (const turnId of thread.turnIds) {
      const turn = this.requireTurn(turnId);

      if (turn.id === currentTurn.id) {
        messages.push(this.readCurrentUserMessage(turn));
        return messages;
      }

      if (turn.status !== "completed") {
        continue;
      }

      for (
        const item of
          this.lifecycleStore.getItemsForTurn(turn.id)
      ) {
        const message = readHistoricalMessage(item);

        if (message !== undefined) {
          messages.push(message);
        }
      }
    }

    throw new LifecycleError(
      `Current Turn is not linked to its Thread: ${currentTurnId}`,
    );
  }

  private buildFromCheckpoint(
    currentTurn: Turn,
    turnIds: readonly TurnId[],
    throughTurnId: TurnId,
    replacementMessages: readonly LlmMessage[],
  ): LlmMessage[] {
    const messages = replacementMessages.map(
      (message) => ({ ...message }),
    );
    let reachedCheckpointBoundary = false;

    for (const turnId of turnIds) {
      const turn = this.requireTurn(turnId);

      if (!reachedCheckpointBoundary) {
        if (turn.id !== throughTurnId) {
          continue;
        }

        reachedCheckpointBoundary = true;

        // Checkpoint 已经包含边界 Turn 的 user_message；Turn 成功后生成的
        // 最终 assistant_message 需要在这里补回，不能重复加入用户消息。
        if (turn.status === "completed") {
          this.appendCompletedMessages(
            messages,
            turn,
            false,
          );
        }

        continue;
      }

      if (turn.id === currentTurn.id) {
        messages.push(this.readCurrentUserMessage(turn));
        return messages;
      }

      if (turn.status === "completed") {
        this.appendCompletedMessages(messages, turn, true);
      }
    }

    if (!reachedCheckpointBoundary) {
      throw new LifecycleError(
        `Checkpoint Turn is not linked to Thread: ${throughTurnId}`,
      );
    }

    throw new LifecycleError(
      `Current Turn is not linked to its Thread: ${currentTurn.id}`,
    );
  }

  private appendCompletedMessages(
    messages: LlmMessage[],
    turn: Turn,
    includeUserMessages: boolean,
  ): void {
    for (
      const item of
        this.lifecycleStore.getItemsForTurn(turn.id)
    ) {
      if (
        !includeUserMessages &&
        item.type === "user_message"
      ) {
        continue;
      }

      const message = readHistoricalMessage(item);

      if (message !== undefined) {
        messages.push(message);
      }
    }
  }

  private requireTurn(turnId: TurnId): Turn {
    const turn = this.lifecycleStore.getTurn(turnId);

    if (turn === undefined) {
      throw new LifecycleError(`Turn not found: ${turnId}`);
    }

    return turn;
  }

  private readCurrentUserMessage(turn: Turn): LlmMessage {
    const userMessage = this.lifecycleStore
      .getItemsForTurn(turn.id)
      .find((item) => item.type === "user_message");

    const text = readTextContent(userMessage);

    if (text === undefined) {
      throw new LifecycleError(
        `Current Turn has no valid user message: ${turn.id}`,
      );
    }

    // 当前消息只在这里追加一次，避免历史遍历和当前输入重复收集。
    return {
      role: "user",
      text,
    };
  }
}

function readHistoricalMessage(
  item: Item,
): LlmMessage | undefined {
  if (
    item.type !== "user_message" &&
    item.type !== "assistant_message"
  ) {
    // 第一版跨 Turn Context 不回放 Tool 执行轨迹。
    return undefined;
  }

  const text = readTextContent(item);

  if (text === undefined) {
    throw new LifecycleError(
      `Message Item has no valid text: ${item.id}`,
    );
  }

  return {
    role:
      item.type === "user_message"
        ? "user"
        : "assistant",
    text,
  };
}

function readTextContent(
  item: Item | undefined,
): string | undefined {
  if (
    item === undefined ||
    typeof item.content !== "object" ||
    item.content === null ||
    !("text" in item.content) ||
    typeof item.content.text !== "string"
  ) {
    return undefined;
  }

  return "modelText" in item.content && typeof item.content.modelText === "string"
    ? item.content.modelText
    : item.content.text;
}
