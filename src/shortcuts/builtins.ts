import type { ActionDefinition } from "./action-types.js";
import { CommandRegistry } from "./command-registry.js";

export const BUILTIN_ACTIONS = [
  action("app.help", "快捷帮助", "查看可用命令与快捷入口", "app", {
    surfaces: ["cli", "desktop"], slashCommand: "/help", cliAvailability: ["idle"],
  }),
  action("session.status", "查看状态", "查看当前会话与运行状态", "session", {
    surfaces: ["cli", "desktop"], slashCommand: "/status", cliAvailability: ["idle", "running"],
  }),
  action("chat.list", "列出会话", "列出已持久化的任务", "chat", {
    surfaces: ["cli"], slashCommand: "/threads", cliAvailability: ["idle"],
  }),
  action("chat.new", "新建任务", "创建并切换到新任务", "chat", {
    surfaces: ["cli", "desktop"], slashCommand: "/new", cliAvailability: ["idle"], defaultBindings: ["Primary+N"], risk: "write",
  }),
  action("turn.cancel", "取消运行", "取消正在运行的任务", "turn", {
    surfaces: ["cli"], slashCommand: "/cancel", cliAvailability: ["idle", "running"], risk: "write",
  }),
  action("app.exit", "安全退出", "安全退出", "app", {
    surfaces: ["cli"], slashCommand: "/exit", cliAvailability: ["idle", "running"],
  }),
  action("composer.commandPalette", "命令面板", "搜索命令、快捷键或 Skill", "composer", {
    surfaces: ["desktop"], defaultBindings: ["Primary+Shift+P"],
  }),
  action("chat.search", "搜索任务", "搜索并切换历史任务", "chat", {
    surfaces: ["desktop"], defaultBindings: ["Primary+K"],
  }),
  action("output.copyLatest", "复制最近回答", "复制最近一次完整的 Agent 回答", "output", {
    surfaces: ["desktop"], slashCommand: "/copy", defaultBindings: ["Primary+O"],
  }),
  action("session.model", "模型与推理", "选择模型和推理强度", "session", {
    surfaces: ["desktop"], slashCommand: "/model",
  }),
  action("session.permissions", "权限模式", "选择当前任务的权限边界", "session", {
    surfaces: ["desktop"], slashCommand: "/permissions",
  }),
  action("skill.pick", "Skills", "查看当前 Runtime 已发现的 Skills", "skill", {
    surfaces: ["desktop"], slashCommand: "/skills",
  }),
  action("settings.keymap", "快捷键", "查看和个性化快捷键", "settings", {
    surfaces: ["desktop"], slashCommand: "/keymap",
  }),
] as const satisfies readonly ActionDefinition[];

export const CLI_COMMAND_REGISTRY = new CommandRegistry(
  BUILTIN_ACTIONS.filter((item) => item.surfaces.includes("cli")),
);

export const DESKTOP_COMMAND_REGISTRY = new CommandRegistry(
  BUILTIN_ACTIONS.filter((item) => item.surfaces.includes("desktop")),
);

function action(
  id: string,
  label: string,
  description: string,
  category: ActionDefinition["category"],
  options: {
    surfaces: ActionDefinition["surfaces"];
    slashCommand?: `/${string}`;
    defaultBindings?: readonly string[];
    cliAvailability?: ActionDefinition["cliAvailability"];
    risk?: ActionDefinition["risk"];
  },
): ActionDefinition {
  return {
    id,
    label,
    description,
    category,
    risk: options.risk ?? "local-ui",
    userBindable: true,
    surfaces: options.surfaces,
    ...(options.slashCommand === undefined ? {} : { slashCommand: options.slashCommand }),
    ...(options.defaultBindings === undefined ? {} : { defaultBindings: options.defaultBindings }),
    ...(options.cliAvailability === undefined ? {} : { cliAvailability: options.cliAvailability }),
  };
}
