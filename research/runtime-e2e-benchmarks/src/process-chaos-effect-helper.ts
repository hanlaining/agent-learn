import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isAbsolute } from "node:path";
import { dirname, join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

interface EffectEntry {
  operationId: string;
  payload: string;
  effectId: string;
  effectDigest: string;
  receipt: { receiptId: string; receiptDigest: string; receiptMac: string };
  proof: { proofId: string; proofDigest: string; proofMac: string };
  effectApplyCount: 1;
}

interface EffectLedger {
  schemaVersion: "process-chaos-effect-ledger-v1";
  effects: EffectEntry[];
  audit: { createRequests: number; duplicateCreateRequests: number; proofVerificationRequests: number };
}

const ledgerPath = parseLedgerPath(process.argv.slice(2));
const secretPath = join(dirname(ledgerPath), "helper-secret.bin");
await mkdir(dirname(ledgerPath), { recursive: true });
const secret = await loadOrCreateSecret(secretPath);
let ledger = await loadLedger(ledgerPath);

const server = createServer((request, response) => {
  void handle(request, response).catch((error: unknown) => {
    respondJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  });
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Process Chaos helper failed to bind");
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "process-chaos-effect-helper-ready-v1",
    pid: process.pid,
    baseUrl: `http://127.0.0.1:${address.port}`,
    ledgerPath,
  })}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/audit") {
    respondJson(response, 200, ledger);
    return;
  }
  if (request.method === "POST" && url.pathname === "/effects") {
    const input = JSON.parse(await readBody(request)) as unknown;
    if (!isRecord(input) || !hasExactKeys(input, ["operationId", "payload"]) ||
      typeof input.operationId !== "string" || !/^[a-zA-Z0-9._-]+$/u.test(input.operationId) ||
      typeof input.payload !== "string" || input.payload.length === 0) {
      respondJson(response, 400, { error: "invalid effect input" });
      return;
    }
    ledger.audit.createRequests += 1;
    const existing = ledger.effects.find((item) => item.operationId === input.operationId);
    if (existing !== undefined) {
      if (existing.payload !== input.payload) {
        await persistLedger();
        respondJson(response, 409, { error: "operationId payload mismatch" });
        return;
      }
      ledger.audit.duplicateCreateRequests += 1;
      await persistLedger();
      respondJson(response, 200, existing);
      return;
    }
    const entry = createEffect(input.operationId, input.payload);
    ledger.effects.push(entry);
    await persistLedger();
    respondJson(response, 201, entry);
    return;
  }
  const match = /^\/effects\/([a-zA-Z0-9._-]+)(?:\/(verify-proof))?$/u.exec(url.pathname);
  if (match !== null) {
    const operationId = match[1]!;
    const entry = ledger.effects.find((item) => item.operationId === operationId);
    if (entry === undefined) {
      respondJson(response, 404, { error: "effect not found" });
      return;
    }
    if (request.method === "GET" && match[2] === undefined) {
      respondJson(response, 200, entry);
      return;
    }
    if (request.method === "POST" && match[2] === "verify-proof") {
      const input = JSON.parse(await readBody(request)) as unknown;
      const proof = isRecord(input) && isRecord(input.proof) ? input.proof : undefined;
      ledger.audit.proofVerificationRequests += 1;
      await persistLedger();
      const verified = proof !== undefined && proof.proofId === entry.proof.proofId &&
        proof.proofDigest === entry.proof.proofDigest && proof.proofMac === entry.proof.proofMac &&
        verifyMac(String(proof.proofDigest), String(proof.proofMac));
      respondJson(response, 200, { verified, proofDigest: entry.proof.proofDigest });
      return;
    }
  }
  respondJson(response, 404, { error: "not found" });
}

function createEffect(operationId: string, payload: string): EffectEntry {
  const effectDigest = digest({ operationId, payload });
  const effectId = `effect-${effectDigest.slice(7, 39)}`;
  const receiptDigest = digest({ operationId, effectId, effectDigest });
  const receiptId = `receipt-${receiptDigest.slice(7, 39)}`;
  const proofDigest = digest({ operationId, effectId, effectDigest, receiptId, receiptDigest });
  return {
    operationId,
    payload,
    effectId,
    effectDigest,
    receipt: { receiptId, receiptDigest, receiptMac: mac(receiptDigest) },
    proof: { proofId: `proof-${proofDigest.slice(7, 39)}`, proofDigest, proofMac: mac(proofDigest) },
    effectApplyCount: 1,
  };
}

async function loadLedger(path: string): Promise<EffectLedger> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isRecord(value) || value.schemaVersion !== "process-chaos-effect-ledger-v1" ||
      !Array.isArray(value.effects) || !isRecord(value.audit)) throw new Error("invalid ledger");
    return value as unknown as EffectLedger;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const fresh: EffectLedger = {
      schemaVersion: "process-chaos-effect-ledger-v1",
      effects: [],
      audit: { createRequests: 0, duplicateCreateRequests: 0, proofVerificationRequests: 0 },
    };
    await atomicWrite(path, fresh);
    return fresh;
  }
}

async function loadOrCreateSecret(path: string): Promise<Buffer> {
  try {
    const value = await readFile(path);
    if (value.length !== 32) throw new Error("Invalid Process Chaos helper secret");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const value = randomBytes(32);
    await writeFile(path, value, { flag: "wx" });
    return value;
  }
}

async function persistLedger(): Promise<void> {
  await atomicWrite(ledgerPath, ledger);
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;
}

function mac(value: string): string {
  return `hmac-sha256:${createHmac("sha256", secret).update(value, "utf8").digest("hex")}`;
}

function verifyMac(value: string, candidate: string): boolean {
  const expected = mac(value);
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(candidate, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseLedgerPath(args: string[]): string {
  if (args.length !== 2 || args[0] !== "--ledger" || !isAbsolute(args[1]!)) {
    throw new Error("Usage: process-chaos-effect-helper.ts --ledger <absolute-path>");
  }
  return args[1]!;
}

function respondJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function readBody(request: IncomingMessage): Promise<string> {
  let result = "";
  for await (const chunk of request) result += chunk.toString();
  return result;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
