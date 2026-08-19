import type { RequirementExecutionKind } from "../requirements/requirement.js";
import type { FixedProductStage } from "../agents/fixed-software-team-coordinator.js";
import type { ExecutionContext } from "./execution-context.js";
import type { ExecutionEngine, ExecutionEngineSnapshot } from "./execution-engine.js";
import type { ExecutionControl } from "./execution-engine.js";

export interface StageAdvancingExecutionEngine extends ExecutionEngine {
  advance(jobId: string, expectedStage: FixedProductStage): Promise<{ stage: FixedProductStage; changed: boolean }>;
}

export class ExecutionEngineRouter {
  constructor(private readonly engines: ExecutionEngine[]) {
    if (engines.length < 2) throw new Error("ExecutionEngineRouter requires independent dynamic and team engines");
  }

  route(kind: RequirementExecutionKind): ExecutionEngine {
    const matches = this.engines.filter((engine) => engine.supports(kind));
    if (matches.length !== 1) throw new Error(`Execution engine route must be unique for ${kind}`);
    return matches[0]!;
  }

  start(context: ExecutionContext): Promise<void> { return this.route(context.executionKind).start(context); }
  control(kind: RequirementExecutionKind): ExecutionControl { return this.route(kind).control; }
  validateStart(kind: RequirementExecutionKind, allowedTools: string[]): void { this.route(kind).validateStart?.(allowedTools); }
  resume(kind: RequirementExecutionKind, jobId: string): Promise<void> { return this.route(kind).resume(jobId); }
  cancel(kind: RequirementExecutionKind, jobId: string): Promise<void> { return this.route(kind).cancel(jobId); }
  recover(kind: RequirementExecutionKind, jobId: string): Promise<void> { return this.route(kind).recover(jobId); }
  snapshot(kind: RequirementExecutionKind, jobId: string): ExecutionEngineSnapshot { return this.route(kind).snapshot(jobId); }

  advance(kind: RequirementExecutionKind, jobId: string, expectedStage: FixedProductStage): Promise<{ stage: FixedProductStage; changed: boolean }> {
    const engine = this.route(kind) as Partial<StageAdvancingExecutionEngine>;
    if (engine.advance === undefined) throw new Error(`Execution engine does not expose stages: ${kind}`);
    return engine.advance(jobId, expectedStage);
  }
}
