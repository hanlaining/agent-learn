import type {
  AgentEvidence, AgentJob, AgentJobStatus, AgentReturnEnvelope,
  AgentRuntimeSnapshot, AgentTask, AgentTaskEdge, AgentTaskStatus,
  AgentTeamConfig, SharedBoardEntry,
  AgentStageCheckpoint,
} from "./agent-runtime.js";
import { normalizeAgentTeamConfig } from "./agent-runtime.js";
import type { RuntimeStageMetric } from "../observability/runtime-metrics.js";

type CreateTaskInput = Omit<AgentTask, "id" | "dependencyIds" | "attempt" | "jobAttempt" | "status" | "createdAt" | "updatedAt"> &
  Partial<Pick<AgentTask, "dependencyIds" | "attempt" | "jobAttempt" | "status">>;

export class AgentRuntimeStore {
  private sequence = 0;
  private readonly jobs = new Map<string, AgentJob>();
  private readonly tasks = new Map<string, AgentTask>();
  private readonly edges = new Map<string, AgentTaskEdge>();
  private readonly evidence = new Map<string, AgentEvidence>();
  private readonly board = new Map<string, SharedBoardEntry>();
  private readonly returns = new Map<string, AgentReturnEnvelope>();
  private readonly returnReceipts = new Set<string>();
  private readonly stageCheckpoints = new Map<string, AgentStageCheckpoint>();
  private readonly stageMetrics = new Map<string, RuntimeStageMetric>();

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  static fromSnapshot(value: AgentRuntimeSnapshot | undefined): AgentRuntimeStore {
    const store = new AgentRuntimeStore();
    if (value === undefined) return store;
    if (value.version !== 1) throw new Error("Invalid agent runtime snapshot");
    store.sequence = value.sequence;
    value.jobs.forEach((item) => store.jobs.set(item.id, {
      ...structuredClone(item),
      executionKind: item.executionKind ?? "software_change",
      workflowVersion: item.workflowVersion ?? (item.executionKind === "software_product_delivery" ? "fixed_team_v1" : "dynamic_v1"),
      attempt: item.attempt ?? 1,
    }));
    value.tasks.forEach((item) => store.tasks.set(item.id, {
      ...structuredClone(item),
      jobAttempt: item.jobAttempt ?? 1,
    }));
    value.edges.forEach((item) => store.edges.set(item.id, structuredClone(item)));
    value.evidence.forEach((item) => store.evidence.set(item.id, structuredClone(item)));
    value.board.forEach((item) => store.board.set(item.id, structuredClone(item)));
    value.returnReceipts.forEach((id) => store.returnReceipts.add(id));
    value.returns.forEach((item) => {
      const restored = structuredClone(item);
      if (store.returnReceipts.has(restored.idempotencyKey)) {
        restored.status = "consumed";
        restored.consumedAt ??= store.now();
        delete restored.nextAttemptAt;
      } else if (restored.status === "delivering") {
        // claim 本身没有业务副作用。没有 receipt 的遗留 claim 在重启后回到
        // outbox，但启动流程不得因此自动执行父模型 continuation。
        restored.status = "ready";
        delete restored.nextAttemptAt;
      }
      store.returns.set(restored.id, restored);
    });
    value.stageCheckpoints?.forEach((item) => store.stageCheckpoints.set(item.idempotencyKey, structuredClone(item)));
    value.stageMetrics?.forEach((item) => store.recordStageMetric(item));
    store.validateReferences();
    return store;
  }

  createJob(input: { threadId: string; rootTurnId: string; rootRunId: string; configSnapshot: AgentTeamConfig;
    executionKind?: import("../requirements/requirement.js").RequirementExecutionKind;
    workflowVersion?: string;
    requirementId?: string; requirementRevision?: number }): AgentJob {
    const existing = input.requirementId === undefined
      ? this.getJobByTurn(input.rootTurnId)
      : this.getJobByRequirement(input.requirementId, input.requirementRevision);
    if (existing !== undefined) return existing;
    const job: AgentJob = {
      ...input, executionKind: input.executionKind ?? "software_change",
      workflowVersion: input.workflowVersion ?? (input.executionKind === "software_product_delivery" ? "software_product_delivery_v2" : "dynamic_v1"), attempt: 1,
      id: input.requirementId === undefined ? `job-${input.rootTurnId}` : `job-${input.requirementId}-v${input.requirementRevision ?? 1}`, configSnapshot: normalizeAgentTeamConfig(input.configSnapshot),
      status: "planning", createdAt: this.now(),
    };
    this.jobs.set(job.id, job);
    return structuredClone(job);
  }

  getJob(id: string): AgentJob | undefined { return clone(this.jobs.get(id)); }
  getJobByTurn(turnId: string): AgentJob | undefined { return clone([...this.jobs.values()].find((item) => item.rootTurnId === turnId)); }
  getJobByRequirement(requirementId: string, revision?: number): AgentJob | undefined {
    return clone([...this.jobs.values()].find((item) => item.requirementId === requirementId &&
      (revision === undefined || item.requirementRevision === revision)));
  }
  listJobs(threadId?: string): AgentJob[] { return [...this.jobs.values()].filter((item) => threadId === undefined || item.threadId === threadId).map(copy); }
  setJobStatus(id: string, status: AgentJobStatus): void {
    const job = this.requireJob(id); job.status = status;
    if (["completed", "partial", "failed", "cancelled"].includes(status)) job.completedAt = this.now();
    else delete job.completedAt;
  }
  startJobAttempt(id: string, rootTurnId: string, rootRunId: string): AgentJob {
    const job = this.requireJob(id);
    if (job.rootTurnId === rootTurnId) return copy(job);
    if (!["failed", "cancelled", "partial"].includes(job.status)) {
      throw new Error("Only a terminal failed Job can start another attempt");
    }
    job.attempt += 1;
    job.rootTurnId = rootTurnId;
    job.rootRunId = rootRunId;
    job.status = "planning";
    delete job.completedAt;
    delete job.failureCode;
    for (const item of this.returns.values()) {
      if (item.jobId === job.id && item.status !== "consumed") item.status = "failed";
    }
    return copy(job);
  }
  failJob(id: string, status: "failed" | "cancelled", failureCode: string): void {
    const job = this.requireJob(id);
    this.setJobStatus(id, status);
    job.failureCode = failureCode;
  }

  /**
   * Reconcile a Job from persisted Task/Return facts instead of treating an
   * empty Return outbox as proof that the work passed acceptance.
   */
  reconcileJobStatus(jobId: string): AgentJobStatus {
    const job = this.requireJob(jobId);
    if (job.status === "cancelled") return job.status;
    if (job.executionKind === "software_product_delivery" && job.workflowVersion === "software_product_delivery_v2") {
      if (["failed", "partial"].includes(job.status)) return job.status;
      return this.reconcileSoftwareProductDeliveryJob(job);
    }
    const returns = this.listReturns(jobId);
    if (returns.some((item) => item.status === "ready" || item.status === "delivering")) {
      this.setJobStatus(jobId, "waiting_returns");
      return "waiting_returns";
    }

    // Reviewer Tasks are evidence for their parent Task. They must not create
    // a second independent completion contract for the Job.
    const requiredTasks = this.listTasks(jobId).filter((task) =>
      task.parentTaskId === undefined && task.jobAttempt === job.attempt);
    if (requiredTasks.length === 0) {
      this.setJobStatus(jobId, "planning");
      return "planning";
    }
    if (requiredTasks.some((task) => ["failed", "cancelled", "lost"].includes(task.status))) {
      this.setJobStatus(jobId, "failed");
      return "failed";
    }
    if (requiredTasks.some((task) => task.status === "rework" || task.status === "reviewing")) {
      this.setJobStatus(jobId, "reviewing");
      return "reviewing";
    }
    if (requiredTasks.some((task) => task.status !== "completed")) {
      this.setJobStatus(jobId, "running");
      return "running";
    }
    if (job.configSnapshot.independentReview && requiredTasks.some((task) =>
      !this.listEvidence(task.id).some((item) => item.kind === "review" && item.producer === "reviewer" && item.verdict === "passed"))) {
      this.setJobStatus(jobId, "failed");
      return "failed";
    }
    this.setJobStatus(jobId, "completed");
    return "completed";
  }

  createTask(input: CreateTaskInput): AgentTask {
    this.requireJob(input.jobId);
    const task: AgentTask = {
      ...structuredClone(input), id: this.id("task"), dependencyIds: [...(input.dependencyIds ?? [])],
      attempt: input.attempt ?? 1, jobAttempt: input.jobAttempt ?? this.requireJob(input.jobId).attempt,
      status: input.status ?? "draft", createdAt: this.now(), updatedAt: this.now(),
    };
    if (task.parentTaskId !== undefined) {
      const parent = this.requireTask(task.parentTaskId);
      if (parent.jobId !== task.jobId) throw new Error("Cross-job parent task is forbidden");
    }
    this.tasks.set(task.id, task);
    return copy(task);
  }

  getTask(id: string): AgentTask | undefined { return clone(this.tasks.get(id)); }
  listTasks(jobId: string): AgentTask[] { return [...this.tasks.values()].filter((item) => item.jobId === jobId).map(copy); }
  listRunsForTask(taskId: string): string[] {
    const task = this.requireTask(taskId);
    return this.listEvidence(taskId).map((item) => item.runId).concat(task.ownerRunId).filter((id, index, all) => all.indexOf(id) === index);
  }
  setTaskOwnerRun(taskId: string, runId: string, attempt?: number): void {
    const task = this.requireTask(taskId); task.ownerRunId = runId;
    if (attempt !== undefined) task.attempt = attempt;
    task.updatedAt = this.now();
  }
  setTaskStatus(id: string, status: AgentTaskStatus): void { const task = this.requireTask(id); task.status = status; task.updatedAt = this.now(); }

  addEdge(input: Omit<AgentTaskEdge, "id" | "createdAt">): AgentTaskEdge {
    const from = this.requireTask(input.fromTaskId); const to = this.requireTask(input.toTaskId);
    if (from.jobId !== input.jobId || to.jobId !== input.jobId) throw new Error("Cross-job task edge is forbidden");
    const edge: AgentTaskEdge = { ...input, id: this.id("edge"), createdAt: this.now() };
    this.edges.set(edge.id, edge);
    if (this.hasCycle(input.jobId)) { this.edges.delete(edge.id); throw new Error("Task dependency cycle detected"); }
    if (edge.hard && !to.dependencyIds.includes(from.id)) to.dependencyIds.push(from.id);
    return copy(edge);
  }

  listEdges(jobId: string): AgentTaskEdge[] { return [...this.edges.values()].filter((item) => item.jobId === jobId).map(copy); }
  readyTasks(jobId: string): AgentTask[] {
    const tasks = this.listTasks(jobId);
    const runningClaims = tasks.filter((item) => ["claimed", "running"].includes(item.status)).flatMap((item) => item.fileClaims);
    return tasks.filter((task) => {
      if (!["draft", "blocked", "ready", "rework", "lost"].includes(task.status)) return false;
      const deps = this.listEdges(jobId).filter((edge) => edge.toTaskId === task.id && edge.hard);
      if (!deps.every((edge) => this.tasks.get(edge.fromTaskId)?.status === "completed")) return false;
      return !task.fileClaims.some((claim) => runningClaims.some((held) => pathsOverlap(claim, held)));
    });
  }

  claimTask(taskId: string, owner: string, leaseMs = 30_000): AgentTask {
    const task = this.requireTask(taskId);
    if (!this.readyTasks(task.jobId).some((item) => item.id === taskId)) throw new Error("Task is not ready");
    task.status = "claimed"; task.leaseOwner = owner; task.heartbeatAt = this.now();
    task.leaseExpiresAt = new Date(Date.parse(task.heartbeatAt) + leaseMs).toISOString(); task.updatedAt = this.now();
    return copy(task);
  }

  heartbeat(taskId: string, owner: string, leaseMs = 30_000): AgentTask {
    const task = this.requireTask(taskId);
    if (task.leaseOwner !== owner || !["claimed", "running"].includes(task.status)) throw new Error("Task lease owner mismatch");
    task.heartbeatAt = this.now(); task.leaseExpiresAt = new Date(Date.parse(task.heartbeatAt) + leaseMs).toISOString(); task.updatedAt = this.now();
    return copy(task);
  }

  recoverExpiredLeases(at = this.now()): AgentTask[] {
    const expired: AgentTask[] = [];
    for (const task of this.tasks.values()) {
      if (["claimed", "running"].includes(task.status) && task.leaseExpiresAt !== undefined && task.leaseExpiresAt <= at) {
        task.status = "lost"; delete task.leaseOwner; delete task.leaseExpiresAt; task.updatedAt = this.now(); expired.push(copy(task));
      }
    }
    return expired;
  }

  recoverInterruptedWork(at = this.now()): { lostTasks: AgentTask[]; pendingReturns: AgentReturnEnvelope[] } {
    return { lostTasks: this.recoverExpiredLeases(at), pendingReturns: this.listReturns().filter((item) => item.status === "ready") };
  }

  reconcilePersistedJobs(jobId?: string): AgentJob[] {
    for (const job of this.jobs.values()) {
      if (jobId !== undefined && job.id !== jobId) continue;
      if (["partial", "failed", "cancelled"].includes(job.status)) continue;
      const hasCurrentTasks = this.listTasks(job.id).some((task) =>
        task.parentTaskId === undefined && task.jobAttempt === job.attempt);
      const hasCurrentWorkflowCheckpoints = job.executionKind === "software_product_delivery" &&
        job.workflowVersion === "software_product_delivery_v2" &&
        this.listStageCheckpoints(job.id).some((checkpoint) => checkpoint.jobAttempt === job.attempt);
      if (job.status !== "completed" || hasCurrentTasks || hasCurrentWorkflowCheckpoints) {
        this.reconcileJobStatus(job.id);
      }
    }
    return this.listJobs();
  }

  addEvidence(input: Omit<AgentEvidence, "id" | "createdAt">): AgentEvidence {
    const task = this.requireTask(input.taskId);
    if (task.jobId !== input.jobId) throw new Error("Cross-job evidence is forbidden");
    const existing = input.idempotencyKey === undefined ? undefined : [...this.evidence.values()]
      .find((item) => item.idempotencyKey === input.idempotencyKey);
    if (existing !== undefined) return copy(existing);
    const evidence: AgentEvidence = { ...input, id: this.id("evidence"), createdAt: this.now() };
    this.evidence.set(evidence.id, evidence); return copy(evidence);
  }
  listEvidence(taskId: string): AgentEvidence[] { return [...this.evidence.values()].filter((item) => item.taskId === taskId).map(copy); }
  getEvidence(id: string): AgentEvidence | undefined { return clone(this.evidence.get(id)); }
  reviewTask(taskId: string): { passed: boolean; rework: boolean } {
    const task = this.requireTask(taskId); const evidence = this.listEvidence(taskId);
    const latestReview = evidence.filter((item) => item.kind === "review" && item.producer === "reviewer").at(-1);
    const severeFailure = latestReview?.verdict === "failed" && ["P0", "P1", "P2"].includes(latestReview.severity ?? "");
    const hasIndependentReview = latestReview?.verdict === "passed";
    const outputsCovered = task.acceptanceCriteria.length === 0 || evidence.some((item) => ["passed", "supported"].includes(item.verdict));
    const passed = !severeFailure && hasIndependentReview && outputsCovered;
    task.status = passed ? "completed" : severeFailure ? "rework" : "reviewing"; task.updatedAt = this.now();
    return { passed, rework: severeFailure };
  }

  publishBoard(input: Omit<SharedBoardEntry, "id" | "createdAt">): SharedBoardEntry {
    this.requireJob(input.jobId);
    assertSafeBoardEntry(input);
    const existing = input.idempotencyKey === undefined ? undefined : [...this.board.values()]
      .find((item) => item.idempotencyKey === input.idempotencyKey);
    if (existing !== undefined) return copy(existing);
    const item: SharedBoardEntry = { ...structuredClone(input), id: this.id("board"), createdAt: this.now() };
    const supersededId = item.supersedesBoardEntryId ?? item.supersedesId;
    if (supersededId !== undefined) {
      const previous = this.board.get(supersededId);
      if (previous === undefined || previous.jobId !== item.jobId) {
        throw new Error("Superseded Board Entry is unavailable");
      }
      if (item.taskId !== undefined && previous.taskId !== undefined && item.taskId !== previous.taskId) {
        throw new Error("Cross-task Board supersession is forbidden");
      }
      previous.supersededByBoardEntryId = item.id;
      previous.supersededAt = item.createdAt;
    }
    this.board.set(item.id, item); return copy(item);
  }
  listBoard(jobId: string): SharedBoardEntry[] { return [...this.board.values()].filter((item) => item.jobId === jobId).map(copy); }
  listCurrentBoard(jobId: string): SharedBoardEntry[] {
    return this.listBoard(jobId).filter((entry) => {
      if (entry.supersededByBoardEntryId !== undefined) return false;
      if (entry.taskId === undefined) return true;
      const task = this.tasks.get(entry.taskId);
      if (task === undefined || task.jobId !== jobId || task.status !== "completed") return false;
      if (task.ownerRunId !== entry.producerRunId || task.attempt !== entry.attempt) return false;
      return this.listEvidence(task.id).some((evidence) =>
        evidence.kind === "review" && evidence.producer === "reviewer" &&
        evidence.verdict === "passed" && evidence.runId.startsWith(`${entry.producerRunId}:`));
    });
  }

  createReturn(input: Omit<AgentReturnEnvelope, "id" | "status" | "attempts" | "createdAt">): AgentReturnEnvelope {
    this.requireJob(input.jobId);
    const existing = [...this.returns.values()].find((item) => item.idempotencyKey === input.idempotencyKey);
    if (existing !== undefined) return copy(existing);
    const item: AgentReturnEnvelope = { ...structuredClone(input), id: this.id("return"), status: "ready", attempts: 0, createdAt: this.now() };
    this.returns.set(item.id, item); return copy(item);
  }
  listReturns(jobId?: string): AgentReturnEnvelope[] { return [...this.returns.values()].filter((item) => jobId === undefined || item.jobId === jobId).sort((a, b) => a.sequence - b.sequence).map(copy); }
  claimReturn(id: string): AgentReturnEnvelope | undefined {
    const item = this.returns.get(id); if (item === undefined || item.status !== "ready" || (item.nextAttemptAt !== undefined && item.nextAttemptAt > this.now())) return undefined;
    item.status = "delivering"; item.attempts += 1; return copy(item);
  }
  retryReturn(id: string, delayMs: number): void {
    const item = this.requireReturn(id);
    if (item.status !== "delivering") throw new Error("Only a delivering Return can be retried");
    item.status = "ready";
    item.nextAttemptAt = new Date(Date.parse(this.now()) + delayMs).toISOString();
  }
  failReturn(id: string): void {
    const item = this.requireReturn(id);
    if (item.status === "consumed") return;
    item.status = "failed";
    delete item.nextAttemptAt;
  }
  consumeReturn(id: string): boolean {
    const item = this.requireReturn(id); if (this.returnReceipts.has(item.idempotencyKey)) return false;
    if (item.status !== "delivering") throw new Error("Return is not delivering");
    item.status = "consumed"; item.consumedAt = this.now(); delete item.nextAttemptAt; this.returnReceipts.add(item.idempotencyKey); return true;
  }

  beginStage(jobId: string, stageId: string, maxAttempts = 2, forceNewAttempt = false): AgentStageCheckpoint {
    const job = this.requireJob(jobId);
    const previous = this.listStageCheckpoints(jobId).filter((item) => item.stageId === stageId).at(-1);
    if (!forceNewAttempt && (previous?.status === "completed" || previous?.status === "running" || previous?.status === "validating")) return previous;
    if (forceNewAttempt && previous !== undefined && previous.status !== "completed" && previous.status !== "failed_retryable") return previous;
    const stageAttempt = previous === undefined ? 1 : previous.stageAttempt + 1;
    if (stageAttempt > maxAttempts || previous?.status === "failed_terminal") {
      throw Object.assign(new Error(`Stage retry exhausted: ${stageId}`), { code: "stage_retry_exhausted" });
    }
    const idempotencyKey = [job.id, job.attempt, job.workflowVersion, stageId, stageAttempt].join(":");
    const checkpoint: AgentStageCheckpoint = {
      idempotencyKey, jobId: job.id, jobAttempt: job.attempt, workflowVersion: job.workflowVersion,
      stageId, stageAttempt, status: "running", startedAt: this.now(), updatedAt: this.now(),
    };
    this.stageCheckpoints.set(idempotencyKey, checkpoint);
    return copy(checkpoint);
  }

  setStageStatus(
    idempotencyKey: string,
    status: "validating" | "completed" | "failed_retryable" | "failed_terminal",
    failureCode?: string,
  ): AgentStageCheckpoint {
    const checkpoint = this.stageCheckpoints.get(idempotencyKey);
    if (checkpoint === undefined) throw new Error(`Stage checkpoint not found: ${idempotencyKey}`);
    const allowed = checkpoint.status === "running"
      ? ["validating", "failed_retryable", "failed_terminal"]
      : checkpoint.status === "validating"
        ? ["completed", "failed_retryable", "failed_terminal"]
        : [];
    if (!allowed.includes(status)) throw new Error(`Invalid stage transition: ${checkpoint.status} -> ${status}`);
    checkpoint.status = status;
    checkpoint.updatedAt = this.now();
    if (failureCode === undefined) delete checkpoint.failureCode;
    else checkpoint.failureCode = failureCode;
    if (status === "completed") checkpoint.completedAt = checkpoint.updatedAt;
    return copy(checkpoint);
  }

  listStageCheckpoints(jobId?: string): AgentStageCheckpoint[] {
    return [...this.stageCheckpoints.values()]
      .filter((item) => jobId === undefined || item.jobId === jobId)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.stageAttempt - right.stageAttempt)
      .map(copy);
  }

  recordStageMetric(metric: RuntimeStageMetric): void {
    const key = [metric.jobId, metric.jobAttempt, metric.workflowVersion, metric.stageId, metric.stageAttempt].join(":");
    this.stageMetrics.set(key, copy(metric));
  }

  listStageMetrics(jobId?: string): RuntimeStageMetric[] {
    return [...this.stageMetrics.values()].filter((item) => jobId === undefined || item.jobId === jobId).map(copy);
  }

  cancelJob(jobId: string): void {
    this.setJobStatus(jobId, "cancelled");
    for (const task of this.tasks.values()) if (task.jobId === jobId && !["completed", "failed", "cancelled"].includes(task.status)) task.status = "cancelled";
    for (const item of this.returns.values()) if (item.jobId === jobId && item.status !== "consumed") item.status = "failed";
    for (const item of this.stageCheckpoints.values()) if (item.jobId === jobId && ["running", "validating"].includes(item.status)) {
      item.status = "failed_terminal"; item.failureCode = "user_cancelled"; item.updatedAt = this.now();
    }
  }

  closeActiveTasks(jobId: string, terminal: "failed" | "cancelled" | "lost"): AgentTask[] {
    const closed: AgentTask[] = [];
    for (const task of this.tasks.values()) {
      if (task.jobId !== jobId || ["completed", "failed", "cancelled", "lost"].includes(task.status)) continue;
      task.status = terminal;
      task.updatedAt = this.now();
      closed.push(copy(task));
    }
    return closed;
  }

  closeTasks(taskIds: readonly string[], terminal: "cancelled" | "lost" = "cancelled"): AgentTask[] {
    const selected = new Set(taskIds);
    const closed: AgentTask[] = [];
    for (const task of this.tasks.values()) {
      if (!selected.has(task.id) ||
        ["completed", "failed", "cancelled", "lost"].includes(task.status)) continue;
      task.status = terminal;
      task.updatedAt = this.now();
      closed.push(copy(task));
    }
    return closed;
  }

  exportSnapshot(): AgentRuntimeSnapshot {
    return { version: 1, sequence: this.sequence, jobs: this.listJobs(), tasks: [...this.tasks.values()].map(copy), edges: [...this.edges.values()].map(copy), evidence: [...this.evidence.values()].map(copy), board: [...this.board.values()].map(copy), returns: this.listReturns(), returnReceipts: [...this.returnReceipts], stageCheckpoints: this.listStageCheckpoints(), stageMetrics: this.listStageMetrics() };
  }

  private reconcileSoftwareProductDeliveryJob(job: AgentJob): AgentJobStatus {
    const checkpoints = this.listStageCheckpoints(job.id).filter((item) => item.jobAttempt === job.attempt);
    const currentTasks = this.listTasks(job.id).filter((item) => item.jobAttempt === job.attempt);
    const returns = this.listReturns(job.id).filter((item) => item.jobAttempt === undefined || item.jobAttempt === job.attempt);
    if (checkpoints.some((item) => item.status === "failed_terminal") ||
      currentTasks.some((item) => ["failed", "cancelled", "lost"].includes(item.status))) {
      this.setJobStatus(job.id, "failed");
      return "failed";
    }
    const requiredStages = ["product", "engineering", "quality", "lead", "return_god"];
    const stagesCompleted = requiredStages.every((stageId) =>
      checkpoints.some((item) => item.stageId === stageId && item.status === "completed"));
    const leadReturnConsumed = returns.some((item) => item.stageId === "lead" && item.status === "consumed");
    if (stagesCompleted && leadReturnConsumed) {
      const currentEvidence = currentTasks.flatMap((task) => this.listEvidence(task.id));
      const evidenceById = new Map(currentEvidence.map((item) => [item.id, item]));
      const completedCheckpoints = checkpoints.filter((item) => item.status === "completed");
      const checkpointsHaveEvidence = completedCheckpoints.every((checkpoint) =>
        currentEvidence.some((item) =>
          item.idempotencyKey === `${checkpoint.idempotencyKey}:evidence` &&
          item.jobId === job.id && item.jobAttempt === job.attempt &&
          item.workflowVersion === job.workflowVersion && item.stageId === checkpoint.stageId &&
          item.stageAttempt === checkpoint.stageAttempt));
      const returnsHaveValidEvidence = completedCheckpoints
        .filter((checkpoint) => checkpoint.stageId !== "return_god")
        .every((checkpoint) => {
          const envelope = returns.find((item) => item.idempotencyKey === checkpoint.idempotencyKey);
          return envelope !== undefined && envelope.result.evidenceIds.length > 0 &&
            envelope.result.evidenceIds.every((evidenceId) => {
              const evidence = evidenceById.get(evidenceId);
              return evidence !== undefined && evidence.jobId === job.id &&
                evidence.jobAttempt === job.attempt && evidence.workflowVersion === job.workflowVersion;
            });
        });
      if (!checkpointsHaveEvidence || !returnsHaveValidEvidence) {
        this.failJob(job.id, "failed", "terminal_state_inconsistent");
        return "failed";
      }
      this.setJobStatus(job.id, "completed");
      return "completed";
    }
    if (returns.some((item) => item.status === "ready" || item.status === "delivering")) {
      this.setJobStatus(job.id, "waiting_returns");
      return "waiting_returns";
    }
    if (currentTasks.some((item) => item.status === "rework" || item.status === "reviewing") ||
      checkpoints.some((item) => item.status === "validating")) {
      this.setJobStatus(job.id, "reviewing");
      return "reviewing";
    }
    if (currentTasks.length === 0 && checkpoints.length === 0) {
      this.setJobStatus(job.id, "planning");
      return "planning";
    }
    this.setJobStatus(job.id, "running");
    return "running";
  }

  private hasCycle(jobId: string): boolean {
    const adjacency = new Map<string, string[]>();
    for (const task of this.tasks.values()) if (task.jobId === jobId) adjacency.set(task.id, []);
    for (const edge of this.edges.values()) if (edge.jobId === jobId && edge.hard) adjacency.get(edge.fromTaskId)?.push(edge.toTaskId);
    const active = new Set<string>(); const done = new Set<string>();
    const visit = (id: string): boolean => { if (active.has(id)) return true; if (done.has(id)) return false; active.add(id); for (const next of adjacency.get(id) ?? []) if (visit(next)) return true; active.delete(id); done.add(id); return false; };
    return [...adjacency.keys()].some(visit);
  }
  private validateReferences(): void {
    for (const task of this.tasks.values()) this.requireJob(task.jobId);
    for (const edge of this.edges.values()) { this.requireTask(edge.fromTaskId); this.requireTask(edge.toTaskId); }
    if ([...this.jobs.values()].some((job) => this.listJobs().filter((item) => item.rootTurnId === job.rootTurnId).length > 1)) throw new Error("Duplicate job root turn");
  }
  private id(prefix: string): string { this.sequence += 1; return `${prefix}-${this.sequence}`; }
  private requireJob(id: string): AgentJob { const item = this.jobs.get(id); if (item === undefined) throw new Error(`AgentJob not found: ${id}`); return item; }
  private requireTask(id: string): AgentTask { const item = this.tasks.get(id); if (item === undefined) throw new Error(`AgentTask not found: ${id}`); return item; }
  private requireReturn(id: string): AgentReturnEnvelope { const item = this.returns.get(id); if (item === undefined) throw new Error(`AgentReturn not found: ${id}`); return item; }
}

function copy<T>(value: T): T { return structuredClone(value); }
function clone<T>(value: T | undefined): T | undefined { return value === undefined ? undefined : copy(value); }
function pathsOverlap(left: string, right: string): boolean { const a = left.replace(/\\/g, "/").replace(/\/$/, ""); const b = right.replace(/\\/g, "/").replace(/\/$/, ""); return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`); }
function assertSafeBoardEntry(input: Omit<SharedBoardEntry, "id" | "createdAt">): void {
  const text = JSON.stringify(input);
  if (/\b(api[_-]?key|token|cookie|secret|password|environment variable|思维链)\b/i.test(text)) throw new Error("Sensitive data is forbidden on the shared board");
}
