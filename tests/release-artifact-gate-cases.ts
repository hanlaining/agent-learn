import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { formatReleaseArtifactGateReport, verifyReleaseArtifactEvidence } from "../scripts/release-artifact-gate.js";

test("发行物证据完整且安装包摘要一致时通过，但声明边界仍不是生产批准", async () => {
  const root = await fixture();
  try {
    const report = await verifyReleaseArtifactEvidence(root);
    assert.equal(report.status, "PASS");
    assert.match(formatReleaseArtifactGateReport(report), /not proof of a live Provider/u);
    assert.equal(report.candidateRef, "candidate-2026-08-26-a");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("缺安装器、签名、干净机、升级回滚或长稳 receipt 时失败关闭", async () => {
  const root = await fixture();
  try {
    await rm(path.join(root, "dist/release/installer.exe"));
    await rm(path.join(root, "evidence/signature.json"));
    await rm(path.join(root, "evidence/clean-machine.json"));
    await rm(path.join(root, "evidence/upgrade-rollback.json"));
    await rm(path.join(root, "evidence/long-stability.json"));
    const report = await verifyReleaseArtifactEvidence(root);
    assert.equal(report.status, "BLOCKED");
    assert.ok(report.checks.filter((check) => check.status === "blocking").length >= 5);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("安装包摘要漂移、短于一小时长稳和工作区外路径均失败关闭", async () => {
  const root = await fixture();
  try {
    const manifestPath = path.join(root, "dist/release/release-artifact.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, any>;
    manifest.installerSha256 = "0".repeat(64);
    manifest.longStability.durationSeconds = 3599;
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
    const report = await verifyReleaseArtifactEvidence(root);
    assert.equal(report.status, "BLOCKED");
    assert.equal(report.checks.find((check) => check.id === "installer-digest")?.status, "blocking");
    assert.equal(report.checks.find((check) => check.id === "long-stability")?.status, "blocking");
    manifest.upgradeRollback.evidencePath = "../outside.json";
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
    const invalidPathReport = await verifyReleaseArtifactEvidence(root);
    assert.equal(invalidPathReport.status, "BLOCKED");
    assert.equal(invalidPathReport.checks.find((check) => check.id === "manifest")?.status, "blocking");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("receipt 候选漂移、重复路径和签名时间戳缺失均失败关闭", async () => {
  const root = await fixture();
  try {
    const manifestPath = path.join(root, "dist/release/release-artifact.json");
    const signaturePath = path.join(root, "evidence/signature.json");
    const signature = JSON.parse(await readFile(signaturePath, "utf8")) as Record<string, unknown>;
    signature.candidateRef = "candidate-drift";
    await writeFile(signaturePath, `${JSON.stringify(signature)}\n`, "utf8");
    const drift = await verifyReleaseArtifactEvidence(root);
    assert.equal(drift.status, "BLOCKED");
    assert.equal(drift.checks.find((check) => check.id === "signature")?.status, "blocking");

    signature.candidateRef = "candidate-2026-08-26-a";
    signature.timestamped = false;
    await writeFile(signaturePath, `${JSON.stringify(signature)}\n`, "utf8");
    const noTimestamp = await verifyReleaseArtifactEvidence(root);
    assert.equal(noTimestamp.status, "BLOCKED");
    assert.equal(noTimestamp.checks.find((check) => check.id === "signature")?.status, "blocking");

    const cleanPath = path.join(root, "evidence/clean-machine.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, any>;
    manifest.cleanMachine.evidencePath = manifest.signature.evidencePath;
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
    const duplicate = await verifyReleaseArtifactEvidence(root);
    assert.equal(duplicate.status, "BLOCKED");
    assert.equal(duplicate.checks.find((check) => check.id === "evidence-path-uniqueness")?.status, "blocking");
    await writeFile(cleanPath, await readFile(cleanPath), "utf8");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("干净机、回滚和长稳 receipt 的关键完成字段缺失时失败关闭", async () => {
  const root = await fixture();
  try {
    const cleanPath = path.join(root, "evidence/clean-machine.json");
    const clean = JSON.parse(await readFile(cleanPath, "utf8")) as Record<string, unknown>;
    clean.uninstallPassed = false;
    await writeFile(cleanPath, `${JSON.stringify(clean)}\n`, "utf8");
    let report = await verifyReleaseArtifactEvidence(root);
    assert.equal(report.checks.find((check) => check.id === "clean-machine")?.status, "blocking");

    const rollbackPath = path.join(root, "evidence/upgrade-rollback.json");
    const rollback = JSON.parse(await readFile(rollbackPath, "utf8")) as Record<string, unknown>;
    rollback.stateIntegrityVerified = false;
    await writeFile(rollbackPath, `${JSON.stringify(rollback)}\n`, "utf8");
    report = await verifyReleaseArtifactEvidence(root);
    assert.equal(report.checks.find((check) => check.id === "upgrade-rollback")?.status, "blocking");

    const stabilityPath = path.join(root, "evidence/long-stability.json");
    const stability = JSON.parse(await readFile(stabilityPath, "utf8")) as Record<string, unknown>;
    stability.recoveryVerified = false;
    const stabilityText = `${JSON.stringify(stability)}\n`;
    await writeFile(stabilityPath, stabilityText, "utf8");
    const manifestPath = path.join(root, "dist/release/release-artifact.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, any>;
    manifest.longStability.evidenceSha256 = createHash("sha256").update(stabilityText).digest("hex");
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
    report = await verifyReleaseArtifactEvidence(root);
    assert.equal(report.checks.find((check) => check.id === "long-stability")?.status, "blocking");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("相同候选重复运行输出稳定且不产生副作用", async () => {
  const root = await fixture();
  try {
    const first = await verifyReleaseArtifactEvidence(root);
    const second = await verifyReleaseArtifactEvidence(root);
    assert.deepEqual(second, first);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "god-agent-release-artifact-"));
  await mkdir(path.join(root, "dist/release"), { recursive: true });
  await mkdir(path.join(root, "evidence"), { recursive: true });
  const installer = Buffer.from("signed-installer-fixture\n", "utf8");
  await writeFile(path.join(root, "dist/release/installer.exe"), installer);
  const digest = createHash("sha256").update(installer).digest("hex");
  await writeFile(path.join(root, "evidence/signature.json"), `${JSON.stringify({
    schemaVersion: "god-agent-release-signature-v1",
    candidateRef: "candidate-2026-08-26-a",
    installerSha256: digest,
    status: "verified",
    format: "authenticode",
    certificateSubject: "CN=God Agent Release",
    timestamped: true,
    verificationTool: "signtool",
  })}\n`, "utf8");
  await writeFile(path.join(root, "evidence/clean-machine.json"), `${JSON.stringify({
    schemaVersion: "god-agent-clean-machine-v1",
    candidateRef: "candidate-2026-08-26-a",
    status: "passed",
    executorId: "independent-executor-1",
    machineId: "clean-win32-1",
    installPassed: true,
    startupPassed: true,
    uninstallPassed: true,
  })}\n`, "utf8");
  await writeFile(path.join(root, "evidence/upgrade-rollback.json"), `${JSON.stringify({
    schemaVersion: "god-agent-upgrade-rollback-v1",
    candidateRef: "candidate-2026-08-26-a",
    status: "passed",
    testedFrom: "1.0.0",
    testedTo: "1.0.1",
    rollbackVerified: true,
    stateIntegrityVerified: true,
  })}\n`, "utf8");
  const longStabilityReceipt = `${JSON.stringify({
    schemaVersion: "god-agent-long-stability-v1",
    candidateRef: "candidate-2026-08-26-a",
    status: "passed",
    durationSeconds: 3600,
    failureCount: 0,
    recoveryVerified: true,
  })}\n`;
  await writeFile(path.join(root, "evidence/long-stability.json"), longStabilityReceipt, "utf8");
  const longStabilitySha256 = createHash("sha256").update(longStabilityReceipt).digest("hex");
  const manifest = {
    schemaVersion: "god-agent-release-artifact-v1",
    candidateRef: "candidate-2026-08-26-a",
    createdAt: "2026-08-26T08:00:00.000Z",
    installerPath: "dist/release/installer.exe",
    installerSha256: digest,
    signature: { status: "verified", format: "authenticode", evidencePath: "evidence/signature.json", certificateSubject: "CN=God Agent Release", timestamped: true },
    cleanMachine: { status: "passed", evidencePath: "evidence/clean-machine.json", executorId: "independent-executor-1", machineId: "clean-win32-1" },
    upgradeRollback: { status: "passed", evidencePath: "evidence/upgrade-rollback.json", testedFrom: "1.0.0", testedTo: "1.0.1", rollbackVerified: true },
    longStability: { status: "passed", evidencePath: "evidence/long-stability.json", durationSeconds: 3600, evidenceSha256: longStabilitySha256 },
    claimBoundary: "artifact-evidence-only-not-provider-not-production-approval",
  };
  await writeFile(path.join(root, "dist/release/release-artifact.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return root;
}
