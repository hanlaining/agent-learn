import type { FixedProductStage } from "../agents/fixed-software-team-coordinator.js";
import type { WorkflowTeamCoordinator } from "./workflow-team-coordinator.js";
import type { AgentRuntimeStore } from "../agents/agent-runtime-store.js";
import type { RequirementExecutionKind } from "../requirements/requirement.js";
import type { ExecutionContext } from "./execution-context.js";
import type { ExecutionEngineSnapshot } from "./execution-engine.js";
import type { ExecutionFeedback } from "./execution-engine.js";
import type { ExecutionEngineResult } from "./execution-engine.js";
import type { StageAdvancingExecutionEngine } from "./execution-engine-router.js";

export class TeamWorkflowExecutionEngine implements StageAdvancingExecutionEngine {
  readonly id = "team_workflow";
  readonly control = "workflow" as const;
  private static readonly MAX_RESUME_TRANSITIONS = 32;
  private readonly activeDrives = new Set<string>();

  constructor(
    private readonly runtimeStore: AgentRuntimeStore,
    private readonly coordinator: WorkflowTeamCoordinator,
    private readonly provision: (context: ExecutionContext) => void,
    private readonly validateTools: (allowedTools: string[]) => void = () => undefined,
  ) {}

  supports(kind: RequirementExecutionKind): boolean { return kind === "software_product_delivery"; }
  isActive(jobId: string): boolean { return this.activeDrives.has(jobId); }
  validateStart(allowedTools: string[]): void { this.validateTools(allowedTools); }
  provideFeedback(jobId: string, feedback: ExecutionFeedback): Promise<boolean> {
    return this.coordinator.provideFeedback(jobId, feedback);
  }
  async start(context: ExecutionContext): Promise<ExecutionEngineResult> {
    this.provision(context);
    return this.resume(context.jobId);
  }
  async resume(jobId: string): Promise<ExecutionEngineResult> {
    await this.runDrive(jobId, true);
    return {};
  }
  async cancel(jobId: string): Promise<void> { this.runtimeStore.cancelJob(jobId); }
  async recover(jobId: string): Promise<void> {
    await this.runDrive(jobId, false);
  }
  advance(jobId: string, expectedStage: FixedProductStage): Promise<{ stage: FixedProductStage; changed: boolean }> {
    return this.coordinator.advance(jobId, expectedStage);
  }
  snapshot(jobId: string): ExecutionEngineSnapshot {
    const job = this.runtimeStore.getJob(jobId);
    return { engine: this.id, jobId, ...(job === undefined ? {} : { workflowVersion: job.workflowVersion }), stage: this.coordinator.getStage(jobId), terminal: job === undefined || ["completed", "failed", "partial", "cancelled"].includes(job.status) };
  }

  private async runDrive(jobId: string, allowModelCalls: boolean): Promise<void> {
    if (this.activeDrives.has(jobId)) return;
    this.activeDrives.add(jobId);
    try {
      this.runtimeStore.reconcilePersistedJobs(jobId);
      this.coordinator.recoverPersistedCheckpoints(jobId);
      await this.drive(jobId, allowModelCalls);
    } finally {
      this.activeDrives.delete(jobId);
    }
  }

  private async drive(jobId: string, allowModelCalls: boolean): Promise<void> {
    const job = this.runtimeStore.getJob(jobId);
    if (job === undefined) throw new Error(`Team Workflow Job is unavailable: ${jobId}`);
    if (job.executionKind !== "software_product_delivery" || job.workflowVersion !== "software_product_delivery_v2") {
      throw new Error(`Team Workflow Job version is unsupported: ${jobId}`);
    }
    for (let transition = 0; transition < TeamWorkflowExecutionEngine.MAX_RESUME_TRANSITIONS; transition += 1) {
      const decision = this.coordinator.recoveryDecision(jobId);
      if (decision.kind === "terminal" || decision.kind === "wait") return;
      if (!allowModelCalls && !this.coordinator.canAdvanceWithoutModel(jobId, decision.stage)) return;
      const before = this.fingerprint(jobId);
      const advanced = await this.coordinator.advance(jobId, decision.stage);
      const after = this.fingerprint(jobId);
      if (!advanced.changed || before === after) return;
    }
    throw new Error(`Team Workflow resume exceeded ${TeamWorkflowExecutionEngine.MAX_RESUME_TRANSITIONS} transitions: ${jobId}`);
  }

  private fingerprint(jobId: string): string {
    const job = this.runtimeStore.getJob(jobId);
    return JSON.stringify({
      status: job?.status,
      attempt: job?.attempt,
      stage: this.coordinator.getStage(jobId),
      tasks: this.runtimeStore.listTasks(jobId).map((item) => [item.id, item.attempt, item.status]),
      returns: this.runtimeStore.listReturns(jobId).map((item) => [item.id, item.status, item.attempts, item.nextAttemptAt]),
      checkpoints: this.runtimeStore.listStageCheckpoints(jobId).map((item) => [item.idempotencyKey, item.status]),
    });
  }
}
