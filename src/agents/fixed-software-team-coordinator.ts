import type { AgentRunResult } from "./agent-run.js";
import { AgentRunStore } from "./agent-run-store.js";
import { AgentRuntimeStore } from "./agent-runtime-store.js";

export const FIXED_PRODUCT_STAGES = [
  "ready_first_return", "first_return_ready", "rework",
  "second_return_ready", "lead_return_ready", "completed",
] as const;
export type FixedProductStage = typeof FIXED_PRODUCT_STAGES[number];

export interface FixedTeamExecution {
  turnId: string;
  summary: string;
}

export interface FixedSoftwareTeamCoordinatorOptions {
  runStore: AgentRunStore;
  runtimeStore: AgentRuntimeStore;
  execute(input: {
    threadId: string;
    profileId: "product_role" | "software_team_lead" | "orchestrator";
    prompt: string;
    attempt: number;
  }): Promise<FixedTeamExecution>;
  persist?: () => void | Promise<void>;
  onRunUpdated?: (runId: string) => void;
  onCompleted?: (jobId: string) => void;
}

export class FixedSoftwareTeamCoordinator {
  private readonly activeJobs = new Set<string>();

  constructor(private readonly options: FixedSoftwareTeamCoordinatorOptions) {}

  recoverPersistedCheckpoints(): number {
    let recovered = 0;
    for (const job of this.options.runtimeStore.listJobs()) {
      const runs = this.options.runStore.listForJob(job.id);
      if (!runs.some((run) => run.agentProfileId === "software_team_lead") ||
        !runs.some((run) => run.agentProfileId === "product_role")) continue;
      const { root, lead, product } = this.team(job.id); const stage = this.getStage(job.id);
      if (stage === "rework") {
        this.options.runStore.setStatus(root.id, "waiting_children");
        this.options.runStore.setStatus(lead.id, "waiting_children");
        this.options.runStore.setStatus(product.id, "resuming"); recovered += 1;
      } else if (stage === "first_return_ready") {
        this.options.runStore.setStatus(root.id, "waiting_children");
        this.options.runStore.setStatus(lead.id, "waiting_children"); recovered += 1;
      } else if (stage === "second_return_ready") {
        this.options.runStore.setStatus(root.id, "waiting_children");
        this.options.runStore.setStatus(lead.id, "resuming"); recovered += 1;
      } else if (stage === "lead_return_ready") {
        this.options.runStore.setStatus(root.id, "resuming");
        this.options.runStore.setStatus(lead.id, "resuming"); recovered += 1;
      }
    }
    return recovered;
  }

  getStage(jobId: string): FixedProductStage {
    const { runtimeStore } = this.options;
    const task = runtimeStore.listTasks(jobId).find((item) => item.profileId === "product_role" && item.parentTaskId === undefined);
    if (task === undefined) return "ready_first_return";
    const summaries = runtimeStore.listEvidence(task.id).filter((item) => item.kind === "summary" && item.producer === "worker");
    const reviews = runtimeStore.listEvidence(task.id).filter((item) => item.kind === "review" && item.producer === "reviewer");
    const returns = runtimeStore.listReturns(jobId);
    const leadReturn = returns.find((item) => item.idempotencyKey === `${jobId}:fixed:lead:god`);
    if (leadReturn?.status === "consumed") return "completed";
    if (leadReturn !== undefined) return "lead_return_ready";
    if (summaries.length >= 2 && reviews.at(-1)?.verdict !== "passed") return "second_return_ready";
    if (reviews.at(-1)?.verdict === "failed") return "rework";
    if (summaries.length >= 1) return "first_return_ready";
    return "ready_first_return";
  }

  async advance(jobId: string, expectedStage: FixedProductStage): Promise<{ stage: FixedProductStage; changed: boolean }> {
    const current = this.getStage(jobId);
    if (current !== expectedStage || current === "completed" || this.activeJobs.has(jobId)) {
      return { stage: current, changed: false };
    }
    this.activeJobs.add(jobId);
    try {
      if (current === "ready_first_return") await this.runFirstProductReturn(jobId);
      else if (current === "first_return_ready") await this.rejectFirstReturn(jobId);
      else if (current === "rework") await this.runSecondProductReturn(jobId);
      else if (current === "second_return_ready") await this.acceptSecondReturn(jobId);
      else if (current === "lead_return_ready") await this.deliverLeadReturn(jobId);
      return { stage: this.getStage(jobId), changed: true };
    } finally {
      this.activeJobs.delete(jobId);
    }
  }

  private team(jobId: string) {
    const job = this.options.runtimeStore.getJob(jobId);
    if (job === undefined) throw new Error("固定团队 Job 不存在");
    const runs = this.options.runStore.listForJob(jobId);
    const root = runs.find((item) => item.id === job.rootRunId);
    const lead = runs.find((item) => item.agentProfileId === "software_team_lead");
    const product = runs.find((item) => item.agentProfileId === "product_role");
    if (root === undefined || lead === undefined || product === undefined || product.parentRunId !== lead.id) {
      throw new Error("固定软件团队结构不完整");
    }
    return { job, root, lead, product };
  }

  private productTask(jobId: string) {
    const existing = this.options.runtimeStore.listTasks(jobId)
      .find((item) => item.profileId === "product_role" && item.parentTaskId === undefined);
    if (existing !== undefined) return existing;
    const { root, product } = this.team(jobId);
    const task = this.options.runtimeStore.createTask({
      jobId, rootRunId: root.rootRunId, ownerRunId: product.id, profileId: "product_role",
      title: "今日运势签产品草图", objective: "为玄学小玩意‘今日运势签’整理可测试的移动端产品草图",
      scope: { allowedPaths: [], deniedPaths: [], nonGoals: ["工程实现", "真实占卜承诺"] },
      requiredOutputs: ["MVP 范围", "页面结构", "验收条件", "隐私与娱乐提示"],
      acceptanceCriteria: ["第二轮明确补齐异常/空状态", "明确内容仅供娱乐且不收集敏感信息"],
      fileClaims: [], maxAttempts: 2, status: "ready",
    });
    this.options.runStore.setTaskId(product.id, task.id);
    return task;
  }

  private async runFirstProductReturn(jobId: string): Promise<void> {
    const { root, lead, product } = this.team(jobId);
    const task = this.productTask(jobId);
    this.options.runtimeStore.setJobStatus(jobId, "running");
    this.options.runtimeStore.setTaskStatus(task.id, "running");
    this.options.runStore.setStatus(root.id, "waiting_children");
    this.options.runStore.setStatus(lead.id, "waiting_children");
    this.options.runStore.setStatus(product.id, "running");
    this.notify(root.id, lead.id, product.id); await this.options.persist?.();
    const execution = await this.options.execute({
      threadId: product.threadId, profileId: "product_role", attempt: 1,
      prompt: "负责人派发产品任务：为‘今日运势签’玄学小玩意给出第一版产品草图。输出 MVP 范围、页面结构、3 条验收条件和娱乐免责声明。保持简洁；这是第一轮 Return，等待负责人验收。",
    });
    this.options.runStore.rebindAttempt(product.id, execution.turnId, 1);
    this.options.runStore.complete(product.id, { runId: product.id, taskId: task.id, status: "completed", summary: execution.summary });
    const evidence = this.options.runtimeStore.addEvidence({ jobId, taskId: task.id, runId: product.id,
      kind: "summary", summary: execution.summary, producer: "worker", verdict: "supported" });
    this.options.runtimeStore.setTaskStatus(task.id, "reviewing");
    this.options.runtimeStore.createReturn({ jobId, rootRunId: root.rootRunId, parentRunId: lead.id,
      childRunId: product.id, taskId: task.id, sequence: 1,
      result: { status: "completed", summary: execution.summary, evidenceIds: [evidence.id], boardEntryIds: [] },
      idempotencyKey: `${jobId}:fixed:product:attempt:1` });
    this.options.runtimeStore.setJobStatus(jobId, "waiting_returns");
    this.notify(product.id, lead.id); await this.options.persist?.();
  }

  private async rejectFirstReturn(jobId: string): Promise<void> {
    const { root, lead, product } = this.team(jobId); const task = this.productTask(jobId);
    const envelope = this.requireReturn(jobId, `${jobId}:fixed:product:attempt:1`);
    const claimed = this.options.runtimeStore.claimReturn(envelope.id);
    if (claimed === undefined) throw new Error("第一轮产品 Return 尚不可验收");
    this.options.runtimeStore.setJobStatus(jobId, "reviewing");
    this.options.runStore.setStatus(lead.id, "running"); this.notify(lead.id); await this.options.persist?.();
    try {
      const execution = await this.options.execute({ threadId: lead.threadId, profileId: "software_team_lead", attempt: 1,
        prompt: `验收产品角色第一次 Return。为了验证返工协议，本轮合同要求必须驳回并指出 P2 缺口：需要补齐异常/空状态、免责声明位置与隐私边界。请用简洁中文给出负责人驳回意见。\n\n产品 Return：\n${claimed.result.summary}` });
      this.options.runStore.rebindAttempt(lead.id, execution.turnId, 1);
      this.options.runtimeStore.addEvidence({ jobId, taskId: task.id, runId: lead.id, kind: "review",
        summary: execution.summary, producer: "reviewer", verdict: "failed", severity: "P2" });
      this.options.runtimeStore.reviewTask(task.id);
      this.options.runtimeStore.consumeReturn(envelope.id);
      this.options.runStore.setStatus(product.id, "resuming");
      this.options.runStore.setStatus(lead.id, "waiting_children");
      this.options.runStore.setStatus(root.id, "waiting_children");
      this.options.runtimeStore.setJobStatus(jobId, "reviewing");
      this.notify(product.id, lead.id); await this.options.persist?.();
    } catch (error) {
      this.options.runtimeStore.retryReturn(envelope.id, 0); await this.options.persist?.(); throw error;
    }
  }

  private async runSecondProductReturn(jobId: string): Promise<void> {
    const { root, lead, product } = this.team(jobId); const task = this.productTask(jobId);
    this.options.runtimeStore.setTaskOwnerRun(task.id, product.id, 2);
    this.options.runtimeStore.setTaskStatus(task.id, "running");
    this.options.runStore.setStatus(product.id, "running"); this.notify(product.id); await this.options.persist?.();
    const feedback = this.options.runtimeStore.listEvidence(task.id).filter((item) => item.kind === "review").at(-1)?.summary ?? "补齐异常/空状态与隐私边界";
    const execution = await this.options.execute({ threadId: product.threadId, profileId: "product_role", attempt: 2,
      prompt: `这是原 Task、原产品 Thread 的第 2 次执行。根据负责人驳回意见返工，保留第一版有效内容并明确补齐：加载失败/无结果状态、免责声明展示位置、只供娱乐、不收集生日姓名等敏感信息。返回完整修订稿。\n\n负责人意见：${feedback}` });
    this.options.runStore.rebindAttempt(product.id, execution.turnId, 2);
    this.options.runStore.complete(product.id, { runId: product.id, taskId: task.id, status: "completed", summary: execution.summary });
    const evidence = this.options.runtimeStore.addEvidence({ jobId, taskId: task.id, runId: product.id,
      kind: "summary", summary: execution.summary, producer: "worker", verdict: "supported" });
    this.options.runtimeStore.setTaskStatus(task.id, "reviewing");
    this.options.runtimeStore.createReturn({ jobId, rootRunId: root.rootRunId, parentRunId: lead.id,
      childRunId: product.id, taskId: task.id, sequence: 2,
      result: { status: "completed", summary: execution.summary, evidenceIds: [evidence.id], boardEntryIds: [] },
      idempotencyKey: `${jobId}:fixed:product:attempt:2` });
    this.options.runtimeStore.setJobStatus(jobId, "waiting_returns");
    this.options.runStore.setStatus(lead.id, "resuming"); this.notify(product.id, lead.id); await this.options.persist?.();
  }

  private async acceptSecondReturn(jobId: string): Promise<void> {
    const { root, lead, product } = this.team(jobId); const task = this.productTask(jobId);
    const envelope = this.requireReturn(jobId, `${jobId}:fixed:product:attempt:2`);
    const claimed = this.options.runtimeStore.claimReturn(envelope.id);
    if (claimed === undefined) throw new Error("第二轮产品 Return 尚不可验收");
    this.options.runtimeStore.setJobStatus(jobId, "reviewing"); this.options.runStore.setStatus(lead.id, "running");
    this.notify(lead.id); await this.options.persist?.();
    try {
      const execution = await this.options.execute({ threadId: lead.threadId, profileId: "software_team_lead", attempt: 2,
        prompt: `验收同一产品 Task 的第二轮 Return。核对已补齐异常/空状态、免责声明位置、只供娱乐和不收集敏感信息；本轮合同满足时给出“通过”及可验证理由，然后准备 Return God。\n\n第二轮 Return：\n${claimed.result.summary}` });
      this.options.runStore.rebindAttempt(lead.id, execution.turnId, 2);
      const review = this.options.runtimeStore.addEvidence({ jobId, taskId: task.id, runId: lead.id, kind: "review",
        summary: execution.summary, producer: "reviewer", verdict: "passed" });
      if (!this.options.runtimeStore.reviewTask(task.id).passed) throw new Error("第二轮产品验收未通过");
      this.options.runtimeStore.consumeReturn(envelope.id);
      this.options.runStore.complete(product.id, { runId: product.id, taskId: task.id, status: "completed", summary: claimed.result.summary });
      this.options.runStore.setStatus(lead.id, "resuming");
      this.options.runtimeStore.createReturn({ jobId, rootRunId: root.rootRunId, parentRunId: root.id,
        childRunId: lead.id, taskId: task.id, sequence: 3,
        result: { status: "completed", summary: execution.summary, evidenceIds: [...claimed.result.evidenceIds, review.id], boardEntryIds: [] },
        idempotencyKey: `${jobId}:fixed:lead:god` });
      this.options.runtimeStore.setJobStatus(jobId, "waiting_returns"); this.notify(product.id, lead.id, root.id); await this.options.persist?.();
    } catch (error) {
      this.options.runtimeStore.retryReturn(envelope.id, 0); await this.options.persist?.(); throw error;
    }
  }

  private async deliverLeadReturn(jobId: string): Promise<void> {
    const { job, root, lead } = this.team(jobId); const task = this.productTask(jobId);
    const envelope = this.requireReturn(jobId, `${jobId}:fixed:lead:god`);
    const claimed = this.options.runtimeStore.claimReturn(envelope.id);
    if (claimed === undefined) throw new Error("负责人 Return 尚不可交付 God");
    this.options.runtimeStore.setJobStatus(jobId, "resuming"); this.options.runStore.setStatus(root.id, "resuming");
    this.notify(root.id); await this.options.persist?.();
    try {
      const execution = await this.options.execute({ threadId: job.threadId, profileId: "orchestrator", attempt: 1,
        prompt: `软件团队负责人已完成产品角色双轮验收。只向用户汇总一次最终产品草图结论，说明第一次被驳回、原产品 Thread 完成 Attempt 2、第二次已通过；不要创建工程或测试角色任务。\n\n负责人 Return：\n${claimed.result.summary}` });
      this.options.runtimeStore.consumeReturn(envelope.id);
      this.options.runtimeStore.reconcileJobStatus(jobId);
      const result: AgentRunResult = { runId: lead.id, taskId: task.id, status: "completed", summary: claimed.result.summary };
      this.options.runStore.complete(lead.id, result);
      this.options.runStore.complete(root.id, { ...result, runId: root.id, summary: execution.summary });
      this.options.runtimeStore.setJobStatus(jobId, "completed");
      this.options.onCompleted?.(jobId); this.notify(lead.id, root.id); await this.options.persist?.();
    } catch (error) {
      this.options.runtimeStore.retryReturn(envelope.id, 0); this.options.runtimeStore.setJobStatus(jobId, "waiting_returns");
      await this.options.persist?.(); throw error;
    }
  }

  private requireReturn(jobId: string, idempotencyKey: string) {
    const item = this.options.runtimeStore.listReturns(jobId).find((candidate) => candidate.idempotencyKey === idempotencyKey);
    if (item === undefined) throw new Error("固定团队 Return 不存在");
    return item;
  }

  private notify(...runIds: string[]): void { runIds.forEach((runId) => this.options.onRunUpdated?.(runId)); }
}
