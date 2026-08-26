import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  evaluateReleaseReadiness,
  formatReleaseReadinessReport,
} from "../scripts/release-readiness.js";
import {
  createRuntimeStateRecoveryBundle,
  restoreRuntimeStateRecoveryBundle,
  verifyRuntimeStateRecoveryBundle,
} from "../scripts/runtime-state-recovery-bundle.js";
import { JsonFileRuntimePersistence } from "../src/runtime/json-file-runtime-persistence.js";

const CLEAN_AUDIT = {
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } },
};

test("reports READY only when metadata, documents, CI, discovery, build and offline Provider gates pass", async () => {
  const fixture = await createReleaseFixture();
  try {
    const report = await evaluateReleaseReadiness(fixture.root, { candidatePaths: fixture.candidates, dependencyAuditReport: CLEAN_AUDIT });
    assert.equal(report.status, "READY");
    assert.equal(report.counts.blocking, 0);
    assert.equal(report.counts.warning, 0);
    assert.match(formatReleaseReadinessReport(report), /local structural checks only/u);
    assert.match(formatReleaseReadinessReport(report), /not proof of a clean-machine install/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("missing release artifact evidence blocks readiness instead of implying install or signing proof", async () => {
  const fixture = await createReleaseFixture();
  try {
    await rm(join(fixture.root, "dist", "release", "release-artifact.json"));
    const report = await evaluateReleaseReadiness(fixture.root, { candidatePaths: fixture.candidates, dependencyAuditReport: CLEAN_AUDIT });
    assert.equal(report.status, "BLOCKED");
    assert.equal(find(report, "release-artifact-evidence").level, "blocking");
    assert.match(find(report, "release-artifact-evidence").details.join("\n"), /release-artifact\.json/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("missing or tampered SBOM, security and data-integrity receipts block readiness", async () => {
  const fixture = await createReleaseFixture();
  try {
    await rm(join(fixture.root, "dist", "release", "release-supply-chain.json"));
    const missing = await evaluateReleaseReadiness(fixture.root, { candidatePaths: fixture.candidates, dependencyAuditReport: CLEAN_AUDIT });
    assert.equal(find(missing, "release-supply-chain-evidence").level, "blocking");
    assert.match(find(missing, "release-supply-chain-evidence").details.join("\n"), /release-supply-chain\.json/u);

    await createReleaseSupplyChainFixture(fixture.root);
    await writeFile(join(fixture.root, "dist", "release", "god-agent.cdx.json"), "tampered\n", "utf8");
    const tampered = await evaluateReleaseReadiness(fixture.root, { candidatePaths: fixture.candidates, dependencyAuditReport: CLEAN_AUDIT });
    assert.equal(find(tampered, "release-supply-chain-evidence").level, "blocking");
    assert.match(find(tampered, "release-supply-chain-evidence").details.join("\n"), /SBOM evidence SHA-256/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("supply-chain index is bound to the exact release-artifact manifest bytes", async () => {
  const fixture = await createReleaseFixture();
  try {
    const artifactPath = join(fixture.root, "dist", "release", "release-artifact.json");
    const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as Record<string, unknown>;
    artifact.createdAt = "2026-08-26T08:01:00.000Z";
    await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    const report = await evaluateReleaseReadiness(fixture.root, {
      candidatePaths: fixture.candidates,
      dependencyAuditReport: CLEAN_AUDIT,
    });
    const supply = find(report, "release-supply-chain-evidence");
    assert.equal(supply.level, "blocking");
    assert.match(supply.details.join("\n"), /release artifact manifest SHA-256/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("missing LICENSE, NOTICE, Electron output and offline CI evidence are graded honestly", async () => {
  const fixture = await createReleaseFixture();
  try {
    await rm(join(fixture.root, "LICENSE"));
    await rm(join(fixture.root, "NOTICE"));
    await rm(join(fixture.root, "dist", "electron-app", "electron", "main.cjs"));
    const ciPath = join(fixture.root, ".github", "workflows", "ci.yml");
    const ci = (await readFile(ciPath, "utf8")).replace('PROVIDER_SMOKE_LIVE: "0"\n', "");
    await writeFile(ciPath, ci, "utf8");
    await writeFile(
      join(fixture.root, "README.md"),
      "# Fixture\n\nElectron and Multi-Agent.\n\n## 当前不应声称\n\nNo production claim.\n\n## 当前验证基线\n\n1/1 files.\n",
      "utf8",
    );
    const report = await evaluateReleaseReadiness(fixture.root, { candidatePaths: fixture.candidates, dependencyAuditReport: CLEAN_AUDIT });
    assert.equal(report.status, "BLOCKED");
    assert.equal(find(report, "license-file").level, "blocking");
    assert.equal(find(report, "notice-file").level, "warning");
    assert.equal(find(report, "electron-build").level, "blocking");
    assert.equal(find(report, "provider-offline-default").level, "blocking");
    assert.equal(find(report, "test-discovery").level, "blocking");
    assert.match(find(report, "test-discovery").details.join("\n"), /README current verification baseline/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("sensitive release candidates and detected credentials block without echoing the secret", async () => {
  const fixture = await createReleaseFixture();
  const secret = ["sk-proj-", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4"].join("");
  try {
    await writeFile(join(fixture.root, ".env.production"), `OPENAI_API_KEY=${secret}\n`, "utf8");
    const report = await evaluateReleaseReadiness(fixture.root, {
      candidatePaths: [...fixture.candidates, ".env.production"],
      dependencyAuditReport: CLEAN_AUDIT,
    });
    assert.equal(report.status, "BLOCKED");
    assert.equal(find(report, "sensitive-file-blacklist").level, "blocking");
    assert.equal(find(report, "secret-scan").level, "blocking");
    assert.doesNotMatch(JSON.stringify(report), new RegExp(escapeRegExp(secret), "u"));
    assert.doesNotMatch(formatReleaseReadinessReport(report), new RegExp(escapeRegExp(secret), "u"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("allows the documented frozen public lease artifact but blocks runtime state elsewhere", async () => {
  const fixture = await createReleaseFixture();
  try {
    const publicArtifact = "research/artifacts/v0.1/process-check/runtime-leases.json";
    const localState = "work/runtime-leases.json";
    await mkdir(join(fixture.root, "research", "artifacts", "v0.1", "process-check"), { recursive: true });
    await mkdir(join(fixture.root, "work"), { recursive: true });
    await writeFile(join(fixture.root, ...publicArtifact.split("/")), "{}", "utf8");
    await writeFile(join(fixture.root, ...localState.split("/")), "{}", "utf8");

    const allowed = await evaluateReleaseReadiness(fixture.root, {
      candidatePaths: [...fixture.candidates, publicArtifact],
      dependencyAuditReport: CLEAN_AUDIT,
    });
    assert.equal(find(allowed, "sensitive-file-blacklist").level, "pass");

    const blocked = await evaluateReleaseReadiness(fixture.root, {
      candidatePaths: [...fixture.candidates, publicArtifact, localState],
      dependencyAuditReport: CLEAN_AUDIT,
    });
    assert.equal(find(blocked, "sensitive-file-blacklist").level, "blocking");
    assert.deepEqual(find(blocked, "sensitive-file-blacklist").details, [localState]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("live Provider in a package command blocks release readiness", async () => {
  const fixture = await createReleaseFixture();
  try {
    const packagePath = join(fixture.root, "package.json");
    const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as { scripts: Record<string, string> };
    packageJson.scripts["provider:smoke"] = "PROVIDER_SMOKE_LIVE=1 tsx scripts/provider-capability-smoke.ts";
    await writeFile(packagePath, JSON.stringify(packageJson), "utf8");
    const report = await evaluateReleaseReadiness(fixture.root, { candidatePaths: fixture.candidates, dependencyAuditReport: CLEAN_AUDIT });
    assert.equal(report.status, "BLOCKED");
    assert.equal(find(report, "provider-offline-default").level, "blocking");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("package and lockfile drift blocks reproducible release provenance", async () => {
  const fixture = await createReleaseFixture();
  try {
    const lockPath = join(fixture.root, "package-lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as {
      packages: Record<string, { version?: string }>;
    };
    const rootPackage = lock.packages[""];
    assert.ok(rootPackage);
    rootPackage.version = "9.9.9";
    await writeFile(lockPath, JSON.stringify(lock), "utf8");
    const report = await evaluateReleaseReadiness(fixture.root, { candidatePaths: fixture.candidates, dependencyAuditReport: CLEAN_AUDIT });
    assert.equal(report.status, "BLOCKED");
    assert.equal(find(report, "package-provenance").level, "blocking");
    assert.match(find(report, "package-provenance").details.join("\n"), /package-lock root version/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("authoritative critical/high dependency findings always block release readiness", async () => {
  const fixture = await createReleaseFixture();
  try {
    const report = await evaluateReleaseReadiness(fixture.root, {
      candidatePaths: fixture.candidates,
      dependencyAuditReport: {
        auditReportVersion: 2,
        vulnerabilities: {
          electron: {
            severity: "high",
            via: [{ url: "https://github.com/advisories/GHSA-9f4c-93c8-jc8g" }],
            nodes: ["node_modules/electron"],
          },
        },
        metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } },
      },
    });
    assert.equal(report.status, "BLOCKED");
    assert.equal(find(report, "dependency-risk").level, "blocking");
    assert.match(find(report, "dependency-risk").details.join("\n"), /GHSA-9f4c-93c8-jc8g/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("missing or malformed authoritative audit evidence fails closed without claiming zero risk", async () => {
  const fixture = await createReleaseFixture();
  try {
    const report = await evaluateReleaseReadiness(fixture.root, {
      candidatePaths: fixture.candidates,
      dependencyAuditReport: { auditReportVersion: 2, error: "registry unavailable" },
    });
    assert.equal(report.status, "BLOCKED");
    const dependencyRisk = find(report, "dependency-risk");
    assert.equal(dependencyRisk.level, "blocking");
    assert.match(dependencyRisk.summary, /audit is unavailable/u);
    assert.doesNotMatch(dependencyRisk.summary, /0 critical, 0 high/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("malformed package metadata and an omitted CI command remain blocking", async () => {
  const fixture = await createReleaseFixture();
  try {
    const packagePath = join(fixture.root, "package.json");
    const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as { version: string; scripts: Record<string, string> };
    packageJson.version = "not-semver";
    delete packageJson.scripts["test:process-chaos"];
    await writeFile(packagePath, JSON.stringify(packageJson), "utf8");
    const ciPath = join(fixture.root, ".github", "workflows", "ci.yml");
    await writeFile(ciPath, (await readFile(ciPath, "utf8")).replace("npm run test:process-chaos\n", ""), "utf8");
    const report = await evaluateReleaseReadiness(fixture.root, { candidatePaths: fixture.candidates, dependencyAuditReport: CLEAN_AUDIT });
    assert.equal(report.status, "BLOCKED");
    assert.equal(find(report, "package-metadata").level, "blocking");
    assert.match(find(report, "package-metadata").details.join("\n"), /valid semver version/u);
    assert.equal(find(report, "ci-gate").level, "blocking");
    assert.match(find(report, "ci-gate").details.join("\n"), /test:process-chaos/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("all local credential filename variants are rejected as release candidates", async () => {
  const fixture = await createReleaseFixture();
  try {
    const candidates = ["credentials.json", "auth.p12", "service.local-config", "private.pem", ".env.test"];
    const report = await evaluateReleaseReadiness(fixture.root, {
      candidatePaths: [...fixture.candidates, ...candidates],
      dependencyAuditReport: CLEAN_AUDIT,
    });
    const blacklist = find(report, "sensitive-file-blacklist");
    assert.equal(blacklist.level, "blocking");
    assert.deepEqual(blacklist.details, [...candidates].sort());
    assert.equal(report.status, "BLOCKED");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("runtime recovery bundle proves backup, clean restore and N+1 to N rollback with receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "god-runtime-recovery-"));
  try {
    const statePath = join(root, "state", "runtime.json");
    const persistence = new JsonFileRuntimePersistence(statePath);
    const state = await persistence.load();
    state.lifecycleStore.createThread();
    await persistence.save(state);
    const nBytes = await readFile(statePath);
    const manifest = await createRuntimeStateRecoveryBundle({
      workspaceRoot: root,
      statePath: "state/runtime.json",
      outputDirectory: "backups/n",
      candidateRef: "candidate@example",
      createdAt: "2026-08-24T19:15:00+08:00",
    });
    assert.equal(manifest.generation, 1);
    assert.equal(manifest.sha256, sha256(nBytes));
    assert.equal((await verifyRuntimeStateRecoveryBundle({
      workspaceRoot: root,
      bundleDirectory: "backups/n",
      expectedCandidateRef: "candidate@example",
    })).manifest.generation, 1);

    const cleanReceipt = await restoreRuntimeStateRecoveryBundle({
      workspaceRoot: root,
      bundleDirectory: "backups/n",
      targetStatePath: "restored/runtime.json",
      expectedCandidateRef: "candidate@example",
      recordedAt: "2026-08-24T19:16:00+08:00",
      mode: "restore",
    });
    assert.equal(cleanReceipt.phase, "committed");
    assert.equal((await new JsonFileRuntimePersistence(join(root, "restored", "runtime.json")).load()).generation, 1);

    state.lifecycleStore.createThread();
    await persistence.save(state);
    const nPlusOneBytes = await readFile(statePath);
    const rollbackReceipt = await restoreRuntimeStateRecoveryBundle({
      workspaceRoot: root,
      bundleDirectory: "backups/n",
      targetStatePath: "state/runtime.json",
      expectedCandidateRef: "candidate@example",
      expectedCurrentSha256: sha256(nPlusOneBytes),
      recordedAt: "2026-08-24T19:17:00+08:00",
      mode: "rollback",
    });
    assert.equal(rollbackReceipt.previousGeneration, 2);
    assert.equal(rollbackReceipt.restoredGeneration, 1);
    const rolledBack = await new JsonFileRuntimePersistence(statePath).load();
    assert.equal(rolledBack.generation, 1);
    assert.equal(rolledBack.lifecycleStore.listThreads().length, 1);
    const receiptNames = (await readdir(`${statePath}.restore-receipts`)).sort();
    assert.equal(receiptNames.length, 2);
    assert.equal(receiptNames.filter((name) => name.endsWith(".prepared.json")).length, 1);
    assert.equal(receiptNames.filter((name) => name.endsWith(".committed.json")).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime recovery rejects overwrite, candidate drift, tampering, extras and stale rollback preconditions", async () => {
  const root = await mkdtemp(join(tmpdir(), "god-runtime-recovery-attacks-"));
  try {
    const statePath = join(root, "state", "runtime.json");
    const persistence = new JsonFileRuntimePersistence(statePath);
    const state = await persistence.load();
    state.lifecycleStore.createThread();
    await persistence.save(state);
    await createRuntimeStateRecoveryBundle({
      workspaceRoot: root,
      statePath: "state/runtime.json",
      outputDirectory: "backups/n",
      candidateRef: "candidate@example",
      createdAt: "2026-08-24T19:20:00+08:00",
    });
    await assert.rejects(
      createRuntimeStateRecoveryBundle({
        workspaceRoot: root,
        statePath: "state/runtime.json",
        outputDirectory: "backups/n",
        candidateRef: "candidate@example",
        createdAt: "2026-08-24T19:20:00+08:00",
      }),
      /already exists/u,
    );
    await assert.rejects(
      verifyRuntimeStateRecoveryBundle({ workspaceRoot: root, bundleDirectory: "backups/n", expectedCandidateRef: "other" }),
      /candidate/u,
    );
    await assert.rejects(
      restoreRuntimeStateRecoveryBundle({
        workspaceRoot: root,
        bundleDirectory: "backups/n",
        targetStatePath: "state/runtime.json",
        expectedCandidateRef: "candidate@example",
        recordedAt: "2026-08-24T19:21:00+08:00",
        mode: "restore",
      }),
      /refuses to overwrite/u,
    );
    state.lifecycleStore.createThread();
    await persistence.save(state);
    await assert.rejects(
      restoreRuntimeStateRecoveryBundle({
        workspaceRoot: root,
        bundleDirectory: "backups/n",
        targetStatePath: "state/runtime.json",
        expectedCandidateRef: "candidate@example",
        expectedCurrentSha256: "0".repeat(64),
        recordedAt: "2026-08-24T19:22:00+08:00",
        mode: "rollback",
      }),
      /precondition/u,
    );
    await writeFile(join(root, "backups", "n", "extra.txt"), "extra", "utf8");
    await assert.rejects(
      verifyRuntimeStateRecoveryBundle({ workspaceRoot: root, bundleDirectory: "backups/n" }),
      /exactly/u,
    );
    await rm(join(root, "backups", "n", "extra.txt"));
    const backupStatePath = join(root, "backups", "n", "runtime-state.json");
    await writeFile(backupStatePath, `${await readFile(backupStatePath, "utf8")} `, "utf8");
    await assert.rejects(
      verifyRuntimeStateRecoveryBundle({ workspaceRoot: root, bundleDirectory: "backups/n" }),
      /digest or byte count/u,
    );
    await assert.rejects(
      verifyRuntimeStateRecoveryBundle({ workspaceRoot: root, bundleDirectory: "../outside" }),
      /normalized workspace-relative/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime rollback requires a newer current generation and exact precondition digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "god-runtime-recovery-generation-"));
  try {
    const statePath = join(root, "state", "runtime.json");
    const persistence = new JsonFileRuntimePersistence(statePath);
    const state = await persistence.load();
    state.lifecycleStore.createThread();
    await persistence.save(state);
    await createRuntimeStateRecoveryBundle({ workspaceRoot: root, statePath: "state/runtime.json", outputDirectory: "backups/n", candidateRef: "candidate", createdAt: "2026-08-24T19:30:00+08:00" });
    await assert.rejects(
      restoreRuntimeStateRecoveryBundle({ workspaceRoot: root, bundleDirectory: "backups/n", targetStatePath: "state/runtime.json", expectedCandidateRef: "candidate", recordedAt: "2026-08-24T19:31:00+08:00", mode: "rollback", expectedCurrentSha256: sha256(await readFile(statePath)) }),
      /newer than the backup generation/u,
    );
    assert.equal((await persistence.load()).generation, 1);
    await assert.rejects(
      restoreRuntimeStateRecoveryBundle({ workspaceRoot: root, bundleDirectory: "backups/n", targetStatePath: "missing/runtime.json", expectedCandidateRef: "candidate", recordedAt: "2026-08-24T19:32:00+08:00", mode: "rollback", expectedCurrentSha256: "0".repeat(64) }),
      /existing runtime state/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createReleaseFixture(): Promise<{ root: string; candidates: string[] }> {
  const root = await mkdtemp(join(tmpdir(), "god-agent-release-readiness-"));
  const files: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "god-agent-fixture",
      version: "1.0.0",
      description: "A complete local release readiness test fixture.",
      license: "ISC",
      author: "Fixture Author",
      repository: "https://example.invalid/god-agent-fixture",
      main: "dist/electron-app/electron/main.cjs",
      bin: { "god-agent": "bin/god-agent.js" },
      scripts: {
        test: "tsx --test tests/sample-test.ts",
        "test:discovery": "tsx scripts/verify-test-discovery.ts",
        "test:evidence": "tsx --test tests/evidence-consistency-test.ts",
        "evidence:verify": "tsx scripts/verify-evidence-consistency.ts",
        "test:benchmarks": "tsx --test research/benchmarks/tests/sample-test.ts",
        "test:runtime-e2e": "tsx --test research/runtime-e2e-benchmarks/tests/sample-test.ts",
        "test:process-chaos": "tsx --test tests/process-chaos-test.ts",
        "electron:build": "echo build",
        "provider:smoke": "tsx scripts/provider-capability-smoke.ts",
      },
    }),
    "package-lock.json": JSON.stringify({
      name: "god-agent-fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "god-agent-fixture",
          version: "1.0.0",
          license: "ISC",
        },
      },
    }),
    "README.md": "# Fixture\n\nElectron and Multi-Agent.\n\n## 当前不应声称\n\nNo production claim.\n",
    "LICENSE": "ISC fixture text",
    "NOTICE": "Fixture notice",
    ".github/workflows/ci.yml": [
      "PROVIDER_SMOKE_LIVE: \"0\"",
      "npm ci",
      "npm run check",
      "npm run test:discovery",
      "npm run test:evidence",
      "npm run evidence:verify",
      "npm test",
      "npm run test:coverage",
      "npm run security:scan",
      "npm run test:benchmarks",
      "npm run test:runtime-e2e",
      "npm run test:process-chaos",
      "npm run electron:build",
      "npm run doctor",
      "npm run sbom:generate",
      "npm run release:check",
    ].join("\n"),
    "src/llm/provider-capability-smoke.ts": 'const live = env.PROVIDER_SMOKE_LIVE === "1";\n',
    "tests/sample-test.ts": "// fixture test",
    "tests/evidence-consistency-test.ts": "// fixture evidence test",
    "tests/process-chaos-test.ts": "// fixture test",
    "research/benchmarks/tests/sample-test.ts": "// fixture test",
    "research/runtime-e2e-benchmarks/tests/sample-test.ts": "// fixture test",
    "dist/electron-app/electron/main.cjs": "module.exports = {};",
    "dist/electron-app/electron/renderer/index.html": "<!doctype html>",
  };
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, ...path.split("/"));
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
  // The readiness fixture includes a fully consistent artifact-evidence set.
  // The real workspace intentionally has no such receipts and must remain BLOCKED.
  const installer = Buffer.from("signed-installer-fixture\n", "utf8");
  await mkdir(join(root, "dist", "release"), { recursive: true });
  await mkdir(join(root, "evidence"), { recursive: true });
  await writeFile(join(root, "dist", "release", "installer.exe"), installer);
  const candidateRef = "candidate-fixture-1";
  const installerSha256 = sha256(installer);
  const signature = {
    schemaVersion: "god-agent-release-signature-v1",
    candidateRef,
    installerSha256,
    status: "verified",
    format: "authenticode",
    certificateSubject: "CN=Fixture Release",
    timestamped: true,
    verificationTool: "signtool",
  };
  const cleanMachine = {
    schemaVersion: "god-agent-clean-machine-v1",
    candidateRef,
    status: "passed",
    executorId: "fixture-executor",
    machineId: "fixture-clean-win32",
    installPassed: true,
    startupPassed: true,
    uninstallPassed: true,
  };
  const upgradeRollback = {
    schemaVersion: "god-agent-upgrade-rollback-v1",
    candidateRef,
    status: "passed",
    testedFrom: "1.0.0",
    testedTo: "1.0.1",
    rollbackVerified: true,
    stateIntegrityVerified: true,
  };
  const longStability = JSON.stringify({
    schemaVersion: "god-agent-long-stability-v1",
    candidateRef,
    status: "passed",
    durationSeconds: 3600,
    failureCount: 0,
    recoveryVerified: true,
  }) + "\n";
  await writeFile(join(root, "evidence", "signature.json"), `${JSON.stringify(signature)}\n`, "utf8");
  await writeFile(join(root, "evidence", "clean-machine.json"), `${JSON.stringify(cleanMachine)}\n`, "utf8");
  await writeFile(join(root, "evidence", "upgrade-rollback.json"), `${JSON.stringify(upgradeRollback)}\n`, "utf8");
  await writeFile(join(root, "evidence", "long-stability.json"), longStability, "utf8");
  const manifest = {
    schemaVersion: "god-agent-release-artifact-v1",
    candidateRef,
    createdAt: "2026-08-26T08:00:00.000Z",
    installerPath: "dist/release/installer.exe",
    installerSha256,
    signature: { status: "verified", format: "authenticode", evidencePath: "evidence/signature.json", certificateSubject: "CN=Fixture Release", timestamped: true },
    cleanMachine: { status: "passed", evidencePath: "evidence/clean-machine.json", executorId: "fixture-executor", machineId: "fixture-clean-win32" },
    upgradeRollback: { status: "passed", evidencePath: "evidence/upgrade-rollback.json", testedFrom: "1.0.0", testedTo: "1.0.1", rollbackVerified: true },
    longStability: { status: "passed", evidencePath: "evidence/long-stability.json", durationSeconds: 3600, evidenceSha256: sha256(Buffer.from(longStability, "utf8")) },
    claimBoundary: "artifact-evidence-only-not-provider-not-production-approval",
  };
  await writeFile(join(root, "dist", "release", "release-artifact.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await createReleaseSupplyChainFixture(root, candidateRef);
  return { root, candidates: Object.keys(files).filter((path) => !path.startsWith("dist/")) };
}

async function createReleaseSupplyChainFixture(root: string, candidateRef = "candidate-fixture-1"): Promise<void> {
  const sbomText = `${JSON.stringify({
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    components: [{ type: "library", name: "fixture", version: "1.0.0", purl: "pkg:npm/fixture@1.0.0" }],
  }, null, 2)}\n`;
  const securityText = `${JSON.stringify({
    schemaVersion: "god-agent-security-scan-v1",
    candidateRef,
    status: "passed",
    scannedFiles: 42,
    findings: [],
  }, null, 2)}\n`;
  const integrityText = `${JSON.stringify({
    schemaVersion: "god-agent-data-integrity-v1",
    candidateRef,
    status: "passed",
    stateDigestVerified: true,
    backupRestoreVerified: true,
    noDataLoss: true,
  }, null, 2)}\n`;
  await writeFile(join(root, "dist", "release", "god-agent.cdx.json"), sbomText, "utf8");
  await writeFile(join(root, "dist", "release", "security-scan.json"), securityText, "utf8");
  await writeFile(join(root, "dist", "release", "data-integrity.json"), integrityText, "utf8");
  const manifest = {
    schemaVersion: "god-agent-release-supply-chain-v1",
    candidateRef,
    createdAt: "2026-08-26T08:00:00.000Z",
    releaseArtifactSha256: sha256(await readFile(join(root, "dist", "release", "release-artifact.json"))),
    sbom: { path: "dist/release/god-agent.cdx.json", sha256: sha256(Buffer.from(sbomText)), format: "CycloneDX", specVersion: "1.5", componentCount: 1 },
    securityScan: { path: "dist/release/security-scan.json", sha256: sha256(Buffer.from(securityText)), status: "passed", scannedFiles: 42, findingCount: 0 },
    dataIntegrity: { path: "dist/release/data-integrity.json", sha256: sha256(Buffer.from(integrityText)), status: "passed", stateDigestVerified: true, backupRestoreVerified: true, noDataLoss: true },
    claimBoundary: "supply-chain-evidence-only-not-production-approval",
  };
  await writeFile(join(root, "dist", "release", "release-supply-chain.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function find(report: Awaited<ReturnType<typeof evaluateReleaseReadiness>>, id: string) {
  const check = report.checks.find((item) => item.id === id);
  assert.ok(check, `missing readiness check ${id}`);
  return check;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
