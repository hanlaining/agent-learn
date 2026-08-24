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
    id: "software_team_lead", name: "软件团队负责人", description: "拆分、监工、验收并向 God Return",
    instructions: "你是固定软件产品演示团队负责人。只负责拆分、监工、验收和汇总；角色结果不合格时退回原角色返工，合格后才 Return God。",
    defaultModel: "gpt-5.6-sol", reasoningEffort: "high", allowedTools: ["read_shared_board", "publish_shared_result", "run_agent"], allowedSkills: ["*"],
  },
  {
    id: "product_role", name: "产品角色 Agent", description: "定义需求、页面结构和产品验收条件",
    instructions: "你是固定软件团队的产品角色，只负责产品需求、页面结构和验收条件，不修改工程实现。",
    defaultModel: "gpt-5.6-terra", reasoningEffort: "high", allowedTools: ["list_files", "read_file", "read_skill", "read_shared_board", "publish_shared_result"], allowedSkills: ["*"],
  },
  {
    id: "engineering_role", name: "工程角色 Agent", description: "给出限定范围的工程实现建议",
    instructions: "你是固定软件团队的工程角色，只负责工程方案和获准的实现工作，遵守任务合同与文件边界。",
    defaultModel: "gpt-5.6-sol", reasoningEffort: "high", allowedTools: ["list_files", "read_file", "write_file", "read_skill", "run_command", "read_shared_board", "publish_shared_result"], allowedSkills: ["*"],
  },
  {
    id: "product_design", name: "产品原稿 Chat", description: "把需求整理为用户可确认的产品原稿",
    instructions: "你是产品原稿 Chat。只输出页面结构、关键流程、状态和验收条件；不写前端或后端代码。原稿必须能让不懂代码的用户理解和确认。",
    defaultModel: "gpt-5.6-terra", reasoningEffort: "high", allowedTools: ["list_files", "read_file", "read_skill", "read_shared_board", "publish_shared_result"], allowedSkills: ["*"] ,
  },
  {
    id: "mock_preview", name: "Mock 交互 Chat", description: "把产品原稿转成交互预览",
    instructions: "你是 Mock 交互 Chat。根据已确认需求制作可说明的交互预览、页面跳转和空/错/加载状态；不得修改真实前端业务代码。",
    defaultModel: "gpt-5.6-terra", reasoningEffort: "high", allowedTools: ["list_files", "read_file", "read_skill", "read_shared_board", "publish_shared_result"], allowedSkills: ["*"] ,
  },
  {
    id: "frontend_engineering", name: "前端工程 Chat", description: "只负责已确认原稿范围内的前端实现",
    instructions: "你是前端工程 Chat。只修改任务合同声明的前端文件，先读取已确认原稿与 Mock，不得改后端/API，不得越过设计确认闸门。完成后 Return 变更文件、测试证据和风险。",
    defaultModel: "gpt-5.6-sol", reasoningEffort: "high", allowedTools: ["list_files", "read_file", "write_file", "read_skill", "run_command", "read_shared_board", "publish_shared_result"], allowedSkills: ["*"] ,
  },
  {
    id: "backend_engineering", name: "后端工程 Chat", description: "只负责 API、数据和服务端实现",
    instructions: "你是后端工程 Chat。只修改任务合同声明的 API、数据和服务端文件，遵守前后端边界。完成后 Return 接口契约、变更文件、测试证据和风险。",
    defaultModel: "gpt-5.6-sol", reasoningEffort: "high", allowedTools: ["list_files", "read_file", "write_file", "read_skill", "run_command", "read_shared_board", "publish_shared_result"], allowedSkills: ["*"] ,
  },
  {
    id: "integration_quality", name: "联调测试 Chat", description: "负责联调、测试和构建保障，不抢占前后端文件",
    instructions: "你是联调/测试 Chat。负责接口联调、测试、构建和验收证据；除测试夹具与报告外不得修改前端/后端业务文件。发现问题只 Return 风险和可复现证据。",
    defaultModel: "gpt-5.6-terra", reasoningEffort: "medium", allowedTools: ["list_files", "read_file", "read_skill", "run_command", "read_shared_board", "publish_shared_result"], allowedSkills: ["*"] ,
  },
  {
    id: "quality_role", name: "测试角色 Agent", description: "独立检查产品与工程结果是否一致",
    instructions: "你是固定软件团队的测试角色，只负责独立测试和审查，不得偷偷修改产品或工程产物。",
    defaultModel: "gpt-5.6-terra", reasoningEffort: "medium", allowedTools: ["list_files", "read_file", "read_skill", "run_command", "read_shared_board", "publish_shared_result"], allowedSkills: ["*"],
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
    defaultModel: "gpt-5.6-sol", reasoningEffort: "high", allowedTools: ["list_files", "read_file", "write_file", "read_skill", "run_command", "read_shared_board", "publish_shared_result", "run_agent"], allowedSkills: ["*"],
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
