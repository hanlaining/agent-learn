import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import { strictObjectSchema } from "../llm/tool-schema.js";
import type { AgentTool, AgentToolExecution } from "./tool-registry.js";

export const PROCESS_CHAOS_LOCAL_EFFECT_TOOL_NAME = "process_chaos_local_effect" as const;

export interface ProcessChaosEffectRecord {
  operationId: string;
  payload: string;
  effectId: string;
  effectDigest: string;
  receipt: {
    receiptId: string;
    receiptDigest: string;
    receiptMac: string;
  };
  proof: {
    proofId: string;
    proofDigest: string;
    proofMac: string;
  };
  effectApplyCount: 1;
}

export interface ProcessChaosLocalEffectToolOptions {
  helperBaseUrl: string;
  experimentDirectory: string;
  afterEffectObserved?(record: ProcessChaosEffectRecord): void | Promise<void>;
}

export function createProcessChaosLocalEffectTool(
  options: ProcessChaosLocalEffectToolOptions,
): AgentTool {
  const helperBaseUrl = requireLoopbackHelperUrl(options.helperBaseUrl);
  if (!isAbsolute(options.experimentDirectory)) {
    throw new Error("Process Chaos experiment directory must be absolute");
  }
  return {
    definition: {
      name: PROCESS_CHAOS_LOCAL_EFFECT_TOOL_NAME,
      description: "Test-only local effect ledger Tool. Creates one idempotent file-backed effect or verifies its persisted proof.",
      parameters: strictObjectSchema({
        action: { type: "string", enum: ["create_effect", "verify_proof"] },
        operationId: { type: "string", pattern: "^[a-zA-Z0-9._-]+$" },
        payload: { type: "string", minLength: 1 },
      }),
    },
    requiresPermission: false,
    riskLevel: "sensitive",
    async execute(argumentsJson, context) {
      context.signal.throwIfAborted();
      const input = parseToolArguments(argumentsJson);
      if (input.action === "create_effect") {
        const record = await requestJson<ProcessChaosEffectRecord>(helperBaseUrl, "/effects", {
          method: "POST",
          body: JSON.stringify({ operationId: input.operationId, payload: input.payload }),
          signal: context.signal,
        });
        assertEffectRecord(record, input.operationId, input.payload);
        await options.afterEffectObserved?.(record);
        return effectToolExecution("effect_created", record);
      }
      const record = await queryProcessChaosEffect(helperBaseUrl, input.operationId, context.signal);
      if (record.payload !== input.payload) throw new Error("Process Chaos proof payload mismatch");
      const verification = await requestJson<{ verified: boolean; proofDigest: string }>(
        helperBaseUrl,
        `/effects/${encodeURIComponent(input.operationId)}/verify-proof`,
        { method: "POST", body: JSON.stringify({ proof: record.proof }), signal: context.signal },
      );
      if (verification.verified !== true || verification.proofDigest !== record.proof.proofDigest) {
        throw new Error("Process Chaos helper rejected persisted proof");
      }
      return effectToolExecution("proof_verified", record);
    },
  };
}

export async function queryProcessChaosEffect(
  helperBaseUrl: string,
  operationId: string,
  signal?: AbortSignal,
): Promise<ProcessChaosEffectRecord> {
  const baseUrl = requireLoopbackHelperUrl(helperBaseUrl);
  if (!/^[a-zA-Z0-9._-]+$/u.test(operationId)) throw new Error("Invalid Process Chaos operationId");
  const record = await requestJson<ProcessChaosEffectRecord>(
    baseUrl,
    `/effects/${encodeURIComponent(operationId)}`,
    { method: "GET", ...(signal === undefined ? {} : { signal }) },
  );
  assertEffectRecord(record, operationId, record.payload);
  return record;
}

export function effectToolExecution(
  action: "effect_created" | "proof_verified",
  record: ProcessChaosEffectRecord,
): AgentToolExecution {
  const result = {
    action,
    operationId: record.operationId,
    effectId: record.effectId,
    effectDigest: record.effectDigest,
    receipt: record.receipt,
    proof: record.proof,
    effectApplyCount: record.effectApplyCount,
  };
  return { result, modelOutput: result };
}

export function requireLoopbackHelperUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Process Chaos helper URL must be a valid loopback HTTP URL");
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username !== "" ||
    url.password !== "" || url.search !== "" || url.hash !== "" ||
    (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("Process Chaos helper URL must be loopback http://127.0.0.1:<port>");
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Process Chaos helper URL must include a valid port");
  }
  return `http://127.0.0.1:${port}`;
}

function parseToolArguments(value: string): {
  action: "create_effect" | "verify_proof";
  operationId: string;
  payload: string;
} {
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; } catch { throw new Error("Process Chaos Tool arguments must be valid JSON"); }
  if (!isRecord(parsed) || !hasExactKeys(parsed, ["action", "operationId", "payload"]) ||
    !["create_effect", "verify_proof"].includes(String(parsed.action)) ||
    typeof parsed.operationId !== "string" || !/^[a-zA-Z0-9._-]+$/u.test(parsed.operationId) ||
    typeof parsed.payload !== "string" || parsed.payload.length === 0) {
    throw new Error("Invalid Process Chaos Tool arguments");
  }
  return parsed as ReturnType<typeof parseToolArguments>;
}

function assertEffectRecord(value: unknown, operationId: string, payload: string): asserts value is ProcessChaosEffectRecord {
  if (!isRecord(value) || !hasExactKeys(value, [
    "operationId", "payload", "effectId", "effectDigest", "receipt", "proof", "effectApplyCount",
  ]) || value.operationId !== operationId || value.payload !== payload || value.effectApplyCount !== 1 ||
    !stableDigest(value.effectDigest) || !nonEmpty(value.effectId) || !isRecord(value.receipt) ||
    !hasExactKeys(value.receipt, ["receiptId", "receiptDigest", "receiptMac"]) ||
    ![value.receipt.receiptId, value.receipt.receiptDigest, value.receipt.receiptMac].every(nonEmpty) ||
    !stableDigest(value.receipt.receiptDigest) || !stableMac(value.receipt.receiptMac) || !isRecord(value.proof) ||
    !hasExactKeys(value.proof, ["proofId", "proofDigest", "proofMac"]) ||
    ![value.proof.proofId, value.proof.proofDigest, value.proof.proofMac].every(nonEmpty) ||
    !stableDigest(value.proof.proofDigest) || !stableMac(value.proof.proofMac)) {
    throw new Error("Invalid Process Chaos helper effect record");
  }
  const expectedEffectDigest = digest({ operationId, payload });
  if (value.effectDigest !== expectedEffectDigest || value.effectId !== `effect-${expectedEffectDigest.slice(7, 39)}`) {
    throw new Error("Process Chaos effect digest mismatch");
  }
}

function requestJson<T>(baseUrl: string, pathname: string, init: RequestInit): Promise<T> {
  return fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: { "content-type": "application/json" },
  }).then(async (response) => {
    const body = await response.text();
    if (!response.ok) throw new Error(`Process Chaos helper HTTP ${response.status}: ${body.slice(0, 256)}`);
    return JSON.parse(body) as T;
  });
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;
}

function stableDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function stableMac(value: unknown): value is string {
  return typeof value === "string" && /^hmac-sha256:[a-f0-9]{64}$/u.test(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
