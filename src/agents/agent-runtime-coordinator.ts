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

  constructor(private readonly options: AgentRuntimeCoordinatorOptions) {
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? ((attempt) => Math.min(4_000, 250 * 2 ** (attempt - 1)));
  }

  async continueParent<T>(parentTurnId: string, childRunIds: string[], continuation: () => Promise<T>): Promise<T> {
    const job = this.options.store.getJobByTurn(parentTurnId);
    if (job === undefined || childRunIds.length === 0) return continuation();
    const selected = this.options.store.listReturns(job.id)
      .filter((item) => childRunIds.includes(item.childRunId) && item.status !== "consumed");
    if (selected.length === 0) return continuation();

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const claimed = selected.map((item) => this.options.store.claimReturn(item.id)).filter((item) => item !== undefined);
      if (claimed.length === 0) throw new Error("Agent Return is not ready for delivery");
      await this.options.persist?.();
      try {
        const result = await continuation();
        // 先持久化 continuation 已成功的事实，再提交 consumed receipt。
        await this.options.persist?.();
        claimed.forEach((item) => this.options.store.consumeReturn(item.id));
        await this.options.persist?.();
        return result;
      } catch (error) {
        lastError = error;
        for (const item of claimed) this.options.store.retryReturn(item.id, 0);
        await this.options.persist?.();
        if (attempt < this.maxAttempts) await delay(this.retryDelayMs(attempt));
      }
    }
    throw lastError;
  }

  async recoverPendingReturns<T>(deliver: (job: AgentJob, returns: AgentReturnEnvelope[]) => Promise<T>): Promise<T[]> {
    const results: T[] = [];
    const pendingByJob = new Map<string, AgentReturnEnvelope[]>();
    for (const item of this.options.store.listReturns().filter((candidate) => candidate.status === "ready")) {
      pendingByJob.set(item.jobId, [...(pendingByJob.get(item.jobId) ?? []), item]);
    }
    for (const [jobId, pending] of pendingByJob) {
      const job = this.options.store.getJob(jobId); if (job === undefined || job.status === "cancelled") continue;
      const claimed = pending.map((item) => this.options.store.claimReturn(item.id)).filter((item): item is AgentReturnEnvelope => item !== undefined);
      if (claimed.length === 0) continue;
      this.options.store.setJobStatus(job.id, "resuming"); await this.options.persist?.();
      try {
        const result = await deliver(job, claimed); await this.options.persist?.();
        claimed.forEach((item) => this.options.store.consumeReturn(item.id)); this.options.store.setJobStatus(job.id, "completed");
        await this.options.persist?.(); results.push(result);
      } catch (error) {
        claimed.forEach((item) => this.options.store.retryReturn(item.id, this.retryDelayMs(item.attempts)));
        this.options.store.setJobStatus(job.id, "waiting_returns"); await this.options.persist?.();
        process.stderr.write(`[agent-runtime] pending Return recovery deferred: ${error instanceof Error ? error.message : "unknown error"}\n`);
      }
    }
    return results;
  }
}

function delay(milliseconds: number): Promise<void> {
  return milliseconds <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, milliseconds));
}
