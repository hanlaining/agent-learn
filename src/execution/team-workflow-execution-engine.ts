import type { FixedProductStage } from "../agents/fixed-software-team-coordinator.js";
import type { WorkflowTeamCoordinator } from "./workflow-team-coordinator.js";
import type { AgentRuntimeStore } from "../agents/agent-runtime-store.js";
import type { RequirementExecutionKind } from "../requirements/requirement.js";
import type { ExecutionContext } from "./execution-context.js";
import type { ExecutionEngineSnapshot } from "./execution-engine.js";
import type { StageAdvancingExecutionEngine } from "./execution-engine-router.js";

export class TeamWorkflowExecutionEngine implements StageAdvancingExecutionEngine {
  readonly id = "team_workflow";

  constructor(
    private readonly runtimeStore: AgentRuntimeStore,
    private readonly coordinator: WorkflowTeamCoordinator,
    private readonly provision: (context: ExecutionContext) => void,
    private readonly validateTools: (allowedTools: string[]) => void = () => undefined,
  ) {}

  supports(kind: RequirementExecutionKind): boolean { return kind === "software_product_delivery"; }
  validateStart(allowedTools: string[]): void { this.validateTools(allowedTools); }
  async start(context: ExecutionContext): Promise<void> { this.provision(context); }
  async resume(_jobId: string): Promise<void> {}
  async cancel(jobId: string): Promise<void> { this.runtimeStore.cancelJob(jobId); }
  async recover(_jobId: string): Promise<void> { this.coordinator.recoverPersistedCheckpoints(); }
  advance(jobId: string, expectedStage: FixedProductStage): Promise<{ stage: FixedProductStage; changed: boolean }> {
    return this.coordinator.advance(jobId, expectedStage);
  }
  snapshot(jobId: string): ExecutionEngineSnapshot {
    const job = this.runtimeStore.getJob(jobId);
    return { engine: this.id, jobId, ...(job === undefined ? {} : { workflowVersion: job.workflowVersion }), stage: this.coordinator.getStage(jobId), terminal: job === undefined || ["completed", "failed", "partial", "cancelled"].includes(job.status) };
  }
}
