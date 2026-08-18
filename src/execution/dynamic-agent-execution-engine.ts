import type { AgentRuntimeStore } from "../agents/agent-runtime-store.js";
import type { RequirementExecutionKind } from "../requirements/requirement.js";
import type { ExecutionContext } from "./execution-context.js";
import type { ExecutionEngine, ExecutionEngineSnapshot } from "./execution-engine.js";

export class DynamicAgentExecutionEngine implements ExecutionEngine {
  readonly id = "dynamic_agent";

  constructor(private readonly runtimeStore: AgentRuntimeStore) {}

  supports(kind: RequirementExecutionKind): boolean { return kind === "analysis_only" || kind === "software_change"; }
  async start(_context: ExecutionContext): Promise<void> {}
  async resume(_jobId: string): Promise<void> {}
  async cancel(jobId: string): Promise<void> { this.runtimeStore.cancelJob(jobId); }
  async recover(_jobId: string): Promise<void> {}
  snapshot(jobId: string): ExecutionEngineSnapshot {
    const job = this.runtimeStore.getJob(jobId);
    return { engine: this.id, jobId, ...(job === undefined ? {} : { workflowVersion: job.workflowVersion }), terminal: job === undefined || ["completed", "failed", "partial", "cancelled"].includes(job.status) };
  }
}
