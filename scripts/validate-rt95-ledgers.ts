import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

type JsonObject = Record<string, unknown>;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER_DIR = "research/rt95-ledgers";
const PATHS = {
  engineering: `${LEDGER_DIR}/engineering-work-packages-v1.json`,
  testCases: `${LEDGER_DIR}/test-cases-v1.json`,
  research: `${LEDGER_DIR}/research-sop-gates-v1.json`,
  variants: `${LEDGER_DIR}/w0-component-variants-v1.json`,
} as const;

const LEGAL_LEDGER_STATUSES = new Set([
  "Proposed",
  "Designed",
  "BlockedByDecision",
  "Accepted",
  "InProgress",
  "Implemented",
  "PartiallyVerified",
  "NotVerified",
  "Verified",
  "Failed",
  "Unknown",
]);
const TEST_ALLOWED_STATUSES = [
  "Designed",
  "BlockedByDecision",
  "Implemented",
  "PartiallyVerified",
  "Failed",
  "Unknown",
] as const;
const TEST_STATUSES = new Set<string>(TEST_ALLOWED_STATUSES);
const RESEARCH_ALLOWED_STATUSES = [
  "NotVerified",
  "Blocked",
  "InProgress",
  "ReviewerAccepted",
  "ReviewerReturned",
  "Verified",
] as const;
const RESEARCH_STATUSES = new Set<string>(RESEARCH_ALLOWED_STATUSES);
const TEST_EVIDENCE_LEVELS = new Set(["E2", "E3", "E2/E3", "E4", "E4 候选"]);
const VARIANT_TEST_FILES = [
  "tests/authority-registry-test.ts",
  "tests/runtime-correlation-test.ts",
  "tests/runtime-event-test.ts",
  "tests/capability-grant-test.ts",
  "tests/capability-intersection-test.ts",
  "tests/legacy-capability-adapter-test.ts",
  "tests/evidence-contract-test.ts",
  "tests/evidence-validation-test.ts",
  "tests/legacy-evidence-adapter-test.ts",
] as const;
const CATEGORY_BY_SECTION: Readonly<Record<string, string>> = {
  "19.2": "normal-mainline",
  "19.3": "fail-closed",
  "19.4": "duplicate-out-of-order-late",
  "19.5": "concurrency-race",
  "19.6": "cancellation-timeout-late-results",
  "19.7": "crash-recovery",
  "19.8": "multi-process",
  "19.9": "lease-fencing",
  "19.10": "partition-migration",
  "19.11": "task-contract-graph",
  "19.12": "supervisor-wait-guidance-heartbeat",
  "19.13": "evidence-proof-arbiter",
  "19.14": "capability-namespace",
  "19.15": "quota-backpressure-fairness",
  "19.16": "performance-durability-reproduction",
};
const TEST_SOURCE_DOCUMENT = "docs/God-Agent-科研项目/03-测试用例与验收标准.md";
const TEST_SOURCE_SECTION = "第 19 节：TC-RT95 预注册测试账本（150 条，v0.1）";
const TEST_TRANSCRIPTION_RULE = "逐行转录 D03 TC-RT95-001..150；不增删顶层分母。";
const TEST_VERIFIED_RULE = "W0 阶段禁止任何顶层 TC 标记为 Verified；普通 evidenceFiles 路径不构成 Completion Proof。只有未来升级 schema、引入结构化 Completion Proof，并同时满足生产入口、规定重复次数、独立 Oracle、原始证据和文档门禁后，才可启用 Verified；组件 variant 通过不自动升级。";
const VARIANT_PROMOTION_RULE = "Variant 通过不得自动升级顶层 TC；顶层 TC 仍需生产入口、规定重复次数、独立 Oracle、原始证据和文档门禁。";
const VARIANT_CLAIM_CEILING = "仅支持对应合同的 E2 组件候选证据；不证明生产组装、真实进程、顶层 TC Verified、完整 E3、GATE-40 或生产可用。";
const RESEARCH_VERIFIED_RULE = "当前 rt95-research-sop-gates-v1 schema 禁止任何单项进入 Verified；文件存在、命令成功、普通 evidenceRefs 或摘要文本均不构成 Research Completion Proof。只有未来升级为结构化 Research Completion Proof schema，并同时验证冻结输入摘要、精确命令、Oracle、预期 Artifact、原始 Evidence、排除规则、执行者结果和独立 Reviewer 结论后，才可启用 Verified。";
const RESEARCH_UNKNOWN_COMMAND_RULE = "D11 附录 C 未给出精确命令时 command 必须为 null，并在 blockedReason 说明缺口；不得猜测命令或 Evidence 路径。";
const RESEARCH_95_RULE = "Verified 至少 63/66，全部 p0=true 项 Verified，且 EXP-RT95-020 或 EXP-RT95-021 至少一项 Verified；工程分数不能补偿科研 P0、外部基线、外部复现或 Artifact 保管链失败。";
const RESEARCH_BASELINE_IDS = ["EXP-RT95-020", "EXP-RT95-021"] as const;
const ATTACK_NAMES = new Set([
  "tc-verified-with-evidence",
  "tc-denominator-one",
  "tc-category-count-999",
  "tc-default-verified",
  "variant-full-access",
  "variant-policy-promotion",
  "research-status-policy-tamper",
  "research-gate-minimum-tamper",
  "research-gate-baseline-tamper",
  "research-reviewer-accepted-as-verified",
  "research-verified-status-enabled",
  "research-forged-63-verified",
]);

function fail(message: string): never {
  throw new Error(`RT95 ledger validation failed: ${message}`);
}

function parseAttack(): string | undefined {
  const direct = process.argv.find((argument) => argument.startsWith("--attack="));
  const flagIndex = process.argv.indexOf("--attack");
  const attack = direct?.slice("--attack=".length) ?? (flagIndex >= 0 ? process.argv[flagIndex + 1] : undefined);
  if (attack !== undefined && !ATTACK_NAMES.has(attack)) fail(`unknown attack fixture: ${attack}`);
  return attack;
}

const SELECTED_ATTACK = parseAttack();

function applyAttackFixture(relativePath: string, parsed: JsonObject): void {
  const attack = SELECTED_ATTACK;
  if (attack === undefined) return;
  if (relativePath === PATHS.testCases) {
    const source = asObject(parsed.source, "attack.test.source");
    const statusPolicy = asObject(parsed.statusPolicy, "attack.test.statusPolicy");
    const cases = asArray(parsed.testCases, "attack.test.testCases");
    if (attack === "tc-verified-with-evidence") {
      const first = asObject(cases[0], "attack.test.testCases[0]");
      first.status = "Verified";
      first.evidenceFiles = ["package.json"];
    } else if (attack === "tc-denominator-one") {
      source.scoringDenominator = 1;
    } else if (attack === "tc-category-count-999") {
      asObject(source.categoryCounts, "attack.test.source.categoryCounts")["normal-mainline"] = 999;
    } else if (attack === "tc-default-verified") {
      statusPolicy.defaultStatus = "Verified";
    }
  } else if (relativePath === PATHS.variants) {
    const statusPolicy = asObject(parsed.statusPolicy, "attack.variant.statusPolicy");
    const variants = asArray(parsed.variants, "attack.variant.variants");
    if (attack === "variant-full-access") {
      const first = asObject(variants[0], "attack.variant.variants[0]");
      first.actualEvidenceLevel = "E3-full";
      first.productionAssembly = true;
      first.status = "Verified";
      first.claimCeiling = "证明完整 E3 和生产可用。";
    } else if (attack === "variant-policy-promotion") {
      statusPolicy.scoringEffect = "top-level-verified";
      statusPolicy.promotionRule = "Variant 通过自动升级顶层 TC。";
    }
  } else if (relativePath === PATHS.research) {
    const statusPolicy = asObject(parsed.statusPolicy, "attack.research.statusPolicy");
    const gate = asObject(statusPolicy.research95Gate, "attack.research.statusPolicy.research95Gate");
    if (attack === "research-status-policy-tamper") {
      statusPolicy.allowedStatuses = ["NotVerified", "ReviewerAccepted", "Verified"];
    } else if (attack === "research-gate-minimum-tamper") {
      gate.minimumVerified = 1;
    } else if (attack === "research-gate-baseline-tamper") {
      gate.externalBaselineAnyOf = ["EXP-RT95-001"];
    } else if (attack === "research-reviewer-accepted-as-verified") {
      gate.reviewerAcceptedCountsAsVerified = true;
    } else if (attack === "research-verified-status-enabled") {
      statusPolicy.verifiedStatusEnabled = true;
    } else if (attack === "research-forged-63-verified") {
      const excludedIds = new Set(["EXP-RT95-001", "EXP-RT95-002", "EXP-RT95-003"]);
      for (const [index, value] of asArray(parsed.items, "attack.research.items").entries()) {
        const item = asObject(value, `attack.research.items[${index}]`);
        const id = asString(item.id, `attack.research.items[${index}].id`);
        if (!excludedIds.has(id)) {
          item.status = "Verified";
          item.evidenceRefs = ["package.json"];
        }
      }
    }
  }
}

function readJson(relativePath: string): JsonObject {
  assertSafeRepoPath(relativePath, relativePath, true);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolve(ROOT, relativePath), "utf8"));
  } catch (error) {
    fail(`${relativePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const object = asObject(parsed, relativePath);
  applyAttackFixture(relativePath, object);
  return object;
}

function asObject(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value as JsonObject;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function asBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") fail(`${label} must be a boolean`);
  return value;
}

function stringArray(value: unknown, label: string, allowEmpty = true): string[] {
  const entries = asArray(value, label).map((entry, index) => asString(entry, `${label}[${index}]`));
  if (!allowEmpty && entries.length === 0) fail(`${label} cannot be empty`);
  assertUnique(entries, label);
  return entries;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) fail(`${label} contains duplicates`);
}

function assertExactKeys(value: JsonObject, expected: readonly string[], label: string): void {
  const actual = Object.keys(value);
  const missing = expected.filter((key) => !Object.hasOwn(value, key));
  const extra = actual.filter((key) => !expected.includes(key));
  if (missing.length > 0 || extra.length > 0) {
    fail(`${label} key mismatch; missing=[${missing.join(",")}], extra=[${extra.join(",")}]`);
  }
}

function assertExactString(value: unknown, expected: string, label: string): void {
  const actual = asString(value, label);
  if (actual !== expected) fail(`${label} must equal ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertExactNumber(value: unknown, expected: number, label: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value !== expected) {
    fail(`${label} must equal ${expected}, got ${String(value)}`);
  }
}

function assertExactBoolean(value: unknown, expected: boolean, label: string): void {
  const actual = asBoolean(value, label);
  if (actual !== expected) fail(`${label} must equal ${expected}, got ${actual}`);
}

function assertExactStringArray(value: unknown, expected: readonly string[], label: string): string[] {
  const actual = stringArray(value, label);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} must exactly equal [${expected.join(",")}], got [${actual.join(",")}]`);
  }
  return actual;
}

function assertExactIds(actual: readonly string[], expected: readonly string[], label: string): void {
  assertUnique(actual, label);
  const actualSet = new Set(actual);
  const missing = expected.filter((id) => !actualSet.has(id));
  const extra = actual.filter((id) => !expected.includes(id));
  if (missing.length > 0 || extra.length > 0) {
    fail(`${label} ID mismatch; missing=[${missing.join(",")}], extra=[${extra.join(",")}]`);
  }
}

function assertSafeRepoPath(value: string, label: string, requireExists: boolean): void {
  if (value.length === 0 || value.includes("\\") || value.includes("\0") ||
      value.startsWith("/") || isAbsolute(value) ||
      value.split("/").some((part) => part.length === 0 || part === "." || part === "..")) {
    fail(`${label} is not a safe repository-relative path: ${value}`);
  }
  const absolute = resolve(ROOT, value);
  if (absolute !== ROOT && !absolute.startsWith(`${ROOT}${sep}`)) fail(`${label} escapes the repository: ${value}`);
  if (requireExists && !existsSync(absolute)) fail(`${label} does not exist: ${value}`);
}

function validateEvidencePaths(value: unknown, label: string, requireExists: boolean): string[] {
  const paths = stringArray(value, label);
  for (const [index, path] of paths.entries()) assertSafeRepoPath(path, `${label}[${index}]`, requireExists);
  return paths;
}

function validateStatus(value: unknown, label: string, allowed = LEGAL_LEDGER_STATUSES): string {
  const status = asString(value, label);
  if (!allowed.has(status)) fail(`${label} has illegal status: ${status}`);
  return status;
}

function expectedEngineeringIds(): string[] {
  const counts: Readonly<Record<string, number>> = { A: 16, B: 28, C: 18, D: 10, E: 12, F: 10, G: 6 };
  return Object.entries(counts).flatMap(([prefix, count]) =>
    Array.from({ length: count }, (_, index) => `${prefix}${String(index + 1).padStart(2, "0")}`));
}

function validateEngineeringLedger(): { count: number; verified: number } {
  const ledger = readJson(PATHS.engineering);
  const packages = asArray(ledger.workPackages, `${PATHS.engineering}.workPackages`)
    .map((value, index) => asObject(value, `workPackages[${index}]`));
  if (packages.length !== 100) fail(`engineering Work Package count must be 100, got ${packages.length}`);
  const ids = packages.map((item, index) => asString(item.id, `workPackages[${index}].id`));
  assertExactIds(ids, expectedEngineeringIds(), "engineering Work Packages");

  const allowedExternalDependencies = new Set(["RT95-001", "RT95-002", "RT95-003"]);
  const idSet = new Set(ids);
  let verified = 0;
  for (const [index, item] of packages.entries()) {
    const id = ids[index]!;
    asString(item.epicId, `${id}.epicId`);
    asString(item.domain, `${id}.domain`);
    asString(item.title, `${id}.title`);
    asBoolean(item.p0, `${id}.p0`);
    asString(item.definitionOfDone, `${id}.definitionOfDone`);
    asString(item.risk, `${id}.risk`);
    asString(item.rollback, `${id}.rollback`);
    const status = validateStatus(item.status, `${id}.status`);
    const evidenceRefs = validateEvidencePaths(item.evidenceRefs, `${id}.evidenceRefs`, status === "Verified");
    if (status === "Verified") {
      verified += 1;
      if (evidenceRefs.length === 0) fail(`${id} cannot be Verified without evidenceRefs`);
    }
    const dependencies = stringArray(item.dependencies, `${id}.dependencies`);
    for (const dependency of dependencies) {
      if (!idSet.has(dependency) && !allowedExternalDependencies.has(dependency)) {
        fail(`${id} references unknown dependency: ${dependency}`);
      }
    }
  }
  // D11 currently contains deliberate contract-bootstrap dependency cycles
  // (for example Task Contract ↔ CapabilityGrant). W0 validates reference
  // closure only; execution DAG ordering is a later, separately frozen plan.
  return { count: packages.length, verified };
}

interface D03Case {
  id: string;
  category: string;
  p0: boolean;
  evidenceLevel: string;
  preconditions: string[];
  steps: string[];
  faultBoundary: string;
  oracle: string;
  invariants: string[];
}

function expandInvariants(value: string): string[] {
  const output: string[] = [];
  for (const part of value.split("、").map((entry) => entry.trim())) {
    const range = /^(\d+)～(\d+)$/.exec(part);
    if (range !== null) {
      for (let current = Number(range[1]); current <= Number(range[2]); current += 1) {
        output.push(`INV-RT95-${String(current).padStart(2, "0")}`);
      }
    } else if (/^\d+$/.test(part)) {
      output.push(`INV-RT95-${part.padStart(2, "0")}`);
    } else {
      fail(`D03 contains an invalid invariant expression: ${part}`);
    }
  }
  return output;
}

function parseD03Cases(): D03Case[] {
  const relativePath = "docs/God-Agent-科研项目/03-测试用例与验收标准.md";
  const lines = readFileSync(resolve(ROOT, relativePath), "utf8").split(/\r?\n/);
  let context: { section: string; category: string; preconditions: string[]; invariants: string[] } | undefined;
  const cases: D03Case[] = [];
  for (const line of lines) {
    const heading = /^### (19\.(?:[2-9]|1[0-6])) (.+)：TC-RT95-\d+～\d+$/.exec(line);
    if (heading !== null) {
      const category = CATEGORY_BY_SECTION[heading[1]!];
      if (category === undefined) fail(`D03 category is not registered: ${heading[1]}`);
      context = { section: heading[1]!, category, preconditions: [], invariants: [] };
      continue;
    }
    if (line.startsWith("### 19.17")) break;
    if (context === undefined) continue;
    if (line.startsWith("前置：")) {
      const precondition = /前置：(.+?)(?:。|  )/.exec(line)?.[1]?.trim();
      if (precondition !== undefined) context.preconditions = [precondition];
      const invariants = /主要不变量：(.+?)(?:。|  |$)/.exec(line)?.[1];
      if (invariants !== undefined) context.invariants = expandInvariants(invariants);
      continue;
    }
    if (!/^\| TC-RT95-\d{3} \|/.test(line)) continue;
    const columns = line.split("|").slice(1, -1).map((column) => column.trim());
    cases.push({
      id: columns[0]!,
      category: context.category,
      p0: columns[4] === "是",
      evidenceLevel: columns[3]!,
      preconditions: [...context.preconditions],
      steps: [columns[1]!],
      faultBoundary: context.section === "19.2" ? "none" : columns[1]!,
      oracle: columns[2]!,
      invariants: [...context.invariants],
    });
  }
  return cases;
}

function validateTestAndVariantLedgers(): { topLevelTC: number; componentVariants: number; topLevelVerified: number } {
  const testLedger = readJson(PATHS.testCases);
  const variantLedger = readJson(PATHS.variants);
  assertExactKeys(testLedger, ["schemaVersion", "ledgerId", "source", "statusPolicy", "testCases"], PATHS.testCases);
  assertExactString(testLedger.schemaVersion, "rt95-test-cases-v1", `${PATHS.testCases}.schemaVersion`);
  assertExactString(testLedger.ledgerId, "RT95-TEST-CASES-V1", `${PATHS.testCases}.ledgerId`);
  const testSource = asObject(testLedger.source, `${PATHS.testCases}.source`);
  assertExactKeys(testSource, ["document", "section", "scoringDenominator", "transcriptionRule", "categoryCounts"], `${PATHS.testCases}.source`);
  assertExactString(testSource.document, TEST_SOURCE_DOCUMENT, `${PATHS.testCases}.source.document`);
  assertExactString(testSource.section, TEST_SOURCE_SECTION, `${PATHS.testCases}.source.section`);
  assertExactNumber(testSource.scoringDenominator, 150, `${PATHS.testCases}.source.scoringDenominator`);
  assertExactString(testSource.transcriptionRule, TEST_TRANSCRIPTION_RULE, `${PATHS.testCases}.source.transcriptionRule`);
  const declaredCategoryCounts = asObject(testSource.categoryCounts, `${PATHS.testCases}.source.categoryCounts`);
  assertExactKeys(declaredCategoryCounts, Object.values(CATEGORY_BY_SECTION), `${PATHS.testCases}.source.categoryCounts`);
  for (const category of Object.values(CATEGORY_BY_SECTION)) {
    assertExactNumber(declaredCategoryCounts[category], 10, `${PATHS.testCases}.source.categoryCounts.${category}`);
  }
  const testStatusPolicy = asObject(testLedger.statusPolicy, `${PATHS.testCases}.statusPolicy`);
  assertExactKeys(testStatusPolicy, ["allowedStatuses", "scoringStatus", "defaultStatus", "verifiedRule"], `${PATHS.testCases}.statusPolicy`);
  assertExactStringArray(testStatusPolicy.allowedStatuses, TEST_ALLOWED_STATUSES, `${PATHS.testCases}.statusPolicy.allowedStatuses`);
  assertExactString(testStatusPolicy.scoringStatus, "Verified", `${PATHS.testCases}.statusPolicy.scoringStatus`);
  assertExactString(testStatusPolicy.defaultStatus, "Designed", `${PATHS.testCases}.statusPolicy.defaultStatus`);
  assertExactString(testStatusPolicy.verifiedRule, TEST_VERIFIED_RULE, `${PATHS.testCases}.statusPolicy.verifiedRule`);

  assertExactKeys(variantLedger, ["schemaVersion", "ledgerId", "source", "statusPolicy", "variants"], PATHS.variants);
  assertExactString(variantLedger.schemaVersion, "rt95-w0-component-variants-v1", `${PATHS.variants}.schemaVersion`);
  assertExactString(variantLedger.ledgerId, "RT95-W0-COMPONENT-VARIANTS-V1", `${PATHS.variants}.ledgerId`);
  const variantSource = asObject(variantLedger.source, `${PATHS.variants}.source`);
  assertExactKeys(variantSource, ["testFiles", "nonScoringVariantCount", "executedAt", "result"], `${PATHS.variants}.source`);
  assertExactStringArray(variantSource.testFiles, VARIANT_TEST_FILES, `${PATHS.variants}.source.testFiles`);
  assertExactNumber(variantSource.nonScoringVariantCount, 46, `${PATHS.variants}.source.nonScoringVariantCount`);
  asString(variantSource.executedAt, `${PATHS.variants}.source.executedAt`);
  assertExactString(variantSource.result, "46/46 passed", `${PATHS.variants}.source.result`);
  const variantStatusPolicy = asObject(variantLedger.statusPolicy, `${PATHS.variants}.statusPolicy`);
  assertExactKeys(variantStatusPolicy, ["candidateStatus", "scoringEffect", "promotionRule"], `${PATHS.variants}.statusPolicy`);
  assertExactString(variantStatusPolicy.candidateStatus, "passed-candidate-evidence", `${PATHS.variants}.statusPolicy.candidateStatus`);
  assertExactString(variantStatusPolicy.scoringEffect, "none", `${PATHS.variants}.statusPolicy.scoringEffect`);
  assertExactString(variantStatusPolicy.promotionRule, VARIANT_PROMOTION_RULE, `${PATHS.variants}.statusPolicy.promotionRule`);

  const testCases = asArray(testLedger.testCases, `${PATHS.testCases}.testCases`)
    .map((value, index) => asObject(value, `testCases[${index}]`));
  const variants = asArray(variantLedger.variants, `${PATHS.variants}.variants`)
    .map((value, index) => asObject(value, `variants[${index}]`));
  if (testCases.length !== 150) fail(`TC-RT95 count must be 150, got ${testCases.length}`);
  if (variants.length !== 46) fail(`W0 component variant count must be 46, got ${variants.length}`);

  const expectedTestIds = Array.from({ length: 150 }, (_, index) =>
    `TC-RT95-${String(index + 1).padStart(3, "0")}`);
  const testIds = testCases.map((item, index) => asString(item.id, `testCases[${index}].id`));
  assertExactIds(testIds, expectedTestIds, "TC-RT95 test cases");
  const testById = new Map(testCases.map((item, index) => [testIds[index]!, item] as const));

  const d03Cases = parseD03Cases();
  if (d03Cases.length !== 150) fail(`D03 transcription source must contain 150 cases, got ${d03Cases.length}`);
  const expectedInvariantIds = new Set(Array.from({ length: 14 }, (_, index) =>
    `INV-RT95-${String(index + 1).padStart(2, "0")}`));
  const categoryCounts = new Map<string, number>();
  let verified = 0;
  for (const [index, item] of testCases.entries()) {
    const id = testIds[index]!;
    const source = d03Cases[index]!;
    assertExactKeys(item, [
      "id", "category", "p0", "evidenceLevel", "preconditions", "steps", "faultBoundary",
      "oracle", "invariants", "status", "evidenceFiles", "caseVariants", "limitations",
    ], id);
    for (const field of ["id", "category", "p0", "evidenceLevel", "preconditions", "steps", "faultBoundary", "oracle", "invariants"] as const) {
      if (JSON.stringify(item[field]) !== JSON.stringify(source[field])) {
        fail(`${id} field ${field} does not exactly transcribe D03`);
      }
    }
    const category = asString(item.category, `${id}.category`);
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
    asBoolean(item.p0, `${id}.p0`);
    const evidenceLevel = asString(item.evidenceLevel, `${id}.evidenceLevel`);
    if (!TEST_EVIDENCE_LEVELS.has(evidenceLevel)) fail(`${id} has illegal evidenceLevel: ${evidenceLevel}`);
    stringArray(item.preconditions, `${id}.preconditions`, false);
    stringArray(item.steps, `${id}.steps`, false);
    asString(item.faultBoundary, `${id}.faultBoundary`);
    asString(item.oracle, `${id}.oracle`);
    for (const invariant of stringArray(item.invariants, `${id}.invariants`, false)) {
      if (!expectedInvariantIds.has(invariant)) fail(`${id} references unknown invariant: ${invariant}`);
    }
    const status = validateStatus(item.status, `${id}.status`, TEST_STATUSES);
    validateEvidencePaths(item.evidenceFiles, `${id}.evidenceFiles`, false);
    stringArray(item.caseVariants, `${id}.caseVariants`);
    stringArray(item.limitations, `${id}.limitations`, false);
    if (status === "Verified") fail(`${id} cannot be Verified under the W0 test ledger schema`);
  }
  for (const category of Object.values(CATEGORY_BY_SECTION)) {
    if (categoryCounts.get(category) !== 10) fail(`category ${category} must contain 10 cases`);
  }

  const variantIds = variants.map((item, index) => asString(item.variantId, `variants[${index}].variantId`));
  assertUnique(variantIds, "W0 component variants");
  const variantById = new Map(variants.map((item, index) => [variantIds[index]!, item] as const));
  const reverseVariantIds: string[] = [];
  for (const [testCaseId, item] of testById) {
    for (const variantId of stringArray(item.caseVariants, `${testCaseId}.caseVariants`)) {
      reverseVariantIds.push(variantId);
      const variant = variantById.get(variantId);
      if (variant === undefined) fail(`${testCaseId} references unknown variant: ${variantId}`);
      if (variant.testCaseId !== testCaseId) fail(`${variantId} reverse mapping does not match ${testCaseId}`);
    }
  }
  assertExactIds(reverseVariantIds, variantIds, "TC caseVariants reverse mappings");

  const sourceTests = new Set<string>();
  for (const testFile of VARIANT_TEST_FILES) {
    assertSafeRepoPath(testFile, testFile, true);
    const source = readFileSync(resolve(ROOT, testFile), "utf8");
    for (const match of source.matchAll(/^test\("([^"]+)"/gm)) sourceTests.add(`${testFile}\u0000${match[1]}`);
  }
  if (sourceTests.size !== 46) fail(`the fixed nine W0 files must contain exactly 46 test() cases, got ${sourceTests.size}`);
  const mappedTests: string[] = [];
  for (const [index, variant] of variants.entries()) {
    const id = variantIds[index]!;
    assertExactKeys(variant, [
      "variantId", "testCaseId", "testFile", "testName", "entryPoint", "oracleKind",
      "actualEvidenceLevel", "productionAssembly", "status", "claimCeiling",
    ], id);
    const testCaseId = asString(variant.testCaseId, `${id}.testCaseId`);
    if (!testById.has(testCaseId)) fail(`${id} references unknown testCaseId: ${testCaseId}`);
    const testFile = asString(variant.testFile, `${id}.testFile`);
    if (!VARIANT_TEST_FILES.includes(testFile as typeof VARIANT_TEST_FILES[number])) {
      fail(`${id} references a file outside the fixed nine W0 tests: ${testFile}`);
    }
    assertSafeRepoPath(testFile, `${id}.testFile`, true);
    const testName = asString(variant.testName, `${id}.testName`);
    const testKey = `${testFile}\u0000${testName}`;
    if (!sourceTests.has(testKey)) fail(`${id} does not match a real test() declaration`);
    mappedTests.push(testKey);
    asString(variant.entryPoint, `${id}.entryPoint`);
    asString(variant.oracleKind, `${id}.oracleKind`);
    if (variant.actualEvidenceLevel !== "E2-component") fail(`${id} must remain E2-component`);
    if (variant.productionAssembly !== false) fail(`${id} must declare productionAssembly=false`);
    if (variant.status !== "passed-candidate-evidence") fail(`${id} has an invalid candidate status`);
    assertExactString(variant.claimCeiling, VARIANT_CLAIM_CEILING, `${id}.claimCeiling`);
  }
  assertExactIds(mappedTests, [...sourceTests], "W0 test() to variant mappings");
  return { topLevelTC: testCases.length, componentVariants: variants.length, topLevelVerified: verified };
}

function expectedResearchIds(): string[] {
  return [
    ...Array.from({ length: 50 }, (_, index) => `EXP-RT95-${String(index + 1).padStart(3, "0")}`),
    ...Array.from({ length: 8 }, (_, index) => `TC-REP-${String(index + 1).padStart(3, "0")}`),
    ...Array.from({ length: 8 }, (_, index) => `TC-ART-${String(index + 1).padStart(3, "0")}`),
  ];
}

interface ResearchValidationResult {
  count: number;
  verified: number;
  verifiedStatusEnabled: boolean;
  p0Total: number;
  p0Verified: number;
  allP0: boolean;
  externalBaselineAnyOf: string[];
  externalBaselineSatisfied: boolean;
  research95Eligible: boolean;
}

function validateResearchLedger(): ResearchValidationResult {
  const ledger = readJson(PATHS.research);
  assertExactKeys(ledger, ["schemaVersion", "ledgerId", "statusPolicy", "items"], PATHS.research);
  assertExactString(ledger.schemaVersion, "rt95-research-sop-gates-v1", `${PATHS.research}.schemaVersion`);
  assertExactString(ledger.ledgerId, "RT95-RESEARCH-SOP-GATES-V1", `${PATHS.research}.ledgerId`);
  const statusPolicy = asObject(ledger.statusPolicy, `${PATHS.research}.statusPolicy`);
  assertExactKeys(statusPolicy, [
    "allowedStatuses", "defaultStatus", "scoringStatus", "verifiedStatusEnabled", "verifiedRule", "unknownCommandRule",
    "research95Rule", "research95Gate",
  ], `${PATHS.research}.statusPolicy`);
  assertExactStringArray(statusPolicy.allowedStatuses, RESEARCH_ALLOWED_STATUSES, `${PATHS.research}.statusPolicy.allowedStatuses`);
  assertExactString(statusPolicy.defaultStatus, "NotVerified", `${PATHS.research}.statusPolicy.defaultStatus`);
  assertExactString(statusPolicy.scoringStatus, "Verified", `${PATHS.research}.statusPolicy.scoringStatus`);
  assertExactBoolean(statusPolicy.verifiedStatusEnabled, false, `${PATHS.research}.statusPolicy.verifiedStatusEnabled`);
  assertExactString(statusPolicy.verifiedRule, RESEARCH_VERIFIED_RULE, `${PATHS.research}.statusPolicy.verifiedRule`);
  assertExactString(statusPolicy.unknownCommandRule, RESEARCH_UNKNOWN_COMMAND_RULE, `${PATHS.research}.statusPolicy.unknownCommandRule`);
  assertExactString(statusPolicy.research95Rule, RESEARCH_95_RULE, `${PATHS.research}.statusPolicy.research95Rule`);
  const research95Gate = asObject(statusPolicy.research95Gate, `${PATHS.research}.statusPolicy.research95Gate`);
  assertExactKeys(research95Gate, [
    "minimumVerified", "requireAllP0Verified", "externalBaselineAnyOf", "reviewerAcceptedCountsAsVerified",
  ], `${PATHS.research}.statusPolicy.research95Gate`);
  assertExactNumber(research95Gate.minimumVerified, 63, `${PATHS.research}.statusPolicy.research95Gate.minimumVerified`);
  assertExactBoolean(research95Gate.requireAllP0Verified, true, `${PATHS.research}.statusPolicy.research95Gate.requireAllP0Verified`);
  const externalBaselineAnyOf = assertExactStringArray(
    research95Gate.externalBaselineAnyOf,
    RESEARCH_BASELINE_IDS,
    `${PATHS.research}.statusPolicy.research95Gate.externalBaselineAnyOf`,
  );
  assertExactBoolean(
    research95Gate.reviewerAcceptedCountsAsVerified,
    false,
    `${PATHS.research}.statusPolicy.research95Gate.reviewerAcceptedCountsAsVerified`,
  );
  const items = asArray(ledger.items, `${PATHS.research}.items`)
    .map((value, index) => asObject(value, `research.items[${index}]`));
  if (items.length !== 66) fail(`Research/SOP item count must be 66, got ${items.length}`);
  const ids = items.map((item, index) => asString(item.id, `research.items[${index}].id`));
  assertExactIds(ids, expectedResearchIds(), "Research/SOP items");
  const requiredP0 = new Set([
    "EXP-RT95-005", "EXP-RT95-006", "EXP-RT95-032", "EXP-RT95-034", "EXP-RT95-035",
    "EXP-RT95-039", "EXP-RT95-040", "EXP-RT95-044", "EXP-RT95-045", "EXP-RT95-046",
    "EXP-RT95-047", "EXP-RT95-048", "EXP-RT95-049", "EXP-RT95-050",
    "TC-REP-008", "TC-ART-006", "TC-ART-007", "TC-ART-008",
  ]);
  let verified = 0;
  let p0Verified = 0;
  const statusById = new Map<string, string>();
  for (const [index, item] of items.entries()) {
    const id = ids[index]!;
    const p0 = asBoolean(item.p0, `${id}.p0`);
    if (p0 !== requiredP0.has(id)) fail(`${id}.p0 does not match D11`);
    const status = validateStatus(item.status, `${id}.status`, RESEARCH_STATUSES);
    statusById.set(id, status);
    if (status === "Verified") {
      fail(`${id}.status cannot be Verified under rt95-research-sop-gates-v1; structured Research Completion Proof is not available`);
    }
    const evidenceRefs = validateEvidencePaths(item.evidenceRefs, `${id}.evidenceRefs`, status === "Verified");
    if (status === "Verified") {
      verified += 1;
      if (p0) p0Verified += 1;
      if (evidenceRefs.length === 0) fail(`${id} cannot be Verified without evidenceRefs`);
    }
  }
  const p0Total = requiredP0.size;
  const allP0 = p0Verified === p0Total;
  const externalBaselineSatisfied = externalBaselineAnyOf.some((id) => statusById.get(id) === "Verified");
  const research95Eligible = verified >= 63 && allP0 && externalBaselineSatisfied;
  return {
    count: items.length,
    verified,
    verifiedStatusEnabled: false,
    p0Total,
    p0Verified,
    allP0,
    externalBaselineAnyOf,
    externalBaselineSatisfied,
    research95Eligible,
  };
}

function validatePackageScripts(): void {
  const packageJson = readJson("package.json");
  const scripts = asObject(packageJson.scripts, "package.json.scripts");
  const contractCommand = asString(scripts["test:w0-contracts"], "scripts.test:w0-contracts");
  for (const testFile of VARIANT_TEST_FILES) {
    if (!contractCommand.includes(testFile)) fail(`test:w0-contracts omits ${testFile}`);
  }
  if (scripts["test:w0-ledgers"] !== "tsx scripts/validate-rt95-ledgers.ts") {
    fail("test:w0-ledgers must run the fixed validator entry point");
  }
}

function main(): void {
  validatePackageScripts();
  const engineering = validateEngineeringLedger();
  const tests = validateTestAndVariantLedgers();
  const research = validateResearchLedger();
  process.stdout.write(`${JSON.stringify({
    result: "RT95 ledgers valid",
    engineering,
    tests,
    research,
    claimBoundary: "Ledger validity and component candidate evidence do not upgrade any top-level item to Verified.",
  }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
