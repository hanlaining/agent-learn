import type { AgentRuntimeStore } from "../agents/agent-runtime-store.js";
import type { FixedProductStage, FixedSoftwareTeamCoordinator } from "../agents/fixed-software-team-coordinator.js";
import type { RequirementExecutionKind } from "../requirements/requirement.js";
import type { ExecutionContext } from "./execution-context.js";
import type { ExecutionEngineSnapshot } from "./execution-engine.js";
import type { StageAdvancingExecutionEngine } from "./execution-engine-router.js";

/**
 * Explicit rollback seam for legacy workflowVersion Jobs. It reuses the same
 * Runtime stores and AgentLoop assembly; it is intentionally not the default
 * route for newly created software_product_delivery Jobs.
 */
export class LegacyTeamExecutionEngineAdapter implements StageAdvancingExecutionEngine {
  readonly id = "legacy_team_adapter";
  readonly control = "turn_agent" as const;

  constructor(
    private readonly runtimeStore: AgentRuntimeStore,
    private readonly coordinator: FixedSoftwareTeamCoordinator,
  ) {}

  supports(kind: RequirementExecutionKind): boolean { return kind === "software_product_delivery"; }
  async start(_context: ExecutionContext): Promise<{}> { return {}; }
  async resume(_jobId: string): Promise<{}> { return {}; }
  async cancel(jobId: string): Promise<void> { this.runtimeStore.cancelJob(jobId); }
  async recover(_jobId: string): Promise<void> { this.coordinator.recoverPersistedCheckpoints(); }
  advance(jobId: string, expectedStage: FixedProductStage): Promise<{ stage: FixedProductStage; changed: boolean }> {
    return this.coordinator.advance(jobId, expectedStage);
  }
  snapshot(jobId: string): ExecutionEngineSnapshot {
    const job = this.runtimeStore.getJob(jobId);
    return { engine: this.id, jobId, ...(job === undefined ? {} : { workflowVersion: job.workflowVersion }),
      stage: this.coordinator.getStage(jobId), terminal: job === undefined || ["completed", "failed", "partial", "cancelled"].includes(job.status) };
  }
}
