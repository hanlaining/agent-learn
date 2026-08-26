import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import test from "node:test";

import {
  createProcessChaosLocalEffectTool,
  queryProcessChaosEffect,
  type ProcessChaosEffectRecord,
} from "../src/tools/process-chaos-local-effect-tool.js";

interface HelperState {
  record: unknown;
  verify: unknown;
  status: number;
  rawBody?: string;
  requests: Array<{ method: string; url: string; body: string }>;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;
}

function validRecord(operationId = "op-1", payload = "payload"): ProcessChaosEffectRecord {
  const effectDigest = digest({ operationId, payload });
  return {
    operationId,
    payload,
    effectId: `effect-${effectDigest.slice(7, 39)}`,
    effectDigest,
    receipt: {
      receiptId: "receipt-1",
      receiptDigest: `sha256:${"b".repeat(64)}`,
      receiptMac: `hmac-sha256:${"c".repeat(64)}`,
    },
    proof: {
      proofId: "proof-1",
      proofDigest: `sha256:${"d".repeat(64)}`,
      proofMac: `hmac-sha256:${"e".repeat(64)}`,
    },
    effectApplyCount: 1,
  };
}

async function startHelper(): Promise<{ baseUrl: string; server: Server; state: HelperState }> {
  const state: HelperState = {
    record: validRecord(),
    verify: { verified: true, proofDigest: validRecord().proof.proofDigest },
    status: 200,
    requests: [],
  };
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    state.requests.push({ method: request.method ?? "", url: request.url ?? "", body });
    response.statusCode = state.status;
    response.setHeader("content-type", "application/json");
    if (state.rawBody !== undefined) {
      response.end(state.rawBody);
      return;
    }
    response.end(JSON.stringify(request.url?.endsWith("/verify-proof") ? state.verify : state.record));
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return { baseUrl: `http://127.0.0.1:${address.port}`, server, state };
}

test("Process Chaos effect Tool uses real loopback HTTP for create and persisted-proof verification", async (t) => {
  const helper = await startHelper();
  t.after(() => new Promise<void>((resolvePromise, rejectPromise) => {
    helper.server.close((error) => error === undefined ? resolvePromise() : rejectPromise(error));
  }));
  const observed: ProcessChaosEffectRecord[] = [];
  const tool = createProcessChaosLocalEffectTool({
    helperBaseUrl: `${helper.baseUrl}/`,
    experimentDirectory: resolve(".tmp", "process-chaos-hotpaths6"),
    afterEffectObserved: async (record) => { observed.push(record); },
  });
  const signal = new AbortController().signal;

  const created = await tool.execute(JSON.stringify({
    action: "create_effect",
    operationId: "op-1",
    payload: "payload",
  }), { signal });
  assert.equal((created.result as { action: string }).action, "effect_created");
  assert.deepEqual(observed, [validRecord()]);
  assert.deepEqual(helper.state.requests[0], {
    method: "POST",
    url: "/effects",
    body: JSON.stringify({ operationId: "op-1", payload: "payload" }),
  });

  const verified = await tool.execute(JSON.stringify({
    action: "verify_proof",
    operationId: "op-1",
    payload: "payload",
  }), { signal });
  assert.equal((verified.result as { action: string }).action, "proof_verified");
  assert.deepEqual(helper.state.requests.slice(1).map(({ method, url }) => ({ method, url })), [
    { method: "GET", url: "/effects/op-1" },
    { method: "POST", url: "/effects/op-1/verify-proof" },
  ]);
  assert.deepEqual(JSON.parse(helper.state.requests[2]!.body), { proof: validRecord().proof });

  assert.deepEqual(await queryProcessChaosEffect(helper.baseUrl, "op-1", signal), validRecord());
  assert.deepEqual(await queryProcessChaosEffect(helper.baseUrl, "op-1"), validRecord());
});

test("Process Chaos effect Tool fails closed on payload, proof, HTTP and JSON failures", async (t) => {
  const helper = await startHelper();
  t.after(() => new Promise<void>((resolvePromise, rejectPromise) => {
    helper.server.close((error) => error === undefined ? resolvePromise() : rejectPromise(error));
  }));
  const tool = createProcessChaosLocalEffectTool({
    helperBaseUrl: helper.baseUrl,
    experimentDirectory: resolve(".tmp", "process-chaos-hotpaths6"),
  });
  const signal = new AbortController().signal;

  await assert.rejects(async () => tool.execute(JSON.stringify({
    action: "verify_proof", operationId: "op-1", payload: "different",
  }), { signal }), /payload mismatch/u);

  helper.state.verify = { verified: false, proofDigest: validRecord().proof.proofDigest };
  await assert.rejects(async () => tool.execute(JSON.stringify({
    action: "verify_proof", operationId: "op-1", payload: "payload",
  }), { signal }), /rejected persisted proof/u);
  helper.state.verify = { verified: true, proofDigest: `sha256:${"f".repeat(64)}` };
  await assert.rejects(async () => tool.execute(JSON.stringify({
    action: "verify_proof", operationId: "op-1", payload: "payload",
  }), { signal }), /rejected persisted proof/u);

  helper.state.status = 503;
  helper.state.rawBody = "helper unavailable";
  await assert.rejects(() => queryProcessChaosEffect(helper.baseUrl, "op-1"), /HTTP 503: helper unavailable/u);
  helper.state.status = 200;
  helper.state.rawBody = "not-json";
  await assert.rejects(() => queryProcessChaosEffect(helper.baseUrl, "op-1"), /JSON/u);
});

test("Process Chaos effect Tool rejects malformed helper records before reporting evidence", async (t) => {
  const helper = await startHelper();
  t.after(() => new Promise<void>((resolvePromise, rejectPromise) => {
    helper.server.close((error) => error === undefined ? resolvePromise() : rejectPromise(error));
  }));
  const tool = createProcessChaosLocalEffectTool({
    helperBaseUrl: helper.baseUrl,
    experimentDirectory: resolve(".tmp", "process-chaos-hotpaths6"),
  });
  const signal = new AbortController().signal;
  const execute = async () => tool.execute(JSON.stringify({
    action: "create_effect", operationId: "op-1", payload: "payload",
  }), { signal });
  const base = validRecord();
  const invalidRecords: unknown[] = [
    null,
    [],
    { ...base, extra: true },
    { ...base, operationId: "op-2" },
    { ...base, payload: "wrong" },
    { ...base, effectApplyCount: 2 },
    { ...base, effectId: "" },
    { ...base, effectDigest: "sha256:bad" },
    { ...base, receipt: null },
    { ...base, receipt: { ...base.receipt, extra: true } },
    { ...base, receipt: { ...base.receipt, receiptId: "" } },
    { ...base, receipt: { ...base.receipt, receiptDigest: "sha256:bad" } },
    { ...base, receipt: { ...base.receipt, receiptMac: "hmac-sha256:bad" } },
    { ...base, proof: null },
    { ...base, proof: { ...base.proof, extra: true } },
    { ...base, proof: { ...base.proof, proofId: "" } },
    { ...base, proof: { ...base.proof, proofDigest: "sha256:bad" } },
    { ...base, proof: { ...base.proof, proofMac: "hmac-sha256:bad" } },
  ];
  for (const record of invalidRecords) {
    helper.state.record = record;
    await assert.rejects(execute, /Invalid Process Chaos helper effect record/u);
  }

  helper.state.record = { ...base, effectId: `effect-${"0".repeat(32)}` };
  await assert.rejects(execute, /effect digest mismatch/u);
  helper.state.record = { ...base, effectDigest: `sha256:${"0".repeat(64)}`, effectId: `effect-${"0".repeat(32)}` };
  await assert.rejects(execute, /effect digest mismatch/u);
});

test("Process Chaos effect query rejects unsafe operation IDs and helper URLs", async () => {
  await assert.rejects(() => queryProcessChaosEffect("http://127.0.0.1:43123", "bad/id"), /Invalid Process Chaos operationId/u);
  await assert.rejects(() => queryProcessChaosEffect("https://127.0.0.1:43123", "op-1"), /loopback/u);
});
