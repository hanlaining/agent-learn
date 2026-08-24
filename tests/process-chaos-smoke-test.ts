import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

test("process-chaos smoke dry-run emits an auditable JSON result without spawning a server", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "god-process-chaos-dry-run-"));
  try {
    const result = await runCli(["--dry-run", "--seed", "dry-run-1", "--out", output]);
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as { status: string; provider: { liveCalls: boolean }; outputDirectory: string };
    assert.equal(parsed.status, "dry-run");
    assert.equal(parsed.provider.liveCalls, false);
    const caseDirectory = path.join(output, "process-chaos-dry-run-1");
    assert.equal(path.resolve(parsed.outputDirectory), path.resolve(caseDirectory));
    const persisted = JSON.parse(await readFile(path.join(caseDirectory, "smoke-result.json"), "utf8")) as { status: string };
    assert.equal(persisted.status, "dry-run");
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("process-chaos smoke rejects an unsafe seed before any child process starts", async () => {
  const result = await runCli(["--dry-run", "--seed", "unsafe/seed"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /--seed must contain/);
});

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const script = path.resolve("scripts/process-chaos-smoke.ts");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", script, ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
