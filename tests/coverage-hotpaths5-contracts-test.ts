import assert from "node:assert/strict";
import test from "node:test";

import type { EvidenceContractInput } from "../src/evidence/evidence-contract.js";
import { createEvidenceContract } from "../src/evidence/evidence-normalization.js";
import { validateEvidenceContract } from "../src/evidence/evidence-validation.js";
import {
  createMcpRequestMeta,
  parseLegacyMcpInitializeResult,
  parseMcpDiscovery,
  parseMcpToolCallResult,
  parseMcpToolListPage,
} from "../src/mcp/mcp-protocol.js";
import { ContextBuilder } from "../src/runtime/context-builder.js";
import { ContextCheckpointStore } from "../src/runtime/context-checkpoint-store.js";
import { LifecycleStore } from "../src/runtime/lifecycle-store.js";

const HASH = "a".repeat(64);
const NOW = "2026-08-24T10:00:00.000Z";

function evidenceInput(overrides: Partial<EvidenceContractInput> = {}): EvidenceContractInput {
  return {
    schemaVersion: 1,
    id: "evidence-hotpaths5",
    authority: {
      threadId: "thread-1", turnId: "turn-1",
      requirementId: "requirement-1", requirementRevision: 1, requirementContentHash: HASH,
      planId: "plan-1", planVersion: "v1", contractDigest: HASH,
      jobId: "job-1", jobAttempt: 1, taskId: "task-1", taskAttempt: 1, runId: "run-1",
    },
    criterionBindings: [{ criterionId: "criterion-1", relation: "informational" }],
    kind: "summary",
    producer: "worker",
    assurance: "observed",
    freshness: { observedAt: NOW, recordedAt: NOW, inputDigest: HASH },
    summary: "deterministic evidence",
    indexOnly: true,
    resource: { type: "summary", indexOnly: true },
    compatibility: "native_v1",
    ...overrides,
  };
}

function validate(input: EvidenceContractInput): void {
  validateEvidenceContract(createEvidenceContract(input));
}

test("Evidence 时间、保证级别、兼容模式和归一化摘要统一 fail closed", () => {
  assert.throws(() => validate(evidenceInput({
    freshness: { observedAt: NOW, recordedAt: "2026-08-24T09:59:59.000Z", inputDigest: HASH },
  })), /recorded before/);
  assert.throws(() => validate(evidenceInput({
    freshness: { observedAt: NOW, recordedAt: NOW, validUntil: "2026-08-24T09:59:59.000Z", inputDigest: HASH },
  })), /validUntil precedes/);
  assert.throws(() => validate(evidenceInput({
    producer: "runtime", assurance: "verified",
  })), /Only a Verifier/);
  assert.throws(() => validate(evidenceInput({
    kind: "source", resource: { type: "summary", indexOnly: true },
  })), /discriminator/);
  assert.throws(() => validate(evidenceInput({
    compatibility: "legacy_projected", resource: { type: "summary", indexOnly: true },
  })), /Legacy Evidence/);

  const evidence = structuredClone(createEvidenceContract(evidenceInput()));
  evidence.normalizedDigest = "b".repeat(64);
  deepFreeze(evidence);
  assert.throws(() => validateEvidenceContract(evidence), /normalizedDigest does not match/);
});

test("Evidence 各资源族校验真实结构、路径和专用 Verifier", () => {
  assert.doesNotThrow(() => validate(evidenceInput({
    kind: "source", producer: "runtime", assurance: "observed", indexOnly: false,
    resource: { type: "source", uri: "https://example.test/source", title: "Source", contentDigest: HASH },
  })));
  assert.throws(() => validate(evidenceInput({
    kind: "source", producer: "runtime", assurance: "observed", indexOnly: false,
    resource: { type: "source", uri: "", title: "Source" },
  })), /Source Evidence is incomplete/);

  assert.doesNotThrow(() => validate(evidenceInput({
    kind: "diff", producer: "runtime", assurance: "observed", indexOnly: false,
    resource: { type: "diff", namespace: "workspace", path: "changes/result.diff", baseDigest: HASH, resultDigest: HASH },
  })));
  assert.throws(() => validate(evidenceInput({
    kind: "diff", producer: "runtime", assurance: "observed", indexOnly: false,
    resource: { type: "diff", namespace: "workspace", path: "../escape.diff", baseDigest: HASH, resultDigest: HASH },
  })), /Invalid diff.path/);

  assert.doesNotThrow(() => validate(evidenceInput({
    kind: "screenshot", producer: "artifact_verifier", assurance: "verified", indexOnly: false,
    resource: { type: "screenshot", namespace: "workspace", path: "shots/result.png", sha256: HASH, width: 800, height: 600, mediaType: "image/png" },
  })));
  assert.throws(() => validate(evidenceInput({
    kind: "screenshot", producer: "test_verifier", assurance: "verified", indexOnly: false,
    resource: { type: "screenshot", namespace: "workspace", path: "shots/result.png", sha256: HASH, width: 800, height: 600, mediaType: "image/png" },
  })), /dedicated Verifier/);

  assert.doesNotThrow(() => validate(evidenceInput({
    kind: "oracle", producer: "oracle_verifier", assurance: "verified", indexOnly: false,
    resource: { type: "oracle", oracleId: "oracle-1", oracleVersion: "v1", queryDigest: HASH, observationDigest: HASH, status: "satisfied" },
  })));
  assert.throws(() => validate(evidenceInput({
    kind: "oracle", producer: "oracle_verifier", assurance: "verified", indexOnly: false,
    criterionBindings: [{ criterionId: "criterion-1", relation: "supports" }],
    resource: { type: "oracle", oracleId: "oracle-1", oracleVersion: "v1", queryDigest: HASH, observationDigest: HASH, status: "unknown" },
  })), /cannot become successful proof/);

  assert.doesNotThrow(() => validate(evidenceInput({
    kind: "remote_state", producer: "runtime", assurance: "observed", indexOnly: false,
    resource: { type: "remote_state", systemId: "system-1", objectId: "object-1", stateDigest: HASH },
  })));
});

test("MCP 协议解析器防御性复制并拒绝含糊能力、分页和内容块", () => {
  const client = { name: "god-agent", version: "1.0.0", title: "God" };
  const meta = createMcpRequestMeta("2026-07-28", client);
  assert.deepEqual(meta["io.modelcontextprotocol/clientInfo"], client);
  assert.notEqual(meta["io.modelcontextprotocol/clientInfo"], client);

  assert.deepEqual(parseMcpDiscovery({ supportedVersions: ["2026-07-28"], capabilities: {}, instructions: "safe" }), {
    supportedVersions: ["2026-07-28"], capabilities: {}, instructions: "safe",
  });
  assert.throws(() => parseMcpDiscovery({ supportedVersions: [], capabilities: {} }), /discover result/);
  assert.throws(() => parseMcpDiscovery({ supportedVersions: ["2026-07-28"], capabilities: { tools: [] } }), /tools capability/);

  assert.deepEqual(parseLegacyMcpInitializeResult({
    protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "server", version: "1" },
  }).supportedVersions, ["2025-11-25"]);
  assert.throws(() => parseLegacyMcpInitializeResult({ protocolVersion: "", capabilities: {}, serverInfo: {} }), /initialize result/);
  assert.throws(() => parseLegacyMcpInitializeResult({ protocolVersion: "2025-11-25", capabilities: { tools: [] }, serverInfo: { name: "s", version: "1" } }), /tools capability/);

  const tool = { name: "read", title: "Read", description: "safe", inputSchema: { type: "object", properties: {} }, outputSchema: {}, annotations: {}, _meta: {} };
  assert.deepEqual(parseMcpToolListPage({ tools: [tool], nextCursor: "next" }).nextCursor, "next");
  assert.throws(() => parseMcpToolListPage({ tools: [tool, tool] }), /Duplicate MCP Tool/);
  for (const invalid of [
    { tools: "bad" },
    { tools: [{ ...tool, name: "" }] },
    { tools: [{ ...tool, inputSchema: { type: "array" } }] },
    { tools: [{ ...tool, outputSchema: [] }] },
  ]) assert.throws(() => parseMcpToolListPage(invalid));

  assert.deepEqual(parseMcpToolCallResult({ content: [{ type: "text", text: "ok" }], structuredContent: { ok: true }, isError: false }), {
    content: [{ type: "text", text: "ok" }], structuredContent: { ok: true }, isError: false,
  });
  assert.throws(() => parseMcpToolCallResult({ content: [{ type: "" }] }), /content block/);
  assert.throws(() => parseMcpToolCallResult({ content: [], structuredContent: [] }), /tools\/call result/);
});

test("ContextBuilder 对终态、断链、损坏消息和陈旧 Checkpoint 保守拒绝", () => {
  const completedStore = new LifecycleStore({ now: () => NOW });
  const completedThread = completedStore.createThread();
  const completedTurn = completedStore.createTurn(completedThread.id);
  completedStore.appendItem(completedTurn.id, "user_message", { text: "done" });
  completedStore.completeTurn(completedTurn.id);
  assert.throws(() => new ContextBuilder(completedStore).build(completedTurn.id), /not in progress/);
  assert.throws(() => new ContextBuilder(completedStore).build("missing"), /Turn not found/);

  const missingThreadStore = new LifecycleStore({ now: () => NOW });
  const missingThread = missingThreadStore.createThread();
  const missingThreadTurn = missingThreadStore.createTurn(missingThread.id);
  missingThreadStore.appendItem(missingThreadTurn.id, "user_message", { text: "current" });
  missingThreadTurn.threadId = "missing-thread";
  assert.throws(() => new ContextBuilder(missingThreadStore).build(missingThreadTurn.id), /Thread not found/);

  const unlinkedStore = new LifecycleStore({ now: () => NOW });
  const unlinkedThread = unlinkedStore.createThread();
  const unlinkedTurn = unlinkedStore.createTurn(unlinkedThread.id);
  unlinkedStore.appendItem(unlinkedTurn.id, "user_message", { text: "current" });
  unlinkedThread.turnIds.length = 0;
  assert.throws(() => new ContextBuilder(unlinkedStore).build(unlinkedTurn.id), /not linked/);

  const badMessageStore = new LifecycleStore({ now: () => NOW });
  const badThread = badMessageStore.createThread();
  const prior = badMessageStore.createTurn(badThread.id);
  badMessageStore.appendItem(prior.id, "user_message", { text: "prior" });
  badMessageStore.appendItem(prior.id, "assistant_message", { unsafe: true });
  badMessageStore.completeTurn(prior.id);
  const current = badMessageStore.createTurn(badThread.id);
  badMessageStore.appendItem(current.id, "user_message", { text: "current" });
  assert.throws(() => new ContextBuilder(badMessageStore).build(current.id), /no valid text/);

  const checkpoints = new ContextCheckpointStore();
  checkpoints.record({
    threadId: badThread.id,
    throughTurnId: "missing-boundary",
    replacementMessages: [{ role: "assistant", text: "summary" }],
    beforeTokens: 10,
    afterTokens: 5,
  });
  assert.throws(() => new ContextBuilder(badMessageStore, checkpoints).build(current.id), /Checkpoint Turn is not linked/);
});

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  return Object.freeze(value);
}
