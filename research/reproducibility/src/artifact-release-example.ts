import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createVersionedArtifactRelease, verifyVersionedArtifactRelease } from "./artifact-release.js";
import { createPublishableDerivation } from "./publishable-sanitizer.js";

const repositoryRoot = path.resolve(process.cwd());
const outputRoot = path.join(repositoryRoot, "research", "artifact-releases", "local-tooling-v0.1.0", "release");
const stagingParent = await mkdtemp(path.join(tmpdir(), "god-agent-local-tooling-release-"));
const privateRoot = path.join(stagingParent, "private-source");
const sourceRoot = path.join(stagingParent, "release-source");

try {
  await mkdir(privateRoot, { recursive: true });
  await mkdir(sourceRoot, { recursive: true });
  await copy("LICENSE", "LICENSE");
  await copy("research/paper/CLAIM-TABLE.json", "claims/CLAIM-TABLE.json");
  await copy("research/metrics/metric-dictionary-v2.json", "dictionary/metric-dictionary-v2.json");
  await copy("research/artifacts/v0.1/model-check/artifact-manifest.json", "manifest/artifact-manifest.json");
  await copy("research/rt95-closure/preregistration.draft.example.json", "preregistration/preregistration.draft.example.json");
  await copy("research/reproducibility/src/artifact-release.ts", "src/artifact-release.ts.txt");
  await copyToPrivate("research/artifacts/v0.1/model-check/artifact-manifest.json", "statistics.json");
  await copyToPrivate("research/artifacts/v0.1/model-check/summary.csv", "summary.csv");
  await writeFile(path.join(privateRoot, "private-operator-notes.bin"), Buffer.from([1, 3, 3, 7]), { flag: "wx" });
  await createPublishableDerivation({
    privateRootDirectory: privateRoot,
    publicRootDirectory: path.join(sourceRoot, "raw"),
    allowPaths: ["statistics.json", "summary.csv"],
  });
  await mkdir(path.dirname(outputRoot), { recursive: true });
  const release = await createVersionedArtifactRelease({
    sourceRootDirectory: sourceRoot,
    outputRootDirectory: outputRoot,
    releaseVersion: "0.1.0",
    previousReleaseVersion: null,
    candidateCommit: "f3320cb9eb241e7717433a54e7b88d327e754821",
    files: [
      { path: "LICENSE", role: "license" },
      { path: "claims/CLAIM-TABLE.json", role: "claim-table" },
      { path: "dictionary/metric-dictionary-v2.json", role: "data-dictionary" },
      { path: "manifest/artifact-manifest.json", role: "artifact-manifest" },
      { path: "preregistration/preregistration.draft.example.json", role: "preregistration" },
      { path: "raw/publishable-derivation-receipt.json", role: "raw-public-derivation-receipt" },
      { path: "raw/statistics.json", role: "statistics" },
      { path: "raw/summary.csv", role: "table" },
      { path: "src/artifact-release.ts.txt", role: "source-snapshot" },
    ],
    includedClaimIds: ["CLAIM-PIPELINE-ARTIFACT-RELEASE-001"],
  });
  await verifyVersionedArtifactRelease({
    outputRootDirectory: outputRoot,
    minimumReleaseVersion: "0.1.0",
    expectedCandidateCommit: "f3320cb9eb241e7717433a54e7b88d327e754821",
  });
  process.stdout.write(`${JSON.stringify({
    verified: true,
    releaseVersion: release.releaseVersion,
    claimBoundary: release.claimBoundary,
    files: release.files.length,
    releaseSha256: release.releaseSha256,
  })}\n`);
} finally {
  await rm(stagingParent, { recursive: true, force: true });
}

async function copy(sourceRelativePath: string, targetRelativePath: string): Promise<void> {
  const target = path.join(sourceRoot, ...targetRelativePath.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(repositoryRoot, ...sourceRelativePath.split("/")), target);
}

async function copyToPrivate(sourceRelativePath: string, targetName: string): Promise<void> {
  await copyFile(path.join(repositoryRoot, ...sourceRelativePath.split("/")), path.join(privateRoot, targetName));
}
