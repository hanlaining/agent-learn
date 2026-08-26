import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendPersistentRunLedgerEvent,
  initializePersistentRunLedger,
  readPersistentRunLedger,
} from "../research/rt95-closure/src/persistent-run-ledger.js";
import {
  createFormalRawLedger,
  type AppendLedgerEventInput,
  type FormalCasePlan,
} from "../research/rt95-closure/src/formal-research-packet.js";
import {
  createPublishableDerivation,
  verifyPublishableDerivation,
} from "../research/reproducibility/src/publishable-sanitizer.js";
import {
  createVersionedArtifactRelease,
  validateVersionedArtifactRelease,
  verifyVersionedArtifactRelease,
  type ArtifactReleaseFileInput,
} from "../research/reproducibility/src/artifact-release.js";

const PLAN: FormalCasePlan[] = [{
  caseId: "CASE-PERSISTENT-001",
  armId: "ARM-BASELINE",
  faultWindowId: "FW-MODEL-RESPONSE-COMMIT",
  seed: 469816031,
}];
const ARTIFACT_SHA = "a".repeat(64);

test("文件系统 ledger 跨中断恢复并不可抹除地保留人工介入、aborted、excluded、failure、获准重跑与 success", async (context) => {
  const root = await emptyTarget(context, "rt95-persistent-ledger-");
  let ledger = createFormalRawLedger("PACKET-PERSISTENT-001", "1".repeat(64), "2026-08-24T08:00:00.000Z");
  ledger = await initializePersistentRunLedger(root, ledger, PLAN);
  ledger = await appendPersistentRunLedgerEvent(root, PLAN, event("EVENT-START-1", "case-started", "2026-08-24T08:01:00.000Z", {
    caseId: PLAN[0]!.caseId, attempt: 1,
  }));
  assert.equal((await readPersistentRunLedger(root, PLAN)).events.at(-1)?.eventType, "case-started", "进程中断后必须恢复 active attempt");
  ledger = await appendPersistentRunLedgerEvent(root, PLAN, event("EVENT-MANUAL-1", "manual-intervention-recorded", "2026-08-24T08:02:00.000Z", {
    caseId: PLAN[0]!.caseId, attempt: 1, artifactPath: "interventions/operator-1.json",
    artifactSha256: "2".repeat(64), reason: "operator-observed-harness-stall-no-state-edit",
  }));
  ledger = await appendPersistentRunLedgerEvent(root, PLAN, terminal("EVENT-ABORTED-1", "2026-08-24T08:03:00.000Z", 1, "aborted", "operator-stopped-after-stall"));
  ledger = await appendPersistentRunLedgerEvent(root, PLAN, rerun("EVENT-RERUN-2", "2026-08-24T08:04:00.000Z", 2));
  ledger = await appendPersistentRunLedgerEvent(root, PLAN, started("EVENT-START-2", "2026-08-24T08:05:00.000Z", 2));
  ledger = await appendPersistentRunLedgerEvent(root, PLAN, terminal("EVENT-EXCLUDED-2", "2026-08-24T08:06:00.000Z", 2, "excluded", "frozen-exclusion-rule"));
  ledger = await appendPersistentRunLedgerEvent(root, PLAN, rerun("EVENT-RERUN-3", "2026-08-24T08:07:00.000Z", 3));
  ledger = await appendPersistentRunLedgerEvent(root, PLAN, started("EVENT-START-3", "2026-08-24T08:08:00.000Z", 3));
  ledger = await appendPersistentRunLedgerEvent(root, PLAN, terminal("EVENT-FAILURE-3", "2026-08-24T08:09:00.000Z", 3, "failure", "oracle-failed"));
  ledger = await appendPersistentRunLedgerEvent(root, PLAN, rerun("EVENT-RERUN-4", "2026-08-24T08:10:00.000Z", 4));
  ledger = await appendPersistentRunLedgerEvent(root, PLAN, started("EVENT-START-4", "2026-08-24T08:11:00.000Z", 4));
  ledger = await appendPersistentRunLedgerEvent(root, PLAN, terminal("EVENT-SUCCESS-4", "2026-08-24T08:12:00.000Z", 4, "success", null));
  ledger = await appendPersistentRunLedgerEvent(root, PLAN, event("EVENT-SEAL", "ledger-sealed", "2026-08-24T08:13:00.000Z"));

  assert.equal(ledger.status, "sealed");
  assert.deepEqual(
    ledger.events.filter((item) => item.eventType === "case-recorded").map((item) => item.outcome),
    ["aborted", "excluded", "failure", "success"],
  );
  assert.equal(ledger.events.some((item) => item.eventType === "manual-intervention-recorded"), true);
  assert.equal((await readPersistentRunLedger(root, PLAN)).events.length, 14);
  await assert.rejects(
    appendPersistentRunLedgerEvent(root, PLAN, event("EVENT-REPLAY-AFTER-SEAL", "manual-intervention-recorded", "2026-08-24T08:14:00.000Z", {
      artifactPath: "interventions/replay.json", artifactSha256: ARTIFACT_SHA, reason: "forbidden-replay",
    })),
    /sealed/u,
  );
});

test("持久 ledger 拒绝覆盖、内容篡改、事件删除、重排、重放和额外文件", async (context) => {
  for (const attack of ["overwrite", "tamper", "delete", "reorder", "replay", "extra"] as const) {
    const root = await basicPersistentLedger(context, attack);
    const eventsRoot = path.join(root, "events");
    if (attack === "overwrite") {
      await assert.rejects(
        initializePersistentRunLedger(root, createFormalRawLedger("PACKET-SECOND", "3".repeat(64), "2026-08-24T09:00:00.000Z"), PLAN),
        /already exists/u,
      );
      continue;
    }
    if (attack === "tamper") {
      const target = path.join(eventsRoot, "000002.json");
      const value = JSON.parse(await readFile(target, "utf8"));
      value.reason = "rewritten-history";
      await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    } else if (attack === "delete") {
      await unlink(path.join(eventsRoot, "000001.json"));
    } else if (attack === "reorder") {
      const first = path.join(eventsRoot, "000001.json");
      const second = path.join(eventsRoot, "000002.json");
      const temporary = path.join(eventsRoot, "swap.tmp");
      await rename(first, temporary);
      await rename(second, first);
      await rename(temporary, second);
    } else if (attack === "replay") {
      await copyFile(path.join(eventsRoot, "000001.json"), path.join(eventsRoot, "000003.json"));
    } else {
      await writeFile(path.join(root, "unexpected.txt"), "attack\n", "utf8");
    }
    await assert.rejects(
      readPersistentRunLedger(root, PLAN),
      /(?:digest|hash|gap|deletion|reorder|replay|sequence|unexpected|canonical)/u,
      `attack ${attack} must fail closed`,
    );
  }
});

test("持久 ledger 拒绝 header schema、claim boundary、case plan 和 digest 漂移", async (context) => {
  for (const mutation of ["schemaVersion", "claimBoundary", "casePlanSha256", "headerSha256", "createdAt"] as const) {
    const root = await basicPersistentLedger(context, `header-${mutation}`);
    const target = path.join(root, "run-ledger-header.json");
    const header = JSON.parse(await readFile(target, "utf8")) as Record<string, any>;
    if (mutation === "schemaVersion") header.schemaVersion = "wrong-v2";
    if (mutation === "claimBoundary") header.claimBoundary = "formal-verified";
    if (mutation === "casePlanSha256") header.casePlanSha256 = "f".repeat(64);
    if (mutation === "headerSha256") header.headerSha256 = "e".repeat(64);
    if (mutation === "createdAt") header.createdAt = "2026-08-24T08:00:00Z";
    await writeFile(target, serializeCanonical(header), "utf8");
    await assert.rejects(readPersistentRunLedger(root, PLAN), /header|digest|canonical/u, `header ${mutation} must fail closed`);
  }
});

test("持久 ledger 拒绝根目录/事件目录结构污染与非 JSON 内容", async (context) => {
  const root = await basicPersistentLedger(context, "layout");
  await writeFile(path.join(root, "unexpected.json"), "{}\n", "utf8");
  await assert.rejects(readPersistentRunLedger(root, PLAN), /unexpected root entries/u);

  const malformed = await basicPersistentLedger(context, "malformed");
  await writeFile(path.join(malformed, "events", "000002.json"), "{broken\n", "utf8");
  await assert.rejects(readPersistentRunLedger(malformed, PLAN), /valid JSON/u);

  const nonCanonical = await basicPersistentLedger(context, "noncanonical");
  const eventPath = path.join(nonCanonical, "events", "000001.json");
  const eventValue = JSON.parse(await readFile(eventPath, "utf8"));
  await writeFile(eventPath, JSON.stringify(eventValue), "utf8");
  await assert.rejects(readPersistentRunLedger(nonCanonical, PLAN), /canonical/u);
});

test("持久 ledger 拒绝事件命名、序号、首事件和符号链接边界", async (context) => {
  const badName = await basicPersistentLedger(context, "bad-name");
  await rename(path.join(badName, "events", "000002.json"), path.join(badName, "events", "event.json"));
  await assert.rejects(readPersistentRunLedger(badName, PLAN), /unexpected persistent ledger event file/u);

  const gap = await basicPersistentLedger(context, "gap");
  await rename(path.join(gap, "events", "000002.json"), path.join(gap, "events", "000004.json"));
  await assert.rejects(readPersistentRunLedger(gap, PLAN), /gap|deletion|reorder/u);

  const firstMismatch = await basicPersistentLedger(context, "first-mismatch");
  const headerPath = path.join(firstMismatch, "run-ledger-header.json");
  const header = JSON.parse(await readFile(headerPath, "utf8")) as Record<string, any>;
  header.firstEventSha256 = "a".repeat(64);
  header.headerSha256 = digestCanonical(Object.fromEntries(Object.entries(header).filter(([key]) => key !== "headerSha256")));
  await writeFile(headerPath, serializeCanonical(header), "utf8");
  await assert.rejects(readPersistentRunLedger(firstMismatch, PLAN), /first event|hash|digest/u);

  const symlinkRoot = await basicPersistentLedger(context, "symlink");
  try {
    await symlink(path.join(symlinkRoot, "events", "000001.json"), path.join(symlinkRoot, "events", "000009.json"), "file");
  } catch (error) {
    if (error instanceof Error && "code" in error && ["EPERM", "EACCES", "UNKNOWN"].includes(String((error as NodeJS.ErrnoException).code))) {
      return;
    }
    throw error;
  }
  await assert.rejects(readPersistentRunLedger(symlinkRoot, PLAN), /regular files|symbolic links|unexpected/u);
});

test("持久 ledger 跨读取恢复后保持 append-only，重复并发追加至少一方失败", async (context) => {
  const root = await emptyTarget(context, "rt95-ledger-concurrent-");
  await initializePersistentRunLedger(root, createFormalRawLedger("PACKET-CONCURRENT-001", "6".repeat(64), "2026-08-24T11:00:00.000Z"), PLAN);
  await appendPersistentRunLedgerEvent(root, PLAN, started("EVENT-CONCURRENT-START", "2026-08-24T11:01:00.000Z", 1));
  const input = terminal("EVENT-CONCURRENT-RAW", "2026-08-24T11:02:00.000Z", 1, "failure", "concurrent-test");
  const results = await Promise.allSettled([
    appendPersistentRunLedgerEvent(root, PLAN, input),
    appendPersistentRunLedgerEvent(root, PLAN, input),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.match(String(results.find((result) => result.status === "rejected")?.reason), /(?:append target|duplicate|history|event)/u);
  assert.equal((await readPersistentRunLedger(root, PLAN)).events.at(-1)?.eventType, "case-recorded");
});

test("publishable sanitizer 只复制显式白名单，并生成不披露私有路径的源摘要→公开派生 receipt", async (context) => {
  const fixture = await sanitizerFixture(context, "valid");
  const receipt = await createPublishableDerivation({
    privateRootDirectory: fixture.privateRoot,
    publicRootDirectory: fixture.publicRoot,
    allowPaths: ["report.json", "tables/results.csv"],
  });
  assert.equal(receipt.privateSource.fileCount, 4);
  assert.equal(receipt.publicDerivation.fileCount, 2);
  assert.equal(receipt.publicDerivation.excludedFileCount, 2);
  assert.equal(receipt.policy.privatePathsDisclosed, false);
  assert.equal(receipt.policy.secretsCopied, false);
  const serialized = JSON.stringify(receipt);
  assert.doesNotMatch(serialized, /helper-secret|credentials\.env|private-value/u);
  assert.deepEqual(
    receipt.publicDerivation.files.map((item) => item.path),
    ["report.json", "tables/results.csv"],
  );
  assert.deepEqual(await verifyPublishableDerivation({
    privateRootDirectory: fixture.privateRoot,
    publicRootDirectory: fixture.publicRoot,
  }), receipt);
  await assert.rejects(
    createPublishableDerivation({
      privateRootDirectory: fixture.privateRoot,
      publicRootDirectory: fixture.publicRoot,
      allowPaths: ["report.json"],
    }),
    /already exists/u,
  );
});

test("sanitizer 拒绝把 secret 文件名或高置信凭据内容加入公开白名单", async (context) => {
  const named = await sanitizerFixture(context, "named-secret");
  await assert.rejects(
    createPublishableDerivation({
      privateRootDirectory: named.privateRoot,
      publicRootDirectory: named.publicRoot,
      allowPaths: ["credentials.env"],
    }),
    /sensitive file/u,
  );
  const content = await sanitizerFixture(context, "content-secret");
  const githubLikeToken = ["ghp_", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd"].join("");
  await writeFile(path.join(content.privateRoot, "report.json"), JSON.stringify({
    token: githubLikeToken,
  }), "utf8");
  await assert.rejects(
    createPublishableDerivation({
      privateRootDirectory: content.privateRoot,
      publicRootDirectory: content.publicRoot,
      allowPaths: ["report.json"],
    }),
    /resembles a credential/u,
  );
  const helper = await sanitizerFixture(context, "helper-secret-name");
  await assert.rejects(
    createPublishableDerivation({
      privateRootDirectory: helper.privateRoot,
      publicRootDirectory: helper.publicRoot,
      allowPaths: ["helper-secret.bin"],
    }),
    /sensitive file/u,
  );
});

test("publishable verifier 拒绝私有源漂移、公开篡改/删除/额外文件、receipt 篡改与旧 receipt 重放", async (context) => {
  for (const attack of ["source-drift", "public-tamper", "public-delete", "public-extra", "receipt-tamper", "receipt-replay"] as const) {
    const fixture = await sanitizerFixture(context, attack);
    await createPublishableDerivation({
      privateRootDirectory: fixture.privateRoot,
      publicRootDirectory: fixture.publicRoot,
      allowPaths: ["report.json", "tables/results.csv"],
    });
    if (attack === "source-drift") {
      await writeFile(path.join(fixture.privateRoot, "report.json"), "{\"status\":\"changed\"}\n", "utf8");
    } else if (attack === "public-tamper") {
      await writeFile(path.join(fixture.publicRoot, "report.json"), "{\"status\":\"changed\"}\n", "utf8");
    } else if (attack === "public-delete") {
      await unlink(path.join(fixture.publicRoot, "tables", "results.csv"));
    } else if (attack === "public-extra") {
      await writeFile(path.join(fixture.publicRoot, "extra.txt"), "extra\n", "utf8");
    } else {
      const receiptPath = path.join(fixture.publicRoot, "publishable-derivation-receipt.json");
      const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
      if (attack === "receipt-tamper") receipt.publicDerivation.excludedFileCount = 0;
      else receipt.privateSource.treeSha256 = "f".repeat(64);
      await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    }
    await assert.rejects(
      verifyPublishableDerivation({
        privateRootDirectory: fixture.privateRoot,
        publicRootDirectory: fixture.publicRoot,
      }),
      /(?:drift|digest|file set|canonical)/u,
      `publishable attack ${attack} must fail closed`,
    );
  }
});

test("版本化 Artifact Release 严格绑定源码、Draft 预注册、数据字典、公开 Raw receipt、统计、表格、manifest、license 与 CodeVerified Claims", async (context) => {
  const fixture = await releaseFixture(context, "valid");
  const release = await createVersionedArtifactRelease(releaseOptions(fixture));
  assert.equal(release.releaseVersion, "0.1.0");
  assert.equal(release.claimBoundary, "local-tooling-only-not-formal-or-external");
  assert.equal(release.evidenceState.preregistration, "Draft");
  assert.equal(release.evidenceState.formalRaw, "NotIncluded");
  assert.equal(release.evidenceState.formalExperiment, "NotRun");
  assert.equal(release.review.independentReview, false);
  assert.deepEqual(release.claims.includedClaimIds, ["CLAIM-PIPELINE-LOCAL-001"]);
  assert.equal(release.files.length, RELEASE_FILES.length);
  assert.deepEqual(await verifyVersionedArtifactRelease({
    outputRootDirectory: fixture.outputRoot,
    minimumReleaseVersion: "0.1.0",
    expectedCandidateCommit: "5".repeat(40),
  }), release);
});

test("Artifact Release verifier 拒绝缺失、extra、摘要漂移、secret 与版本回退", async (context) => {
  for (const attack of ["missing", "extra", "digest", "secret", "rollback"] as const) {
    const fixture = await releaseFixture(context, attack);
    if (attack === "secret") {
      const token = ["ghp_", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd"].join("");
      await writeFile(path.join(fixture.sourceRoot, "src", "runtime.ts"), `export const token = ${JSON.stringify(token)};\n`, "utf8");
      await assert.rejects(createVersionedArtifactRelease(releaseOptions(fixture)), /credential/u);
      continue;
    }
    await createVersionedArtifactRelease(releaseOptions(fixture));
    if (attack === "missing") await unlink(path.join(fixture.outputRoot, "raw", "summary.csv"));
    if (attack === "extra") await writeFile(path.join(fixture.outputRoot, "extra.txt"), "extra\n", "utf8");
    if (attack === "digest") await writeFile(path.join(fixture.outputRoot, "raw", "report.json"), "{\"changed\":true}\n", "utf8");
    await assert.rejects(
      verifyVersionedArtifactRelease({
        outputRootDirectory: fixture.outputRoot,
        minimumReleaseVersion: attack === "rollback" ? "0.2.0" : "0.1.0",
        expectedCandidateCommit: "5".repeat(40),
      }),
      /(?:file set drift|digest drift|rollback)/u,
    );
  }
});

test("Artifact Release verifier 拒绝把 publishable receipt 边界升级为 formal 或 external", async (context) => {
  const fixture = await releaseFixture(context, "receipt-boundary-overreach");
  await createVersionedArtifactRelease(releaseOptions(fixture));
  const receiptPath = path.join(fixture.outputRoot, "raw", "publishable-derivation-receipt.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
  receipt.claimBoundary = "formal-experiment-verified";
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

  await assert.rejects(
    verifyVersionedArtifactRelease({
      outputRootDirectory: fixture.outputRoot,
      minimumReleaseVersion: "0.1.0",
      expectedCandidateCommit: "5".repeat(40),
    }),
    /publishable receipt claim boundary mismatch/u,
  );
});

test("Artifact Release verifier 拒绝候选 commit 漂移，即使攻击者重算 release digest", async (context) => {
  const fixture = await releaseFixture(context, "candidate-drift");
  await createVersionedArtifactRelease(releaseOptions(fixture));
  const manifestPath = path.join(fixture.outputRoot, "artifact-release.json");
  const release = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  release.candidateCommit = "6".repeat(40);
  const { releaseSha256: _ignored, ...withoutDigest } = release;
  release.releaseSha256 = digestCanonical(withoutDigest);
  await writeFile(manifestPath, serializeCanonical(release), "utf8");

  await assert.rejects(
    verifyVersionedArtifactRelease({
      outputRootDirectory: fixture.outputRoot,
      minimumReleaseVersion: "0.1.0",
      expectedCandidateCommit: "5".repeat(40),
    }),
    /candidate commit drift/u,
  );
});

test("Artifact Release 状态与 provenance 组合越界均 fail-closed", async (context) => {
  const fixture = await releaseFixture(context, "release-boundary-matrix");
  const release = await createVersionedArtifactRelease(releaseOptions(fixture));
  const mutations: Array<{ label: string; mutate: (value: any) => void; error: RegExp }> = [
    { label: "formal review", mutate: (value) => { value.review.formalEvidenceReviewed = true; }, error: /unreviewed or overclaimed/u },
    { label: "independent review", mutate: (value) => { value.review.independentReview = true; }, error: /unreviewed or overclaimed/u },
    { label: "frozen preregistration", mutate: (value) => { value.evidenceState.preregistration = "Frozen"; }, error: /overclaims/u },
    { label: "formal Raw", mutate: (value) => { value.evidenceState.formalRaw = "Verified"; }, error: /overclaims/u },
    { label: "formal experiment", mutate: (value) => { value.evidenceState.formalExperiment = "Verified"; }, error: /overclaims/u },
    { label: "external reproduction", mutate: (value) => { value.evidenceState.externalReproduction = "Verified"; }, error: /overclaims/u },
    { label: "publication review", mutate: (value) => { value.evidenceState.publicationReview = "Reviewed"; }, error: /overclaims/u },
    { label: "claim evidence state", mutate: (value) => { value.claims.includedEvidenceState = "NotVerified"; }, error: /non-empty CodeVerified claims/u },
    { label: "formal raw mode", mutate: (value) => { value.rawEvidence.mode = "formal-raw"; }, error: /bounded publishable receipt/u },
    { label: "formal receipt boundary", mutate: (value) => { value.rawEvidence.receiptClaimBoundary = "formal-experiment-verified"; }, error: /bounded publishable receipt/u },
    { label: "zero candidate", mutate: (value) => { value.candidateCommit = "0".repeat(40); }, error: /non-zero/u },
    { label: "missing role", mutate: (value) => { value.files = value.files.filter((item: any) => item.role !== "license"); }, error: /missing required role/u },
  ];
  assert.equal(mutations.length >= 10, true);
  for (const mutation of mutations) {
    const changed = structuredClone(release);
    mutation.mutate(changed);
    assert.throws(
      () => validateVersionedArtifactRelease(changed),
      mutation.error,
      `${mutation.label} must be rejected`,
    );
  }
});

test("Artifact Release verifier 的 expectedCandidateCommit 输入本身也必须是非零规范 commit", async (context) => {
  const fixture = await releaseFixture(context, "expected-candidate-validation");
  await createVersionedArtifactRelease(releaseOptions(fixture));
  for (const expectedCandidateCommit of ["0".repeat(40), "A".repeat(40), "short", undefined]) {
    await assert.rejects(
      verifyVersionedArtifactRelease({
        outputRootDirectory: fixture.outputRoot,
        minimumReleaseVersion: "0.1.0",
        expectedCandidateCommit,
      } as any),
      /expectedCandidateCommit must be a lowercase non-zero 40-character commit hash/u,
    );
  }
});

test("Artifact Release 拒绝绝对/本机路径、Claim 越界、未审查状态与非递增版本", async (context) => {
  const absolute = await releaseFixture(context, "absolute");
  const absoluteFiles = RELEASE_FILES.map((item) => item.role === "source-snapshot" ? { ...item, path: "C:/Users/example/runtime.ts" } : item);
  await assert.rejects(createVersionedArtifactRelease({ ...releaseOptions(absolute), files: absoluteFiles }), /relative path/u);

  const claim = await releaseFixture(context, "claim-overreach");
  await assert.rejects(
    createVersionedArtifactRelease({ ...releaseOptions(claim), includedClaimIds: ["CLAIM-RQ1-001"] }),
    /not CodeVerified/u,
  );

  const version = await releaseFixture(context, "version");
  await assert.rejects(
    createVersionedArtifactRelease({ ...releaseOptions(version), releaseVersion: "0.1.0", previousReleaseVersion: "0.1.0" }),
    /must advance/u,
  );

  const valid = await releaseFixture(context, "state");
  const release = await createVersionedArtifactRelease(releaseOptions(valid));
  assert.throws(
    () => validateVersionedArtifactRelease({ ...release, review: { ...release.review, independentReview: true } }),
    /unreviewed or overclaimed/u,
  );
  assert.throws(
    () => validateVersionedArtifactRelease({ ...release, evidenceState: { ...release.evidenceState, formalExperiment: "Verified" } }),
    /overclaims/u,
  );
});

async function basicPersistentLedger(context: test.TestContext, suffix: string): Promise<string> {
  const root = await emptyTarget(context, `rt95-ledger-attack-${suffix}-`);
  let ledger = await initializePersistentRunLedger(
    root,
    createFormalRawLedger("PACKET-ATTACK-001", "4".repeat(64), "2026-08-24T10:00:00.000Z"),
    PLAN,
  );
  ledger = await appendPersistentRunLedgerEvent(root, PLAN, started("EVENT-ATTACK-START", "2026-08-24T10:01:00.000Z", 1));
  await appendPersistentRunLedgerEvent(root, PLAN, terminal("EVENT-ATTACK-RAW", "2026-08-24T10:02:00.000Z", 1, "failure", "retained-failure"));
  return root;
}

async function sanitizerFixture(context: test.TestContext, suffix: string): Promise<{
  privateRoot: string;
  publicRoot: string;
}> {
  const parent = await mkdtemp(path.join(tmpdir(), `rt95-sanitizer-${suffix}-`));
  context.after(async () => rm(parent, { recursive: true, force: true }));
  const privateRoot = path.join(parent, "private");
  const publicRoot = path.join(parent, "public");
  await mkdir(path.join(privateRoot, "tables"), { recursive: true });
  await writeFile(path.join(privateRoot, "report.json"), "{\"status\":\"local-only\"}\n", "utf8");
  await writeFile(path.join(privateRoot, "tables", "results.csv"), "case,result\n1,pass\n", "utf8");
  await writeFile(path.join(privateRoot, "helper-secret.bin"), Buffer.alloc(32, 7));
  await writeFile(path.join(privateRoot, "credentials.env"), "PRIVATE_VALUE=private-value\n", "utf8");
  return { privateRoot, publicRoot };
}

const RELEASE_FILES: ArtifactReleaseFileInput[] = [
  { path: "LICENSE", role: "license" },
  { path: "claims/CLAIM-TABLE.json", role: "claim-table" },
  { path: "dictionary/metric-dictionary.json", role: "data-dictionary" },
  { path: "manifest/artifact-manifest.json", role: "artifact-manifest" },
  { path: "preregistration/preregistration.draft.json", role: "preregistration" },
  { path: "raw/publishable-derivation-receipt.json", role: "raw-public-derivation-receipt" },
  { path: "src/runtime.ts", role: "source-snapshot" },
  { path: "raw/report.json", role: "statistics" },
  { path: "raw/summary.csv", role: "table" },
];

async function releaseFixture(context: test.TestContext, suffix: string): Promise<{
  sourceRoot: string;
  outputRoot: string;
}> {
  const parent = await mkdtemp(path.join(tmpdir(), `rt95-artifact-release-${suffix}-`));
  context.after(async () => rm(parent, { recursive: true, force: true }));
  const privateRoot = path.join(parent, "private");
  const sourceRoot = path.join(parent, "source");
  const outputRoot = path.join(parent, "release");
  for (const directory of [
    "claims", "dictionary", "manifest", "preregistration", "src", "statistics", "tables",
  ]) await mkdir(path.join(sourceRoot, directory), { recursive: true });
  await mkdir(privateRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, "LICENSE"), "Local tooling fixture license\n", "utf8");
  await writeFile(path.join(sourceRoot, "src", "runtime.ts"), "export const localTooling = true;\n", "utf8");
  await writeFile(path.join(sourceRoot, "preregistration", "preregistration.draft.json"), "{\"status\":\"Draft\"}\n", "utf8");
  await writeFile(path.join(sourceRoot, "dictionary", "metric-dictionary.json"), "{\"metric\":\"fixture-only\"}\n", "utf8");
  await writeFile(path.join(sourceRoot, "manifest", "artifact-manifest.json"), "{\"boundary\":\"local-tooling-only\"}\n", "utf8");
  await writeFile(path.join(sourceRoot, "claims", "CLAIM-TABLE.json"), `${JSON.stringify({ claims: [
    {
      id: "CLAIM-PIPELINE-LOCAL-001",
      evidenceState: "CodeVerified",
      allowedClaim: "The local release verifier is exercised by repository tests.",
      forbiddenClaim: "Formal or external evidence exists.",
      requiredEvidence: ["passing repository test"],
    },
    {
      id: "CLAIM-RQ1-001",
      evidenceState: "NotVerified",
      allowedClaim: "RQ1 remains unverified.",
      forbiddenClaim: "A formal result exists.",
      requiredEvidence: ["formal Raw"],
    },
  ] }, null, 2)}\n`, "utf8");
  await writeFile(path.join(privateRoot, "report.json"), "{\"status\":\"local-tooling-only\"}\n", "utf8");
  await writeFile(path.join(privateRoot, "summary.csv"), "case,result\nfixture,pass\n", "utf8");
  await writeFile(path.join(privateRoot, "helper-secret.bin"), Buffer.alloc(8, 3));
  await createPublishableDerivation({
    privateRootDirectory: privateRoot,
    publicRootDirectory: path.join(sourceRoot, "raw"),
    allowPaths: ["report.json", "summary.csv"],
  });
  return { sourceRoot, outputRoot };
}

function releaseOptions(fixture: { sourceRoot: string; outputRoot: string }) {
  return {
    sourceRootDirectory: fixture.sourceRoot,
    outputRootDirectory: fixture.outputRoot,
    releaseVersion: "0.1.0",
    previousReleaseVersion: null,
    candidateCommit: "5".repeat(40),
    files: RELEASE_FILES,
    includedClaimIds: ["CLAIM-PIPELINE-LOCAL-001"],
  } as const;
}

async function emptyTarget(context: test.TestContext, prefix: string): Promise<string> {
  const parent = await mkdtemp(path.join(tmpdir(), prefix));
  context.after(async () => rm(parent, { recursive: true, force: true }));
  return path.join(parent, "ledger");
}

function serializeCanonical(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function digestCanonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortKeys(value)), "utf8").digest("hex");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortKeys(record[key])]));
}

function started(eventId: string, occurredAt: string, attempt: number): AppendLedgerEventInput {
  return event(eventId, "case-started", occurredAt, { caseId: PLAN[0]!.caseId, attempt });
}

function rerun(eventId: string, occurredAt: string, attempt: number): AppendLedgerEventInput {
  return event(eventId, "rerun-authorized", occurredAt, {
    caseId: PLAN[0]!.caseId, attempt, reason: "preregistered-rerun-rule",
  });
}

function terminal(
  eventId: string,
  occurredAt: string,
  attempt: number,
  outcome: "success" | "failure" | "excluded" | "aborted",
  reason: string | null,
): AppendLedgerEventInput {
  return event(eventId, "case-recorded", occurredAt, {
    caseId: PLAN[0]!.caseId,
    attempt,
    outcome,
    artifactPath: `raw/attempt-${attempt}.json`,
    artifactSha256: ARTIFACT_SHA,
    reason,
  });
}

function event(
  eventId: string,
  eventType: AppendLedgerEventInput["eventType"],
  occurredAt: string,
  overrides: Partial<AppendLedgerEventInput> = {},
): AppendLedgerEventInput {
  return {
    eventId,
    eventType,
    occurredAt,
    caseId: overrides.caseId ?? null,
    attempt: overrides.attempt ?? null,
    outcome: overrides.outcome ?? null,
    artifactPath: overrides.artifactPath ?? null,
    artifactSha256: overrides.artifactSha256 ?? null,
    reason: overrides.reason ?? null,
  };
}
