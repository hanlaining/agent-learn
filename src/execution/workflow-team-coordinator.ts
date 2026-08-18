import type { AgentRunResult } from "../agents/agent-run.js";
import { AgentRunStore } from "../agents/agent-run-store.js";
import { AgentRuntimeStore } from "../agents/agent-runtime-store.js";
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
  }): Promise<WorkflowTeamExecution>;
  requirement(jobId: string): WorkflowRequirementContext;
  modelInfo?(profileId: TeamProfile): { model: string; reasoningEffort?: string };
  persist?: () => void | Promise<void>;
  onRunUpdated?: (runId: string) => void;
  onCompleted?: (jobId: string) => void;
}

const FORMAT_CONTRACT = `只返回一个 JSON 对象，不要 Markdown：{"status":"completed|failed|blocked","summary":"简洁结论","deliverables":["交付物"],"evidence":["可验证证据"],"blockers":[],"nextStageRecommendation":"continue|retry|block|complete","contractVersion":"${STAGE_RESULT_CONTRACT_VERSION}"}`;

export class WorkflowTeamCoordinator {
  private readonly activeJobs = new Set<string>();
  private readonly metrics: RuntimeMetricsLedger;

  constructor(private readonly options: WorkflowTeamCoordinatorOptions) {
    this.metrics = options.metrics ?? new RuntimeMetricsLedger();
  }

  recoverPersistedCheckpoints(): number {
    let recovered = 0;
    for (const job of this.options.runtimeStore.listJobs()) {
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
    if (job?.status === "completed") return "completed";
    const returns = this.options.runtimeStore.listReturns(jobId);
    const leadReturn = returns.find((item) => item.stageId === "lead");
    if (leadReturn?.status === "consumed") return "completed";
    if (leadReturn !== undefined) return "lead_return_ready";
    const qualityReturn = returns.find((item) => item.stageId === "quality" && item.jobAttempt === job?.attempt);
    if (qualityReturn !== undefined) return "quality_return_ready";
    const qualityTask = this.taskFor(jobId, "quality_role");
    if (qualityTask !== undefined) return "quality_ready";
    const engineeringReturn = returns.find((item) => item.stageId === "engineering" && item.jobAttempt === job?.attempt);
    if (engineeringReturn !== undefined) return "engineering_return_ready";
    const productTask = this.taskFor(jobId, "product_role");
    if (productTask?.status === "completed") return "engineering_ready";
    if (productTask?.status === "rework") return "rework";
    const productReturns = returns.filter((item) => item.stageId === "product" && item.jobAttempt === job?.attempt);
    if (productReturns.some((item) => item.businessAttempt === 2)) return "second_return_ready";
    if (productReturns.length > 0) return "first_return_ready";
    return "ready_first_return";
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
      this.options.runtimeStore.setJobStatus(jobId, "running");
    } else if (attempt < 2) {
      this.options.runtimeStore.setTaskStatus(task.id, "rework"); this.options.runStore.setStatus(team.product.id, "resuming");
      this.options.runtimeStore.setJobStatus(jobId, "reviewing");
    } else {
      this.options.runtimeStore.setTaskStatus(task.id, "failed"); this.options.runtimeStore.failJob(jobId, "failed", "stage_retry_exhausted");
      this.options.runStore.closeActiveForJob(jobId, "failed", "Product stage retry exhausted");
      this.options.runtimeStore.closeActiveTasks(jobId, "failed");
    }
    void review; await this.options.persist?.();
  }

  private async runEngineering(jobId: string): Promise<void> {
    const team = this.team(jobId); const parent = this.ensureTask(jobId, "product_role");
    const task = this.ensureTask(jobId, "engineering_role", parent.id);
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
    if (result.status !== "completed" || result.evidence.length === 0 || result.blockers.length > 0) {
      this.options.runtimeStore.retryReturn(envelope.id, 0);
      throw new RuntimeFailure("stage_contract_failed", "Engineering business acceptance failed", true);
    }
    this.options.runtimeStore.consumeReturn(envelope.id);
    this.options.runtimeStore.setTaskStatus(task.id, "completed");
    this.options.runtimeStore.addEvidence({ jobId, taskId: task.id, runId: team.lead.id, kind: "review", summary: "Engineering contract accepted; independent quality follows", producer: "runtime", verdict: "passed",
      idempotencyKey: `${envelope.idempotencyKey}:review`, jobAttempt: team.job.attempt, workflowVersion: team.job.workflowVersion, stageId: "engineering", stageAttempt: task.attempt });
    this.ensureTask(jobId, "quality_role", task.id); this.options.runtimeStore.setJobStatus(jobId, "running"); await this.options.persist?.();
  }

  private async runQuality(jobId: string): Promise<void> {
    const team = this.team(jobId); const engineering = this.ensureTask(jobId, "engineering_role");
    const task = this.ensureTask(jobId, "quality_role", engineering.id);
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
    const result = parseStageResult(claimed.result.summary);
    if (result.status !== "completed" || result.evidence.length === 0 || result.blockers.length > 0) {
      this.options.runtimeStore.retryReturn(envelope.id, 0);
      throw new RuntimeFailure("stage_contract_failed", "Quality acceptance failed", true);
    }
    this.options.runtimeStore.consumeReturn(envelope.id); this.options.runtimeStore.setTaskStatus(task.id, "completed");
    const stage = this.options.runtimeStore.beginStage(jobId, "lead", 2); const stageTemplate = this.stage("lead");
    const leadResult = await this.executeStructured({ jobId, checkpointKey: stage.idempotencyKey, stageId: "lead", profileId: "software_team_lead", threadId: team.lead.threadId,
      attempt: stage.stageAttempt, allowedTools: stageTemplate.allowedTools,
      prompt: `只汇总已有 Product、Engineering、Quality 合法证据一次，不重新读取文件或执行 Worker 工作。\n\nQuality Return:\n${claimed.result.summary}` });
    this.options.runtimeStore.setStageStatus(stage.idempotencyKey, "validating");
    const review = this.options.runtimeStore.addEvidence({ jobId, taskId: task.id, runId: team.lead.id, kind: "review", summary: leadResult.result.summary, producer: "reviewer", verdict: "passed",
      idempotencyKey: `${stage.idempotencyKey}:evidence`, jobAttempt: team.job.attempt, workflowVersion: team.job.workflowVersion, stageId: "lead", stageAttempt: stage.stageAttempt });
    this.options.runtimeStore.createReturn({ jobId, rootRunId: team.root.rootRunId, parentRunId: team.root.id, childRunId: team.lead.id, taskId: task.id, sequence: 4,
      result: { status: "completed", summary: JSON.stringify(leadResult.result), evidenceIds: [...claimed.result.evidenceIds, review.id], boardEntryIds: [] },
      idempotencyKey: stage.idempotencyKey, jobAttempt: team.job.attempt, workflowVersion: team.job.workflowVersion, stageId: "lead", stageAttempt: stage.stageAttempt });
    this.options.runtimeStore.setStageStatus(stage.idempotencyKey, "completed"); this.options.runtimeStore.setJobStatus(jobId, "waiting_returns"); await this.options.persist?.();
  }

  private async deliver(jobId: string): Promise<void> {
    const team = this.team(jobId); const task = this.ensureTask(jobId, "quality_role");
    const envelope = this.options.runtimeStore.listReturns(jobId).find((item) => item.stageId === "lead");
    if (envelope === undefined) throw new RuntimeFailure("return_delivery_failed", "Lead Return is unavailable", true);
    const claimed = this.options.runtimeStore.claimReturn(envelope.id);
    if (claimed === undefined) throw new RuntimeFailure("return_delivery_failed", "Lead Return cannot be claimed", true);
    const stage = this.options.runtimeStore.beginStage(jobId, "return_god", 2);
    try {
      const deliveryModel = this.options.modelInfo?.("orchestrator");
      this.metrics.start({ jobId: team.job.id, jobAttempt: team.job.attempt, workflowVersion: team.job.workflowVersion,
        stageId: "return_god", stageAttempt: stage.stageAttempt, ...(deliveryModel === undefined ? {} : deliveryModel) });
      const execution = await this.options.execute({ threadId: team.job.threadId, profileId: "orchestrator", attempt: stage.stageAttempt, allowedTools: [], formatRepair: false,
        prompt: `团队工作已经完成。只根据负责人 Return 向用户交付一次最终结果；不要重复读取文件、执行任务或再次委派。\n\n${claimed.result.summary}` });
      this.metrics.increment(stage, "modelCalls");
      for (let index = 0; index < (execution.toolCalls ?? 0); index += 1) this.metrics.increment(stage, "toolCalls");
      this.options.runtimeStore.setStageStatus(stage.idempotencyKey, "validating");
      this.options.runtimeStore.consumeReturn(envelope.id);
      const result: AgentRunResult = { runId: team.lead.id, taskId: task.id, status: "completed", summary: claimed.result.summary };
      this.options.runStore.complete(team.lead.id, result);
      this.options.runStore.complete(team.root.id, { ...result, runId: team.root.id, summary: execution.summary });
      this.options.runtimeStore.setStageStatus(stage.idempotencyKey, "completed"); this.options.runtimeStore.setJobStatus(jobId, "completed");
      this.metrics.finish(stage, { terminalStates: { job: "completed", requirement: "completed", task: "completed", agentRun: "completed", return: "consumed" } });
      this.options.onCompleted?.(jobId); this.notify(team.root.id, team.lead.id); await this.options.persist?.();
    } catch (error) {
      this.options.runtimeStore.retryReturn(envelope.id, 0);
      this.options.runtimeStore.setStageStatus(stage.idempotencyKey, stage.stageAttempt >= 2 ? "failed_terminal" : "failed_retryable", classifyRuntimeFailure(error));
      this.metrics.finish(stage, { primaryFailureCode: classifyRuntimeFailure(error) }); await this.options.persist?.(); throw error;
    }
  }

  private async runWorkerStage(input: { jobId: string; stageId: "product" | "engineering" | "quality"; profileId: TeamProfile; runId: string; threadId: string; taskId: string; parentRunId: string; attempt: number; kind: "summary" | "artifact" | "test"; producer: "worker" | "reviewer"; prompt: string }): Promise<void> {
    const team = this.team(input.jobId); const template = this.stage(input.stageId);
    const checkpoint = this.options.runtimeStore.beginStage(input.jobId, input.stageId, template.retryPolicy.maxBusinessAttempts, input.attempt > 1);
    const evidenceKey = `${checkpoint.idempotencyKey}:evidence`;
    const existingEvidence = this.options.runtimeStore.listEvidence(input.taskId).find((item) => item.idempotencyKey === evidenceKey);
    try {
      this.options.runtimeStore.setTaskStatus(input.taskId, "running"); this.options.runStore.setStatus(input.runId, "running"); await this.options.persist?.();
      let result: StageResult; let turnId: string;
      if (existingEvidence !== undefined) {
        result = parseStageResult(existingEvidence.summary); turnId = this.options.runStore.get(input.runId)?.turnId ?? input.threadId;
      } else {
        const execution = await this.executeStructured({ jobId: input.jobId, checkpointKey: checkpoint.idempotencyKey, stageId: input.stageId, profileId: input.profileId,
          threadId: input.threadId, attempt: checkpoint.stageAttempt, allowedTools: template.allowedTools, prompt: input.prompt });
        result = execution.result; turnId = execution.turnId;
      }
      this.options.runtimeStore.setStageStatus(checkpoint.idempotencyKey, "validating");
      this.options.runStore.rebindAttempt(input.runId, turnId, input.attempt);
      const evidence = this.options.runtimeStore.addEvidence({ jobId: input.jobId, taskId: input.taskId, runId: input.runId, kind: input.kind,
        summary: JSON.stringify(result), producer: input.producer, verdict: result.status === "completed" ? "supported" : "failed",
        idempotencyKey: evidenceKey, jobAttempt: team.job.attempt, workflowVersion: team.job.workflowVersion, stageId: input.stageId, stageAttempt: checkpoint.stageAttempt });
      this.options.runStore.complete(input.runId, { runId: input.runId, taskId: input.taskId, status: result.status === "completed" ? "completed" : "failed", summary: result.summary });
      this.options.runtimeStore.createReturn({ jobId: input.jobId, rootRunId: team.root.rootRunId, parentRunId: input.parentRunId, childRunId: input.runId, taskId: input.taskId,
        sequence: input.stageId === "product" ? input.attempt : input.stageId === "engineering" ? 2 : 3,
        result: { status: result.status === "completed" ? "completed" : "failed", summary: JSON.stringify(result), evidenceIds: [evidence.id], boardEntryIds: [] },
        idempotencyKey: checkpoint.idempotencyKey, jobAttempt: team.job.attempt, workflowVersion: team.job.workflowVersion, stageId: input.stageId,
        stageAttempt: checkpoint.stageAttempt, businessAttempt: input.attempt });
      this.options.runtimeStore.setStageStatus(checkpoint.idempotencyKey, "completed"); this.options.runtimeStore.setJobStatus(input.jobId, "waiting_returns");
      this.metrics.finish(checkpoint); this.notify(input.runId); await this.options.persist?.();
    } catch (error) {
      const code = classifyRuntimeFailure(error); const terminal = checkpoint.stageAttempt >= template.retryPolicy.maxBusinessAttempts;
      this.options.runtimeStore.setStageStatus(checkpoint.idempotencyKey, terminal ? "failed_terminal" : "failed_retryable", code);
      this.metrics.finish(checkpoint, { primaryFailureCode: code });
      if (terminal) {
        this.options.runtimeStore.setTaskStatus(input.taskId, "failed"); this.options.runtimeStore.failJob(input.jobId, "failed", code);
        this.options.runStore.closeActiveForJob(input.jobId, "failed", `Stage failed: ${code}`); this.options.runtimeStore.closeActiveTasks(input.jobId, "failed");
      } else {
        this.options.runtimeStore.setTaskStatus(input.taskId, "ready"); this.options.runStore.setStatus(input.runId, "resuming");
      }
      await this.options.persist?.(); throw error;
    }
  }

  private async executeStructured(input: { jobId: string; checkpointKey: string; stageId: string; profileId: TeamProfile; threadId: string; prompt: string; attempt: number; allowedTools: string[] }): Promise<{ result: StageResult; turnId: string }> {
    const job = this.options.runtimeStore.getJob(input.jobId)!;
    const checkpoint = this.options.runtimeStore.listStageCheckpoints(input.jobId).find((item) => item.idempotencyKey === input.checkpointKey)!;
    const modelInfo = this.options.modelInfo?.(input.profileId);
    this.metrics.start({ jobId: job.id, jobAttempt: job.attempt, workflowVersion: job.workflowVersion,
      stageId: input.stageId, stageAttempt: checkpoint.stageAttempt, ...(modelInfo === undefined ? {} : modelInfo) });
    const first = await this.options.execute({ threadId: input.threadId, profileId: input.profileId, prompt: `${input.prompt}\n\n${FORMAT_CONTRACT}`, attempt: input.attempt, allowedTools: input.allowedTools, formatRepair: false });
    this.metrics.increment(checkpoint, "modelCalls");
    for (let index = 0; index < (first.toolCalls ?? 0); index += 1) this.metrics.increment(checkpoint, "toolCalls");
    let lastTurnId = first.turnId;
    const parsed = await parseStageResultWithRepair(first.summary, async (invalid) => {
      const repair = await this.options.execute({ threadId: input.threadId, profileId: input.profileId,
        prompt: `仅修复下面输出的 JSON 格式以满足合同，不改变业务结论。tools=[]。\n\n${FORMAT_CONTRACT}\n\n无效输出：\n${invalid}`,
        attempt: input.attempt, allowedTools: [], formatRepair: true });
      lastTurnId = repair.turnId; this.metrics.increment(checkpoint, "modelCalls");
      for (let index = 0; index < (repair.toolCalls ?? 0); index += 1) this.metrics.increment(checkpoint, "toolCalls");
      return repair.summary;
    });
    return { result: parsed.result, turnId: lastTurnId };
  }

  private stage(id: string) {
    const stage = this.options.template.stages.find((item) => item.id === id);
    if (stage === undefined) throw new Error(`Workflow stage is unavailable: ${id}`);
    return stage;
  }

  private requireReturn(jobId: string, stageId: string, attempt: number) {
    const item = this.options.runtimeStore.listReturns(jobId).find((candidate) => candidate.stageId === stageId && candidate.businessAttempt === attempt);
    if (item === undefined) throw new RuntimeFailure("return_delivery_failed", `${stageId} Return is unavailable`, true);
    return item;
  }

  private notify(...runIds: string[]): void { for (const runId of runIds) this.options.onRunUpdated?.(runId); }
}
