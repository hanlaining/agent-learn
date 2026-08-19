import type { AgentRunResult } from "../agents/agent-run.js";
import type { AgentStageCheckpoint } from "../agents/agent-runtime.js";
import { AgentRunStore } from "../agents/agent-run-store.js";
import { AgentRuntimeStore } from "../agents/agent-runtime-store.js";
import { failureOriginForCode, safeFailureMessage } from "../agents/agent-presentation.js";
import type { AgentFailureOrigin } from "../agents/agent-run.js";
import type { FixedProductStage } from "../agents/fixed-software-team-coordinator.js";
import { classifyRuntimeFailure, RuntimeFailure } from "../observability/runtime-failure.js";
import { RuntimeMetricsLedger } from "../observability/runtime-metrics.js";
import type { StageResult } from "./stage-contract.js";
import { STAGE_RESULT_CONTRACT_VERSION } from "./stage-contract.js";
import { parseStageResult, parseStageResultWithRepair } from "./stage-result-parser.js";
import type { WorkflowTemplate } from "./workflows/workflow-template.js";

type TeamProfile = "product_role" | "engineering_role" | "quality_role" | "software_team_lead" | "orchestrator";

export interface WorkflowRequirementContext {
  objective: string;
  scope: string[];
  nonGoals: string[];
  deliverables: string[];
  acceptanceCriteria: string[];
  prompt: string;
}

export interface WorkflowTeamExecution {
  turnId: string;
  summary: string;
  toolCalls?: number;
  invocationId?: string;
}

export interface WorkflowTeamCoordinatorOptions {
  runStore: AgentRunStore;
  runtimeStore: AgentRuntimeStore;
  template: WorkflowTemplate;
  metrics?: RuntimeMetricsLedger;
  execute(input: {
    threadId: string;
    profileId: TeamProfile;
    prompt: string;
    attempt: number;
    allowedTools: string[];
    formatRepair: boolean;
    jobId: string;
    jobAttempt: number;
    workflowVersion: string;
    stageId: string;
    stageAttempt: number;
  }): Promise<WorkflowTeamExecution>;
  recoverModelExecution?(input: {
    jobId: string;
    jobAttempt: number;
    workflowVersion: string;
    stageId: string;
    stageAttempt: number;
  }): WorkflowTeamExecution | undefined;
  commitRecoveredModelExecution?(invocationId: string, targetCommitKey: string): void;
  requirement(jobId: string): WorkflowRequirementContext;
  modelInfo?(profileId: TeamProfile): { model: string; reasoningEffort?: string };
  persist?: () => void | Promise<void>;
  onRunUpdated?: (runId: string) => void;
  onCompleted?: (jobId: string) => void;
  onFailed?: (jobId: string) => void;
}

const FORMAT_CONTRACT = `只返回一个 JSON 对象，不要 Markdown：{"status":"completed|failed|blocked","summary":"简洁结论","deliverables":["交付物"],"evidence":["可验证证据"],"blockers":[],"nextStageRecommendation":"continue|retry|block|complete","contractVersion":"${STAGE_RESULT_CONTRACT_VERSION}"}`;

export type WorkflowRecoveryDecision =
  | { kind: "resume_stage"; stage: FixedProductStage }
  | { kind: "deliver_return"; stage: FixedProductStage }
  | { kind: "wait"; reason: "active" | "backoff" | "no_progress" }
  | { kind: "terminal"; status: "completed" | "failed" | "partial" | "cancelled" };

export class WorkflowTeamCoordinator {
  private readonly activeJobs = new Set<string>();
  private readonly metrics: RuntimeMetricsLedger;

  constructor(private readonly options: WorkflowTeamCoordinatorOptions) {
    this.metrics = options.metrics ?? new RuntimeMetricsLedger();
  }

  recoverPersistedCheckpoints(jobId?: string): number {
    let recovered = 0;
    for (const job of this.options.runtimeStore.listJobs()) {
      if (jobId !== undefined && job.id !== jobId) continue;
      if (job.executionKind !== "software_product_delivery" || job.workflowVersion !== `${this.options.template.id}_${this.options.template.version}`) continue;
      const runs = this.options.runStore.listForJob(job.id);
      if (runs.length === 0 || ["completed", "failed", "partial", "cancelled"].includes(job.status)) continue;
      for (const run of runs) {
        if (["running", "resuming"].includes(run.status)) this.options.runStore.setStatus(run.id, run.agentProfileId === "orchestrator" ? "waiting_children" : "queued");
      }
      recovered += 1;
    }
    return recovered;
  }

  getStage(jobId: string): FixedProductStage {
    const job = this.options.runtimeStore.getJob(jobId);
    if (job === undefined || ["completed", "failed", "partial", "cancelled"].includes(job.status)) return "completed";
    const returns = this.options.runtimeStore.listReturns(jobId)
      .filter((item) => (item.jobAttempt === undefined || item.jobAttempt === job.attempt) && ["ready", "delivering"].includes(item.status));
    const qualityReturn = returns.find((item) => item.stageId === "quality" && item.jobAttempt === job?.attempt);
    if (qualityReturn !== undefined) return "quality_return_ready";
    const leadReturn = returns.find((item) => item.stageId === "lead");
    if (leadReturn !== undefined) return "lead_return_ready";
    const qualityTask = this.taskFor(jobId, "quality_role");
    if (qualityTask !== undefined) return "quality_ready";
    const engineeringReturn = returns.find((item) => item.stageId === "engineering" && item.jobAttempt === job?.attempt);
    if (engineeringReturn !== undefined) return "engineering_return_ready";
    const productTask = this.taskFor(jobId, "product_role");
    if (productTask?.status === "completed") return "engineering_ready";
    if (productTask?.status === "rework" || productTask?.status === "blocked") return "rework";
    const productReturns = returns.filter((item) => item.stageId === "product" && item.jobAttempt === job?.attempt);
    if (productReturns.some((item) => item.businessAttempt === 2)) return "second_return_ready";
    if (productReturns.length > 0) return "first_return_ready";
    return "ready_first_return";
  }

  recoveryDecision(jobId: string): WorkflowRecoveryDecision {
    const job = this.options.runtimeStore.getJob(jobId);
    if (job === undefined) return { kind: "terminal", status: "failed" };
    if (["completed", "failed", "partial", "cancelled"].includes(job.status)) {
      return { kind: "terminal", status: job.status as "completed" | "failed" | "partial" | "cancelled" };
    }
    if (this.activeJobs.has(jobId)) return { kind: "wait", reason: "active" };
    if (job.status === "reviewing" && this.options.runStore.listForJob(jobId).some((run) =>
      run.coordinationStatus === "feedback_required")) {
      // Feedback is a durable pause, not an automatic retry. A parent steer or
      // explicit resume calls advance() after adding the missing guidance.
      return { kind: "wait", reason: "no_progress" };
    }
    const now = new Date().toISOString();
    const pendingBackoff = this.options.runtimeStore.listReturns(jobId).some((item) =>
      (item.jobAttempt === undefined || item.jobAttempt === job.attempt) && item.status === "ready" &&
      item.nextAttemptAt !== undefined && item.nextAttemptAt > now);
    if (pendingBackoff) return { kind: "wait", reason: "backoff" };
    const stage = this.getStage(jobId);
    if (["first_return_ready", "second_return_ready", "engineering_return_ready", "quality_return_ready", "lead_return_ready"].includes(stage)) {
      return { kind: "deliver_return", stage };
    }
    if (stage === "completed") {
      const status = this.options.runtimeStore.getJob(jobId)?.status;
      return { kind: "terminal", status: status === "failed" || status === "partial" || status === "cancelled" ? status : "completed" };
    }
    return { kind: "resume_stage", stage };
  }

  canAdvanceWithoutModel(jobId: string, stage: FixedProductStage): boolean {
    const job = this.options.runtimeStore.getJob(jobId);
    if (job === undefined || ["completed", "failed", "partial", "cancelled"].includes(job.status)) return true;
    if (["first_return_ready", "second_return_ready", "engineering_return_ready"].includes(stage)) return true;
    if (stage === "quality_return_ready") {
      const hasLeadReturn = this.options.runtimeStore.listReturns(jobId).some((item) => item.stageId === "lead" &&
        item.jobAttempt === job.attempt && ["ready", "delivering", "consumed"].includes(item.status));
      if (hasLeadReturn) return true;
      return this.hasPersistedStageEvidence(jobId, "lead", job.attempt) ||
        this.hasRecoverableModelExecution(jobId, "lead", job.attempt);
    }
    if (stage === "lead_return_ready") return this.hasPersistedStageEvidence(jobId, "return_god", job.attempt) ||
      this.hasRecoverableModelExecution(jobId, "return_god", job.attempt);
    const stageId = stage === "ready_first_return" || stage === "rework" ? "product"
      : stage === "engineering_ready" ? "engineering"
        : stage === "quality_ready" ? "quality" : undefined;
    return stageId !== undefined && (this.hasPersistedStageEvidence(jobId, stageId, job.attempt, true) ||
      this.hasRecoverableModelExecution(jobId, stageId, job.attempt));
  }

  async advance(jobId: string, expectedStage: FixedProductStage): Promise<{ stage: FixedProductStage; changed: boolean }> {
    const current = this.getStage(jobId);
    if (current !== expectedStage || current === "completed" || this.activeJobs.has(jobId)) return { stage: current, changed: false };
    this.activeJobs.add(jobId);
    try {
      if (current === "ready_first_return") await this.runProduct(jobId, 1);
      else if (current === "first_return_ready") await this.validateProduct(jobId, 1);
      else if (current === "rework") await this.runProduct(jobId, 2);
      else if (current === "second_return_ready") await this.validateProduct(jobId, 2);
      else if (current === "engineering_ready") await this.runEngineering(jobId);
      else if (current === "engineering_return_ready") await this.acceptEngineering(jobId);
      else if (current === "quality_ready") await this.runQuality(jobId);
      else if (current === "quality_return_ready") await this.acceptQuality(jobId);
      else if (current === "lead_return_ready") await this.deliver(jobId);
      return { stage: this.getStage(jobId), changed: true };
    } finally {
      this.activeJobs.delete(jobId);
    }
  }

  private team(jobId: string) {
    const job = this.options.runtimeStore.getJob(jobId);
    if (job === undefined) throw new Error("Team Job is unavailable");
    const runs = this.options.runStore.listForJob(jobId);
    const root = runs.find((item) => item.id === job.rootRunId);
    const lead = runs.find((item) => item.agentProfileId === "software_team_lead");
    const product = runs.find((item) => item.agentProfileId === "product_role");
    const engineering = runs.find((item) => item.agentProfileId === "engineering_role");
    const quality = runs.find((item) => item.agentProfileId === "quality_role");
    if (root === undefined || lead === undefined || product === undefined || engineering === undefined || quality === undefined) throw new Error("Team structure is incomplete");
    return { job, root, lead, product, engineering, quality };
  }

  private taskFor(jobId: string, profileId: TeamProfile) {
    const job = this.options.runtimeStore.getJob(jobId);
    return this.options.runtimeStore.listTasks(jobId).find((item) => item.profileId === profileId && item.jobAttempt === job?.attempt);
  }

  private ensureTask(jobId: string, profileId: "product_role" | "engineering_role" | "quality_role", parentTaskId?: string) {
    const existing = this.taskFor(jobId, profileId);
    if (existing !== undefined) return existing;
    const context = this.options.requirement(jobId); const team = this.team(jobId);
    const owner = profileId === "product_role" ? team.product : profileId === "engineering_role" ? team.engineering : team.quality;
    const writable = profileId === "engineering_role";
    const task = this.options.runtimeStore.createTask({
      jobId, rootRunId: team.root.rootRunId, ownerRunId: owner.id, profileId,
      ...(parentTaskId === undefined ? {} : { parentTaskId }),
      title: `${profileId}:${context.objective}`,
      objective: context.objective,
      scope: { allowedPaths: profileId === "product_role" ? [] : [...context.scope], deniedPaths: [".env", ".git/**"], nonGoals: [...context.nonGoals] },
      requiredOutputs: [...context.deliverables], acceptanceCriteria: [...context.acceptanceCriteria],
      fileClaims: writable ? [...context.scope] : [], maxAttempts: 2, status: "ready",
    });
    this.options.runStore.setTaskId(owner.id, task.id);
    this.options.runStore.setPresentation(owner.id, {
      attentionLevel: "neutral",
      statusMessage: "已收到任务，等待阶段启动",
    });
    return task;
  }

  private async runProduct(jobId: string, attempt: number): Promise<void> {
    const team = this.team(jobId); const task = this.ensureTask(jobId, "product_role");
    if (attempt > 1) this.options.runtimeStore.setTaskOwnerRun(task.id, team.product.id, attempt);
    await this.runWorkerStage({
      jobId, stageId: "product", profileId: "product_role", runId: team.product.id, threadId: team.product.threadId,
      taskId: task.id, parentRunId: team.lead.id, attempt, kind: "summary", producer: "worker",
      prompt: `把已确认需求整理成可执行的结构化产品规格。不得实现工程，也不得扩大范围。\n\n${this.options.requirement(jobId).prompt}`,
    });
  }

  private async validateProduct(jobId: string, attempt: number): Promise<void> {
    const team = this.team(jobId); const task = this.ensureTask(jobId, "product_role");
    const envelope = this.requireReturn(jobId, "product", attempt); const claimed = this.options.runtimeStore.claimReturn(envelope.id);
    if (claimed === undefined) throw new RuntimeFailure("return_delivery_failed", "Product Return is unavailable", true);
    const result = parseStageResult(claimed.result.summary);
    const complete = result.status === "completed" && result.deliverables.length > 0 && result.evidence.length > 0 && result.blockers.length === 0;
    const review = this.options.runtimeStore.addEvidence({
      jobId, taskId: task.id, runId: team.lead.id, kind: "review", producer: "reviewer",
      verdict: complete ? "passed" : "failed", ...(complete ? {} : { severity: "P2" as const }),
      summary: complete ? "Runtime deterministic product contract passed" : "Product contract lacks required deliverables/evidence or contains blockers",
      idempotencyKey: `${envelope.idempotencyKey}:deterministic-review`, jobAttempt: team.job.attempt,
      workflowVersion: team.job.workflowVersion, stageId: "product", stageAttempt: attempt,
    });
    this.options.runtimeStore.consumeReturn(envelope.id);
    if (complete) {
      this.options.runtimeStore.setTaskStatus(task.id, "completed");
      this.options.runtimeStore.publishBoard({ jobId, producerRunId: team.product.id, taskId: task.id, attempt,
        kind: "summary", title: "Product specification", summary: result.summary, confidence: "confirmed", visibility: "job",
        idempotencyKey: `${envelope.idempotencyKey}:board`, workflowVersion: team.job.workflowVersion, stageId: "product", stageAttempt: attempt });
      this.options.runStore.complete(team.product.id, { runId: team.product.id, taskId: task.id, status: "completed", summary: result.summary });
      this.options.runStore.setPresentation(team.product.id, { attentionLevel: "success", statusMessage: "产品规格已通过验收" });
      this.options.runtimeStore.setJobStatus(jobId, "running");
    } else if (result.status === "blocked") {
      this.pauseForFeedback(jobId, task.id, team.product.id, "产品阶段需要负责人补充信息");
    } else if (attempt < 2) {
      this.options.runtimeStore.setTaskStatus(task.id, "rework"); this.options.runStore.setStatus(team.product.id, "resuming");
      this.options.runStore.setPresentation(team.product.id, {
        coordinationStatus: "rework_required",
        attentionLevel: "feedback",
        statusMessage: "产品输出需要返工",
      });
      this.options.runtimeStore.setJobStatus(jobId, "reviewing");
    } else {
      this.options.runtimeStore.setTaskStatus(task.id, "failed");
      this.failWorkflow(jobId, "stage_retry_exhausted", "Product business acceptance failed", [team.product.id], "contract");
    }
    void review; await this.options.persist?.();
  }

  private async runEngineering(jobId: string): Promise<void> {
    const team = this.team(jobId); const parent = this.ensureTask(jobId, "product_role");
    let task = this.ensureTask(jobId, "engineering_role", parent.id);
    if (task.status === "rework" || task.status === "blocked") {
      this.options.runtimeStore.setTaskOwnerRun(task.id, team.engineering.id, task.attempt + 1);
      this.options.runStore.setStatus(team.engineering.id, "resuming");
      task = this.options.runtimeStore.getTask(task.id)!;
    }
    await this.runWorkerStage({
      jobId, stageId: "engineering", profileId: "engineering_role", runId: team.engineering.id, threadId: team.engineering.threadId,
      taskId: task.id, parentRunId: team.lead.id, attempt: task.attempt, kind: "artifact", producer: "worker",
      prompt: `只在已确认 scope 内完成工程实现并运行必要检查。交付目录来自 Requirement，不得假设任何演示项目路径。\n\n${this.options.requirement(jobId).prompt}`,
    });
  }

  private async acceptEngineering(jobId: string): Promise<void> {
    const team = this.team(jobId); const task = this.ensureTask(jobId, "engineering_role");
    const envelope = this.requireReturn(jobId, "engineering", task.attempt); const claimed = this.options.runtimeStore.claimReturn(envelope.id);
    if (claimed === undefined) throw new RuntimeFailure("return_delivery_failed", "Engineering Return is unavailable", true);
    const result = parseStageResult(claimed.result.summary);
    if (!isSuccessfulStageResult(result)) {
      if (result.status === "blocked") {
        this.options.runtimeStore.consumeReturn(envelope.id);
        this.pauseForFeedback(jobId, task.id, team.engineering.id, "工程阶段需要负责人补充信息");
        await this.options.persist?.();
        return;
      }
      if (task.attempt < task.maxAttempts) {
        this.options.runtimeStore.consumeReturn(envelope.id);
        this.options.runtimeStore.setTaskStatus(task.id, "rework");
        this.options.runStore.setStatus(team.engineering.id, "resuming");
        this.options.runStore.setPresentation(team.engineering.id, {
          coordinationStatus: "rework_required",
          attentionLevel: "feedback",
          statusMessage: "工程输出需要返工",
        });
        this.options.runtimeStore.setJobStatus(jobId, "reviewing");
        await this.options.persist?.();
        return;
      }
      this.options.runtimeStore.failReturn(envelope.id);
      this.options.runtimeStore.setTaskStatus(task.id, "failed");
      this.failWorkflow(jobId, "stage_retry_exhausted", "Engineering business acceptance failed", [team.engineering.id], "contract");
      await this.options.persist?.();
      return;
    }
    this.options.runtimeStore.consumeReturn(envelope.id);
    this.options.runtimeStore.setTaskStatus(task.id, "completed");
    this.options.runtimeStore.addEvidence({ jobId, taskId: task.id, runId: team.lead.id, kind: "review", summary: "Engineering contract accepted; independent quality follows", producer: "runtime", verdict: "passed",
      idempotencyKey: `${envelope.idempotencyKey}:review`, jobAttempt: team.job.attempt, workflowVersion: team.job.workflowVersion, stageId: "engineering", stageAttempt: task.attempt });
    this.ensureTask(jobId, "quality_role", task.id); this.options.runtimeStore.setJobStatus(jobId, "running"); await this.options.persist?.();
  }

  private async runQuality(jobId: string): Promise<void> {
    const team = this.team(jobId); const engineering = this.ensureTask(jobId, "engineering_role");
    let task = this.ensureTask(jobId, "quality_role", engineering.id);
    if (task.status === "rework" || task.status === "blocked") {
      this.options.runtimeStore.setTaskOwnerRun(task.id, team.quality.id, task.attempt + 1);
      this.options.runStore.setStatus(team.quality.id, "resuming");
      task = this.options.runtimeStore.getTask(task.id)!;
    }
    await this.runWorkerStage({
      jobId, stageId: "quality", profileId: "quality_role", runId: team.quality.id, threadId: team.quality.threadId,
      taskId: task.id, parentRunId: team.lead.id, attempt: task.attempt, kind: "test", producer: "reviewer",
      prompt: `独立、只读验收工程结果；运行允许的测试并逐条核对已确认验收标准。不得修改文件。\n\n${this.options.requirement(jobId).prompt}`,
    });
  }

  private async acceptQuality(jobId: string): Promise<void> {
    const team = this.team(jobId); const task = this.ensureTask(jobId, "quality_role");
    const envelope = this.requireReturn(jobId, "quality", task.attempt); const claimed = this.options.runtimeStore.claimReturn(envelope.id);
    if (claimed === undefined) throw new RuntimeFailure("return_delivery_failed", "Quality Return is unavailable", true);
    const existingLeadReturn = this.options.runtimeStore.listReturns(jobId).find((item) => item.stageId === "lead" &&
      item.jobAttempt === team.job.attempt && ["ready", "delivering", "consumed"].includes(item.status));
    if (existingLeadReturn !== undefined) {
      this.options.runtimeStore.consumeReturn(envelope.id);
      this.options.runtimeStore.reconcileJobStatus(jobId);
      await this.options.persist?.();
      return;
    }
    const result = parseStageResult(claimed.result.summary);
    if (!isSuccessfulStageResult(result)) {
      if (result.status === "blocked") {
        this.options.runtimeStore.consumeReturn(envelope.id);
        this.pauseForFeedback(jobId, task.id, team.quality.id, "测试阶段需要负责人补充信息");
        await this.options.persist?.();
        return;
      }
      if (task.attempt < task.maxAttempts) {
        this.options.runtimeStore.consumeReturn(envelope.id);
        this.options.runtimeStore.setTaskStatus(task.id, "rework");
        this.options.runStore.setStatus(team.quality.id, "resuming");
        this.options.runStore.setPresentation(team.quality.id, {
          coordinationStatus: "rework_required",
          attentionLevel: "feedback",
          statusMessage: "测试输出需要返工",
        });
        this.options.runtimeStore.setJobStatus(jobId, "reviewing");
        await this.options.persist?.();
        return;
      }
      this.options.runtimeStore.failReturn(envelope.id);
      this.options.runtimeStore.setTaskStatus(task.id, "failed");
      this.failWorkflow(jobId, "stage_retry_exhausted", "Quality business acceptance failed", [team.quality.id], "contract");
      await this.options.persist?.();
      return;
    }
    const savedLeadCheckpoint = this.options.runtimeStore.listStageCheckpoints(jobId)
      .filter((item) => item.jobAttempt === team.job.attempt && item.stageId === "lead" &&
        ["running", "validating", "completed"].includes(item.status)).at(-1);
    const savedLeadEvidence = savedLeadCheckpoint === undefined ? undefined : this.options.runtimeStore.listEvidence(task.id)
      .find((item) => item.idempotencyKey === `${savedLeadCheckpoint.idempotencyKey}:evidence`);
    if (savedLeadCheckpoint !== undefined && savedLeadEvidence !== undefined) {
      const savedLeadResult = parseStageResult(savedLeadEvidence.summary);
      if (!isSuccessfulStageResult(savedLeadResult)) {
        this.options.runtimeStore.failReturn(envelope.id);
        this.failWorkflow(jobId, "stage_contract_failed", "Persisted Lead evidence is invalid", [team.lead.id], "contract");
        await this.options.persist?.();
        throw new RuntimeFailure("stage_contract_failed", "Persisted Lead evidence is invalid", false);
      }
      if (savedLeadCheckpoint.status === "running") {
        this.options.runtimeStore.setStageStatus(savedLeadCheckpoint.idempotencyKey, "validating");
      }
      const review = this.options.runtimeStore.addEvidence({ jobId, taskId: task.id, runId: team.lead.id, kind: "review", summary: JSON.stringify(savedLeadResult), producer: "reviewer", verdict: "passed",
        idempotencyKey: `${savedLeadCheckpoint.idempotencyKey}:evidence`, jobAttempt: team.job.attempt, workflowVersion: team.job.workflowVersion, stageId: "lead", stageAttempt: savedLeadCheckpoint.stageAttempt });
      this.options.runtimeStore.createReturn({ jobId, rootRunId: team.root.rootRunId, parentRunId: team.root.id, childRunId: team.lead.id, taskId: task.id, sequence: 4,
        result: { status: "completed", summary: JSON.stringify(savedLeadResult), evidenceIds: [...claimed.result.evidenceIds, review.id], boardEntryIds: [] },
        idempotencyKey: savedLeadCheckpoint.idempotencyKey, jobAttempt: team.job.attempt, workflowVersion: team.job.workflowVersion, stageId: "lead", stageAttempt: savedLeadCheckpoint.stageAttempt });
      if (savedLeadCheckpoint.status !== "completed") {
        this.options.runtimeStore.setStageStatus(savedLeadCheckpoint.idempotencyKey, "completed");
      }
      this.options.runtimeStore.setTaskStatus(task.id, "completed");
      this.options.runtimeStore.setJobStatus(jobId, "waiting_returns");
      await this.options.persist?.();
      this.options.runtimeStore.consumeReturn(envelope.id);
      await this.options.persist?.();
      return;
    }
    if (savedLeadCheckpoint?.status === "completed") {
      this.options.runtimeStore.failReturn(envelope.id);
      this.failWorkflow(jobId, "stage_contract_failed", "Completed Lead stage has no recoverable evidence", [team.lead.id], "contract");
      await this.options.persist?.();
      throw new RuntimeFailure("stage_contract_failed", "Completed Lead stage has no recoverable evidence", false);
    }
    this.options.runtimeStore.setTaskStatus(task.id, "completed");
    const stageTemplate = this.stage("lead");
    let stage: AgentStageCheckpoint | undefined;
    try {
      stage = this.options.runtimeStore.beginStage(jobId, "lead", stageTemplate.retryPolicy.maxBusinessAttempts);
      this.options.runStore.setStatus(team.lead.id, "running");
      this.options.runStore.setPresentation(team.lead.id, { attentionLevel: "active", statusMessage: "负责人正在验收团队结果" });
      const leadResult = await this.executeStructured({ jobId, checkpointKey: stage.idempotencyKey, stageId: "lead", profileId: "software_team_lead", threadId: team.lead.threadId,
        attempt: stage.stageAttempt, allowedTools: stageTemplate.allowedTools,
        prompt: `只汇总已有 Product、Engineering、Quality 合法证据一次，不重新读取文件或执行 Worker 工作。\n\nQuality Return:\n${claimed.result.summary}` });
      if (leadResult.result.status === "blocked") {
        this.options.runtimeStore.retryReturn(envelope.id, 0);
        this.options.runtimeStore.setStageStatus(stage.idempotencyKey, "failed_retryable", "stage_feedback_required");
        this.pauseForFeedback(jobId, undefined, team.lead.id, "负责人需要补充信息后才能继续验收");
        this.metrics.finish(stage);
        await this.options.persist?.();
        return;
      }
      if (!isSuccessfulStageResult(leadResult.result)) {
        throw new RuntimeFailure("stage_contract_failed", "Lead business acceptance failed", true);
      }
      this.options.runtimeStore.setStageStatus(stage.idempotencyKey, "validating");
      const review = this.options.runtimeStore.addEvidence({ jobId, taskId: task.id, runId: team.lead.id, kind: "review", summary: JSON.stringify(leadResult.result), producer: "reviewer", verdict: "passed",
        idempotencyKey: `${stage.idempotencyKey}:evidence`, jobAttempt: team.job.attempt, workflowVersion: team.job.workflowVersion, stageId: "lead", stageAttempt: stage.stageAttempt });
      this.options.runtimeStore.createReturn({ jobId, rootRunId: team.root.rootRunId, parentRunId: team.root.id, childRunId: team.lead.id, taskId: task.id, sequence: 4,
        result: { status: "completed", summary: JSON.stringify(leadResult.result), evidenceIds: [...claimed.result.evidenceIds, review.id], boardEntryIds: [] },
        idempotencyKey: stage.idempotencyKey, jobAttempt: team.job.attempt, workflowVersion: team.job.workflowVersion, stageId: "lead", stageAttempt: stage.stageAttempt });
      this.options.runtimeStore.setStageStatus(stage.idempotencyKey, "completed");
      this.options.runStore.complete(team.lead.id, { runId: team.lead.id, taskId: task.id, status: "completed", summary: leadResult.result.summary });
      this.options.runStore.setPresentation(team.lead.id, { attentionLevel: "success", statusMessage: "团队结果已验收并 Return God" });
      this.options.runtimeStore.setJobStatus(jobId, "waiting_returns");
      if (leadResult.invocationId !== undefined) {
        this.options.commitRecoveredModelExecution?.(
          leadResult.invocationId,
          `${stage.idempotencyKey}:evidence`,
        );
      }
      this.metrics.finish(stage);
      // 先提交 Lead Evidence/Return/Checkpoint，再 ack Quality。
      // 如果进程在两次持久化之间退出，下一次 acceptQuality 只补 ack，绝不重跑 Lead。
      await this.options.persist?.();
      this.options.runtimeStore.consumeReturn(envelope.id);
      await this.options.persist?.();
    } catch (error) {
      const currentQualityReturn = this.options.runtimeStore.listReturns(jobId).find((item) => item.id === envelope.id);
      const committedLeadReturn = this.options.runtimeStore.listReturns(jobId).find((item) => item.stageId === "lead" &&
        item.jobAttempt === team.job.attempt && ["ready", "delivering", "consumed"].includes(item.status));
      const currentLeadStage = stage === undefined ? undefined : this.options.runtimeStore.listStageCheckpoints(jobId)
        .find((item) => item.idempotencyKey === stage!.idempotencyKey);
      if (currentQualityReturn?.status === "consumed") {
        // ack 已完成，保存失败不能把 Return 回退为 ready。
        await this.options.persist?.();
        throw error;
      }
      if (committedLeadReturn !== undefined && currentLeadStage?.status === "completed") {
        if (currentQualityReturn?.status === "delivering") this.options.runtimeStore.retryReturn(envelope.id, 0);
        this.options.runtimeStore.setJobStatus(jobId, "waiting_returns");
        await this.options.persist?.();
        throw error;
      }
      const code = classifyRuntimeFailure(error);
      const terminal = stage === undefined || stage.stageAttempt >= stageTemplate.retryPolicy.maxBusinessAttempts;
      if (stage !== undefined) {
        this.setStageFailure(stage, terminal, code);
        this.metrics.finish(stage, { primaryFailureCode: code });
      }
      if (terminal) {
        this.options.runtimeStore.failReturn(envelope.id);
        this.failWorkflow(jobId, code, "Lead stage failed", [team.lead.id], failureOriginForCode(code));
      } else {
        this.options.runtimeStore.retryReturn(envelope.id, 0);
        this.options.runStore.setStatus(team.lead.id, "resuming");
        this.options.runStore.setPresentation(team.lead.id, {
          coordinationStatus: "feedback_required", attentionLevel: "feedback",
          statusMessage: safeFailureMessage(code), failureOrigin: failureOriginForCode(code),
        });
        this.options.runtimeStore.setJobStatus(jobId, "waiting_returns");
      }
      await this.options.persist?.();
      throw error;
    }
  }

  private async deliver(jobId: string): Promise<void> {
    const team = this.team(jobId); const task = this.ensureTask(jobId, "quality_role");
    const envelope = this.options.runtimeStore.listReturns(jobId).find((item) => item.stageId === "lead" &&
      item.jobAttempt === team.job.attempt && ["ready", "delivering"].includes(item.status));
    if (envelope === undefined) throw new RuntimeFailure("return_delivery_failed", "Lead Return is unavailable", true);
    let stage: AgentStageCheckpoint | undefined;
    try {
      const claimed = this.options.runtimeStore.claimReturn(envelope.id);
      if (claimed === undefined) throw new RuntimeFailure("return_delivery_failed", "Lead Return cannot be claimed", true);
      stage = this.options.runtimeStore.beginStage(jobId, "return_god", 2);
      this.options.runStore.setStatus(team.root.id, "resuming");
      this.options.runStore.setPresentation(team.root.id, { attentionLevel: "active", statusMessage: "God 正在收口最终结果" });
      const deliveryEvidenceKey = `${stage.idempotencyKey}:evidence`;
      const savedDeliveryEvidence = this.options.runtimeStore.listEvidence(task.id)
        .find((item) => item.idempotencyKey === deliveryEvidenceKey);
      let finalSummary: string;
      if (savedDeliveryEvidence !== undefined) {
        finalSummary = savedDeliveryEvidence.summary;
      } else {
        if (stage.status === "completed") {
          throw new RuntimeFailure("stage_contract_failed", "Completed final delivery has no recoverable evidence", false);
        }
        const deliveryModel = this.options.modelInfo?.("orchestrator");
        this.metrics.start({ jobId: team.job.id, jobAttempt: team.job.attempt, workflowVersion: team.job.workflowVersion,
          stageId: "return_god", stageAttempt: stage.stageAttempt, ...(deliveryModel === undefined ? {} : deliveryModel) });
        const execution = this.options.recoverModelExecution?.({
          jobId: team.job.id, jobAttempt: team.job.attempt, workflowVersion: team.job.workflowVersion,
          stageId: "return_god", stageAttempt: stage.stageAttempt,
        }) ?? await this.options.execute({ threadId: team.job.threadId, profileId: "orchestrator", attempt: stage.stageAttempt, allowedTools: [], formatRepair: false,
          jobId: team.job.id, jobAttempt: team.job.attempt, workflowVersion: team.job.workflowVersion, stageId: "return_god", stageAttempt: stage.stageAttempt,
          prompt: `团队工作已经完成。只根据负责人 Return 向用户交付一次最终结果；不要重复读取文件、执行任务或再次委派。\n\n${claimed.result.summary}` });
        if (execution.invocationId === undefined) {
          this.metrics.increment(stage, "modelCalls");
          for (let index = 0; index < (execution.toolCalls ?? 0); index += 1) this.metrics.increment(stage, "toolCalls");
        }
        finalSummary = execution.summary;
        if (stage.status === "running") this.options.runtimeStore.setStageStatus(stage.idempotencyKey, "validating");
        this.options.runtimeStore.addEvidence({ jobId, taskId: task.id, runId: team.root.id, kind: "summary", summary: finalSummary,
          producer: "runtime", verdict: "supported", idempotencyKey: deliveryEvidenceKey, jobAttempt: team.job.attempt,
          workflowVersion: team.job.workflowVersion, stageId: "return_god", stageAttempt: stage.stageAttempt });
        if (execution.invocationId !== undefined) {
          this.options.commitRecoveredModelExecution?.(execution.invocationId, deliveryEvidenceKey);
        }
        // 先持久化最终模型结果；后续 ack/终态保存失败时可只补提交，不重跑模型。
        await this.options.persist?.();
      }
      this.options.runtimeStore.consumeReturn(envelope.id);
      const result: AgentRunResult = { runId: team.lead.id, taskId: task.id, status: "completed", summary: claimed.result.summary };
      this.options.runStore.complete(team.lead.id, result);
      this.options.runStore.complete(team.root.id, { ...result, runId: team.root.id, summary: finalSummary });
      const currentStage = this.options.runtimeStore.listStageCheckpoints(jobId).find((item) => item.idempotencyKey === stage!.idempotencyKey);
      if (currentStage?.status !== "completed") this.options.runtimeStore.setStageStatus(stage.idempotencyKey, "completed");
      this.options.runtimeStore.setJobStatus(jobId, "completed");
      this.metrics.finish(stage, { terminalStates: { job: "completed", requirement: "completed", task: "completed", agentRun: "completed", return: "consumed" } });
      this.options.onCompleted?.(jobId); this.notify(team.root.id, team.lead.id); await this.options.persist?.();
    } catch (error) {
      const currentReturn = this.options.runtimeStore.listReturns(jobId).find((item) => item.id === envelope.id);
      const currentStage = stage === undefined ? undefined : this.options.runtimeStore.listStageCheckpoints(jobId)
        .find((item) => item.idempotencyKey === stage!.idempotencyKey);
      const savedDeliveryEvidence = stage === undefined ? undefined : this.options.runtimeStore.listEvidence(task.id)
        .find((item) => item.idempotencyKey === `${stage!.idempotencyKey}:evidence`);
      if (currentReturn?.status === "consumed" && currentStage?.status === "completed" &&
        this.options.runtimeStore.getJob(jobId)?.status === "completed") {
        await this.options.persist?.();
        throw error;
      }
      if (savedDeliveryEvidence !== undefined && currentStage !== undefined && ["validating", "completed"].includes(currentStage.status)) {
        if (currentReturn?.status === "delivering") this.options.runtimeStore.retryReturn(envelope.id, 0);
        this.options.runtimeStore.setJobStatus(jobId, "waiting_returns");
        await this.options.persist?.();
        throw error;
      }
      const code = classifyRuntimeFailure(error);
      const terminal = stage === undefined ||
        (error instanceof RuntimeFailure && !error.retryable) || stage.stageAttempt >= 2;
      if (stage !== undefined) {
        this.setStageFailure(stage, terminal, code);
        this.metrics.finish(stage, { primaryFailureCode: code });
      }
      if (terminal) {
        this.options.runtimeStore.failReturn(envelope.id);
        this.failWorkflow(jobId, code, "Final delivery failed", [team.root.id], failureOriginForCode(code));
      } else {
        this.options.runtimeStore.retryReturn(envelope.id, 0);
        this.options.runtimeStore.setJobStatus(jobId, "waiting_returns");
        this.options.runStore.setPresentation(team.root.id, {
          coordinationStatus: "feedback_required", attentionLevel: "feedback",
          statusMessage: safeFailureMessage(code), failureOrigin: failureOriginForCode(code),
        });
      }
      await this.options.persist?.(); throw error;
    }
  }

  private async runWorkerStage(input: { jobId: string; stageId: "product" | "engineering" | "quality"; profileId: TeamProfile; runId: string; threadId: string; taskId: string; parentRunId: string; attempt: number; kind: "summary" | "artifact" | "test"; producer: "worker" | "reviewer"; prompt: string }): Promise<void> {
    const team = this.team(input.jobId); const template = this.stage(input.stageId);
    const checkpoint = this.options.runtimeStore.beginStage(input.jobId, input.stageId, template.retryPolicy.maxBusinessAttempts, input.attempt > 1);
    const evidenceKey = `${checkpoint.idempotencyKey}:evidence`;
    const existingEvidence = this.options.runtimeStore.listEvidence(input.taskId).find((item) => item.idempotencyKey === evidenceKey);
    if (checkpoint.status === "completed" && existingEvidence === undefined) {
      this.options.runtimeStore.setTaskStatus(input.taskId, "failed");
      this.failWorkflow(input.jobId, "stage_contract_failed", `Completed ${input.stageId} stage has no recoverable evidence`, [input.runId], "runtime");
      await this.options.persist?.();
      throw new RuntimeFailure("stage_contract_failed", `Completed ${input.stageId} stage has no recoverable evidence`, false);
    }
    try {
      this.options.runtimeStore.setTaskStatus(input.taskId, "running"); this.options.runStore.setStatus(input.runId, "running");
      this.markSupervisorsWaiting(input.jobId, input.runId);
      this.options.runStore.setPresentation(input.runId, { attentionLevel: "active", statusMessage: "正在执行已分派任务" });
      await this.options.persist?.();
      let result: StageResult; let turnId: string; let recoveredInvocationId: string | undefined;
      if (existingEvidence !== undefined) {
        result = parseStageResult(existingEvidence.summary); turnId = this.options.runStore.get(input.runId)?.turnId ?? input.threadId;
      } else {
        const execution = await this.executeStructured({ jobId: input.jobId, checkpointKey: checkpoint.idempotencyKey, stageId: input.stageId, profileId: input.profileId,
          threadId: input.threadId, attempt: checkpoint.stageAttempt, allowedTools: template.allowedTools, prompt: input.prompt });
        result = execution.result; turnId = execution.turnId; recoveredInvocationId = execution.invocationId;
      }
      if (checkpoint.status === "running") this.options.runtimeStore.setStageStatus(checkpoint.idempotencyKey, "validating");
      this.options.runStore.rebindAttempt(input.runId, turnId, input.attempt);
      const evidence = this.options.runtimeStore.addEvidence({ jobId: input.jobId, taskId: input.taskId, runId: input.runId, kind: input.kind,
        summary: JSON.stringify(result), producer: input.producer, verdict: result.status === "failed" ? "failed" : "supported",
        idempotencyKey: evidenceKey, jobAttempt: team.job.attempt, workflowVersion: team.job.workflowVersion, stageId: input.stageId, stageAttempt: checkpoint.stageAttempt });
      this.options.runStore.complete(input.runId, {
        runId: input.runId, taskId: input.taskId,
        status: "completed",
        summary: result.summary,
      });
      this.options.runStore.setPresentation(input.runId, result.status === "blocked" ? {
        coordinationStatus: "feedback_required", attentionLevel: "feedback",
        statusMessage: result.summary || "需要负责人补充信息后继续",
      } : result.status === "failed" ? {
        coordinationStatus: "rework_required", attentionLevel: "feedback", statusMessage: "阶段输出需要返工",
      } : { attentionLevel: "success", statusMessage: "阶段结果已返回，等待验收" });
      this.options.runtimeStore.createReturn({ jobId: input.jobId, rootRunId: team.root.rootRunId, parentRunId: input.parentRunId, childRunId: input.runId, taskId: input.taskId,
        sequence: input.stageId === "product" ? input.attempt : input.stageId === "engineering" ? 2 : 3,
        result: { status: result.status === "failed" ? "failed" : "completed", summary: JSON.stringify(result), evidenceIds: [evidence.id], boardEntryIds: [] },
        idempotencyKey: checkpoint.idempotencyKey, jobAttempt: team.job.attempt, workflowVersion: team.job.workflowVersion, stageId: input.stageId,
        stageAttempt: checkpoint.stageAttempt, businessAttempt: input.attempt });
      const currentCheckpoint = this.options.runtimeStore.listStageCheckpoints(input.jobId)
        .find((item) => item.idempotencyKey === checkpoint.idempotencyKey);
      if (currentCheckpoint?.status !== "completed") this.options.runtimeStore.setStageStatus(checkpoint.idempotencyKey, "completed");
      this.options.runtimeStore.setJobStatus(input.jobId, "waiting_returns");
      if (recoveredInvocationId !== undefined) {
        this.options.commitRecoveredModelExecution?.(recoveredInvocationId, evidenceKey);
      }
      this.metrics.finish(checkpoint); this.notify(input.runId); await this.options.persist?.();
    } catch (error) {
      const code = classifyRuntimeFailure(error); const terminal = checkpoint.stageAttempt >= template.retryPolicy.maxBusinessAttempts;
      this.options.runtimeStore.setStageStatus(checkpoint.idempotencyKey, terminal ? "failed_terminal" : "failed_retryable", code);
      this.metrics.finish(checkpoint, { primaryFailureCode: code });
      if (terminal) {
        this.options.runtimeStore.setTaskStatus(input.taskId, "failed");
        this.failWorkflow(input.jobId, code, `Stage failed: ${code}`, [input.runId], failureOriginForCode(code));
      } else {
        this.options.runtimeStore.setTaskStatus(input.taskId, "ready"); this.options.runStore.setStatus(input.runId, "resuming");
        this.options.runStore.setPresentation(input.runId, {
          coordinationStatus: "feedback_required", attentionLevel: "feedback",
          statusMessage: safeFailureMessage(code), failureOrigin: failureOriginForCode(code),
        });
      }
      await this.options.persist?.(); throw error;
    }
  }

  private async executeStructured(input: { jobId: string; checkpointKey: string; stageId: string; profileId: TeamProfile; threadId: string; prompt: string; attempt: number; allowedTools: string[] }): Promise<{ result: StageResult; turnId: string; invocationId?: string }> {
    const job = this.options.runtimeStore.getJob(input.jobId)!;
    const checkpoint = this.options.runtimeStore.listStageCheckpoints(input.jobId).find((item) => item.idempotencyKey === input.checkpointKey)!;
    const modelInfo = this.options.modelInfo?.(input.profileId);
    this.metrics.start({ jobId: job.id, jobAttempt: job.attempt, workflowVersion: job.workflowVersion,
      stageId: input.stageId, stageAttempt: checkpoint.stageAttempt, ...(modelInfo === undefined ? {} : modelInfo) });
    const first = this.options.recoverModelExecution?.({
      jobId: job.id, jobAttempt: job.attempt, workflowVersion: job.workflowVersion,
      stageId: input.stageId, stageAttempt: checkpoint.stageAttempt,
    }) ?? await this.options.execute({ threadId: input.threadId, profileId: input.profileId, prompt: `${input.prompt}\n\n${FORMAT_CONTRACT}`, attempt: input.attempt, allowedTools: input.allowedTools, formatRepair: false,
      jobId: job.id, jobAttempt: job.attempt, workflowVersion: job.workflowVersion, stageId: input.stageId, stageAttempt: checkpoint.stageAttempt });
    if (first.invocationId === undefined) {
      this.metrics.increment(checkpoint, "modelCalls");
      for (let index = 0; index < (first.toolCalls ?? 0); index += 1) this.metrics.increment(checkpoint, "toolCalls");
    }
    let lastTurnId = first.turnId;
    let recoveredInvocationId = first.invocationId;
    const parsed = await parseStageResultWithRepair(first.summary, async (invalid) => {
      const repair = await this.options.execute({ threadId: input.threadId, profileId: input.profileId,
        prompt: `仅修复下面输出的 JSON 格式以满足合同，不改变业务结论。tools=[]。\n\n${FORMAT_CONTRACT}\n\n无效输出：\n${invalid}`,
        attempt: input.attempt, allowedTools: [], formatRepair: true,
        jobId: job.id, jobAttempt: job.attempt, workflowVersion: job.workflowVersion, stageId: input.stageId, stageAttempt: checkpoint.stageAttempt });
      lastTurnId = repair.turnId; recoveredInvocationId = repair.invocationId; this.metrics.increment(checkpoint, "modelCalls");
      for (let index = 0; index < (repair.toolCalls ?? 0); index += 1) this.metrics.increment(checkpoint, "toolCalls");
      return repair.summary;
    });
    return { result: parsed.result, turnId: lastTurnId,
      ...(recoveredInvocationId === undefined ? {} : { invocationId: recoveredInvocationId }) };
  }

  private stage(id: string) {
    const stage = this.options.template.stages.find((item) => item.id === id);
    if (stage === undefined) throw new Error(`Workflow stage is unavailable: ${id}`);
    return stage;
  }

  private requireReturn(jobId: string, stageId: string, attempt: number) {
    const job = this.options.runtimeStore.getJob(jobId);
    const item = this.options.runtimeStore.listReturns(jobId).find((candidate) => candidate.stageId === stageId &&
      candidate.businessAttempt === attempt && candidate.jobAttempt === job?.attempt && ["ready", "delivering"].includes(candidate.status));
    if (item === undefined) throw new RuntimeFailure("return_delivery_failed", `${stageId} Return is unavailable`, true);
    return item;
  }

  private setStageFailure(checkpoint: AgentStageCheckpoint, terminal: boolean, failureCode: string): void {
    const current = this.options.runtimeStore.listStageCheckpoints(checkpoint.jobId)
      .find((item) => item.idempotencyKey === checkpoint.idempotencyKey);
    if (current === undefined || !["running", "validating"].includes(current.status)) return;
    this.options.runtimeStore.setStageStatus(checkpoint.idempotencyKey, terminal ? "failed_terminal" : "failed_retryable", failureCode);
  }

  private hasPersistedStageEvidence(jobId: string, stageId: string, jobAttempt: number, requireCompleted = false): boolean {
    const checkpoint = this.options.runtimeStore.listStageCheckpoints(jobId)
      .filter((item) => item.jobAttempt === jobAttempt && item.stageId === stageId &&
        (!requireCompleted || item.status === "completed")).at(-1);
    if (checkpoint === undefined) return false;
    return this.options.runtimeStore.listTasks(jobId).some((task) =>
      this.options.runtimeStore.listEvidence(task.id).some((item) => item.idempotencyKey === `${checkpoint.idempotencyKey}:evidence`));
  }

  private hasRecoverableModelExecution(jobId: string, stageId: string, jobAttempt: number): boolean {
    const job = this.options.runtimeStore.getJob(jobId);
    const checkpoint = this.options.runtimeStore.listStageCheckpoints(jobId)
      .filter((item) => item.jobAttempt === jobAttempt && item.stageId === stageId)
      .at(-1);
    if (job === undefined || checkpoint === undefined) return false;
    return this.options.recoverModelExecution?.({
      jobId,
      jobAttempt,
      workflowVersion: job.workflowVersion,
      stageId,
      stageAttempt: checkpoint.stageAttempt,
    }) !== undefined;
  }

  private pauseForFeedback(jobId: string, taskId: string | undefined, runId: string, message: string): void {
    if (taskId !== undefined) this.options.runtimeStore.setTaskStatus(taskId, "blocked");
    this.options.runtimeStore.setJobStatus(jobId, "reviewing");
    this.options.runStore.setStatus(runId, "resuming");
    this.options.runStore.setPresentation(runId, {
      coordinationStatus: "feedback_required", attentionLevel: "feedback", statusMessage: message,
    });
    this.markSupervisorsWaiting(jobId, runId);
    const downstreamRunIds = this.downstreamRunIds(jobId, runId);
    const blockedRuns = this.options.runStore.markUpstreamBlocked(jobId, downstreamRunIds, "上游需要补充信息，本角色尚未启动");
    this.notify(runId, ...blockedRuns.map((run) => run.id));
  }

  private failWorkflow(
    jobId: string,
    failureCode: string,
    summary: string,
    responsibleRunIds: readonly string[] = [],
    failureOrigin: AgentFailureOrigin = failureOriginForCode(failureCode),
  ): void {
    const alreadyTerminal = ["failed", "cancelled"].includes(this.options.runtimeStore.getJob(jobId)?.status ?? "");
    this.options.runtimeStore.failJob(jobId, "failed", failureCode);
    const safeError = safeFailureMessage(failureCode);
    for (const runId of responsibleRunIds) {
      const run = this.options.runStore.get(runId);
      if (run === undefined) continue;
      if (run.taskId !== undefined) this.options.runtimeStore.setTaskStatus(run.taskId, "failed");
      this.options.runStore.complete(runId, {
        runId,
        ...(run.taskId === undefined ? {} : { taskId: run.taskId }),
        status: "failed",
        summary,
        safeError,
        failureOrigin,
      });
      this.options.runStore.setPresentation(runId, {
        attentionLevel: "error", statusMessage: safeError, failureOrigin,
      });
    }
    const downstreamRunIds = responsibleRunIds.flatMap((runId) => this.downstreamRunIds(jobId, runId));
    const downstreamTaskIds = this.options.runStore.listForJob(jobId)
      .filter((run) => downstreamRunIds.includes(run.id) && run.taskId !== undefined)
      .map((run) => run.taskId!);
    this.options.runtimeStore.closeTasks(downstreamTaskIds);
    this.options.runtimeStore.closeActiveTasks(jobId, "cancelled");
    const downstream = this.options.runStore.closeAsUpstreamBlocked(jobId, downstreamRunIds, "上游阶段未完成，本角色未启动");
    const nonResponsible = this.options.runStore.closeActiveForJob(jobId, "cancelled", "责任节点失败，流程已终止");
    for (const run of nonResponsible) {
      this.options.runStore.setPresentation(run.id, {
        coordinationStatus: "skipped", attentionLevel: "neutral",
        statusMessage: "责任节点失败，流程已终止",
      });
    }
    if (!alreadyTerminal) this.options.onFailed?.(jobId);
    this.notify(...responsibleRunIds, ...downstream.map((run) => run.id), ...nonResponsible.map((run) => run.id));
  }

  private markSupervisorsWaiting(jobId: string, responsibleRunId: string): void {
    const team = this.team(jobId);
    for (const supervisor of [team.root, team.lead]) {
      if (supervisor.id === responsibleRunId) continue;
      if (["failed", "cancelled", "timed_out"].includes(supervisor.status)) continue;
      this.options.runStore.setStatus(supervisor.id, "waiting_children");
      this.options.runStore.setPresentation(supervisor.id, {
        coordinationStatus: "waiting_children", attentionLevel: "active",
        statusMessage: supervisor.id === team.root.id ? "等待负责人继续协调" : "正在监督子 Agent并等待反馈",
      });
    }
  }

  private downstreamRunIds(jobId: string, responsibleRunId: string): string[] {
    const team = this.team(jobId);
    if (responsibleRunId === team.product.id) return [team.engineering.id, team.quality.id];
    if (responsibleRunId === team.engineering.id) return [team.quality.id];
    return [];
  }

  private notify(...runIds: string[]): void { for (const runId of runIds) this.options.onRunUpdated?.(runId); }
}

function isSuccessfulStageResult(result: StageResult): boolean {
  return result.status === "completed" && result.deliverables.length > 0 &&
    result.evidence.length > 0 && result.blockers.length === 0 &&
    !["retry", "block"].includes(result.nextStageRecommendation);
}
