import type {
  AgentEvidence, AgentJob, AgentJobStatus, AgentReturnEnvelope,
  AgentRuntimeSnapshot, AgentTask, AgentTaskEdge, AgentTaskStatus,
  AgentTeamConfig, SharedBoardEntry,
} from "./agent-runtime.js";
import { normalizeAgentTeamConfig } from "./agent-runtime.js";

type CreateTaskInput = Omit<AgentTask, "id" | "dependencyIds" | "attempt" | "status" | "createdAt" | "updatedAt"> &
  Partial<Pick<AgentTask, "dependencyIds" | "attempt" | "status">>;

export class AgentRuntimeStore {
  private sequence = 0;
  private readonly jobs = new Map<string, AgentJob>();
  private readonly tasks = new Map<string, AgentTask>();
  private readonly edges = new Map<string, AgentTaskEdge>();
  private readonly evidence = new Map<string, AgentEvidence>();
  private readonly board = new Map<string, SharedBoardEntry>();
  private readonly returns = new Map<string, AgentReturnEnvelope>();
  private readonly returnReceipts = new Set<string>();

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  static fromSnapshot(value: AgentRuntimeSnapshot | undefined): AgentRuntimeStore {
    const store = new AgentRuntimeStore();
    if (value === undefined) return store;
    if (value.version !== 1) throw new Error("Invalid agent runtime snapshot");
    store.sequence = value.sequence;
    value.jobs.forEach((item) => store.jobs.set(item.id, structuredClone(item)));
    value.tasks.forEach((item) => store.tasks.set(item.id, structuredClone(item)));
    value.edges.forEach((item) => store.edges.set(item.id, structuredClone(item)));
    value.evidence.forEach((item) => store.evidence.set(item.id, structuredClone(item)));
    value.board.forEach((item) => store.board.set(item.id, structuredClone(item)));
    value.returns.forEach((item) => {
      const restored = structuredClone(item);
      if (restored.status === "delivering") restored.status = "ready";
      store.returns.set(restored.id, restored);
    });
    value.returnReceipts.forEach((id) => store.returnReceipts.add(id));
    store.validateReferences();
    return store;
  }

  createJob(input: { threadId: string; rootTurnId: string; rootRunId: string; configSnapshot: AgentTeamConfig; requirementId?: string; requirementRevision?: number }): AgentJob {
    const existing = input.requirementId === undefined
      ? this.getJobByTurn(input.rootTurnId)
      : this.getJobByRequirement(input.requirementId, input.requirementRevision);
    if (existing !== undefined) return existing;
    const job: AgentJob = {
      ...input, id: input.requirementId === undefined ? `job-${input.rootTurnId}` : `job-${input.requirementId}-v${input.requirementRevision ?? 1}`, configSnapshot: normalizeAgentTeamConfig(input.configSnapshot),
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

  /**
   * Reconcile a Job from persisted Task/Return facts instead of treating an
   * empty Return outbox as proof that the work passed acceptance.
   */
  reconcileJobStatus(jobId: string): AgentJobStatus {
    const job = this.requireJob(jobId);
    if (job.status === "cancelled") return job.status;
    const returns = this.listReturns(jobId);
    if (returns.some((item) => item.status === "ready" || item.status === "delivering")) {
      this.setJobStatus(jobId, "waiting_returns");
      return "waiting_returns";
    }

    // Reviewer Tasks are evidence for their parent Task. They must not create
    // a second independent completion contract for the Job.
    const requiredTasks = this.listTasks(jobId).filter((task) => task.parentTaskId === undefined);
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
      attempt: input.attempt ?? 1, status: input.status ?? "draft", createdAt: this.now(), updatedAt: this.now(),
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

  reconcilePersistedJobs(): AgentJob[] {
    for (const job of this.jobs.values()) {
      if (job.status !== "cancelled") this.reconcileJobStatus(job.id);
    }
    return this.listJobs();
  }

  addEvidence(input: Omit<AgentEvidence, "id" | "createdAt">): AgentEvidence {
    const task = this.requireTask(input.taskId);
    if (task.jobId !== input.jobId) throw new Error("Cross-job evidence is forbidden");
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
    const item: SharedBoardEntry = { ...structuredClone(input), id: this.id("board"), createdAt: this.now() };
    this.board.set(item.id, item); return copy(item);
  }
  listBoard(jobId: string): SharedBoardEntry[] { return [...this.board.values()].filter((item) => item.jobId === jobId).map(copy); }

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
  retryReturn(id: string, delayMs: number): void { const item = this.requireReturn(id); item.status = "ready"; item.nextAttemptAt = new Date(Date.parse(this.now()) + delayMs).toISOString(); }
  consumeReturn(id: string): boolean {
    const item = this.requireReturn(id); if (this.returnReceipts.has(item.idempotencyKey)) return false;
    if (item.status !== "delivering") throw new Error("Return is not delivering");
    item.status = "consumed"; item.consumedAt = this.now(); delete item.nextAttemptAt; this.returnReceipts.add(item.idempotencyKey); return true;
  }

  cancelJob(jobId: string): void {
    this.setJobStatus(jobId, "cancelled");
    for (const task of this.tasks.values()) if (task.jobId === jobId && !["completed", "failed", "cancelled"].includes(task.status)) task.status = "cancelled";
    for (const item of this.returns.values()) if (item.jobId === jobId && item.status !== "consumed") item.status = "failed";
  }

  exportSnapshot(): AgentRuntimeSnapshot {
    return { version: 1, sequence: this.sequence, jobs: this.listJobs(), tasks: [...this.tasks.values()].map(copy), edges: [...this.edges.values()].map(copy), evidence: [...this.evidence.values()].map(copy), board: [...this.board.values()].map(copy), returns: this.listReturns(), returnReceipts: [...this.returnReceipts] };
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
