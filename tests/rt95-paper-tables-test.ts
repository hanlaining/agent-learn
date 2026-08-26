import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { analyzeRawResults } from "../research/rt95-closure/src/statistics.js";
import {
  createPaperTableArtifacts,
  parsePaperTableCliArgs,
  renderRt95PaperTables,
  validateStatisticsReportForPaper,
} from "../scripts/render-rt95-paper-tables.js";

function report() {
  return analyzeRawResults({
    schemaVersion: "rt95-raw-results-v1",
    experimentId: "EXP-PAPER-KAT",
    baselineArmId: "ARM-Z-BASE",
    records: [
      { runId: "b1", armId: "ARM-Z-BASE", seed: 1, faultWindowId: "FW-1", outcome: "success", latencyMs: 10 },
      { runId: "b2", armId: "ARM-Z-BASE", seed: 2, faultWindowId: "FW-2", outcome: "success", latencyMs: 30 },
      { runId: "c1", armId: "ARM-A-COMP", seed: 1, faultWindowId: "FW-1", outcome: "failure", latencyMs: 20 },
      { runId: "c2", armId: "ARM-A-COMP", seed: 2, faultWindowId: "FW-2", outcome: "success", latencyMs: 40 },
    ],
  });
}

test("从 v1 报告确定性生成 Markdown、arm CSV 和 comparison CSV", () => {
  const first = createPaperTableArtifacts(report());
  const reversed = structuredClone(report());
  reversed.arms.reverse();
  reversed.comparisons.reverse();
  assert.deepEqual(createPaperTableArtifacts(reversed), first);
  assert.match(first.markdown, /significanceClaimed=false/u);
  assert.match(first.markdown, /ARM-A-COMP[\s\S]*ARM-Z-BASE/u, "arm rows use stable ID order");
  assert.match(first.armsCsv, /^arm_id,successes,failures,total,success_rate,/u);
  assert.match(first.armsCsv, /ARM-Z-BASE,2,0,2,1,/u);
  assert.match(first.comparisonsCsv, /ARM-Z-BASE,ARM-A-COMP,1,0\.5,0\.5,2,finite/u);
});

test("严格 schema、significanceClaimed=false 和有限数值失败关闭", () => {
  const badSchema = structuredClone(report()) as unknown as Record<string, unknown>;
  badSchema.schemaVersion = "rt95-statistics-report-v2";
  assert.throws(() => validateStatisticsReportForPaper(badSchema), /schemaVersion/u);

  const claimed = structuredClone(report());
  claimed.methodology.significanceClaimed = true as false;
  assert.throws(() => validateStatisticsReportForPaper(claimed), /significanceClaimed/u);

  const extra = structuredClone(report()) as typeof report extends () => infer T ? T & { invented?: number } : never;
  extra.invented = 95;
  assert.throws(() => validateStatisticsReportForPaper(extra), /key mismatch/u);

  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const nonFinite = structuredClone(report());
    nonFinite.arms[0]!.latencyMs.p95 = value;
    assert.throws(() => validateStatisticsReportForPaper(nonFinite), /finite non-negative/u);
  }
});

test("拒绝报告内部不一致和人工数字 CLI 参数", () => {
  const inconsistent = structuredClone(report());
  inconsistent.arms[0]!.successRate.estimate = 0.6;
  assert.throws(() => validateStatisticsReportForPaper(inconsistent), /inconsistent/u);
  assert.deepEqual(parsePaperTableCliArgs(["--input", "report.json", "--output-dir", "paper/tables"]), {
    inputPath: "report.json",
    outputDirectory: "paper/tables",
  });
  assert.throws(
    () => parsePaperTableCliArgs(["--input", "report.json", "--output-dir", "paper", "--success-rate", "0.95"]),
    /only --input and --output-dir/u,
  );
});

test("文件入口只在工作区内读取和写入三个固定文件", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "rt95-paper-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "input"));
  await writeFile(path.join(root, "input", "report.json"), `${JSON.stringify(report(), null, 2)}\n`, "utf8");
  const rendered = await renderRt95PaperTables(root, { inputPath: "input/report.json", outputDirectory: "paper/tables" });
  assert.equal(await readFile(path.join(root, "paper", "tables", "results.md"), "utf8"), rendered.markdown);
  assert.equal(await readFile(path.join(root, "paper", "tables", "arms.csv"), "utf8"), rendered.armsCsv);
  assert.equal(await readFile(path.join(root, "paper", "tables", "comparisons.csv"), "utf8"), rendered.comparisonsCsv);
  await assert.rejects(renderRt95PaperTables(root, { inputPath: "../outside.json", outputDirectory: "paper" }), /escapes workspace/u);
  await assert.rejects(renderRt95PaperTables(root, { inputPath: "input/report.json", outputDirectory: "../escaped" }), /escapes workspace/u);
});

test("输出目录经符号链接逃逸时拒绝", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "rt95-paper-symlink-root-"));
  const outside = await mkdtemp(path.join(tmpdir(), "rt95-paper-symlink-outside-"));
  context.after(async () => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await writeFile(path.join(root, "report.json"), `${JSON.stringify(report())}\n`, "utf8");
  await symlink(outside, path.join(root, "escaped"), "junction");
  await assert.rejects(
    renderRt95PaperTables(root, { inputPath: "report.json", outputDirectory: "escaped/tables" }),
    /escapes workspace/u,
  );
});

test("Claim Table 机器可读且每项同时给出 allowed/forbidden claim", async () => {
  const claimPath = path.resolve("research/paper/CLAIM-TABLE.json");
  const value = JSON.parse(await readFile(claimPath, "utf8")) as {
    schemaVersion?: unknown;
    policy?: { significanceClaimed?: unknown };
    claims?: Array<Record<string, unknown>>;
  };
  assert.equal(value.schemaVersion, "rt95-paper-claim-table-v1");
  assert.equal(value.policy?.significanceClaimed, false);
  assert.ok(Array.isArray(value.claims) && value.claims.length >= 1);
  const ids = new Set<string>();
  for (const claim of value.claims ?? []) {
    assert.match(String(claim.id), /^CLAIM-[A-Z0-9-]+$/u);
    assert.equal(ids.has(String(claim.id)), false, `duplicate claim ID: ${String(claim.id)}`);
    ids.add(String(claim.id));
    assert.ok(typeof claim.allowedClaim === "string" && claim.allowedClaim.length > 0);
    assert.ok(typeof claim.forbiddenClaim === "string" && claim.forbiddenClaim.length > 0);
    assert.ok(claim.evidenceState === "CodeVerified" || claim.evidenceState === "NotVerified");
  }
});

test("论文草案、Claim Table 与独立引用审阅清单保持 fail-closed 一致", async () => {
  const root = path.resolve(".");
  const manuscript = await readFile(path.join(root, "research/paper/MANUSCRIPT-DRAFT.zh-CN.md"), "utf8");
  const claims = JSON.parse(await readFile(path.join(root, "research/paper/CLAIM-TABLE.json"), "utf8")) as {
    claims?: Array<{
      id?: unknown;
      evidenceState?: unknown;
      allowedClaim?: unknown;
      forbiddenClaim?: unknown;
      requiredEvidence?: unknown;
    }>;
  };
  const checklist = await readFile(path.join(root, "research/paper/CITATION-REVIEW-CHECKLIST.zh-CN.md"), "utf8");

  assert.match(manuscript, /TODO\/NotVerified/u, "未验证结果必须在草案中显式保留");
  assert.match(manuscript, /相关工作/u, "草案必须保留相关工作章节");
  assert.match(manuscript, /引用/u, "草案必须保留引用核验边界");
  assert.match(checklist, /NotReviewed \/ NotVerified/u);
  assert.match(checklist, /CIT-TODO-001/u);
  assert.match(checklist, /一手来源/u);
  assert.match(checklist, /同作者同机器复跑写成独立复现/u);
  assert.doesNotMatch(checklist, /^\| CIT-TODO-001.*\| Verified \|$/mu);

  const claimIds = new Set<string>();
  for (const claim of claims.claims ?? []) {
    const id = String(claim.id ?? "");
    assert.match(id, /^CLAIM-[A-Z0-9-]+$/u);
    assert.equal(claimIds.has(id), false, `duplicate claim ID: ${id}`);
    claimIds.add(id);
    assert.equal(typeof claim.allowedClaim, "string");
    assert.equal(typeof claim.forbiddenClaim, "string");
    assert.ok(Array.isArray(claim.requiredEvidence) && claim.requiredEvidence.length > 0,
      `${id} must declare required evidence`);
    if (claim.evidenceState === "NotVerified") {
      assert.notEqual(claim.evidenceState, "Verified", `${id} cannot be Verified in this gate`);
      assert.notEqual(String(claim.allowedClaim).trim(), String(claim.forbiddenClaim).trim(),
        `${id} must keep allowed and forbidden wording distinct`);
    }
  }
  assert.ok(claimIds.has("CLAIM-PAPER-001"), "publication readiness claim must remain machine-addressable");
  assert.ok(claimIds.has("CLAIM-REPRO-001"), "external reproduction claim must remain machine-addressable");
});
