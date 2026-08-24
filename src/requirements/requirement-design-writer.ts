import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { Requirement, RequirementDesignArtifact } from "./requirement.js";

export class RequirementDesignWriter {
  constructor(
    private readonly designsRoot: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async write(input: {
    requirement: Requirement;
    productDesign: string;
    mockPreview: string;
  }): Promise<RequirementDesignArtifact> {
    const generatedAt = this.now();
    const markdown = renderRequirementDesign(input.requirement, input.productDesign, input.mockPreview);
    const contentHash = createHash("sha256").update(markdown, "utf8").digest("hex");
    const fileName = `${safeSegment(input.requirement.title)}-${input.requirement.id}-v${input.requirement.revision}-设计稿与Mock.md`;
    const mockFileName = `${safeSegment(input.requirement.title)}-${input.requirement.id}-v${input.requirement.revision}-Mock.html`;
    const root = resolve(this.designsRoot);
    const path = resolve(root, fileName);
    const mockPath = resolve(root, mockFileName);
    if (path !== join(root, fileName)) throw new Error("Invalid requirement design path");
    if (mockPath !== join(root, mockFileName)) throw new Error("Invalid requirement Mock path");
    await mkdir(root, { recursive: true });
    await writeFile(path, markdown, "utf8");
    await writeFile(mockPath, renderInteractiveMock(input.requirement.title, input.mockPreview), "utf8");
    return { path, contentHash, generatedAt, mockPreview: mockPath, mockSummary: input.mockPreview };
  }
}

interface InteractiveMockAction {
  label: string;
  to?: string;
  feedback?: string;
  state?: string;
}

interface InteractiveMockScreen {
  id: string;
  title: string;
  description: string;
  states: string[];
  actions: InteractiveMockAction[];
}

interface InteractiveMockSpec {
  initialScreen: string;
  screens: InteractiveMockScreen[];
}

function renderInteractiveMock(title: string, mockPreview: string): string {
  const spec = parseInteractiveMockSpec(mockPreview, title);
  const safeTitle = escapeHtml(title);
  const screenIndex = new Map(spec.screens.map((screen, index) => [screen.id, index]));
  const screens = spec.screens.map((screen, index) => {
    const states = screen.states.length === 0
      ? ""
      : `<ul class="state-list">${screen.states.map((state) => `<li>${escapeHtml(state)}</li>`).join("")}</ul>`;
    const actions = screen.actions.map((action, actionIndex) => {
      const targetIndex = action.to === undefined ? undefined : screenIndex.get(action.to);
      return `<button type="button" data-action="${actionIndex}"${targetIndex === undefined ? "" : ` data-to="${targetIndex}"`}${action.feedback === undefined ? "" : ` data-feedback="${escapeHtml(action.feedback)}"`}${action.state === undefined ? "" : ` data-state="${escapeHtml(action.state)}"`}>${escapeHtml(action.label)}</button>`;
    }).join("");
    return `<section class="screen" data-screen="${index}"${screen.id === spec.initialScreen ? "" : " hidden"}><div class="screen-count">页面 ${index + 1}/${spec.screens.length}</div><h1>${escapeHtml(screen.title)}</h1><p>${escapeHtml(screen.description)}</p>${states}<div class="actions">${actions}</div></section>`;
  }).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle} Mock</title><style>*{box-sizing:border-box}body{font-family:system-ui;margin:0;background:#eef1f6;color:#172033}.shell{max-width:430px;margin:24px auto;background:#fff;border-radius:24px;box-shadow:0 18px 50px #25304a2e;overflow:hidden}.head{padding:22px;background:#172033;color:#fff}.head small{display:block;margin-top:6px;color:#cbd5e1}.screen{padding:24px;min-height:500px;line-height:1.65}.screen-count{color:#667085;font-size:12px}.screen h1{font-size:24px;margin:10px 0}.state-list{padding:14px 14px 14px 32px;border-radius:12px;background:#f5f7fb}.actions{display:grid;gap:10px;margin-top:24px}.actions button{padding:12px;border:0;border-radius:12px;background:#315efb;color:#fff;cursor:pointer}.feedback{min-height:54px;margin:0 24px 24px;padding:14px;border-radius:12px;background:#eef4ff;color:#25304a}[hidden]{display:none!important}</style></head><body><main class="shell"><header class="head"><strong>${safeTitle}</strong><small>可点击交互 Mock · 设计确认前预览</small></header>${screens}<div id="feedback" class="feedback" role="status">请选择页面操作，检查跳转与状态反馈。</div></main><script>(()=>{const screens=[...document.querySelectorAll('[data-screen]')];const feedback=document.getElementById('feedback');document.addEventListener('click',(event)=>{const button=event.target.closest('button[data-action]');if(!button)return;const to=button.dataset.to;if(to!==undefined){screens.forEach((screen,index)=>screen.hidden=String(index)!==to)}feedback.textContent=button.dataset.feedback||button.dataset.state||('已执行：'+button.textContent)});})();</script></body></html>`;
}

function parseInteractiveMockSpec(value: string, title: string): InteractiveMockSpec {
  const raw = extractMarkedJson(value, "MOCK_SPEC:");
  if (raw !== undefined) {
    try {
      const normalized = normalizeInteractiveMockSpec(JSON.parse(raw) as unknown);
      if (normalized !== undefined) return normalized;
    } catch {
      // 非法结构不执行模型提供的 HTML/脚本，安全退回文本原型。
    }
  }
  return {
    initialScreen: "overview",
    screens: [{
      id: "overview",
      title: `${title} 产品预览`,
      description: value.trim() || "等待补充交互说明",
      states: ["默认状态", "加载状态", "空状态", "错误状态"],
      actions: [{ label: "查看状态反馈", state: "已切换产品状态预览" }],
    }],
  };
}

function normalizeInteractiveMockSpec(value: unknown): InteractiveMockSpec | undefined {
  if (!isRecord(value) || !Array.isArray(value.screens)) return undefined;
  const screens = value.screens.slice(0, 12).flatMap((candidate, index): InteractiveMockScreen[] => {
    if (!isRecord(candidate)) return [];
    const id = safeMockText(candidate.id, `screen-${index + 1}`);
    const title = safeMockText(candidate.title, `页面 ${index + 1}`);
    const description = safeMockText(candidate.description, "");
    const states = Array.isArray(candidate.states)
      ? candidate.states.slice(0, 8).flatMap((state) => typeof state === "string" ? [state.slice(0, 160)] : [])
      : [];
    const actions = Array.isArray(candidate.actions)
      ? candidate.actions.slice(0, 8).flatMap((action): InteractiveMockAction[] => {
        if (!isRecord(action) || typeof action.label !== "string" || action.label.trim().length === 0) return [];
        return [{ label: action.label.slice(0, 80), ...(typeof action.to === "string" ? { to: action.to.slice(0, 80) } : {}),
          ...(typeof action.feedback === "string" ? { feedback: action.feedback.slice(0, 240) } : {}),
          ...(typeof action.state === "string" ? { state: action.state.slice(0, 160) } : {}) }];
      })
      : [];
    return [{ id, title, description, states, actions }];
  });
  if (screens.length === 0 || new Set(screens.map((screen) => screen.id)).size !== screens.length) return undefined;
  const initialScreen = typeof value.initialScreen === "string" && screens.some((screen) => screen.id === value.initialScreen)
    ? value.initialScreen
    : screens[0]!.id;
  return { initialScreen, screens };
}

function extractMarkedJson(value: string, marker: string): string | undefined {
  const markerIndex = value.indexOf(marker);
  if (markerIndex === -1) return undefined;
  const start = value.indexOf("{", markerIndex + marker.length);
  if (start === -1) return undefined;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") quoted = false;
      continue;
    }
    if (character === "\"") quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return value.slice(start, index + 1);
  }
  return undefined;
}

function safeMockText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 500) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]!);
}

export function renderRequirementDesign(
  requirement: Requirement,
  productDesign: string,
  mockPreview: string,
): string {
  return [
    `# ${requirement.title}：产品原稿与 Mock`,
    "",
    `> Requirement: ${requirement.id} · revision ${requirement.revision}`,
    "> 当前状态：等待用户确认设计；确认前禁止前端、后端和联调 Chat 修改工程文件。",
    "",
    "## 产品原稿",
    "",
    productDesign.trim(),
    "",
    "## Mock 交互预览",
    "",
    mockPreview.trim(),
    "",
    "## 设计确认",
    "",
    "请先查看原稿和 Mock。需要调整时提出修改；确认没有问题后点击“确认设计”，Runtime 才会启动三个工程 Chat。",
    "",
  ].join("\n");
}

function safeSegment(value: string): string {
  const normalized = value.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").replace(/\s+/g, "-").slice(0, 60);
  return normalized.length === 0 ? "product-design" : normalized;
}
