import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface EvidenceSnapshot {
  schemaVersion: 1;
  capturedAt: string;
  candidate: { baseline: string; state: "uncommitted-local-worktree"; remoteVerified: false };
  testDiscovery: { formalFiles: number; coveredFiles: number; omitted: 0; stale: 0 };
  mainTests: { total: number; passed: number; skipped: number; failed: 0; skipBoundary: string };
  coverage: {
    sourceFiles: number;
    loadedFiles: number;
    lineCovered: number;
    lineTotal: number;
    linePercent: number;
    gateLinePercent: number;
    gateLoadedPercent: number;
  };
  processChaos: { passed: number; total: number };
  gate40: {
    candidate: 40;
    runnable: number;
    localPassed: number;
    localFailed: number;
    blocked: number;
    formalVerified: 0;
    complete: false;
    lifecycle: "candidate-not-frozen";
  };
  provider: { mode: "offline-deterministic-fake"; liveCalls: 0; credentialsRead: false };
  release: {
    localPassed: number;
    localTotal: number;
    localStatus: "READY" | "BLOCKED";
    productionStatus: "BLOCKED";
    auditCritical: number;
    auditHigh: number;
  };
  scores: {
    target: 95;
    engineering: number;
    interview: number;
    research: number;
    paper: number;
    production: number;
  };
  presentation: {
    slides: 7;
    renderedSlides: 7;
    overflowErrors: 0;
    sourceNotes: 7;
    qaMode: "separate-render-and-notes-qa";
  };
  rehearsal: RehearsalEvidence;
  claimBoundary: string[];
}

export interface RehearsalArtifact {
  kind: "recording" | "observer-attestation";
  path: string;
  sha256: string;
}

export interface RehearsalIssue {
  id: string;
  severity: "P0" | "P1" | "P2";
  status: "Open" | "Closed";
  retestArtifactSha256: string | null;
}

export interface RehearsalRecord {
  id: string;
  kind: "timed" | "non-author";
  status: "Run-Failed" | "Run-Conditional" | "Passed";
  performedAt: string;
  participant: string;
  participantRole: "author" | "non-author";
  observer: string;
  durationSeconds: number;
  candidateRef: string;
  challengeNonce: string;
  independent: boolean;
  authorInterventions: string;
  factsVerified: boolean;
  sensitiveDataCheck: "Passed" | "Failed";
  issues: RehearsalIssue[];
  artifacts: RehearsalArtifact[];
}

export interface RehearsalEvidence {
  timedCompleted: number;
  timedRequired: 3;
  nonAuthorCompleted: number;
  nonAuthorRequired: 1;
  status: "NotRun" | "InProgress" | "Passed";
  records: RehearsalRecord[];
}

export interface EvidenceConsistencyReport {
  snapshot: EvidenceSnapshot;
  checkedDocuments: string[];
}

const SCORE_KEYS = ["engineering", "interview", "research", "paper", "production"] as const;
const DEFAULT_DOCUMENTS = [
  "README.md",
  "docs/God-Agent-考研复试高频追问与回答.md",
  "docs/God-Agent-考研复试彩排验收表.md",
  "docs/God-Agent-AI辅助与原创边界声明.md",
  "docs/DEMO-复试三分钟演示.md",
  "docs/God-Agent-95plus持续精进总账.md",
  "docs/God-Agent-最新完整度最终裁决与95plus补足方案.md",
] as const;

export async function verifyEvidenceConsistency(
  workspaceRoot: string,
  snapshotPath = "docs/evidence/current-evidence.json",
  documents: readonly string[] = DEFAULT_DOCUMENTS,
): Promise<EvidenceConsistencyReport> {
  const root = resolve(workspaceRoot);
  const snapshotAbsolute = resolveInside(root, snapshotPath);
  const snapshot = parseEvidenceSnapshot(await readFile(snapshotAbsolute, "utf8"));
  validateSnapshot(snapshot);
  await verifyRehearsalArtifacts(root, snapshot.rehearsal.records);

  const expected = expectedDocumentTokens(snapshot);
  const scoreToken = `${snapshot.scores.engineering}/${snapshot.scores.interview}/${snapshot.scores.research}/${snapshot.scores.paper}/${snapshot.scores.production}`;
  const checkedDocuments: string[] = [];
  for (const path of documents) {
    const absolute = resolveInside(root, path);
    const normalized = normalizeEvidenceText(await readFile(absolute, "utf8"));
    const required = path.endsWith("God-Agent-95plus持续精进总账.md")
      || path.endsWith("God-Agent-最新完整度最终裁决与95plus补足方案.md")
      ? [...expected, scoreToken]
      : expected;
    const missing = required.filter((token) => !normalized.includes(normalizeEvidenceText(token)));
    if (missing.length > 0) {
      throw new Error(`Evidence drift in ${path}: missing ${missing.join(", ")}`);
    }
    checkedDocuments.push(path.replaceAll("\\", "/"));
  }
  return { snapshot, checkedDocuments };
}

export function parseEvidenceSnapshot(text: string): EvidenceSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Evidence snapshot is not valid JSON");
  }
  if (!isRecord(value)) throw new Error("Evidence snapshot root must be an object");
  return value as unknown as EvidenceSnapshot;
}

export function validateSnapshot(snapshot: EvidenceSnapshot): void {
  if (snapshot.schemaVersion !== 1) throw new Error("Unsupported evidence schemaVersion");
  if (!Number.isFinite(Date.parse(snapshot.capturedAt))) throw new Error("capturedAt must be an ISO date-time");
  if (snapshot.candidate?.state !== "uncommitted-local-worktree" || snapshot.candidate.remoteVerified !== false) {
    throw new Error("Candidate boundary must remain an uncommitted, non-remote-verified worktree");
  }
  assertExactKeys(snapshot as unknown as Record<string, unknown>, [
    "schemaVersion", "capturedAt", "candidate", "testDiscovery", "mainTests", "coverage",
    "processChaos", "gate40", "provider", "release", "scores", "presentation", "rehearsal", "claimBoundary",
  ], "snapshot");
  assertExactKeys(snapshot.candidate as unknown as Record<string, unknown>, ["baseline", "state", "remoteVerified"], "candidate");
  assertExactKeys(snapshot.testDiscovery as unknown as Record<string, unknown>, ["formalFiles", "coveredFiles", "omitted", "stale"], "testDiscovery");
  assertExactKeys(snapshot.mainTests as unknown as Record<string, unknown>, ["total", "passed", "skipped", "failed", "skipBoundary"], "mainTests");
  assertExactKeys(snapshot.coverage as unknown as Record<string, unknown>, [
    "sourceFiles", "loadedFiles", "lineCovered", "lineTotal", "linePercent", "gateLinePercent", "gateLoadedPercent",
  ], "coverage");
  assertExactKeys(snapshot.processChaos as unknown as Record<string, unknown>, ["passed", "total"], "processChaos");
  assertExactKeys(snapshot.gate40 as unknown as Record<string, unknown>, [
    "candidate", "runnable", "localPassed", "localFailed", "blocked", "formalVerified", "complete", "lifecycle",
  ], "gate40");
  assertExactKeys(snapshot.provider as unknown as Record<string, unknown>, ["mode", "liveCalls", "credentialsRead"], "provider");
  assertExactKeys(snapshot.release as unknown as Record<string, unknown>, [
    "localPassed", "localTotal", "localStatus", "productionStatus", "auditCritical", "auditHigh",
  ], "release");
  assertExactKeys(snapshot.scores as unknown as Record<string, unknown>, [
    "target", "engineering", "interview", "research", "paper", "production",
  ], "scores");
  assertExactKeys(snapshot.presentation as unknown as Record<string, unknown>, [
    "slides", "renderedSlides", "overflowErrors", "sourceNotes", "qaMode",
  ], "presentation");
  assertExactKeys(snapshot.rehearsal as unknown as Record<string, unknown>, [
    "timedCompleted", "timedRequired", "nonAuthorCompleted", "nonAuthorRequired", "status", "records",
  ], "rehearsal");

  const discovery = snapshot.testDiscovery;
  assertNonNegativeIntegers(discovery, ["formalFiles", "coveredFiles", "omitted", "stale"], "testDiscovery");
  if (discovery.formalFiles < 1 || discovery.coveredFiles !== discovery.formalFiles || discovery.omitted !== 0 || discovery.stale !== 0) {
    throw new Error("Test discovery must cover every formal file with zero omitted or stale entries");
  }

  const tests = snapshot.mainTests;
  assertNonNegativeIntegers(tests, ["total", "passed", "skipped", "failed"], "mainTests");
  if (tests.total !== tests.passed + tests.skipped + tests.failed || tests.failed !== 0 || tests.skipBoundary.trim().length === 0) {
    throw new Error("Main test arithmetic or skip boundary is invalid");
  }

  const coverage = snapshot.coverage;
  assertNonNegativeIntegers(coverage, ["sourceFiles", "loadedFiles", "lineCovered", "lineTotal"], "coverage");
  if (coverage.sourceFiles < 1 || coverage.lineTotal < 1 || coverage.loadedFiles > coverage.sourceFiles || coverage.lineCovered > coverage.lineTotal) {
    throw new Error("Coverage counts are invalid");
  }
  const computedLine = round4((coverage.lineCovered / coverage.lineTotal) * 100);
  if (Math.abs(computedLine - coverage.linePercent) > 0.0001) throw new Error("Coverage linePercent does not match counts");
  const computedLoaded = (coverage.loadedFiles / coverage.sourceFiles) * 100;
  if (coverage.linePercent < coverage.gateLinePercent || computedLoaded < coverage.gateLoadedPercent) {
    throw new Error("Coverage snapshot is below its declared gate");
  }

  if (snapshot.processChaos.passed !== snapshot.processChaos.total || snapshot.processChaos.total < 1) {
    throw new Error("Process Chaos specialty gate must be fully passing");
  }
  const gate = snapshot.gate40;
  assertNonNegativeIntegers(gate, ["candidate", "runnable", "localPassed", "localFailed", "blocked", "formalVerified"], "gate40");
  if (gate.candidate !== 40 || gate.runnable !== gate.localPassed + gate.localFailed || gate.candidate !== gate.runnable + gate.blocked) {
    throw new Error("GATE-40 candidate/runnable/blocked arithmetic is invalid");
  }
  if (gate.formalVerified !== 0 || gate.complete !== false || gate.lifecycle !== "candidate-not-frozen") {
    throw new Error("GATE-40 claim boundary was inflated beyond local pilot evidence");
  }
  if (snapshot.provider.mode !== "offline-deterministic-fake" || snapshot.provider.liveCalls !== 0 || snapshot.provider.credentialsRead !== false) {
    throw new Error("Provider claim boundary was inflated beyond offline evidence");
  }
  assertNonNegativeIntegers(snapshot.release, ["localPassed", "localTotal", "auditCritical", "auditHigh"], "release");
  if (snapshot.release.localTotal < 1 || snapshot.release.localPassed > snapshot.release.localTotal) {
    throw new Error("Release counts are invalid");
  }
  const expectedLocalStatus = snapshot.release.localPassed === snapshot.release.localTotal ? "READY" : "BLOCKED";
  if (snapshot.release.localStatus !== expectedLocalStatus || snapshot.release.productionStatus !== "BLOCKED") {
    throw new Error("Release status must match local gates and must not be promoted to production readiness");
  }
  if (snapshot.scores.target !== 95) throw new Error("The score target must remain 95");
  for (const key of SCORE_KEYS) {
    const value = snapshot.scores[key];
    if (!Number.isInteger(value) || value < 0 || value >= snapshot.scores.target) {
      throw new Error(`Score ${key} cannot claim 95+ before the evidence contract changes`);
    }
  }
  if (snapshot.presentation.slides !== 7 || snapshot.presentation.renderedSlides !== 7
    || snapshot.presentation.overflowErrors !== 0 || snapshot.presentation.sourceNotes !== 7
    || snapshot.presentation.qaMode !== "separate-render-and-notes-qa") {
    throw new Error("Presentation evidence must come from separate seven-slide render and notes QA");
  }
  validateRehearsal(snapshot.rehearsal, snapshot.candidate.baseline, snapshot.capturedAt);
  if (!Array.isArray(snapshot.claimBoundary) || snapshot.claimBoundary.length < 5
    || snapshot.claimBoundary.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error("At least five explicit claim boundaries are required");
  }
}

function validateRehearsal(rehearsal: RehearsalEvidence, candidateRef: string, capturedAt: string): void {
  assertNonNegativeIntegers(rehearsal, ["timedCompleted", "timedRequired", "nonAuthorCompleted", "nonAuthorRequired"], "rehearsal");
  if (rehearsal.timedRequired !== 3 || rehearsal.nonAuthorRequired !== 1
    || rehearsal.timedCompleted > rehearsal.timedRequired
    || rehearsal.nonAuthorCompleted > rehearsal.nonAuthorRequired) {
    throw new Error("Rehearsal required/completed counts are invalid");
  }
  if (!Array.isArray(rehearsal.records)) throw new Error("rehearsal.records must be an array");

  const ids = new Set<string>();
  const nonces = new Set<string>();
  const passedArtifactPaths = new Set<string>();
  const passedArtifactDigests = new Set<string>();
  for (const [index, record] of rehearsal.records.entries()) {
    assertExactKeys(record as unknown as Record<string, unknown>, [
      "id", "kind", "status", "performedAt", "participant", "participantRole", "observer", "durationSeconds",
      "candidateRef", "challengeNonce", "independent", "authorInterventions", "factsVerified",
      "sensitiveDataCheck", "issues", "artifacts",
    ], `rehearsal.records[${index}]`);
    if (typeof record.id !== "string" || record.id.trim().length === 0 || ids.has(record.id)) {
      throw new Error("Rehearsal record IDs must be non-empty and unique");
    }
    ids.add(record.id);
    if (record.kind !== "timed" && record.kind !== "non-author") throw new Error("Rehearsal record kind is invalid");
    if (!(["Run-Failed", "Run-Conditional", "Passed"] as const).includes(record.status)) {
      throw new Error("Rehearsal record status is invalid");
    }
    const performedAt = Date.parse(record.performedAt);
    if (!Number.isFinite(performedAt)) throw new Error("Rehearsal performedAt must be an ISO date-time");
    if (performedAt > Date.parse(capturedAt)) throw new Error("Rehearsal performedAt cannot be later than capturedAt");
    for (const [key, value] of [["participant", record.participant], ["observer", record.observer], ["candidateRef", record.candidateRef]] as const) {
      if (typeof value !== "string" || value.trim().length === 0) throw new Error(`Rehearsal ${key} must be non-empty`);
    }
    if (!Number.isInteger(record.durationSeconds) || record.durationSeconds < 1) throw new Error("Rehearsal durationSeconds must be positive");
    if (record.participant === record.observer) throw new Error("Rehearsal participant and observer must be distinct");
    if (record.status === "Passed" && (record.durationSeconds < 165 || record.durationSeconds > 190)) {
      throw new Error("Every Passed rehearsal must stay within 2:45-3:10");
    }
    if (record.candidateRef !== candidateRef) throw new Error("Rehearsal candidateRef must match the evidence candidate baseline");
    if (!/^[a-f0-9]{32}$/u.test(record.challengeNonce) || nonces.has(record.challengeNonce)) {
      throw new Error("Rehearsal challengeNonce must be unique lowercase hexadecimal");
    }
    nonces.add(record.challengeNonce);
    if (record.kind === "non-author" && (record.participantRole !== "non-author" || record.independent !== true
      || record.participant.trim().toLowerCase().includes("project author")
      || record.authorInterventions.trim().toLowerCase() !== "none")) {
      throw new Error("Non-author rehearsal requires a distinct declared non-author with no author intervention");
    }
    if (record.kind === "timed" && record.participantRole !== "author") throw new Error("Timed rehearsal participantRole must be author");
    if (typeof record.authorInterventions !== "string") throw new Error("Rehearsal authorInterventions must be disclosed");
    if (!Array.isArray(record.issues)) throw new Error("Rehearsal issues must be an array");
    const issueIds = new Set<string>();
    for (const issue of record.issues) {
      assertExactKeys(issue as unknown as Record<string, unknown>, ["id", "severity", "status", "retestArtifactSha256"], "rehearsal issue");
      if (!nonBlank(issue.id) || issueIds.has(issue.id) || !(["P0", "P1", "P2"] as const).includes(issue.severity)
        || !(["Open", "Closed"] as const).includes(issue.status)
        || !(issue.retestArtifactSha256 === null || typeof issue.retestArtifactSha256 === "string" && /^[a-f0-9]{64}$/u.test(issue.retestArtifactSha256))) {
        throw new Error("Rehearsal issue is invalid");
      }
      issueIds.add(issue.id);
      if (issue.status === "Closed" && issue.retestArtifactSha256 === null) throw new Error("Closed rehearsal issue requires retest evidence");
    }
    if (!Array.isArray(record.artifacts) || record.artifacts.length < 2) throw new Error("Every rehearsal record requires recording and observer attestation artifacts");
    const artifactKinds = new Set(record.artifacts.map((artifact) => artifact.kind));
    if (artifactKinds.size !== 2 || !artifactKinds.has("recording") || !artifactKinds.has("observer-attestation")) {
      throw new Error("Rehearsal artifacts must include recording and observer-attestation");
    }
    for (const artifact of record.artifacts) {
      assertExactKeys(artifact as unknown as Record<string, unknown>, ["kind", "path", "sha256"], "rehearsal artifact");
      const normalizedPath = typeof artifact.path === "string" ? posix.normalize(artifact.path.replaceAll("\\", "/")) : "";
      if ((artifact.kind !== "recording" && artifact.kind !== "observer-attestation")
        || normalizedPath !== artifact.path || artifact.path.trim().length === 0 || isAbsolute(artifact.path)
        || !artifact.path.startsWith(`docs/evidence/rehearsals/${record.id}/`)) {
        throw new Error("Rehearsal artifact path must be workspace-relative");
      }
      if (typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(artifact.sha256)) {
        throw new Error("Rehearsal artifact sha256 must be lowercase hexadecimal");
      }
      if (record.status === "Passed" && (!passedArtifactPaths.add(artifact.path) || !passedArtifactDigests.add(artifact.sha256))) {
        throw new Error("Passed rehearsal artifacts cannot be reused across records");
      }
    }
    const recordArtifactDigests = new Set(record.artifacts.map((artifact) => artifact.sha256));
    if (record.issues.some((issue) => issue.status === "Closed" && !recordArtifactDigests.has(issue.retestArtifactSha256!))) {
      throw new Error("Closed rehearsal issue retest evidence must belong to the same record");
    }
    const blockingOpen = record.issues.filter((issue) => issue.status === "Open" && (issue.severity === "P0" || issue.severity === "P1"));
    if (record.status === "Passed" && (record.factsVerified !== true || record.sensitiveDataCheck !== "Passed"
      || blockingOpen.length !== 0)) {
      throw new Error("Passed rehearsal requires verified facts, privacy pass and zero open P0/P1");
    }
  }

  const timedPassed = rehearsal.records.filter((record) => record.kind === "timed" && record.status === "Passed").length;
  const nonAuthorPassed = rehearsal.records.filter((record) => record.kind === "non-author" && record.status === "Passed").length;
  if (rehearsal.timedCompleted !== timedPassed || rehearsal.nonAuthorCompleted !== nonAuthorPassed) {
    throw new Error("Rehearsal completed counts must be derived from Passed records");
  }
  const expectedStatus = timedPassed === 0 && nonAuthorPassed === 0 && rehearsal.records.length === 0
    ? "NotRun"
    : timedPassed === rehearsal.timedRequired && nonAuthorPassed === rehearsal.nonAuthorRequired
      ? "Passed"
      : "InProgress";
  if (rehearsal.status !== expectedStatus) throw new Error(`Rehearsal status must be ${expectedStatus}`);
}

async function verifyRehearsalArtifacts(root: string, records: readonly RehearsalRecord[]): Promise<void> {
  const rootReal = await realpath(root);
  for (const record of records) {
    for (const artifact of record.artifacts) {
      const absolute = resolveInside(root, artifact.path);
      let bytes: Buffer;
      try {
        const before = await lstat(absolute);
        if (!before.isFile() || before.isSymbolicLink()) throw new Error("not a regular file");
        const physical = await realpath(absolute);
        const physicalRelative = relative(rootReal, physical);
        if (physicalRelative === "" || physicalRelative === ".." || physicalRelative.startsWith(`..${sep}`) || isAbsolute(physicalRelative)) {
          throw new Error("physical path escapes workspace");
        }
        bytes = await readFile(absolute);
        const after = await lstat(absolute);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("artifact changed while verifying");
      } catch {
        throw new Error(`Rehearsal artifact is missing or unsafe: ${artifact.path}`);
      }
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== artifact.sha256) throw new Error(`Rehearsal artifact digest mismatch: ${artifact.path}`);
      if (artifact.kind === "recording" && bytes.length === 0) throw new Error(`Rehearsal recording is empty: ${artifact.path}`);
      if (artifact.kind === "observer-attestation") verifyObserverAttestation(bytes, record);
    }
  }
}

function verifyObserverAttestation(bytes: Buffer, record: RehearsalRecord): void {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`Observer attestation is not valid JSON for ${record.id}`);
  }
  if (!isRecord(value)) throw new Error(`Observer attestation must be an object for ${record.id}`);
  assertExactKeys(value, [
    "schemaVersion", "recordId", "challengeNonce", "candidateRef", "performedAt", "participant", "observer",
    "authorInterventions", "confirmation",
  ], "observer attestation");
  if (value.schemaVersion !== "god-agent-rehearsal-attestation-v1" || value.recordId !== record.id
    || value.challengeNonce !== record.challengeNonce || value.candidateRef !== record.candidateRef
    || value.performedAt !== record.performedAt || value.participant !== record.participant || value.observer !== record.observer
    || value.authorInterventions !== record.authorInterventions || value.confirmation !== "observed-in-person-or-live") {
    throw new Error(`Observer attestation does not bind rehearsal record ${record.id}`);
  }
}

export function expectedDocumentTokens(snapshot: EvidenceSnapshot): string[] {
  return [
    `${snapshot.testDiscovery.coveredFiles}/${snapshot.testDiscovery.formalFiles}`,
    `${snapshot.mainTests.total}`,
    `${snapshot.mainTests.passed}pass`,
    `${snapshot.mainTests.skipped}`,
    `${snapshot.mainTests.failed}fail`,
    `${snapshot.coverage.lineCovered}/${snapshot.coverage.lineTotal}`,
    `${snapshot.coverage.linePercent}%`,
    `${snapshot.coverage.loadedFiles}/${snapshot.coverage.sourceFiles}`,
    `${snapshot.processChaos.passed}/${snapshot.processChaos.total}`,
    `${snapshot.gate40.localPassed}passed`,
    `${snapshot.gate40.blocked}blocked`,
    `formalverified${snapshot.gate40.formalVerified}`,
    `livecalls=${snapshot.provider.liveCalls}`,
    `${snapshot.release.localPassed}/${snapshot.release.localTotal}`,
    `${snapshot.release.auditHigh}high`,
  ];
}

function normalizeEvidenceText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replaceAll(",", "").replaceAll("=", "").replaceAll("个", "").replace(/\s+/gu, "");
}

function resolveInside(root: string, path: string): string {
  if (isAbsolute(path)) throw new Error(`Evidence path must be workspace-relative: ${path}`);
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Unsafe evidence path: ${path}`);
  }
  return absolute;
}

function assertExactKeys(value: unknown, expected: readonly string[], label: string): void {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains missing or unknown fields`);
  }
}

function assertNonNegativeIntegers(value: unknown, keys: readonly string[], label: string): void {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  for (const key of keys) {
    if (!Number.isInteger(value[key]) || (value[key] as number) < 0) throw new Error(`${label}.${key} must be a non-negative integer`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

async function main(): Promise<void> {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const report = await verifyEvidenceConsistency(root);
  process.stdout.write(`Evidence consistency verified: ${report.checkedDocuments.length} documents; schema v${report.snapshot.schemaVersion}.\n`);
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) await main();
