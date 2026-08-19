import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
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
import { AgentRunStore } from "../agents/agent-run-store.js";
import type { AgentRunSnapshot } from "../agents/agent-run.js";
import type { AgentProfile } from "../agents/agent-profile.js";
import { AgentRuntimeStore } from "../agents/agent-runtime-store.js";
import type { AgentRuntimeSnapshot, AgentTeamConfig } from "../agents/agent-runtime.js";
import { isRuntimeSession, type RuntimeSession } from "./runtime-session.js";
import { RequirementStore } from "../requirements/requirement-store.js";
import type { RequirementSnapshot } from "../requirements/requirement.js";
import {
  ModelInvocationStore,
} from "./model-invocation-store.js";
import type {
  ModelInvocationSnapshot,
} from "./model-invocation.js";
import {
  ToolInvocationStore,
} from "./tool-invocation-store.js";
import type {
  ToolInvocationSnapshot,
} from "./tool-invocation.js";
import {
  ProcessSafeFileLock,
  type ProcessSafeFileLockOptions,
} from "./process-safe-file-lock.js";

export interface PersistedThreadConfig {
  threadId: string;
  model: string;
  reasoningEffort: string;
  agentProfileId: string;
  agentTeam?: AgentTeamConfig;
}

export interface PersistedRuntimeSession {
  threadId: string;
  turnState: string;
  session: RuntimeSession;
}

export interface RuntimeStateSnapshot {
  version: 7;
  generation: number;
  lifecycle: LifecycleSnapshot;
  contextCheckpoints: ContextCheckpointSnapshot;
  threadConfigs: PersistedThreadConfig[];
  agentProfiles: AgentProfile[];
  agentRuns: AgentRunSnapshot;
  agentRuntime: AgentRuntimeSnapshot;
  runtimeSessions: PersistedRuntimeSession[];
  requirements: RequirementSnapshot;
  modelInvocations?: ModelInvocationSnapshot;
  toolInvocations?: ToolInvocationSnapshot;
}

export interface LoadedRuntimeState {
  lifecycleStore: LifecycleStore;
  contextCheckpointStore: ContextCheckpointStore;
  agentRunStore: AgentRunStore;
  agentRuntimeStore: AgentRuntimeStore;
  requirementStore: RequirementStore;
  modelInvocationStore: ModelInvocationStore;
  toolInvocationStore: ToolInvocationStore;
  threadConfigs: PersistedThreadConfig[];
  agentProfiles: AgentProfile[];
  runtimeSessions: PersistedRuntimeSession[];
  restored: boolean;
  recoveredTurnIds: string[];
  /** Diagnostic mirror only; save authorization is kept in a private state identity. */
  generation: number;
}

export class SnapshotConflictError extends Error {
  readonly name = "SnapshotConflict";
  readonly code = "snapshot_conflict";

  constructor(
    readonly statePath: string,
    readonly expectedGeneration: number,
    readonly actualGeneration: number,
  ) {
    super(
      `SnapshotConflict: expected generation ${expectedGeneration}, ` +
        `found ${actualGeneration}; reload before retrying ${statePath}`,
    );
  }
}

export class SnapshotStateIdentityError extends Error {
  readonly name = "SnapshotConflict";
  readonly code = "snapshot_state_identity_mismatch";

  constructor(readonly statePath: string) {
    super(
      `SnapshotConflict: Runtime state identity does not match ${statePath}; ` +
        "reload and save the returned state as one unit",
    );
  }
}

interface SnapshotStateIdentity {
  generation: number;
  lifecycleStore: LifecycleStore;
  contextCheckpointStore: ContextCheckpointStore;
  agentRunStore: AgentRunStore;
  agentRuntimeStore: AgentRuntimeStore;
  requirementStore: RequirementStore;
  modelInvocationStore: ModelInvocationStore;
  toolInvocationStore: ToolInvocationStore;
  threadConfigs: PersistedThreadConfig[];
  agentProfiles: AgentProfile[];
  runtimeSessions: PersistedRuntimeSession[];
}

/**
 * 把 Runtime 状态保存为单个版本化 JSON 文件。
 * 写入先落到同目录临时文件，再 rename，避免进程中断留下半份 JSON。
 */
export class JsonFileRuntimePersistence {
  private saveQueue: Promise<void> = Promise.resolve();
  private readonly stateLock: ProcessSafeFileLock;
  private readonly stateIdentities = new WeakMap<
    LoadedRuntimeState,
    SnapshotStateIdentity
  >();

  constructor(
    private readonly statePath: string,
    lockOptions: ProcessSafeFileLockOptions = {},
  ) {
    if (statePath.trim().length === 0) throw new Error("Runtime state path must not be empty");
    this.stateLock = new ProcessSafeFileLock(
      `${statePath}.lock`,
      lockOptions,
      "Runtime snapshot",
    );
  }

  async load(): Promise<LoadedRuntimeState> {
    await this.saveQueue;

    let text: string;

    try {
      text = await readFile(this.statePath, "utf8");
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        const state: LoadedRuntimeState = {
          lifecycleStore: new LifecycleStore(),
          contextCheckpointStore:
            new ContextCheckpointStore(),
          agentRunStore: new AgentRunStore(),
          agentRuntimeStore: new AgentRuntimeStore(),
          requirementStore: new RequirementStore(),
          modelInvocationStore: new ModelInvocationStore(),
          toolInvocationStore: new ToolInvocationStore(),
          threadConfigs: [],
          agentProfiles: [],
          runtimeSessions: [],
          restored: false,
          recoveredTurnIds: [],
          generation: 0,
        };
        this.bindStateIdentity(state);
        return state;
      }

      throw error;
    }

    try {
      const value = JSON.parse(text) as unknown;

      if (
        !isRecord(value) ||
        (value.version !== 1 && value.version !== 2 && value.version !== 3 &&
          value.version !== 4 && value.version !== 5 && value.version !== 6 &&
          value.version !== 7)
      ) {
        throw new Error("Unsupported state version");
      }
      const generation = snapshotGeneration(value);

      const lifecycleStore = LifecycleStore.fromSnapshot(
        value.lifecycle,
      );
      const contextCheckpointStore =
        ContextCheckpointStore.fromSnapshot(
          value.contextCheckpoints,
        );
      const version2 = value.version === 2 || value.version === 3 ||
        value.version === 4 || value.version === 5 || value.version === 6 ||
          value.version === 7;
      const agentRunStore = AgentRunStore.fromSnapshot(
        version2 ? value.agentRuns as AgentRunSnapshot : undefined,
      );
      const agentRuntimeStore = AgentRuntimeStore.fromSnapshot(
        value.version === 3 || value.version === 4 || value.version === 5 ||
          value.version === 6 || value.version === 7
          ? value.agentRuntime as AgentRuntimeSnapshot : undefined,
      );
      const requirementStore = RequirementStore.fromSnapshot(
        value.version === 4 || value.version === 5 || value.version === 6 ||
          value.version === 7
          ? value.requirements as RequirementSnapshot : undefined,
      );
      const modelInvocationStore = ModelInvocationStore.fromSnapshot(
        value.version === 5 || value.version === 6 || value.version === 7
          ? value.modelInvocations as ModelInvocationSnapshot | undefined
          : undefined,
      );
      const toolInvocationStore = ToolInvocationStore.fromSnapshot(
        value.version === 6 || value.version === 7
          ? value.toolInvocations as ToolInvocationSnapshot | undefined
          : undefined,
      );
      const threadConfigs = version2 && Array.isArray(value.threadConfigs)
        ? value.threadConfigs as PersistedThreadConfig[] : [];
      const agentProfiles = version2 && Array.isArray(value.agentProfiles)
        ? value.agentProfiles as AgentProfile[] : [];
      const runtimeSessions = version2 && Array.isArray(value.runtimeSessions)
        ? value.runtimeSessions.filter(isPersistedRuntimeSession)
        : [];
      const recoveredTurnIds =
        lifecycleStore
          .recoverInProgressTurns()
          .map((turn) => turn.id);
      const state: LoadedRuntimeState = {
        lifecycleStore,
        contextCheckpointStore,
        agentRunStore,
        agentRuntimeStore,
        requirementStore,
        modelInvocationStore,
        toolInvocationStore,
        threadConfigs,
        agentProfiles,
        runtimeSessions,
        restored: true,
        recoveredTurnIds,
        generation,
      };
      this.bindStateIdentity(state);

      if (recoveredTurnIds.length > 0) {
        await this.save(state);
      }

      return state;
    } catch (error) {
      if (
        error instanceof SnapshotConflictError ||
        error instanceof SnapshotStateIdentityError
      ) throw error;
      const message =
        error instanceof Error
          ? error.message
          : "Unknown parse error";

      throw new Error(
        `Invalid runtime state file: ${message}`,
      );
    }
  }

  async save(state: LoadedRuntimeState): Promise<void> {
    const identity = this.requireStateIdentity(state);
    const snapshot: Omit<RuntimeStateSnapshot, "generation"> = {
      version: 7,
      lifecycle: state.lifecycleStore.exportSnapshot(),
      contextCheckpoints:
        state.contextCheckpointStore.exportSnapshot(),
      threadConfigs: structuredClone(state.threadConfigs),
      agentProfiles: structuredClone(state.agentProfiles),
      agentRuns: state.agentRunStore.exportSnapshot(),
      agentRuntime: state.agentRuntimeStore.exportSnapshot(),
      runtimeSessions: structuredClone(state.runtimeSessions),
      requirements: state.requirementStore.exportSnapshot(),
      modelInvocations: state.modelInvocationStore.exportSnapshot(),
      toolInvocations: state.toolInvocationStore.exportSnapshot(),
    };
    const operation = this.saveQueue.then(() =>
      this.writeSnapshot(state, identity, snapshot),
    );

    // 队列继续工作，但当前调用者仍会收到本次写入的真实失败。
    this.saveQueue = operation.then(() => undefined, () => undefined);

    return operation;
  }

  private async writeSnapshot(
    state: LoadedRuntimeState,
    identity: SnapshotStateIdentity,
    snapshot: Omit<RuntimeStateSnapshot, "generation">,
  ): Promise<void> {
    await this.stateLock.withLock(async () => {
      this.requireStateIdentity(state, identity);
      const expectedGeneration = identity.generation;
      const actualGeneration = await this.readDiskGeneration();
      if (actualGeneration !== expectedGeneration) {
        throw new SnapshotConflictError(
          this.statePath,
          expectedGeneration,
          actualGeneration,
        );
      }
      const generation = expectedGeneration + 1;
      assertGeneration(generation, "next generation");
      await this.replaceSnapshot({ ...snapshot, generation });
      identity.generation = generation;
      state.generation = generation;
    });
  }

  private bindStateIdentity(state: LoadedRuntimeState): void {
    this.stateIdentities.set(state, {
      generation: state.generation,
      lifecycleStore: state.lifecycleStore,
      contextCheckpointStore: state.contextCheckpointStore,
      agentRunStore: state.agentRunStore,
      agentRuntimeStore: state.agentRuntimeStore,
      requirementStore: state.requirementStore,
      modelInvocationStore: state.modelInvocationStore,
      toolInvocationStore: state.toolInvocationStore,
      threadConfigs: state.threadConfigs,
      agentProfiles: state.agentProfiles,
      runtimeSessions: state.runtimeSessions,
    });
  }

  private requireStateIdentity(
    state: LoadedRuntimeState,
    expected?: SnapshotStateIdentity,
  ): SnapshotStateIdentity {
    const identity = this.stateIdentities.get(state);
    if (
      identity === undefined ||
      (expected !== undefined && identity !== expected) ||
      identity.lifecycleStore !== state.lifecycleStore ||
      identity.contextCheckpointStore !== state.contextCheckpointStore ||
      identity.agentRunStore !== state.agentRunStore ||
      identity.agentRuntimeStore !== state.agentRuntimeStore ||
      identity.requirementStore !== state.requirementStore ||
      identity.modelInvocationStore !== state.modelInvocationStore ||
      identity.toolInvocationStore !== state.toolInvocationStore ||
      identity.threadConfigs !== state.threadConfigs ||
      identity.agentProfiles !== state.agentProfiles ||
      identity.runtimeSessions !== state.runtimeSessions
    ) {
      throw new SnapshotStateIdentityError(this.statePath);
    }
    return identity;
  }

  private async readDiskGeneration(): Promise<number> {
    try {
      const value = JSON.parse(await readFile(this.statePath, "utf8")) as unknown;
      if (!isRecord(value) || !isSupportedVersion(value.version)) {
        throw new Error("Unsupported state version");
      }
      return snapshotGeneration(value);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return 0;
      throw error;
    }
  }

  private async replaceSnapshot(snapshot: RuntimeStateSnapshot): Promise<void> {
    const stateDirectory = dirname(this.statePath);
    const temporaryPath = join(
      stateDirectory,
      `.${basename(this.statePath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    const text = `${JSON.stringify(snapshot, null, 2)}\n`;

    await mkdir(stateDirectory, { recursive: true });
    try {
      await writeFile(temporaryPath, text, { encoding: "utf8", flag: "wx" });
      // Linearization point: generation comparison and this atomic replacement
      // are in one cross-process critical section.
      await rename(temporaryPath, this.statePath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }
}

function snapshotGeneration(value: Record<string, unknown>): number {
  if (value.version !== 7) return 0;
  assertGeneration(value.generation, "snapshot generation");
  return value.generation as number;
}

function isSupportedVersion(value: unknown): boolean {
  return value === 1 || value === 2 || value === 3 || value === 4 ||
    value === 5 || value === 6 || value === 7;
}

function assertGeneration(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function isPersistedRuntimeSession(value: unknown): value is PersistedRuntimeSession {
  return isRecord(value) && typeof value.threadId === "string" &&
    typeof value.turnState === "string" && isRuntimeSession(value.session);
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
