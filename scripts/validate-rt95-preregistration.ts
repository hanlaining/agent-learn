import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const RT95_PREREGISTRATION_SCHEMA_VERSION = "rt95-preregistration-v1" as const;

export interface Rt95Preregistration extends Record<string, unknown> {
  schemaVersion: typeof RT95_PREREGISTRATION_SCHEMA_VERSION;
  registrationId: string;
  lifecycle: { status: "draft" | "frozen"; frozenAt: string | null };
  verification: { status: "NotVerified"; evidenceActual: null; reviewerConclusion: null };
  integrity: { summary: Record<string, unknown>; payloadSha256: string | null };
}

type JsonObject = Record<string, unknown>;

const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const ID = /^[A-Z][A-Z0-9-]*$/u;
const RQ_ID = /^RQ[1-9][0-9]*$/u;
const UINT32_MAX = 0xffff_ffff;

export const RT95_GATE40_SEEDS = [
  469816031,
  3443330994,
  4121183031,
  3314624278,
  3472974415,
] as const;

export const RT95_GATE40_WINDOWS = [
  { id: "FW-MODEL-RESPONSE-COMMIT", oracleId: "ORACLE-MODEL-WAL-V1", readiness: "blocked" },
  { id: "FW-TOOL-EFFECT-RECEIPT", oracleId: "ORACLE-TOOL-OUTCOME-V1", readiness: "blocked" },
  { id: "FW-RETURN-RESPONSE-LEASE", oracleId: "ORACLE-RETURN-LEASE-V1", readiness: "available" },
  { id: "FW-RETURN-PERSISTED-CONSUME", oracleId: "ORACLE-RETURN-CONSUME-V1", readiness: "blocked" },
  { id: "FW-LEASE-FENCED-COMMIT", oracleId: "ORACLE-FENCING-V1", readiness: "blocked" },
  { id: "FW-WORKFLOW-STAGE-COMMIT", oracleId: "ORACLE-WORKFLOW-COMMIT-V1", readiness: "blocked" },
  { id: "FW-RECEIPT-COMMIT", oracleId: "ORACLE-RECEIPT-V1", readiness: "blocked" },
  { id: "FW-PROOF-COMMIT", oracleId: "ORACLE-PROOF-V1", readiness: "blocked" },
] as const;

const AVAILABLE_PRODUCTION_COMMAND = "node --import tsx src/app-server/main.ts";
const AVAILABLE_HARNESS_PATH = "research/runtime-e2e-benchmarks/src/process-chaos-harness.ts";

export function validateRt95Preregistration(value: unknown): Rt95Preregistration {
  const root = object(value, "root");
  exactKeys(root, [
    "schemaVersion", "registrationId", "title", "lifecycle", "verification",
    "researchQuestions", "hypotheses", "primaryEndpoint", "estimand",
    "minimumEffectOfInterest", "sampleSize", "seedPlan", "faultPlan", "rules",
    "arms", "analyses", "provenance", "integrity",
  ], "root");
  equal(root.schemaVersion, RT95_PREREGISTRATION_SCHEMA_VERSION, "schemaVersion");
  nonEmpty(root.registrationId, "registrationId");
  nonEmpty(root.title, "title");

  const lifecycle = object(root.lifecycle, "lifecycle");
  exactKeys(lifecycle, ["status", "frozenAt"], "lifecycle");
  if (lifecycle.status !== "draft" && lifecycle.status !== "frozen") fail("lifecycle.status must be draft or frozen");
  if (lifecycle.status === "draft") {
    equal(lifecycle.frozenAt, null, "draft lifecycle.frozenAt");
  } else {
    canonicalTimestamp(lifecycle.frozenAt, "frozen lifecycle.frozenAt");
  }

  const verification = object(root.verification, "verification");
  exactKeys(verification, ["status", "evidenceActual", "reviewerConclusion"], "verification");
  equal(verification.status, "NotVerified", "verification.status");
  equal(verification.evidenceActual, null, "NotVerified verification.evidenceActual");
  equal(verification.reviewerConclusion, null, "NotVerified verification.reviewerConclusion");

  const rqs = objectArray(root.researchQuestions, "researchQuestions");
  nonEmptyArray(rqs, "researchQuestions");
  const rqIds = rqs.map((rq, index) => {
    exactKeys(rq, ["id", "question"], `researchQuestions[${index}]`);
    const id = stringMatching(rq.id, RQ_ID, `researchQuestions[${index}].id`);
    nonEmpty(rq.question, `researchQuestions[${index}].question`);
    return id;
  });
  unique(rqIds, "researchQuestions IDs");

  const hypotheses = objectArray(root.hypotheses, "hypotheses");
  if (hypotheses.length < 2) fail("hypotheses must contain H0 and H1");
  const hypothesisIds: string[] = [];
  const kindsByRq = new Map<string, Set<string>>();
  for (const [index, hypothesis] of hypotheses.entries()) {
    exactKeys(hypothesis, ["id", "kind", "rqId", "statement"], `hypotheses[${index}]`);
    const id = validId(hypothesis.id, `hypotheses[${index}].id`);
    const kind = hypothesis.kind;
    if (kind !== "null" && kind !== "alternative") fail(`hypotheses[${index}].kind must be null or alternative`);
    if (kind === "null" && !id.startsWith("H0-")) fail(`${id} null hypothesis ID must start with H0-`);
    if (kind === "alternative" && !id.startsWith("H1-")) fail(`${id} alternative hypothesis ID must start with H1-`);
    const rqId = stringMatching(hypothesis.rqId, RQ_ID, `hypotheses[${index}].rqId`);
    if (!rqIds.includes(rqId)) fail(`${id} references unknown research question ${rqId}`);
    nonEmpty(hypothesis.statement, `hypotheses[${index}].statement`);
    hypothesisIds.push(id);
    const kinds = kindsByRq.get(rqId) ?? new Set<string>();
    kinds.add(kind);
    kindsByRq.set(rqId, kinds);
  }
  unique(hypothesisIds, "hypothesis IDs");
  for (const rqId of rqIds) {
    const kinds = kindsByRq.get(rqId);
    if (kinds?.has("null") !== true || kinds.has("alternative") !== true) {
      fail(`${rqId} must have both H0/null and H1/alternative hypotheses`);
    }
  }

  const endpoint = object(root.primaryEndpoint, "primaryEndpoint");
  exactKeys(endpoint, [
    "id", "name", "construct", "unit", "direction", "numerator", "denominator", "analysisId", "oracleId",
  ], "primaryEndpoint");
  const endpointId = validId(endpoint.id, "primaryEndpoint.id");
  for (const key of ["name", "construct", "unit", "numerator", "denominator"] as const) nonEmpty(endpoint[key], `primaryEndpoint.${key}`);
  if (!["higher-is-better", "lower-is-better", "two-sided"].includes(String(endpoint.direction))) {
    fail("primaryEndpoint.direction is invalid");
  }
  const endpointAnalysisId = validId(endpoint.analysisId, "primaryEndpoint.analysisId");
  validId(endpoint.oracleId, "primaryEndpoint.oracleId");

  const estimand = object(root.estimand, "estimand");
  exactKeys(estimand, ["id", "population", "unitOfAnalysis", "treatment", "comparator", "contrast"], "estimand");
  validId(estimand.id, "estimand.id");
  for (const key of ["population", "unitOfAnalysis", "treatment", "comparator", "contrast"] as const) nonEmpty(estimand[key], `estimand.${key}`);

  const effect = object(root.minimumEffectOfInterest, "minimumEffectOfInterest");
  exactKeys(effect, ["absoluteDifference", "unit", "rationale"], "minimumEffectOfInterest");
  positiveNumber(effect.absoluteDifference, "minimumEffectOfInterest.absoluteDifference");
  if (Number(effect.absoluteDifference) >= 1) fail("minimumEffectOfInterest.absoluteDifference must be below 1 for a rate endpoint");
  nonEmpty(effect.unit, "minimumEffectOfInterest.unit");
  nonEmpty(effect.rationale, "minimumEffectOfInterest.rationale");

  const sample = object(root.sampleSize, "sampleSize");
  exactKeys(sample, [
    "basis", "calculationId", "alpha", "targetPower", "targetHalfWidth", "assumedBaselineRate", "perArm", "total", "rationale",
  ], "sampleSize");
  nonEmpty(sample.basis, "sampleSize.basis");
  validId(sample.calculationId, "sampleSize.calculationId");
  probabilityExclusive(sample.alpha, "sampleSize.alpha");
  probabilityExclusive(sample.targetPower, "sampleSize.targetPower");
  probabilityExclusive(sample.targetHalfWidth, "sampleSize.targetHalfWidth");
  probabilityInclusive(sample.assumedBaselineRate, "sampleSize.assumedBaselineRate");
  positiveInteger(sample.perArm, "sampleSize.perArm");
  positiveInteger(sample.total, "sampleSize.total");
  nonEmpty(sample.rationale, "sampleSize.rationale");

  const seedPlan = object(root.seedPlan, "seedPlan");
  exactKeys(seedPlan, ["id", "algorithm", "masterSeed", "seeds", "seedListSha256"], "seedPlan");
  validId(seedPlan.id, "seedPlan.id");
  equal(seedPlan.algorithm, "xorshift32-v1", "seedPlan.algorithm");
  uint32(seedPlan.masterSeed, "seedPlan.masterSeed");
  const seeds = array(seedPlan.seeds, "seedPlan.seeds").map((seed, index) => uint32(seed, `seedPlan.seeds[${index}]`));
  nonEmptyArray(seeds, "seedPlan.seeds");
  unique(seeds, "seedPlan.seeds");
  exactNumberArray(seeds, RT95_GATE40_SEEDS, "seedPlan.seeds");
  const expectedSeedDigest = sha256(JSON.stringify(seeds));
  equal(seedPlan.seedListSha256, expectedSeedDigest, "seedPlan.seedListSha256");

  const faultPlan = object(root.faultPlan, "faultPlan");
  exactKeys(faultPlan, [
    "id", "gateId", "windowSetLifecycle", "pairing", "seedsPerWindow",
    "gate40PlannedCases", "totalPlannedCases", "windows",
  ], "faultPlan");
  validId(faultPlan.id, "faultPlan.id");
  equal(faultPlan.gateId, "EXP-RT95-032", "faultPlan.gateId");
  if (lifecycle.status === "draft") equal(faultPlan.windowSetLifecycle, "candidate-not-frozen", "draft faultPlan.windowSetLifecycle");
  else equal(faultPlan.windowSetLifecycle, "frozen", "frozen faultPlan.windowSetLifecycle");
  equal(faultPlan.pairing, "same-seed-across-arms", "faultPlan.pairing");
  const seedsPerWindow = positiveInteger(faultPlan.seedsPerWindow, "faultPlan.seedsPerWindow");
  if (seedsPerWindow !== seeds.length) fail("faultPlan.seedsPerWindow must equal seedPlan.seeds length");
  equal(faultPlan.gate40PlannedCases, RT95_GATE40_WINDOWS.length * RT95_GATE40_SEEDS.length, "faultPlan.gate40PlannedCases");
  const windows = objectArray(faultPlan.windows, "faultPlan.windows");
  if (windows.length !== RT95_GATE40_WINDOWS.length) {
    fail(`faultPlan.windows must contain exactly ${RT95_GATE40_WINDOWS.length} GATE-40 windows`);
  }
  const availableWindowIds: string[] = [];
  const blockedWindowIds: string[] = [];
  // Legacy smoke drafts keep seven windows blocked. The authoritative
  // 8-window candidate is valid only as an all-available frozen profile;
  // mixed readiness remains fail-closed.
  const authoritativeFrozenProfile = lifecycle.status === "frozen" && windows.every((window) => {
    const readiness = object(window.readiness, "faultPlan.window.readiness");
    return readiness.status === "available";
  });
  const faultWindowIds = windows.map((window, index) => {
    exactKeys(window, [
      "id", "description", "injectionPoint", "productionEntry", "oracle", "expectedArtifacts", "readiness",
    ], `faultPlan.windows[${index}]`);
    const id = validId(window.id, `faultPlan.windows[${index}].id`);
    const expectedWindow = RT95_GATE40_WINDOWS[index];
    if (expectedWindow === undefined || id !== expectedWindow.id) {
      fail(`faultPlan.windows[${index}].id must equal ${expectedWindow?.id ?? "<missing>"}, got ${id}`);
    }
    nonEmpty(window.description, `faultPlan.windows[${index}].description`);
    nonEmpty(window.injectionPoint, `faultPlan.windows[${index}].injectionPoint`);

    const productionEntry = object(window.productionEntry, `faultPlan.windows[${index}].productionEntry`);
    exactKeys(productionEntry, ["command", "harnessPath"], `faultPlan.windows[${index}].productionEntry`);
    const oracle = object(window.oracle, `faultPlan.windows[${index}].oracle`);
    exactKeys(oracle, ["id", "assertion"], `faultPlan.windows[${index}].oracle`);
    equal(oracle.id, expectedWindow.oracleId, `faultPlan.windows[${index}].oracle.id`);
    nonEmpty(oracle.assertion, `faultPlan.windows[${index}].oracle.assertion`);
    const expectedArtifacts = stringArray(window.expectedArtifacts, `faultPlan.windows[${index}].expectedArtifacts`);
    nonEmptyArray(expectedArtifacts, `faultPlan.windows[${index}].expectedArtifacts`);
    unique(expectedArtifacts, `faultPlan.windows[${index}].expectedArtifacts`);
    if (!expectedArtifacts.includes("process-chaos-<seed>/process-chaos-report.json") ||
      !expectedArtifacts.includes("process-chaos-gate40-failures/<caseId>.json")) {
      fail(`faultPlan.windows[${index}].expectedArtifacts must preserve both success and failure Raw paths`);
    }

    const readiness = object(window.readiness, `faultPlan.windows[${index}].readiness`);
    exactKeys(readiness, ["status", "blockedReason"], `faultPlan.windows[${index}].readiness`);
    const expectedReadiness = authoritativeFrozenProfile ? "available" : expectedWindow.readiness;
    equal(readiness.status, expectedReadiness, `faultPlan.windows[${index}].readiness.status`);
    if (readiness.status === "available") {
      equal(readiness.blockedReason, null, `available faultPlan.windows[${index}].readiness.blockedReason`);
      equal(productionEntry.command, AVAILABLE_PRODUCTION_COMMAND, `available faultPlan.windows[${index}].productionEntry.command`);
      equal(productionEntry.harnessPath, AVAILABLE_HARNESS_PATH, `available faultPlan.windows[${index}].productionEntry.harnessPath`);
      safeRelativePath(productionEntry.harnessPath, `faultPlan.windows[${index}].productionEntry.harnessPath`);
      availableWindowIds.push(id);
    } else if (readiness.status === "blocked") {
      nonEmpty(readiness.blockedReason, `blocked faultPlan.windows[${index}].readiness.blockedReason`);
      equal(productionEntry.command, null, `blocked faultPlan.windows[${index}].productionEntry.command`);
      equal(productionEntry.harnessPath, null, `blocked faultPlan.windows[${index}].productionEntry.harnessPath`);
      blockedWindowIds.push(id);
    } else {
      fail(`faultPlan.windows[${index}].readiness.status must be available or blocked`);
    }
    return id;
  });
  unique(faultWindowIds, "fault window IDs");

  const rules = object(root.rules, "rules");
  exactKeys(rules, ["exclusions", "reruns", "stopping"], "rules");
  const ruleIds: string[] = [];
  for (const kind of ["exclusions", "reruns", "stopping"] as const) {
    const entries = objectArray(rules[kind], `rules.${kind}`);
    nonEmptyArray(entries, `rules.${kind}`);
    for (const [index, entry] of entries.entries()) {
      exactKeys(entry, ["id", "condition", "action"], `rules.${kind}[${index}]`);
      ruleIds.push(validId(entry.id, `rules.${kind}[${index}].id`));
      nonEmpty(entry.condition, `rules.${kind}[${index}].condition`);
      nonEmpty(entry.action, `rules.${kind}[${index}].action`);
    }
  }
  unique(ruleIds, "rule IDs");

  const arms = object(root.arms, "arms");
  exactKeys(arms, ["baseline", "ablations", "externalBaselines"], "arms");
  const baseline = object(arms.baseline, "arms.baseline");
  exactKeys(baseline, ["id", "implementation", "configurationId"], "arms.baseline");
  const baselineId = validId(baseline.id, "arms.baseline.id");
  nonEmpty(baseline.implementation, "arms.baseline.implementation");
  const configurationIds = [validId(baseline.configurationId, "arms.baseline.configurationId")];
  const armIds = [baselineId];
  const disabledMechanisms: string[] = [];
  const ablations = objectArray(arms.ablations, "arms.ablations");
  nonEmptyArray(ablations, "arms.ablations");
  for (const [index, arm] of ablations.entries()) {
    exactKeys(arm, ["id", "mechanismDisabled", "configurationId"], `arms.ablations[${index}]`);
    armIds.push(validId(arm.id, `arms.ablations[${index}].id`));
    disabledMechanisms.push(nonEmpty(arm.mechanismDisabled, `arms.ablations[${index}].mechanismDisabled`));
    configurationIds.push(validId(arm.configurationId, `arms.ablations[${index}].configurationId`));
  }
  const external = objectArray(arms.externalBaselines, "arms.externalBaselines");
  for (const [index, arm] of external.entries()) {
    exactKeys(arm, ["id", "system", "configurationId"], `arms.externalBaselines[${index}]`);
    armIds.push(validId(arm.id, `arms.externalBaselines[${index}].id`));
    nonEmpty(arm.system, `arms.externalBaselines[${index}].system`);
    configurationIds.push(validId(arm.configurationId, `arms.externalBaselines[${index}].configurationId`));
  }
  unique(armIds, "arm IDs");
  unique(configurationIds, "arm configuration IDs");
  unique(disabledMechanisms, "ablation mechanisms");

  const plannedCases = windows.length * seedsPerWindow * armIds.length;
  equal(faultPlan.totalPlannedCases, plannedCases, "faultPlan.totalPlannedCases");
  equal(sample.perArm, windows.length * seedsPerWindow, "sampleSize.perArm");
  equal(sample.total, plannedCases, "sampleSize.total");

  const analyses = object(root.analyses, "analyses");
  exactKeys(analyses, ["primaryAnalysisId", "items"], "analyses");
  const primaryAnalysisId = validId(analyses.primaryAnalysisId, "analyses.primaryAnalysisId");
  const analysisItems = objectArray(analyses.items, "analyses.items");
  nonEmptyArray(analysisItems, "analyses.items");
  const analysisIds = analysisItems.map((analysis, index) => {
    exactKeys(analysis, ["id", "endpointId", "method", "interval", "multiplicity"], `analyses.items[${index}]`);
    const id = validId(analysis.id, `analyses.items[${index}].id`);
    equal(analysis.endpointId, endpointId, `analyses.items[${index}].endpointId`);
    for (const key of ["method", "interval", "multiplicity"] as const) nonEmpty(analysis[key], `analyses.items[${index}].${key}`);
    return id;
  });
  unique(analysisIds, "analysis IDs");
  if (!analysisIds.includes(primaryAnalysisId)) fail("analyses.primaryAnalysisId references an unknown analysis");
  equal(endpointAnalysisId, primaryAnalysisId, "primaryEndpoint.analysisId");

  const provenance = object(root.provenance, "provenance");
  exactKeys(provenance, ["baselineCommit", "configPath", "configSha256", "providerPolicy"], "provenance");
  stringMatching(provenance.baselineCommit, COMMIT, "provenance.baselineCommit");
  safeRelativePath(provenance.configPath, "provenance.configPath");
  stringMatching(provenance.configSha256, SHA256, "provenance.configSha256");
  validateProviderPolicy(provenance.providerPolicy);

  const integrity = object(root.integrity, "integrity");
  exactKeys(integrity, ["summary", "payloadSha256"], "integrity");
  const summary = object(integrity.summary, "integrity.summary");
  exactKeys(summary, [
    "rqIds", "hypothesisIds", "analysisIds", "armIds", "faultWindowIds", "seedValues",
    "availableWindowIds", "blockedWindowIds", "gate40PlannedCases", "plannedCases",
  ], "integrity.summary");
  exactArray(summary.rqIds, rqIds, "integrity.summary.rqIds");
  exactArray(summary.hypothesisIds, hypothesisIds, "integrity.summary.hypothesisIds");
  exactArray(summary.analysisIds, analysisIds, "integrity.summary.analysisIds");
  exactArray(summary.armIds, armIds, "integrity.summary.armIds");
  exactArray(summary.faultWindowIds, faultWindowIds, "integrity.summary.faultWindowIds");
  exactNumberArray(summary.seedValues, seeds, "integrity.summary.seedValues");
  exactArray(summary.availableWindowIds, availableWindowIds, "integrity.summary.availableWindowIds");
  exactArray(summary.blockedWindowIds, blockedWindowIds, "integrity.summary.blockedWindowIds");
  equal(summary.gate40PlannedCases, RT95_GATE40_WINDOWS.length * RT95_GATE40_SEEDS.length, "integrity.summary.gate40PlannedCases");
  equal(summary.plannedCases, plannedCases, "integrity.summary.plannedCases");

  if (lifecycle.status === "draft") {
    equal(integrity.payloadSha256, null, "draft integrity.payloadSha256");
  } else {
    const digest = stringMatching(integrity.payloadSha256, SHA256, "frozen integrity.payloadSha256");
    const expected = computePreregistrationDigest(root);
    if (digest !== expected) fail(`frozen payload digest mismatch: expected ${expected}, got ${digest}`);
  }

  return root as Rt95Preregistration;
}

export function computePreregistrationDigest(value: unknown): string {
  const root = structuredClone(object(value, "root"));
  const integrity = object(root.integrity, "integrity");
  integrity.payloadSha256 = null;
  return sha256(canonicalJson(root));
}

export function freezePreregistrationDraft(value: unknown, frozenAt: string): Rt95Preregistration {
  const draft = validateRt95Preregistration(value);
  if (draft.lifecycle.status !== "draft") fail("only a draft preregistration can be frozen");
  canonicalTimestamp(frozenAt, "frozenAt");
  const frozen = structuredClone(draft);
  frozen.lifecycle = { status: "frozen", frozenAt };
  object(frozen.faultPlan, "faultPlan").windowSetLifecycle = "frozen";
  frozen.integrity.payloadSha256 = null;
  frozen.integrity.payloadSha256 = computePreregistrationDigest(frozen);
  return validateRt95Preregistration(frozen);
}

function validateProviderPolicy(value: unknown): void {
  const policy = object(value, "provenance.providerPolicy");
  exactKeys(policy, ["mode", "authorizedLiveCalls", "approvalId", "maxRequests", "maxTotalCostUsd", "allowedProviders"], "provenance.providerPolicy");
  const providers = stringArray(policy.allowedProviders, "provenance.providerPolicy.allowedProviders");
  nonEmptyArray(providers, "provenance.providerPolicy.allowedProviders");
  unique(providers, "provenance.providerPolicy.allowedProviders");
  const maxRequests = nonNegativeInteger(policy.maxRequests, "provenance.providerPolicy.maxRequests");
  const maxCost = nonNegativeNumber(policy.maxTotalCostUsd, "provenance.providerPolicy.maxTotalCostUsd");
  if (policy.mode === "offline-only") {
    equal(policy.authorizedLiveCalls, false, "offline provider authorizedLiveCalls");
    equal(policy.approvalId, null, "offline provider approvalId");
    equal(maxRequests, 0, "offline provider maxRequests");
    equal(maxCost, 0, "offline provider maxTotalCostUsd");
    if (providers.some((provider) => provider !== "none" && provider !== "deterministic-fake")) {
      fail("offline-only provider policy cannot allow a live Provider");
    }
  } else if (policy.mode === "live-authorized") {
    equal(policy.authorizedLiveCalls, true, "live provider authorizedLiveCalls");
    nonEmpty(policy.approvalId, "live provider approvalId");
    if (maxRequests <= 0) fail("live provider maxRequests must be positive");
    if (maxCost <= 0) fail("live provider maxTotalCostUsd must be positive");
    if (providers.every((provider) => provider === "none" || provider === "deterministic-fake")) {
      fail("live-authorized policy must name an actual live Provider");
    }
  } else {
    fail("providerPolicy.mode must be offline-only or live-authorized");
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function object(value: unknown, label: string): JsonObject {
  if (!isObject(value)) fail(`${label} must be an object`);
  return value;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function objectArray(value: unknown, label: string): JsonObject[] {
  return array(value, label).map((entry, index) => object(entry, `${label}[${index}]`));
}

function stringArray(value: unknown, label: string): string[] {
  return array(value, label).map((entry, index) => nonEmpty(entry, `${label}[${index}]`));
}

function exactKeys(value: JsonObject, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} key mismatch; expected [${wanted.join(",")}], got [${actual.join(",")}]`);
  }
}

function exactArray(value: unknown, expected: readonly string[], label: string): void {
  const actual = stringArray(value, label);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} summary mismatch; expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function exactNumberArray(value: unknown, expected: readonly number[], label: string): void {
  const actual = array(value, label).map((entry, index) => nonNegativeInteger(entry, `${label}[${index}]`));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} mismatch; expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function equal(actual: unknown, expected: unknown, label: string): void {
  if (!Object.is(actual, expected)) fail(`${label} must equal ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function stringMatching(value: unknown, pattern: RegExp, label: string): string {
  const text = nonEmpty(value, label);
  if (!pattern.test(text)) fail(`${label} has invalid format: ${text}`);
  return text;
}

function validId(value: unknown, label: string): string {
  return stringMatching(value, ID, label);
}

function positiveNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) fail(`${label} must be a positive finite number`);
  return value;
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail(`${label} must be a non-negative finite number`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const number = nonNegativeInteger(value, label);
  if (number <= 0) fail(`${label} must be positive`);
  return number;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail(`${label} must be a non-negative safe integer`);
  return Number(value);
}

function uint32(value: unknown, label: string): number {
  const number = nonNegativeInteger(value, label);
  if (number > UINT32_MAX) fail(`${label} must be an unsigned 32-bit integer`);
  return number;
}

function probabilityExclusive(value: unknown, label: string): number {
  const number = positiveNumber(value, label);
  if (number >= 1) fail(`${label} must be below 1`);
  return number;
}

function probabilityInclusive(value: unknown, label: string): number {
  const number = nonNegativeNumber(value, label);
  if (number > 1) fail(`${label} must be at most 1`);
  return number;
}

function unique<T>(values: readonly T[], label: string): void {
  if (new Set(values).size !== values.length) fail(`${label} contains duplicates`);
}

function nonEmptyArray(value: readonly unknown[], label: string): void {
  if (value.length === 0) fail(`${label} cannot be empty`);
}

function canonicalTimestamp(value: unknown, label: string): string {
  const text = nonEmpty(value, label);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== text) {
    fail(`${label} must be canonical ISO-8601 UTC`);
  }
  return text;
}

function safeRelativePath(value: unknown, label: string): string {
  const text = nonEmpty(value, label);
  if (text.includes("\\") || text.includes("\0") || path.posix.isAbsolute(text) || path.win32.isAbsolute(text)) {
    fail(`${label} must be a safe repository-relative POSIX path`);
  }
  if (text.split("/").some((part) => part.length === 0 || part === "." || part === "..") || path.posix.normalize(text) !== text) {
    fail(`${label} contains an unsafe path segment`);
  }
  return text;
}

function fail(message: string): never {
  throw new Error(`RT95 preregistration validation failed: ${message}`);
}

function parseCli(args: string[]): { file: string; printDigest: boolean } {
  let file: string | undefined;
  let printDigest = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--file") {
      file = args[++index];
      if (file === undefined) fail("--file requires a JSON path");
    } else if (argument === "--print-digest") {
      printDigest = true;
    } else {
      fail(`unknown CLI argument: ${argument ?? ""}`);
    }
  }
  if (file === undefined) fail("missing --file <preregistration.json>");
  return { file, printDigest };
}

function runCli(): void {
  const options = parseCli(process.argv.slice(2));
  const parsed: unknown = JSON.parse(readFileSync(path.resolve(options.file), "utf8"));
  const registration = validateRt95Preregistration(parsed);
  process.stdout.write(`${JSON.stringify({
    status: "valid",
    registrationId: registration.registrationId,
    lifecycle: registration.lifecycle.status,
    verification: registration.verification.status,
    ...(options.printDigest ? { candidatePayloadSha256: computePreregistrationDigest(registration) } : {}),
    claimBoundary: "input-complete-only; not experiment-executed or Verified",
  })}\n`);
}

const invokedAsScript = process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) runCli();
