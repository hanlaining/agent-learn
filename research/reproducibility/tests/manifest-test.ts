import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  createArtifactManifest,
  serializeArtifactManifest,
  inferContentType,
  normalizeSafeRelativePath,
  assertPublishableArtifactContent,
  validateArtifactManifest,
  verifyArtifactManifest,
} from "../src/manifest.js";
import type { ArtifactManifest, CreateArtifactManifestOptions } from "../src/types.js";

const BASELINE_COMMIT = "e65767f960967a21ab2191503363e53280d4ba62";
const CLI_PATH = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

test("create 记录排序后的相对路径、字节数、SHA-256、内容类型与安全运行元数据", async (context) => {
  const root = await fixtureRoot(context);
  const first = await createArtifactManifest(createOptions(root));
  const firstBytes = await readFile(path.join(root, "artifact-manifest.json"), "utf8");
  const second = await createArtifactManifest(createOptions(root));
  const secondBytes = await readFile(path.join(root, "artifact-manifest.json"), "utf8");

  assert.equal(firstBytes, secondBytes);
  assert.equal(firstBytes, serializeArtifactManifest(first));
  assert.deepEqual(first.files.map((entry) => entry.path), ["a.json", "nested/z.csv"]);
  assert.deepEqual(first.files.map((entry) => entry.contentType), ["application/json", "text/csv"]);
  assert.equal(first.files[0]?.bytes, Buffer.byteLength("{\"ok\":true}\n"));
  assert.match(first.files[0]?.sha256 ?? "", /^[0-9a-f]{64}$/u);
  assert.equal(first.baselineCommit, BASELINE_COMMIT);
  assert.equal(first.run.command, "npm run benchmark:gate30");
  assert.equal(first.provider.realApiCalls, false);
  assert.equal(first.provider.credentialsRead, false);
  assert.equal(second.files.length, 2, "重复 create 不得把 Manifest 自身加入文件列表");
  await verifyArtifactManifest({ rootDirectory: root });
});

test("verify 拒绝内容篡改，CLI 返回非零退出码", async (context) => {
  const root = await fixtureRoot(context);
  await createArtifactManifest(createOptions(root));
  await writeFile(path.join(root, "a.json"), "{\"ok\":false}\n", "utf8");
  await assert.rejects(verifyArtifactManifest({ rootDirectory: root }), /(?:byte count|SHA-256) mismatch/u);

  const result = runCli(["verify", "--root", root]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /artifact manifest error:/u);
});

test("verify 拒绝 Manifest 中已登记但实际缺失的文件", async (context) => {
  const root = await fixtureRoot(context);
  await createArtifactManifest(createOptions(root));
  await unlink(path.join(root, "nested", "z.csv"));
  await assert.rejects(verifyArtifactManifest({ rootDirectory: root }), /files are missing: nested\/z\.csv/u);
  assert.notEqual(runCli(["verify", "--root", root]).status, 0);
});

test("verify 拒绝 Manifest 创建后出现的多余文件", async (context) => {
  const root = await fixtureRoot(context);
  await createArtifactManifest(createOptions(root));
  await writeFile(path.join(root, "unexpected.txt"), "not registered\n", "utf8");
  await assert.rejects(verifyArtifactManifest({ rootDirectory: root }), /unexpected artifact files found: unexpected\.txt/u);
  assert.notEqual(runCli(["verify", "--root", root]).status, 0);
});

test("路径校验拒绝目录穿越、绝对路径、重复路径和 Manifest 自包含", async (context) => {
  const root = await fixtureRoot(context);
  const manifest = await createArtifactManifest(createOptions(root));
  const entry = manifest.files[0]!;

  assert.throws(() => validateArtifactManifest(withFiles(manifest, [{ ...entry, path: "../outside.json" }])), /unsafe path segment/u);
  assert.throws(() => validateArtifactManifest(withFiles(manifest, [{ ...entry, path: "C:/Users/example/result.json" }])), /relative path/u);
  assert.throws(() => validateArtifactManifest(withFiles(manifest, [entry, { ...entry }])), /duplicate artifact path/u);
  assert.throws(() => validateArtifactManifest(withFiles(manifest, [{ ...entry, path: "artifact-manifest.json" }])), /must not include itself/u);
  await assert.rejects(createArtifactManifest({ ...createOptions(root), manifestPath: "../manifest.json" }), /unsafe path segment/u);
});

test("元数据拒绝绝对本机路径、环境变量值和凭据参数", async (context) => {
  const root = await fixtureRoot(context);
  await assert.rejects(createArtifactManifest({ ...createOptions(root), command: "node C:\\Users\\example\\runner.js" }), /must not contain/u);
  await assert.rejects(createArtifactManifest({ ...createOptions(root), command: "API_MODE=offline npm test" }), /must not contain/u);
  await assert.rejects(createArtifactManifest({ ...createOptions(root), command: "runner --api-key=secret-value" }), /must not contain/u);
});

test("Artifact 正文拒绝本机绝对路径和高置信 GitHub Token，但接受安全相对路径与占位符", async (context) => {
  const unsafeContents = [
    "D:/练手/god-runtime-phase1-integration/result.json",
    "D:\\练手\\god-runtime-phase1-integration\\result.json",
    "C:/Users/example/result.json",
    "\\\\server\\share\\result.json",
    "/home/example/result.json",
    "/tmp/god-agent/result.json",
    "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  ];
  for (const [index, content] of unsafeContents.entries()) {
    const root = await fixtureRoot(context);
    await writeFile(path.join(root, "a.json"), `${JSON.stringify({ content })}\n`, "utf8");
    await assert.rejects(
      createArtifactManifest(createOptions(root)),
      /credential or machine-local absolute path/u,
      `unsafe content case ${index + 1} must be rejected`,
    );
  }

  const safeRoot = await fixtureRoot(context);
  await writeFile(
    path.join(safeRoot, "a.json"),
    `${JSON.stringify({ relative: "research/results/report.json", placeholder: "<integration-worktree>/result.json" })}\n`,
    "utf8",
  );
  await createArtifactManifest(createOptions(safeRoot));
  await verifyArtifactManifest({ rootDirectory: safeRoot });
});

test("CLI 可从仓库根目录直接 create 和 verify", async (context) => {
  const root = await fixtureRoot(context);
  const create = runCli([
    "create", "--root", root,
    "--baseline-commit", BASELINE_COMMIT,
    "--command", "npm run benchmark:gate30",
    "--started-at", "2026-08-20T01:00:00.000Z",
    "--finished-at", "2026-08-20T01:05:00.000Z",
    "--provider", "deterministic-fake",
  ]);
  assert.equal(create.status, 0, create.stderr);
  assert.match(create.stdout, /"action":"create"/u);

  const verify = runCli(["verify", "--root", root]);
  assert.equal(verify.status, 0, verify.stderr);
  assert.match(verify.stdout, /"verified":true/u);
});

test("自定义 Manifest 相对路径仍保持规范化并排除自身", async (context) => {
  const root = await fixtureRoot(context);
  const manifestPath = "metadata/artifact-manifest.json";
  const manifest = await createArtifactManifest({ ...createOptions(root), manifestPath });
  assert.equal(manifest.files.some((entry) => entry.path === manifestPath), false);
  assert.equal(
    await readFile(path.join(root, "metadata", "artifact-manifest.json"), "utf8"),
    serializeArtifactManifest(manifest, manifestPath),
  );
  await verifyArtifactManifest({ rootDirectory: root, manifestPath });
});

test("Manifest 路径、内容类型和可发布正文边界覆盖全部安全分支", () => {
  const expected: Record<string, string> = {
    "a.json": "application/json", "a.jsonl": "application/x-ndjson", "a.ndjson": "application/x-ndjson",
    "a.csv": "text/csv", "a.md": "text/markdown", "a.txt": "text/plain", "a.log": "text/plain",
    "a.repro": "text/plain", "a.cjs": "text/plain", "a.js": "text/plain", "a.mjs": "text/plain",
    "a.ts": "text/plain", "a.tsx": "text/plain", "a.yaml": "application/yaml", "a.yml": "application/yaml",
    "a.pdf": "application/pdf", "a.zip": "application/zip", "a.bin": "application/octet-stream",
  };
  for (const [file, contentType] of Object.entries(expected)) assert.equal(inferContentType(file), contentType);
  assert.equal(normalizeSafeRelativePath("nested/report.json"), "nested/report.json");
  assert.equal(normalizeSafeRelativePath("结果.md"), "结果.md");
  for (const unsafe of ["", "../outside", "/absolute", "C:/absolute", "nested//file", "nested/./file", "nested/../file", "nested\\file", "nested\0file"]) {
    assert.throws(() => normalizeSafeRelativePath(unsafe), /safe relative|normalized relative|unsafe path segment|escapes/u);
  }
  assert.doesNotThrow(() => assertPublishableArtifactContent("results/report.json", Buffer.from('{"ok":true}\n')));
  assert.throws(() => assertPublishableArtifactContent("results/token.txt", Buffer.from("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")), /sensitive|credential|absolute path/u);
  assert.throws(() => assertPublishableArtifactContent("../token.txt", Buffer.from("safe")), /safe relative|unsafe path segment/u);
});

test("Manifest 拒绝时间倒退、非 canonical 时间和命令换行", async (context) => {
  const root = await fixtureRoot(context);
  await assert.rejects(createArtifactManifest({ ...createOptions(root), startedAt: "2026-08-20T01:05:00.000Z", finishedAt: "2026-08-20T01:00:00.000Z" }), /finishedAt precedes/u);
  await assert.rejects(createArtifactManifest({ ...createOptions(root), startedAt: "2026-08-20T01:00:00Z" }), /canonical ISO-8601/u);
  await assert.rejects(createArtifactManifest({ ...createOptions(root), command: "npm test\nsecret" }), /run command|must not contain/u);
});

test("Manifest 拒绝非法 baseline、Node/OS 和 Provider 状态", async (context) => {
  const root = await fixtureRoot(context);
  const base = await createArtifactManifest(createOptions(root));
  assert.throws(() => validateArtifactManifest({ ...base, baselineCommit: "g".repeat(40) }), /baselineCommit/u);
  assert.throws(() => validateArtifactManifest({ ...base, environment: { ...base.environment, node: "node" } }), /Node version/u);
  assert.throws(() => validateArtifactManifest({ ...base, environment: { ...base.environment, os: { ...base.environment.os, arch: "x64 space" } } }), /OS arch/u);
  assert.throws(() => validateArtifactManifest({ ...base, provider: { ...base.provider, kind: "live" } }), /provider kind/u);
  assert.throws(() => validateArtifactManifest({ ...base, provider: { ...base.provider, credentialsRead: true } }), /zero credential reads/u);
});

test("Manifest 拒绝文件条目空值、无序、非法摘要和错误 contentType", async (context) => {
  const root = await fixtureRoot(context);
  const base = await createArtifactManifest(createOptions(root));
  const first = base.files[0]!;
  assert.throws(() => validateArtifactManifest({ ...base, files: [{ ...first, bytes: -1 }] }), /byte count/u);
  assert.throws(() => validateArtifactManifest({ ...base, files: [{ ...first, sha256: "bad" }] }), /SHA-256/u);
  assert.throws(() => validateArtifactManifest({ ...base, files: [{ ...first, contentType: "text/plain" }] }), /content type/u);
  assert.throws(() => validateArtifactManifest({ ...base, files: [{ ...first, path: "z.json" }, { ...first, path: "a.json" }] }), /deterministic path order/u);
});

test("Manifest 拒绝敏感文件名、二进制私钥和不可发布占位内容", async (context) => {
  const root = await fixtureRoot(context);
  await writeFile(path.join(root, "secret.pem"), "safe\n", "utf8");
  await assert.rejects(createArtifactManifest(createOptions(root)), /sensitive file/u);
  const privateRoot = await fixtureRoot(context);
  const privateKeyHeader = `-----BEGIN ${"PRIVATE"} KEY-----`;
  await writeFile(path.join(privateRoot, "a.json"), JSON.stringify({ key: privateKeyHeader }), "utf8");
  await assert.rejects(createArtifactManifest(createOptions(privateRoot)), /credential/u);
  assert.throws(() => assertPublishableArtifactContent("report.json", Buffer.from([0xff, 0xfe])), /credential|absolute path|replacement/u);
});

test("Manifest verify 拒绝 canonical 漂移、目录代替文件和自包含路径", async (context) => {
  const root = await fixtureRoot(context);
  await createArtifactManifest(createOptions(root));
  const manifestPath = path.join(root, "artifact-manifest.json");
  const text = await readFile(manifestPath, "utf8");
  await writeFile(manifestPath, text.replace("\n", "\r\n"), "utf8");
  await assert.rejects(verifyArtifactManifest({ rootDirectory: root }), /canonical/u);
  const second = await fixtureRoot(context);
  await mkdir(path.join(second, "artifact-manifest.json"));
  await assert.rejects(createArtifactManifest(createOptions(second)), /regular file/u);
  const base = await createArtifactManifest(createOptions(await fixtureRoot(context)));
  assert.throws(() => validateArtifactManifest({ ...base, files: [{ ...base.files[0]!, path: "artifact-manifest.json" }] }), /must not include itself/u);
});

async function fixtureRoot(context: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "research-artifact-manifest-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "nested"));
  await writeFile(path.join(root, "a.json"), "{\"ok\":true}\n", "utf8");
  await writeFile(path.join(root, "nested", "z.csv"), "case,result\n1,pass\n", "utf8");
  return root;
}

function createOptions(rootDirectory: string): CreateArtifactManifestOptions {
  return {
    rootDirectory,
    baselineCommit: BASELINE_COMMIT,
    command: "npm run benchmark:gate30",
    startedAt: "2026-08-20T01:00:00.000Z",
    finishedAt: "2026-08-20T01:05:00.000Z",
    providerKind: "deterministic-fake",
  };
}

function withFiles(manifest: ArtifactManifest, files: ArtifactManifest["files"]): ArtifactManifest {
  return { ...manifest, files };
}

function runCli(args: string[]): ReturnType<typeof spawnSync> & { stdout: string; stderr: string } {
  return spawnSync(process.execPath, ["--import", "tsx", CLI_PATH, ...args], {
    cwd: path.resolve(fileURLToPath(new URL("../../../", import.meta.url))),
    encoding: "utf8",
  });
}
