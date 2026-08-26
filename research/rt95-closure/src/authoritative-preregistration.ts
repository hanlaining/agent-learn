import {
  computePreregistrationDigest,
  RT95_GATE40_WINDOWS,
  validateRt95Preregistration,
  type Rt95Preregistration,
} from "../../../scripts/validate-rt95-preregistration.js";

export const GATE40_PROTOCOL_SCHEMA_VERSION = "rt95-gate40-authoritative-protocol-v1" as const;
export const GATE40_PROTOCOL_CLAIM_BOUNDARY = "local-pilot-protocol-only-not-formal" as const;

const EXPECTED_COMMAND = "node --import tsx src/app-server/main.ts";
const EXPECTED_HARNESS = "research/runtime-e2e-benchmarks/src/process-chaos-harness.ts";
const EXPECTED_SEEDS = [469816031, 3443330994, 4121183031, 3314624278, 3472974415] as const;
const EXPECTED_SEED_SHA = "5a9b5ec4193f82477fa09a5f47537915478d8982c615074725f179036342ca7b";

export interface Gate40AuthoritativeProtocol {
  schemaVersion: typeof GATE40_PROTOCOL_SCHEMA_VERSION;
  authority: "current-research-candidate";
  lifecycle: "candidate-not-frozen";
  claimBoundary: typeof GATE40_PROTOCOL_CLAIM_BOUNDARY;
  gateId: "EXP-RT95-032";
  pairing: "same-seed-across-arms";
  seedPlan: {
    algorithm: "xorshift32-v1";
    masterSeed: 20260824;
    seeds: number[];
    seedListSha256: string;
  };
  windows: Array<{
    id: string;
    oracleId: string;
    readiness: "available";
    productionCommand: typeof EXPECTED_COMMAND;
    harnessPath: typeof EXPECTED_HARNESS;
    localPilot: { planned: 5; passed: 5; failed: 0 };
  }>;
  summary: {
    windowCount: 8;
    seedsPerWindow: 5;
    plannedCases: 40;
    localPassed: 40;
    localFailed: 0;
    formalVerified: 0;
    completeFormalGate40: false;
  };
}

type JsonObject = Record<string, unknown>;

export function validateGate40AuthoritativeProtocol(value: unknown): Gate40AuthoritativeProtocol {
  const root = object(value, "protocol");
  exactKeys(root, ["schemaVersion", "authority", "lifecycle", "claimBoundary", "gateId", "pairing", "seedPlan", "windows", "summary"], "protocol");
  equal(root.schemaVersion, GATE40_PROTOCOL_SCHEMA_VERSION, "protocol.schemaVersion");
  equal(root.authority, "current-research-candidate", "protocol.authority");
  equal(root.lifecycle, "candidate-not-frozen", "protocol.lifecycle");
  equal(root.claimBoundary, GATE40_PROTOCOL_CLAIM_BOUNDARY, "protocol.claimBoundary");
  equal(root.gateId, "EXP-RT95-032", "protocol.gateId");
  equal(root.pairing, "same-seed-across-arms", "protocol.pairing");

  const seedPlan = object(root.seedPlan, "protocol.seedPlan");
  exactKeys(seedPlan, ["algorithm", "masterSeed", "seeds", "seedListSha256"], "protocol.seedPlan");
  equal(seedPlan.algorithm, "xorshift32-v1", "protocol.seedPlan.algorithm");
  equal(seedPlan.masterSeed, 20260824, "protocol.seedPlan.masterSeed");
  exactArray(seedPlan.seeds, EXPECTED_SEEDS, "protocol.seedPlan.seeds");
  equal(seedPlan.seedListSha256, EXPECTED_SEED_SHA, "protocol.seedPlan.seedListSha256");

  const windows = array(root.windows, "protocol.windows").map((item, index) => object(item, `protocol.windows[${index}]`));
  if (windows.length !== RT95_GATE40_WINDOWS.length) fail("protocol must contain exactly eight windows");
  for (const [index, expected] of RT95_GATE40_WINDOWS.entries()) {
    const window = windows[index]!;
    exactKeys(window, ["id", "oracleId", "readiness", "productionCommand", "harnessPath", "localPilot"], `protocol.windows[${index}]`);
    equal(window.id, expected.id, `protocol.windows[${index}].id`);
    equal(window.oracleId, expected.oracleId, `protocol.windows[${index}].oracleId`);
    equal(window.readiness, "available", `protocol.windows[${index}].readiness`);
    equal(window.productionCommand, EXPECTED_COMMAND, `protocol.windows[${index}].productionCommand`);
    equal(window.harnessPath, EXPECTED_HARNESS, `protocol.windows[${index}].harnessPath`);
    const pilot = object(window.localPilot, `protocol.windows[${index}].localPilot`);
    exactKeys(pilot, ["planned", "passed", "failed"], `protocol.windows[${index}].localPilot`);
    equal(pilot.planned, 5, `protocol.windows[${index}].localPilot.planned`);
    equal(pilot.passed, 5, `protocol.windows[${index}].localPilot.passed`);
    equal(pilot.failed, 0, `protocol.windows[${index}].localPilot.failed`);
  }

  const summary = object(root.summary, "protocol.summary");
  exactKeys(summary, ["windowCount", "seedsPerWindow", "plannedCases", "localPassed", "localFailed", "formalVerified", "completeFormalGate40"], "protocol.summary");
  for (const [key, expected] of Object.entries({
    windowCount: 8, seedsPerWindow: 5, plannedCases: 40, localPassed: 40, localFailed: 0, formalVerified: 0,
  })) equal(summary[key], expected, `protocol.summary.${key}`);
  equal(summary.completeFormalGate40, false, "protocol.summary.completeFormalGate40");
  return value as Gate40AuthoritativeProtocol;
}

export function materializeAuthoritativePreregistrationCandidate(
  smokeDraftValue: unknown,
  protocolValue: unknown,
): Rt95Preregistration {
  const smoke = structuredClone(validateRt95Preregistration(smokeDraftValue)) as unknown as JsonObject;
  const protocol = validateGate40AuthoritativeProtocol(protocolValue);
  const lifecycle = object(smoke.lifecycle, "preregistration.lifecycle");
  equal(lifecycle.status, "draft", "preregistration.lifecycle.status");
  const faultPlan = object(smoke.faultPlan, "preregistration.faultPlan");
  const windows = array(faultPlan.windows, "preregistration.faultPlan.windows").map((item, index) =>
    object(item, `preregistration.faultPlan.windows[${index}]`));
  for (const [index, protocolWindow] of protocol.windows.entries()) {
    const window = windows[index]!;
    equal(window.id, protocolWindow.id, `preregistration.faultPlan.windows[${index}].id`);
    const productionEntry = object(window.productionEntry, `preregistration.faultPlan.windows[${index}].productionEntry`);
    productionEntry.command = protocolWindow.productionCommand;
    productionEntry.harnessPath = protocolWindow.harnessPath;
    const readiness = object(window.readiness, `preregistration.faultPlan.windows[${index}].readiness`);
    readiness.status = "available";
    readiness.blockedReason = null;
  }
  const integrity = object(smoke.integrity, "preregistration.integrity");
  const summary = object(integrity.summary, "preregistration.integrity.summary");
  summary.availableWindowIds = protocol.windows.map((window) => window.id);
  summary.blockedWindowIds = [];
  integrity.payloadSha256 = null;
  return validateAuthoritativeRt95Preregistration(smoke);
}

export function freezeAuthoritativePreregistrationDraft(
  draftValue: unknown,
  frozenAt: string,
): Rt95Preregistration {
  const draft = structuredClone(validateAuthoritativeRt95Preregistration(draftValue)) as unknown as JsonObject;
  equal(object(draft.lifecycle, "preregistration.lifecycle").status, "draft", "preregistration.lifecycle.status");
  object(draft.lifecycle, "preregistration.lifecycle").status = "frozen";
  object(draft.lifecycle, "preregistration.lifecycle").frozenAt = frozenAt;
  object(draft.faultPlan, "preregistration.faultPlan").windowSetLifecycle = "frozen";
  object(draft.integrity, "preregistration.integrity").payloadSha256 = null;
  object(draft.integrity, "preregistration.integrity").payloadSha256 =
    computePreregistrationDigest(draft as unknown as Rt95Preregistration);
  return validateAuthoritativeRt95Preregistration(draft);
}

export function validateAuthoritativeRt95Preregistration(value: unknown): Rt95Preregistration {
  const original = object(value, "authoritative preregistration");
  const faultPlan = object(original.faultPlan, "authoritative preregistration.faultPlan");
  const windows = array(faultPlan.windows, "authoritative preregistration.faultPlan.windows")
    .map((item, index) => object(item, `authoritative preregistration.faultPlan.windows[${index}]`));
  if (windows.length !== RT95_GATE40_WINDOWS.length) fail("authoritative preregistration must contain eight windows");
  for (const [index, expected] of RT95_GATE40_WINDOWS.entries()) {
    const window = windows[index]!;
    equal(window.id, expected.id, `authoritative preregistration window[${index}].id`);
    equal(object(window.oracle, `window[${index}].oracle`).id, expected.oracleId, `window[${index}].oracle.id`);
    const readiness = object(window.readiness, `window[${index}].readiness`);
    equal(readiness.status, "available", `window[${index}].readiness.status`);
    equal(readiness.blockedReason, null, `window[${index}].readiness.blockedReason`);
    const productionEntry = object(window.productionEntry, `window[${index}].productionEntry`);
    equal(productionEntry.command, EXPECTED_COMMAND, `window[${index}].productionEntry.command`);
    equal(productionEntry.harnessPath, EXPECTED_HARNESS, `window[${index}].productionEntry.harnessPath`);
  }
  const summary = object(object(original.integrity, "authoritative preregistration.integrity").summary, "authoritative preregistration.integrity.summary");
  exactArray(summary.availableWindowIds, RT95_GATE40_WINDOWS.map((window) => window.id), "authoritative availableWindowIds");
  exactArray(summary.blockedWindowIds, [], "authoritative blockedWindowIds");

  const lifecycle = object(original.lifecycle, "authoritative preregistration.lifecycle");
  if (lifecycle.status === "frozen") {
    const actualDigest = object(original.integrity, "authoritative preregistration.integrity").payloadSha256;
    equal(actualDigest, computePreregistrationDigest(original as unknown as Rt95Preregistration), "authoritative preregistration payload digest");
  }

  const compatibility = structuredClone(original);
  const compatibilityWindows = array(object(compatibility.faultPlan, "compatibility.faultPlan").windows, "compatibility windows")
    .map((item, index) => object(item, `compatibility window[${index}]`));
  for (const [index, legacy] of RT95_GATE40_WINDOWS.entries()) {
    if (legacy.readiness === "available") continue;
    const window = compatibilityWindows[index]!;
    const productionEntry = object(window.productionEntry, `compatibility window[${index}].productionEntry`);
    productionEntry.command = null;
    productionEntry.harnessPath = null;
    const readiness = object(window.readiness, `compatibility window[${index}].readiness`);
    readiness.status = "blocked";
    readiness.blockedReason = "legacy-smoke-validator-compatibility-only";
  }
  const compatibilityIntegrity = object(compatibility.integrity, "compatibility.integrity");
  const compatibilitySummary = object(compatibilityIntegrity.summary, "compatibility.integrity.summary");
  compatibilitySummary.availableWindowIds = RT95_GATE40_WINDOWS.filter((window) => window.readiness === "available").map((window) => window.id);
  compatibilitySummary.blockedWindowIds = RT95_GATE40_WINDOWS.filter((window) => window.readiness === "blocked").map((window) => window.id);
  if (object(compatibility.lifecycle, "compatibility.lifecycle").status === "frozen") {
    compatibilityIntegrity.payloadSha256 = null;
    compatibilityIntegrity.payloadSha256 = computePreregistrationDigest(compatibility as unknown as Rt95Preregistration);
  }
  validateRt95Preregistration(compatibility);
  return value as Rt95Preregistration;
}

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value as JsonObject;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function exactKeys(value: JsonObject, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} key mismatch`);
  }
}

function exactArray(actual: unknown, expected: readonly unknown[], label: string): void {
  if (!Array.isArray(actual) || JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} mismatch`);
}

function equal(actual: unknown, expected: unknown, label: string): void {
  if (!Object.is(actual, expected)) fail(`${label} must equal ${JSON.stringify(expected)}`);
}

function fail(message: string): never {
  throw new Error(`RT95 authoritative protocol validation failed: ${message}`);
}
