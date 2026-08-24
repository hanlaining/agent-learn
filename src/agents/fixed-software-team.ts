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
  workflowVersion = "software_product_delivery_v2",
): AgentRun[] {
  if (workflowVersion === "software_product_delivery_v3") {
    return ensureV3SoftwareTeam(lifecycleStore, runStore, rootRun);
  }
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

const V3_ROLE_CONTRACTS = [
  ["product_design", "产品原稿 Chat", "只产出产品原稿、页面结构和验收条件，不写工程"],
  ["mock_preview", "Mock 交互 Chat", "把原稿转成可预览交互和状态说明，不写前端业务代码"],
  ["frontend_engineering", "前端工程 Chat", "只修改前端文件"],
  ["backend_engineering", "后端工程 Chat", "只修改后端/API/数据文件"],
  ["integration_quality", "联调测试 Chat", "负责联调、测试、构建和验收证据，不修改前后端业务文件"],
  ["quality_role", "独立测试 Agent", "对照已确认原稿与 Mock 做最终独立验收，不修改业务文件"],
] as const;

function ensureV3SoftwareTeam(lifecycleStore: LifecycleStore, runStore: AgentRunStore, rootRun: AgentRun): AgentRun[] {
  const existing = runStore.listForJob(rootRun.jobId).filter((run) =>
    ["software_team_lead", ...V3_ROLE_CONTRACTS.map(([profileId]) => profileId)].includes(run.agentProfileId),
  );
  if (existing.length > 0) return existing;
  const leadThread = createRoleThread(lifecycleStore, "软件团队负责人", "监督设计确认、三 Chat 并行工程、联调验收并 Return God");
  const lead = runStore.create({ jobId: rootRun.jobId, rootRunId: rootRun.rootRunId, threadId: leadThread.threadId,
    turnId: leadThread.turnId, agentProfileId: "software_team_lead", parentRunId: rootRun.id,
    task: "监督 God-Agent v3 产品落地流程", depth: rootRun.depth + 1, attempt: 1,
    coordinationStatus: "waiting_assignment", attentionLevel: "neutral", statusMessage: "等待设计与工程阶段启动" });
  const roles = V3_ROLE_CONTRACTS.map(([profileId, title, task]) => {
    const thread = createRoleThread(lifecycleStore, title, task);
    return runStore.create({ jobId: rootRun.jobId, rootRunId: rootRun.rootRunId, threadId: thread.threadId,
      turnId: thread.turnId, agentProfileId: profileId, parentRunId: lead.id, task, depth: lead.depth + 1,
      attempt: 1, coordinationStatus: "waiting_assignment", attentionLevel: "neutral", statusMessage: "等待负责人派发真实任务" });
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
