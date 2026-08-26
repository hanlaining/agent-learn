import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

/**
 * Fail-closed audit for the evidence package needed for a real 90+ score.
 * This tool only inspects an already-produced package. It never creates Raw,
 * changes a Claim status, contacts a Provider, or edits current-evidence.json.
 */
const SCHEMA = "rt95-evidence-90-manifest-v1";
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const SAFE_STATUS = new Set(["NotVerified", "Completed-Unreviewed", "Verified"]);

type FileRef = { path: string; sha256: string };
type Manifest = {
  schemaVersion: string;
  candidate: { commit: string; sourceTreeSha256: string; preregistrationSha256: string; casePlanSha256: string; createdAt: string };
  roles: { producerId: string; reviewerId: string };
  formalProvider: { status: string; authorization: FileRef; rawLedger: FileRef; receipt: FileRef };
  externalBaseline: { status: string; protocol: FileRef; rawResults: FileRef; provenance: FileRef };
  independentReproduction: { status: string; executorId: string; environment: FileRef; report: FileRef };
  artifactChain: { raw: FileRef; derived: FileRef; statistics: FileRef; tables: FileRef; figures: FileRef; manifest: FileRef };
  claimMatrix: FileRef;
  publicationReview: { status: string; report: FileRef };
};

type Finding = { area: string; points: number; maxPoints: number; status: "PASS" | "BLOCKED"; reasons: string[] };

const HANDLE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/u;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log("Usage: npx tsx research/rt95-closure/src/evidence-90-gate.ts --root <evidence-package> [--manifest <relative-path>] [--json]");
    return;
  }
  const rootArg = valueAfter(args, "--root");
  if (!rootArg) throw new Error("--root is required");
  const root = resolve(rootArg);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`evidence root is not a directory: ${root}`);
  const manifestPath = valueAfter(args, "--manifest") ?? "evidence-manifest.json";
  const manifestAbs = resolve(root, manifestPath);
  if (!isInside(root, manifestAbs) || !existsSync(manifestAbs)) throw new Error("manifest must exist inside --root");
  const manifest = parseManifest(JSON.parse(readFileSync(manifestAbs, "utf8")));
  const findings = audit(manifest, root);
  const total = findings.reduce((sum, item) => sum + item.points, 0);
  const max = findings.reduce((sum, item) => sum + item.maxPoints, 0);
  const blockers = findings.flatMap((item) => item.reasons.map((reason) => `${item.area}: ${reason}`));
  const result = { schemaVersion: SCHEMA, score: total, maxScore: max, percent: Number(((total / max) * 100).toFixed(2)), status: total >= 90 && blockers.length === 0 ? "READY_FOR_90_REVIEW" : "BLOCKED", findings, blockers };
  if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`evidence-90 score=${result.percent}/100 status=${result.status}`);
    for (const finding of findings) console.log(`${finding.status.padEnd(7)} ${finding.area}: ${finding.points}/${finding.maxPoints}${finding.reasons.length ? ` (${finding.reasons.join("; ")})` : ""}`);
  }
  if (result.status !== "READY_FOR_90_REVIEW") process.exitCode = 2;
}

function audit(manifest: Manifest, root: string): Finding[] {
  const file = (ref: FileRef, label: string): string[] => {
    const reasons: string[] = [];
    if (!isFileRef(ref)) reasons.push(`${label} must contain a relative path and a 64-hex SHA-256`);
    if (!isSafeRelative(ref.path)) reasons.push(`${label} path is not safe relative POSIX path`);
    const abs = resolve(root, ref.path);
    if (!isInside(root, abs)) reasons.push(`${label} escapes evidence root`);
    else if (!existsSync(abs) || !statSync(abs).isFile()) reasons.push(`${label} is missing`);
    else if (lstatSync(abs).isSymbolicLink()) reasons.push(`${label} must not be a symbolic link`);
    else {
      try {
        if (!isInside(realpathSync(root), realpathSync(abs))) reasons.push(`${label} resolves outside evidence root`);
        else if (sha256File(abs) !== ref.sha256) reasons.push(`${label} SHA-256 mismatch`);
      } catch {
        reasons.push(`${label} could not be resolved as a regular file`);
      }
    }
    return reasons;
  };
  const status = (value: string, label: string): string[] => SAFE_STATUS.has(value) ? [] : [`${label} has invalid status ${value}`];
  const section = (area: string, points: number, checks: string[][]): Finding => {
    const reasons = checks.flat();
    return { area, points: reasons.length === 0 ? points : 0, maxPoints: points, status: reasons.length === 0 ? "PASS" : "BLOCKED", reasons };
  };
  const provider = manifest.formalProvider;
  const baseline = manifest.externalBaseline;
  const reproduction = manifest.independentReproduction;
  const chain = manifest.artifactChain;
  const allRefs: Array<[FileRef, string]> = [
    [provider.authorization, "authorization"], [provider.rawLedger, "formal Raw ledger"], [provider.receipt, "Provider receipt"],
    [baseline.protocol, "baseline protocol"], [baseline.rawResults, "baseline Raw"], [baseline.provenance, "baseline provenance"],
    [reproduction.environment, "reproduction environment"], [reproduction.report, "reproduction report"],
    [chain.raw, "chain.raw"], [chain.derived, "chain.derived"], [chain.statistics, "chain.statistics"], [chain.tables, "chain.tables"], [chain.figures, "chain.figures"], [chain.manifest, "chain.manifest"],
    [manifest.claimMatrix, "claim matrix"], [manifest.publicationReview.report, "publication review report"],
  ];
  const duplicatePaths = new Map<string, string[]>();
  for (const [ref, label] of allRefs) {
    if (isFileRef(ref)) {
      const key = process.platform === "win32" ? ref.path.toLowerCase() : ref.path;
      duplicatePaths.set(key, [...(duplicatePaths.get(key) ?? []), label]);
    }
  }
  const duplicateReasons = [...duplicatePaths.entries()]
    .filter(([, labels]) => labels.length > 1)
    .map(([path, labels]) => `file reference ${path} is reused by ${labels.join(", ")}`);
  return [
    section("Candidate binding", 0, [
      !UTC_TIMESTAMP.test(manifest.candidate.createdAt) ? ["candidate.createdAt must be RFC3339 UTC and end with Z"] : [],
      (() => {
        const date = Date.parse(manifest.candidate.createdAt);
        const normalized = /\.\d{3}Z$/u.test(manifest.candidate.createdAt)
          ? manifest.candidate.createdAt
          : manifest.candidate.createdAt.replace(/Z$/u, ".000Z");
        return !Number.isFinite(date) || new Date(date).toISOString() !== normalized ? ["candidate.createdAt is not a canonical UTC timestamp"] : [];
      })(),
      ["producerId and reviewerId must be stable non-secret handles"].filter(() => !HANDLE.test(manifest.roles.producerId) || !HANDLE.test(manifest.roles.reviewerId)),
      ["executorId must be a stable non-secret handle"].filter(() => !HANDLE.test(reproduction.executorId)),
      ["reviewer and producer must be different identities"].filter(() => manifest.roles.reviewerId === manifest.roles.producerId),
      duplicateReasons,
    ]),
    section("Formal Provider + Raw", 30, [status(provider.status, "formalProvider"), ...(provider.status === "Verified" ? [file(provider.authorization, "authorization"), file(provider.rawLedger, "formal Raw ledger"), file(provider.receipt, "Provider receipt")] : [["formal Provider is not Verified"]])]),
    section("External baseline", 20, [status(baseline.status, "externalBaseline"), ...(baseline.status === "Verified" ? [file(baseline.protocol, "baseline protocol"), file(baseline.rawResults, "baseline Raw"), file(baseline.provenance, "baseline provenance")] : [["external baseline is not Verified"]])]),
    section("Independent reproduction", 20, [status(reproduction.status, "independentReproduction"), reproduction.executorId === manifest.roles.producerId ? ["independent executor must differ from producer"] : [], ...(reproduction.status === "Verified" ? [file(reproduction.environment, "reproduction environment"), file(reproduction.report, "reproduction report")] : [["independent reproduction is not Verified"]])]),
    section("Raw → derived → statistics → tables/figures", 15, [file(chain.raw, "chain.raw"), file(chain.derived, "chain.derived"), file(chain.statistics, "chain.statistics"), file(chain.tables, "chain.tables"), file(chain.figures, "chain.figures"), file(chain.manifest, "chain.manifest")]),
    section("Claim matrix closure", 10, [file(manifest.claimMatrix, "claim matrix")]),
    section("Non-author publication review", 5, [status(manifest.publicationReview.status, "publicationReview"), manifest.roles.reviewerId === manifest.roles.producerId ? ["reviewer must differ from producer"] : [], ...(manifest.publicationReview.status === "Verified" ? [file(manifest.publicationReview.report, "publication review report")] : [["publication review is not Verified"]])]),
  ];
}

function parseManifest(value: unknown): Manifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("manifest must be an object");
  const manifest = value as Manifest;
  if (manifest.schemaVersion !== SCHEMA) throw new Error(`manifest.schemaVersion must be ${SCHEMA}`);
  if (!manifest.candidate || typeof manifest.candidate !== "object") throw new Error("candidate is required");
  if (!manifest.roles || typeof manifest.roles !== "object") throw new Error("roles is required");
  for (const key of ["formalProvider", "externalBaseline", "independentReproduction", "artifactChain", "publicationReview"] as const) {
    if (!manifest[key] || typeof manifest[key] !== "object") throw new Error(`${key} is required`);
  }
  if (!manifest.claimMatrix || typeof manifest.claimMatrix !== "object") throw new Error("claimMatrix is required");
  if (!manifest.candidate.createdAt || typeof manifest.candidate.createdAt !== "string") throw new Error("candidate.createdAt is required");
  if (!manifest.candidate.commit || !COMMIT.test(manifest.candidate.commit) || /^0+$/u.test(manifest.candidate.commit) || !SHA256.test(manifest.candidate.sourceTreeSha256) || /^0+$/u.test(manifest.candidate.sourceTreeSha256) || !SHA256.test(manifest.candidate.preregistrationSha256) || /^0+$/u.test(manifest.candidate.preregistrationSha256) || !SHA256.test(manifest.candidate.casePlanSha256) || /^0+$/u.test(manifest.candidate.casePlanSha256)) throw new Error("candidate bindings are incomplete or malformed");
  if (!manifest.roles.producerId || !manifest.roles.reviewerId) throw new Error("roles.producerId and roles.reviewerId are required");
  const refs: Array<[unknown, string]> = [
    [manifest.formalProvider.authorization, "formalProvider.authorization"], [manifest.formalProvider.rawLedger, "formalProvider.rawLedger"], [manifest.formalProvider.receipt, "formalProvider.receipt"],
    [manifest.externalBaseline.protocol, "externalBaseline.protocol"], [manifest.externalBaseline.rawResults, "externalBaseline.rawResults"], [manifest.externalBaseline.provenance, "externalBaseline.provenance"],
    [manifest.independentReproduction.environment, "independentReproduction.environment"], [manifest.independentReproduction.report, "independentReproduction.report"],
    [manifest.artifactChain.raw, "artifactChain.raw"], [manifest.artifactChain.derived, "artifactChain.derived"], [manifest.artifactChain.statistics, "artifactChain.statistics"], [manifest.artifactChain.tables, "artifactChain.tables"], [manifest.artifactChain.figures, "artifactChain.figures"], [manifest.artifactChain.manifest, "artifactChain.manifest"],
    [manifest.claimMatrix, "claimMatrix"], [manifest.publicationReview.report, "publicationReview.report"],
  ];
  for (const [ref, label] of refs) if (!isFileRef(ref)) throw new Error(`${label} must contain path and sha256`);
  return manifest;
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function isSafeRelative(path: string): boolean {
  return typeof path === "string" && path.length > 0 && !path.includes("\\") && !path.includes("\0") && !path.startsWith("/") && !/^[A-Za-z]:/u.test(path) && path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function isFileRef(value: unknown): value is FileRef {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && typeof (value as FileRef).path === "string"
    && typeof (value as FileRef).sha256 === "string";
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !rel.includes("..\\") && !rel.includes("../") && !/^[A-Za-z]:/u.test(rel));
}

function sha256File(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }

main();
