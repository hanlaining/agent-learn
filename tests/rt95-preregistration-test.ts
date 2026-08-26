import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import "./rt95-formal-research-packet-cases.js";
import "./rt95-research-contract-cases.js";
import "./rt95-persistent-evidence-chain-cases.js";
import { fileURLToPath } from "node:url";

import {
  computePreregistrationDigest,
  freezePreregistrationDraft,
  RT95_GATE40_SEEDS,
  RT95_GATE40_WINDOWS,
  validateRt95Preregistration,
} from "../scripts/validate-rt95-preregistration.js";
import {
  freezeAuthoritativePreregistrationDraft,
  materializeAuthoritativePreregistrationCandidate,
} from "../research/rt95-closure/src/authoritative-preregistration.js";

const DRAFT_PATH = fileURLToPath(new URL("../research/rt95-closure/preregistration.draft.example.json", import.meta.url));
const SCHEMA_PATH = fileURLToPath(new URL("../research/rt95-closure/preregistration.schema.json", import.meta.url));

async function loadDraft(): Promise<any> {
  return JSON.parse(await readFile(DRAFT_PATH, "utf8"));
}

test("RT95 preregistration Schema 与 Draft 示例可读取，但 Draft 保持 NotVerified", async () => {
  const schema = JSON.parse(await readFile(SCHEMA_PATH, "utf8")) as { $schema?: string; title?: string; required?: string[] };
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.title, "God-Agent RT95 preregistration v1");
  assert.ok(schema.required?.includes("primaryEndpoint"));
  assert.ok(schema.required?.includes("sampleSize"));
  assert.ok(schema.required?.includes("provenance"));

  const draft = validateRt95Preregistration(await loadDraft());
  assert.equal(draft.lifecycle.status, "draft");
  assert.equal(draft.lifecycle.frozenAt, null);
  assert.equal(draft.verification.status, "NotVerified");
  assert.equal(draft.verification.evidenceActual, null);
  assert.equal(draft.integrity.payloadSha256, null);
  const faultPlan = draft.faultPlan as any;
  assert.equal(faultPlan.windowSetLifecycle, "candidate-not-frozen");
  assert.equal(faultPlan.windows.length, 8);
  assert.equal(faultPlan.gate40PlannedCases, 40);
  assert.deepEqual(faultPlan.windows.map((window: any) => window.id), RT95_GATE40_WINDOWS.map((window) => window.id));
  assert.deepEqual((draft.seedPlan as any).seeds, RT95_GATE40_SEEDS);
  assert.match(computePreregistrationDigest(draft), /^[0-9a-f]{64}$/u);
});

test("Freeze 绑定 canonical 时间与完整 payload digest，未改内容可复验", async () => {
  const frozen = freezePreregistrationDraft(await loadDraft(), "2026-08-24T08:00:00.000Z");
  assert.equal(frozen.lifecycle.status, "frozen");
  assert.equal(frozen.verification.status, "NotVerified");
  assert.equal(frozen.integrity.payloadSha256, computePreregistrationDigest(frozen));
  assert.doesNotThrow(() => validateRt95Preregistration(structuredClone(frozen)));
});

test("8 窗口权威候选冻结后可通过统一 preregistration validator", async () => {
  const smoke = JSON.parse(await readFile(DRAFT_PATH, "utf8")) as unknown;
  const protocol = JSON.parse(await readFile(fileURLToPath(new URL("../research/rt95-closure/gate40-authoritative-protocol.json", import.meta.url)), "utf8")) as unknown;
  const candidate = materializeAuthoritativePreregistrationCandidate(smoke, protocol);
  const frozen = freezeAuthoritativePreregistrationDraft(candidate, "2026-08-26T00:00:00.000Z");
  assert.equal(frozen.lifecycle.status, "frozen");
  assert.equal((frozen.faultPlan as any).windowSetLifecycle, "frozen");
  assert.equal((frozen.integrity as any).payloadSha256, computePreregistrationDigest(frozen));
  assert.doesNotThrow(() => validateRt95Preregistration(structuredClone(frozen)));
});

test("Validator 拒绝缺少预注册必填项与跨字段样本计划不一致", async () => {
  const missing = await loadDraft();
  delete missing.minimumEffectOfInterest;
  assert.throws(() => validateRt95Preregistration(missing), /key mismatch/u);

  const inconsistent = await loadDraft();
  inconsistent.sampleSize.total += 1;
  assert.throws(() => validateRt95Preregistration(inconsistent), /sampleSize\.total/u);
});

test("Validator 拒绝摘要不匹配和 analysis ID 悬空", async () => {
  const summary = await loadDraft();
  summary.integrity.summary.rqIds = ["RQ999"];
  assert.throws(() => validateRt95Preregistration(summary), /summary mismatch/u);

  const analysis = await loadDraft();
  analysis.primaryEndpoint.analysisId = "AN-UNKNOWN";
  assert.throws(() => validateRt95Preregistration(analysis), /primaryEndpoint\.analysisId/u);
});

test("Validator 拒绝 Frozen 后的事后修改", async () => {
  const frozen = freezePreregistrationDraft(await loadDraft(), "2026-08-24T08:00:00.000Z") as any;
  frozen.primaryEndpoint.name = "post-hoc-success-rate";
  assert.throws(() => validateRt95Preregistration(frozen), /payload digest mismatch/u);
});

test("Validator 对 live Provider fail closed，只有显式授权和预算才可进入预注册", async () => {
  const unauthorized = await loadDraft();
  unauthorized.provenance.providerPolicy = {
    mode: "live-authorized",
    authorizedLiveCalls: false,
    approvalId: null,
    maxRequests: 2,
    maxTotalCostUsd: 1,
    allowedProviders: ["openai-responses"],
  };
  assert.throws(() => validateRt95Preregistration(unauthorized), /authorizedLiveCalls/u);

  const offlineLeak = await loadDraft();
  offlineLeak.provenance.providerPolicy.allowedProviders = ["openai-responses"];
  assert.throws(() => validateRt95Preregistration(offlineLeak), /cannot allow a live Provider/u);

  const authorized = await loadDraft();
  authorized.provenance.providerPolicy = {
    mode: "live-authorized",
    authorizedLiveCalls: true,
    approvalId: "APPROVAL-RT95-PILOT-001",
    maxRequests: 2,
    maxTotalCostUsd: 1,
    allowedProviders: ["openai-responses"],
  };
  assert.doesNotThrow(() => validateRt95Preregistration(authorized));
});

test("NotVerified 禁止预填 Evidence、Reviewer 结论或伪造 Verified", async () => {
  const evidence = await loadDraft();
  evidence.verification.evidenceActual = ["research/results/report.json"];
  assert.throws(() => validateRt95Preregistration(evidence), /evidenceActual/u);

  const reviewer = await loadDraft();
  reviewer.verification.reviewerConclusion = "passed";
  assert.throws(() => validateRt95Preregistration(reviewer), /reviewerConclusion/u);

  const verified = await loadDraft();
  verified.verification.status = "Verified";
  assert.throws(() => validateRt95Preregistration(verified), /verification\.status/u);
});

test("Validator 拒绝 seed 摘要篡改与缺少 H0/H1 配对", async () => {
  const seed = await loadDraft();
  seed.seedPlan.seeds[0] += 1;
  assert.throws(() => validateRt95Preregistration(seed), /seedPlan\.seeds mismatch|seedListSha256/u);

  const hypotheses = await loadDraft();
  hypotheses.hypotheses = hypotheses.hypotheses.filter((item: { kind: string }) => item.kind !== "alternative");
  hypotheses.integrity.summary.hypothesisIds = ["H0-RQ1"];
  assert.throws(() => validateRt95Preregistration(hypotheses), /must contain H0 and H1|must have both H0/u);
});

test("GATE-40 Validator 拒绝窗口不足、重复或稳定 ID 漂移", async () => {
  const missing = await loadDraft();
  missing.faultPlan.windows.pop();
  assert.throws(() => validateRt95Preregistration(missing), /exactly 8 GATE-40 windows/u);

  const duplicate = await loadDraft();
  duplicate.faultPlan.windows[1] = structuredClone(duplicate.faultPlan.windows[0]);
  assert.throws(() => validateRt95Preregistration(duplicate), /faultPlan\.windows\[1\]\.id/u);

  const drift = await loadDraft();
  drift.faultPlan.windows[0].id = "FW-MODEL-RESPONSE-OTHER";
  assert.throws(() => validateRt95Preregistration(drift), /faultPlan\.windows\[0\]\.id/u);
});

test("GATE-40 Validator 拒绝固定 seed 漂移，即使调用者同步改摘要", async () => {
  const drift = await loadDraft();
  drift.seedPlan.seeds[0] = 1;
  drift.integrity.summary.seedValues[0] = 1;
  assert.throws(() => validateRt95Preregistration(drift), /seedPlan\.seeds mismatch/u);
});

test("GATE-40 available 窗口必须绑定生产入口和 Harness，blocked 窗口必须给出原因", async () => {
  const fakeReady = await loadDraft();
  const available = fakeReady.faultPlan.windows.find((window: any) => window.readiness.status === "available");
  available.productionEntry.command = null;
  assert.throws(() => validateRt95Preregistration(fakeReady), /productionEntry\.command/u);

  const blockedWithoutReason = await loadDraft();
  const blocked = blockedWithoutReason.faultPlan.windows.find((window: any) => window.readiness.status === "blocked");
  blocked.readiness.blockedReason = null;
  assert.throws(() => validateRt95Preregistration(blockedWithoutReason), /blockedReason/u);
});

test("GATE-40 Validator 拒绝 Oracle、Expected Artifact 和派生摘要漂移", async () => {
  const oracle = await loadDraft();
  oracle.faultPlan.windows[0].oracle.id = "ORACLE-OTHER-V1";
  assert.throws(() => validateRt95Preregistration(oracle), /oracle\.id/u);

  const artifacts = await loadDraft();
  artifacts.faultPlan.windows[0].expectedArtifacts = ["only-summary.json"];
  assert.throws(() => validateRt95Preregistration(artifacts), /success and failure Raw paths/u);

  const summary = await loadDraft();
  summary.integrity.summary.blockedWindowIds.pop();
  assert.throws(() => validateRt95Preregistration(summary), /blockedWindowIds summary mismatch/u);
});
