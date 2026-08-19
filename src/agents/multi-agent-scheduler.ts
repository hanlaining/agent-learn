import type { AgentProfile } from "./agent-profile.js";
import { AgentRegistry } from "./agent-registry.js";
import type { AgentRunResult } from "./agent-run.js";
import { AgentRunStore } from "./agent-run-store.js";
import { AgentRuntimeStore } from "./agent-runtime-store.js";
import { DEFAULT_AGENT_TEAM_CONFIG, type AgentTeamConfig } from "./agent-runtime.js";

export interface ChildAgentRequest {
  parentTurnId: string; profileId: string; task: string;
  taskId?: string;
  dependsOnTaskIds?: string[]; fileClaims?: string[];
  requiredOutputs?: string[]; acceptanceCriteria?: string[];
  signal?: AbortSignal; deadlineAt?: string;
}
export interface ChildAgentExecution {
  threadId: string;
  turnId: string;
  execute(): Promise<string>;
}
export interface MultiAgentSchedulerOptions {
  registry: AgentRegistry; store: AgentRunStore;
  runtimeStore?: AgentRuntimeStore;
  resolveParent(turnId: string): { threadId: string; teamConfig?: AgentTeamConfig } | undefined;
  prepare(profile: AgentProfile, task: string, parentRunId: string, taskId: string, attempt: number): ChildAgentExecution;
  maxConcurrentRuns?: number; maxDepth?: number; maxChildrenPerRun?: number;
  persist?: () => void | Promise<void>;
  onRunUpdated?: (rootThreadId: string, parentTurnId: string, runId: string) => void;
  review?: (input: { taskId: string; jobId: string; workerRunId: string; summary: string }) => Promise<{ passed: boolean; summary: string; severity?: "P0" | "P1" | "P2" | "P3" }>;
  enableAutomaticReview?: boolean;
  waitTimeoutMs?: number;
}

interface CapacityWaiter {
  jobId: string; jobLimit: number;
  resolve: () => void; reject: (error: Error) => void;
}

export class MultiAgentScheduler {
  private active = 0;
  private readonly queue: CapacityWaiter[] = [];
  private readonly childrenByParent = new Map<string, Set<string>>();
  private readonly activeTurnsByParent = new Map<string, Set<string>>();
  private readonly activeByJob = new Map<string, number>();
  private readonly lastServedJobs: string[] = [];
  private readonly runtimeStore: AgentRuntimeStore;
  private readonly legacyReceiptMode: boolean;
  private readonly waitTimeoutMs: number;
  readonly maxConcurrentRuns: number;
  readonly maxDepth: number;
  readonly maxChildrenPerRun: number;

  constructor(private readonly options: MultiAgentSchedulerOptions) {
    this.maxConcurrentRuns = options.maxConcurrentRuns ?? 4;
    this.maxDepth = options.maxDepth ?? 3;
    this.maxChildrenPerRun = options.maxChildrenPerRun ?? 4;
    this.runtimeStore = options.runtimeStore ?? new AgentRuntimeStore();
    this.legacyReceiptMode = options.runtimeStore === undefined;
    this.waitTimeoutMs = options.waitTimeoutMs ?? 120_000;
  }

  async runAgent(request: ChildAgentRequest): Promise<AgentRunResult> {
    const parentFact = this.options.resolveParent(request.parentTurnId);
    if (parentFact === undefined) throw new Error("Parent Turn is unavailable");
    const parent = this.options.store.ensureRoot(parentFact.threadId, request.parentTurnId);
    const existingJob = this.runtimeStore.getJob(parent.jobId) ?? this.runtimeStore.getJobByTurn(request.parentTurnId);
    const config = existingJob?.configSnapshot ?? parentFact.teamConfig ?? DEFAULT_AGENT_TEAM_CONFIG;
    const job = existingJob ?? this.runtimeStore.createJob({ threadId: parentFact.threadId, rootTurnId: request.parentTurnId, rootRunId: parent.rootRunId, configSnapshot: config });
    if (config.mode === "off") throw new Error("Agent collaboration is disabled for this Job");
    if (parent.depth >= config.maxDepth) throw new Error("Agent delegation depth exceeded");
    if (!config.allowedProfiles.includes(request.profileId as never)) throw new Error("Agent profile is not allowed for this Job");
    if (this.countTaskRuns(job.id) >= config.maxSubagents) throw new Error("Agent Job budget exceeded");
    const children = this.childrenByParent.get(parent.id) ?? new Set<string>();
    const registeredProfile = this.options.registry.require(request.profileId);
    const routedModel = config.modelRouting === "role_based" ? config.roleModels?.[request.profileId as keyof typeof config.roleModels] : undefined;
    const profile: AgentProfile = routedModel === undefined ? registeredProfile : { ...registeredProfile, defaultModel: routedModel.model,
      ...(routedModel.reasoningEffort === undefined ? {} : { reasoningEffort: routedModel.reasoningEffort }) };
    this.options.store.setStatus(parent.id, "waiting_children");
    this.notify(parentFact.threadId, request.parentTurnId, parent.id);

    let childId: string | undefined;
    let taskId: string | undefined;
    let workerCompleted = false;
    let acquired = false;
    try {
      const resumedTask = request.taskId === undefined ? undefined : this.runtimeStore.getTask(request.taskId);
      if (request.taskId !== undefined && (resumedTask === undefined || resumedTask.jobId !== job.id || resumedTask.parentTaskId !== undefined)) {
        throw new Error("Resumed Task is unavailable for this Job");
      }
      if (resumedTask !== undefined && (["completed", "cancelled"].includes(resumedTask.status) || resumedTask.attempt >= resumedTask.maxAttempts)) {
        throw new Error("Resumed Task has no eligible attempt");
      }
      const attempt = resumedTask === undefined ? 1 : resumedTask.attempt + 1;
      const task = resumedTask ?? this.runtimeStore.createTask({ jobId: job.id, rootRunId: parent.rootRunId, ownerRunId: `pending:${parent.id}`,
        profileId: profile.id, title: request.task.slice(0, 80), objective: request.task,
        scope: { allowedPaths: [], deniedPaths: [], nonGoals: [] }, requiredOutputs: request.requiredOutputs ?? ["结构化子任务结论"],
        acceptanceCriteria: request.acceptanceCriteria ?? ["子 Agent 返回可验证结果"], fileClaims: request.fileClaims ?? [], maxAttempts: 2, status: "draft" });
      if (resumedTask !== undefined) this.runtimeStore.setTaskStatus(task.id, "draft");
      taskId = task.id;
      const execution = this.options.prepare(profile, request.task, parent.id, task.id, attempt);
      const child = this.options.store.create({ jobId: job.id, threadId: execution.threadId, turnId: execution.turnId,
        agentProfileId: profile.id, parentRunId: parent.id, task: request.task, depth: parent.depth + 1, attempt });
      childId = child.id; children.add(child.id); this.childrenByParent.set(parent.id, children);
      this.runtimeStore.setTaskOwnerRun(task.id, child.id, attempt);
      this.options.store.setTaskId(child.id, task.id);
      for (const dependencyId of resumedTask === undefined ? request.dependsOnTaskIds ?? [] : []) {
        this.runtimeStore.addEdge({ jobId: job.id, fromTaskId: dependencyId, toTaskId: task.id, type: "depends_on", hard: true });
      }
      const deadlineAt = request.deadlineAt ?? new Date(Date.now() + this.waitTimeoutMs).toISOString();
      const readyBeforeWait = this.runtimeStore.readyTasks(job.id).some((item) => item.id === task.id);
      this.recordDynamic(job.id, readyBeforeWait ? "queued" : "waiting_dependencies", "explicit_model_resume",
        readyBeforeWait ? "Child Task is durably queued" : "Child Task is waiting for durable dependency facts", [task.id], [], deadlineAt);
      await this.options.persist?.();
      await this.waitUntilReady(job.id, task.id, deadlineAt, request.signal);
      await this.acquire(job.id, config.maxConcurrent, deadlineAt, request.signal);
      acquired = true;
      this.runtimeStore.claimTask(task.id, child.id, 30_000);
      this.runtimeStore.setTaskStatus(task.id, "running");
      const runningTask = this.runtimeStore.getTask(task.id);
      this.recordDynamic(job.id, "child_running", "manual_intervention",
        "Child attempt is in flight and cannot be replayed without an outcome decision", [task.id], [], runningTask?.leaseExpiresAt);
      await this.options.persist?.();
      const activeTurns = this.activeTurnsByParent.get(parent.id) ?? new Set<string>();
      activeTurns.add(execution.turnId);
      this.activeTurnsByParent.set(parent.id, activeTurns);
      this.options.store.setStatus(child.id, "running");
      this.notify(parentFact.threadId, request.parentTurnId, child.id);
      const summary = await execution.execute();
      const result: AgentRunResult = { runId: child.id, taskId: task.id, status: "completed", summary };
      this.options.store.complete(child.id, result);
      workerCompleted = true;
      const evidence = this.runtimeStore.addEvidence({ jobId: job.id, taskId: task.id, runId: child.id,
        kind: "summary", summary, producer: "worker", verdict: "supported" });
      let deliveryRunId = child.id; let deliverySummary = summary; const deliveryEvidenceIds = [evidence.id];
      this.runtimeStore.setTaskStatus(task.id, "awaiting_evidence");
      const boardEntryIds: string[] = [];
      if (config.shareBoard) {
        boardEntryIds.push(this.runtimeStore.publishBoard({ jobId: job.id, producerRunId: child.id, kind: "summary",
          title: task.title, summary, confidence: "supported", visibility: "job" }).id);
      }
      if (config.independentReview && profile.id !== "reviewer") {
        this.runtimeStore.setTaskStatus(task.id, "reviewing");
        const review = this.options.review !== undefined
          ? await this.options.review({ taskId: task.id, jobId: job.id, workerRunId: child.id, summary })
          : this.options.enableAutomaticReview === true
            ? await this.runIndependentReviewer(job.id, parent.id, child.id, task.id, request, summary, config)
            : { passed: true, summary: "测试兼容路径：未启用自动 Reviewer" };
        this.runtimeStore.addEvidence({ jobId: job.id, taskId: task.id, runId: `${child.id}:review`, kind: "review",
          summary: review.summary, producer: "reviewer", verdict: review.passed ? "passed" : "failed", ...(review.severity === undefined ? {} : { severity: review.severity }) });
        const verdict = this.runtimeStore.reviewTask(task.id);
        if (!verdict.passed) {
          if (verdict.rework && task.attempt < task.maxAttempts) {
            const rework = await this.runRework(job.id, parent.id, task.id, profile, request, review.summary, config);
            deliveryRunId = rework.runId; deliverySummary = rework.summary; deliveryEvidenceIds.push(...rework.evidenceIds);
          } else {
            throw new Error(`Independent review failed: ${review.summary}`);
          }
        }
      } else {
        this.runtimeStore.addEvidence({ jobId: job.id, taskId: task.id, runId: `${child.id}:runtime-review`, kind: "review",
          summary: "当前 Job 未要求独立 Reviewer，Runtime 按验收合同关闭", producer: "reviewer", verdict: "passed" });
        this.runtimeStore.reviewTask(task.id);
      }
      const envelope = this.runtimeStore.createReturn({ jobId: job.id, rootRunId: parent.rootRunId, parentRunId: parent.id,
        childRunId: deliveryRunId, taskId: task.id, sequence: parent.childRunIds.length,
        result: { status: "completed", summary: deliverySummary, evidenceIds: [...deliveryEvidenceIds, ...this.runtimeStore.listEvidence(task.id).filter((item) => item.kind === "review").map((item) => item.id)], boardEntryIds },
        idempotencyKey: `${job.id}:${deliveryRunId}` });
      this.recordDynamic(job.id, "return_ready", "explicit_model_resume", "Durable child Return awaits parent continuation",
        [task.id], [envelope.id]);
      this.notify(parentFact.threadId, request.parentTurnId, child.id);
      this.options.store.setStatus(parent.id, "resuming");
      this.notify(parentFact.threadId, request.parentTurnId, parent.id);
      await this.options.persist?.();
      if (this.legacyReceiptMode) this.options.store.receiveReturn(result);
      return deliveryRunId === child.id ? result : { runId: deliveryRunId, taskId: task.id, status: "completed", summary: deliverySummary };
    } catch (error) {
      const result: AgentRunResult = { runId: childId ?? "unstarted", status: "failed", summary: "子 Agent 未完成", safeError: error instanceof Error ? error.message : "Unknown child agent failure" };
      // A Reviewer failure invalidates the Task/Return, but it must not rewrite
      // an already completed Worker Run as though the Worker itself crashed.
      if (childId !== undefined && !workerCompleted) this.options.store.complete(childId, result);
      if (childId !== undefined) this.notify(parentFact.threadId, request.parentTurnId, childId);
      this.options.store.setStatus(parent.id, "resuming");
      this.notify(parentFact.threadId, request.parentTurnId, parent.id);
      if (childId !== undefined && taskId !== undefined) {
        const evidence = this.runtimeStore.addEvidence({ jobId: job.id, taskId, runId: childId,
          kind: "summary", summary: result.summary, producer: "runtime", verdict: "failed" });
        this.runtimeStore.setTaskStatus(taskId, "failed");
        const envelope = this.runtimeStore.createReturn({ jobId: job.id, rootRunId: parent.rootRunId, parentRunId: parent.id,
          childRunId: childId, taskId, sequence: parent.childRunIds.length,
          result: { status: "failed", summary: result.summary, evidenceIds: [evidence.id], boardEntryIds: [] },
          idempotencyKey: `${job.id}:${childId}` });
        this.recordDynamic(job.id, "return_ready", "explicit_model_resume", "Failed child feedback awaits parent decision",
          [taskId], [envelope.id]);
      }
      await this.options.persist?.();
      if (this.legacyReceiptMode && childId !== undefined) this.options.store.receiveReturn(result);
      return result;
    } finally {
      if (childId !== undefined) children.delete(childId);
      if (childId !== undefined) {
        const child = this.options.store.get(childId);
        if (child !== undefined) this.activeTurnsByParent.get(parent.id)?.delete(child.turnId);
      }
      if (acquired) this.release(job.id);
    }
  }

  cancelChildren(parentTurnId: string, cancel: (turnId: string) => boolean): number {
    const parent = this.options.store.getByTurn(parentTurnId);
    if (parent === undefined) return 0;
    let cancelled = 0;
    const visit = (runId: string) => {
      const run = this.options.store.get(runId);
      if (run === undefined) return;
      for (const childId of run.childRunIds) {
        const child = this.options.store.get(childId);
        if (child === undefined) continue;
        if (cancel(child.turnId)) cancelled += 1;
        if (["queued", "running", "waiting_children", "resuming"].includes(child.status)) {
          this.options.store.complete(child.id, {
            runId: child.id, status: "cancelled", summary: "父 Agent 已取消，子 Agent 已级联停止",
          });
        }
        visit(child.id);
      }
    };
    visit(parent.id);
    return cancelled;
  }

  recoverJob(jobId: string): void {
    this.rejectQueued(jobId, new Error("Scheduler queue was discarded during deterministic restart recovery"));
    this.activeByJob.delete(jobId);
    this.pump();
  }

  cancelJob(jobId: string): void {
    this.rejectQueued(jobId, abortError("Scheduler wait cancelled"));
  }

  private async acquire(jobId: string, jobLimit: number, deadlineAt: string, signal?: AbortSignal): Promise<void> {
    if (this.hasCapacity(jobId, jobLimit)) { this.reserve(jobId); return; }
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) { reject(abortError("Scheduler wait cancelled")); return; }
      const remaining = Date.parse(deadlineAt) - Date.now();
      if (remaining <= 0) { reject(new Error("Scheduler capacity deadline exceeded")); return; }
      let waiter!: CapacityWaiter;
      const onAbort = () => this.removeWaiter(waiter, abortError("Scheduler wait cancelled"));
      const timer = setTimeout(() => this.removeWaiter(waiter, new Error("Scheduler capacity deadline exceeded")), remaining);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
      waiter = { jobId, jobLimit, resolve: () => { cleanup(); resolve(); }, reject: (error) => { cleanup(); reject(error); } };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(waiter); this.pump();
    });
  }
  private release(jobId: string): void { this.active -= 1; this.activeByJob.set(jobId, Math.max(0, (this.activeByJob.get(jobId) ?? 1) - 1)); this.pump(); }
  private hasCapacity(jobId: string, jobLimit: number): boolean { return this.active < this.maxConcurrentRuns && (this.activeByJob.get(jobId) ?? 0) < jobLimit; }
  private reserve(jobId: string): void { this.active += 1; this.activeByJob.set(jobId, (this.activeByJob.get(jobId) ?? 0) + 1); }
  private pump(): void {
    while (this.active < this.maxConcurrentRuns) {
      const eligibleJobs = [...new Set(this.queue.filter((waiter) => this.hasCapacity(waiter.jobId, waiter.jobLimit)).map((waiter) => waiter.jobId))];
      const jobId = eligibleJobs.sort((left, right) => this.lastServedJobs.indexOf(left) - this.lastServedJobs.indexOf(right))[0];
      const index = jobId === undefined ? -1 : this.queue.findIndex((waiter) => waiter.jobId === jobId && this.hasCapacity(waiter.jobId, waiter.jobLimit));
      if (index < 0) return;
      const [waiter] = this.queue.splice(index, 1); this.reserve(waiter!.jobId); waiter!.resolve();
      const previous = this.lastServedJobs.indexOf(waiter!.jobId); if (previous >= 0) this.lastServedJobs.splice(previous, 1); this.lastServedJobs.push(waiter!.jobId);
    }
  }
  private async waitUntilReady(jobId: string, taskId: string, deadlineAt: string, signal?: AbortSignal): Promise<void> {
    while (!this.runtimeStore.readyTasks(jobId).some((item) => item.id === taskId)) {
      const task = this.runtimeStore.getTask(taskId);
      if (task === undefined || ["cancelled", "failed"].includes(task.status)) throw new Error("Task became unavailable while waiting for dependencies");
      await this.waitForRuntimeChange(deadlineAt, signal);
    }
  }

  private waitForRuntimeChange(deadlineAt: string, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) { reject(abortError("Dependency wait cancelled")); return; }
      const remaining = Date.parse(deadlineAt) - Date.now();
      if (remaining <= 0) { reject(new Error("Dependency wait deadline exceeded")); return; }
      let unsubscribe: () => void = () => undefined;
      const finish = (error?: Error) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); unsubscribe(); error === undefined ? resolve() : reject(error); };
      const onAbort = () => finish(abortError("Dependency wait cancelled"));
      const timer = setTimeout(() => finish(new Error("Dependency wait deadline exceeded")), remaining);
      unsubscribe = this.runtimeStore.onChange(() => finish());
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private removeWaiter(waiter: CapacityWaiter, error: Error): void {
    const index = this.queue.indexOf(waiter);
    if (index < 0) return;
    this.queue.splice(index, 1);
    waiter.reject(error);
  }

  private rejectQueued(jobId: string, error: Error): void {
    for (const waiter of [...this.queue]) if (waiter.jobId === jobId) this.removeWaiter(waiter, error);
  }
  private async runIndependentReviewer(jobId: string, parentRunId: string, workerRunId: string, workerTaskId: string,
    request: ChildAgentRequest, workerSummary: string, config: AgentTeamConfig): Promise<{ passed: boolean; summary: string; severity?: "P0" | "P1" | "P2" | "P3" }> {
    if (!config.allowedProfiles.includes("reviewer")) throw new Error("Independent review requires the reviewer profile");
    if (this.countTaskRuns(jobId) >= config.maxSubagents) {
      throw new Error("Agent Job budget has no slot for independent review");
    }
    const worker = this.options.store.get(workerRunId); if (worker === undefined) throw new Error("Worker Run is unavailable for review");
    const profile = this.options.registry.require("reviewer");
    const prompt = `独立验收以下子任务。\n任务：${request.task}\n验收条件：${(request.acceptanceCriteria ?? ["结论可验证"]).join("；")}\nWorker 结论：${workerSummary}\n只返回 JSON：{"verdict":"pass"|"fail","severity":null|"P0"|"P1"|"P2"|"P3","summary":"可验证的审查结论"}。`;
    const reviewTask = this.runtimeStore.createTask({ jobId, rootRunId: worker.rootRunId, ownerRunId: `pending:${workerRunId}`,
      parentTaskId: workerTaskId, profileId: "reviewer", title: `验收：${request.task.slice(0, 70)}`, objective: prompt,
      scope: { allowedPaths: [], deniedPaths: [], nonGoals: ["修改 Worker 产物"] }, requiredOutputs: ["独立验收结论"],
      acceptanceCriteria: ["返回结构化 verdict、severity 与 summary"], fileClaims: [], maxAttempts: 1, status: "running" });
    const execution = this.options.prepare(profile, prompt, workerRunId, reviewTask.id, 1);
    const reviewRun = this.options.store.create({ jobId, threadId: execution.threadId, turnId: execution.turnId,
      agentProfileId: profile.id, parentRunId: worker.depth < config.maxDepth ? workerRunId : parentRunId,
      task: `验收：${request.task}`, depth: Math.min(config.maxDepth, worker.depth + 1), attempt: 1 });
    this.runtimeStore.setTaskOwnerRun(reviewTask.id, reviewRun.id, 1);
    this.options.store.setTaskId(reviewRun.id, reviewTask.id); this.options.store.setStatus(reviewRun.id, "running");
    const job = this.runtimeStore.getJob(jobId);
    this.notify(job?.threadId ?? worker.threadId, job?.rootTurnId ?? worker.turnId, reviewRun.id);
    this.runtimeStore.addEdge({ jobId, fromTaskId: workerTaskId, toTaskId: reviewTask.id, type: "validates", hard: false });
    try {
      const rawReviewSummary = await execution.execute();
      const review = parseReviewerVerdict(rawReviewSummary);
      const reviewSummary = review.summary;
      const severity = review.severity;
      const passed = review.passed;
      const result: AgentRunResult = { runId: reviewRun.id, status: passed ? "completed" : "failed", summary: reviewSummary };
      this.options.store.complete(reviewRun.id, result); this.runtimeStore.setTaskStatus(reviewTask.id, passed ? "completed" : "failed");
      this.notify(job?.threadId ?? worker.threadId, job?.rootTurnId ?? worker.turnId, reviewRun.id);
      return { passed, summary: reviewSummary, ...(severity === undefined ? {} : { severity }) };
    } catch (error) {
      const safeError = error instanceof Error ? error.message : "Unknown reviewer failure";
      this.options.store.complete(reviewRun.id, {
        runId: reviewRun.id, taskId: reviewTask.id, status: "failed", summary: "Reviewer 未完成", safeError,
      });
      this.runtimeStore.setTaskStatus(reviewTask.id, "failed");
      this.notify(job?.threadId ?? worker.threadId, job?.rootTurnId ?? worker.turnId, reviewRun.id);
      throw error;
    }
  }
  private async runRework(jobId: string, parentRunId: string, taskId: string, profile: AgentProfile, request: ChildAgentRequest,
    reviewFeedback: string, config: AgentTeamConfig): Promise<{ runId: string; summary: string; evidenceIds: string[] }> {
    const task = this.runtimeStore.getTask(taskId); if (task === undefined) throw new Error("Rework Task is unavailable");
    const attempt = task.attempt + 1;
    const prompt = `${request.task}\n\n这是同一 Task 的第 ${attempt} 次执行。独立 Reviewer 发现必须返工的问题：${reviewFeedback}\n请保留原任务上下文并针对问题修正，再返回新的可验证结果。`;
    const execution = this.options.prepare(profile, prompt, parentRunId, taskId, attempt);
    const parent = this.options.store.get(parentRunId); if (parent === undefined) throw new Error("Rework parent Run is unavailable");
    const run = this.options.store.create({ jobId, threadId: execution.threadId, turnId: execution.turnId, agentProfileId: profile.id,
      parentRunId, task: request.task, depth: parent.depth + 1, attempt });
    this.options.store.setTaskId(run.id, taskId); this.runtimeStore.setTaskOwnerRun(taskId, run.id, attempt);
    this.runtimeStore.setTaskStatus(taskId, "running"); this.options.store.setStatus(run.id, "running"); this.notify(parent.threadId, parent.turnId, run.id);
    const summary = await execution.execute(); const result: AgentRunResult = { runId: run.id, taskId, status: "completed", summary };
    this.options.store.complete(run.id, result);
    const evidence = this.runtimeStore.addEvidence({ jobId, taskId, runId: run.id, kind: "summary", summary, producer: "worker", verdict: "supported" });
    this.runtimeStore.setTaskStatus(taskId, "reviewing");
    const review = this.options.review !== undefined
      ? await this.options.review({ taskId, jobId, workerRunId: run.id, summary })
      : await this.runIndependentReviewer(jobId, parentRunId, run.id, taskId, request, summary, config);
    const reviewEvidence = this.runtimeStore.addEvidence({ jobId, taskId, runId: `${run.id}:review`, kind: "review", summary: review.summary,
      producer: "reviewer", verdict: review.passed ? "passed" : "failed", ...(review.severity === undefined ? {} : { severity: review.severity }) });
    if (!this.runtimeStore.reviewTask(taskId).passed) throw new Error(`Rework review failed: ${review.summary}`);
    return { runId: run.id, summary, evidenceIds: [evidence.id, reviewEvidence.id] };
  }
  private notify(threadId: string, turnId: string, runId: string): void {
    const root = this.options.store.getRoot(runId);
    this.options.onRunUpdated?.(
      root?.threadId ?? threadId,
      root?.turnId ?? turnId,
      runId,
    );
  }

  private countTaskRuns(jobId: string): number {
    return this.options.store.listForJob(jobId).filter((run) => run.taskId !== undefined).length;
  }

  private recordDynamic(jobId: string,
    phase: import("./agent-runtime.js").DynamicAgentExecutionPhase,
    recoveryAction: import("./agent-runtime.js").DynamicAgentRecoveryAction,
    reason: string, taskIds: string[], returnIds: string[], deadlineAt?: string): void {
    const job = this.runtimeStore.getJob(jobId);
    if (job?.workflowVersion !== "dynamic_v1") return;
    this.runtimeStore.setDynamicExecution({ jobId, jobAttempt: job.attempt, phase, recoveryAction, reason,
      taskIds, returnIds, ...(deadlineAt === undefined ? {} : { deadlineAt }) });
  }
}

function parseReviewerVerdict(raw: string): { passed: boolean; summary: string; severity?: "P0" | "P1" | "P2" | "P3" } {
  const normalized = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const value = JSON.parse(normalized) as unknown;
    if (typeof value === "object" && value !== null &&
      "verdict" in value && (value.verdict === "pass" || value.verdict === "fail") &&
      "summary" in value && typeof value.summary === "string" && value.summary.trim().length > 0) {
      const severityValue = "severity" in value ? value.severity : undefined;
      const severity = typeof severityValue === "string" && /^(P0|P1|P2|P3)$/i.test(severityValue)
        ? severityValue.toUpperCase() as "P0" | "P1" | "P2" | "P3"
        : undefined;
      return {
        passed: value.verdict === "pass" && severity === undefined,
        summary: value.summary.trim(),
        ...(severity === undefined ? {} : { severity }),
      };
    }
  } catch {
    // Backward-compatible parsing for persisted prompts and scripted tests.
  }
  const severity = /\b(P[0-3])\b/i.exec(raw)?.[1]?.toUpperCase() as "P0" | "P1" | "P2" | "P3" | undefined;
  return { passed: severity === undefined && /^\s*PASS\b/i.test(raw), summary: raw.trim(), ...(severity === undefined ? {} : { severity }) };
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}
