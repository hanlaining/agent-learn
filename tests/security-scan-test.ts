import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  formatSecurityScanReport,
  listVersionControlCandidates,
  scanSecurityCandidates,
  UnsafeCandidatePathError,
} from "../scripts/security-scan.js";

test("discovers release candidates deterministically without Git metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "god-agent-security-discovery-"));
  try {
    await mkdir(join(root, "src", "nested"), { recursive: true });
    await mkdir(join(root, ".git", "objects"), { recursive: true });
    await mkdir(join(root, "node_modules", "dependency"), { recursive: true });
    await mkdir(join(root, ".tmp"), { recursive: true });
    await writeFile(join(root, "z.txt"), "z", "utf8");
    await writeFile(join(root, "src", "a.ts"), "a", "utf8");
    await writeFile(join(root, "src", "nested", "b.ts"), "b", "utf8");
    await writeFile(join(root, ".git", "objects", "ignored"), "ignored", "utf8");
    await writeFile(join(root, "node_modules", "dependency", "ignored"), "ignored", "utf8");
    await writeFile(join(root, ".tmp", "ignored"), "ignored", "utf8");

    assert.deepEqual(await listVersionControlCandidates(root), [
      "src/a.ts",
      "src/nested/b.ts",
      "z.txt",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detects high-confidence credentials while reporting no secret content", async () => {
  const root = await mkdtemp(join(tmpdir(), "god-agent-security-scan-"));
  const bearer = ["Bearer ", "AbC123", "xYz987", "TokenValue987654321"].join("");
  const privateHeader = ["-----BEGIN", " PRIVATE KEY-----"].join("");
  const githubToken = ["ghp_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");
  try {
    await writeFile(join(root, "config.txt"), `safe=true\n${bearer}\n${privateHeader}\n${githubToken}\n`, "utf8");
    const report = await scanSecurityCandidates(root, ["config.txt"]);
    assert.equal(report.status, "blocked");
    assert.deepEqual(report.findings.map((item) => [item.ruleId, item.line]), [
      ["bearer-credential", 2],
      ["private-key-header", 3],
      ["github-token", 4],
    ]);
    const serialized = JSON.stringify(report);
    const formatted = formatSecurityScanReport(report);
    for (const secret of [bearer, privateHeader, githubToken]) {
      assert.doesNotMatch(serialized, new RegExp(escapeRegExp(secret), "u"));
      assert.doesNotMatch(formatted, new RegExp(escapeRegExp(secret), "u"));
    }
    assert.match(formatted, /config\.txt:2 \[bearer-credential\]/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skips binary and default ignored build or local-state directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "god-agent-security-binary-"));
  try {
    await mkdir(join(root, "dist"), { recursive: true });
    await mkdir(join(root, ".tmp"), { recursive: true });
    await writeFile(join(root, "binary.bin"), Buffer.from([0, 45, 45, 45, 45, 45, 66, 69, 71, 73, 78]));
    await writeFile(join(root, "dist", "ignored.txt"), "ignored", "utf8");
    await writeFile(join(root, ".tmp", "state.txt"), "ignored", "utf8");
    const report = await scanSecurityCandidates(root, ["binary.bin", "dist/ignored.txt", ".tmp/state.txt"]);
    assert.equal(report.status, "passed");
    assert.equal(report.scannedFiles, 0);
    assert.deepEqual(report.skippedFiles.map((item) => item.reason).sort(), ["binary", "ignored", "ignored"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects path traversal before reading an out-of-workspace candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "god-agent-security-root-"));
  const outside = await mkdtemp(join(tmpdir(), "god-agent-security-outside-"));
  try {
    await writeFile(join(outside, "outside.txt"), "do-not-read", "utf8");
    await assert.rejects(
      () => scanSecurityCandidates(root, ["../outside.txt"]),
      UnsafeCandidatePathError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("rejects absolute and directory candidates before scanning", async () => {
  const root = await mkdtemp(join(tmpdir(), "god-agent-security-boundary-"));
  try {
    await mkdir(join(root, "nested"), { recursive: true });
    await assert.rejects(() => scanSecurityCandidates(root, [join(root, "nested")]), UnsafeCandidatePathError);
    await assert.rejects(() => scanSecurityCandidates(root, ["C:/outside.txt"]), UnsafeCandidatePathError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skips oversized text and ignores low-entropy generic assignments", async () => {
  const root = await mkdtemp(join(tmpdir(), "god-agent-security-size-"));
  try {
    await writeFile(join(root, "large.txt"), "x".repeat(128), "utf8");
    await writeFile(join(root, "low.txt"), "password=aaaaaaaaaaaaaaaaaaaaaaaa\n", "utf8");
    const report = await scanSecurityCandidates(root, ["large.txt", "low.txt"], 64);
    assert.equal(report.status, "passed");
    assert.equal(report.scannedFiles, 1);
    assert.deepEqual(report.skippedFiles, [{ path: "large.txt", reason: "too_large" }]);
    assert.equal(report.findings.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a symlink candidate instead of following it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "god-agent-security-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "god-agent-security-symlink-outside-"));
  try {
    const externalCredential = ["Bearer ", "AbC123", "xYz987", "TokenValue987654321"].join("");
    await writeFile(join(outside, "secret.txt"), externalCredential, "utf8");
    try {
      await symlink(join(outside, "secret.txt"), join(root, "linked.txt"));
    } catch (error) {
      t.skip(`symlink creation unavailable: ${String(error)}`);
      return;
    }
    await assert.rejects(() => scanSecurityCandidates(root, ["linked.txt"]), UnsafeCandidatePathError);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
