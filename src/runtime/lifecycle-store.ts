import {
  isItem,
  isThread,
  isTurn,
  type Item,
  type ItemId,
  type ItemType,
  type Thread,
  type ThreadDeleteBatch,
  type ThreadId,
  type Turn,
  type TurnId,
} from "./lifecycle.js";

type IdPrefix =
  | "thread"
  | "turn"
  | "item";

export interface LifecycleStoreOptions {
  now?: () => string;
  createId?: (prefix: IdPrefix) => string;
}

export interface LifecycleSnapshot {
  version: 1;
  idSequence: number;
  threads: Thread[];
  turns: Turn[];
  items: Item[];
  deleteBatches?: ThreadDeleteBatch[];
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
  private readonly deleteBatches = new Map<string, ThreadDeleteBatch>();

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

  static fromSnapshot(
    value: unknown,
    options: LifecycleStoreOptions = {},
  ): LifecycleStore {
    const snapshot = parseLifecycleSnapshot(value);
    const store = new LifecycleStore(options);

    store.idSequence = snapshot.idSequence;

    for (const thread of snapshot.threads) {
      store.threads.set(thread.id, cloneThread(thread));
    }

    for (const turn of snapshot.turns) {
      store.turns.set(turn.id, cloneTurn(turn));
    }

    for (const item of snapshot.items) {
      store.items.set(item.id, cloneItem(item));
    }
    for (const batch of snapshot.deleteBatches ?? []) store.deleteBatches.set(batch.id, structuredClone(batch));

    return store;
  }

  exportSnapshot(): LifecycleSnapshot {
    return {
      version: 1,
      idSequence: this.idSequence,
      threads: [...this.threads.values()].map(cloneThread),
      turns: [...this.turns.values()].map(cloneTurn),
      items: [...this.items.values()].map(cloneItem),
      deleteBatches: this.listDeleteBatches(),
    };
  }

  createThread(): Thread {
    const thread: Thread = {
      id: this.createId("thread"),
      status: "active",
      createdAt: this.now(),
      lastActivityAt: this.now(),
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
    thread.lastActivityAt = turn.createdAt;

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
    this.requireThread(turn.threadId).lastActivityAt = item.createdAt;

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

  interruptTurn(turnId: TurnId): Turn {
    const turn = this.requireTurn(turnId);

    if (turn.status !== "in_progress") {
      throw new LifecycleError(
        `Turn cannot be interrupted: ${turnId}`,
      );
    }

    turn.status = "interrupted";
    turn.completedAt = this.now();

    return turn;
  }

  timeoutTurn(turnId: TurnId): Turn {
    const turn = this.requireTurn(turnId);

    if (turn.status !== "in_progress") {
      throw new LifecycleError(
        `Turn cannot time out: ${turnId}`,
      );
    }

    turn.status = "timed_out";
    turn.completedAt = this.now();

    return turn;
  }

  getThread(threadId: ThreadId): Thread | undefined {
    return this.threads.get(threadId);
  }

  listThreads(): Thread[] {
    return [...this.threads.values()];
  }

  listTrash(): Thread[] { return this.listThreads().filter((thread) => thread.deletedAt !== undefined).map(cloneThread); }
  listDeleteBatches(): ThreadDeleteBatch[] { return [...this.deleteBatches.values()].map((item) => structuredClone(item)); }

  renameThread(threadId: ThreadId, title: string): Thread {
    const normalized = title.replace(/\s+/g, " ").trim();
    if (normalized.length === 0 || [...normalized].length > 160) throw new LifecycleError("Invalid thread title");
    const thread = this.requireThread(threadId); thread.title = normalized; thread.lastActivityAt = this.now(); return cloneThread(thread);
  }

  softDeleteThreads(threadIds: readonly ThreadId[], batchDeleteId: string): Thread[] {
    if (batchDeleteId.trim().length === 0) throw new LifecycleError("Invalid batch delete id");
    const now = this.now(); const expires = new Date(Date.parse(now) + 7 * 86_400_000).toISOString();
    const frozenIds = [...new Set(threadIds)];
    const existing = this.deleteBatches.get(batchDeleteId);
    if (existing !== undefined && JSON.stringify(existing.threadIds) !== JSON.stringify(frozenIds)) throw new LifecycleError("Batch delete id belongs to another frozen Thread set");
    const result = frozenIds.map((id) => {
      const thread = this.requireThread(id);
      if (thread.deletedAt === undefined) { thread.deletedAt = now; thread.trashExpiresAt = expires; thread.deleteBatchId = batchDeleteId; }
      return cloneThread(thread);
    });
    if (existing === undefined) this.deleteBatches.set(batchDeleteId, { id: batchDeleteId, threadIds: frozenIds, createdAt: now, status: "completed" });
    return result;
  }

  restoreThread(threadId: ThreadId): Thread {
    const thread = this.requireThread(threadId); delete thread.deletedAt; delete thread.trashExpiresAt; delete thread.deleteBatchId; return cloneThread(thread);
  }

  restoreDeleteBatch(batchDeleteId: string): Thread[] {
    const batch = this.deleteBatches.get(batchDeleteId); if (batch === undefined) throw new LifecycleError("Delete batch not found");
    const restored = batch.threadIds.map((threadId) => this.restoreThread(threadId));
    batch.status = "restored"; batch.restoredAt = this.now(); return restored;
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

  recoverInProgressTurns(): Turn[] {
    const recovered: Turn[] = [];

    for (const turn of this.turns.values()) {
      if (turn.status !== "in_progress") {
        continue;
      }

      // 进程重启后旧执行体已经不存在，不能继续宣称它仍在运行。
      turn.status = "interrupted";
      turn.completedAt = this.now();
      recovered.push(turn);
    }

    return recovered;
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

function parseLifecycleSnapshot(
  value: unknown,
): LifecycleSnapshot {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Number.isInteger(value.idSequence) ||
    (value.idSequence as number) < 0 ||
    !Array.isArray(value.threads) ||
    !value.threads.every(isThread) ||
    !Array.isArray(value.turns) ||
    !value.turns.every(isTurn) ||
    !Array.isArray(value.items) ||
    !value.items.every(isItem)
  ) {
    throw new Error("Invalid lifecycle snapshot");
  }

  const threads = value.threads.map(cloneThread);
  const turns = value.turns.map(cloneTurn);
  const items = value.items.map(cloneItem);
  const threadMap = createUniqueMap(threads);
  const turnMap = createUniqueMap(turns);
  const itemMap = createUniqueMap(items);
  const referencedTurns = new Set<string>();
  const referencedItems = new Set<string>();

  for (const thread of threads) {
    if (new Set(thread.turnIds).size !== thread.turnIds.length) {
      throw new Error("Invalid lifecycle snapshot");
    }

    for (const turnId of thread.turnIds) {
      const turn = turnMap.get(turnId);

      if (
        turn === undefined ||
        turn.threadId !== thread.id ||
        referencedTurns.has(turnId)
      ) {
        throw new Error("Invalid lifecycle snapshot");
      }

      referencedTurns.add(turnId);
    }
  }

  for (const turn of turns) {
    if (
      !threadMap.has(turn.threadId) ||
      !referencedTurns.has(turn.id) ||
      new Set(turn.itemIds).size !== turn.itemIds.length
    ) {
      throw new Error("Invalid lifecycle snapshot");
    }

    for (const itemId of turn.itemIds) {
      const item = itemMap.get(itemId);

      if (
        item === undefined ||
        item.turnId !== turn.id ||
        item.threadId !== turn.threadId ||
        referencedItems.has(itemId)
      ) {
        throw new Error("Invalid lifecycle snapshot");
      }

      referencedItems.add(itemId);
    }
  }

  if (
    referencedTurns.size !== turns.length ||
    referencedItems.size !== items.length
  ) {
    throw new Error("Invalid lifecycle snapshot");
  }

  return {
    version: 1,
    idSequence: value.idSequence as number,
    threads,
    turns,
    items,
    deleteBatches: Array.isArray(value.deleteBatches) ? value.deleteBatches.filter(isDeleteBatch).map((item) => structuredClone(item)) : [],
  };
}

function isDeleteBatch(value: unknown): value is ThreadDeleteBatch {
  return isRecord(value) && typeof value.id === "string" && Array.isArray(value.threadIds) && value.threadIds.every((id) => typeof id === "string") &&
    typeof value.createdAt === "string" && (value.status === "completed" || value.status === "restored") && (value.restoredAt === undefined || typeof value.restoredAt === "string");
}

function createUniqueMap<T extends { id: string }>(
  values: readonly T[],
): Map<string, T> {
  const map = new Map<string, T>();

  for (const value of values) {
    if (map.has(value.id)) {
      throw new Error("Invalid lifecycle snapshot");
    }

    map.set(value.id, value);
  }

  return map;
}

function cloneThread(thread: Thread): Thread {
  return {
    ...thread,
    turnIds: [...thread.turnIds],
  };
}

function cloneTurn(turn: Turn): Turn {
  return {
    ...turn,
    itemIds: [...turn.itemIds],
  };
}

function cloneItem(item: Item): Item {
  return {
    ...item,
    content: structuredClone(item.content),
  };
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}
