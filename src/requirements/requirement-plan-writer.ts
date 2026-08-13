import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { RequirementDraft, RequirementPlanArtifact } from "./requirement.js";

export class RequirementPlanWriter {
  constructor(
    private readonly plansRoot: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async write(input: {
    requirementId: string;
    revision: number;
    draft: RequirementDraft;
  }): Promise<RequirementPlanArtifact> {
    const generatedAt = this.now();
    const markdown = renderRequirementPlan(input.requirementId, input.revision, input.draft);
    const contentHash = createHash("sha256").update(markdown, "utf8").digest("hex");
    const fileName = `${safeSegment(input.draft.title)}-${input.requirementId}-v${input.revision}.md`;
    const root = resolve(this.plansRoot);
    const path = resolve(root, fileName);
    if (path !== join(root, fileName)) throw new Error("Invalid requirement plan path");
    await mkdir(root, { recursive: true });
    await writeFile(path, markdown, "utf8");
    return { path, contentHash, generatedAt };
  }
}

export function renderRequirementPlan(
  requirementId: string,
  revision: number,
  draft: RequirementDraft,
): string {
  return [
    `# ${draft.title}`,
    "",
    `> Requirement: ${requirementId} · revision ${revision}`,
    "",
    "## 目标", "", draft.objective,
    "", "## 范围", "", list(draft.scope),
    "", "## 不做的内容", "", list(draft.nonGoals),
    "", "## 约束", "", list(draft.constraints),
    "", "## 交付物", "", list(draft.deliverables),
    "", "## 验收标准", "", list(draft.acceptanceCriteria),
    "", "## 测试用例", "",
    ...draft.testCases.flatMap((testCase) => [
      `### ${testCase.id} ${testCase.title}`,
      "",
      `- 类型：${testCase.kind}`,
      `- 步骤：${testCase.steps.join(" → ")}`,
      `- 预期：${testCase.expected}`,
      "",
    ]),
    "## 执行步骤", "", list(draft.executionSteps),
    "", "## 确认", "",
    "只有用户确认本版本后才开始执行。需求发生实质变化时，需要生成新版本并重新确认。",
    "",
  ].join("\n");
}

function list(values: readonly string[]): string {
  return values.length === 0 ? "- 无" : values.map((value) => `- ${value}`).join("\n");
}

function safeSegment(value: string): string {
  const normalized = value.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").replace(/\s+/g, "-").slice(0, 60);
  return normalized.length === 0 ? "requirement-plan" : normalized;
}
