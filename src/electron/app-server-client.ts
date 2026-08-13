import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { JsonRpcConnection } from "../protocol/connection.js";
import {
  isAgentEvent,
  type AgentEvent,
} from "../agent/events.js";
import {
  isThread,
  type Thread,
} from "../runtime/lifecycle.js";
import {
  isTurnStartResult,
  type TurnStartResult,
} from "../runtime/turn-start.js";
import {
  isTurnRunResult,
  type TurnRunResult,
} from "../runtime/turn-run.js";
import {
  isTurnCancelResult,
  type TurnCancelResult,
} from "../runtime/turn-cancel.js";
import {
  isThreadHistoryResult,
  type ThreadHistoryResult,
} from "../runtime/thread-history.js";
import {
  isRuntimeCapabilities,
  type RuntimeCapabilities,
} from "../app-server/runtime-capabilities.js";
import {
  parseToolPermissionPrompt,
  type ToolPermissionPrompt,
} from "../permissions/json-rpc-permission-gate.js";
import type {
  ToolPermissionDecision,
} from "../permissions/permission-gate.js";
import {
  CLOSED_RUNTIME_STATUS,
  CONNECTED_RUNTIME_STATUS,
  CONNECTING_RUNTIME_STATUS,
  createSafeRuntimeFailure,
  type RuntimeFailureCode,
  type RuntimeStatus,
} from "./runtime-status.js";

export interface AppServerClientOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  handshakeTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  onDiagnostic?: (message: string) => void;
  onPermissionRequest?: (
    request: ToolPermissionPrompt,
  ) => Promise<ToolPermissionDecision>;
}

export async function resolveToolPermissionRequest(
  params: unknown,
  handler?: (
    request: ToolPermissionPrompt,
  ) => Promise<ToolPermissionDecision>,
): Promise<ToolPermissionDecision> {
  const request = parseToolPermissionPrompt(params);
  return handler === undefined
    ? {
        decision: "deny",
        reason: "Electron Permission UI is not available",
      }
    : handler(request);
}

type RuntimeStatusListener = (status: RuntimeStatus) => void;
type AgentEventListener = (event: AgentEvent) => void;

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

/**
 * Electron Main 持有的 App Server Client。
 *
 * Renderer 和 Preload 都不能接触这里的子进程、环境变量或 JSON-RPC。
 */
export class AppServerClient {
  private status: RuntimeStatus = CLOSED_RUNTIME_STATUS;
  private readonly listeners = new Set<RuntimeStatusListener>();
  private readonly agentEventListeners = new Set<AgentEventListener>();
  private child: ChildProcessWithoutNullStreams | undefined;
  private connection: JsonRpcConnection | undefined;
  private startPromise: Promise<RuntimeStatus> | undefined;
  private closePromise: Promise<void> | undefined;
  private closing = false;

  constructor(private readonly options: AppServerClientOptions) {}

  getStatus(): RuntimeStatus {
    return this.status;
  }

  getChildPid(): number | undefined {
    return this.child?.pid;
  }

  onStatusChange(listener: RuntimeStatusListener): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  onAgentEvent(listener: AgentEventListener): () => void {
    this.agentEventListeners.add(listener);

    return () => {
      this.agentEventListeners.delete(listener);
    };
  }

  async listThreads(): Promise<Thread[]> {
    const value = await this.sendRequest("thread/list");

    if (!Array.isArray(value) || !value.every(isThread)) {
      throw new Error("Invalid thread/list response");
    }

    return value;
  }

  async startThread(): Promise<Thread> {
    const value = await this.sendRequest("thread/start");

    if (!isThread(value)) {
      throw new Error("Invalid thread/start response");
    }

    return value;
  }

  async renameThread(threadId: string, title: string): Promise<Thread> {
    const value = await this.sendRequest("thread/rename", { threadId, title });
    if (!isThread(value)) throw new Error("Invalid thread/rename response"); return value;
  }
  async softDeleteThreads(threadIds: string[], batchDeleteId: string): Promise<Thread[]> {
    const value = await this.sendRequest("thread/soft-delete", { threadIds, batchDeleteId });
    if (!Array.isArray(value) || !value.every(isThread)) throw new Error("Invalid thread/soft-delete response"); return value;
  }
  async restoreThread(threadId: string): Promise<Thread> {
    const value = await this.sendRequest("thread/restore", { threadId });
    if (!isThread(value)) throw new Error("Invalid thread/restore response"); return value;
  }
  async listTrash(): Promise<Thread[]> {
    const value = await this.sendRequest("thread/trash/list");
    if (!Array.isArray(value) || !value.every(isThread)) throw new Error("Invalid thread/trash/list response"); return value;
  }
  async getAgentRuntime(threadId: string): Promise<unknown> { return this.sendRequest("agent/runtime", { threadId }); }
  async advanceFixedProduct(threadId: string, expectedStage: import("../agents/fixed-software-team-coordinator.js").FixedProductStage): Promise<unknown> {
    return this.sendRequest("agent/fixed-product/advance", { threadId, expectedStage });
  }
  async getRequirement(threadId: string): Promise<import("../requirements/requirement.js").Requirement | undefined> {
    const value = await this.sendRequest("requirement/get", { threadId });
    return value === null ? undefined : value as import("../requirements/requirement.js").Requirement;
  }
  async confirmRequirement(requirementId: string, revision: number, contentHash: string): Promise<import("../requirements/requirement.js").Requirement> {
    return await this.sendRequest("requirement/confirm", { requirementId, revision, contentHash }) as import("../requirements/requirement.js").Requirement;
  }

  async readThreadHistory(
    threadId: string,
  ): Promise<ThreadHistoryResult> {
    const value = await this.sendRequest(
      "thread/history",
      { threadId },
    );

    if (!isThreadHistoryResult(value)) {
      throw new Error("Invalid thread/history response");
    }

    return value;
  }

  async getCapabilities(): Promise<RuntimeCapabilities> {
    const value = await this.sendRequest(
      "runtime/capabilities",
    );

    if (!isRuntimeCapabilities(value)) {
      throw new Error("Invalid runtime/capabilities response");
    }

    return value;
  }

  async listAgentRuns(threadId?: string): Promise<import("../agents/agent-run.js").AgentRun[]> {
    const value = await this.sendRequest("agent-run/list", threadId === undefined ? {} : { threadId });
    if (!Array.isArray(value)) throw new Error("Invalid agent-run/list response");
    return value as import("../agents/agent-run.js").AgentRun[];
  }

  async getThreadConfig(threadId: string): Promise<import("./desktop-types.js").DesktopAgentConfig | undefined> {
    const value = await this.sendRequest("thread/config/get", { threadId });
    if (value === null) return undefined;
    if (!isRecord(value) || typeof value.model !== "string" ||
      typeof value.reasoningEffort !== "string" || typeof value.agentProfileId !== "string") {
      throw new Error("Invalid thread/config/get response");
    }
    return value as unknown as import("./desktop-types.js").DesktopAgentConfig;
  }

  async setThreadConfig(
    threadId: string,
    config: import("./desktop-types.js").DesktopAgentConfig,
  ): Promise<void> {
    await this.sendRequest("thread/config/set", { threadId, ...config });
  }

  async listRuntimeSessions(): Promise<Array<{
    threadId: string;
    turnState: import("./desktop-types.js").DesktopTurnState;
    session: import("../runtime/runtime-session.js").RuntimeSession;
  }>> {
    const value = await this.sendRequest("runtime-session/list", {});
    if (!Array.isArray(value)) throw new Error("Invalid runtime-session/list response");
    return value as Array<{
      threadId: string;
      turnState: import("./desktop-types.js").DesktopTurnState;
      session: import("../runtime/runtime-session.js").RuntimeSession;
    }>;
  }

  async setRuntimeSession(
    threadId: string,
    turnState: import("./desktop-types.js").DesktopTurnState,
    session: import("../runtime/runtime-session.js").RuntimeSession,
  ): Promise<void> {
    await this.sendRequest("runtime-session/set", { threadId, turnState, session });
  }

  async selectModel(model: string): Promise<RuntimeCapabilities> {
    const value = await this.sendRequest(
      "runtime/select-model",
      { model },
    );
    if (!isRuntimeCapabilities(value)) {
      throw new Error("Invalid runtime/select-model response");
    }
    return value;
  }

  async startTurn(
    threadId: string,
    input: string,
  ): Promise<TurnStartResult> {
    const value = await this.sendRequest(
      "turn/start",
      { threadId, input },
    );

    if (!isTurnStartResult(value)) {
      throw new Error("Invalid turn/start response");
    }

    return value;
  }

  async runTurn(
    turnId: string,
    options: { model?: string; reasoningEffort?: import("./desktop-types.js").DesktopReasoningEffort } = {},
  ): Promise<TurnRunResult> {
    const value = await this.sendRequest(
      "turn/run",
      { turnId, ...options },
    );

    if (!isTurnRunResult(value)) {
      throw new Error("Invalid turn/run response");
    }

    return value;
  }

  async cancelTurn(turnId: string): Promise<TurnCancelResult> {
    const value = await this.sendRequest(
      "turn/cancel",
      { turnId },
    );

    if (!isTurnCancelResult(value)) {
      throw new Error("Invalid turn/cancel response");
    }

    return value;
  }

  start(): Promise<RuntimeStatus> {
    if (this.startPromise !== undefined) {
      return this.startPromise;
    }

    this.startPromise = this.startInternal();
    return this.startPromise;
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }

    this.closePromise = this.closeInternal();
    return this.closePromise;
  }

  private async startInternal(): Promise<RuntimeStatus> {
    this.setStatus(CONNECTING_RUNTIME_STATUS);

    let spawned = false;

    try {
      const child = spawn(
        this.options.command,
        [...this.options.args],
        {
          cwd: this.options.cwd,
          env: this.options.env,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );

      this.child = child;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");

      const connection = new JsonRpcConnection((data) => {
        if (!child.stdin.writable) {
          throw new Error("App Server stdin is unavailable");
        }

        child.stdin.write(data);
      });
      this.connection = connection;

      connection.onNotification("agent/event", (params) => {
        if (!isAgentEvent(params)) {
          return;
        }

        for (const listener of this.agentEventListeners) {
          listener(params);
        }
      });
      connection.onRequest("tool/request-permission", async (params) => {
        return resolveToolPermissionRequest(
          params,
          this.options.onPermissionRequest,
        );
      });

      child.stdout.on("data", (chunk: string) => {
        void connection.receive(chunk).catch(() => {
          void this.fail("unexpected_exit");
        });
      });
      child.stderr.on("data", (chunk: string) => {
        // stderr 只留在 Main 诊断边界，不会进入 IPC 或 Renderer。
        this.options.onDiagnostic?.(chunk);
      });
      child.stdin.on("error", () => {
        if (!this.closing) {
          void this.fail(
            spawned ? "unexpected_exit" : "start_failed",
          );
        }
      });
      child.once("exit", () => {
        connection.close();

        if (this.closing) {
          this.setStatus(CLOSED_RUNTIME_STATUS);
          return;
        }

        void this.fail(
          this.status.state === "connecting"
            ? "handshake_failed"
            : "unexpected_exit",
        );
      });

      await waitForSpawn(child);
      spawned = true;

      const initializeResult = await withTimeout(
        connection.sendRequest("initialize", {
          clientName: "god-agent-electron",
          protocolVersion: 1,
        }),
        this.options.handshakeTimeoutMs ??
          DEFAULT_HANDSHAKE_TIMEOUT_MS,
        "App Server initialize timed out",
      );

      if (!isInitializeResult(initializeResult)) {
        throw new Error("Invalid initialize response");
      }

      connection.sendNotification("initialized");

      if (child.exitCode !== null || this.closing) {
        throw new Error("App Server closed during handshake");
      }

      this.setStatus(CONNECTED_RUNTIME_STATUS);
      return this.status;
    } catch {
      if (this.closing) {
        this.setStatus(CLOSED_RUNTIME_STATUS);
        return this.status;
      }

      await this.fail(
        spawned ? "handshake_failed" : "start_failed",
      );
      return this.status;
    }
  }

  private async closeInternal(): Promise<void> {
    this.closing = true;
    this.connection?.close();

    await stopChild(
      this.child,
      this.options.shutdownTimeoutMs ??
        DEFAULT_SHUTDOWN_TIMEOUT_MS,
    );

    this.setStatus(CLOSED_RUNTIME_STATUS);
  }

  private async fail(code: RuntimeFailureCode): Promise<void> {
    if (this.closing || this.status.state === "failed") {
      return;
    }

    // 先发布脱敏状态，再回收连接和子进程；原始 Error 永不跨 IPC。
    this.setStatus(createSafeRuntimeFailure(code));
    this.connection?.close();
    await stopChild(
      this.child,
      this.options.shutdownTimeoutMs ??
        DEFAULT_SHUTDOWN_TIMEOUT_MS,
    );
  }

  private setStatus(status: RuntimeStatus): void {
    if (
      this.status.state === status.state &&
      this.status.message === status.message
    ) {
      return;
    }

    this.status = status;

    for (const listener of this.listeners) {
      listener(status);
    }
  }

  private sendRequest(
    method: string,
    params?: unknown,
  ): Promise<unknown> {
    if (
      this.status.state !== "connected" ||
      this.connection === undefined ||
      this.closing
    ) {
      throw new Error("Runtime is not connected");
    }

    return this.connection.sendRequest(method, params);
  }
}

function waitForSpawn(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

async function stopChild(
  child: ChildProcessWithoutNullStreams | undefined,
  timeoutMs: number,
): Promise<void> {
  if (child === undefined || child.exitCode !== null) {
    return;
  }

  const exited = waitForExit(child);

  // App Server 以 stdin end 作为正常关闭信号，并在退出前清理 MCP 子进程。
  if (child.stdin.writable) {
    child.stdin.end();
  }

  if (await settlesWithin(exited, timeoutMs)) {
    return;
  }

  // 只有优雅关闭超时才兜底终止明确持有的单个 App Server 进程。
  child.kill();
  await settlesWithin(exited, Math.min(timeoutMs, 1_000));
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (child.exitCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    child.once("exit", () => resolve());
  });
}

async function settlesWithin(
  promise: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;

  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });

  const result = await Promise.race([
    promise.then(() => true as const),
    timedOut,
  ]);

  if (timer !== undefined) {
    clearTimeout(timer);
  }

  return result;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function isInitializeResult(
  value: unknown,
): value is {
  serverName: string;
  protocolVersion: number;
  capabilities: Record<string, unknown>;
} {
  return (
    isRecord(value) &&
    value.serverName === "agent-app-server" &&
    value.protocolVersion === 1 &&
    isRecord(value.capabilities)
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
