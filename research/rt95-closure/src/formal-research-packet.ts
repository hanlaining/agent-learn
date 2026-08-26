import { createHash } from "node:crypto";

import {
  computePreregistrationDigest,
  type Rt95Preregistration,
} from "../../../scripts/validate-rt95-preregistration.js";
import { validateAuthoritativeRt95Preregistration } from "./authoritative-preregistration.js";

export const FORMAL_RESEARCH_PACKET_SCHEMA_VERSION = "rt95-formal-research-packet-v1" as const;
export const FORMAL_RAW_LEDGER_SCHEMA_VERSION = "rt95-formal-raw-ledger-v1" as const;
export const CLAIM_EVIDENCE_MATRIX_SCHEMA_VERSION = "rt95-claim-evidence-matrix-v1" as const;
export const FORMAL_PACKET_CLAIM_BOUNDARY = "preflight-only-not-formal-or-external-verification" as const;

const COMMIT = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MACHINE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

export type RawOutcome = "success" | "failure" | "excluded" | "aborted";
export type RawLedgerEventType =
  | "ledger-opened"
  | "case-started"
  | "case-recorded"
  | "rerun-authorized"
  | "manual-intervention-recorded"
  | "ledger-sealed";

export interface FormalCasePlan {
  caseId: string;
  armId: string;
  faultWindowId: string;
  seed: number;
}

export interface FormalRawLedgerEvent {
  sequence: number;
  eventId: string;
  eventType: RawLedgerEventType;
  occurredAt: string;
  caseId: string | null;
  attempt: number | null;
  outcome: RawOutcome | null;
  artifactPath: string | null;
  artifactSha256: string | null;
  reason: string | null;
  previousEventSha256: string | null;
  eventSha256: string;
}

export interface FormalRawLedger {
  schemaVersion: typeof FORMAL_RAW_LEDGER_SCHEMA_VERSION;
  claimBoundary: typeof FORMAL_PACKET_CLAIM_BOUNDARY;
  packetId: string;
  bindingsSha256: string;
  status: "open" | "sealed";
  events: FormalRawLedgerEvent[];
}

export interface ClaimTableClaim {
  id: string;
  evidenceState: "CodeVerified" | "NotVerified";
  requiredEvidence: string[];
}

export interface ClaimTable {
  schemaVersion: "rt95-paper-claim-table-v1";
  claims: ClaimTableClaim[];
}

export interface ClaimEvidenceItem {
  requirement: string;
  status: "NotVerified" | "Verified";
  artifactPath: string | null;
  artifactSha256: string | null;
  ledgerEventSha256: string | null;
  producerId: string | null;
  reviewerId: string | null;
}

export interface ClaimEvidenceEntry {
  claimId: string;
  claimClass: "code" | "formal-result" | "external" | "publication" | "maturity";
  status: "NotVerified" | "CodeVerified";
  evidence: ClaimEvidenceItem[];
}

export interface ClaimEvidenceMatrix {
  schemaVersion: typeof CLAIM_EVIDENCE_MATRIX_SCHEMA_VERSION;
  claimBoundary: typeof FORMAL_PACKET_CLAIM_BOUNDARY;
  claims: ClaimEvidenceEntry[];
}

export interface FormalResearchPacket {
  schemaVersion: typeof FORMAL_RESEARCH_PACKET_SCHEMA_VERSION;
  claimBoundary: typeof FORMAL_PACKET_CLAIM_BOUNDARY;
  packetId: string;
  lifecycle: "preflight";
  preflight: {
    status: "blocked" | "ready-to-run";
    blockers: string[];
  };
  verification: {
    formalVerified: false;
    externalReproduced: false;
    independentReviewCompleted: false;
  };
  bindings: {
    preregistrationPayloadSha256: string;
    baselineCommit: string;
    sourceTreeSha256: string;
    lockfileSha256: string;
    configSha256: string;
  };
  roles: {
    executorId: string;
    reviewerId: string;
    independence: "declared-independent-not-yet-reviewed";
  };
  providerPreflight: {
    mode: "offline-only" | "live-authorized";
    kind: "deterministic-fake" | "live-provider-authorized-not-called";
    realApiCalls: 0;
    credentialsRead: false;
    authorizationId: string | null;
    maxRequests: number;
    maxTotalCostUsd: number;
  };
  plan: {
    experimentId: string;
    pairing: "same-seed-across-arms";
    plannedCaseCount: number;
    casePlanSha256: string;
    cases: FormalCasePlan[];
  };
  ledger: FormalRawLedger;
  claimEvidence: ClaimEvidenceMatrix;
}

export interface FormalPacketSourceBindings {
  baselineCommit: string;
  sourceTreeSha256: string;
  lockfileSha256: string;
  configSha256: string;
}

export interface FormalPacketRoles {
  executorId: string;
  reviewerId: string;
}

export type AppendLedgerEventInput = Omit<FormalRawLedgerEvent,
  "sequence" | "previousEventSha256" | "eventSha256">;

export function createFormalResearchPacket(
  preregistrationValue: unknown,
  claimTableValue: unknown,
  options: {
    packetId: string;
    openedAt: string;
    source: FormalPacketSourceBindings;
    roles: FormalPacketRoles;
  },
): FormalResearchPacket {
  const preregistration = validateFrozenPreregistration(preregistrationValue);
  const claimTable = validateClaimTable(claimTableValue);
  const packetId = machineId(options.packetId, "packetId");
  const bindings = validateSourceBindings(options.source, preregistration);
  const roles = validateRoles(options.roles);
  const plan = deriveFormalCasePlan(preregistration);
  const providerPreflight = deriveProviderPreflight(preregistration);
  const bindingsSha256 = sha256(canonicalJson({ bindings, packetId, planSha256: plan.casePlanSha256 }));
  const ledger = createFormalRawLedger(packetId, bindingsSha256, options.openedAt);
  const packet: FormalResearchPacket = {
    schemaVersion: FORMAL_RESEARCH_PACKET_SCHEMA_VERSION,
    claimBoundary: FORMAL_PACKET_CLAIM_BOUNDARY,
    packetId,
    lifecycle: "preflight",
    preflight: derivePreflightStatus(preregistration),
    verification: {
      formalVerified: false,
      externalReproduced: false,
      independentReviewCompleted: false,
    },
    bindings,
    roles,
    providerPreflight,
    plan,
    ledger,
    claimEvidence: createClaimEvidenceMatrix(claimTable),
  };
  validateFormalResearchPacket(packet, preregistration, claimTable);
  return packet;
}

export function validateFormalResearchPacket(
  value: unknown,
  preregistrationValue: unknown,
  claimTableValue: unknown,
): FormalResearchPacket {
  const preregistration = validateFrozenPreregistration(preregistrationValue);
  const claimTable = validateClaimTable(claimTableValue);
  const packet = object(value, "formal packet");
  exactKeys(packet, [
    "schemaVersion", "claimBoundary", "packetId", "lifecycle", "preflight", "verification", "bindings", "roles",
    "providerPreflight", "plan", "ledger", "claimEvidence",
  ], "formal packet");
  constant(packet.schemaVersion, FORMAL_RESEARCH_PACKET_SCHEMA_VERSION, "packet.schemaVersion");
  constant(packet.claimBoundary, FORMAL_PACKET_CLAIM_BOUNDARY, "packet.claimBoundary");
  const packetId = machineId(packet.packetId, "packet.packetId");
  constant(packet.lifecycle, "preflight", "packet.lifecycle");
  const expectedPreflight = derivePreflightStatus(preregistration);
  if (canonicalJson(packet.preflight) !== canonicalJson(expectedPreflight)) fail("packet preflight blockers do not match frozen inputs");

  const verification = object(packet.verification, "packet.verification");
  exactKeys(verification, ["formalVerified", "externalReproduced", "independentReviewCompleted"], "packet.verification");
  constant(verification.formalVerified, false, "packet.verification.formalVerified");
  constant(verification.externalReproduced, false, "packet.verification.externalReproduced");
  constant(verification.independentReviewCompleted, false, "packet.verification.independentReviewCompleted");

  const bindings = validateSourceBindings(packet.bindings as FormalPacketSourceBindings, preregistration);
  validateRoles(packet.roles as FormalPacketRoles & { independence?: unknown });
  const expectedPlan = deriveFormalCasePlan(preregistration);
  validatePlan(packet.plan, expectedPlan);
  validateProviderPreflight(packet.providerPreflight, preregistration);

  const expectedBindingsSha256 = sha256(canonicalJson({ bindings, packetId, planSha256: expectedPlan.casePlanSha256 }));
  const ledger = validateFormalRawLedger(packet.ledger, expectedPlan.cases);
  if (ledger.packetId !== packetId || ledger.bindingsSha256 !== expectedBindingsSha256) {
    fail("formal ledger is not bound to packet inputs");
  }
  if (ledger.status !== "open" || ledger.events.length !== 1 || ledger.events[0]?.eventType !== "ledger-opened") {
    fail("preflight packet must contain only the initial open ledger event");
  }
  validateClaimEvidenceMatrix(packet.claimEvidence, claimTable, ledger, expectedPlan.cases);
  return value as FormalResearchPacket;
}

export function deriveFormalCasePlan(preregistration: Rt95Preregistration): FormalResearchPacket["plan"] {
  const faultPlan = object(preregistration.faultPlan, "preregistration.faultPlan");
  const seedPlan = object(preregistration.seedPlan, "preregistration.seedPlan");
  const arms = object(preregistration.arms, "preregistration.arms");
  const baseline = object(arms.baseline, "preregistration.arms.baseline");
  const armIds = [
    machineId(baseline.id, "baseline arm id"),
    ...objectArray(arms.ablations, "ablation arms").map((arm, index) => machineId(arm.id, `ablation[${index}].id`)),
    ...objectArray(arms.externalBaselines, "external arms").map((arm, index) => machineId(arm.id, `external[${index}].id`)),
  ].sort(compare);
  unique(armIds, "formal arm IDs");
  const windows = objectArray(faultPlan.windows, "fault windows")
    .map((window, index) => machineId(window.id, `window[${index}].id`));
  const seeds = array(seedPlan.seeds, "seeds").map((seed, index) => uint32(seed, `seed[${index}]`));
  const cases = armIds.flatMap((armId) => windows.flatMap((faultWindowId) => seeds.map((seed): FormalCasePlan => ({
    caseId: formalCaseId(armId, faultWindowId, seed),
    armId,
    faultWindowId,
    seed,
  })))).sort(compareCases);
  const plannedCaseCount = positiveInteger(faultPlan.totalPlannedCases, "faultPlan.totalPlannedCases");
  if (cases.length !== plannedCaseCount) fail(`derived formal case count ${cases.length} does not match preregistration ${plannedCaseCount}`);
  return {
    experimentId: machineId(faultPlan.gateId, "faultPlan.gateId"),
    pairing: "same-seed-across-arms",
    plannedCaseCount,
    casePlanSha256: sha256(canonicalJson(cases)),
    cases,
  };
}

export function formalCaseId(armId: string, faultWindowId: string, seed: number): string {
  return `CASE-${sha256(`${armId}\u0000${faultWindowId}\u0000${seed}`).slice(0, 24).toUpperCase()}`;
}

export function createFormalRawLedger(packetId: string, bindingsSha256: string, openedAt: string): FormalRawLedger {
  machineId(packetId, "ledger packetId");
  digest(bindingsSha256, "ledger bindingsSha256");
  const initial = materializeEvent({
    eventId: "EVENT-LEDGER-OPENED",
    eventType: "ledger-opened",
    occurredAt: canonicalTimestamp(openedAt, "ledger openedAt"),
    caseId: null,
    attempt: null,
    outcome: null,
    artifactPath: null,
    artifactSha256: null,
    reason: null,
  }, 0, null);
  return {
    schemaVersion: FORMAL_RAW_LEDGER_SCHEMA_VERSION,
    claimBoundary: FORMAL_PACKET_CLAIM_BOUNDARY,
    packetId,
    bindingsSha256,
    status: "open",
    events: [initial],
  };
}

export function appendFormalRawLedgerEvent(
  ledgerValue: unknown,
  plannedCases: readonly FormalCasePlan[],
  input: AppendLedgerEventInput,
): FormalRawLedger {
  const ledger = structuredClone(validateFormalRawLedger(ledgerValue, plannedCases));
  if (ledger.status !== "open") fail("cannot append to a sealed formal Raw ledger");
  const previous = ledger.events.at(-1)!;
  const event = materializeEvent(input, ledger.events.length, previous.eventSha256);
  ledger.events.push(event);
  if (event.eventType === "ledger-sealed") ledger.status = "sealed";
  return validateFormalRawLedger(ledger, plannedCases);
}

export function validateFormalRawLedger(value: unknown, plannedCases: readonly FormalCasePlan[]): FormalRawLedger {
  const ledger = object(value, "formal Raw ledger");
  exactKeys(ledger, ["schemaVersion", "claimBoundary", "packetId", "bindingsSha256", "status", "events"], "formal Raw ledger");
  constant(ledger.schemaVersion, FORMAL_RAW_LEDGER_SCHEMA_VERSION, "ledger.schemaVersion");
  constant(ledger.claimBoundary, FORMAL_PACKET_CLAIM_BOUNDARY, "ledger.claimBoundary");
  machineId(ledger.packetId, "ledger.packetId");
  digest(ledger.bindingsSha256, "ledger.bindingsSha256");
  if (ledger.status !== "open" && ledger.status !== "sealed") fail("ledger.status must be open or sealed");
  const caseIds = new Set(plannedCases.map((item) => item.caseId));
  if (caseIds.size === 0 || caseIds.size !== plannedCases.length) fail("planned case IDs must be non-empty and unique");

  const rawEvents = array(ledger.events, "ledger.events");
  if (rawEvents.length === 0) fail("formal Raw ledger cannot be empty");
  const events: FormalRawLedgerEvent[] = [];
  const eventIds = new Set<string>();
  const attempts = new Map<string, { lastRecorded: number; activeAttempt: number | null; authorizedAttempt: number | null }>();
  let previousHash: string | null = null;
  let previousTime = -Infinity;
  for (const [index, rawEvent] of rawEvents.entries()) {
    const event = validateEvent(rawEvent, index, previousHash, caseIds);
    if (eventIds.has(event.eventId)) fail(`duplicate ledger eventId: ${event.eventId}`);
    eventIds.add(event.eventId);
    const time = Date.parse(event.occurredAt);
    if (time < previousTime) fail(`ledger event time moved backwards at sequence ${index}`);
    previousTime = time;
    previousHash = event.eventSha256;
    events.push(event);
    applyCaseTransition(event, attempts, caseIds.size);
  }
  if (events[0]?.eventType !== "ledger-opened") fail("first ledger event must be ledger-opened");
  if (events.slice(1).some((event) => event.eventType === "ledger-opened")) fail("ledger-opened may appear only once");
  const sealedEvents = events.filter((event) => event.eventType === "ledger-sealed");
  if ((ledger.status === "sealed") !== (sealedEvents.length === 1 && events.at(-1)?.eventType === "ledger-sealed")) {
    fail("ledger sealed status/event mismatch");
  }
  return value as FormalRawLedger;
}

export function assertFormalRawLedgerAppendOnly(
  previousValue: unknown,
  nextValue: unknown,
  plannedCases: readonly FormalCasePlan[],
): void {
  const previous = validateFormalRawLedger(previousValue, plannedCases);
  const next = validateFormalRawLedger(nextValue, plannedCases);
  if (next.events.length < previous.events.length) fail("formal Raw ledger history was truncated");
  for (let index = 0; index < previous.events.length; index += 1) {
    if (canonicalJson(previous.events[index]) !== canonicalJson(next.events[index])) {
      fail(`formal Raw ledger history was rewritten at sequence ${index}`);
    }
  }
  if (previous.status === "sealed" && canonicalJson(previous) !== canonicalJson(next)) {
    fail("sealed formal Raw ledger cannot change");
  }
}

export function createClaimEvidenceMatrix(claimTableValue: unknown): ClaimEvidenceMatrix {
  const claimTable = validateClaimTable(claimTableValue);
  return {
    schemaVersion: CLAIM_EVIDENCE_MATRIX_SCHEMA_VERSION,
    claimBoundary: FORMAL_PACKET_CLAIM_BOUNDARY,
    claims: claimTable.claims.map((claim) => ({
      claimId: claim.id,
      claimClass: claimClass(claim.id),
      status: "NotVerified",
      evidence: claim.requiredEvidence.map((requirement) => ({
        requirement,
        status: "NotVerified",
        artifactPath: null,
        artifactSha256: null,
        ledgerEventSha256: null,
        producerId: null,
        reviewerId: null,
      })),
    })),
  };
}

export function validateClaimEvidenceMatrix(
  value: unknown,
  claimTableValue: unknown,
  ledgerValue?: unknown,
  plannedCases: readonly FormalCasePlan[] = [],
): ClaimEvidenceMatrix {
  const claimTable = validateClaimTable(claimTableValue);
  const ledgerHashes = ledgerValue === undefined ? new Set<string>() :
    new Set(validateFormalRawLedger(ledgerValue, plannedCases).events.map((event) => event.eventSha256));
  const matrix = object(value, "claim evidence matrix");
  exactKeys(matrix, ["schemaVersion", "claimBoundary", "claims"], "claim evidence matrix");
  constant(matrix.schemaVersion, CLAIM_EVIDENCE_MATRIX_SCHEMA_VERSION, "matrix.schemaVersion");
  constant(matrix.claimBoundary, FORMAL_PACKET_CLAIM_BOUNDARY, "matrix.claimBoundary");
  const entries = objectArray(matrix.claims, "matrix.claims");
  if (entries.length !== claimTable.claims.length) fail("claim evidence matrix must cover every Claim Table entry exactly once");
  for (const [index, claim] of claimTable.claims.entries()) {
    const entry = entries[index]!;
    exactKeys(entry, ["claimId", "claimClass", "status", "evidence"], `matrix.claims[${index}]`);
    constant(entry.claimId, claim.id, `matrix.claims[${index}].claimId`);
    const classification = claimClass(claim.id);
    constant(entry.claimClass, classification, `matrix.claims[${index}].claimClass`);
    if (entry.status !== "NotVerified" && entry.status !== "CodeVerified") fail(`invalid Claim status for ${claim.id}`);
    if (classification !== "code" && entry.status !== "NotVerified") {
      fail(`preflight packet cannot verify formal/external/publication Claim ${claim.id}`);
    }
    const evidence = objectArray(entry.evidence, `matrix.claims[${index}].evidence`);
    if (evidence.length !== claim.requiredEvidence.length) fail(`evidence requirement count mismatch for ${claim.id}`);
    let allVerified = true;
    for (const [evidenceIndex, requirement] of claim.requiredEvidence.entries()) {
      const item = evidence[evidenceIndex]!;
      validateEvidenceItem(item, requirement, `${claim.id}.evidence[${evidenceIndex}]`, ledgerHashes);
      if (item.status !== "Verified") allVerified = false;
    }
    if ((entry.status === "CodeVerified") !== allVerified) {
      fail(`Claim status/evidence closure mismatch for ${claim.id}`);
    }
  }
  return value as ClaimEvidenceMatrix;
}

function validateFrozenPreregistration(value: unknown): Rt95Preregistration {
  const preregistration = validateAuthoritativeRt95Preregistration(value);
  if (preregistration.lifecycle.status !== "frozen" || preregistration.lifecycle.frozenAt === null) {
    fail("formal preflight requires a frozen preregistration");
  }
  const payloadSha256 = digest(preregistration.integrity.payloadSha256, "preregistration payloadSha256");
  if (computePreregistrationDigest(preregistration) !== payloadSha256) fail("preregistration payload digest mismatch");
  return preregistration;
}

function validateSourceBindings(value: FormalPacketSourceBindings, preregistration: Rt95Preregistration): FormalResearchPacket["bindings"] {
  const bindings = object(value, "source bindings");
  const hasPreregistrationDigest = "preregistrationPayloadSha256" in bindings;
  exactKeys(bindings, [
    ...(hasPreregistrationDigest ? ["preregistrationPayloadSha256"] : []),
    "baselineCommit", "sourceTreeSha256", "lockfileSha256", "configSha256",
  ], "source bindings");
  const baselineCommit = stringValue(bindings.baselineCommit, "bindings.baselineCommit");
  if (!COMMIT.test(baselineCommit) || /^0+$/u.test(baselineCommit)) fail("bindings.baselineCommit must be a non-zero lowercase commit hash");
  const provenance = object(preregistration.provenance, "preregistration.provenance");
  const preregistrationPayloadSha256 = digest(preregistration.integrity.payloadSha256, "preregistration payloadSha256");
  if (hasPreregistrationDigest && bindings.preregistrationPayloadSha256 !== preregistrationPayloadSha256) {
    fail("source bindings preregistration digest mismatch");
  }
  const configSha256 = digest(bindings.configSha256, "bindings.configSha256");
  if (configSha256 !== provenance.configSha256) fail("source config digest does not match frozen preregistration");
  return {
    preregistrationPayloadSha256,
    baselineCommit,
    sourceTreeSha256: nonZeroDigest(bindings.sourceTreeSha256, "bindings.sourceTreeSha256"),
    lockfileSha256: nonZeroDigest(bindings.lockfileSha256, "bindings.lockfileSha256"),
    configSha256,
  };
}

function validateRoles(value: FormalPacketRoles & { independence?: unknown }): FormalResearchPacket["roles"] {
  const roles = object(value, "roles");
  const expectedKeys = "independence" in roles ? ["executorId", "reviewerId", "independence"] : ["executorId", "reviewerId"];
  exactKeys(roles, expectedKeys, "roles");
  const executorId = machineId(roles.executorId, "roles.executorId");
  const reviewerId = machineId(roles.reviewerId, "roles.reviewerId");
  if (executorId === reviewerId) fail("formal executor and reviewer must be different identities");
  if ("independence" in roles) constant(roles.independence, "declared-independent-not-yet-reviewed", "roles.independence");
  return { executorId, reviewerId, independence: "declared-independent-not-yet-reviewed" };
}

function deriveProviderPreflight(preregistration: Rt95Preregistration): FormalResearchPacket["providerPreflight"] {
  const policy = object(object(preregistration.provenance, "provenance").providerPolicy, "providerPolicy");
  if (policy.mode === "offline-only") {
    return {
      mode: "offline-only",
      kind: "deterministic-fake",
      realApiCalls: 0,
      credentialsRead: false,
      authorizationId: null,
      maxRequests: 0,
      maxTotalCostUsd: 0,
    };
  }
  return {
    mode: "live-authorized",
    kind: "live-provider-authorized-not-called",
    realApiCalls: 0,
    credentialsRead: false,
    authorizationId: stringValue(policy.approvalId, "providerPolicy.approvalId"),
    maxRequests: positiveInteger(policy.maxRequests, "providerPolicy.maxRequests"),
    maxTotalCostUsd: positiveNumber(policy.maxTotalCostUsd, "providerPolicy.maxTotalCostUsd"),
  };
}

function derivePreflightStatus(preregistration: Rt95Preregistration): FormalResearchPacket["preflight"] {
  const faultPlan = object(preregistration.faultPlan, "preregistration.faultPlan");
  const blockers = objectArray(faultPlan.windows, "preregistration fault windows")
    .filter((window) => object(window.readiness, "fault window readiness").status !== "available")
    .map((window) => `frozen-window-blocked:${machineId(window.id, "blocked window ID")}`)
    .sort(compare);
  return { status: blockers.length === 0 ? "ready-to-run" : "blocked", blockers };
}

function validateProviderPreflight(value: unknown, preregistration: Rt95Preregistration): void {
  const actual = object(value, "providerPreflight");
  exactKeys(actual, ["mode", "kind", "realApiCalls", "credentialsRead", "authorizationId", "maxRequests", "maxTotalCostUsd"], "providerPreflight");
  const expected = deriveProviderPreflight(preregistration);
  if (canonicalJson(actual) !== canonicalJson(expected)) fail("provider preflight does not match frozen policy or overclaims live calls");
}

function validatePlan(value: unknown, expected: FormalResearchPacket["plan"]): void {
  const plan = object(value, "packet.plan");
  exactKeys(plan, ["experimentId", "pairing", "plannedCaseCount", "casePlanSha256", "cases"], "packet.plan");
  if (canonicalJson(plan) !== canonicalJson(expected)) fail("formal case plan does not exactly match frozen preregistration");
}

function validateEvent(raw: unknown, index: number, previousHash: string | null, caseIds: ReadonlySet<string>): FormalRawLedgerEvent {
  const event = object(raw, `ledger.events[${index}]`);
  exactKeys(event, [
    "sequence", "eventId", "eventType", "occurredAt", "caseId", "attempt", "outcome", "artifactPath",
    "artifactSha256", "reason", "previousEventSha256", "eventSha256",
  ], `ledger.events[${index}]`);
  constant(event.sequence, index, `ledger.events[${index}].sequence`);
  machineId(event.eventId, `ledger.events[${index}].eventId`);
  if (!["ledger-opened", "case-started", "case-recorded", "rerun-authorized", "manual-intervention-recorded", "ledger-sealed"].includes(String(event.eventType))) {
    fail(`invalid ledger eventType at sequence ${index}`);
  }
  canonicalTimestamp(event.occurredAt, `ledger.events[${index}].occurredAt`);
  constant(event.previousEventSha256, previousHash, `ledger.events[${index}].previousEventSha256`);
  digest(event.eventSha256, `ledger.events[${index}].eventSha256`);
  const expectedHash = hashLedgerEvent(event as unknown as FormalRawLedgerEvent);
  if (event.eventSha256 !== expectedHash) fail(`ledger event hash mismatch at sequence ${index}`);

  const eventType = event.eventType as RawLedgerEventType;
  if (eventType === "ledger-opened" || eventType === "ledger-sealed") {
    for (const key of ["caseId", "attempt", "outcome", "artifactPath", "artifactSha256", "reason"] as const) {
      constant(event[key], null, `ledger.events[${index}].${key}`);
    }
  } else if (eventType === "manual-intervention-recorded") {
    if (event.caseId === null) constant(event.attempt, null, `ledger.events[${index}].attempt`);
    else {
      const caseId = machineId(event.caseId, `ledger.events[${index}].caseId`);
      if (!caseIds.has(caseId)) fail(`manual intervention references unplanned case: ${caseId}`);
      if (event.attempt !== null) positiveInteger(event.attempt, `ledger.events[${index}].attempt`);
    }
    constant(event.outcome, null, `ledger.events[${index}].outcome`);
    safePath(event.artifactPath, `ledger.events[${index}].artifactPath`);
    digest(event.artifactSha256, `ledger.events[${index}].artifactSha256`);
    nonEmpty(event.reason, `ledger.events[${index}].reason`);
  } else {
    const caseId = machineId(event.caseId, `ledger.events[${index}].caseId`);
    if (!caseIds.has(caseId)) fail(`ledger event references unplanned case: ${caseId}`);
    positiveInteger(event.attempt, `ledger.events[${index}].attempt`);
    if (eventType === "case-started") {
      for (const key of ["outcome", "artifactPath", "artifactSha256", "reason"] as const) constant(event[key], null, `ledger.events[${index}].${key}`);
    } else if (eventType === "rerun-authorized") {
      constant(event.outcome, null, `ledger.events[${index}].outcome`);
      constant(event.artifactPath, null, `ledger.events[${index}].artifactPath`);
      constant(event.artifactSha256, null, `ledger.events[${index}].artifactSha256`);
      nonEmpty(event.reason, `ledger.events[${index}].reason`);
    } else {
      if (!["success", "failure", "excluded", "aborted"].includes(String(event.outcome))) fail(`invalid Raw outcome at sequence ${index}`);
      safePath(event.artifactPath, `ledger.events[${index}].artifactPath`);
      digest(event.artifactSha256, `ledger.events[${index}].artifactSha256`);
      if (event.outcome === "success") constant(event.reason, null, `ledger.events[${index}].reason`);
      else nonEmpty(event.reason, `ledger.events[${index}].reason`);
    }
  }
  return event as unknown as FormalRawLedgerEvent;
}

function applyCaseTransition(
  event: FormalRawLedgerEvent,
  attempts: Map<string, { lastRecorded: number; activeAttempt: number | null; authorizedAttempt: number | null }>,
  plannedCaseCount: number,
): void {
  if (event.eventType === "ledger-opened") return;
  if (event.eventType === "manual-intervention-recorded") return;
  if (event.eventType === "ledger-sealed") {
    if (attempts.size !== plannedCaseCount || [...attempts.values()].some((state) => state.lastRecorded < 1 || state.activeAttempt !== null)) {
      fail("ledger cannot seal before every planned case has a terminal Raw record");
    }
    return;
  }
  const caseId = event.caseId!;
  const attempt = event.attempt!;
  const state = attempts.get(caseId) ?? { lastRecorded: 0, activeAttempt: null, authorizedAttempt: null };
  if (event.eventType === "case-started") {
    if (state.activeAttempt !== null) fail(`case already has an active attempt: ${caseId}`);
    if (attempt === 1) {
      if (state.lastRecorded !== 0) fail(`case attempt 1 cannot restart: ${caseId}`);
    } else if (state.authorizedAttempt !== attempt || state.lastRecorded !== attempt - 1) {
      fail(`case rerun attempt was not authorized: ${caseId}/${attempt}`);
    }
    state.activeAttempt = attempt;
    state.authorizedAttempt = null;
  } else if (event.eventType === "case-recorded") {
    if (state.activeAttempt !== attempt) fail(`case terminal Raw has no matching active attempt: ${caseId}/${attempt}`);
    state.activeAttempt = null;
    state.lastRecorded = attempt;
  } else {
    if (state.activeAttempt !== null || state.lastRecorded < 1 || attempt !== state.lastRecorded + 1) {
      fail(`rerun authorization is out of order: ${caseId}/${attempt}`);
    }
    if (state.authorizedAttempt !== null) fail(`case already has a pending rerun authorization: ${caseId}`);
    state.authorizedAttempt = attempt;
  }
  attempts.set(caseId, state);
}

function materializeEvent(input: AppendLedgerEventInput, sequence: number, previousEventSha256: string | null): FormalRawLedgerEvent {
  const eventWithoutHash = { sequence, ...input, previousEventSha256 };
  return { ...eventWithoutHash, eventSha256: sha256(canonicalJson(eventWithoutHash)) };
}

function hashLedgerEvent(event: FormalRawLedgerEvent): string {
  const { eventSha256: _omitted, ...payload } = event;
  return sha256(canonicalJson(payload));
}

function validateClaimTable(value: unknown): ClaimTable {
  const root = object(value, "Claim Table");
  constant(root.schemaVersion, "rt95-paper-claim-table-v1", "Claim Table schemaVersion");
  const claims = objectArray(root.claims, "Claim Table claims");
  if (claims.length === 0) fail("Claim Table cannot be empty");
  const ids = new Set<string>();
  for (const [index, claim] of claims.entries()) {
    const id = machineId(claim.id, `Claim Table claims[${index}].id`);
    if (ids.has(id)) fail(`duplicate Claim Table ID: ${id}`);
    ids.add(id);
    if (claim.evidenceState !== "CodeVerified" && claim.evidenceState !== "NotVerified") fail(`invalid Claim Table evidenceState: ${id}`);
    const requirements = stringArray(claim.requiredEvidence, `Claim ${id} requiredEvidence`);
    if (requirements.length === 0) fail(`Claim ${id} must have required evidence`);
    unique(requirements, `Claim ${id} required evidence`);
  }
  return { schemaVersion: "rt95-paper-claim-table-v1", claims: claims as unknown as ClaimTableClaim[] };
}

function validateEvidenceItem(item: Record<string, unknown>, requirement: string, label: string, ledgerHashes: ReadonlySet<string>): void {
  exactKeys(item, ["requirement", "status", "artifactPath", "artifactSha256", "ledgerEventSha256", "producerId", "reviewerId"], label);
  constant(item.requirement, requirement, `${label}.requirement`);
  if (item.status === "NotVerified") {
    for (const key of ["artifactPath", "artifactSha256", "ledgerEventSha256", "producerId", "reviewerId"] as const) {
      constant(item[key], null, `${label}.${key}`);
    }
    return;
  }
  constant(item.status, "Verified", `${label}.status`);
  safePath(item.artifactPath, `${label}.artifactPath`);
  digest(item.artifactSha256, `${label}.artifactSha256`);
  const producerId = machineId(item.producerId, `${label}.producerId`);
  const reviewerId = machineId(item.reviewerId, `${label}.reviewerId`);
  if (producerId === reviewerId) fail(`${label} producer and reviewer must differ`);
  if (item.ledgerEventSha256 !== null) {
    const eventHash = digest(item.ledgerEventSha256, `${label}.ledgerEventSha256`);
    if (!ledgerHashes.has(eventHash)) fail(`${label} references an unknown ledger event hash`);
  }
}

function claimClass(claimId: string): ClaimEvidenceEntry["claimClass"] {
  if (claimId.startsWith("CLAIM-PIPELINE-") || claimId.startsWith("CLAIM-METHOD-")) return "code";
  if (claimId.startsWith("CLAIM-RQ")) return "formal-result";
  if (claimId.startsWith("CLAIM-REPRO-")) return "external";
  if (claimId.startsWith("CLAIM-PAPER-")) return "publication";
  return "maturity";
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort(compare).map((key) => [key, sortKeys(record[key])]));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function objectArray(value: unknown, label: string): Record<string, unknown>[] {
  return array(value, label).map((item, index) => object(item, `${label}[${index}]`));
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  return array(value, label).map((item, index) => stringValue(item, `${label}[${index}]`));
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function nonEmpty(value: unknown, label: string): string {
  return stringValue(value, label);
}

function machineId(value: unknown, label: string): string {
  const result = stringValue(value, label);
  if (!MACHINE_ID.test(result)) fail(`${label} must be a machine ID`);
  return result;
}

function digest(value: unknown, label: string): string {
  const result = stringValue(value, label);
  if (!SHA256.test(result)) fail(`${label} must be a lowercase SHA-256`);
  return result;
}

function nonZeroDigest(value: unknown, label: string): string {
  const result = digest(value, label);
  if (/^0+$/u.test(result)) fail(`${label} must not be all zeroes`);
  return result;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) fail(`${label} must be a positive safe integer`);
  return Number(value);
}

function uint32(value: unknown, label: string): number {
  const result = positiveInteger(value, label);
  if (result > 0xffff_ffff) fail(`${label} must be uint32`);
  return result;
}

function positiveNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) fail(`${label} must be a positive finite number`);
  return value;
}

function safePath(value: unknown, label: string): string {
  const result = stringValue(value, label);
  if (result.includes("\\") || result.includes("\0") || result.startsWith("/") || /^[A-Za-z]:/u.test(result) ||
    result.split("/").some((part) => part.length === 0 || part === "." || part === "..")) {
    fail(`${label} must be a safe relative POSIX path`);
  }
  return result;
}

function canonicalTimestamp(value: unknown, label: string): string {
  const result = stringValue(value, label);
  const time = Date.parse(result);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== result) fail(`${label} must be canonical UTC ISO-8601`);
  return result;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(compare);
  const expected = [...keys].sort(compare);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} key mismatch; expected [${expected.join(", ")}]`);
  }
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) fail(`${label} contains duplicates`);
}

function constant(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) fail(`${label} must equal ${JSON.stringify(expected)}`);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareCases(left: FormalCasePlan, right: FormalCasePlan): number {
  return compare(left.armId, right.armId) || compare(left.faultWindowId, right.faultWindowId) || left.seed - right.seed;
}

function fail(message: string): never {
  throw new Error(message);
}
