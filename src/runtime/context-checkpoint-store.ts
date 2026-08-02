import type {
  LlmMessage,
} from "../llm/types.js";
import type {
  ThreadId,
  TurnId,
} from "./lifecycle.js";

export interface ContextCheckpoint {
  id: string;
  threadId: ThreadId;
  throughTurnId: TurnId;
  windowNumber: number;
  previousCheckpointId?: string;
  replacementMessages: LlmMessage[];
  beforeTokens: number;
  afterTokens: number;
  createdAt: string;
}

export interface ContextCheckpointRecord {
  threadId: ThreadId;
  throughTurnId: TurnId;
  replacementMessages: readonly LlmMessage[];
  beforeTokens: number;
  afterTokens: number;
}

export interface ContextCheckpointStoreOptions {
  now?: () => string;
  createId?: () => string;
}

export interface ContextCheckpointSnapshot {
  version: 1;
  idSequence: number;
  checkpoints: ContextCheckpoint[];
}

/**
 * 记录 Context Window 的替换历史。
 * 第一版只保存在内存，后续 Thread 持久化阶段再落盘。
 */
export class ContextCheckpointStore {
  private readonly checkpointsByThread = new Map<
    ThreadId,
    ContextCheckpoint[]
  >();

  private readonly now: () => string;
  private readonly createId: () => string;
  private idSequence = 0;

  constructor(
    options: ContextCheckpointStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId =
      options.createId ??
      (() => {
        this.idSequence += 1;
        return `checkpoint-${this.idSequence}`;
      });
  }

  static fromSnapshot(
    value: unknown,
    options: ContextCheckpointStoreOptions = {},
  ): ContextCheckpointStore {
    const snapshot = parseContextCheckpointSnapshot(value);
    const store = new ContextCheckpointStore(options);

    store.idSequence = snapshot.idSequence;

    for (const checkpoint of snapshot.checkpoints) {
      const checkpoints =
        store.checkpointsByThread.get(checkpoint.threadId) ?? [];

      checkpoints.push(cloneCheckpoint(checkpoint));
      store.checkpointsByThread.set(
        checkpoint.threadId,
        checkpoints,
      );
    }

    return store;
  }

  exportSnapshot(): ContextCheckpointSnapshot {
    return {
      version: 1,
      idSequence: this.idSequence,
      checkpoints: [
        ...this.checkpointsByThread.values(),
      ].flatMap((checkpoints) =>
        checkpoints.map(cloneCheckpoint),
      ),
    };
  }

  record(input: ContextCheckpointRecord): ContextCheckpoint {
    const checkpoints =
      this.checkpointsByThread.get(input.threadId) ?? [];
    const previous = checkpoints.at(-1);

    const checkpoint: ContextCheckpoint = {
      id: this.createId(),
      threadId: input.threadId,
      throughTurnId: input.throughTurnId,
      windowNumber: checkpoints.length + 1,
      ...(previous === undefined
        ? {}
        : { previousCheckpointId: previous.id }),
      replacementMessages: input.replacementMessages.map(
        (message) => ({ ...message }),
      ),
      beforeTokens: input.beforeTokens,
      afterTokens: input.afterTokens,
      createdAt: this.now(),
    };

    checkpoints.push(checkpoint);
    this.checkpointsByThread.set(input.threadId, checkpoints);

    return checkpoint;
  }

  getLatest(
    threadId: ThreadId,
  ): ContextCheckpoint | undefined {
    return this.checkpointsByThread.get(threadId)?.at(-1);
  }
}

function parseContextCheckpointSnapshot(
  value: unknown,
): ContextCheckpointSnapshot {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Number.isInteger(value.idSequence) ||
    (value.idSequence as number) < 0 ||
    !Array.isArray(value.checkpoints) ||
    !value.checkpoints.every(isContextCheckpoint)
  ) {
    throw new Error("Invalid context checkpoint snapshot");
  }

  const checkpoints = value.checkpoints.map(cloneCheckpoint);
  const checkpointIds = new Set<string>();
  const latestByThread = new Map<string, ContextCheckpoint>();

  for (const checkpoint of checkpoints) {
    if (checkpointIds.has(checkpoint.id)) {
      throw new Error("Invalid context checkpoint snapshot");
    }

    checkpointIds.add(checkpoint.id);
    const previous = latestByThread.get(checkpoint.threadId);

    if (
      checkpoint.windowNumber !==
        (previous?.windowNumber ?? 0) + 1 ||
      checkpoint.previousCheckpointId !== previous?.id
    ) {
      throw new Error("Invalid context checkpoint snapshot");
    }

    latestByThread.set(checkpoint.threadId, checkpoint);
  }

  return {
    version: 1,
    idSequence: value.idSequence as number,
    checkpoints,
  };
}

function isContextCheckpoint(
  value: unknown,
): value is ContextCheckpoint {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.threadId === "string" &&
    typeof value.throughTurnId === "string" &&
    Number.isInteger(value.windowNumber) &&
    (value.windowNumber as number) > 0 &&
    (value.previousCheckpointId === undefined ||
      typeof value.previousCheckpointId === "string") &&
    Array.isArray(value.replacementMessages) &&
    value.replacementMessages.every(isLlmMessage) &&
    Number.isInteger(value.beforeTokens) &&
    (value.beforeTokens as number) >= 0 &&
    Number.isInteger(value.afterTokens) &&
    (value.afterTokens as number) >= 0 &&
    typeof value.createdAt === "string"
  );
}

function isLlmMessage(value: unknown): value is LlmMessage {
  return (
    isRecord(value) &&
    (value.role === "user" || value.role === "assistant") &&
    typeof value.text === "string"
  );
}

function cloneCheckpoint(
  checkpoint: ContextCheckpoint,
): ContextCheckpoint {
  return {
    ...checkpoint,
    replacementMessages: checkpoint.replacementMessages.map(
      (message) => ({ ...message }),
    ),
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
