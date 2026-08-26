import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  materializeAuthoritativePreregistrationCandidate,
  validateAuthoritativeRt95Preregistration,
  validateGate40AuthoritativeProtocol,
} from "../research/rt95-closure/src/authoritative-preregistration.js";
import {
  analyzeConfirmatoryRaw,
  exactMcNemarTwoSided,
  validateConfirmatoryAnalysisPlan,
  validateConfirmatoryAnalysisReport,
} from "../research/rt95-closure/src/confirmatory-analysis.js";
import { validateRawResults, wilson95 } from "../research/rt95-closure/src/statistics.js";
import { validateRt95Preregistration } from "../scripts/validate-rt95-preregistration.js";

async function json(relativePath: string): Promise<any> {
  return JSON.parse(await readFile(path.resolve(relativePath), "utf8"));
}

test("Formal Provider/外部基线/第二环境 Runbook 保持 fail-closed 证据边界", async () => {
  const runbook = await readFile(
    path.resolve("docs/research/FORMAL-PROVIDER-BASELINE-REPLICATION-RUNBOOK.zh-CN.md"),
    "utf8",
  );
  for (const required of [
    "provider-authorization.json",
    "Formal Raw",
    "casePlanSha256",
    "ledger-sealed",
    "outcome_unknown",
    "外部 baseline",
    "第二环境/非作者复现",
    "Independent review",
    "formalVerified=0",
    "externalBaseline=0",
    "independentReproduction=0",
    "NotVerified",
    "Verified",
  ]) {
    assert.ok(runbook.includes(required), `runbook must contain ${required}`);
  }
  assert.match(runbook, /不能输出 `formalVerified=true`/u);
  assert.match(runbook, /不得.*Mock|Fake.*local pilot/u);
  assert.match(runbook, /同作者同机器复跑/u);
  assert.match(runbook, /不是 independent reproduction/u);
  assert.match(runbook, /真实 Provider 授权/u);
  assert.match(runbook, /真实 Provider.*NotRun|authorized-not-called/u);
});

test("8窗口×5 seed 权威协议固定 40/40 local pilot、formal 0，并将旧 1/7 Draft 限定为 smoke", async () => {
  const smoke = await json("research/rt95-closure/preregistration.draft.example.json");
  const protocol = validateGate40AuthoritativeProtocol(
    await json("research/rt95-closure/gate40-authoritative-protocol.json"),
  );
  const smokeValidated = validateRt95Preregistration(smoke) as any;
  assert.equal(smokeValidated.integrity.summary.availableWindowIds.length, 1);
  assert.equal(smokeValidated.integrity.summary.blockedWindowIds.length, 7);
  assert.match(smokeValidated.title, /Smoke 基础 Draft/u);

  const candidate = materializeAuthoritativePreregistrationCandidate(smoke, protocol) as any;
  assert.equal(candidate.faultPlan.windows.length, 8);
  assert.equal(candidate.faultPlan.windows.every((window: any) => window.readiness.status === "available"), true);
  assert.equal(candidate.integrity.summary.availableWindowIds.length, 8);
  assert.deepEqual(candidate.integrity.summary.blockedWindowIds, []);
  assert.equal(protocol.summary.plannedCases, 40);
  assert.equal(protocol.summary.localPassed, 40);
  assert.equal(protocol.summary.formalVerified, 0);
  assert.equal(protocol.summary.completeFormalGate40, false);
  assert.deepEqual(validateAuthoritativeRt95Preregistration(candidate), candidate);
});

test("权威协议与候选适配器拒绝窗口降级、乱序、伪 formal 和本地 helper 外部化", async () => {
  const protocol = await json("research/rt95-closure/gate40-authoritative-protocol.json");
  for (const mutate of [
    (value: any) => { value.windows[0].readiness = "blocked"; },
    (value: any) => { [value.windows[0], value.windows[1]] = [value.windows[1], value.windows[0]]; },
    (value: any) => { value.summary.formalVerified = 40; },
    (value: any) => { value.claimBoundary = "external-system-verified"; },
  ]) {
    const changed = structuredClone(protocol);
    mutate(changed);
    assert.throws(() => validateGate40AuthoritativeProtocol(changed), /authoritative protocol validation failed/u);
  }

  const smoke = await json("research/rt95-closure/preregistration.draft.example.json");
  const candidate = materializeAuthoritativePreregistrationCandidate(smoke, protocol) as any;
  candidate.faultPlan.windows[7].readiness = { status: "blocked", blockedReason: "stale" };
  assert.throws(() => validateAuthoritativeRt95Preregistration(candidate), /readiness.status/u);
});

test("Draft 将活跃范围收敛为 RQ1/RQ2，RQ3 成本 Claim 移出确认性范围", async () => {
  const smoke = validateRt95Preregistration(
    await json("research/rt95-closure/preregistration.draft.example.json"),
  ) as any;
  assert.deepEqual(smoke.researchQuestions.map((rq: any) => rq.id), ["RQ1", "RQ2"]);
  assert.deepEqual(
    smoke.hypotheses.map((hypothesis: any) => hypothesis.id),
    ["H0-RQ1", "H1-RQ1", "H0-RQ2", "H1-RQ2"],
  );
  const claims = await json("research/paper/CLAIM-TABLE.json");
  assert.equal(claims.claims.some((claim: any) => claim.id === "CLAIM-RQ3-001"), false);
  const manuscript = await readFile(path.resolve("research/paper/MANUSCRIPT-DRAFT.zh-CN.md"), "utf8");
  assert.match(manuscript, /范围外问题（延迟与成本）/u);
  assert.doesNotMatch(manuscript, /RQ3（代价与尾延迟）/u);
});

test("perArm=40 的 Draft 精度目标使用 Wilson 实际边界 0.15，不再声称 0.08 或已达到 power", async () => {
  const draft = validateRt95Preregistration(
    await json("research/rt95-closure/preregistration.draft.example.json"),
  ) as any;
  const interval = wilson95(32, 40);
  const maximumSideDistance = Math.max(interval.estimate - interval.lower, interval.upper - interval.estimate);
  assert.equal(draft.sampleSize.perArm, 40);
  assert.equal(draft.sampleSize.targetHalfWidth, 0.15);
  assert.equal(maximumSideDistance <= draft.sampleSize.targetHalfWidth, true);
  assert.equal(maximumSideDistance <= 0.08, false);
  assert.match(draft.sampleSize.basis, /not-powered/u);
  assert.match(draft.sampleSize.rationale, /未证明达到该 power/u);
});

test("逐条配对 Raw 自动生成 exact McNemar、配对区间与 Holm family，仍固定为 pipeline-only", async () => {
  const raw = rawFixture();
  const plan = await json("research/rt95-closure/confirmatory-analysis-plan.draft.json");
  const report = analyzeConfirmatoryRaw(raw, plan);
  assert.equal(report.analyses.length, 3);
  assert.equal(report.formalVerified, false);
  assert.equal(report.significanceClaimed, false);
  assert.equal(report.multiplicity.applied, true);
  assert.deepEqual(
    report.analyses.map((analysis) => [analysis.analysisId, analysis.exactTwoSidedPValue, analysis.holmAdjustedPValue]),
    [
      ["AN-RQ2-NO-LEASE", 0.125, 0.125],
      ["AN-RQ2-NO-RECOVERY", 0.03125, 0.0625],
      ["AN-RQ2-NO-WAL", 0.0078125, 0.0234375],
    ],
  );
  assert.equal(report.analyses.find((item) => item.analysisId === "AN-RQ2-NO-WAL")!.rejectedUnderDraftPlan, true);
  assert.deepEqual(validateConfirmatoryAnalysisReport(report, raw, plan), report);
});

test("确认性入口拒绝缺比较、人工 p-value、非配对 Raw 与 formal/significance 越界", async () => {
  const raw = rawFixture();
  const plan = await json("research/rt95-closure/confirmatory-analysis-plan.draft.json");
  const missing = structuredClone(plan);
  missing.family.pop();
  assert.throws(() => validateConfirmatoryAnalysisPlan(missing, raw), /cover every Raw comparator/u);

  const injected = structuredClone(plan);
  injected.family[0].pValue = 0.00001;
  assert.throws(() => validateConfirmatoryAnalysisPlan(injected, raw), /key mismatch/u);

  const unpaired = structuredClone(raw);
  unpaired.records.pop();
  assert.throws(() => validateRawResults(unpaired), /non-paired seed\/fault plan/u);

  const report = analyzeConfirmatoryRaw(raw, plan) as any;
  report.formalVerified = true;
  report.significanceClaimed = true;
  assert.throws(
    () => validateConfirmatoryAnalysisReport(report, raw, plan),
    /does not deterministically match/u,
  );
  assert.equal(exactMcNemarTwoSided(0, 0), 1);
  assert.equal(exactMcNemarTwoSided(8, 0), 0.0078125);
});

function rawFixture() {
  const windows = Array.from({ length: 8 }, (_, index) => `FW-${String(index + 1).padStart(2, "0")}`);
  const arms = ["ARM-BASELINE", "ARM-NO-LEASE", "ARM-NO-RECOVERY", "ARM-NO-WAL"];
  const failures: Record<string, number> = {
    "ARM-BASELINE": 0,
    "ARM-NO-LEASE": 4,
    "ARM-NO-RECOVERY": 6,
    "ARM-NO-WAL": 8,
  };
  return {
    schemaVersion: "rt95-raw-results-v1",
    experimentId: "EXP-PIPELINE-FIXTURE",
    baselineArmId: "ARM-BASELINE",
    records: arms.flatMap((armId) => windows.map((faultWindowId, index) => ({
      runId: `RUN-${armId}-${index + 1}`,
      armId,
      seed: 469816031,
      faultWindowId,
      outcome: index < failures[armId]! ? "failure" : "success",
      latencyMs: 10 + index,
    }))),
  };
}
