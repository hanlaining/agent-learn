import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

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

const SCAN_FILES = [...PAPER_FILES, ...SUPPORT_FILES] as const;
const ARTIFACT_RELEASE = SUPPORT_FILES[1];
const ARTIFACT_MANIFEST = SUPPORT_FILES[2];
const ARTIFACT_RELEASE_ROOT = "research/artifact-releases/local-tooling-v0.1.0/release";
const STALE_SHAS = [
  "3c78dca7747c4a87c611007a9148fc36604a1b0a",
  "1f366bcab693240e1834a1c25faaadbb53ca01ad63326bf49592ad294e20ad97",
  "ed74a8f05b7629ad7dd7589f971897c930d20d7d737af6e00a840ada861dd439",
] as const;

const STALE_TOKENS: ReadonlyArray<[string, string]> = [
  ["2026-08-24", "旧采样日期"],
  ["91.19", "旧覆盖率"],
  ["26,146/28,672", "旧覆盖分子/分母"],
  ["26,604/28,672", "旧覆盖分子/分母"],
  ["26,803/28,736", "旧覆盖分子/分母"],
  ["26,808/28,736", "旧覆盖分子/分母"],
  ["736 total", "旧测试快照"],
  ["735 pass", "旧测试快照"],
  ["780 total", "旧测试快照"],
  ["816 total", "旧测试快照"],
  ["822 total", "旧测试快照"],
  ["2026-08-20", "旧采样日期"],
];

export interface PaperConsistencyIssue {
  file: string;
  line: number;
  kind: "stale-token" | "stale-sha" | "unbound-number" | "manifest-boundary" | "artifact-integrity" | "claim-evidence" | "paper-structure" | "citation-structure" | "secret" | "path";
  message: string;
  excerpt: string;
}

export interface PaperConsistencyReport {
  ok: boolean;
  files: string[];
  issues: PaperConsistencyIssue[];
}

export async function scanPaperConsistency(workspaceRoot: string): Promise<PaperConsistencyReport> {
  const issues: PaperConsistencyIssue[] = [];
  const contents = new Map<string, string>();
  for (const relative of SCAN_FILES) {
    const absolute = path.resolve(workspaceRoot, relative);
    let text: string;
    try {
      text = await readFile(absolute, "utf8");
    } catch (error) {
      issues.push({ file: relative, line: 1, kind: "paper-structure", message: `论文/证据文件缺失或不可读: ${String(error)}`, excerpt: "" });
      continue;
    }
    contents.set(relative, text);
    const lines = text.split(/\r?\n/u);
    lines.forEach((line, index) => {
      const lineNumber = index + 1;
      for (const [token, description] of STALE_TOKENS) {
        if (line.includes(token) && !isBoundedArtifactMetadata(relative, token)) {
          issues.push({ file: relative, line: lineNumber, kind: "stale-token", message: `${description}: ${token}`, excerpt: line.trim() });
        }
      }
      for (const sha of STALE_SHAS) {
        if (line.toLowerCase().includes(sha)) {
          issues.push({ file: relative, line: lineNumber, kind: "stale-sha", message: `旧候选或证据 SHA: ${sha}`, excerpt: line.trim() });
        }
      }
      if (PAPER_FILES.includes(relative as typeof PAPER_FILES[number]) && !line.trimStart().startsWith("```") && isUnboundResultNumber(line)) {
        issues.push({
          file: relative,
          line: lineNumber,
          kind: "unbound-number",
          message: "结果数字必须在同一行绑定 Evidence/Source/Artifact 引用",
          excerpt: line.trim(),
        });
      }
    });
  }
  validatePaperStructures(contents, issues);
  await validateArtifactBoundaries(workspaceRoot, issues);
  return { ok: issues.length === 0, files: [...SCAN_FILES], issues };
}

function validatePaperStructures(contents: ReadonlyMap<string, string>, issues: PaperConsistencyIssue[]): void {
  const manuscript = contents.get(PAPER_FILES[0]);
  const claimsText = contents.get(PAPER_FILES[1]);
  const checklist = contents.get(PAPER_FILES[2]);
  if (manuscript !== undefined) {
    for (const required of ["TODO/NotVerified", "## 5. 有效性威胁", "## 7. 相关工作", "## 8. 可复现性与开放材料"]) {
      if (!manuscript.includes(required)) {
        issues.push({ file: PAPER_FILES[0], line: 1, kind: "paper-structure", message: `正文缺少必要边界/章节: ${required}`, excerpt: "" });
      }
    }
    if (/论文(?:已经|已)完成|正式结果(?:已经|已)验证|formalVerified\s*=\s*(?:true|95)/iu.test(manuscript)) {
      issues.push({ file: PAPER_FILES[0], line: 1, kind: "paper-structure", message: "正文存在未被证据支持的完成/Verified 主张", excerpt: "" });
    }
    if (/(?:[A-Za-z]:\\|(?:^|\s)\/(?:Users|home|var|tmp)\/)/u.test(manuscript)) {
      issues.push({ file: PAPER_FILES[0], line: 1, kind: "path", message: "正文包含绝对或本机路径", excerpt: "" });
    }
    const secret = manuscript.match(/(?:sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})/u);
    if (secret) issues.push({ file: PAPER_FILES[0], line: 1, kind: "secret", message: "正文包含疑似凭据片段", excerpt: secret[0].slice(0, 8) + "…" });
  }
  if (claimsText !== undefined) {
    try {
      const root = JSON.parse(claimsText) as Record<string, unknown>;
      if (root.schemaVersion !== "rt95-paper-claim-table-v1") {
        issues.push({ file: PAPER_FILES[1], line: 1, kind: "paper-structure", message: "Claim Table schemaVersion 漂移", excerpt: String(root.schemaVersion) });
      }
      const policy = asRecord(root.policy);
      if (policy.defaultEvidenceState !== "NotVerified" || policy.significanceClaimed !== false
        || typeof policy.unknownOrMissingEvidence !== "string" || typeof policy.negativeAndNullResults !== "string") {
        issues.push({ file: PAPER_FILES[1], line: 1, kind: "paper-structure", message: "Claim Table policy 必须保持 fail-closed 的未验证边界", excerpt: JSON.stringify(policy) });
      }
      const claims = root.claims;
      if (!Array.isArray(claims) || claims.length === 0) {
        issues.push({ file: PAPER_FILES[1], line: 1, kind: "paper-structure", message: "Claim Table 必须包含非空 claims 数组", excerpt: "" });
      } else {
        const ids = new Set<string>();
        claims.forEach((value, index) => {
          const claim = asRecord(value);
          const id = typeof claim.id === "string" ? claim.id : "";
          if (!/^CLAIM-[A-Z0-9-]+$/u.test(id) || ids.has(id)) {
            issues.push({ file: PAPER_FILES[1], line: index + 1, kind: "paper-structure", message: `Claim ID 缺失、非法或重复: ${id || "<empty>"}`, excerpt: "" });
          }
          ids.add(id);
          if (claim.evidenceState !== "CodeVerified" && claim.evidenceState !== "NotVerified") {
            issues.push({ file: PAPER_FILES[1], line: index + 1, kind: "paper-structure", message: `Claim evidenceState 越界: ${String(claim.evidenceState)}`, excerpt: id });
          }
          if (typeof claim.allowedClaim !== "string" || typeof claim.forbiddenClaim !== "string" ||
            !Array.isArray(claim.requiredEvidence) || claim.requiredEvidence.length === 0) {
            issues.push({ file: PAPER_FILES[1], line: index + 1, kind: "paper-structure", message: `Claim ${id || "<empty>"} 缺 allowed/forbidden/requiredEvidence`, excerpt: "" });
          }
          if (typeof claim.topic !== "string" || claim.topic.trim() === "") {
            issues.push({ file: PAPER_FILES[1], line: index + 1, kind: "paper-structure", message: `Claim ${id || "<empty>"} topic 缺失`, excerpt: "" });
          }
          if (typeof claim.allowedClaim === "string" && claim.allowedClaim.trim() === "") {
            issues.push({ file: PAPER_FILES[1], line: index + 1, kind: "paper-structure", message: `Claim ${id || "<empty>"} allowedClaim 不能为空`, excerpt: "" });
          }
          if (typeof claim.forbiddenClaim === "string" && claim.forbiddenClaim.trim() === "") {
            issues.push({ file: PAPER_FILES[1], line: index + 1, kind: "paper-structure", message: `Claim ${id || "<empty>"} forbiddenClaim 不能为空`, excerpt: "" });
          }
          if (Array.isArray(claim.requiredEvidence)) {
            const evidence = claim.requiredEvidence;
            const normalized = evidence.filter((item): item is string => typeof item === "string").map((item) => item.trim());
            if (normalized.length !== evidence.length || normalized.some((item) => item.length === 0)
              || new Set(normalized).size !== normalized.length) {
              issues.push({ file: PAPER_FILES[1], line: index + 1, kind: "paper-structure", message: `Claim ${id || "<empty>"} requiredEvidence 必须为唯一非空字符串`, excerpt: JSON.stringify(evidence) });
            }
          }
        });
      }
    } catch (error) {
      issues.push({ file: PAPER_FILES[1], line: 1, kind: "paper-structure", message: `Claim Table JSON 无法解析: ${String(error)}`, excerpt: "" });
    }
  }
  if (checklist !== undefined) {
    for (const required of ["NotReviewed / NotVerified", "CIT-TODO-001", "一手来源", "同作者同机器复跑写成独立复现"]) {
      if (!checklist.includes(required)) {
        issues.push({ file: PAPER_FILES[2], line: 1, kind: "paper-structure", message: `引用审阅清单缺少门禁: ${required}`, excerpt: "" });
      }
    }
    const secret = checklist.match(/(?:sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})/u);
    if (secret) issues.push({ file: PAPER_FILES[2], line: 1, kind: "secret", message: "引用清单包含疑似凭据片段", excerpt: secret[0].slice(0, 8) + "…" });
    if (/(?:[A-Za-z]:\\|(?:^|\s)\/(?:Users|home|var|tmp)\/)/u.test(checklist)) {
      issues.push({ file: PAPER_FILES[2], line: 1, kind: "path", message: "引用清单包含绝对或本机路径", excerpt: "" });
    }
    validateCitationTable(checklist, issues);
  }
}

/**
 * Validate the citation table as a claim-boundary contract.  This deliberately
 * checks metadata shape and state transitions only; it never treats a local
 * placeholder, search result, or code test as a verified citation.
 */
function validateCitationTable(checklist: string, issues: PaperConsistencyIssue[]): void {
  const lines = checklist.split(/\r?\n/u);
  const sectionIndex = lines.findIndex((line) => /^## A\. /u.test(line.trim()));
  const headerIndex = lines.findIndex((line, index) => index > sectionIndex && /^\|\s*Citation ID\s*\|/u.test(line.trim()));
  if (sectionIndex < 0 || headerIndex < 0) {
    issues.push({ file: PAPER_FILES[2], line: 1, kind: "citation-structure", message: "引用表缺少规范的 Citation ID 表头", excerpt: "" });
    return;
  }
  const header = splitMarkdownTableRow(lines[headerIndex]!);
  const expectedHeader = ["Citation ID", "作者", "标题", "出处/版本", "年份", "DOI/稳定 URL", "一手来源已打开", "与 Claim 的支持范围", "状态"];
  if (header.length !== expectedHeader.length || header.some((cell, index) => cell !== expectedHeader[index])) {
    issues.push({ file: PAPER_FILES[2], line: headerIndex + 1, kind: "citation-structure", message: "引用表列顺序或列数漂移", excerpt: lines[headerIndex]!.trim() });
  }
  const rows: Array<{ cells: string[]; line: number }> = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^##\s/u.test(line.trim())) break;
    if (!/^\|/u.test(line.trim()) || /^\|\s*:?-{3,}/u.test(line.trim())) continue;
    rows.push({ cells: splitMarkdownTableRow(line), line: index + 1 });
  }
  if (rows.length === 0) {
    issues.push({ file: PAPER_FILES[2], line: headerIndex + 1, kind: "citation-structure", message: "引用表必须保留至少一条待核验记录", excerpt: "" });
    return;
  }
  const ids = new Set<string>();
  for (const row of rows) {
    const [rawId = "", rawAuthor = "", rawTitle = "", rawVenue = "", rawYear = "", rawLocator = "", rawFirstParty = "", rawScope = "", rawStatus = ""] = row.cells;
    const [id = "", author = "", title = "", venue = "", year = "", locator = "", firstParty = "", scope = "", status = ""] = [rawId, rawAuthor, rawTitle, rawVenue, rawYear, rawLocator, rawFirstParty, rawScope, rawStatus].map(normalizeCitationCell);
    if (row.cells.length !== expectedHeader.length) {
      issues.push({ file: PAPER_FILES[2], line: row.line, kind: "citation-structure", message: "引用记录必须恰好包含 9 列", excerpt: lines[row.line - 1]!.trim() });
      continue;
    }
    if (!/^CIT-[A-Z0-9-]+$/u.test(id) || ids.has(id)) {
      issues.push({ file: PAPER_FILES[2], line: row.line, kind: "citation-structure", message: `Citation ID 缺失、非法或重复: ${id || "<empty>"}`, excerpt: id });
    }
    ids.add(id);
    if (!["NotRun", "NotVerified", "Verified"].includes(status)) {
      issues.push({ file: PAPER_FILES[2], line: row.line, kind: "citation-structure", message: `引用状态越界: ${status || "<empty>"}`, excerpt: id });
    }
    if (status === "Verified" && (firstParty !== "Yes" || [author, title, venue, year, locator, scope].some((value) => !value || /TODO|NotRun/iu.test(value)))) {
      issues.push({ file: PAPER_FILES[2], line: row.line, kind: "citation-structure", message: "Verified 引用必须有完整元数据、一手来源确认和支持范围", excerpt: id });
    }
    if (!["Yes", "No", "NotRun"].includes(firstParty)) {
      issues.push({ file: PAPER_FILES[2], line: row.line, kind: "citation-structure", message: `一手来源状态越界: ${firstParty || "<empty>"}`, excerpt: id });
    }
    if (year !== "TODO" && year !== "NotRun" && (!/^\d{4}$/u.test(year) || Number(year) > new Date().getUTCFullYear())) {
      issues.push({ file: PAPER_FILES[2], line: row.line, kind: "citation-structure", message: `引用年份非法或晚于当前年份: ${year}`, excerpt: id });
    }
    if (id === "CIT-TODO-001" && (author !== "TODO" || title !== "TODO" || venue !== "TODO" || year !== "TODO" || locator !== "TODO" || firstParty !== "NotRun" || scope !== "TODO" || status !== "NotVerified")) {
      issues.push({ file: PAPER_FILES[2], line: row.line, kind: "citation-structure", message: "CIT-TODO-001 必须保持 TODO/NotRun/NotVerified 占位边界", excerpt: id });
    }
    if (/^(?:javascript|data|file):/iu.test(locator)) {
      issues.push({ file: PAPER_FILES[2], line: row.line, kind: "citation-structure", message: "引用定位符协议不安全", excerpt: locator });
    }
    if (locator !== "TODO" && locator !== "NotRun" && !/^(?:https:\/\/|doi:10\.)/iu.test(locator)) {
      issues.push({ file: PAPER_FILES[2], line: row.line, kind: "citation-structure", message: "引用定位符必须是 HTTPS 或 DOI 一手来源地址", excerpt: locator });
    }
  }
  if (!checklist.includes("> 当前状态：`NotReviewed / NotVerified`")) {
    issues.push({ file: PAPER_FILES[2], line: 1, kind: "citation-structure", message: "引用清单总状态必须保持 NotReviewed / NotVerified", excerpt: "" });
  }
}

function splitMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim();
  const body = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const withoutTrailing = body.endsWith("|") ? body.slice(0, -1) : body;
  return withoutTrailing.split("|").map((cell) => cell.trim());
}

function normalizeCitationCell(value: string): string {
  return value.trim().replace(/^`|`$/gu, "");
}

function isBoundedArtifactMetadata(relative: string, token: string): boolean {
  // The release bundle intentionally records its historical run timestamp; its claim boundary
  // and Draft/NotRun states are checked semantically below instead of treating metadata as paper results.
  return relative === ARTIFACT_MANIFEST && token === "2026-08-20";
}

async function validateArtifactBoundaries(workspaceRoot: string, issues: PaperConsistencyIssue[]): Promise<void> {
  const releasePath = path.resolve(workspaceRoot, ARTIFACT_RELEASE);
  const manifestPath = path.resolve(workspaceRoot, ARTIFACT_MANIFEST);
  const canonicalClaimPath = path.resolve(workspaceRoot, PAPER_FILES[1]);
  let release: unknown;
  let manifest: unknown;
  let canonicalClaims: unknown;
  try {
    release = JSON.parse(await readFile(releasePath, "utf8")) as unknown;
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    canonicalClaims = JSON.parse(await readFile(canonicalClaimPath, "utf8")) as unknown;
  } catch (error) {
    issues.push({ file: ARTIFACT_RELEASE, line: 1, kind: "manifest-boundary", message: `Artifact Manifest JSON 无法读取或解析: ${String(error)}`, excerpt: "" });
    return;
  }
  const releaseRecord = asRecord(release);
  const state = asRecord(releaseRecord.evidenceState);
  const review = asRecord(releaseRecord.review);
  const boundary = releaseRecord.claimBoundary;
  const expectedStates: Record<string, string> = {
    externalReproduction: "NotVerified",
    formalExperiment: "NotRun",
    formalRaw: "NotIncluded",
    preregistration: "Draft",
    publicationReview: "NotReviewed",
  };
  if (boundary !== "local-tooling-only-not-formal-or-external") {
    issues.push({ file: ARTIFACT_RELEASE, line: 1, kind: "manifest-boundary", message: "Artifact Release claimBoundary 越界", excerpt: String(boundary) });
  }
  for (const [key, expected] of Object.entries(expectedStates)) {
    if (state[key] !== expected) {
      issues.push({ file: ARTIFACT_RELEASE, line: 1, kind: "manifest-boundary", message: `Artifact Release ${key} 必须保持 ${expected}`, excerpt: JSON.stringify(state) });
    }
  }
  if (review.formalEvidenceReviewed !== false || review.independentReview !== false || review.status !== "local-tooling-reviewed") {
    issues.push({ file: ARTIFACT_RELEASE, line: 1, kind: "manifest-boundary", message: "Artifact Release review 状态不能冒充正式或独立审阅", excerpt: JSON.stringify(review) });
  }
  const manifestRecord = asRecord(manifest);
  if (manifestRecord.schemaVersion !== "research-artifact-manifest-v1") {
    issues.push({ file: ARTIFACT_MANIFEST, line: 1, kind: "manifest-boundary", message: "Artifact Manifest schemaVersion 漂移", excerpt: String(manifestRecord.schemaVersion) });
  }
  const provider = asRecord(manifestRecord.provider);
  if (provider.kind !== "deterministic-fake" || provider.credentialsRead !== false || provider.realApiCalls !== false) {
    issues.push({ file: ARTIFACT_MANIFEST, line: 1, kind: "manifest-boundary", message: "Artifact Manifest Provider 必须保持 deterministic-fake 且不读取凭据、不发起真实调用", excerpt: JSON.stringify(provider) });
  }
  const manifestRun = asRecord(manifestRecord.run);
  if (typeof manifestRun.startedAt !== "string" || typeof manifestRun.finishedAt !== "string"
    || typeof manifestRun.command !== "string" || !manifestRun.command.includes("verify-determinism")) {
    issues.push({ file: ARTIFACT_MANIFEST, line: 1, kind: "manifest-boundary", message: "Artifact Manifest run 必须包含可审计的 deterministic 命令和时间边界", excerpt: JSON.stringify(manifestRun) });
  }
  const manifestFiles = manifestRecord.files;
  if (!Array.isArray(manifestFiles) || manifestFiles.length === 0) {
    issues.push({ file: ARTIFACT_MANIFEST, line: 1, kind: "manifest-boundary", message: "Artifact Manifest files 必须为非空数组", excerpt: "" });
  } else {
    const paths = manifestFiles.map((entry) => asRecord(entry).path);
    if (paths.some((entry) => typeof entry !== "string" || entry.trim() === "") || new Set(paths).size !== paths.length) {
      issues.push({ file: ARTIFACT_MANIFEST, line: 1, kind: "manifest-boundary", message: "Artifact Manifest files 路径必须唯一且非空", excerpt: JSON.stringify(paths) });
    }
    for (const [index, value] of manifestFiles.entries()) {
      const entry = asRecord(value);
      if (!isSha256(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1
        || typeof entry.contentType !== "string" || typeof entry.path !== "string") {
        issues.push({ file: ARTIFACT_MANIFEST, line: index + 1, kind: "manifest-boundary", message: "Artifact Manifest 文件条目必须包含合法 path/contentType/bytes/sha256", excerpt: JSON.stringify(entry) });
      }
    }
  }
  validateReleaseDigest(releaseRecord, issues);
  await validateReleaseFileChain(workspaceRoot, releaseRecord, issues);
  await validateClaimEvidenceArtifactBinding(workspaceRoot, releaseRecord, canonicalClaims, issues);
}

function validateReleaseDigest(release: Record<string, any>, issues: PaperConsistencyIssue[]): void {
  const digest = release.releaseSha256;
  if (!isSha256(digest)) {
    issues.push({ file: ARTIFACT_RELEASE, line: 1, kind: "artifact-integrity", message: "Artifact Release 缺少合法 releaseSha256", excerpt: String(digest) });
    return;
  }
  const { releaseSha256: _omitted, ...withoutDigest } = release;
  if (digestCanonical(withoutDigest) !== digest) {
    issues.push({ file: ARTIFACT_RELEASE, line: 1, kind: "artifact-integrity", message: "Artifact Release releaseSha256 与规范化内容不一致", excerpt: digest });
  }
}

async function validateReleaseFileChain(workspaceRoot: string, release: Record<string, any>, issues: PaperConsistencyIssue[]): Promise<void> {
  const releaseRoot = path.resolve(workspaceRoot, ARTIFACT_RELEASE_ROOT);
  // Paper-only callers may provide the boundary manifests without materializing
  // the publishable release payload. Preserve that contract; once either the
  // claim table or derivation receipt is present, the release is materialized
  // and the complete file chain becomes mandatory.
  const materialized = await Promise.any([
    lstat(path.join(releaseRoot, "claims/CLAIM-TABLE.json")),
    lstat(path.join(releaseRoot, "raw/publishable-derivation-receipt.json")),
  ]).then(() => true).catch(() => false);
  if (!materialized) return;
  const entries = Array.isArray(release.files) ? release.files : [];
  if (entries.length === 0) {
    issues.push({ file: ARTIFACT_RELEASE, line: 1, kind: "artifact-integrity", message: "Artifact Release files 必须为非空数组", excerpt: "" });
    return;
  }
  const seen = new Set<string>();
  const declared = new Set<string>();
  let previousPath = "";
  for (const [index, value] of entries.entries()) {
    const entry = asRecord(value);
    const relative = typeof entry.path === "string" ? entry.path : "";
    const normalized = relative.replaceAll("\\", "/");
    if (!relative || normalized !== path.posix.normalize(normalized) || path.posix.isAbsolute(normalized)
      || normalized.split("/").includes("..") || normalized === "artifact-release.json" || seen.has(normalized)) {
      issues.push({ file: ARTIFACT_RELEASE, line: 1, kind: "artifact-integrity", message: `Artifact 文件路径非法、越界或重复: ${relative || "<empty>"}`, excerpt: relative });
      continue;
    }
    seen.add(normalized);
    declared.add(normalized);
    if (index > 0 && normalized < previousPath) {
      issues.push({ file: ARTIFACT_RELEASE, line: index + 1, kind: "artifact-integrity", message: "Artifact Release files 必须按规范化路径排序", excerpt: `${previousPath} -> ${normalized}` });
    }
    previousPath = normalized;
    if (typeof entry.role !== "string" || entry.role.trim() === "") {
      issues.push({ file: ARTIFACT_RELEASE, line: index + 1, kind: "artifact-integrity", message: `Artifact 文件 role 缺失: ${normalized}`, excerpt: JSON.stringify(entry) });
    }
    const expectedContentType = contentTypeForPath(normalized);
    if (expectedContentType !== undefined && entry.contentType !== expectedContentType) {
      issues.push({ file: ARTIFACT_RELEASE, line: index + 1, kind: "artifact-integrity", message: `Artifact 文件 contentType 与路径不一致: ${normalized}`, excerpt: `declared=${String(entry.contentType)}; expected=${expectedContentType}` });
    }
    if (!isSha256(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1) {
      issues.push({ file: ARTIFACT_RELEASE, line: 1, kind: "artifact-integrity", message: `Artifact 文件摘要或字节数非法: ${normalized}`, excerpt: JSON.stringify(entry) });
      continue;
    }
    const absolute = path.resolve(releaseRoot, ...normalized.split("/"));
    const relativeToRoot = path.relative(releaseRoot, absolute);
    if (relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {
      issues.push({ file: ARTIFACT_RELEASE, line: 1, kind: "artifact-integrity", message: `Artifact 文件路径逃出 release 根目录: ${normalized}`, excerpt: normalized });
      continue;
    }
    try {
      const status = await lstat(absolute);
      if (!status.isFile() || status.isSymbolicLink()) throw new Error("not a regular file");
      const bytes = await readFile(absolute);
      const actualDigest = sha256(bytes);
      if (bytes.byteLength !== entry.bytes || actualDigest !== entry.sha256) {
        issues.push({ file: ARTIFACT_RELEASE, line: 1, kind: "artifact-integrity", message: `Artifact 文件哈希链漂移: ${normalized}`, excerpt: `declared=${entry.sha256}; actual=${actualDigest}` });
      }
    } catch (error) {
      issues.push({ file: ARTIFACT_RELEASE, line: 1, kind: "artifact-integrity", message: `Artifact 文件缺失、不安全或不可读: ${normalized}`, excerpt: String(error) });
    }
  }
  const actual = await collectRegularFiles(releaseRoot, issues);
  for (const relative of actual) if (!declared.has(relative)) {
    issues.push({ file: ARTIFACT_RELEASE, line: 1, kind: "artifact-integrity", message: `Artifact Release 存在未声明额外文件: ${relative}`, excerpt: relative });
  }
}

function contentTypeForPath(relative: string): string | undefined {
  if (relative === "LICENSE") return "application/octet-stream";
  if (relative.endsWith(".json")) return "application/json";
  if (relative.endsWith(".csv")) return "text/csv";
  if (relative.endsWith(".md")) return "text/markdown";
  if (relative.endsWith(".txt")) return "text/plain";
  return undefined;
}

async function collectRegularFiles(root: string, issues: PaperConsistencyIssue[]): Promise<string[]> {
  const files: string[] = [];
  async function walk(relativeDirectory: string): Promise<void> {
    const directory = relativeDirectory ? path.resolve(root, ...relativeDirectory.split("/")) : root;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      issues.push({ file: ARTIFACT_RELEASE, line: 1, kind: "artifact-integrity", message: `Artifact Release 目录不可读: ${relativeDirectory || "."}`, excerpt: String(error) });
      return;
    }
    for (const item of entries) {
      const relative = relativeDirectory ? `${relativeDirectory}/${item.name}` : item.name;
      if (relative === "artifact-release.json") continue;
      const absolute = path.resolve(root, ...relative.split("/"));
      if (item.isSymbolicLink()) {
        issues.push({ file: ARTIFACT_RELEASE, line: 1, kind: "artifact-integrity", message: `Artifact Release 禁止符号链接: ${relative}`, excerpt: relative });
      } else if (item.isDirectory()) await walk(relative);
      else if (item.isFile()) files.push(relative);
      else issues.push({ file: ARTIFACT_RELEASE, line: 1, kind: "artifact-integrity", message: `Artifact Release 存在不支持的目录项: ${relative}`, excerpt: String(absolute) });
    }
  }
  await walk("");
  return files.sort();
}

async function validateClaimEvidenceArtifactBinding(
  workspaceRoot: string,
  release: Record<string, any>,
  canonicalClaimsValue: unknown,
  issues: PaperConsistencyIssue[],
): Promise<void> {
  const releaseRoot = path.resolve(workspaceRoot, ARTIFACT_RELEASE_ROOT);
  const materialized = await Promise.any([
    lstat(path.join(releaseRoot, "claims/CLAIM-TABLE.json")),
    lstat(path.join(releaseRoot, "raw/publishable-derivation-receipt.json")),
  ]).then(() => true).catch(() => false);
  if (!materialized) return;
  const canonicalClaims = asRecord(canonicalClaimsValue);
  const canonical = Array.isArray(canonicalClaims.claims) ? canonicalClaims.claims.map(asRecord) : [];
  const canonicalById = new Map(canonical.filter((claim) => typeof claim.id === "string").map((claim) => [claim.id as string, claim]));
  const claims = asRecord(release.claims);
  const claimPath = claims.claimTablePath;
  const included = Array.isArray(claims.includedClaimIds) ? claims.includedClaimIds : [];
  if (claims.includedEvidenceState !== "CodeVerified" || typeof claimPath !== "string") {
    issues.push({ file: ARTIFACT_RELEASE, line: 1, kind: "claim-evidence", message: "Artifact Release Claim binding 缺失或状态越界", excerpt: JSON.stringify(claims) });
    return;
  }
  if (claimPath !== "claims/CLAIM-TABLE.json") {
    issues.push({ file: ARTIFACT_RELEASE, line: 1, kind: "claim-evidence", message: "Artifact Release claimTablePath 越界", excerpt: claimPath });
  }
  const sorted = [...included].sort();
  if (sorted.some((id, index) => typeof id !== "string" || id.length === 0 || id !== included[index] || (index > 0 && sorted[index - 1] === id))) {
    issues.push({ file: ARTIFACT_RELEASE, line: 1, kind: "claim-evidence", message: "includedClaimIds 必须为排序且唯一的非空 ID", excerpt: JSON.stringify(included) });
  }
  const releaseClaimPath = path.resolve(releaseRoot, ...String(claimPath).split("/"));
  let releaseClaims: Record<string, any>;
  try { releaseClaims = asRecord(JSON.parse(await readFile(releaseClaimPath, "utf8"))); }
  catch (error) {
    issues.push({ file: ARTIFACT_RELEASE, line: 1, kind: "claim-evidence", message: "Artifact Release Claim Table 缺失或不可解析", excerpt: String(error) });
    return;
  }
  if (releaseClaims.schemaVersion !== "rt95-paper-claim-table-v1") {
    issues.push({ file: `${ARTIFACT_RELEASE_ROOT}/${claimPath}`, line: 1, kind: "claim-evidence", message: "Artifact Release Claim Table schemaVersion 漂移", excerpt: String(releaseClaims.schemaVersion) });
  }
  const releaseClaimsArray = Array.isArray(releaseClaims.claims) ? releaseClaims.claims : [];
  const releaseIds = releaseClaimsArray.map((claim) => asRecord(claim).id);
  if (releaseIds.some((id) => typeof id !== "string" || !/^CLAIM-[A-Z0-9-]+$/u.test(id)) || new Set(releaseIds).size !== releaseIds.length) {
    issues.push({ file: `${ARTIFACT_RELEASE_ROOT}/${claimPath}`, line: 1, kind: "claim-evidence", message: "Artifact Release Claim Table ID 必须合法且唯一", excerpt: JSON.stringify(releaseIds) });
  }
  const releaseById = new Map(releaseClaimsArray.map((claim) => [asRecord(claim).id, asRecord(claim)]));
  for (const id of included) {
    const canonicalClaim = canonicalById.get(id);
    const releaseClaim = releaseById.get(id);
    if (!canonicalClaim || !releaseClaim) {
      issues.push({ file: ARTIFACT_RELEASE, line: 1, kind: "claim-evidence", message: `included Claim 未在论文表和 Artifact 表同时存在: ${id}`, excerpt: id });
      continue;
    }
    if (canonicalClaim.evidenceState !== "CodeVerified" || releaseClaim.evidenceState !== "CodeVerified") {
      issues.push({ file: ARTIFACT_RELEASE, line: 1, kind: "claim-evidence", message: `included Claim 必须保持 CodeVerified: ${id}`, excerpt: JSON.stringify({ canonical: canonicalClaim.evidenceState, release: releaseClaim.evidenceState }) });
    }
    if (typeof releaseClaim.topic !== "string" || typeof releaseClaim.allowedClaim !== "string"
      || typeof releaseClaim.forbiddenClaim !== "string" || !Array.isArray(releaseClaim.requiredEvidence)) {
      issues.push({ file: `${ARTIFACT_RELEASE_ROOT}/${claimPath}`, line: 1, kind: "claim-evidence", message: `Artifact Claim 字段不完整: ${id}`, excerpt: JSON.stringify(releaseClaim) });
    }
    for (const key of ["topic", "allowedClaim", "forbiddenClaim", "requiredEvidence"] as const) {
      if (JSON.stringify(sortKeys(canonicalClaim[key])) !== JSON.stringify(sortKeys(releaseClaim[key]))) {
        issues.push({ file: ARTIFACT_RELEASE, line: 1, kind: "claim-evidence", message: `论文 Claim 与 Artifact Claim 内容漂移: ${id}.${key}`, excerpt: id });
      }
    }
  }
}

function isSha256(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value); }
function sha256(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function digestCanonical(value: unknown): string { return sha256(Buffer.from(JSON.stringify(sortKeys(value)), "utf8")); }
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortKeys(record[key])]));
}

function asRecord(value: unknown): Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function isUnboundResultNumber(line: string): boolean {
  if (/Evidence|Source|Artifact|证据|来源|原始文件|Manifest/iu.test(line)) return false;
  if (/TODO|NotVerified|NotRun|NotReviewed|NotIncluded/iu.test(line)) return false;
  if (/报告|区间|上界|方法|指标|schema|GATE|RQ/iu.test(line)) return false;
  // Only flag asserted measurements, not methodological constants such as Wilson 95% or GATE-40.
  return /(?:当前|本次|实测|观察到|结果(?:为|是)|测得|共计|合计|成功率(?:为|达到)|覆盖率(?:为|达到))[^。\n]{0,32}\b\d+(?:\.\d+)?%?/u.test(line);
}

async function main(): Promise<void> {
  const report = await scanPaperConsistency(process.cwd());
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 2;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
