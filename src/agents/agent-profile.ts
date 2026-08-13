export type AgentReasoningEffort =
  | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface AgentProfile {
  id: string;
  name: string;
  description: string;
  instructions: string;
  defaultModel: string;
  reasoningEffort: AgentReasoningEffort;
  allowedTools: string[];
  allowedSkills: string[];
}

export const BUILTIN_AGENT_PROFILES: AgentProfile[] = [
  {
    id: "orchestrator", name: "主 Agent", description: "拆解任务并汇总子 Agent 结果",
    instructions: "你是主 Agent。按需委派可并行子任务；子 Agent 返回后直接继续并给出最终结果，不询问用户是否继续。",
    defaultModel: "gpt-5.6-sol", reasoningEffort: "high", allowedTools: ["*"], allowedSkills: ["*"],
  },
  {
    id: "investigator", name: "排查 Agent", description: "读取证据、定位根因",
    instructions: "专注收集证据和定位根因，返回简洁、可验证的结论。",
    defaultModel: "gpt-5.6-terra", reasoningEffort: "high", allowedTools: ["list_files", "read_file", "read_skill", "read_shared_board", "publish_shared_result", "run_agent"], allowedSkills: ["*"],
  },
  {
    id: "researcher", name: "资料 Agent", description: "检索并整理可信来源",
    instructions: "专注检索和核对可信来源，只返回可引用的事实、来源与不确定项。",
    defaultModel: "gpt-5.6-terra", reasoningEffort: "high", allowedTools: ["list_files", "read_file", "read_skill", "read_shared_board", "publish_shared_result", "run_agent"], allowedSkills: ["*"],
  },
  {
    id: "coder", name: "编程 Agent", description: "实现限定范围的代码变更",
    instructions: "专注实现分配的代码任务并说明改动和验证结果。",
    defaultModel: "gpt-5.6-sol", reasoningEffort: "high", allowedTools: ["list_files", "read_file", "read_skill", "run_command", "read_shared_board", "publish_shared_result", "run_agent"], allowedSkills: ["*"],
  },
  {
    id: "tester", name: "测试 Agent", description: "执行验证并报告失败证据",
    instructions: "专注测试、边界和回归，返回可复现的结果。",
    defaultModel: "gpt-5.6-terra", reasoningEffort: "medium", allowedTools: ["list_files", "read_file", "read_skill", "run_command", "read_shared_board", "publish_shared_result", "run_agent"], allowedSkills: ["*"],
  },
  {
    id: "reviewer", name: "审查 Agent", description: "独立审查证据和回归风险",
    instructions: "独立检查任务合同、证据和风险。P0-P2 问题必须明确返回原任务返工。",
    defaultModel: "gpt-5.6-terra", reasoningEffort: "high", allowedTools: ["list_files", "read_file", "read_skill", "run_command", "read_shared_board", "publish_shared_result"], allowedSkills: ["*"],
  },
];
