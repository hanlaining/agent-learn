import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  join,
} from "node:path";

import {
  ContextCheckpointStore,
  type ContextCheckpointSnapshot,
} from "./context-checkpoint-store.js";
import {
  LifecycleStore,
  type LifecycleSnapshot,
} from "./lifecycle-store.js";

export interface RuntimeStateSnapshot {
  version: 1;
  lifecycle: LifecycleSnapshot;
  contextCheckpoints: ContextCheckpointSnapshot;
}

export interface LoadedRuntimeState {
  lifecycleStore: LifecycleStore;
  contextCheckpointStore: ContextCheckpointStore;
  restored: boolean;
  recoveredTurnIds: string[];
}

/**
 * 把 Runtime 状态保存为单个版本化 JSON 文件。
 * 写入先落到同目录临时文件，再 rename，避免进程中断留下半份 JSON。
 */
export class JsonFileRuntimePersistence {
  private saveSequence = 0;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(private readonly statePath: string) {}

  async load(): Promise<LoadedRuntimeState> {
    await this.saveQueue;

    let text: string;

    try {
      text = await readFile(this.statePath, "utf8");
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        return {
          lifecycleStore: new LifecycleStore(),
          contextCheckpointStore:
            new ContextCheckpointStore(),
          restored: false,
          recoveredTurnIds: [],
        };
      }

      throw error;
    }

    try {
      const value = JSON.parse(text) as unknown;

      if (
        !isRecord(value) ||
        value.version !== 1
      ) {
        throw new Error("Unsupported state version");
      }

      const lifecycleStore = LifecycleStore.fromSnapshot(
        value.lifecycle,
      );
      const contextCheckpointStore =
        ContextCheckpointStore.fromSnapshot(
          value.contextCheckpoints,
        );
      const recoveredTurnIds =
        lifecycleStore
          .recoverInProgressTurns()
          .map((turn) => turn.id);

      if (recoveredTurnIds.length > 0) {
        await this.save(
          lifecycleStore,
          contextCheckpointStore,
        );
      }

      return {
        lifecycleStore,
        contextCheckpointStore,
        restored: true,
        recoveredTurnIds,
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unknown parse error";

      throw new Error(
        `Invalid runtime state file: ${message}`,
      );
    }
  }

  save(
    lifecycleStore: LifecycleStore,
    contextCheckpointStore: ContextCheckpointStore,
  ): Promise<void> {
    const snapshot: RuntimeStateSnapshot = {
      version: 1,
      lifecycle: lifecycleStore.exportSnapshot(),
      contextCheckpoints:
        contextCheckpointStore.exportSnapshot(),
    };
    const operation = this.saveQueue.then(() =>
      this.writeSnapshot(snapshot),
    );

    // 队列继续工作，但当前调用者仍会收到本次写入的真实失败。
    this.saveQueue = operation.catch(() => undefined);

    return operation;
  }

  private async writeSnapshot(
    snapshot: RuntimeStateSnapshot,
  ): Promise<void> {
    const stateDirectory = dirname(this.statePath);
    this.saveSequence += 1;
    const temporaryPath = join(
      stateDirectory,
      `.${basename(this.statePath)}.${process.pid}.` +
        `${this.saveSequence}.tmp`,
    );
    const text = `${JSON.stringify(snapshot, null, 2)}\n`;

    await mkdir(stateDirectory, { recursive: true });
    await writeFile(temporaryPath, text, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporaryPath, this.statePath);
  }
}

function hasErrorCode(
  error: unknown,
  code: string,
): boolean {
  return (
    isRecord(error) &&
    error.code === code
  );
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
