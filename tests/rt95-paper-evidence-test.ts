import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildRt95PaperEvidenceBundle,
  parseRt95PaperEvidenceCliArgs,
  validateRt95PaperEvidenceManifest,
  verifyRt95PaperEvidenceBundle,
} from "../scripts/build-rt95-paper-evidence.js";
import { freezePreregistrationDraft } from "../scripts/validate-rt95-preregistration.js";

interface DraftShape extends Record<string, unknown> {
  faultPlan: { gateId: string; windows: Array<{ id: string }> };
  seedPlan: { seeds: number[] };
  arms: {
    baseline: { id: string };
    ablations: Array<{ id: string }>;
    externalBaselines: Array<{ id: string }>;
  };
}

async function fixture(context: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "rt95-paper-evidence-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const draft = JSON.parse(await readFile(path.resolve("research/rt95-closure/preregistration.draft.example.json"), "utf8")) as DraftShape;
  const frozen = freezePreregistrationDraft(draft, "2026-08-24T08:00:00.000Z") as unknown as DraftShape;
  const armIds = [frozen.arms.baseline.id, ...frozen.arms.ablations.map((arm) => arm.id),
    ...frozen.arms.externalBaselines.map((arm) => arm.id)];
  const records = armIds.flatMap((armId, armIndex) => frozen.faultPlan.windows.flatMap((window, windowIndex) =>
    frozen.seedPlan.seeds.map((seed, seedIndex) => ({
      runId: `run-${armIndex}-${windowIndex}-${seedIndex}`,
      armId,
      seed,
      faultWindowId: window.id,
      outcome: (armIndex === 0 ? seedIndex !== 0 : (armIndex + windowIndex + seedIndex) % 3 !== 0) ? "success" : "failure",
      latencyMs: 10 + armIndex + windowIndex + seedIndex,
    }))));
  const raw = {
    schemaVersion: "rt95-raw-results-v1",
    experimentId: frozen.faultPlan.gateId,
    baselineArmId: frozen.arms.baseline.id,
    records,
  };
  await writeFile(path.join(root, "preregistration.json"), `${JSON.stringify(frozen, null, 2)}\n`, "utf8");
  await writeFile(path.join(root, "raw.json"), `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  return { root, draft, frozen, raw };
}

test("一键证据包严格绑定 Frozen 预注册、完整 Raw、统计表和负结果索引", async (context) => {
  const { root, raw } = await fixture(context);
  const manifest = await buildRt95PaperEvidenceBundle(root, {
    preregistrationPath: "preregistration.json",
    rawPath: "raw.json",
    outputDirectory: "paper/bundle-a",
  });
  assert.equal(manifest.claimBoundary, "local-analysis-bundle-not-formal-not-external");
  assert.equal(manifest.raw.recordCount, 160);
  assert.equal(manifest.raw.pairsPerArm, 40);
  assert.ok(manifest.raw.failureCount > 0);
  assert.equal(manifest.raw.successCount + manifest.raw.failureCount, manifest.raw.recordCount);
  assert.equal(manifest.analysis.significanceClaimed, false);
  assert.equal(manifest.analysis.fairnessReviewStatus, "NotReviewed");
  assert.equal(manifest.analysis.externalBaselineArmCount, 0);
  assert.deepEqual(await verifyRt95PaperEvidenceBundle(root, "paper/bundle-a"), manifest);

  const rawIndex = await readFile(path.join(root, "paper/bundle-a/raw-index.csv"), "utf8");
  const failures = await readFile(path.join(root, "paper/bundle-a/failure-records.csv"), "utf8");
  assert.equal(rawIndex.trimEnd().split("\n").length, raw.records.length + 1);
  assert.equal(failures.trimEnd().split("\n").length, manifest.raw.failureCount + 1);
  assert.match(failures, /,failure,/u);

  for (const artifact of manifest.artifacts) {
    const content = await readFile(path.join(root, "paper/bundle-a", artifact.path), "utf8");
    assert.equal(Buffer.byteLength(content, "utf8"), artifact.bytes);
    assert.equal(createHash("sha256").update(content, "utf8").digest("hex"), artifact.sha256);
  }
  const schema = JSON.parse(await readFile(path.resolve("research/paper/paper-evidence-manifest.schema.json"), "utf8")) as {
    properties?: { schemaVersion?: { const?: unknown }; claimBoundary?: { const?: unknown } };
  };
  assert.equal(schema.properties?.schemaVersion?.const, manifest.schemaVersion);
  assert.equal(schema.properties?.claimBoundary?.const, manifest.claimBoundary);
});

test("证据包生成确定且禁止覆盖既有目录", async (context) => {
  const { root } = await fixture(context);
  const first = await buildRt95PaperEvidenceBundle(root, {
    preregistrationPath: "preregistration.json",
    rawPath: "raw.json",
    outputDirectory: "bundle-a",
  });
  const second = await buildRt95PaperEvidenceBundle(root, {
    preregistrationPath: "preregistration.json",
    rawPath: "raw.json",
    outputDirectory: "bundle-b",
  });
  assert.deepEqual(second, first);
  assert.equal(
    await readFile(path.join(root, "bundle-a/artifact-manifest.json"), "utf8"),
    await readFile(path.join(root, "bundle-b/artifact-manifest.json"), "utf8"),
  );
  await assert.rejects(buildRt95PaperEvidenceBundle(root, {
    preregistrationPath: "preregistration.json",
    rawPath: "raw.json",
    outputDirectory: "bundle-a",
  }), /never overwritten/u);
});

test("Draft、冻结计划缺格和事后篡改均 fail-closed", async (context) => {
  const { root, draft, frozen, raw } = await fixture(context);
  await writeFile(path.join(root, "draft.json"), `${JSON.stringify(draft)}\n`, "utf8");
  await assert.rejects(buildRt95PaperEvidenceBundle(root, {
    preregistrationPath: "draft.json", rawPath: "raw.json", outputDirectory: "draft-bundle",
  }), /requires a frozen preregistration/u);

  const firstPair = raw.records[0]!;
  const incomplete = structuredClone(raw);
  incomplete.records = incomplete.records.filter((record) =>
    record.seed !== firstPair.seed || record.faultWindowId !== firstPair.faultWindowId);
  await writeFile(path.join(root, "incomplete.json"), `${JSON.stringify(incomplete)}\n`, "utf8");
  await assert.rejects(buildRt95PaperEvidenceBundle(root, {
    preregistrationPath: "preregistration.json", rawPath: "incomplete.json", outputDirectory: "incomplete-bundle",
  }), /frozen plan/u);

  const tampered = structuredClone(frozen) as unknown as Record<string, unknown> & { title: string };
  tampered.title = "post-hoc changed title";
  await writeFile(path.join(root, "tampered-prereg.json"), `${JSON.stringify(tampered)}\n`, "utf8");
  await assert.rejects(buildRt95PaperEvidenceBundle(root, {
    preregistrationPath: "tampered-prereg.json", rawPath: "raw.json", outputDirectory: "tampered-bundle",
  }), /payload digest mismatch/u);
});

test("Verifier 拒绝产物篡改、缺失和额外文件", async (context) => {
  const { root } = await fixture(context);
  await buildRt95PaperEvidenceBundle(root, {
    preregistrationPath: "preregistration.json", rawPath: "raw.json", outputDirectory: "bundle",
  });
  await writeFile(path.join(root, "bundle/failure-records.csv"), "selected-away\n", "utf8");
  await assert.rejects(verifyRt95PaperEvidenceBundle(root, "bundle"), /digest mismatch/u);

  const second = await fixture(context);
  await buildRt95PaperEvidenceBundle(second.root, {
    preregistrationPath: "preregistration.json", rawPath: "raw.json", outputDirectory: "bundle",
  });
  await writeFile(path.join(second.root, "bundle/post-hoc.csv"), "invented\n", "utf8");
  await assert.rejects(verifyRt95PaperEvidenceBundle(second.root, "bundle"), /file set mismatch/u);
});

test("Manifest 与 CLI 参数保持严格 claim boundary", () => {
  assert.deepEqual(parseRt95PaperEvidenceCliArgs([
    "--preregistration", "p.json", "--raw", "raw.json", "--output-dir", "bundle",
  ]), {
    mode: "build", preregistrationPath: "p.json", rawPath: "raw.json", outputDirectory: "bundle",
  });
  assert.deepEqual(parseRt95PaperEvidenceCliArgs(["--verify-bundle", "bundle"]), {
    mode: "verify", outputDirectory: "bundle",
  });
  assert.throws(() => parseRt95PaperEvidenceCliArgs(["--verify-bundle", "bundle", "--raw", "raw.json"]), /cannot be combined/u);
  assert.throws(() => parseRt95PaperEvidenceCliArgs(["--formal", "true"]), /unknown argument/u);

  const manifest = {
    schemaVersion: "rt95-paper-evidence-bundle-v1",
    claimBoundary: "formal-verified",
  };
  assert.throws(() => validateRt95PaperEvidenceManifest(manifest), /key mismatch|claimBoundary/u);
});

test("输入输出路径不得逃出工作区", async (context) => {
  const { root } = await fixture(context);
  await assert.rejects(buildRt95PaperEvidenceBundle(root, {
    preregistrationPath: "../preregistration.json",
    rawPath: "raw.json",
    outputDirectory: "bundle",
  }), /escapes workspace/u);
  await assert.rejects(buildRt95PaperEvidenceBundle(root, {
    preregistrationPath: "preregistration.json",
    rawPath: "raw.json",
    outputDirectory: "../bundle",
  }), /escapes workspace/u);
});
