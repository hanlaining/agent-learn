import type {
  AgentAttentionLevel, AgentCoordinationStatus, AgentFailureOrigin,
  AgentRun, AgentRunResult, AgentRunSnapshot, AgentRunStatus,
} from "./agent-run.js";

export class AgentRunStore {
  private readonly runs = new Map<string, AgentRun>();
  private readonly runByTurn = new Map<string, string>();
  private readonly returnReceipts = new Set<string>();
  private sequence = 0;

  static fromSnapshot(value: AgentRunSnapshot | undefined | (Omit<AgentRunSnapshot, "version" | "runs"> & { version: 1; runs: Array<Omit<AgentRun, "jobId" | "rootRunId" | "attempt">> })): AgentRunStore {
    const store = new AgentRunStore();
    if (value === undefined) return store;
    store.sequence = value.sequence;
    const fixedTeamJobIds = new Set(value.runs.filter((run) => [
      "software_team_lead", "product_role", "engineering_role", "quality_role",
    ].includes(run.agentProfileId)).map((run) => "jobId" in run ? run.jobId : `job-${run.turnId}`));
    value.runs.forEach((run) => {
      const restored = structuredClone({
        ...run,
        jobId: "jobId" in run ? run.jobId : `job-${run.turnId}`,
        rootRunId: "rootRunId" in run ? run.rootRunId : run.id,
        attempt: "attempt" in run ? run.attempt : 1,
      }) as AgentRun;
      const isWaitingTeamMember = restored.status === "queued" && [
        "software_team_lead", "product_role", "engineering_role", "quality_role",
      ].includes(restored.agentProfileId) && restored.taskId === undefined;
      const isRecoverableFixedCheckpoint = fixedTeamJobIds.has(restored.jobId) &&
        ["queued", "waiting_children", "resuming"].includes(restored.status);
      if (!isWaitingTeamMember && !isRecoverableFixedCheckpoint && ["queued", "running", "waiting_children", "resuming"].includes(restored.status)) {
        restored.status = "cancelled";
        restored.completedAt = new Date().toISOString();
        restored.result = { runId: restored.id, status: "cancelled", summary: "Runtime 重启，旧 AgentRun 已安全中断" };
      }
      store.runs.set(restored.id, restored);
      store.runByTurn.set(restored.turnId, restored.id);
    });
    value.returnReceipts.forEach((id) => store.returnReceipts.add(id));
    return store;
  }

  create(input: Omit<AgentRun, "id" | "jobId" | "rootRunId" | "attempt" | "childRunIds" | "status" | "createdAt"> & { jobId?: string; rootRunId?: string; attempt?: number }): AgentRun {
    this.sequence += 1;
    const id = `agent-run-${this.sequence}`;
    const parent = input.parentRunId === undefined ? undefined : this.require(input.parentRunId);
    const jobId = input.jobId ?? parent?.jobId ?? `job-${input.turnId}`;
    if (parent !== undefined && parent.jobId !== jobId) throw new Error("Cross-job AgentRun parent is forbidden");
    const run: AgentRun = { ...input, id, jobId, rootRunId: input.rootRunId ?? parent?.rootRunId ?? id, attempt: input.attempt ?? 1, childRunIds: [], status: "queued", createdAt: new Date().toISOString() };
    this.runs.set(run.id, run);
    this.runByTurn.set(run.turnId, run.id);
    if (run.parentRunId !== undefined) this.require(run.parentRunId).childRunIds.push(run.id);
    return structuredClone(run);
  }

  ensureRoot(threadId: string, turnId: string, profileId = "orchestrator", jobId?: string): AgentRun {
    const existing = this.getByTurn(turnId);
    return existing ?? this.create({ jobId: jobId ?? `job-${turnId}`, threadId, turnId, agentProfileId: profileId, task: "主任务", depth: 0, attempt: 1 });
  }

  getByTurn(turnId: string): AgentRun | undefined {
    const id = this.runByTurn.get(turnId);
    return id === undefined ? undefined : structuredClone(this.require(id));
  }
  get(id: string): AgentRun | undefined { const run = this.runs.get(id); return run === undefined ? undefined : structuredClone(run); }
  getRoot(id: string): AgentRun | undefined {
    let run = this.runs.get(id);
    const visited = new Set<string>();
    while (run?.parentRunId !== undefined && !visited.has(run.id)) {
      visited.add(run.id);
      run = this.runs.get(run.parentRunId);
    }
    return run === undefined ? undefined : structuredClone(run);
  }
  list(): AgentRun[] { return [...this.runs.values()].map((run) => structuredClone(run)); }
  listForJob(jobId: string): AgentRun[] { return this.list().filter((run) => run.jobId === jobId); }
  findWorkerThread(jobId: string, taskId: string): string | undefined {
    return this.listForJob(jobId)
      .filter((run) => run.parentRunId !== undefined && run.taskId === taskId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]?.threadId;
  }
  isChildThread(threadId: string): boolean {
    return [...this.runs.values()].some(
      (run) => run.threadId === threadId && run.parentRunId !== undefined,
    );
  }
  listForThread(threadId: string): AgentRun[] {
    const runs = this.list();
    const included = new Set(
      runs.filter((run) => run.threadId === threadId).map((run) => run.id),
    );
    let changed = true;
    while (changed) {
      changed = false;
      for (const run of runs) {
        if (run.parentRunId !== undefined && included.has(run.parentRunId) && !included.has(run.id)) {
          included.add(run.id);
          changed = true;
        }
      }
    }
    return runs.filter((run) => included.has(run.id));
  }

  setStatus(id: string, status: AgentRunStatus): void { this.require(id).status = status; }
  setPresentation(id: string, input: {
    coordinationStatus?: AgentCoordinationStatus;
    attentionLevel?: AgentAttentionLevel;
    statusMessage?: string;
    failureOrigin?: AgentFailureOrigin;
  }): void {
    const run = this.require(id);
    if (input.coordinationStatus === undefined) delete run.coordinationStatus;
    else run.coordinationStatus = input.coordinationStatus;
    if (input.attentionLevel === undefined) delete run.attentionLevel;
    else run.attentionLevel = input.attentionLevel;
    if (input.statusMessage === undefined) delete run.statusMessage;
    else run.statusMessage = input.statusMessage;
    if (input.failureOrigin === undefined) delete run.failureOrigin;
    else run.failureOrigin = input.failureOrigin;
  }
  setTaskId(id: string, taskId: string): void { this.require(id).taskId = taskId; }
  rebindAttempt(id: string, turnId: string, attempt: number): void {
    const run = this.require(id);
    if (!Number.isInteger(attempt) || attempt < run.attempt) throw new Error("AgentRun attempt cannot move backwards");
    run.turnId = turnId;
    run.attempt = attempt;
    this.runByTurn.set(turnId, id);
  }
  complete(id: string, result: AgentRunResult): void {
    const run = this.require(id); run.status = result.status; run.result = structuredClone(result); run.completedAt = new Date().toISOString();
    if (result.failureOrigin !== undefined) run.failureOrigin = result.failureOrigin;
  }
  closeActiveForJob(jobId: string, status: "failed" | "cancelled" | "timed_out", summary: string, safeError?: string): AgentRun[] {
    const closed: AgentRun[] = [];
    for (const run of this.runs.values()) {
      if (run.jobId !== jobId || !["queued", "running", "waiting_children", "resuming"].includes(run.status)) continue;
      this.complete(run.id, {
        runId: run.id,
        ...(run.taskId === undefined ? {} : { taskId: run.taskId }),
        status,
        summary,
        ...(safeError === undefined ? {} : { safeError }),
      });
      closed.push(structuredClone(this.require(run.id)));
    }
    return closed;
  }
  markUpstreamBlocked(jobId: string, downstreamRunIds: readonly string[], summary: string): AgentRun[] {
    const downstream = new Set(downstreamRunIds);
    const updated: AgentRun[] = [];
    for (const run of this.runs.values()) {
      if (run.jobId !== jobId || !downstream.has(run.id) ||
        !["queued", "running", "waiting_children", "resuming"].includes(run.status)) continue;
      run.coordinationStatus = "upstream_blocked";
      run.attentionLevel = "feedback";
      run.statusMessage = summary;
      run.failureOrigin = "dependency";
      updated.push(structuredClone(run));
    }
    return updated;
  }
  receiveReturn(result: AgentRunResult): boolean {
    if (this.returnReceipts.has(result.runId)) return false;
    this.returnReceipts.add(result.runId); return true;
  }
  exportSnapshot(): AgentRunSnapshot { return { version: 2, sequence: this.sequence, runs: this.list(), returnReceipts: [...this.returnReceipts] }; }
  private require(id: string): AgentRun { const run = this.runs.get(id); if (run === undefined) throw new Error(`AgentRun not found: ${id}`); return run; }
}
