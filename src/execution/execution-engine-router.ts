import type { RequirementExecutionKind } from "../requirements/requirement.js";
import type { FixedProductStage } from "../agents/fixed-software-team-coordinator.js";
import { assertExecutionContext, type ExecutionContext } from "./execution-context.js";
import {
  assertExecutionEngineSnapshot,
  assertExecutionFeedback,
  type ExecutionControl,
  type ExecutionEngine,
  type ExecutionEngineResult,
  type ExecutionEngineSnapshot,
  type ExecutionFeedback,
} from "./execution-engine.js";

export interface StageAdvancingExecutionEngine extends ExecutionEngine {
  advance(jobId: string, expectedStage: FixedProductStage): Promise<{ stage: FixedProductStage; changed: boolean }>;
  requestEngineeringRework?(jobId: string, taskId: string, reason: string): Promise<void>;
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

  start(context: ExecutionContext): Promise<ExecutionEngineResult> {
    assertExecutionContext(context);
    return this.route(context.executionKind).start(context);
  }
  control(kind: RequirementExecutionKind): ExecutionControl { return this.route(kind).control; }
  isActive(kind: RequirementExecutionKind, jobId: string): boolean {
    return this.route(kind).isActive?.(jobId) ?? false;
  }
  provideFeedback(kind: RequirementExecutionKind, jobId: string, feedback: ExecutionFeedback): Promise<boolean> {
    assertExecutionFeedback(feedback);
    return this.route(kind).provideFeedback?.(jobId, feedback) ?? Promise.resolve(false);
  }
  validateStart(kind: RequirementExecutionKind, allowedTools: string[], workflowVersion?: string): void {
    this.route(kind).validateStart?.(allowedTools, workflowVersion);
  }
  resume(kind: RequirementExecutionKind, jobId: string): Promise<ExecutionEngineResult> { return this.route(kind).resume(jobId); }
  cancel(kind: RequirementExecutionKind, jobId: string): Promise<void> { return this.route(kind).cancel(jobId); }
  recover(kind: RequirementExecutionKind, jobId: string): Promise<void> { return this.route(kind).recover(jobId); }
  snapshot(kind: RequirementExecutionKind, jobId: string): ExecutionEngineSnapshot {
    const engine = this.route(kind);
    const snapshot = engine.snapshot(jobId);
    assertExecutionEngineSnapshot(snapshot, { engine: engine.id, jobId });
    return snapshot;
  }

  advance(kind: RequirementExecutionKind, jobId: string, expectedStage: FixedProductStage): Promise<{ stage: FixedProductStage; changed: boolean }> {
    const engine = this.route(kind) as Partial<StageAdvancingExecutionEngine>;
    if (engine.advance === undefined) throw new Error(`Execution engine does not expose stages: ${kind}`);
    return engine.advance(jobId, expectedStage);
  }

  requestEngineeringRework(kind: RequirementExecutionKind, jobId: string, taskId: string, reason: string): Promise<void> {
    const engine = this.route(kind) as Partial<StageAdvancingExecutionEngine>;
    if (engine.requestEngineeringRework === undefined) throw new Error(`Execution engine does not support engineering rework: ${kind}`);
    return engine.requestEngineeringRework(jobId, taskId, reason);
  }
}
