import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  collectScriptTestReferences,
  discoverFormalTests,
  verifyTestDiscovery,
} from "../scripts/verify-test-discovery.js";

test("discovers nested product and research tests but ignores non-test TypeScript", async () => {
  const root = await mkdtemp(join(tmpdir(), "god-agent-test-discovery-"));
  try {
    await mkdir(join(root, "tests", "capacity"), { recursive: true });
    await mkdir(join(root, "research", "sample", "tests"), { recursive: true });
    await writeFile(join(root, "tests", "root-test.ts"), "", "utf8");
    await writeFile(join(root, "tests", "capacity", "nested-test.ts"), "", "utf8");
    await writeFile(join(root, "tests", "helper.ts"), "", "utf8");
    await writeFile(join(root, "research", "sample", "tests", "formal-test.ts"), "", "utf8");
    assert.deepEqual(await discoverFormalTests(root), [
      "research/sample/tests/formal-test.ts",
      "tests/capacity/nested-test.ts",
      "tests/root-test.ts",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("collects only explicit references from npm test lifecycle scripts", () => {
  assert.deepEqual(collectScriptTestReferences({
    build: "tsx --test tests/ignored-test.ts",
    pretest: "tsx --test tests/pre-test.ts",
    test: "tsx --test tests/main-test.ts",
    "test:research": "tsx --test research/sample/tests/formal-test.ts",
  }), [
    "research/sample/tests/formal-test.ts",
    "tests/main-test.ts",
    "tests/pre-test.ts",
  ]);
});

test("reports both omitted files and stale package script references", async () => {
  const root = await mkdtemp(join(tmpdir(), "god-agent-test-discovery-gate-"));
  try {
    await mkdir(join(root, "tests"), { recursive: true });
    await writeFile(join(root, "tests", "present-test.ts"), "", "utf8");
    await writeFile(join(root, "package.json"), JSON.stringify({
      scripts: { test: "tsx --test tests/stale-test.ts" },
    }), "utf8");
    const result = await verifyTestDiscovery(root);
    assert.deepEqual(result.missingFromScripts, ["tests/present-test.ts"]);
    assert.deepEqual(result.staleScriptReferences, ["tests/stale-test.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("current repository has no silently omitted or stale formal test", async () => {
  const workspaceRoot = resolve(import.meta.dirname, "..");
  const result = await verifyTestDiscovery(workspaceRoot);
  assert.deepEqual(result.missingFromScripts, []);
  assert.deepEqual(result.staleScriptReferences, []);
  assert.ok(result.discovered.includes("tests/agent-registry-test.ts"));
  assert.ok(result.discovered.includes("tests/electron-ipc-boundary-test.ts"));
  assert.ok(result.discovered.includes("tests/outcome-unknown-resolution-test.ts"));
  assert.ok(result.discovered.includes("tests/tool-schema-test.ts"));
  assert.ok(result.discovered.includes("research/reproducibility/tests/manifest-test.ts"));
  assert.ok(result.discovered.includes("research/runtime-e2e-benchmarks/tests/process-chaos-gate-test.ts"));
});
