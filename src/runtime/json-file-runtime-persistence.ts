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
  version: 6;
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
        };
      }

      throw error;
    }

    try {
      const value = JSON.parse(text) as unknown;

      if (
        !isRecord(value) ||
        (value.version !== 1 && value.version !== 2 && value.version !== 3 &&
          value.version !== 4 && value.version !== 5 && value.version !== 6)
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
      const version2 = value.version === 2 || value.version === 3 ||
        value.version === 4 || value.version === 5 || value.version === 6;
      const agentRunStore = AgentRunStore.fromSnapshot(
        version2 ? value.agentRuns as AgentRunSnapshot : undefined,
      );
      const agentRuntimeStore = AgentRuntimeStore.fromSnapshot(
        value.version === 3 || value.version === 4 || value.version === 5 ||
          value.version === 6
          ? value.agentRuntime as AgentRuntimeSnapshot : undefined,
      );
      const requirementStore = RequirementStore.fromSnapshot(
        value.version === 4 || value.version === 5 || value.version === 6
          ? value.requirements as RequirementSnapshot : undefined,
      );
      const modelInvocationStore = ModelInvocationStore.fromSnapshot(
        value.version === 5 || value.version === 6
          ? value.modelInvocations as ModelInvocationSnapshot | undefined
          : undefined,
      );
      const toolInvocationStore = ToolInvocationStore.fromSnapshot(
        value.version === 6
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

      if (recoveredTurnIds.length > 0) {
        await this.save(
          lifecycleStore,
          contextCheckpointStore,
          agentRunStore,
          threadConfigs,
          agentProfiles,
          runtimeSessions,
          agentRuntimeStore,
          requirementStore,
          modelInvocationStore,
          toolInvocationStore,
        );
      }

      return {
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
    agentRunStore: AgentRunStore = new AgentRunStore(),
    threadConfigs: PersistedThreadConfig[] = [],
    agentProfiles: AgentProfile[] = [],
    runtimeSessions: PersistedRuntimeSession[] = [],
    agentRuntimeStore: AgentRuntimeStore = new AgentRuntimeStore(),
    requirementStore: RequirementStore = new RequirementStore(),
    modelInvocationStore: ModelInvocationStore = new ModelInvocationStore(),
    toolInvocationStore: ToolInvocationStore = new ToolInvocationStore(),
  ): Promise<void> {
    const snapshot: RuntimeStateSnapshot = {
      version: 6,
      lifecycle: lifecycleStore.exportSnapshot(),
      contextCheckpoints:
        contextCheckpointStore.exportSnapshot(),
      threadConfigs: structuredClone(threadConfigs),
      agentProfiles: structuredClone(agentProfiles),
      agentRuns: agentRunStore.exportSnapshot(),
      agentRuntime: agentRuntimeStore.exportSnapshot(),
      runtimeSessions: structuredClone(runtimeSessions),
      requirements: requirementStore.exportSnapshot(),
      modelInvocations: modelInvocationStore.exportSnapshot(),
      toolInvocations: toolInvocationStore.exportSnapshot(),
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
