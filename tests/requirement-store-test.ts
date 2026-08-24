import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RequirementStore } from "../src/requirements/requirement-store.js";
import { RequirementPlanWriter } from "../src/requirements/requirement-plan-writer.js";
import { RequirementDesignWriter } from "../src/requirements/requirement-design-writer.js";
import type { RequirementDraft } from "../src/requirements/requirement.js";
import { isDesignConfirmed, isRequirementConfirmed } from "../src/requirements/requirement.js";

const draft: RequirementDraft = {
  executionKind: "analysis_only",
  title: "确认后执行", objective: "用户确认计划后才执行",
  scope: ["父 Chat 澄清"], nonGoals: ["不自动执行"], constraints: ["确认硬门"],
  deliverables: ["计划文档"], acceptanceCriteria: ["确认前没有 Job"],
  testCases: [{ id: "TC-01", title: "确认门", kind: "permission", steps: ["发送需求", "不确认"], expected: "不执行" }],
  executionSteps: ["确认", "执行", "验收"],
};

test("Requirement 修订会使旧确认失效，重复确认同版本幂等", async () => {
  const root = await mkdtemp(join(tmpdir(), "god-agent-plan-"));
  const store = new RequirementStore(() => "2026-08-13T00:00:00.000Z");
  const writer = new RequirementPlanWriter(root, () => "2026-08-13T00:00:00.000Z");
  const firstIdentity = store.nextPlanIdentity("chat-1");
  const firstArtifact = await writer.write({ ...firstIdentity, draft });
  const first = store.prepare("chat-1", draft, firstArtifact);
  const confirmed = store.confirm(first.id, first.revision, first.planArtifact.contentHash);
  assert.equal(store.confirm(first.id, first.revision, first.planArtifact.contentHash).confirmedAt, confirmed.confirmedAt);
  const nextIdentity = store.nextPlanIdentity("chat-1");
  const nextDraft = { ...draft, objective: "更新后的目标" };
  const nextArtifact = await writer.write({ ...nextIdentity, draft: nextDraft });
  const next = store.prepare("chat-1", nextDraft, nextArtifact);
  assert.equal(next.id, first.id); assert.equal(next.revision, 2); assert.equal(next.status, "planned");
  assert.equal(next.confirmedRevision, undefined);
  assert.throws(() => store.confirm(next.id, 1, first.planArtifact.contentHash), /changed/);
});

test("一个已确认 Requirement 版本只绑定一个 Job", async () => {
  const root = await mkdtemp(join(tmpdir(), "god-agent-plan-"));
  const store = new RequirementStore();
  const identity = store.nextPlanIdentity("chat-1");
  const artifact = await new RequirementPlanWriter(root).write({ ...identity, draft });
  const planned = store.prepare("chat-1", draft, artifact);
  store.confirm(planned.id, planned.revision, artifact.contentHash);
  assert.equal(store.attachJob(planned.id, "job-1").jobId, "job-1");
  assert.equal(store.attachJob(planned.id, "job-1").jobId, "job-1");
  const failed = store.setExecutionState(planned.id, "failed_retryable");
  assert.equal(failed.status, "failed_retryable");
  assert.equal(failed.confirmedRevision, planned.revision);
  assert.equal(failed.confirmedContentHash, artifact.contentHash);
  assert.equal(isRequirementConfirmed(failed), true);
  assert.equal(store.attachJob(planned.id, "job-1").executionState, "executing");
  assert.throws(() => store.attachJob(planned.id, "job-2"), /another Job/);
});

test("Markdown 计划包含测试用例并返回稳定哈希和绝对路径", async () => {
  const root = await mkdtemp(join(tmpdir(), "god-agent-plan-"));
  const artifact = await new RequirementPlanWriter(root).write({ requirementId: "requirement-1", revision: 1, draft });
  assert.equal(join(root, artifact.path.slice(root.length + 1)), artifact.path);
  assert.match(artifact.contentHash, /^[a-f0-9]{64}$/);
  const markdown = await readFile(artifact.path, "utf8");
  assert.match(markdown, /TC-01 确认门/); assert.match(markdown, /执行类型：analysis_only/);
  assert.match(markdown, /只有用户确认本版本后才开始执行/);
});

test("完整产品的需求确认与设计确认是两个独立硬门", async () => {
  const root = await mkdtemp(join(tmpdir(), "god-agent-design-"));
  const productDraft = { ...draft, executionKind: "software_product_delivery" as const };
  const store = new RequirementStore(() => "2026-08-24T00:00:00.000Z");
  const identity = store.nextPlanIdentity("chat-product");
  const plan = await new RequirementPlanWriter(root).write({ ...identity, draft: productDraft });
  const planned = store.prepare("chat-product", productDraft, plan);
  assert.throws(() => store.markDesignDraft(planned.id, planned.revision, { path: "x.md", contentHash: "a".repeat(64), generatedAt: "now" }), /confirmed/);
  const confirmed = store.confirm(planned.id, planned.revision, plan.contentHash);
  assert.equal(isRequirementConfirmed(confirmed), true);
  assert.equal(isDesignConfirmed(confirmed), false);
  const mockSpec = 'MOCK_SPEC:{"initialScreen":"home","screens":[{"id":"home","title":"产品首页","description":"输入产品 Idea","states":["等待输入","正在生成"],"actions":[{"label":"生成方案","to":"plan","feedback":"方案已生成"}]},{"id":"plan","title":"方案确认","description":"查看需求方案","states":["待确认"],"actions":[{"label":"确认需求","to":"home","state":"需求已确认"}]}]}';
  const artifact = await new RequirementDesignWriter(root, () => "2026-08-24T00:00:00.000Z").write({ requirement: confirmed, productDesign: "首页与结果页", mockPreview: mockSpec });
  const draftReady = store.markDesignDraft(confirmed.id, confirmed.revision, artifact);
  assert.equal(draftReady.designStatus, "draft_ready");
  assert.throws(() => store.confirmDesign(confirmed.id, confirmed.revision, "b".repeat(64)), /changed/);
  assert.equal(isDesignConfirmed(store.confirmDesign(confirmed.id, confirmed.revision, artifact.contentHash)), true);
  assert.match(await readFile(artifact.path, "utf8"), /产品原稿与 Mock/);
  const mockHtml = await readFile(artifact.mockPreview!, "utf8");
  assert.match(mockHtml, /可点击交互 Mock/);
  assert.match(mockHtml, /data-screen="0"/);
  assert.match(mockHtml, /生成方案/);
  assert.match(mockHtml, /data-to="1"/);
});

test("设计修改意见使旧设计失效并回到原稿与 Mock 返工", async () => {
  const root = await mkdtemp(join(tmpdir(), "god-agent-design-feedback-"));
  const productDraft = { ...draft, executionKind: "software_product_delivery" as const };
  const store = new RequirementStore();
  const identity = store.nextPlanIdentity("chat-product");
  const plan = await new RequirementPlanWriter(root).write({ ...identity, draft: productDraft });
  const planned = store.prepare("chat-product", productDraft, plan);
  const confirmed = store.confirm(planned.id, planned.revision, plan.contentHash);
  const artifact = await new RequirementDesignWriter(root).write({ requirement: confirmed, productDesign: "原稿", mockPreview: "Mock" });
  store.markDesignDraft(confirmed.id, confirmed.revision, artifact);
  const revised = store.requestDesignRevision(confirmed.id, confirmed.revision, "首页按钮改为底部固定");
  assert.equal(revised.designStatus, "not_started");
  assert.equal(revised.designFeedback, "首页按钮改为底部固定");
  assert.equal(isDesignConfirmed(revised), false);
});
