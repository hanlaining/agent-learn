import type {
  Item,
  ItemId,
  ItemType,
  Thread,
  ThreadId,
  Turn,
  TurnId,
} from "./lifecycle.js";

type IdPrefix =
  | "thread"
  | "turn"
  | "item";

export interface LifecycleStoreOptions {
  now?: () => string;
  createId?: (prefix: IdPrefix) => string;
}

export class LifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LifecycleError";
  }
}

export class LifecycleStore {
  private readonly threads = new Map<ThreadId, Thread>();
  private readonly turns = new Map<TurnId, Turn>();
  private readonly items = new Map<ItemId, Item>();

  private readonly now: () => string;
  private readonly createId: (prefix: IdPrefix) => string;

  private idSequence = 0;

  constructor(options: LifecycleStoreOptions = {}) {
    this.now =
      options.now ??
      (() => new Date().toISOString());

    this.createId =
      options.createId ??
      ((prefix) => {
        this.idSequence += 1;
        return `${prefix}-${this.idSequence}`;
      });
  }

  createThread(): Thread {
    const thread: Thread = {
      id: this.createId("thread"),
      status: "active",
      createdAt: this.now(),
      turnIds: [],
    };

    this.threads.set(thread.id, thread);

    return thread;
  }

  createTurn(threadId: ThreadId): Turn {
    const thread = this.requireThread(threadId);

    if (thread.status !== "active") {
      throw new LifecycleError(
        `Thread is not active: ${threadId}`,
      );
    }

    const turn: Turn = {
      id: this.createId("turn"),
      threadId,
      status: "in_progress",
      createdAt: this.now(),
      itemIds: [],
    };

    this.turns.set(turn.id, turn);
    thread.turnIds.push(turn.id);

    return turn;
  }

  appendItem(
    turnId: TurnId,
    type: ItemType,
    content: unknown,
  ): Item {
    const turn = this.requireTurn(turnId);

    if (turn.status !== "in_progress") {
      throw new LifecycleError(
        `Turn is not in progress: ${turnId}`,
      );
    }

    const item: Item = {
      id: this.createId("item"),
      threadId: turn.threadId,
      turnId,
      type,
      content,
      createdAt: this.now(),
    };

    this.items.set(item.id, item);
    turn.itemIds.push(item.id);

    return item;
  }

  completeTurn(turnId: TurnId): Turn {
    const turn = this.requireTurn(turnId);

    if (turn.status !== "in_progress") {
      throw new LifecycleError(
        `Turn cannot be completed: ${turnId}`,
      );
    }

    turn.status = "completed";
    turn.completedAt = this.now();

    return turn;
  }

  failTurn(turnId: TurnId): Turn {
    const turn = this.requireTurn(turnId);

    if (turn.status !== "in_progress") {
      throw new LifecycleError(
        `Turn cannot be failed: ${turnId}`,
      );
    }

    // LLM 或 Tool 失败也必须落到终态，不能永久卡在 in_progress。
    turn.status = "failed";
    turn.completedAt = this.now();

    return turn;
  }

  getThread(threadId: ThreadId): Thread | undefined {
    return this.threads.get(threadId);
  }

  getTurn(turnId: TurnId): Turn | undefined {
    return this.turns.get(turnId);
  }

  getItem(itemId: ItemId): Item | undefined {
    return this.items.get(itemId);
  }

  getItemsForTurn(turnId: TurnId): Item[] {
    const turn = this.requireTurn(turnId);

    return turn.itemIds.map((itemId) => {
      const item = this.items.get(itemId);

      if (item === undefined) {
        throw new LifecycleError(
          `Item not found: ${itemId}`,
        );
      }

      return item;
    });
  }

  private requireThread(threadId: ThreadId): Thread {
    const thread = this.threads.get(threadId);

    if (thread === undefined) {
      throw new LifecycleError(
        `Thread not found: ${threadId}`,
      );
    }

    return thread;
  }

  private requireTurn(turnId: TurnId): Turn {
    const turn = this.turns.get(turnId);

    if (turn === undefined) {
      throw new LifecycleError(
        `Turn not found: ${turnId}`,
      );
    }

    return turn;
  }
}
