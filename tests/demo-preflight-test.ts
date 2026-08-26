import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  formatDemoPreflight,
  runDemoPreflight,
} from "../scripts/demo-preflight.js";
import {
  createOfflineDefenseBundle,
  verifyOfflineDefenseBundle,
  type OfflineDefenseInput,
} from "../scripts/offline-defense-bundle.js";
import {
  expectedDocumentTokens,
  type EvidenceSnapshot,
} from "../scripts/verify-evidence-consistency.js";

const REQUIRED_FILES = [
  "package.json",
  "package-lock.json",
  "README.md",
  "bin/god-agent.js",
  "scripts/run-offline-benchmark.ts",
  "scripts/start-electron.mjs",
  "research/benchmarks/fixtures/gate-30.json",
  "node_modules/tsx/package.json",
  "node_modules/typescript/package.json",
  "node_modules/electron/package.json",
] as const;
const BUILD_FILES = [
  "dist/electron-app/electron/main.cjs",
  "dist/electron-app/electron/renderer/index.html",
] as const;

test("完整离线演示环境通过，未配置 Provider 只产生警告", async () => {
  const root = await createFixtureRoot(true);
  try {
    const report = await runDemoPreflight({
      rootDirectory: root,
      nodeVersion: "20.19.0",
      environment: {},
      tempDirectory: path.join(root, "temp"),
    });

    assert.equal(report.ready, true);
    assert.equal(report.offlineDemoReady, true);
    assert.equal(report.providerConfigured, false);
    assert.equal(report.summary.failed, 0);
    assert.equal(report.checks.find((item) => item.id === "provider")?.status, "warn");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("缺少依赖时 fail-closed，但缺 Electron 构建仅阻止桌面展示", async () => {
  const root = await createFixtureRoot(false, false);
  try {
    const report = await runDemoPreflight({
      rootDirectory: root,
      nodeVersion: "20.19.0",
      environment: {},
      tempDirectory: path.join(root, "temp"),
    });

    assert.equal(report.ready, false);
    assert.equal(report.checks.find((item) => item.id === "dependencies")?.status, "fail");
    assert.equal(report.checks.find((item) => item.id === "electron-build")?.status, "warn");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Provider 自检只观察变量名，不读取或输出密钥值", async () => {
  const root = await createFixtureRoot(true);
  const environment: Record<string, string | undefined> = {
    OPENAI_BASE_URL: "https://secret-provider.example/internal",
    OPENAI_MODEL: "private-model-name",
  };
  Object.defineProperty(environment, "OPENAI_API_KEY", {
    enumerable: true,
    get: () => {
      throw new Error("secret value must not be read");
    },
  });
  try {
    const report = await runDemoPreflight({
      rootDirectory: root,
      nodeVersion: "22.14.0",
      environment,
      tempDirectory: path.join(root, "temp"),
    });
    const formatted = formatDemoPreflight(report);

    assert.equal(report.providerConfigured, true);
    assert.doesNotMatch(formatted, /secret-provider|private-model-name|secret value/);
    assert.match(formatted, /值未读取/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("过旧 Node 与不可写入的临时目标都会阻止离线 Demo", async () => {
  const root = await createFixtureRoot(true);
  const notDirectory = path.join(root, "temp-file");
  await writeFile(notDirectory, "not a directory", "utf8");
  try {
    const report = await runDemoPreflight({
      rootDirectory: root,
      nodeVersion: "18.20.0",
      environment: {},
      tempDirectory: notDirectory,
    });

    assert.equal(report.ready, false);
    assert.equal(report.checks.find((item) => item.id === "node")?.status, "fail");
    assert.equal(report.checks.find((item) => item.id === "temp-write")?.status, "fail");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("离线答辩冻结包绑定候选、证据、PPT、讲稿、问答、截图与报告", async () => {
  const fixture = await createOfflineBundleFixture();
  try {
    const result = await createOfflineDefenseBundle({
      workspaceRoot: fixture.root,
      outputDirectory: ".tmp/offline-defense",
      inputs: fixture.inputs,
    });
    assert.equal(result.verifiedFiles, fixture.inputs.length);
    assert.equal(result.manifest.candidateRef, fixture.snapshot.candidate.baseline);
    assert.deepEqual(result.manifest.claimBoundary, {
      rehearsalStatus: "NotRun",
      formalVerified: 0,
      liveCalls: 0,
      releaseStatus: "BLOCKED",
      productionStatus: "BLOCKED",
    });

    const verified = await verifyOfflineDefenseBundle({
      workspaceRoot: fixture.root,
      outputDirectory: ".tmp/offline-defense",
    });
    assert.match(verified.manifestSha256, /^[a-f0-9]{64}$/u);
    await assert.rejects(
      createOfflineDefenseBundle({
        workspaceRoot: fixture.root,
        outputDirectory: ".tmp/offline-defense",
        inputs: fixture.inputs,
      }),
      /already exists/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("离线答辩冻结包拒绝源文件或副本摘要漂移、缺失和额外文件", async () => {
  for (const attack of ["source-drift", "bundle-drift", "missing", "extra"] as const) {
    const fixture = await createOfflineBundleFixture();
    try {
      await createOfflineDefenseBundle({
        workspaceRoot: fixture.root,
        outputDirectory: ".tmp/offline-defense",
        inputs: fixture.inputs,
      });
      const bundleRoot = path.join(fixture.root, ".tmp", "offline-defense");
      if (attack === "source-drift") await appendFile(path.join(fixture.root, "docs", "script.md"), "changed\n", "utf8");
      if (attack === "bundle-drift") await appendFile(path.join(bundleRoot, "files", "docs", "script.md"), "changed\n", "utf8");
      if (attack === "missing") await unlink(path.join(bundleRoot, "files", "docs", "slides", "slide-1.png"));
      if (attack === "extra") await writeFile(path.join(bundleRoot, "extra.txt"), "extra\n", "utf8");
      await assert.rejects(
        verifyOfflineDefenseBundle({ workspaceRoot: fixture.root, outputDirectory: ".tmp/offline-defense" }),
        /drift|missing/u,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("离线答辩冻结包拒绝绝对路径、secret 和旧数字", async () => {
  const fixture = await createOfflineBundleFixture();
  try {
    await assert.rejects(
      createOfflineDefenseBundle({
        workspaceRoot: fixture.root,
        outputDirectory: path.resolve(fixture.root, "absolute-output"),
        inputs: fixture.inputs,
      }),
      /workspace-relative/u,
    );

    const syntheticSecret = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz123456"].join("-");
    await appendFile(path.join(fixture.root, "docs", "qa.md"), `${syntheticSecret}\n`, "utf8");
    await assert.rejects(
      createOfflineDefenseBundle({ workspaceRoot: fixture.root, outputDirectory: ".tmp/secret", inputs: fixture.inputs }),
      /secret pattern/u,
    );

    await writeFile(path.join(fixture.root, "docs", "qa.md"), "stale 658 tests\n", "utf8");
    await assert.rejects(
      createOfflineDefenseBundle({ workspaceRoot: fixture.root, outputDirectory: ".tmp/stale", inputs: fixture.inputs }),
      /old-number drift/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function createFixtureRoot(
  includeBuild: boolean,
  includeDependencies = true,
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "god-agent-demo-preflight-test-"));
  const paths = [
    ...REQUIRED_FILES.filter((item) => includeDependencies || !item.startsWith("node_modules/")),
    ...(includeBuild ? BUILD_FILES : []),
  ];
  await Promise.all(paths.map(async (relativePath) => {
    const filename = path.join(root, relativePath);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, "fixture\n", "utf8");
  }));
  await mkdir(path.join(root, "temp"), { recursive: true });
  return root;
}

async function createOfflineBundleFixture(): Promise<{
  root: string;
  inputs: OfflineDefenseInput[];
  snapshot: EvidenceSnapshot;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "god-agent-offline-defense-test-"));
  const snapshot: EvidenceSnapshot = {
    schemaVersion: 1,
    capturedAt: "2026-08-24T19:00:00+08:00",
    candidate: { baseline: "main@test-candidate", state: "uncommitted-local-worktree", remoteVerified: false },
    testDiscovery: { formalFiles: 113, coveredFiles: 113, omitted: 0, stale: 0 },
    mainTests: { total: 736, passed: 735, skipped: 1, failed: 0, skipBoundary: "Windows symlink privilege conditional skip" },
    coverage: {
      sourceFiles: 122,
      loadedFiles: 116,
      lineCovered: 26146,
      lineTotal: 28672,
      linePercent: 91.19,
      gateLinePercent: 90.25,
      gateLoadedPercent: 93,
    },
    processChaos: { passed: 17, total: 17 },
    gate40: {
      candidate: 40,
      runnable: 40,
      localPassed: 40,
      localFailed: 0,
      blocked: 0,
      formalVerified: 0,
      complete: false,
      lifecycle: "candidate-not-frozen",
    },
    provider: { mode: "offline-deterministic-fake", liveCalls: 0, credentialsRead: false },
    release: {
      localPassed: 11,
      localTotal: 12,
      localStatus: "BLOCKED",
      productionStatus: "BLOCKED",
      auditCritical: 0,
      auditHigh: 3,
    },
    scores: { target: 95, engineering: 93, interview: 90, research: 69, paper: 47, production: 68 },
    presentation: {
      slides: 7,
      renderedSlides: 7,
      overflowErrors: 0,
      sourceNotes: 7,
      qaMode: "separate-render-and-notes-qa",
    },
    rehearsal: {
      timedCompleted: 0,
      timedRequired: 3,
      nonAuthorCompleted: 0,
      nonAuthorRequired: 1,
      status: "NotRun",
      records: [],
    },
    claimBoundary: ["a", "b", "c", "d", "e"],
  };
  const authoritativeText = `${expectedDocumentTokens(snapshot).join("\n")}\n`;
  const inputs: OfflineDefenseInput[] = [
    { role: "evidence-snapshot", path: "docs/evidence/current-evidence.json" },
    { role: "presentation", path: "docs/presentation.pptx" },
    { role: "presentation-inspection", path: "docs/presentation.inspect.ndjson" },
    { role: "script", path: "docs/script.md" },
    { role: "q-and-a", path: "docs/qa.md" },
    { role: "screenshot", path: "docs/slides/slide-1.png" },
    { role: "report", path: "docs/reports/gate40.json" },
  ];
  const contents = new Map<string, string | Buffer>([
    ["docs/evidence/current-evidence.json", `${JSON.stringify(snapshot, null, 2)}\n`],
    ["docs/presentation.pptx", Buffer.from([0x50, 0x4b, 0x03, 0x04])],
    ["docs/presentation.inspect.ndjson", authoritativeText],
    ["docs/script.md", authoritativeText],
    ["docs/qa.md", authoritativeText],
    ["docs/slides/slide-1.png", Buffer.from([0x89, 0x50, 0x4e, 0x47])],
    ["docs/reports/gate40.json", "{\"formalVerified\":0}\n"],
  ]);
  await Promise.all([...contents].map(async ([relativePath, content]) => {
    const absolute = path.join(root, relativePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }));
  return { root, inputs, snapshot };
}
