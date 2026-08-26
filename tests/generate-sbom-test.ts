import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { generateCycloneDxSbom, resolveSafeInput, serializeCycloneDxSbom } from "../scripts/generate-sbom.js";

test("从 lockfile v3 确定性生成 CycloneDX 1.5，并标记直接/传递依赖", async () => {
  const root = await createFixture();
  try {
    const first = await generateCycloneDxSbom(root);
    const second = await generateCycloneDxSbom(root);
    assert.equal(serializeCycloneDxSbom(first), serializeCycloneDxSbom(second));
    assert.equal(first.bomFormat, "CycloneDX");
    assert.equal(first.specVersion, "1.5");
    assert.deepEqual(first.components.map((component) => component.name), ["@scope/direct", "nested", "transitive"]);
    assert.equal(property(first.components[0], "god-agent:dependency-level"), "direct");
    assert.equal(property(first.components[1], "god-agent:dependency-level"), "transitive");
    assert.equal(property(first.components[2], "god-agent:dependency-level"), "transitive");
    assert.equal(first.components[0]?.purl, "pkg:npm/%40scope/direct@1.2.3");
    assert.deepEqual(first.components[0]?.licenses, [{ license: { name: "MIT" } }]);
    assert.equal("licenses" in (first.components[1] ?? {}), false, "no license is guessed without lock evidence");
    assert.match(metadataProperty(first, "god-agent:source-lockfile-sha256") ?? "", /^[a-f0-9]{64}$/u);
    assert.match(metadataProperty(first, "god-agent:source-manifest-sha256") ?? "", /^[a-f0-9]{64}$/u);
    assert.match(metadataProperty(first, "god-agent:dependency-graph-sha256") ?? "", /^[a-f0-9]{64}$/u);
    assert.equal(metadataProperty(first, "god-agent:component-count"), "3");
    assert.equal(metadataProperty(first, "god-agent:license-evidence-count"), "1");
    assert.equal(metadataProperty(first, "god-agent:license-evidence-missing-count"), "2");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("package.json 与 lockfile 根依赖漂移时拒绝生成", async () => {
  const root = await createFixture({ manifestDependency: "^9.9.9" });
  try {
    await assert.rejects(generateCycloneDxSbom(root), /drift: dependencies/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("根依赖声明存在但没有对应锁定组件时拒绝生成", async () => {
  const root = await createFixture({ omitDirectPackage: true });
  try {
    await assert.rejects(generateCycloneDxSbom(root), /direct dependency is not locked/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("非法 package install path 与工作区外输入路径都被拒绝", async () => {
  const root = await createFixture({ illegalInstallPath: true });
  try {
    await assert.rejects(generateCycloneDxSbom(root), /illegal package-lock install path/u);
    await assert.rejects(
      generateCycloneDxSbom(root, { lockfilePath: "../outside-package-lock.json" }),
      /illegal lockfile path outside workspace/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("非法 JSON 和不支持的 lockfile 版本失败关闭", async () => {
  const root = await createFixture();
  try {
    await writeFile(path.join(root, "package-lock.json"), "not-json", "utf8");
    await assert.rejects(generateCycloneDxSbom(root), /not valid JSON/u);
    await writeFixture(root, { lockfileVersion: 2 });
    await assert.rejects(generateCycloneDxSbom(root), /unsupported package-lock version/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manifest dependency 字段篡改为数组时拒绝生成", async () => {
  const root = await createFixture();
  try {
    const manifestPath = path.join(root, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.dependencies = ["@scope/direct"];
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
    await assert.rejects(generateCycloneDxSbom(root), /package\.json dependencies must be an object/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("工作区内指向外部的 lockfile 符号链接失败关闭", async (t) => {
  const root = await createFixture();
  const outside = await mkdtemp(path.join(tmpdir(), "god-agent-sbom-outside-"));
  try {
    const outsideLock = path.join(outside, "package-lock.json");
    await writeFile(outsideLock, await readFile(path.join(root, "package-lock.json")), "utf8");
    try {
      await symlink(outsideLock, path.join(root, "external-lock.json"));
    } catch (error) {
      t.skip(`symlink creation unavailable: ${String(error)}`);
      return;
    }
    await assert.rejects(
      generateCycloneDxSbom(root, { lockfilePath: "external-lock.json" }),
      /regular file/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("SBOM 输出路径允许工作区内新文件并拒绝路径穿越", async () => {
  const root = await createFixture();
  try {
    const output = await resolveSafeInput(root, ".tmp/release/bom.cdx.json", "output", true);
    assert.equal(output, path.join(root, ".tmp", "release", "bom.cdx.json"));
    await assert.rejects(resolveSafeInput(root, "../bom.cdx.json", "output", true), /outside workspace/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

interface FixtureOptions {
  manifestDependency?: string;
  omitDirectPackage?: boolean;
  illegalInstallPath?: boolean;
  lockfileVersion?: number;
}

async function createFixture(options: FixtureOptions = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "god-agent-sbom-test-"));
  await writeFixture(root, options);
  return root;
}

async function writeFixture(root: string, options: FixtureOptions): Promise<void> {
  const manifest = {
    name: "fixture-app",
    version: "1.0.0",
    license: "ISC",
    dependencies: { "@scope/direct": options.manifestDependency ?? "^1.2.0" },
  };
  const packages: Record<string, object> = {
    "": { ...manifest, dependencies: { "@scope/direct": "^1.2.0" } },
    "node_modules/transitive": { version: "2.0.0", license: 123 },
    "node_modules/@scope/direct/node_modules/nested": { version: "3.0.0" },
  };
  if (!options.omitDirectPackage) {
    packages["node_modules/@scope/direct"] = {
      version: "1.2.3",
      license: "MIT",
      dependencies: { transitive: "^2.0.0", nested: "^3.0.0" },
    };
  }
  if (options.illegalInstallPath) packages["node_modules/../escaped"] = { version: "1.0.0" };
  const lock = {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: options.lockfileVersion ?? 3,
    requires: true,
    packages,
  };
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(path.join(root, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`, "utf8");
}

function property(component: { properties?: Array<{ name: string; value: string }> } | undefined, name: string): string | undefined {
  return component?.properties?.find((item) => item.name === name)?.value;
}

function metadataProperty(sbom: Awaited<ReturnType<typeof generateCycloneDxSbom>>, name: string): string | undefined {
  return sbom.metadata.properties.find((item) => item.name === name)?.value;
}
