import type { LifecycleStore } from "../runtime/lifecycle-store.js";
import type { AgentRun } from "./agent-run.js";
import { AgentRunStore } from "./agent-run-store.js";

export const FIXED_SOFTWARE_TEAM_ID = "software-product-demo-team";
export const FIXED_SOFTWARE_TEAM_NAME = "软件产品演示团队";

const ROLE_CONTRACTS = [
  {
    profileId: "product_role",
    title: "产品角色 Agent",
    task: "整理 3 条简短需求与页面结构；结果 Return 软件团队负责人",
  },
  {
    profileId: "engineering_role",
    title: "工程角色 Agent",
    task: "整理 3 条实现建议；结果 Return 软件团队负责人",
  },
  {
    profileId: "quality_role",
    title: "测试角色 Agent",
    task: "独立检查产品与工程结果是否一致；只给通过或返工结论",
  },
] as const;

export function ensureFixedSoftwareTeam(
  lifecycleStore: LifecycleStore,
  runStore: AgentRunStore,
  rootRun: AgentRun,
): AgentRun[] {
  const existing = runStore.listForJob(rootRun.jobId).filter((run) =>
    ["software_team_lead", ...ROLE_CONTRACTS.map((item) => item.profileId)].includes(run.agentProfileId),
  );
  if (existing.length > 0) return existing;

  const leadThread = createRoleThread(
    lifecycleStore,
    "软件团队负责人",
    "负责拆分、监工、验收产品/工程/测试角色，并只在内部结果通过后 Return God。",
  );
  const lead = runStore.create({
    jobId: rootRun.jobId,
    rootRunId: rootRun.rootRunId,
    threadId: leadThread.threadId,
    turnId: leadThread.turnId,
    agentProfileId: "software_team_lead",
    parentRunId: rootRun.id,
    task: "组织软件产品演示团队并逐级验收 Return",
    depth: rootRun.depth + 1,
    attempt: 1,
    coordinationStatus: "waiting_assignment",
    attentionLevel: "neutral",
    statusMessage: "等待 God 派发团队任务",
  });

  const roles = ROLE_CONTRACTS.map((contract) => {
    const thread = createRoleThread(lifecycleStore, contract.title, contract.task);
    return runStore.create({
      jobId: rootRun.jobId,
      rootRunId: rootRun.rootRunId,
      threadId: thread.threadId,
      turnId: thread.turnId,
      agentProfileId: contract.profileId,
      parentRunId: lead.id,
      task: contract.task,
      depth: lead.depth + 1,
      attempt: 1,
      coordinationStatus: "waiting_assignment",
      attentionLevel: "neutral",
      statusMessage: "等待负责人派发真实任务",
    });
  });
  return [lead, ...roles];
}

function createRoleThread(
  lifecycleStore: LifecycleStore,
  roleName: string,
  contract: string,
): { threadId: string; turnId: string } {
  const thread = lifecycleStore.createThread("agent_internal");
  const turn = lifecycleStore.createTurn(thread.id);
  lifecycleStore.appendItem(turn.id, "assistant_message", {
    text: `【Runtime 团队合同】\n身份：${roleName}\n职责：${contract}\n状态：等待负责人派发真实任务。`,
  });
  lifecycleStore.completeTurn(turn.id);
  return { threadId: thread.id, turnId: turn.id };
}
