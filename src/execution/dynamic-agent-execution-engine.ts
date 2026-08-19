import type { AgentRunStore } from "../agents/agent-run-store.js";
import type { AgentRuntimeStore } from "../agents/agent-runtime-store.js";
import type { AgentJob, AgentTask, DynamicAgentExecutionState, DynamicAgentRecoveryAction } from "../agents/agent-runtime.js";
import type { RequirementExecutionKind } from "../requirements/requirement.js";
import type { ExecutionContext } from "./execution-context.js";
import type { ExecutionEngine, ExecutionEngineResult, ExecutionEngineSnapshot, ExecutionFeedback } from "./execution-engine.js";
import type { ExecutionLeaseCommitBoundary } from "../runtime/execution-lease-coordinator.js";

const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "partial", "cancelled"]);

/** Reserved integration boundary for the persistent Lease owner; this engine never creates another lease. */
export interface DynamicExecutionOwnership {
  withJob<T>(jobId: string, operation: () => Promise<T>): Promise<T>;
}

export interface DynamicAgentExecutionEngineOptions {
  runStore?: AgentRunStore;
  persist?: (boundary: ExecutionLeaseCommitBoundary) => void | Promise<void>;
  cancelTurn?: (turnId: string) => boolean;
  cancelChildren?: (turnId: string) => number;
  cancelScheduler?: (jobId: string) => void;
  recoverScheduler?: (jobId: string) => void | Promise<void>;
  ownership?: DynamicExecutionOwnership;
}

export class DynamicAgentExecutionEngine implements ExecutionEngine {
  readonly id = "dynamic_agent";
  readonly control = "engine" as const;
  private readonly contexts = new Map<string, ExecutionContext>();
  private readonly activeDrives = new Set<string>();

  constructor(private readonly runtimeStore: AgentRuntimeStore, private readonly options: DynamicAgentExecutionEngineOptions = {}) {}

  supports(kind: RequirementExecutionKind): boolean { return kind === "analysis_only" || kind === "software_change"; }
  isActive(jobId: string): boolean { return this.activeDrives.has(jobId); }

  async provideFeedback(jobId: string, feedback: ExecutionFeedback): Promise<boolean> {
    return this.withOwnership(jobId, async () => {
      const job = this.requireDynamicJob(jobId);
      if (TERMINAL_JOB_STATUSES.has(job.status)) return false;
      if (job.rootTurnId !== feedback.turnId) {
        this.runtimeStore.rebindJobTurn(jobId, feedback.turnId);
        const root = this.options.runStore?.get(job.rootRunId);
        if (root !== undefined) this.options.runStore?.rebindAttempt(root.id, feedback.turnId, job.attempt);
      }
      const resumable = this.runtimeStore.listTasks(jobId).filter((task) =>
        task.jobAttempt === job.attempt && ["blocked", "failed", "lost"].includes(task.status) && task.attempt < task.maxAttempts);
      resumable.forEach((task) => this.runtimeStore.setTaskStatus(task.id, "rework"));
      this.runtimeStore.setJobStatus(jobId, "running");
      this.record(jobId, "queued", "explicit_model_resume", "User feedback authorizes an explicit parent resume", resumable);
      await this.persist("runtime_state");
      return true;
    });
  }

  async start(context: ExecutionContext): Promise<ExecutionEngineResult> {
    return this.withOwnership(context.jobId, async () => {
      const job = this.requireDynamicJob(context.jobId);
      if (job.threadId !== context.threadId || job.rootRunId !== context.rootRunId || job.executionKind !== context.executionKind || job.workflowVersion !== context.workflowVersion) {
        throw new Error(`Dynamic execution context does not match persisted Job: ${context.jobId}`);
      }
      this.contexts.set(context.jobId, context);
      return this.drive(context.jobId);
    });
  }

  async resume(jobId: string): Promise<ExecutionEngineResult> {
    return this.withOwnership(jobId, () => this.drive(jobId));
  }

  async recover(jobId: string): Promise<void> {
    await this.withOwnership(jobId, async () => {
      this.requireDynamicJob(jobId);
      await this.options.recoverScheduler?.(jobId);
      this.runtimeStore.recoverInterruptedWork(undefined, jobId);
      this.runtimeStore.reconcilePersistedJobs(jobId);
      this.runtimeStore.setDynamicExecution(this.classify(jobId));
      await this.persist("runtime_state");
      // Fact-only recovery: never invoke a model from process startup.
    });
  }

  async cancel(jobId: string): Promise<void> {
    await this.withOwnership(jobId, async () => {
      const job = this.requireDynamicJob(jobId);
      this.options.cancelScheduler?.(jobId);
      this.options.cancelChildren?.(job.rootTurnId);
      this.options.cancelTurn?.(job.rootTurnId);
      this.runtimeStore.cancelJob(jobId);
      this.options.runStore?.closeActiveForJob(jobId, "cancelled", "Dynamic Agent Job cancelled by user");
      this.record(jobId, "terminal", "terminate", "Job was cancelled", []);
      await this.persist("cancel");
    });
  }

  snapshot(jobId: string): ExecutionEngineSnapshot {
    const job = this.runtimeStore.getJob(jobId);
    const state = this.runtimeStore.getDynamicExecution(jobId);
    return { engine: this.id, jobId,
      ...(job === undefined ? {} : { workflowVersion: job.workflowVersion }),
      ...(state === undefined ? {} : { phase: state.phase, recoveryAction: state.recoveryAction, reason: state.reason,
        ...(state.deadlineAt === undefined ? {} : { deadlineAt: state.deadlineAt }) }),
      terminal: job === undefined || TERMINAL_JOB_STATUSES.has(job.status) };
  }

  private async drive(jobId: string): Promise<ExecutionEngineResult> {
    if (this.activeDrives.has(jobId)) throw new Error(`Dynamic Agent Job is already active: ${jobId}`);
    const job = this.requireDynamicJob(jobId);
    if (TERMINAL_JOB_STATUSES.has(job.status)) return {};
    const context = this.contexts.get(jobId);
    if (context?.drive === undefined) {
      this.runtimeStore.setDynamicExecution(this.classify(jobId));
      await this.persist("runtime_state");
      throw new Error(`Dynamic Agent resume requires an explicit validated drive context: ${jobId}`);
    }
    const before = this.classify(jobId);
    const continuation = before.returnIds.length > 0 || before.phase === "return_ready";
    const claimedReturns = continuation
      ? before.returnIds.map((id) => this.runtimeStore.claimReturn(id)).filter((item) => item !== undefined)
      : [];
    if (continuation && claimedReturns.length === 0) throw new Error("Dynamic parent continuation has no claimable Return");
    this.activeDrives.add(jobId);
    try {
      this.runtimeStore.setJobStatus(jobId, continuation ? "resuming" : "running");
      this.record(jobId, continuation ? "parent_continuation" : "parent_running", "manual_intervention",
        "A model call is in flight; restart requires an explicit outcome decision", this.runtimeStore.listTasks(jobId), before.returnIds);
      this.options.runStore?.setStatus(job.rootRunId, continuation ? "resuming" : "running");
      if (continuation) await this.persist("return_claim");
      await this.persist("parent_continuation");
      const hasPersistedChildren = this.currentTasks(jobId).length > 0;
      const driven = await context.drive({ kind: continuation ? "parent_continuation" : "root",
        ...(!continuation && !hasPersistedChildren ? {} : { guidance: this.buildParentGuidance(jobId) }) });
      await this.persist("model_commit");
      // Cancellation is linearized by its fenced commit. A provider may still
      // return successfully after Abort; that late result must not consume a
      // Return or move the Job out of its already-published terminal state.
      if (TERMINAL_JOB_STATUSES.has(this.requireDynamicJob(jobId).status)) return driven;
      for (const item of claimedReturns) {
        const current = this.runtimeStore.listReturns(jobId).find((candidate) => candidate.id === item.id);
        if (current?.status === "delivering") this.runtimeStore.consumeReturn(item.id);
      }
      const tasks = this.currentTasks(jobId);
      if (tasks.length === 0) this.runtimeStore.setJobStatus(jobId, "completed");
      else this.runtimeStore.reconcileJobStatus(jobId);
      if (this.runtimeStore.getJob(jobId)?.status === "completed") {
        this.options.runStore?.complete(job.rootRunId, { runId: job.rootRunId, status: "completed", summary: "Dynamic parent Agent completed exactly once" });
      }
      this.runtimeStore.setDynamicExecution(this.classify(jobId));
      await this.persist(continuation ? "return_consume" : "runtime_state");
      return driven;
    } catch (error) {
      // A concurrent cancel/failure that already reached a terminal Job is the
      // authority. A late ordinary provider error may be reported to its
      // caller, but must not reopen Return delivery or replace that terminal.
      if (TERMINAL_JOB_STATUSES.has(this.requireDynamicJob(jobId).status)) throw error;
      const cancelled = error instanceof Error && ["TurnCancelledError", "AbortError"].includes(error.name);
      if (continuation && !cancelled) {
        for (const item of claimedReturns) {
          const current = this.runtimeStore.listReturns(jobId).find((candidate) => candidate.id === item.id);
          if (current?.status === "delivering") this.runtimeStore.retryReturn(item.id, 0);
        }
        this.runtimeStore.setJobStatus(jobId, "waiting_returns");
        this.record(jobId, "manual_intervention", "manual_intervention",
          "Parent continuation failed after Return claim; outcome must be resolved before another delivery", this.currentTasks(jobId), claimedReturns.map((item) => item.id));
        await this.persist("parent_continuation");
        throw error;
      }
      this.options.runStore?.closeActiveForJob(jobId, cancelled ? "cancelled" : "failed", "Dynamic Agent execution stopped",
        error instanceof Error ? error.message : "Unknown dynamic execution failure");
      this.runtimeStore.closeActiveTasks(jobId, cancelled ? "cancelled" : "failed");
      this.runtimeStore.failJob(jobId, cancelled ? "cancelled" : "failed", cancelled ? "user_cancelled" : "dynamic_drive_failed");
      this.record(jobId, "terminal", "terminate", cancelled ? "Execution was cancelled" : "Parent drive failed", []);
      await this.persist("runtime_state");
      throw error;
    } finally { this.activeDrives.delete(jobId); }
  }

  private classify(jobId: string): Omit<DynamicAgentExecutionState, "generation" | "updatedAt"> {
    const job = this.requireDynamicJob(jobId);
    const tasks = this.currentTasks(jobId);
    const returns = this.runtimeStore.listReturns(jobId).filter((item) => item.jobAttempt === undefined || item.jobAttempt === job.attempt);
    const pendingReturns = returns.filter((item) => item.status === "ready" || item.status === "delivering");
    const base = { jobId, jobAttempt: job.attempt, taskIds: tasks.map((task) => task.id), returnIds: pendingReturns.map((item) => item.id) };
    if (TERMINAL_JOB_STATUSES.has(job.status)) return { ...base, phase: "terminal", recoveryAction: "terminate", reason: `Job is ${job.status}` };
    if (pendingReturns.length > 0) {
      const previous = this.runtimeStore.getDynamicExecution(jobId);
      if (previous?.recoveryAction === "manual_intervention" &&
        (previous.phase === "parent_continuation" || previous.phase === "manual_intervention")) {
        return { ...base, phase: "manual_intervention", recoveryAction: "manual_intervention", reason: "Parent continuation was in flight at restart; final-delivery outcome is unknown" };
      }
      return { ...base, phase: "return_ready", recoveryAction: "explicit_model_resume", reason: "Durable child Return awaits an explicitly authorized parent continuation" };
    }
    if (tasks.some((task) => task.status === "blocked")) return { ...base, phase: "waiting_user", recoveryAction: "wait_user", reason: "A child Task requires user feedback" };
    const running = tasks.filter((task) => ["claimed", "running", "awaiting_evidence", "reviewing", "rework"].includes(task.status));
    if (running.length > 0) {
      const deadlineAt = running.map((task) => task.leaseExpiresAt).filter((value): value is string => value !== undefined).sort()[0];
      return { ...base, phase: "child_running", recoveryAction: "manual_intervention", reason: "A child attempt was in flight and its side-effect outcome is not safe to replay", ...(deadlineAt === undefined ? {} : { deadlineAt }) };
    }
    if (tasks.some((task) => ["lost", "failed"].includes(task.status))) return { ...base, phase: "manual_intervention", recoveryAction: "manual_intervention", reason: "An interrupted child attempt needs an explicit retry or termination decision" };
    const waiting = tasks.filter((task) => ["draft", "ready"].includes(task.status));
    if (waiting.length > 0) {
      const dependenciesPending = waiting.some((task) => task.dependencyIds.some((id) => this.runtimeStore.getTask(id)?.status !== "completed"));
      return { ...base, phase: dependenciesPending ? "waiting_dependencies" : "queued", recoveryAction: "explicit_model_resume",
        reason: dependenciesPending ? "Persisted dependency facts are incomplete; resume must be explicit" : "Persisted queued work may resume only through an explicit model turn" };
    }
    return { ...base, phase: "queued", recoveryAction: "explicit_model_resume", reason: "Dynamic Job awaits its explicit root turn" };
  }

  private buildParentGuidance(jobId: string): string {
    const job = this.requireDynamicJob(jobId);
    const returns = this.runtimeStore.listReturns(jobId).filter((item) => item.status === "ready" || item.status === "delivering");
    const tasks = this.currentTasks(jobId);
    return ["[Dynamic Engine durable child feedback]", JSON.stringify({ jobId, jobAttempt: job.attempt,
      tasks: tasks.map((task) => ({ taskId: task.id, status: task.status, attempt: task.attempt,
        maxAttempts: task.maxAttempts, objective: task.objective,
        threadId: this.options.runStore?.get(task.ownerRunId)?.threadId,
        nextAction: ["failed", "lost", "blocked", "rework", "draft", "ready"].includes(task.status)
          ? "resume_same_task_with_new_attempt" : "wait_or_validate" })),
      returns: returns.map((item) => ({ returnId: item.id, taskId: item.taskId, childRunId: item.childRunId,
        status: item.result.status, summary: item.result.summary,
        nextAction: item.result.status === "completed" ? "validate_and_finish" : "retry_same_task_or_terminate" })) }),
      "Continue as the parent supervisor. For retry, call run_agent with the listed taskId so Runtime reuses the original Job, Task, and child Thread with a new attempt. Do not create a duplicate task."].join("\n");
  }

  private record(jobId: string, phase: DynamicAgentExecutionState["phase"], recoveryAction: DynamicAgentRecoveryAction,
    reason: string, tasks: AgentTask[], returnIds: string[] = []): void {
    const job = this.requireDynamicJob(jobId);
    this.runtimeStore.setDynamicExecution({ jobId, jobAttempt: job.attempt, phase, recoveryAction, reason,
      taskIds: tasks.map((task) => task.id), returnIds });
  }
  private currentTasks(jobId: string): AgentTask[] { const job = this.requireDynamicJob(jobId); return this.runtimeStore.listTasks(jobId).filter((task) => task.jobAttempt === job.attempt && task.parentTaskId === undefined); }
  private requireDynamicJob(jobId: string): AgentJob { const job = this.runtimeStore.getJob(jobId); if (job === undefined) throw new Error(`Dynamic Agent Job is unavailable: ${jobId}`); if (!this.supports(job.executionKind) || job.workflowVersion !== "dynamic_v1") throw new Error(`Dynamic Agent Job version is unsupported: ${jobId}`); return job; }
  private persist(boundary: ExecutionLeaseCommitBoundary): Promise<void> { return Promise.resolve(this.options.persist?.(boundary)); }
  private withOwnership<T>(jobId: string, operation: () => Promise<T>): Promise<T> { return this.options.ownership?.withJob(jobId, operation) ?? operation(); }
}
