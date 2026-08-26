import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { scanPaperConsistency } from "../scripts/verify-paper-consistency.js";

const PAPER_FILES = [
  "research/paper/MANUSCRIPT-DRAFT.zh-CN.md",
  "research/paper/CLAIM-TABLE.json",
  "research/paper/CITATION-REVIEW-CHECKLIST.zh-CN.md",
] as const;
const SUPPORT_FILES = [
  "docs/research/FORMAL-PROVIDER-BASELINE-REPLICATION-RUNBOOK.zh-CN.md",
  "research/artifact-releases/local-tooling-v0.1.0/release/artifact-release.json",
  "research/artifact-releases/local-tooling-v0.1.0/release/manifest/artifact-manifest.json",
] as const;
const RELEASE_ROOT = "research/artifact-releases/local-tooling-v0.1.0/release";

async function fixture(context: test.TestContext, includeArtifactTree = false): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "paper-consistency-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const relative of PAPER_FILES) {
    const source = path.resolve(relative);
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await readFile(source, "utf8"), "utf8");
  }
  for (const relative of SUPPORT_FILES) {
    const source = path.resolve(relative);
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await readFile(source, "utf8"), "utf8");
  }
  if (includeArtifactTree) {
    // Integrity-specific cases opt into the complete release tree. The legacy
    // paper-only fixture intentionally contains only the boundary manifests.
    await cp(path.resolve(RELEASE_ROOT), path.join(root, RELEASE_ROOT), { recursive: true, force: true });
  }
  return root;
}

async function rewriteCitationRow(root: string, mutate: (cells: string[]) => string[] | null): Promise<void> {
  const target = path.join(root, PAPER_FILES[2]);
  const lines = (await readFile(target, "utf8")).split(/\r?\n/u);
  const index = lines.findIndex((line) => line.startsWith("| CIT-TODO-001"));
  assert.notEqual(index, -1, "fixture must contain the citation placeholder row");
  const original = lines[index]!;
  const cells = original.trim().slice(1, original.trim().endsWith("|") ? -1 : undefined).split("|").map((cell) => cell.trim());
  const next = mutate(cells);
  if (next === null) {
    // Some tests intentionally model an empty citation table. Remove every
    // citation data row so the fixture exercises the scanner's lower-bound
    // check even when the source document contains multiple candidates.
    for (let cursor = lines.length - 1; cursor >= 0; cursor -= 1) {
      if (/^\|\s*CIT-[A-Z0-9-]+\s*\|/u.test(lines[cursor] ?? "")) {
        lines.splice(cursor, 1);
      }
    }
  } else {
    lines[index] = `| ${next.join(" | ")} |`;
  }
  await writeFile(target, lines.join("\n"), "utf8");
}

async function materializedFixture(context: test.TestContext): Promise<string> {
  return fixture(context, true);
}

test("论文三份材料在无旧快照和无结果数字漂移时通过", async (context) => {
  const root = await fixture(context);
  const report = await scanPaperConsistency(root);
  assert.equal(report.ok, true);
  assert.deepEqual(report.issues, []);
  assert.equal(report.files.length, 6);
});

test("Artifact Release 的 Draft/NotRun/NotIncluded/NotVerified 边界通过", async (context) => {
  const root = await fixture(context);
  const report = await scanPaperConsistency(root);
  assert.equal(report.ok, true);
  assert.equal(report.issues.filter((issue) => issue.kind === "manifest-boundary").length, 0);
});

test("旧采样日期、旧覆盖率和旧测试快照 fail-closed", async (context) => {
  const root = await fixture(context);
  const target = path.join(root, "research/paper/MANUSCRIPT-DRAFT.zh-CN.md");
  const original = await readFile(target, "utf8");
  await writeFile(target, `${original}\n旧快照：2026-08-24，覆盖率 91.19，26,803/28,736。\n旧测试：816 total；814 pass。\n`, "utf8");
  const report = await scanPaperConsistency(root);
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((issue) => issue.kind === "stale-token" && issue.message.includes("旧采样日期")));
  assert.ok(report.issues.some((issue) => issue.kind === "stale-token" && issue.message.includes("旧覆盖率")));
  assert.ok(report.issues.some((issue) => issue.kind === "stale-token" && issue.message.includes("旧测试快照")));
});

test("没有 Evidence/Source 绑定的当前结果数字 fail-closed，有绑定的数字允许", async (context) => {
  const root = await fixture(context);
  const target = path.join(root, "research/paper/MANUSCRIPT-DRAFT.zh-CN.md");
  const original = await readFile(target, "utf8");
  await writeFile(target, `${original}\n当前结果成功率为 0.95。\n`, "utf8");
  const failed = await scanPaperConsistency(root);
  assert.equal(failed.ok, false);
  assert.ok(failed.issues.some((issue) => issue.kind === "unbound-number"));

  await writeFile(target, `${original}\n当前结果成功率为 0.95（Evidence: formal-raw-results）。\n`, "utf8");
  const passed = await scanPaperConsistency(root);
  assert.equal(passed.ok, true);
});

test("旧候选 SHA 和旧证据快照 SHA fail-closed", async (context) => {
  const root = await fixture(context);
  const target = path.join(root, PAPER_FILES[0]);
  const original = await readFile(target, "utf8");
  await writeFile(target, `${original}\n旧候选：3c78dca7747c4a87c611007a9148fc36604a1b0a。\n`, "utf8");
  const report = await scanPaperConsistency(root);
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((issue) => issue.kind === "stale-sha"));
});

test("Artifact Release 被改成 formal/Verified 或 schema 漂移时 fail-closed", async (context) => {
  const root = await fixture(context);
  const releasePath = path.join(root, SUPPORT_FILES[1]);
  const release = JSON.parse(await readFile(releasePath, "utf8")) as Record<string, any>;
  release.evidenceState.formalExperiment = "Verified";
  release.claimBoundary = "formal-verified";
  await writeFile(releasePath, `${JSON.stringify(release)}\n`, "utf8");
  const failed = await scanPaperConsistency(root);
  assert.equal(failed.ok, false);
  assert.ok(failed.issues.filter((issue) => issue.kind === "manifest-boundary").length >= 2);

  const clean = await fixture(context);
  const manifestPath = path.join(clean, SUPPORT_FILES[2]);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, any>;
  manifest.schemaVersion = "research-artifact-manifest-v2";
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
  const drifted = await scanPaperConsistency(clean);
  assert.equal(drifted.ok, false);
  assert.ok(drifted.issues.some((issue) => issue.message.includes("schemaVersion")));
});

test("正文缺必要章节时 fail-closed", async (context) => {
  const root = await fixture(context);
  const target = path.join(root, PAPER_FILES[0]);
  const text = await readFile(target, "utf8");
  await writeFile(target, text.replace("## 7. 相关工作", "## 7. 其他"), "utf8");
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.kind === "paper-structure" && issue.message.includes("相关工作")));
});

test("正文把论文写成已完成时 fail-closed", async (context) => {
  const root = await fixture(context);
  const target = path.join(root, PAPER_FILES[0]);
  await writeFile(target, `${await readFile(target, "utf8")}\n论文已经完成，正式结果已验证。\n`, "utf8");
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.kind === "paper-structure"));
});

test("Claim Table JSON 损坏时 fail-closed", async (context) => {
  const root = await fixture(context);
  await writeFile(path.join(root, PAPER_FILES[1]), "{broken\n", "utf8");
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.message.includes("JSON 无法解析")));
});

test("Claim Table 缺 claims 时 fail-closed", async (context) => {
  const root = await fixture(context);
  await writeFile(path.join(root, PAPER_FILES[1]), JSON.stringify({ schemaVersion: "rt95-paper-claim-table-v1" }), "utf8");
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.message.includes("非空 claims")));
});

test("Claim Table 重复 ID 时 fail-closed", async (context) => {
  const root = await fixture(context);
  const target = path.join(root, PAPER_FILES[1]);
  const value = JSON.parse(await readFile(target, "utf8")) as { claims: Array<Record<string, unknown>> };
  value.claims[1]!.id = value.claims[0]!.id;
  await writeFile(target, JSON.stringify(value), "utf8");
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.message.includes("重复")));
});

test("Claim Table evidenceState=Verified 时 fail-closed", async (context) => {
  const root = await fixture(context);
  const target = path.join(root, PAPER_FILES[1]);
  const value = JSON.parse(await readFile(target, "utf8")) as { claims: Array<Record<string, unknown>> };
  value.claims[0]!.evidenceState = "Verified";
  await writeFile(target, JSON.stringify(value), "utf8");
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.message.includes("evidenceState 越界")));
});

test("Claim Table 缺 requiredEvidence 时 fail-closed", async (context) => {
  const root = await fixture(context);
  const target = path.join(root, PAPER_FILES[1]);
  const value = JSON.parse(await readFile(target, "utf8")) as { claims: Array<Record<string, unknown>> };
  delete value.claims[0]!.requiredEvidence;
  await writeFile(target, JSON.stringify(value), "utf8");
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.message.includes("requiredEvidence")));
});

test("引用清单缺一手来源门禁时 fail-closed", async (context) => {
  const root = await fixture(context);
  const target = path.join(root, PAPER_FILES[2]);
  const text = await readFile(target, "utf8");
  await writeFile(target, text.replaceAll("一手来源", "来源"), "utf8");
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.message.includes("一手来源")));
});

test("论文材料出现绝对路径时 fail-closed", async (context) => {
  const root = await fixture(context);
  const target = path.join(root, PAPER_FILES[2]);
  await writeFile(target, `${await readFile(target, "utf8")}\n本机路径：C:\\Users\\secret\\paper.json\n`, "utf8");
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.kind === "path"));
});

test("论文材料出现疑似凭据时 fail-closed", async (context) => {
  const root = await fixture(context);
  const target = path.join(root, PAPER_FILES[0]);
  // Split the fixture token so the repository security scanner does not mistake
  // this intentionally synthetic test input for a committed credential.
  const syntheticCredential = ["sk-", "abcdefghijklmnopqrstuvwxyz123456"].join("");
  await writeFile(target, `${await readFile(target, "utf8")}\n凭据片段：${syntheticCredential}\n`, "utf8");
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.kind === "secret"));
});

test("论文材料缺失时 fail-closed", async (context) => {
  const root = await fixture(context);
  await rm(path.join(root, PAPER_FILES[2]));
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.message.includes("缺失或不可读")));
});

test("引用表头列顺序漂移时 fail-closed", async (context) => {
  const root = await fixture(context);
  const target = path.join(root, PAPER_FILES[2]);
  const text = await readFile(target, "utf8");
  await writeFile(target, text.replace("| Citation ID | 作者 |", "| 作者 | Citation ID |"), "utf8");
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.kind === "citation-structure"));
});

test("引用表没有数据行时 fail-closed", async (context) => {
  const root = await fixture(context);
  await rewriteCitationRow(root, () => null);
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.message.includes("至少一条")));
});

test("引用记录列数不足时 fail-closed", async (context) => {
  const root = await fixture(context);
  await rewriteCitationRow(root, (cells) => cells.slice(0, 8));
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.message.includes("恰好包含 9 列")));
});

test("引用记录列数超出时 fail-closed", async (context) => {
  const root = await fixture(context);
  await rewriteCitationRow(root, (cells) => [...cells, "extra"]);
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.message.includes("恰好包含 9 列")));
});

test("引用 ID 格式非法时 fail-closed", async (context) => {
  const root = await fixture(context);
  await rewriteCitationRow(root, (cells) => ["citation-1", ...cells.slice(1)]);
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.message.includes("非法")));
});

test("引用 ID 重复时 fail-closed", async (context) => {
  const root = await fixture(context);
  await rewriteCitationRow(root, (cells) => ["CIT-TODO-001", ...cells.slice(1)]);
  const target = path.join(root, PAPER_FILES[2]);
  const text = await readFile(target, "utf8");
  const duplicate = "| CIT-TODO-001 | TODO | TODO | TODO | TODO | TODO | NotRun | TODO | NotVerified |";
  await writeFile(target, text.replace("\n## B. Claim", `\n${duplicate}\n\n## B. Claim`), "utf8");
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.message.includes("重复")));
});

test("引用状态超出允许集合时 fail-closed", async (context) => {
  const root = await fixture(context);
  await rewriteCitationRow(root, (cells) => [...cells.slice(0, 8), "CodeVerified"]);
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.message.includes("状态越界")));
});

test("不完整元数据不得声明 Verified", async (context) => {
  const root = await fixture(context);
  await rewriteCitationRow(root, (cells) => ["CIT-EXAMPLE-001", "TODO", "TODO", "TODO", "TODO", "TODO", "Yes", "TODO", "Verified"]);
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.message.includes("Verified 引用必须")));
});

test("TODO 引用占位被升级时 fail-closed", async (context) => {
  const root = await fixture(context);
  await rewriteCitationRow(root, (cells) => [cells[0]!, "作者", ...cells.slice(2)]);
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.message.includes("CIT-TODO-001") && issue.message.includes("占位边界")));
});

test("不安全 citation locator 协议时 fail-closed", async (context) => {
  const root = await fixture(context);
  await rewriteCitationRow(root, (cells) => [...cells.slice(0, 5), "javascript:alert(1)", ...cells.slice(6)]);
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.message.includes("定位符协议不安全")));
});

test("引用清单总状态被改成 Verified 时 fail-closed", async (context) => {
  const root = await fixture(context);
  const target = path.join(root, PAPER_FILES[2]);
  const text = await readFile(target, "utf8");
  await writeFile(target, text.replace("> 当前状态：`NotReviewed / NotVerified`", "> 当前状态：`Verified`"), "utf8");
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.message.includes("总状态必须保持")));
});

test("Verified 引用缺少一手来源确认时 fail-closed", async (context) => {
  const root = await fixture(context);
  await rewriteCitationRow(root, () => ["CIT-EXAMPLE-001", "Author", "Title", "Venue", "2024", "https://example.test/paper", "NotRun", "supports only background", "Verified"]);
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.message.includes("Verified 引用必须")));
});

test("完整 Artifact Release 文件链通过并绑定论文 Claim", async (context) => {
  const root = await materializedFixture(context);
  const report = await scanPaperConsistency(root);
  assert.equal(report.ok, true);
  assert.equal(report.issues.filter((issue) => issue.kind === "artifact-integrity" || issue.kind === "claim-evidence").length, 0);
});

test("Artifact 文件内容漂移时 fail-closed", async (context) => {
  const root = await materializedFixture(context);
  const target = path.join(root, RELEASE_ROOT, "raw/summary.csv");
  await writeFile(target, `${await readFile(target, "utf8")}tampered\n`, "utf8");
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.kind === "artifact-integrity" && issue.message.includes("哈希链漂移")));
});

test("Artifact 文件缺失时 fail-closed", async (context) => {
  const root = await materializedFixture(context);
  await rm(path.join(root, RELEASE_ROOT, "raw/summary.csv"));
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.kind === "artifact-integrity" && issue.message.includes("缺失")));
});

test("Artifact Release 额外文件时 fail-closed", async (context) => {
  const root = await materializedFixture(context);
  await writeFile(path.join(root, RELEASE_ROOT, "post-hoc.txt"), "invented\n", "utf8");
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.kind === "artifact-integrity" && issue.message.includes("额外文件")));
});

test("Artifact Release 符号链接时 fail-closed", async (context) => {
  const root = await materializedFixture(context);
  const link = path.join(root, RELEASE_ROOT, "raw/link.csv");
  try {
    await symlink(path.join(root, RELEASE_ROOT, "raw/summary.csv"), link, "file");
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES" || error.code === "UNKNOWN")) {
      context.skip("Windows symlink privilege is unavailable");
      return;
    }
    throw error;
  }
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.kind === "artifact-integrity" && issue.message.includes("符号链接")));
});

test("Artifact Release releaseSha256 漂移时 fail-closed", async (context) => {
  const root = await materializedFixture(context);
  const target = path.join(root, RELEASE_ROOT, "artifact-release.json");
  const release = JSON.parse(await readFile(target, "utf8")) as Record<string, any>;
  release.releaseSha256 = "0".repeat(64);
  await writeFile(target, `${JSON.stringify(release, null, 2)}\n`, "utf8");
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.kind === "artifact-integrity" && issue.message.includes("releaseSha256")));
});

test("论文 Claim 与 Artifact Claim 内容漂移时 fail-closed", async (context) => {
  const root = await materializedFixture(context);
  const target = path.join(root, RELEASE_ROOT, "claims/CLAIM-TABLE.json");
  const table = JSON.parse(await readFile(target, "utf8")) as { claims: Array<Record<string, any>> };
  table.claims[5]!.allowedClaim = "post-hoc claim";
  await writeFile(target, `${JSON.stringify(table, null, 2)}\n`, "utf8");
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.kind === "claim-evidence" && issue.message.includes("内容漂移")));
});

test("Artifact included Claim 缺失时 fail-closed", async (context) => {
  const root = await materializedFixture(context);
  const target = path.join(root, RELEASE_ROOT, "artifact-release.json");
  const release = JSON.parse(await readFile(target, "utf8")) as Record<string, any>;
  release.claims.includedClaimIds = ["CLAIM-NOT-IN-PAPER"];
  await writeFile(target, `${JSON.stringify(release, null, 2)}\n`, "utf8");
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.kind === "claim-evidence" && issue.message.includes("未在论文表和 Artifact 表同时存在")));
});

test("Artifact Claim Table 路径漂移时 fail-closed", async (context) => {
  const root = await materializedFixture(context);
  const target = path.join(root, RELEASE_ROOT, "artifact-release.json");
  const release = JSON.parse(await readFile(target, "utf8")) as Record<string, any>;
  release.claims.claimTablePath = "../CLAIM-TABLE.json";
  await writeFile(target, `${JSON.stringify(release, null, 2)}\n`, "utf8");
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.kind === "claim-evidence" && issue.message.includes("claimTablePath")));
});

test("Citation 一手来源状态越界时 fail-closed", async (context) => {
  const root = await fixture(context);
  await rewriteCitationRow(root, (cells) => [...cells.slice(0, 6), "Maybe", ...cells.slice(7)]);
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.message.includes("一手来源状态越界")));
});

test("Citation 年份未来或格式漂移时 fail-closed", async (context) => {
  const root = await fixture(context);
  await rewriteCitationRow(root, (cells) => ["CIT-EXAMPLE-001", "Author", "Title", "Venue", "2099", "https://example.test/paper", "Yes", "supports background", "NotVerified"]);
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.message.includes("年份非法")));
});

test("Citation 非 HTTPS/DOI 定位符时 fail-closed", async (context) => {
  const root = await fixture(context);
  await rewriteCitationRow(root, (cells) => ["CIT-EXAMPLE-001", "Author", "Title", "Venue", "2024", "search result", "Yes", "supports background", "NotVerified"]);
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.message.includes("HTTPS 或 DOI")));
});

test("Claim Table schemaVersion 漂移时 fail-closed", async (context) => {
  const root = await fixture(context);
  const target = path.join(root, PAPER_FILES[1]);
  const value = JSON.parse(await readFile(target, "utf8")) as Record<string, unknown>;
  value.schemaVersion = "rt95-paper-claim-table-v2";
  await writeFile(target, `${JSON.stringify(value)}\n`, "utf8");
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.message.includes("Claim Table schemaVersion")));
});

test("Claim Table policy 被改成可声称 Verified 时 fail-closed", async (context) => {
  const root = await fixture(context);
  const target = path.join(root, PAPER_FILES[1]);
  const value = JSON.parse(await readFile(target, "utf8")) as Record<string, any>;
  value.policy.defaultEvidenceState = "Verified";
  value.policy.significanceClaimed = true;
  await writeFile(target, `${JSON.stringify(value)}\n`, "utf8");
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.message.includes("policy 必须保持 fail-closed")));
});

test("Claim 缺 topic 时 fail-closed", async (context) => {
  const root = await fixture(context);
  const target = path.join(root, PAPER_FILES[1]);
  const value = JSON.parse(await readFile(target, "utf8")) as { claims: Array<Record<string, any>> };
  delete value.claims[0]!.topic;
  await writeFile(target, `${JSON.stringify(value)}\n`, "utf8");
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.message.includes("topic 缺失")));
});

test("Claim requiredEvidence 重复或空值时 fail-closed", async (context) => {
  const root = await fixture(context);
  const target = path.join(root, PAPER_FILES[1]);
  const value = JSON.parse(await readFile(target, "utf8")) as { claims: Array<Record<string, any>> };
  value.claims[0]!.requiredEvidence = ["same", "same", "  "];
  await writeFile(target, `${JSON.stringify(value)}\n`, "utf8");
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.message.includes("requiredEvidence 必须为唯一非空字符串")));
});

test("Artifact Manifest real Provider 越界时 fail-closed", async (context) => {
  const root = await fixture(context);
  const target = path.join(root, SUPPORT_FILES[2]);
  const value = JSON.parse(await readFile(target, "utf8")) as Record<string, any>;
  value.provider.kind = "real-provider";
  value.provider.credentialsRead = true;
  value.provider.realApiCalls = true;
  await writeFile(target, `${JSON.stringify(value)}\n`, "utf8");
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.message.includes("Provider 必须保持 deterministic-fake")));
});

test("Artifact Manifest run 缺 deterministic 命令时 fail-closed", async (context) => {
  const root = await fixture(context);
  const target = path.join(root, SUPPORT_FILES[2]);
  const value = JSON.parse(await readFile(target, "utf8")) as Record<string, any>;
  value.run.command = "npm test";
  await writeFile(target, `${JSON.stringify(value)}\n`, "utf8");
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.message.includes("deterministic 命令")));
});

test("Artifact Manifest 文件摘要非法时 fail-closed", async (context) => {
  const root = await fixture(context);
  const target = path.join(root, SUPPORT_FILES[2]);
  const value = JSON.parse(await readFile(target, "utf8")) as Record<string, any>;
  value.files[0].sha256 = "bad";
  value.files[0].bytes = 0;
  await writeFile(target, `${JSON.stringify(value)}\n`, "utf8");
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.message.includes("文件条目必须包含合法")));
});

test("Artifact Release 文件路径排序漂移时 fail-closed", async (context) => {
  const root = await materializedFixture(context);
  const target = path.join(root, RELEASE_ROOT, "artifact-release.json");
  const value = JSON.parse(await readFile(target, "utf8")) as Record<string, any>;
  [value.files[0], value.files[1]] = [value.files[1], value.files[0]];
  await writeFile(target, `${JSON.stringify(value)}\n`, "utf8");
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.message.includes("files 必须按规范化路径排序")));
});

test("Artifact Release role 缺失时 fail-closed", async (context) => {
  const root = await materializedFixture(context);
  const target = path.join(root, RELEASE_ROOT, "artifact-release.json");
  const value = JSON.parse(await readFile(target, "utf8")) as Record<string, any>;
  delete value.files[0].role;
  await writeFile(target, `${JSON.stringify(value)}\n`, "utf8");
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.message.includes("文件 role 缺失")));
});

test("Artifact Release contentType 与路径不一致时 fail-closed", async (context) => {
  const root = await materializedFixture(context);
  const target = path.join(root, RELEASE_ROOT, "artifact-release.json");
  const value = JSON.parse(await readFile(target, "utf8")) as Record<string, any>;
  const jsonFile = value.files.find((entry: Record<string, any>) => String(entry.path).endsWith(".json"));
  jsonFile.contentType = "text/plain";
  await writeFile(target, `${JSON.stringify(value)}\n`, "utf8");
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.message.includes("contentType 与路径不一致")));
});

test("Artifact Claim Table 重复 ID 时 fail-closed", async (context) => {
  const root = await materializedFixture(context);
  const target = path.join(root, RELEASE_ROOT, "claims/CLAIM-TABLE.json");
  const value = JSON.parse(await readFile(target, "utf8")) as { claims: Array<Record<string, any>> };
  value.claims.push({ ...value.claims[0] });
  await writeFile(target, `${JSON.stringify(value)}\n`, "utf8");
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.message.includes("ID 必须合法且唯一")));
});

test("Artifact Claim Table schemaVersion 漂移时 fail-closed", async (context) => {
  const root = await materializedFixture(context);
  const target = path.join(root, RELEASE_ROOT, "claims/CLAIM-TABLE.json");
  const value = JSON.parse(await readFile(target, "utf8")) as Record<string, any>;
  value.schemaVersion = "rt95-paper-claim-table-v2";
  await writeFile(target, `${JSON.stringify(value)}\n`, "utf8");
  const report = await scanPaperConsistency(root);
  assert.ok(report.issues.some((issue) => issue.message.includes("Artifact Release Claim Table schemaVersion")));
});
