import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  FORMAL_PACKET_CLAIM_BOUNDARY,
  appendFormalRawLedgerEvent,
  assertFormalRawLedgerAppendOnly,
  validateFormalRawLedger,
  type AppendLedgerEventInput,
  type FormalCasePlan,
  type FormalRawLedger,
  type FormalRawLedgerEvent,
} from "./formal-research-packet.js";

export const PERSISTENT_RUN_LEDGER_SCHEMA_VERSION = "rt95-persistent-run-ledger-v1" as const;
const HEADER_NAME = "run-ledger-header.json";
const EVENTS_DIRECTORY = "events";
const SHA256 = /^[0-9a-f]{64}$/u;

export interface PersistentRunLedgerHeader {
  schemaVersion: typeof PERSISTENT_RUN_LEDGER_SCHEMA_VERSION;
  claimBoundary: typeof FORMAL_PACKET_CLAIM_BOUNDARY;
  packetId: string;
  bindingsSha256: string;
  casePlanSha256: string;
  firstEventSha256: string;
  createdAt: string;
  headerSha256: string;
}

export async function initializePersistentRunLedger(
  rootDirectory: string,
  ledgerValue: unknown,
  plannedCases: readonly FormalCasePlan[],
): Promise<FormalRawLedger> {
  const ledger = validateFormalRawLedger(ledgerValue, plannedCases);
  if (ledger.status !== "open" || ledger.events.length !== 1 || ledger.events[0]?.eventType !== "ledger-opened") {
    throw new Error("persistent run ledger initialization requires exactly one ledger-opened event");
  }
  const root = path.resolve(rootDirectory);
  if (await lstat(root).catch(() => undefined) !== undefined) {
    throw new Error("persistent run ledger root already exists; overwrite and replay are forbidden");
  }
  const headerWithoutHash = {
    schemaVersion: PERSISTENT_RUN_LEDGER_SCHEMA_VERSION,
    claimBoundary: FORMAL_PACKET_CLAIM_BOUNDARY,
    packetId: ledger.packetId,
    bindingsSha256: ledger.bindingsSha256,
    casePlanSha256: digestCanonical(plannedCases),
    firstEventSha256: ledger.events[0].eventSha256,
    createdAt: ledger.events[0].occurredAt,
  };
  const header: PersistentRunLedgerHeader = {
    ...headerWithoutHash,
    headerSha256: digestCanonical(headerWithoutHash),
  };
  await mkdir(path.join(root, EVENTS_DIRECTORY), { recursive: true });
  await writeExclusive(path.join(root, HEADER_NAME), serialize(header));
  await writeExclusive(eventPath(root, 0), serialize(ledger.events[0]));
  return readPersistentRunLedger(root, plannedCases);
}

export async function appendPersistentRunLedgerEvent(
  rootDirectory: string,
  plannedCases: readonly FormalCasePlan[],
  input: AppendLedgerEventInput,
): Promise<FormalRawLedger> {
  const previous = await readPersistentRunLedger(rootDirectory, plannedCases);
  const next = appendFormalRawLedgerEvent(previous, plannedCases, input);
  assertFormalRawLedgerAppendOnly(previous, next, plannedCases);
  const appended = next.events.at(-1)!;
  await writeExclusive(eventPath(path.resolve(rootDirectory), appended.sequence), serialize(appended));
  return readPersistentRunLedger(rootDirectory, plannedCases);
}

export async function readPersistentRunLedger(
  rootDirectory: string,
  plannedCases: readonly FormalCasePlan[],
): Promise<FormalRawLedger> {
  const root = path.resolve(rootDirectory);
  await assertDirectory(root, "persistent run ledger root is missing or unsafe");
  const rootEntries = await readdir(root, { withFileTypes: true });
  const rootNames = rootEntries.map((entry) => entry.name).sort();
  if (JSON.stringify(rootNames) !== JSON.stringify([EVENTS_DIRECTORY, HEADER_NAME].sort())) {
    throw new Error("persistent run ledger contains missing or unexpected root entries");
  }
  for (const entry of rootEntries) {
    if (entry.isSymbolicLink()) throw new Error("symbolic links are forbidden in persistent run ledgers");
  }
  const header = await readCanonicalJson(path.join(root, HEADER_NAME)) as PersistentRunLedgerHeader;
  validateHeader(header, plannedCases);

  const eventsRoot = path.join(root, EVENTS_DIRECTORY);
  await assertDirectory(eventsRoot, "persistent run ledger events directory is missing or unsafe");
  const entries = await readdir(eventsRoot, { withFileTypes: true });
  if (entries.length === 0) throw new Error("persistent run ledger has no event files");
  const eventNames = entries.map((entry) => {
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("persistent run ledger events must be regular files");
    if (!/^\d{6}\.json$/u.test(entry.name)) throw new Error(`unexpected persistent ledger event file: ${entry.name}`);
    return entry.name;
  }).sort();
  const events: FormalRawLedgerEvent[] = [];
  for (const [index, name] of eventNames.entries()) {
    const expectedName = `${String(index).padStart(6, "0")}.json`;
    if (name !== expectedName) throw new Error(`persistent run ledger event sequence has a gap, deletion, reorder, or replay at ${name}`);
    const event = await readCanonicalJson(path.join(eventsRoot, name)) as FormalRawLedgerEvent;
    if (event.sequence !== index) throw new Error(`persistent run ledger event sequence mismatch at ${name}`);
    events.push(event);
  }
  if (events[0]?.eventSha256 !== header.firstEventSha256) {
    throw new Error("persistent run ledger first event does not match immutable header");
  }
  const ledger: FormalRawLedger = {
    schemaVersion: "rt95-formal-raw-ledger-v1",
    claimBoundary: FORMAL_PACKET_CLAIM_BOUNDARY,
    packetId: header.packetId,
    bindingsSha256: header.bindingsSha256,
    status: events.at(-1)?.eventType === "ledger-sealed" ? "sealed" : "open",
    events,
  };
  return validateFormalRawLedger(ledger, plannedCases);
}

function validateHeader(value: PersistentRunLedgerHeader, plannedCases: readonly FormalCasePlan[]): void {
  const record = value as unknown as Record<string, unknown>;
  exactKeys(record, ["schemaVersion", "claimBoundary", "packetId", "bindingsSha256", "casePlanSha256", "firstEventSha256", "createdAt", "headerSha256"], "persistent ledger header");
  if (value.schemaVersion !== PERSISTENT_RUN_LEDGER_SCHEMA_VERSION) throw new Error("persistent ledger header schema mismatch");
  if (value.claimBoundary !== FORMAL_PACKET_CLAIM_BOUNDARY) throw new Error("persistent ledger header claim boundary mismatch");
  for (const [digest, label] of [
    [value.bindingsSha256, "bindingsSha256"],
    [value.casePlanSha256, "casePlanSha256"],
    [value.firstEventSha256, "firstEventSha256"],
    [value.headerSha256, "headerSha256"],
  ] as const) {
    if (!SHA256.test(digest)) throw new Error(`persistent ledger header ${label} is invalid`);
  }
  if (value.casePlanSha256 !== digestCanonical(plannedCases)) throw new Error("persistent ledger case plan digest mismatch");
  const { headerSha256: _omitted, ...withoutHash } = value;
  if (value.headerSha256 !== digestCanonical(withoutHash)) throw new Error("persistent ledger header digest mismatch");
  if (!Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt) {
    throw new Error("persistent ledger createdAt must be canonical UTC");
  }
}

async function readCanonicalJson(absolutePath: string): Promise<unknown> {
  const status = await lstat(absolutePath).catch(() => undefined);
  if (status === undefined || !status.isFile() || status.isSymbolicLink()) throw new Error(`persistent ledger file is missing or unsafe: ${path.basename(absolutePath)}`);
  const bytes = await readFile(absolutePath, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(bytes) as unknown;
  } catch {
    throw new Error(`persistent ledger file is not valid JSON: ${path.basename(absolutePath)}`);
  }
  if (bytes !== serialize(value)) throw new Error(`persistent ledger file is not canonical: ${path.basename(absolutePath)}`);
  return value;
}

async function writeExclusive(absolutePath: string, content: string): Promise<void> {
  await writeFile(absolutePath, content, { encoding: "utf8", flag: "wx" }).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new Error("persistent run ledger append target already exists; overwrite or concurrent replay refused");
    }
    throw error;
  });
}

async function assertDirectory(absolutePath: string, message: string): Promise<void> {
  const status = await lstat(absolutePath).catch(() => undefined);
  if (status === undefined || !status.isDirectory() || status.isSymbolicLink()) throw new Error(message);
}

function eventPath(root: string, sequence: number): string {
  return path.join(root, EVENTS_DIRECTORY, `${String(sequence).padStart(6, "0")}.json`);
}

function serialize(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function digestCanonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortKeys(value)), "utf8").digest("hex");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortKeys(record[key])]));
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(`${label} key mismatch`);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
