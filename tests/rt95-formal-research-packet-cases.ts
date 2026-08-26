import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  appendFormalRawLedgerEvent,
  assertFormalRawLedgerAppendOnly,
  createFormalResearchPacket,
  validateClaimEvidenceMatrix,
  validateFormalRawLedger,
  validateFormalResearchPacket,
  type AppendLedgerEventInput,
  type ClaimEvidenceMatrix,
  type FormalRawLedger,
  type FormalResearchPacket,
} from "../research/rt95-closure/src/formal-research-packet.js";
import {
  freezeAuthoritativePreregistrationDraft,
  materializeAuthoritativePreregistrationCandidate,
} from "../research/rt95-closure/src/authoritative-preregistration.js";

const SOURCE_TREE_SHA = "1".repeat(64);
const LOCKFILE_SHA = "2".repeat(64);
const ARTIFACT_SHA = "3".repeat(64);

async function inputs() {
  const smokeDraft = JSON.parse(await readFile(path.resolve("research/rt95-closure/preregistration.draft.example.json"), "utf8")) as unknown;
  const protocol = JSON.parse(await readFile(path.resolve("research/rt95-closure/gate40-authoritative-protocol.json"), "utf8")) as unknown;
  const draft = materializeAuthoritativePreregistrationCandidate(smokeDraft, protocol) as any;
  const preregistration = freezeAuthoritativePreregistrationDraft(draft, "2026-08-24T08:00:00.000Z");
  const claimTable = JSON.parse(await readFile(path.resolve("research/paper/CLAIM-TABLE.json"), "utf8")) as unknown;
  const packet = createFormalResearchPacket(preregistration, claimTable, {
    packetId: "PACKET-RT95-001",
    openedAt: "2026-08-24T08:01:00.000Z",
    source: {
      baselineCommit: draft.provenance.baselineCommit,
      sourceTreeSha256: SOURCE_TREE_SHA,
      lockfileSha256: LOCKFILE_SHA,
      configSha256: draft.provenance.configSha256,
    },
    roles: { executorId: "EXECUTOR-01", reviewerId: "REVIEWER-02" },
  });
  return { draft, preregistration, claimTable, packet };
}

test("Formal preflight 从 8×5 权威协议确定生成 4 arm × 40 格计划且达到 ready-to-run", async () => {
  const { preregistration, claimTable, packet } = await inputs();
  assert.equal(packet.plan.plannedCaseCount, 160);
  assert.equal(packet.plan.cases.length, 160);
  assert.equal(new Set(packet.plan.cases.map((item) => item.caseId)).size, 160);
  assert.equal(new Set(packet.plan.cases.map((item) => item.armId)).size, 4);
  assert.equal(new Set(packet.plan.cases.map((item) => item.faultWindowId)).size, 8);
  assert.equal(new Set(packet.plan.cases.map((item) => item.seed)).size, 5);
  assert.equal(packet.verification.formalVerified, false);
  assert.equal(packet.verification.externalReproduced, false);
  assert.equal(packet.verification.independentReviewCompleted, false);
  assert.equal(packet.lifecycle, "preflight");
  assert.equal(packet.preflight.status, "ready-to-run");
  assert.deepEqual(packet.preflight.blockers, []);
  assert.equal(packet.providerPreflight.kind, "deterministic-fake");
  assert.equal(packet.providerPreflight.realApiCalls, 0);
  assert.equal(packet.ledger.events.length, 1);
  assert.equal(packet.claimEvidence.claims.every((claim) => claim.status === "NotVerified"), true);
  assert.deepEqual(validateFormalResearchPacket(packet, preregistration, claimTable), packet);
});

test("Formal preflight 拒绝 Draft、冻结后篡改、输入摘要漂移与同一执行/复核身份", async () => {
  const { draft, preregistration, claimTable } = await inputs();
  const base = {
    packetId: "PACKET-RT95-002",
    openedAt: "2026-08-24T08:01:00.000Z",
    source: {
      baselineCommit: draft.provenance.baselineCommit,
      sourceTreeSha256: SOURCE_TREE_SHA,
      lockfileSha256: LOCKFILE_SHA,
      configSha256: draft.provenance.configSha256,
    },
    roles: { executorId: "EXECUTOR-01", reviewerId: "REVIEWER-02" },
  };
  assert.throws(() => createFormalResearchPacket(draft, claimTable, base), /requires a frozen preregistration/u);

  const tampered = structuredClone(preregistration) as any;
  tampered.title = "post-hoc-title";
  assert.throws(() => createFormalResearchPacket(tampered, claimTable, base), /payload digest/u);
  assert.throws(() => createFormalResearchPacket(preregistration, claimTable, {
    ...base, source: { ...base.source, configSha256: "4".repeat(64) },
  }), /config digest/u);
  assert.throws(() => createFormalResearchPacket(preregistration, claimTable, {
    ...base, source: { ...base.source, sourceTreeSha256: "0".repeat(64) },
  }), /must not be all zeroes/u);
  assert.throws(() => createFormalResearchPacket(preregistration, claimTable, {
    ...base, roles: { executorId: "SAME-PERSON", reviewerId: "SAME-PERSON" },
  }), /must be different identities/u);
});

test("Packet 对 formal/external/live overclaim 和冻结计划删格 fail-closed", async () => {
  const { preregistration, claimTable, packet } = await inputs();
  for (const mutate of [
    (value: any) => { value.preflight = { status: "blocked", blockers: ["stale-smoke-blocker"] }; },
    (value: any) => { value.verification.formalVerified = true; },
    (value: any) => { value.verification.externalReproduced = true; },
    (value: any) => { value.verification.independentReviewCompleted = true; },
    (value: any) => { value.providerPreflight.realApiCalls = 1; },
    (value: any) => { value.providerPreflight.kind = "live-provider-authorized-not-called"; },
    (value: any) => { value.plan.cases.pop(); },
    (value: any) => { value.bindings.sourceTreeSha256 = "5".repeat(64); },
  ]) {
    const changed = structuredClone(packet);
    mutate(changed);
    assert.throws(() => validateFormalResearchPacket(changed, preregistration, claimTable));
  }
});

test("Live-authorized 预注册在 preflight 仍明确为 not-called，不能伪造调用结果", async () => {
  const { draft, claimTable } = await inputs();
  draft.provenance.providerPolicy = {
    mode: "live-authorized",
    authorizedLiveCalls: true,
    approvalId: "APPROVAL-RT95-FORMAL-001",
    maxRequests: 200,
    maxTotalCostUsd: 20,
    allowedProviders: ["openai-responses"],
  };
  const preregistration = freezeAuthoritativePreregistrationDraft(draft, "2026-08-24T08:00:00.000Z");
  const packet = createFormalResearchPacket(preregistration, claimTable, {
    packetId: "PACKET-LIVE-PREFLIGHT-001",
    openedAt: "2026-08-24T08:01:00.000Z",
    source: {
      baselineCommit: draft.provenance.baselineCommit,
      sourceTreeSha256: SOURCE_TREE_SHA,
      lockfileSha256: LOCKFILE_SHA,
      configSha256: draft.provenance.configSha256,
    },
    roles: { executorId: "EXECUTOR-LIVE", reviewerId: "REVIEWER-LIVE" },
  });
  assert.equal(packet.providerPreflight.kind, "live-provider-authorized-not-called");
  assert.equal(packet.providerPreflight.realApiCalls, 0);
  assert.equal(packet.providerPreflight.credentialsRead, false);
  assert.equal(packet.providerPreflight.authorizationId, "APPROVAL-RT95-FORMAL-001");
  assert.equal(packet.verification.formalVerified, false);
});

test("Raw ledger 的失败结果、获准重跑与后续成功均按摘要链只追加保留", async () => {
  const { packet } = await inputs();
  const planned = packet.plan.cases;
  const caseId = planned[0]!.caseId;
  const opened = structuredClone(packet.ledger);
  const started = appendFormalRawLedgerEvent(opened, planned, event({
    eventId: "EVENT-CASE-START-001", eventType: "case-started", occurredAt: "2026-08-24T08:02:00.000Z",
    caseId, attempt: 1,
  }));
  const failed = appendFormalRawLedgerEvent(started, planned, event({
    eventId: "EVENT-CASE-RAW-001", eventType: "case-recorded", occurredAt: "2026-08-24T08:03:00.000Z",
    caseId, attempt: 1, outcome: "failure", artifactPath: "raw/attempt-1/report.json",
    artifactSha256: ARTIFACT_SHA, reason: "oracle-failed",
  }));
  const authorized = appendFormalRawLedgerEvent(failed, planned, event({
    eventId: "EVENT-RERUN-001", eventType: "rerun-authorized", occurredAt: "2026-08-24T08:04:00.000Z",
    caseId, attempt: 2, reason: "preregistered-infrastructure-rerun-rule",
  }));
  const restarted = appendFormalRawLedgerEvent(authorized, planned, event({
    eventId: "EVENT-CASE-START-002", eventType: "case-started", occurredAt: "2026-08-24T08:05:00.000Z",
    caseId, attempt: 2,
  }));
  const succeeded = appendFormalRawLedgerEvent(restarted, planned, event({
    eventId: "EVENT-CASE-RAW-002", eventType: "case-recorded", occurredAt: "2026-08-24T08:06:00.000Z",
    caseId, attempt: 2, outcome: "success", artifactPath: "raw/attempt-2/report.json",
    artifactSha256: "4".repeat(64),
  }));
  assert.equal(succeeded.events.filter((item) => item.eventType === "case-recorded").length, 2);
  assert.deepEqual(succeeded.events.filter((item) => item.eventType === "case-recorded").map((item) => item.outcome), ["failure", "success"]);
  assertFormalRawLedgerAppendOnly(opened, succeeded, planned);
  validateFormalRawLedger(succeeded, planned);
});

test("Raw ledger 拒绝历史篡改、截断、未授权重跑、重复 active attempt 和提前 sealed", async () => {
  const { packet } = await inputs();
  const planned = packet.plan.cases;
  const caseId = planned[0]!.caseId;
  const started = appendFormalRawLedgerEvent(packet.ledger, planned, event({
    eventId: "EVENT-START-001", eventType: "case-started", occurredAt: "2026-08-24T08:02:00.000Z", caseId, attempt: 1,
  }));
  const recorded = appendFormalRawLedgerEvent(started, planned, event({
    eventId: "EVENT-RAW-001", eventType: "case-recorded", occurredAt: "2026-08-24T08:03:00.000Z",
    caseId, attempt: 1, outcome: "failure", artifactPath: "raw/failure.json", artifactSha256: ARTIFACT_SHA, reason: "failure-retained",
  }));

  const tampered = structuredClone(recorded);
  tampered.events[2]!.reason = "rewritten-result";
  assert.throws(() => validateFormalRawLedger(tampered, planned), /event hash mismatch/u);

  const truncated = structuredClone(recorded);
  truncated.events.pop();
  assertFormalRawLedgerAppendOnly(packet.ledger, truncated, planned);
  assert.throws(() => assertFormalRawLedgerAppendOnly(recorded, truncated, planned), /truncated/u);

  assert.throws(() => appendFormalRawLedgerEvent(started, planned, event({
    eventId: "EVENT-DUPLICATE-START", eventType: "case-started", occurredAt: "2026-08-24T08:03:00.000Z", caseId, attempt: 1,
  })), /active attempt/u);
  assert.throws(() => appendFormalRawLedgerEvent(recorded, planned, event({
    eventId: "EVENT-UNAUTHORIZED-RERUN", eventType: "case-started", occurredAt: "2026-08-24T08:04:00.000Z", caseId, attempt: 2,
  })), /not authorized/u);
  assert.throws(() => appendFormalRawLedgerEvent(recorded, planned, event({
    eventId: "EVENT-EARLY-SEAL", eventType: "ledger-sealed", occurredAt: "2026-08-24T08:04:00.000Z",
  })), /before every planned case/u);
});

test("Claim Matrix 强制每个 Claim 和每项 requirement 闭合，CodeVerified 需独立复核", async () => {
  const { claimTable, packet } = await inputs();
  const matrix = structuredClone(packet.claimEvidence);
  const pipelineClaims = matrix.claims.filter((claim) => claim.claimId.startsWith("CLAIM-PIPELINE-"));
  assert.equal(pipelineClaims.length, 6);
  for (const [claimIndex, pipeline] of pipelineClaims.entries()) {
    pipeline.status = "CodeVerified";
    for (const [evidenceIndex, item] of pipeline.evidence.entries()) {
      Object.assign(item, {
        status: "Verified",
        artifactPath: `evidence/pipeline-${claimIndex + 1}-${evidenceIndex + 1}.json`,
        artifactSha256: (claimIndex + evidenceIndex + 5).toString(16).slice(-1).repeat(64),
        ledgerEventSha256: null,
        producerId: "CI-PRODUCER",
        reviewerId: "REVIEWER-02",
      });
    }
  }
  assert.deepEqual(validateClaimEvidenceMatrix(matrix, claimTable, packet.ledger, packet.plan.cases), matrix);

  const missing = structuredClone(matrix);
  missing.claims.pop();
  assert.throws(() => validateClaimEvidenceMatrix(missing, claimTable, packet.ledger, packet.plan.cases), /cover every Claim/u);

  const samePerson = structuredClone(matrix);
  samePerson.claims[0]!.evidence[0]!.reviewerId = "CI-PRODUCER";
  assert.throws(() => validateClaimEvidenceMatrix(samePerson, claimTable, packet.ledger, packet.plan.cases), /producer and reviewer must differ/u);

  const unknownLedger = structuredClone(matrix);
  unknownLedger.claims[0]!.evidence[0]!.ledgerEventSha256 = "9".repeat(64);
  assert.throws(() => validateClaimEvidenceMatrix(unknownLedger, claimTable, packet.ledger, packet.plan.cases), /unknown ledger event hash/u);
});

test("Formal/external/publication Claim 即使填满本地证据也不能在 preflight 包升级", async () => {
  const { claimTable, packet } = await inputs();
  const matrix = structuredClone(packet.claimEvidence);
  const formal = matrix.claims.find((claim) => claim.claimId === "CLAIM-RQ1-001")!;
  formal.status = "CodeVerified";
  for (const [index, item] of formal.evidence.entries()) {
    Object.assign(item, {
      status: "Verified",
      artifactPath: `local-only/rq1-${index + 1}.json`,
      artifactSha256: "a".repeat(64),
      ledgerEventSha256: null,
      producerId: "LOCAL-AUTHOR",
      reviewerId: "LOCAL-REVIEWER",
    });
  }
  assert.throws(
    () => validateClaimEvidenceMatrix(matrix, claimTable, packet.ledger, packet.plan.cases),
    /cannot verify formal\/external\/publication Claim/u,
  );
});

test("Formal packet JSON Schema 同样固定 preflight-only 与三项 false verification", async () => {
  const schema = JSON.parse(await readFile(
    path.resolve("research/rt95-closure/formal-research-packet.schema.json"),
    "utf8",
  )) as any;
  assert.equal(schema.properties.schemaVersion.const, "rt95-formal-research-packet-v1");
  assert.equal(schema.properties.claimBoundary.const, "preflight-only-not-formal-or-external-verification");
  assert.equal(schema.properties.lifecycle.const, "preflight");
  assert.equal(schema.properties.verification.properties.formalVerified.const, false);
  assert.equal(schema.properties.verification.properties.externalReproduced.const, false);
  assert.equal(schema.properties.verification.properties.independentReviewCompleted.const, false);
  assert.equal(schema.properties.providerPreflight.properties.realApiCalls.const, 0);
});

function event(overrides: Partial<AppendLedgerEventInput> & Pick<AppendLedgerEventInput, "eventId" | "eventType" | "occurredAt">): AppendLedgerEventInput {
  return {
    eventId: overrides.eventId,
    eventType: overrides.eventType,
    occurredAt: overrides.occurredAt,
    caseId: overrides.caseId ?? null,
    attempt: overrides.attempt ?? null,
    outcome: overrides.outcome ?? null,
    artifactPath: overrides.artifactPath ?? null,
    artifactSha256: overrides.artifactSha256 ?? null,
    reason: overrides.reason ?? null,
  };
}
