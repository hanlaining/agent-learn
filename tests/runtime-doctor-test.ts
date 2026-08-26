import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { formatRuntimeDoctor, runRuntimeDoctor } from "../scripts/runtime-doctor.js";

const REQUIRED_PATHS = [
  "package.json",
  "package-lock.json",
  "README.md",
  "LICENSE",
  "bin/god-agent.js",
  "node_modules/electron/package.json",
  "node_modules/gpt-tokenizer/package.json",
  "node_modules/react/package.json",
  "node_modules/react-dom/package.json",
  "dist/electron-app/electron/main.cjs",
  "dist/electron-app/electron/renderer/index.html",
] as const;

test("完整 Windows/Node 20 运行环境输出人机可读 READY，并清理临时探针", async () => {
  const root = await createFixture();
  const temp = path.join(root, "temp");
  try {
    const before = await readdir(temp);
    const report = await runRuntimeDoctor({
      rootDirectory: root,
      nodeVersion: "20.19.5",
      platform: "win32",
      environment: {},
      tempDirectory: temp,
    });
    assert.equal(report.ready, true);
    assert.equal(report.schemaVersion, "god-agent-runtime-doctor-v1");
    assert.equal(report.checks.find((check) => check.id === "provider")?.status, "warn");
    assert.deepEqual(await readdir(temp), before);
    assert.match(formatRuntimeDoctor(report), /生产运行前置条件：READY/u);
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(report)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Node 版本、平台、文件、依赖、构建和临时目录任一异常均失败关闭", async () => {
  const root = await createFixture();
  const invalidTemp = path.join(root, "not-a-directory");
  await writeFile(invalidTemp, "file", "utf8");
  await rm(path.join(root, "LICENSE"));
  await rm(path.join(root, "node_modules", "react", "package.json"));
  await rm(path.join(root, "dist", "electron-app", "electron", "main.cjs"));
  try {
    const report = await runRuntimeDoctor({
      rootDirectory: root,
      nodeVersion: "21.0.0",
      platform: "linux",
      environment: {},
      tempDirectory: invalidTemp,
    });
    assert.equal(report.ready, false);
    for (const id of ["node", "platform", "files", "dependencies", "build", "temp-write-cleanup"] as const) {
      assert.equal(report.checks.find((check) => check.id === id)?.status, "fail", id);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("畸形 Node 版本同样失败关闭", async () => {
  const root = await createFixture();
  try {
    const report = await runRuntimeDoctor({
      rootDirectory: root,
      nodeVersion: "current",
      platform: "win32",
      environment: {},
      tempDirectory: path.join(root, "temp"),
    });
    assert.equal(report.ready, false);
    assert.equal(report.checks.find((check) => check.id === "node")?.status, "fail");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Provider 检查只枚举变量名，从不读取或输出配置值", async () => {
  const root = await createFixture();
  const environment = {};
  Object.defineProperties(environment, {
    OPENAI_API_KEY: { enumerable: true, get: () => { throw new Error("api-secret-must-not-be-read"); } },
    OPENAI_BASE_URL: { enumerable: false, get: () => { throw new Error("url-secret-must-not-be-read"); } },
  });
  try {
    const report = await runRuntimeDoctor({
      rootDirectory: root,
      nodeVersion: "20.0.0",
      platform: "win32",
      environment,
      tempDirectory: path.join(root, "temp"),
    });
    const outputs = `${JSON.stringify(report)}\n${formatRuntimeDoctor(report)}`;
    assert.equal(report.providerConfigured, true);
    assert.doesNotMatch(outputs, /api-secret|url-secret/u);
    assert.match(outputs, /值未读取/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("仅配置 BASE_URL 或 MODEL 不得冒充真实 Provider 已配置", async () => {
  const root = await createFixture();
  try {
    const report = await runRuntimeDoctor({
      rootDirectory: root,
      nodeVersion: "20.0.0",
      platform: "win32",
      environment: { OPENAI_BASE_URL: "https://example.invalid", OPENAI_MODEL: "fixture" },
      tempDirectory: path.join(root, "temp"),
    });
    assert.equal(report.providerConfigured, false);
    assert.equal(report.checks.find((check) => check.id === "provider")?.status, "warn");
    assert.equal(report.ready, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("关键路径变成目录或临时目录不存在时，doctor 失败关闭", async () => {
  const root = await createFixture();
  try {
    await rm(path.join(root, "package.json"));
    await mkdir(path.join(root, "package.json"), { recursive: true });
    const report = await runRuntimeDoctor({
      rootDirectory: root,
      nodeVersion: "20.0.0",
      platform: "win32",
      environment: {},
      tempDirectory: path.join(root, "missing-temp"),
    });
    assert.equal(report.ready, false);
    assert.equal(report.checks.find((check) => check.id === "files")?.status, "fail");
    assert.equal(report.checks.find((check) => check.id === "temp-write-cleanup")?.status, "fail");
    assert.equal(report.summary.failed, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "god-agent-runtime-doctor-test-"));
  for (const relativePath of REQUIRED_PATHS) {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, "fixture\n", "utf8");
  }
  await mkdir(path.join(root, "temp"), { recursive: true });
  return root;
}
