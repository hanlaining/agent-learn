import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const appPath = resolve("src/electron/renderer/App.tsx");
const stylePath = resolve("src/electron/renderer/styles.css");
const preloadPath = resolve("src/electron/preload.cjs");
const mainPath = resolve("src/electron/main.cjs");
const browserManagerPath = resolve("src/electron/browser-manager.cjs");

function source(path: string): string {
  return readFileSync(path, "utf8");
}

function numericConstant(text: string, name: string): number {
  const match = text.match(new RegExp(`const\\s+${name}\\s*=\\s*(\\d+)`));
  assert.ok(match, `缺少尺寸常量 ${name}`);
  return Number(match[1]);
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

test("UI 可见文案遵守白名单并保留安全状态语义", () => {
  const app = source(appPath);
  const runtimeUi = source(resolve("src/electron/renderer/runtime-ui.ts"));

  // 这些是对用户承诺的固定文案；变更时必须同步产品验收，而不能随意出现同义漂移。
  const approvedCopy = [
    "只读", "工作区访问", "完全访问", "权限模式",
    "变更检查尚未接入", "桌面终端尚未接入", "正在读取 Runtime 能力…",
    "模型 Runtime", "已连接", "未配置", "不可用", "在线", "关闭",
    "客户端不会展示或传递原始 Tool 参数。",
    "App Server 完成安全握手后会恢复任务历史。",
  ];
  for (const label of approvedCopy) assert.match(app, new RegExp(escapeRegExp(label)));

  // 禁止把危险权限、内部实现细节或原始错误码作为 UI 文案暴露给用户。
  for (const forbidden of [
    /无限制权限/u,
    /绕过权限/u,
    /执行任意命令/u,
    /stack trace/iu,
    /内部异常/u,
  ]) assert.doesNotMatch(app, forbidden);

  for (const status of [
    ["running", "正在处理"],
    ["completed", "处理完成"],
    ["failed", "请求未完成"],
    ["cancelled", "已取消"],
    ["interrupted", "等待恢复"],
    ["timed_out", "已超时"],
  ] as const) {
    if (status[0] === "timed_out") {
      assert.match(runtimeUi, new RegExp(`"${escapeRegExp(status[1])}"`));
    } else {
      assert.match(runtimeUi, new RegExp(`status === "${status[0]}"[\\s\\S]{0,80}"${escapeRegExp(status[1])}"`));
    }
  }
});

test("三栏宽度有明确最小、默认、最大边界并始终保留中间工作区", () => {
  const app = source(appPath);
  const styles = source(stylePath);
  const minLeft = numericConstant(app, "MIN_LEFT_SIDEBAR_WIDTH");
  const defaultLeft = numericConstant(app, "DEFAULT_LEFT_SIDEBAR_WIDTH");
  const maxLeft = numericConstant(app, "MAX_LEFT_SIDEBAR_WIDTH");
  const minRight = numericConstant(app, "MIN_RIGHT_INSPECTOR_WIDTH");
  const defaultRight = numericConstant(app, "DEFAULT_RIGHT_INSPECTOR_WIDTH");
  const maxRight = numericConstant(app, "MAX_RIGHT_INSPECTOR_WIDTH");
  const minWorkspace = numericConstant(app, "MIN_WORKSPACE_WIDTH");

  assert.ok(minLeft > 0 && minLeft < defaultLeft && defaultLeft < maxLeft);
  assert.ok(minRight > 0 && minRight < defaultRight && defaultRight < maxRight);
  assert.ok(minWorkspace >= 240, "中间工作区过窄会导致 Composer 和时间线不可用");
  assert.match(app, /setLeftSidebarWidth\(clamp\(clientX, MIN_LEFT_SIDEBAR_WIDTH, maxWidth\)\)/);
  assert.match(app, /setRightInspectorWidth\(clamp\([\s\S]*MIN_RIGHT_INSPECTOR_WIDTH[\s\S]*maxWidth/);
  assert.match(app, /window\.innerWidth - rightWidth - MIN_WORKSPACE_WIDTH/);
  assert.match(app, /window\.innerWidth - leftWidth - MIN_WORKSPACE_WIDTH/);
  assert.match(app, /function clamp\(value: number, minimum: number, maximum: number\)[\s\S]*Math\.min\(maximum, Math\.max\(minimum, value\)\)/);
  assert.match(styles, /grid-template-columns:\s*minmax\(0,\s*var\(--left-sidebar-width(?:,\s*\d+px)?\)\)\s+minmax\(0,\s*1fr\)\s+minmax\(0,\s*var\(--right-inspector-width(?:,\s*\d+px)?\)\)/);
  assert.match(styles, /\.desktop-layout\s*\{/);
  assert.match(styles, /\.desktop-layout[\s\S]{0,320}min-width:\s*0\s*;/);
});

test("权限请求默认最小授权、展示上下文且 IPC 严格校验决策", () => {
  const app = source(appPath);
  const preload = source(preloadPath);
  const main = source(mainPath);
  const browserManager = source(browserManagerPath);
  const dialog = app.slice(app.indexOf("permissionRequest !== undefined"));

  assert.match(dialog, /role="dialog"[^>]*aria-modal="true"/);
  assert.match(dialog, /data-risk=\{permissionRequest\.riskLevel\}/);
  assert.match(dialog, /Chat \{permissionRequest\.threadId \?\? permissionRequest\.turnId\}/);
  assert.match(dialog, /Job \{permissionRequest\.jobId \?\? "当前"\}/);
  assert.match(dialog, /客户端不会展示或传递原始 Tool 参数/);
  assert.match(dialog, /answerPermission\("deny"\)/);
  assert.match(dialog, /answerPermission\("allow", "session"\)/);
  assert.match(dialog, /answerPermission\("allow", "once"\)/);

  assert.match(preload, /decision !== "allow" && decision !== "deny"/);
  assert.match(preload, /decision === "allow" \? \{ scope: scope === "session" \? "session" : "once" \}/);
  assert.match(main, /response\.decision !== "allow" && response\.decision !== "deny"/);
  assert.match(main, /response\.decision === "deny"/);
  assert.match(main, /response\.scope !== "once" && response\.scope !== "session"/);
  assert.match(app, /子 Agent 继承本次 Job 权限，不能扩大/);
  assert.match(browserManager, /setPermissionCheckHandler\(\(\) => false\)/);
  assert.match(browserManager, /setPermissionRequestHandler\([\s\S]*callback\(false\)/);
});

test("未接入能力使用诚实空态，不伪造成功或可执行入口", () => {
  const app = source(appPath);
  assert.match(app, /title="变更检查尚未接入"/);
  assert.match(app, /客户端不会偷偷执行 git diff/);
  assert.match(app, /title="桌面终端尚未接入"/);
  assert.match(app, /Runtime 当前只允许预注册的 check\/test 命令/);
  assert.match(app, /if \(capabilities === undefined\)[\s\S]*正在读取 Runtime 能力…/);
  assert.match(app, /if \(props\.browserState === undefined \|\| activeTab === undefined\)[\s\S]*正在启动浏览器…/);
  assert.match(app, /disabled=\{\(capabilities\?\.models\.length \?\? 0\) === 0\}/);
  assert.match(app, /capabilities\.webSearch \? "Sources 与 Citation 可用" : "不可用"/);
  assert.doesNotMatch(app, /未接入[\s\S]{0,80}onClick=\{/);
});

test("渲染层无 console 错误输出，并将未知异常转换为安全提示", () => {
  const rendererRoot = resolve("src/electron/renderer");
  const rendererFiles = filesUnder(rendererRoot).filter((path) => /\.(tsx?|cjs)$/u.test(path));
  for (const path of rendererFiles) {
    const text = source(path);
    assert.doesNotMatch(text, /console\.(error|warn|log|debug|info)\s*\(/, `${path} 存在 console 输出`);
  }
  const app = source(appPath);
  assert.match(app, /return error instanceof Error \? error\.message : "桌面操作失败，请稍后重试"/);
  assert.match(app, /\.catch\(\(error: unknown\) => dispatch\(\{[\s\S]*type: "error"/);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
