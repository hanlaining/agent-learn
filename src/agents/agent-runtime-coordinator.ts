import { AgentRuntimeStore } from "./agent-runtime-store.js";
import type { AgentJob, AgentReturnEnvelope } from "./agent-runtime.js";

export interface AgentRuntimeCoordinatorOptions {
  store: AgentRuntimeStore;
  persist?: () => void | Promise<void>;
  maxAttempts?: number;
  retryDelayMs?: (attempt: number) => number;
}

export class AgentRuntimeCoordinator {
  private readonly maxAttempts: number;
  private readonly retryDelayMs: (attempt: number) => number;
  private readonly jobLocks = new Map<string, Promise<void>>();

  constructor(private readonly options: AgentRuntimeCoordinatorOptions) {
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? ((attempt) => Math.min(4_000, 250 * 2 ** (attempt - 1)));
  }

  async continueParent<T>(parentTurnId: string, childRunIds: string[], continuation: () => Promise<T>): Promise<T> {
    const returnForChild = this.options.store.listReturns().find((item) => childRunIds.includes(item.childRunId));
    const job = this.options.store.getJobByTurn(parentTurnId) ??
      (returnForChild === undefined ? undefined : this.options.store.getJob(returnForChild.jobId));
    if (job === undefined || childRunIds.length === 0) return continuation();
    const selected = this.options.store.listReturns(job.id)
      .filter((item) => childRunIds.includes(item.childRunId) && item.status !== "consumed");
    if (selected.length === 0) return continuation();

    return this.withJobLock(job.id, async () => {
      let lastError: unknown;
      for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
        const claimed = selected.map((item) => this.options.store.claimReturn(item.id)).filter((item) => item !== undefined);
        if (claimed.length === 0) throw new Error("Agent Return is not ready for delivery");
        this.options.store.setJobStatus(job.id, "resuming");
        this.recordDynamicContinuation(job, claimed.map((item) => item.id), "parent_continuation",
          "Parent continuation is in flight; restart requires an explicit outcome decision");
        await this.options.persist?.();
        try {
          const result = await continuation();
          // 先持久化 continuation 已成功的事实，再提交 consumed receipt。
          await this.options.persist?.();
          claimed.forEach((item) => this.options.store.consumeReturn(item.id));
          this.options.store.reconcileJobStatus(job.id);
          this.recordDynamicContinuation(job, [], "parent_running",
            "Parent continuation committed and the parent loop owns the next transition");
          await this.options.persist?.();
          return result;
        } catch (error) {
          lastError = error;
          const committedReceipt = this.options.store.listReturns(job.id)
            .some((item) => claimed.some((candidate) => candidate.id === item.id) && item.status === "consumed");
          if (committedReceipt) throw error;
          for (const item of claimed) {
            const current = this.options.store.listReturns(job.id).find((candidate) => candidate.id === item.id);
            if (current?.status === "delivering") this.options.store.retryReturn(item.id, 0);
          }
          this.options.store.setJobStatus(job.id, "waiting_returns");
          this.recordDynamicContinuation(job, claimed.map((item) => item.id), "manual_intervention",
            "Parent continuation failed after Return claim; retry needs an explicit decision");
          await this.options.persist?.();
          if (attempt < this.maxAttempts) await delay(this.retryDelayMs(attempt));
        }
      }
      throw lastError;
    });
  }

  async recoverPendingReturns<T>(deliver: (job: AgentJob, returns: AgentReturnEnvelope[]) => Promise<T>,
    include?: (item: AgentReturnEnvelope) => boolean): Promise<T[]> {
    const results: T[] = [];
    const pendingByJob = new Map<string, AgentReturnEnvelope[]>();
    for (const item of this.options.store.listReturns()) {
      if (item.status !== "ready") continue;
      const job = this.options.store.getJob(item.jobId);
      if (job === undefined || ["completed", "partial", "failed", "cancelled"].includes(job.status)) continue;
      if (item.jobAttempt !== undefined && item.jobAttempt !== job.attempt) continue;
      const isV2TeamReturn = job.executionKind === "software_product_delivery" &&
        job.workflowVersion === "software_product_delivery_v2";
      if (include === undefined ? isV2TeamReturn : !include(item)) continue;
      pendingByJob.set(item.jobId, [...(pendingByJob.get(item.jobId) ?? []), item]);
    }
    for (const [jobId, pending] of pendingByJob) {
      await this.withJobLock(jobId, async () => {
        const job = this.options.store.getJob(jobId);
        if (job === undefined || ["completed", "partial", "failed", "cancelled"].includes(job.status)) return;
        const claimed = pending.map((item) => this.options.store.claimReturn(item.id)).filter((item): item is AgentReturnEnvelope => item !== undefined);
        if (claimed.length === 0) return;
        this.options.store.setJobStatus(job.id, "resuming"); await this.options.persist?.();
        if (claimed.every((item) => item.result.status !== "completed")) {
          claimed.forEach((item) => this.options.store.consumeReturn(item.id));
          this.options.store.reconcileJobStatus(job.id);
          await this.options.persist?.();
          return;
        }
        try {
          const result = await deliver(job, claimed); await this.options.persist?.();
          claimed.forEach((item) => this.options.store.consumeReturn(item.id));
          this.options.store.reconcileJobStatus(job.id);
          await this.options.persist?.(); results.push(result);
        } catch (error) {
          const committedReceipt = this.options.store.listReturns(job.id)
            .some((item) => claimed.some((candidate) => candidate.id === item.id) && item.status === "consumed");
          if (committedReceipt) throw error;
          claimed.forEach((item) => {
            const current = this.options.store.listReturns(job.id).find((candidate) => candidate.id === item.id);
            if (current?.status === "delivering") {
              this.options.store.retryReturn(item.id, this.retryDelayMs(item.attempts));
            }
          });
          this.options.store.setJobStatus(job.id, "waiting_returns"); await this.options.persist?.();
          process.stderr.write(`[agent-runtime] pending Return recovery deferred: ${error instanceof Error ? error.message : "unknown error"}\n`);
        }
      });
    }
    return results;
  }

  /**
   * 这里只提供单进程内的 Job 串行化。未来增加多进程恢复时，持久 lease
   * 必须在这个边界内、任何 Return claim 之前获取并在 finally 中释放。
   */
  private async withJobLock<T>(jobId: string, operation: () => Promise<T>): Promise<T> {
    const predecessor = this.jobLocks.get(jobId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = predecessor.catch(() => undefined).then(() => gate);
    this.jobLocks.set(jobId, tail);
    await predecessor.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.jobLocks.get(jobId) === tail) this.jobLocks.delete(jobId);
    }
  }

  private recordDynamicContinuation(job: AgentJob, returnIds: string[],
    phase: "parent_continuation" | "parent_running" | "manual_intervention", reason: string): void {
    if (job.workflowVersion !== "dynamic_v1") return;
    this.options.store.setDynamicExecution({ jobId: job.id, jobAttempt: job.attempt, phase,
      recoveryAction: "manual_intervention", reason,
      taskIds: this.options.store.listTasks(job.id).filter((task) => task.jobAttempt === job.attempt).map((task) => task.id),
      returnIds });
  }
}

function delay(milliseconds: number): Promise<void> {
  return milliseconds <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, milliseconds));
}
