import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  expectedDocumentTokens,
  parseEvidenceSnapshot,
  validateSnapshot,
  verifyEvidenceConsistency,
  type EvidenceSnapshot,
} from "../scripts/verify-evidence-consistency.js";

test("accepts a strict local evidence snapshot and matching documents", async () => {
  const root = await mkdtemp(join(tmpdir(), "god-evidence-"));
  try {
    const snapshot = validSnapshot();
    await mkdir(join(root, "docs", "evidence"), { recursive: true });
    await writeFile(join(root, "docs", "evidence", "current-evidence.json"), JSON.stringify(snapshot), "utf8");
    const document = expectedDocumentTokens(snapshot).join("\n");
    await writeFile(join(root, "README.md"), document, "utf8");
    const report = await verifyEvidenceConsistency(root, "docs/evidence/current-evidence.json", ["README.md"]);
    assert.deepEqual(report.checkedDocuments, ["README.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects invalid JSON and unknown root fields", () => {
  assert.throws(() => parseEvidenceSnapshot("{"), /not valid JSON/u);
  const snapshot = { ...validSnapshot(), inventedClaim: true };
  assert.throws(() => validateSnapshot(snapshot as unknown as EvidenceSnapshot), /missing or unknown fields/u);
  const nested = structuredClone(validSnapshot()) as unknown as Record<string, any>;
  nested.provider.inventedLiveProof = true;
  assert.throws(() => validateSnapshot(nested as unknown as EvidenceSnapshot), /provider contains missing or unknown fields/u);
});

test("rejects arithmetic drift in tests, coverage and GATE-40", () => {
  const tests = structuredClone(validSnapshot());
  tests.mainTests.total += 1;
  assert.throws(() => validateSnapshot(tests), /Main test arithmetic/u);

  const coverage = structuredClone(validSnapshot());
  coverage.coverage.linePercent = 99;
  assert.throws(() => validateSnapshot(coverage), /does not match counts/u);

  const gate = structuredClone(validSnapshot());
  gate.gate40.blocked -= 1;
  assert.throws(() => validateSnapshot(gate), /arithmetic/u);
});

test("rejects inflated formal, Provider, production and rehearsal claims", () => {
  const formal = structuredClone(validSnapshot()) as unknown as Record<string, any>;
  formal.gate40.formalVerified = 40;
  formal.gate40.complete = true;
  assert.throws(() => validateSnapshot(formal as unknown as EvidenceSnapshot), /inflated/u);

  const provider = structuredClone(validSnapshot()) as unknown as Record<string, any>;
  provider.provider.liveCalls = 1;
  assert.throws(() => validateSnapshot(provider as unknown as EvidenceSnapshot), /Provider claim boundary/u);

  const release = structuredClone(validSnapshot()) as unknown as Record<string, any>;
  release.release.productionStatus = "READY";
  assert.throws(() => validateSnapshot(release as unknown as EvidenceSnapshot), /production readiness/u);

  const rehearsal = structuredClone(validSnapshot()) as unknown as Record<string, any>;
  rehearsal.rehearsal.timedCompleted = 3;
  assert.throws(() => validateSnapshot(rehearsal as unknown as EvidenceSnapshot), /derived from Passed records/u);
});

test("accepts completed rehearsal counts only from digest-bound Passed records", async () => {
  const root = await mkdtemp(join(tmpdir(), "god-rehearsal-evidence-"));
  try {
    const snapshot = validSnapshot();
    const records = [];
    const specs = [
      ["timed-1", "timed", 170],
      ["timed-2", "timed", 180],
      ["timed-3", "timed", 190],
      ["non-author-1", "non-author", 180],
    ] as const;
    for (const [id, kind, duration] of specs) records.push(await writeRehearsalRecord(root, id, kind, duration));
    snapshot.rehearsal = {
      timedCompleted: 3,
      timedRequired: 3,
      nonAuthorCompleted: 1,
      nonAuthorRequired: 1,
      status: "Passed",
      records,
    };
    await mkdir(join(root, "docs", "evidence"), { recursive: true });
    await writeFile(join(root, "docs", "evidence", "current-evidence.json"), JSON.stringify(snapshot), "utf8");
    await writeFile(join(root, "README.md"), expectedDocumentTokens(snapshot).join("\n"), "utf8");
    const report = await verifyEvidenceConsistency(root, "docs/evidence/current-evidence.json", ["README.md"]);
    assert.equal(report.snapshot.rehearsal.status, "Passed");

    snapshot.rehearsal.records[0]!.artifacts[0]!.sha256 = "0".repeat(64);
    await writeFile(join(root, "docs", "evidence", "current-evidence.json"), JSON.stringify(snapshot), "utf8");
    await assert.rejects(
      verifyEvidenceConsistency(root, "docs/evidence/current-evidence.json", ["README.md"]),
      /digest mismatch/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects rehearsal replay, identity contradictions, stale candidate and future claims", async () => {
  const root = await mkdtemp(join(tmpdir(), "god-rehearsal-attacks-"));
  try {
    const base = validSnapshot();
    base.rehearsal = {
      timedCompleted: 3,
      timedRequired: 3,
      nonAuthorCompleted: 1,
      nonAuthorRequired: 1,
      status: "Passed",
      records: [
        await writeRehearsalRecord(root, "timed-1", "timed", 170),
        await writeRehearsalRecord(root, "timed-2", "timed", 180),
        await writeRehearsalRecord(root, "timed-3", "timed", 190),
        await writeRehearsalRecord(root, "non-author-1", "non-author", 180),
      ],
    };
    validateSnapshot(base);

    const replay = structuredClone(base);
    replay.rehearsal.records[1]!.artifacts = structuredClone(replay.rehearsal.records[0]!.artifacts);
    assert.throws(() => validateSnapshot(replay), /workspace-relative|cannot be reused/u);

    const authorAsNonAuthor = structuredClone(base);
    authorAsNonAuthor.rehearsal.records[3]!.participant = "project author";
    assert.throws(() => validateSnapshot(authorAsNonAuthor), /declared non-author/u);

    const selfObserved = structuredClone(base);
    selfObserved.rehearsal.records[0]!.observer = selfObserved.rehearsal.records[0]!.participant;
    assert.throws(() => validateSnapshot(selfObserved), /must be distinct/u);

    const oneSecond = structuredClone(base);
    oneSecond.rehearsal.records[3]!.durationSeconds = 1;
    assert.throws(() => validateSnapshot(oneSecond), /2:45-3:10/u);

    const staleCandidate = structuredClone(base);
    staleCandidate.rehearsal.records[0]!.candidateRef = "main@old";
    assert.throws(() => validateSnapshot(staleCandidate), /candidate baseline/u);

    const future = structuredClone(base);
    future.rehearsal.records[0]!.performedAt = "2099-01-01T00:00:00Z";
    assert.throws(() => validateSnapshot(future), /later than capturedAt/u);

    const foreignRetest = structuredClone(base);
    foreignRetest.rehearsal.records[0]!.issues = [{
      id: "R1-P0",
      severity: "P0",
      status: "Closed",
      retestArtifactSha256: "f".repeat(64),
    }];
    assert.throws(() => validateSnapshot(foreignRetest), /same record/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects rehearsal artifact symlink escape when the platform permits creating one", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "god-rehearsal-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "god-rehearsal-outside-"));
  try {
    const snapshot = validSnapshot();
    const record = await writeRehearsalRecord(root, "timed-1", "timed", 170);
    snapshot.rehearsal = {
      timedCompleted: 1,
      timedRequired: 3,
      nonAuthorCompleted: 0,
      nonAuthorRequired: 1,
      status: "InProgress",
      records: [record],
    };
    const outsideFile = join(outside, "outside.txt");
    await writeFile(outsideFile, "outside bytes", "utf8");
    const recordingPath = join(root, "docs", "evidence", "rehearsals", "timed-1", "recording.txt");
    await rm(recordingPath, { force: true });
    try {
      await symlink(outsideFile, recordingPath, "file");
    } catch (error) {
      if (isPrivilegeError(error)) {
        t.skip("Windows symlink privilege is unavailable");
        return;
      }
      throw error;
    }
    record.artifacts[0]!.sha256 = createHash("sha256").update("outside bytes").digest("hex");
    await mkdir(join(root, "docs", "evidence"), { recursive: true });
    await writeFile(join(root, "docs", "evidence", "current-evidence.json"), JSON.stringify(snapshot), "utf8");
    await writeFile(join(root, "README.md"), expectedDocumentTokens(snapshot).join("\n"), "utf8");
    await assert.rejects(
      verifyEvidenceConsistency(root, "docs/evidence/current-evidence.json", ["README.md"]),
      /missing or unsafe/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("rejects document drift and paths outside the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "god-evidence-"));
  try {
    const snapshot = validSnapshot();
    await mkdir(join(root, "docs", "evidence"), { recursive: true });
    await writeFile(join(root, "docs", "evidence", "current-evidence.json"), JSON.stringify(snapshot), "utf8");
    await writeFile(join(root, "README.md"), "stale evidence", "utf8");
    await assert.rejects(
      verifyEvidenceConsistency(root, "docs/evidence/current-evidence.json", ["README.md"]),
      /Evidence drift/u,
    );
    await assert.rejects(
      verifyEvidenceConsistency(root, "../outside.json", ["README.md"]),
      /Unsafe evidence path/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function validSnapshot(): EvidenceSnapshot {
  return {
    schemaVersion: 1,
    capturedAt: "2026-08-24T14:15:00+08:00",
    candidate: { baseline: "main@example", state: "uncommitted-local-worktree", remoteVerified: false },
    testDiscovery: { formalFiles: 106, coveredFiles: 106, omitted: 0, stale: 0 },
    mainTests: { total: 658, passed: 657, skipped: 1, failed: 0, skipBoundary: "conditional symlink privilege" },
    coverage: {
      sourceFiles: 119,
      loadedFiles: 111,
      lineCovered: 24425,
      lineTotal: 26908,
      linePercent: 90.7723,
      gateLinePercent: 90.25,
      gateLoadedPercent: 93,
    },
    processChaos: { passed: 12, total: 12 },
    gate40: {
      candidate: 40,
      runnable: 25,
      localPassed: 25,
      localFailed: 0,
      blocked: 15,
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
}

async function writeRehearsalRecord(root: string, id: string, kind: "timed" | "non-author", durationSeconds: number) {
  const challengeNonce = createHash("md5").update(id).digest("hex");
  const participant = kind === "non-author" ? "independent candidate" : "project author";
  const observer = `independent observer ${id}`;
  const performedAt = "2026-08-24T14:00:00+08:00";
  const authorInterventions = "none";
  const directory = join(root, "docs", "evidence", "rehearsals", id);
  await mkdir(directory, { recursive: true });
  const recording = Buffer.from(`recording ${id} ${challengeNonce}\n`, "utf8");
  const attestation = Buffer.from(JSON.stringify({
    schemaVersion: "god-agent-rehearsal-attestation-v1",
    recordId: id,
    challengeNonce,
    candidateRef: "main@example",
    performedAt,
    participant,
    observer,
    authorInterventions,
    confirmation: "observed-in-person-or-live",
  }), "utf8");
  await writeFile(join(directory, "recording.txt"), recording);
  await writeFile(join(directory, "observer-attestation.json"), attestation);
  return {
    id,
    kind,
    status: "Passed" as const,
    performedAt,
    participant,
    participantRole: kind === "non-author" ? "non-author" as const : "author" as const,
    observer,
    durationSeconds,
    candidateRef: "main@example",
    challengeNonce,
    independent: kind === "non-author",
    authorInterventions,
    factsVerified: true,
    sensitiveDataCheck: "Passed" as const,
    issues: [],
    artifacts: [
      { kind: "recording" as const, path: `docs/evidence/rehearsals/${id}/recording.txt`, sha256: createHash("sha256").update(recording).digest("hex") },
      { kind: "observer-attestation" as const, path: `docs/evidence/rehearsals/${id}/observer-attestation.json`, sha256: createHash("sha256").update(attestation).digest("hex") },
    ],
  };
}

function isPrivilegeError(error: unknown): boolean {
  return error instanceof Error && "code" in error
    && (error.code === "EPERM" || error.code === "EACCES" || error.code === "UNKNOWN");
}
