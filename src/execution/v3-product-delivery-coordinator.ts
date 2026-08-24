import type { AgentJob, AgentStageCheckpoint, AgentTask } from "../agents/agent-runtime.js";
import type { AgentRun } from "../agents/agent-run.js";
import { AgentRunStore } from "../agents/agent-run-store.js";
import { AgentRuntimeStore } from "../agents/agent-runtime-store.js";
import type { FixedProductStage } from "../agents/fixed-software-team-coordinator.js";
import type { RequirementDesignArtifact } from "../requirements/requirement.js";
import { RuntimeFailure } from "../observability/runtime-failure.js";
import type { StageResult } from "./stage-contract.js";
import { STAGE_RESULT_CONTRACT_VERSION } from "./stage-contract.js";
import { parseStageResult, parseStageResultWithRepair } from "./stage-result-parser.js";
import type { WorkflowTemplate } from "./workflows/workflow-template.js";

export const V3_ENGINEERING_PROFILES = [
  "frontend_engineering",
  "backend_engineering",
  "integration_quality",
] as const;
export type V3EngineeringProfile = typeof V3_ENGINEERING_PROFILES[number];
type V3Profile = "product_design" | "mock_preview" | V3EngineeringProfile |
  "quality_role" | "software_team_lead" | "orchestrator";

const FORMAT_CONTRACT = `只返回一个 JSON 对象，不要 Markdown：{"status":"completed|failed|blocked","summary":"简洁结论","deliverables":["交付物"],"evidence":["可验证证据"],"blockers":[],"nextStageRecommendation":"continue|retry|block|complete","contractVersion":"${STAGE_RESULT_CONTRACT_VERSION}"}`;

export interface V3RequirementContext {
  objective: string;
  scope: string[];
  nonGoals: string[];
  deliverables: string[];
  acceptanceCriteria: string[];
  prompt: string;
  designFeedback?: string;
  artifacts?: {
    requirementPlanPath: string;
    requirementPlanHash: string;
    designPath?: string;
    designHash?: string;
    mockPath?: string;
  };
}

export interface V3ProductDeliveryCoordinatorOptions {
  runStore: AgentRunStore;
  runtimeStore: AgentRuntimeStore;
  template: WorkflowTemplate;
  execute(input: {
    threadId: string;
    profileId: V3Profile;
    prompt: string;
    attempt: number;
    allowedTools: string[];
    formatRepair: boolean;
    jobId: string;
    jobAttempt: number;
    workflowVersion: string;
    stageId: string;
    stageAttempt: number;
    taskId: string;
    runId: string;
  }): Promise<{
    turnId: string;
    summary: string;
    toolCalls?: number;
    toolReceipts?: Array<{ name: string; ok: boolean; exitCode?: number }>;
  }>;
  requirement(jobId: string): V3RequirementContext;
  designConfirmed(jobId: string): boolean;
  writeDesignArtifact(jobId: string, productDesign: string, mockPreview: string): Promise<RequirementDesignArtifact>;
  markDesignDraft(jobId: string, artifact: RequirementDesignArtifact): void | Promise<void>;
  requestDesignRevision(jobId: string, feedback: string): void | Promise<void>;
  persist?: () => void | Promise<void>;
  onRunUpdated?: (runId: string) => void;
  onCompleted?: (jobId: string) => void;
  onFailed?: (jobId: string) => void;
}

export class V3ProductDeliveryCoordinator {
  private readonly activeJobs = new Set<string>();

  constructor(private readonly options: V3ProductDeliveryCoordinatorOptions) {}

  getStage(jobId: string): FixedProductStage {
    const job = this.options.runtimeStore.getJob(jobId);
    if (job === undefined || terminal(job.status)) return "completed";
    if (this.pendingReturn(jobId, "return_god") !== undefined) return "lead_return_ready";

    const product = this.task(jobId, "product_design");
    if (product?.status !== "completed") return "product_design_ready";
    const mock = this.task(jobId, "mock_preview");
    if (mock?.status !== "completed") return "mock_preview_ready";

    // Fail closed：即使恶意/旧快照已持久化工程 Task，设计未确认也永远不能进入工程。
    if (!this.options.designConfirmed(jobId)) return "design_confirmation";

    const engineering = V3_ENGINEERING_PROFILES.map((profile) => this.task(jobId, profile));
    if (engineering.some((task) => task === undefined || task.status !== "completed")) return "engineering_fanout";
    if (!this.stageCompleted(jobId, "integration_review")) return "engineering_fanout_ready";
    if (!this.stageCompleted(jobId, "quality_review")) return "integration_review";
    if (!this.stageCompleted(jobId, "lead_acceptance")) return "quality_review";
    if (!this.stageCompleted(jobId, "return_god")) return "lead_acceptance";
    return "lead_return_ready";
  }

  recoveryDecision(jobId: string):
    | { kind: "resume_stage"; stage: FixedProductStage }
    | { kind: "wait"; reason: "active" | "feedback" | "no_progress" }
    | { kind: "terminal"; status: "completed" | "failed" | "partial" | "cancelled" } {
    const job = this.options.runtimeStore.getJob(jobId);
    if (job === undefined) return { kind: "terminal", status: "failed" };
    if (terminal(job.status)) return { kind: "terminal", status: job.status as "completed" | "failed" | "partial" | "cancelled" };
    if (this.activeJobs.has(jobId)) return { kind: "wait", reason: "active" };
    const stage = this.getStage(jobId);
    if (stage === "design_confirmation") return { kind: "wait", reason: "feedback" };
    if (this.options.runtimeStore.listTasks(jobId).some((task) => task.jobAttempt === job.attempt && task.status === "failed")) {
      return { kind: "wait", reason: "feedback" };
    }
    return { kind: "resume_stage", stage };
  }

  canAdvanceWithoutModel(jobId: string, stage: FixedProductStage): boolean {
    if (stage === "design_confirmation") return this.options.designConfirmed(jobId);
    return stage === "lead_return_ready" || stage === "engineering_fanout_ready" && this.stageCompleted(jobId, "integration_review");
  }

  async provideFeedback(jobId: string, feedback: { turnId: string; text: string }): Promise<boolean> {
    if (this.getStage(jobId) !== "design_confirmation") return false;
    await this.options.requestDesignRevision(jobId, feedback.text);
    for (const profile of ["product_design", "mock_preview"] as const) {
      const task = this.task(jobId, profile);
      if (task !== undefined) {
        if (task.attempt >= task.maxAttempts) throw new Error("Design retry limit reached");
        this.options.runtimeStore.setTaskOwnerRun(task.id, task.ownerRunId, task.attempt + 1);
        this.options.runtimeStore.setTaskStatus(task.id, "rework");
      }
    }
    this.options.runtimeStore.setJobStatus(jobId, "reviewing");
    await this.options.persist?.();
    return true;
  }

  async requestEngineeringRework(jobId: string, taskId: string, reason: string): Promise<void> {
    const task = this.options.runtimeStore.getTask(taskId);
    const job = this.options.runtimeStore.getJob(jobId);
    if (task === undefined || job === undefined || task.jobId !== jobId || task.jobAttempt !== job.attempt ||
      !V3_ENGINEERING_PROFILES.includes(task.profileId as V3EngineeringProfile)) {
      throw new Error("Engineering Chat Task is unavailable");
    }
    if (task.attempt >= task.maxAttempts) throw new Error("Engineering Chat retry limit reached");
    if (["running", "claimed"].includes(task.status)) throw new Error("Engineering Chat is still running");
    const downstream = [
      { stageId: "integration_review", profileId: "software_team_lead" },
      { stageId: "quality_review", profileId: "quality_role" },
      { stageId: "lead_acceptance", profileId: "software_team_lead" },
      { stageId: "return_god", profileId: "orchestrator" },
    ] as const;
    const stagesToRevalidate = downstream.flatMap((item) => {
      const checkpoint = this.latestCheckpoint(jobId, item.stageId);
      return checkpoint === undefined ? [] : [{ ...item, checkpoint }];
    });
    const downstreamTasks = [...new Map(stagesToRevalidate.map((item) => {
      const downstreamTask = this.task(jobId, item.profileId);
      if (downstreamTask === undefined) throw new Error(`Downstream revalidation Task unavailable: ${item.profileId}`);
      return [downstreamTask.id, downstreamTask] as const;
    })).values()];
    for (const item of stagesToRevalidate) {
      const stage = this.stage(item.stageId);
      if (["running", "validating"].includes(item.checkpoint.status)) throw new Error(`Downstream validation is still running: ${item.stageId}`);
      if (item.checkpoint.status === "failed_terminal" || item.checkpoint.stageAttempt >= stage.retryPolicy.maxBusinessAttempts) {
        throw new Error(`Downstream revalidation retry limit reached: ${item.stageId}`);
      }
    }
    for (const downstreamTask of downstreamTasks) {
      if (downstreamTask.attempt >= downstreamTask.maxAttempts) throw new Error(`Downstream revalidation retry limit reached: ${downstreamTask.profileId}`);
    }
    this.options.runtimeStore.publishBoard({ jobId, producerRunId: job.rootRunId, taskId, attempt: task.attempt,
      kind: "decision", title: "单 Chat 返工", summary: reason.trim() || "负责人要求单 Chat 返工",
      confidence: "confirmed", visibility: "job", idempotencyKey: `${jobId}:${job.attempt}:rework:${taskId}:${task.attempt}` });
    this.options.runtimeStore.setTaskOwnerRun(task.id, task.ownerRunId, task.attempt + 1);
    this.options.runtimeStore.setTaskStatus(task.id, "rework");
    this.options.runStore.setStatus(task.ownerRunId, "resuming");
    // 返工发生在下游验收之后时，旧证据保留作审计，但必须创建新的阶段 Attempt。
    // getStage 只承认最新 checkpoint，因此不会复用返工前的联调、独立测试或最终交付。
    for (const downstreamTask of downstreamTasks) {
      this.options.runtimeStore.setTaskOwnerRun(downstreamTask.id, downstreamTask.ownerRunId, downstreamTask.attempt + 1);
      this.options.runtimeStore.setTaskStatus(downstreamTask.id, "rework");
      this.options.runStore.setStatus(downstreamTask.ownerRunId, "resuming");
    }
    for (const item of stagesToRevalidate) {
      this.options.runtimeStore.beginStage(jobId, item.stageId, this.stage(item.stageId).retryPolicy.maxBusinessAttempts, true);
    }
    this.options.runtimeStore.setJobStatus(jobId, "reviewing");
    await this.options.persist?.();
  }

  async advance(jobId: string, expectedStage: FixedProductStage): Promise<{ stage: FixedProductStage; changed: boolean }> {
    const current = this.getStage(jobId);
    if (current !== expectedStage || current === "completed" || this.activeJobs.has(jobId)) return { stage: current, changed: false };
    if (current === "design_confirmation" && !this.options.designConfirmed(jobId)) return { stage: current, changed: false };
    this.activeJobs.add(jobId);
    try {
      if (current === "product_design_ready") await this.runDesign(jobId, "product_design");
      else if (current === "mock_preview_ready") await this.runDesign(jobId, "mock_preview");
      else if (current === "engineering_fanout") await this.runEngineeringFanout(jobId);
      else if (current === "engineering_fanout_ready") await this.runReview(jobId, "integration_review", "software_team_lead");
      else if (current === "integration_review") await this.runReview(jobId, "quality_review", "quality_role");
      else if (current === "quality_review") await this.runReview(jobId, "lead_acceptance", "software_team_lead");
      else if (current === "lead_acceptance") await this.runFinalDelivery(jobId);
      else if (current === "lead_return_ready") await this.deliverGod(jobId);
      return { stage: this.getStage(jobId), changed: true };
    } finally {
      this.activeJobs.delete(jobId);
    }
  }

  private async runDesign(jobId: string, profileId: "product_design" | "mock_preview"): Promise<void> {
    const task = this.ensureTask(jobId, profileId);
    const run = this.requireRun(jobId, profileId);
    if (task.status === "rework") this.options.runStore.setStatus(run.id, "resuming");
    const currentTask = this.options.runtimeStore.getTask(task.id)!;
    const context = this.options.requirement(jobId);
    const productResult = profileId === "mock_preview" ? renderResult(this.latestResult(jobId, "product_design")) : undefined;
    const guidance = profileId === "product_design"
      ? "生成面向非技术用户的产品原稿：页面结构、用户路径、关键状态、文案和逐条验收条件。不得写工程代码。"
      : `根据下方产品原稿生成产品专属的可点击 Mock。deliverables 第一项必须严格写成 MOCK_SPEC:{...}，JSON 结构为 {"initialScreen":"home","screens":[{"id":"home","title":"页面标题","description":"页面内容与控件","states":["加载/空/错误状态"],"actions":[{"label":"按钮文字","to":"目标页面id","feedback":"点击反馈","state":"状态变化"}]}]}。至少 2 个页面，每页包含真实业务控件或动作；不得输出 HTML/脚本，不得写真实前端代码。\n\n产品原稿：\n${productResult}`;
    const result = await this.executeTask(jobId, currentTask, run, profileId,
      `${guidance}${context.designFeedback === undefined ? "" : `\n\n用户修改意见：${context.designFeedback}`}\n\n${context.prompt}`);
    if (!successful(result)) {
      this.handleBusinessFailure(jobId, currentTask, run, result, profileId);
      await this.options.persist?.();
      return;
    }
    this.completeTask(currentTask, run, result, profileId === "product_design" ? "summary" : "artifact");

    if (profileId === "mock_preview") {
      const productResult = this.latestResult(jobId, "product_design");
      const artifact = await this.options.writeDesignArtifact(jobId, renderResult(productResult), renderResult(result));
      await this.options.markDesignDraft(jobId, artifact);
      this.options.runtimeStore.setJobStatus(jobId, "reviewing");
      this.options.runStore.setPresentation(run.id, { coordinationStatus: "feedback_required", attentionLevel: "feedback", statusMessage: "原稿与 Mock 已就绪，等待用户确认设计" });
      this.notify(run.id);
    }
    await this.options.persist?.();
  }

  private async runEngineeringFanout(jobId: string): Promise<void> {
    // 第二道 Runtime 硬闸门，不能依赖 getStage 或 Prompt。
    if (!this.options.designConfirmed(jobId)) throw new RuntimeFailure("stage_contract_failed", "Design confirmation is required before engineering", false);
    const parent = this.ensureTask(jobId, "mock_preview");
    const runnable = V3_ENGINEERING_PROFILES.map((profile) => this.ensureTask(jobId, profile, parent.id))
      .filter((task) => task.status !== "completed" && task.status !== "failed");
    assertDisjointEngineeringClaims(runnable);
    if (runnable.length === 0) return;
    this.options.runtimeStore.setJobStatus(jobId, "running");
    await this.options.persist?.();

    const settled = await Promise.allSettled(runnable.map(async (task) => {
      const profileId = task.profileId as V3EngineeringProfile;
      const run = this.requireRun(jobId, profileId);
      if (task.status === "rework") this.options.runStore.setStatus(run.id, "resuming");
      const currentTask = this.options.runtimeStore.getTask(task.id)!;
      const role = profileId === "frontend_engineering" ? "前端实现" : profileId === "backend_engineering" ? "后端/API/数据实现" : "联调、测试与构建保障";
      const result = await this.executeTask(jobId, currentTask, run, profileId,
        `设计已由用户确认。只完成${role}，严格遵守 Task allowedPaths/deniedPaths；返回变更文件、验证证据、风险和 Return。\n\n${this.options.requirement(jobId).prompt}`);
      if (!successful(result)) this.handleBusinessFailure(jobId, currentTask, run, result, profileId);
      else {
        this.completeTask(currentTask, run, result, profileId === "integration_quality" ? "test" : "artifact");
        this.options.runtimeStore.publishBoard({ jobId, producerRunId: run.id, taskId: currentTask.id, attempt: currentTask.attempt,
          kind: profileId === "integration_quality" ? "test_result" : "artifact", title: `${profileId} Return`,
          summary: renderResult(result), confidence: "supported", visibility: "job",
          idempotencyKey: `${jobId}:${this.requireJob(jobId).attempt}:${profileId}:${currentTask.attempt}:board` });
      }
      await this.options.persist?.();
    }));
    const rejected = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
    if (rejected !== undefined && this.options.runtimeStore.getJob(jobId)?.status === "failed") throw rejected.reason;
    // 结构化业务失败同样可能在 execute 没有抛异常时耗尽重试并终止 Job。
    // 终态不得被下面的 reviewing 汇总状态覆盖，否则会形成无法返工的僵尸 Job。
    const currentJob = this.options.runtimeStore.getJob(jobId);
    if (currentJob === undefined || terminal(currentJob.status)) {
      await this.options.persist?.();
      return;
    }
    const failed = V3_ENGINEERING_PROFILES.map((profile) => this.task(jobId, profile)).filter((task) => task?.status !== "completed");
    this.options.runtimeStore.setJobStatus(jobId, failed.length === 0 ? "running" : "reviewing");
    await this.options.persist?.();
  }

  private async runReview(jobId: string, stageId: "integration_review" | "quality_review" | "lead_acceptance", profileId: "software_team_lead" | "quality_role"): Promise<void> {
    const task = this.ensureTask(jobId, profileId);
    const run = this.requireRun(jobId, profileId);
    const evidence = this.collectEvidence(jobId);
    const instruction = stageId === "integration_review"
      ? "作为工程负责人验收三个工程 Chat 的 Return，检查前后端接口、文件边界、风险和联调证据。"
      : stageId === "quality_review"
        ? "作为独立测试 Agent，对照已确认产品原稿和 Mock 逐条验收，不能修改业务文件。"
        : "作为工程负责人做最终验收，只有设计、前端、后端、联调和独立测试证据完整才允许 Return God。";
    const result = await this.executeTask(jobId, task, run, stageId, `${instruction}\n\n${evidence}`);
    if (!successful(result)) {
      this.handleBusinessFailure(jobId, task, run, result, stageId);
      await this.options.persist?.();
      return;
    }
    this.completeTask(task, run, result, "review", stageId);
    this.consumeReturns(jobId, stageId === "integration_review" ? [...V3_ENGINEERING_PROFILES] : stageId === "quality_review" ? ["integration_review"] : ["quality_review"]);
    await this.options.persist?.();
  }

  private async runFinalDelivery(jobId: string): Promise<void> {
    const task = this.ensureTask(jobId, "orchestrator");
    const run = this.requireRun(jobId, "orchestrator");
    const result = await this.executeTask(jobId, task, run, "return_god",
      `你是唯一最终交付者。只根据下面已验收证据向用户汇总一次：需求/设计文档路径、三个工程 Chat Return、测试结果、风险和手动验收步骤。不得重新执行或委派。\n\n${this.collectEvidence(jobId)}`);
    if (!successful(result)) {
      this.handleBusinessFailure(jobId, task, run, result, "return_god");
      await this.options.persist?.();
      return;
    }
    this.completeTask(task, run, result, "summary", "return_god");
    await this.options.persist?.();
  }

  private async deliverGod(jobId: string): Promise<void> {
    const envelope = this.pendingReturn(jobId, "return_god");
    if (envelope === undefined) throw new RuntimeFailure("return_delivery_failed", "God Return is unavailable", true);
    const claimed = envelope.status === "ready" ? this.options.runtimeStore.claimReturn(envelope.id) : envelope;
    if (claimed === undefined) throw new RuntimeFailure("return_delivery_failed", "God Return cannot be claimed", true);
    this.options.runtimeStore.consumeReturn(claimed.id);
    const { root, lead } = this.team(jobId);
    this.options.runtimeStore.setJobStatus(jobId, "completed");
    this.options.runStore.complete(lead.id, { runId: lead.id, status: "completed", summary: "团队结果已验收并 Return God" });
    this.options.runStore.complete(root.id, { runId: root.id, status: "completed", summary: parseStageResult(claimed.result.summary).summary });
    this.options.onCompleted?.(jobId);
    this.notify(root.id, lead.id);
    await this.options.persist?.();
  }

  private async executeTask(jobId: string, task: AgentTask, run: AgentRun, stageId: string, prompt: string): Promise<StageResult> {
    const job = this.requireJob(jobId);
    const stage = this.stage(stageId);
    const checkpoint = this.options.runtimeStore.beginStage(jobId, stageId, stage.retryPolicy.maxBusinessAttempts, task.attempt > 1);
    const evidenceKey = `${checkpoint.idempotencyKey}:evidence`;
    const existing = this.options.runtimeStore.listEvidence(task.id).find((item) => item.idempotencyKey === evidenceKey);
    if (checkpoint.status === "completed" && existing !== undefined) return parseStageResult(existing.summary);
    this.options.runtimeStore.setTaskStatus(task.id, "running");
    this.options.runStore.setStatus(run.id, "running");
    this.options.runStore.setPresentation(run.id, { attentionLevel: "active", statusMessage: "正在执行已分派任务" });
    this.notify(run.id);
    await this.options.persist?.();
    try {
      const first = await this.options.execute({ threadId: run.threadId, profileId: profileForStage(stageId), prompt: `${prompt}\n\n${FORMAT_CONTRACT}`,
        attempt: checkpoint.stageAttempt, allowedTools: stage.allowedTools, formatRepair: false, jobId, jobAttempt: job.attempt,
        workflowVersion: job.workflowVersion, stageId, stageAttempt: checkpoint.stageAttempt, taskId: task.id, runId: run.id });
      const parsed = await parseStageResultWithRepair(first.summary, async (invalid) => {
        const repair = await this.options.execute({ threadId: run.threadId, profileId: profileForStage(stageId),
          prompt: `只修复 JSON 格式，不改变业务结论。tools=[]。\n\n${FORMAT_CONTRACT}\n\n${invalid}`,
          attempt: checkpoint.stageAttempt, allowedTools: [], formatRepair: true, jobId, jobAttempt: job.attempt,
          workflowVersion: job.workflowVersion, stageId, stageAttempt: checkpoint.stageAttempt, taskId: task.id, runId: run.id });
        return repair.summary;
      });
      assertRuntimeEvidence(stageId, parsed.result, first.toolReceipts);
      this.options.runStore.rebindAttempt(run.id, first.turnId, task.attempt);
      return parsed.result;
    } catch (error) {
      const current = this.latestCheckpoint(jobId, stageId);
      const retryable = task.attempt < task.maxAttempts;
      if (current !== undefined && ["running", "validating"].includes(current.status)) {
        this.options.runtimeStore.setStageStatus(current.idempotencyKey, retryable ? "failed_retryable" : "failed_terminal", "stage_execution_failed");
      }
      if (retryable) {
        this.options.runtimeStore.setTaskOwnerRun(task.id, run.id, task.attempt + 1);
        this.options.runtimeStore.setTaskStatus(task.id, "rework");
        this.options.runStore.setStatus(run.id, "resuming");
        this.options.runtimeStore.setJobStatus(jobId, "reviewing");
      } else {
        this.options.runtimeStore.setTaskStatus(task.id, "failed");
        this.options.runtimeStore.failJob(jobId, "failed", "stage_retry_exhausted");
        this.options.onFailed?.(jobId);
      }
      await this.options.persist?.();
      throw error;
    }
  }

  private completeTask(task: AgentTask, run: AgentRun, result: StageResult, kind: "summary" | "artifact" | "test" | "review", stageId = task.profileId): void {
    const job = this.requireJob(task.jobId);
    const checkpoint = this.latestCheckpoint(task.jobId, stageId);
    if (checkpoint === undefined) throw new Error(`Checkpoint unavailable: ${stageId}`);
    if (checkpoint.status === "running") this.options.runtimeStore.setStageStatus(checkpoint.idempotencyKey, "validating");
    const evidence = this.options.runtimeStore.addEvidence({ jobId: task.jobId, taskId: task.id, runId: run.id, kind,
      summary: JSON.stringify(result), producer: kind === "review" || kind === "test" ? "reviewer" : "worker",
      verdict: kind === "review" || kind === "test" ? "passed" : "supported", idempotencyKey: `${checkpoint.idempotencyKey}:evidence`,
      jobAttempt: job.attempt, workflowVersion: job.workflowVersion, stageId, stageAttempt: checkpoint.stageAttempt });
    this.options.runtimeStore.setTaskStatus(task.id, "completed");
    this.options.runStore.complete(run.id, { runId: run.id, taskId: task.id, status: "completed", summary: result.summary, evidenceIds: [evidence.id] });
    this.options.runtimeStore.createReturn({ jobId: task.jobId, rootRunId: job.rootRunId, parentRunId: this.team(task.jobId).lead.id,
      childRunId: run.id, taskId: task.id, sequence: sequenceFor(stageId), result: { status: "completed", summary: JSON.stringify(result), evidenceIds: [evidence.id], boardEntryIds: [] },
      idempotencyKey: checkpoint.idempotencyKey, jobAttempt: job.attempt, workflowVersion: job.workflowVersion, stageId,
      stageAttempt: checkpoint.stageAttempt, businessAttempt: task.attempt });
    const current = this.latestCheckpoint(task.jobId, stageId);
    if (current?.status === "validating") this.options.runtimeStore.setStageStatus(current.idempotencyKey, "completed");
    this.options.runStore.setPresentation(run.id, { attentionLevel: "success", statusMessage: "阶段结果已 Return，等待验收" });
    this.notify(run.id);
  }

  private handleBusinessFailure(jobId: string, task: AgentTask, run: AgentRun, result: StageResult, stageId: string): void {
    const checkpoint = this.latestCheckpoint(jobId, stageId);
    if (checkpoint?.status === "running") this.options.runtimeStore.setStageStatus(checkpoint.idempotencyKey, "validating");
    if (task.attempt < task.maxAttempts) {
      this.options.runtimeStore.setTaskOwnerRun(task.id, run.id, task.attempt + 1);
      this.options.runtimeStore.setTaskStatus(task.id, result.status === "blocked" ? "blocked" : "rework");
      this.options.runStore.setStatus(run.id, "resuming");
      this.options.runtimeStore.setJobStatus(jobId, "reviewing");
    } else {
      this.options.runtimeStore.setTaskStatus(task.id, "failed");
      this.options.runtimeStore.failJob(jobId, "failed", "stage_retry_exhausted");
      this.options.onFailed?.(jobId);
    }
    if (checkpoint?.status === "validating") this.options.runtimeStore.setStageStatus(checkpoint.idempotencyKey,
      task.attempt < task.maxAttempts ? "failed_retryable" : "failed_terminal", "stage_contract_failed");
    this.options.runStore.setPresentation(run.id, { coordinationStatus: result.status === "blocked" ? "feedback_required" : "rework_required", attentionLevel: "feedback", statusMessage: result.summary });
    this.notify(run.id);
  }

  private ensureTask(jobId: string, profileId: V3Profile, parentTaskId?: string): AgentTask {
    const existing = this.task(jobId, profileId);
    if (existing !== undefined) return existing;
    const context = this.options.requirement(jobId);
    const owner = this.requireRun(jobId, profileId);
    const boundaries = taskBoundaries(profileId, context.scope);
    const task = this.options.runtimeStore.createTask({ jobId, rootRunId: this.requireJob(jobId).rootRunId, ownerRunId: owner.id, profileId,
      ...(parentTaskId === undefined ? {} : { parentTaskId }), title: `${profileId}:${context.objective}`, objective: context.objective,
      scope: { allowedPaths: boundaries.allow, deniedPaths: boundaries.deny, nonGoals: [...context.nonGoals] },
      requiredOutputs: [...context.deliverables], acceptanceCriteria: [...context.acceptanceCriteria], fileClaims: boundaries.claims,
      maxAttempts: 2, status: "ready" });
    this.options.runStore.setTaskId(owner.id, task.id);
    return task;
  }

  private task(jobId: string, profileId: string): AgentTask | undefined {
    const job = this.options.runtimeStore.getJob(jobId);
    return this.options.runtimeStore.listTasks(jobId).find((task) => task.jobAttempt === job?.attempt && task.profileId === profileId);
  }

  private team(jobId: string): { job: AgentJob; root: AgentRun; lead: AgentRun } {
    const job = this.requireJob(jobId);
    const runs = this.options.runStore.listForJob(jobId);
    const root = runs.find((run) => run.id === job.rootRunId);
    const lead = runs.find((run) => run.agentProfileId === "software_team_lead");
    if (root === undefined || lead === undefined) throw new Error("V3 team structure is incomplete");
    return { job, root, lead };
  }

  private requireRun(jobId: string, profileId: V3Profile): AgentRun {
    const { root } = this.team(jobId);
    if (profileId === "orchestrator") return root;
    const run = this.options.runStore.listForJob(jobId).find((item) => item.agentProfileId === profileId);
    if (run === undefined) throw new Error(`V3 Agent Run unavailable: ${profileId}`);
    return run;
  }

  private requireJob(jobId: string): AgentJob {
    const job = this.options.runtimeStore.getJob(jobId);
    if (job === undefined || job.workflowVersion !== "software_product_delivery_v3") throw new Error(`V3 Job unavailable: ${jobId}`);
    return job;
  }

  private stage(stageId: string) {
    const stage = this.options.template.stages.find((item) => item.id === stageId);
    if (stage === undefined) throw new Error(`V3 stage unavailable: ${stageId}`);
    return stage;
  }

  private latestCheckpoint(jobId: string, stageId: string): AgentStageCheckpoint | undefined {
    const job = this.requireJob(jobId);
    return this.options.runtimeStore.listStageCheckpoints(jobId).filter((item) => item.jobAttempt === job.attempt && item.stageId === stageId).at(-1);
  }

  private stageCompleted(jobId: string, stageId: string): boolean {
    return this.latestCheckpoint(jobId, stageId)?.status === "completed";
  }

  private latestResult(jobId: string, profileId: string): StageResult {
    const task = this.task(jobId, profileId);
    const evidence = task === undefined ? undefined : this.options.runtimeStore.listEvidence(task.id).at(-1);
    if (evidence === undefined) throw new Error(`V3 evidence unavailable: ${profileId}`);
    return parseStageResult(evidence.summary);
  }

  private collectEvidence(jobId: string): string {
    const artifacts = this.options.requirement(jobId).artifacts;
    const sections: string[] = artifacts === undefined ? [] : [
      [
        "## Runtime 冻结文档（真实路径与哈希）",
        `- 需求方案：${artifacts.requirementPlanPath}`,
        `- 需求方案 hash：${artifacts.requirementPlanHash}`,
        ...(artifacts.designPath === undefined ? [] : [`- 产品原稿：${artifacts.designPath}`]),
        ...(artifacts.designHash === undefined ? [] : [`- 产品原稿 hash：${artifacts.designHash}`]),
        ...(artifacts.mockPath === undefined ? [] : [`- 交互 Mock：${artifacts.mockPath}`]),
      ].join("\n"),
    ];
    for (const task of this.options.runtimeStore.listTasks(jobId)) {
      const evidence = this.options.runtimeStore.listEvidence(task.id).at(-1);
      if (evidence !== undefined) sections.push(`## ${task.profileId}\n${renderResult(parseStageResult(evidence.summary))}`);
    }
    return sections.join("\n\n");
  }

  private pendingReturn(jobId: string, stageId: string) {
    const job = this.options.runtimeStore.getJob(jobId);
    return this.options.runtimeStore.listReturns(jobId).find((item) => item.jobAttempt === job?.attempt && item.stageId === stageId && ["ready", "delivering"].includes(item.status));
  }

  private consumeReturns(jobId: string, stageIds: readonly string[]): void {
    const job = this.requireJob(jobId);
    for (const item of this.options.runtimeStore.listReturns(jobId)) {
      if (item.jobAttempt !== job.attempt || item.stageId === undefined || !stageIds.includes(item.stageId) || !["ready", "delivering"].includes(item.status)) continue;
      const claimed = item.status === "ready" ? this.options.runtimeStore.claimReturn(item.id) : item;
      if (claimed !== undefined) this.options.runtimeStore.consumeReturn(claimed.id);
    }
  }

  private notify(...runIds: string[]): void {
    for (const runId of runIds) this.options.onRunUpdated?.(runId);
  }
}

export function taskBoundaries(profileId: V3Profile, requirementScope: readonly string[]): { allow: string[]; deny: string[]; claims: string[] } {
  if (profileId === "product_design" || profileId === "mock_preview" || profileId === "software_team_lead" || profileId === "orchestrator") {
    return { allow: [], deny: ["*"], claims: [] };
  }
  const selected = (tokens: RegExp, fallback: string[]) => {
    const matches = requirementScope.filter((path) => tokens.test(path.replace(/\\/g, "/")));
    return matches.length === 0 ? fallback : matches;
  };
  if (profileId === "frontend_engineering") {
    const allow = selected(/(^|\/)(front(end)?|web|ui|renderer|electron)(\/|$)|\.(tsx?|jsx?|css|scss|html)$/i,
      ["frontend", "src/frontend", "src/electron"]);
    return { allow, deny: [".env", ".git", "backend", "src/backend", "src/api", "server"], claims: allow };
  }
  if (profileId === "backend_engineering") {
    const allow = selected(/(^|\/)(back(end)?|app-server|server|api|database|db)(\/|$)/i,
      ["backend", "server", "src/backend", "src/api", "src/app-server"]);
    return { allow, deny: [".env", ".git", "frontend", "src/frontend", "src/electron"], claims: allow };
  }
  const allow = selected(/(^|\/)(tests?|e2e|integration|evidence)(\/|$)/i, ["tests", "e2e", "docs/evidence"]);
  return { allow, deny: [".env", ".git", "frontend", "backend", "src/frontend", "src/backend", "src/electron", "src/app-server"], claims: allow };
}

export function assertDisjointEngineeringClaims(tasks: readonly AgentTask[]): void {
  const claims = tasks.flatMap((task) => task.fileClaims.map((claim) => ({ task, claim: normalizeClaim(claim) })));
  for (let left = 0; left < claims.length; left += 1) {
    for (let right = left + 1; right < claims.length; right += 1) {
      const a = claims[left]!; const b = claims[right]!;
      if (a.task.id !== b.task.id && claimsOverlap(a.claim, b.claim)) throw new Error(`Engineering Chat file claims overlap: ${a.task.profileId} <-> ${b.task.profileId}`);
    }
  }
}

function successful(result: StageResult): boolean {
  return result.status === "completed" && result.deliverables.length > 0 && result.evidence.length > 0 && result.blockers.length === 0 && !["retry", "block"].includes(result.nextStageRecommendation);
}

function assertRuntimeEvidence(
  stageId: string,
  result: StageResult,
  receipts: readonly { name: string; ok: boolean; exitCode?: number }[] | undefined,
): void {
  if (!successful(result)) return;
  if (stageId === "frontend_engineering" || stageId === "backend_engineering") {
    if (!receipts?.some((receipt) => receipt.name === "write_file" && receipt.ok)) {
      throw new RuntimeFailure("stage_contract_failed", `${stageId} requires a successful write_file receipt`, true);
    }
  }
  if (stageId === "integration_quality" || stageId === "quality_review") {
    if (!receipts?.some((receipt) => receipt.name === "run_command" && receipt.ok && receipt.exitCode === 0)) {
      throw new RuntimeFailure("stage_contract_failed", `${stageId} requires a successful run_command receipt`, true);
    }
  }
}

function renderResult(result: StageResult): string {
  return [result.summary, ...result.deliverables.map((item) => `- 交付：${item}`), ...result.evidence.map((item) => `- 证据：${item}`), ...result.blockers.map((item) => `- 阻塞：${item}`)].join("\n");
}

function terminal(status: AgentJob["status"]): boolean {
  return ["completed", "failed", "partial", "cancelled"].includes(status);
}

function profileForStage(stageId: string): V3Profile {
  if (stageId === "integration_review" || stageId === "lead_acceptance") return "software_team_lead";
  if (stageId === "quality_review") return "quality_role";
  if (stageId === "return_god") return "orchestrator";
  return stageId as V3Profile;
}

function sequenceFor(stageId: string): number {
  return stageId === "product_design" ? 1 : stageId === "mock_preview" ? 2 :
    stageId === "frontend_engineering" ? 10 : stageId === "backend_engineering" ? 11 :
      stageId === "integration_quality" ? 12 : stageId === "integration_review" ? 20 :
        stageId === "quality_review" ? 21 : stageId === "lead_acceptance" ? 22 : 30;
}

function normalizeClaim(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/\*\*$/, "").replace(/^\.\//, "").replace(/\/$/, "");
}

function claimsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}
