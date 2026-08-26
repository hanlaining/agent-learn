import type { AgentJob, AgentTask } from "../agents/agent-runtime.js";
import type { AgentRun } from "../agents/agent-run.js";
import type { Requirement } from "../requirements/requirement.js";
import { isDesignConfirmed } from "../requirements/requirement.js";
import { assertWorkspacePathWithinTaskScope } from "../tools/workspace-tools.js";

export interface WriteAuthorizationStores {
  runStore: { getByTurn(turnId: string): Pick<AgentRun, "taskId" | "jobId"> | undefined };
  runtimeStore: {
    getTask(id: string): AgentTask | undefined;
    getJob(id: string): AgentJob | undefined;
  };
  requirementStore: { get(id: string): Requirement | undefined };
}

/**
 * V3 write_file 的唯一授权策略。把状态查找与路径边界集中在一个纯回调中，
 * 便于针对每个 fail-closed 分支做真实行为测试。
 */
export function createWriteAuthorization(stores: WriteAuthorizationStores) {
  return ({ turnId, path }: { turnId?: string; path: string }): void => {
    if (turnId === undefined) return;
    const run = stores.runStore.getByTurn(turnId);
    const task = run?.taskId === undefined ? undefined : stores.runtimeStore.getTask(run.taskId);
    const job = run === undefined ? undefined : stores.runtimeStore.getJob(run.jobId);
    if (job?.workflowVersion !== "software_product_delivery_v3") return;
    const requirement = job.requirementId === undefined
      ? undefined
      : stores.requirementStore.get(job.requirementId);
    if (!isDesignConfirmed(requirement)) {
      throw new Error("Design confirmation is required before write_file");
    }
    if (task === undefined) throw new Error("V3 write_file requires a bound Task");
    assertWorkspacePathWithinTaskScope(path, task.scope);
  };
}
