import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assertPublishableArtifactContent,
  inferContentType,
  normalizeSafeRelativePath,
} from "./manifest.js";
import type { ArtifactContentType, ArtifactFileEntry } from "./types.js";

export const PUBLISHABLE_DERIVATION_RECEIPT_SCHEMA_VERSION = "publishable-derivation-receipt-v1" as const;
export const PUBLISHABLE_CLAIM_BOUNDARY = "sanitized-local-derivation-only-not-formal-or-external" as const;
export const DEFAULT_DERIVATION_RECEIPT_PATH = "publishable-derivation-receipt.json" as const;
const SHA256 = /^[0-9a-f]{64}$/u;

interface PrivateSourceEntry {
  path: string;
  bytes: number;
  sha256: string;
  contentType: ArtifactContentType;
}

export interface PublishableDerivationReceipt {
  schemaVersion: typeof PUBLISHABLE_DERIVATION_RECEIPT_SCHEMA_VERSION;
  claimBoundary: typeof PUBLISHABLE_CLAIM_BOUNDARY;
  policy: {
    mode: "explicit-allowlist";
    allowlistSha256: string;
    privatePathsDisclosed: false;
    secretsCopied: false;
  };
  privateSource: {
    treeSha256: string;
    fileCount: number;
    byteCount: number;
  };
  publicDerivation: {
    treeSha256: string;
    fileCount: number;
    byteCount: number;
    excludedFileCount: number;
    files: ArtifactFileEntry[];
  };
  receiptSha256: string;
}

export async function createPublishableDerivation(options: {
  privateRootDirectory: string;
  publicRootDirectory: string;
  allowPaths: readonly string[];
}): Promise<PublishableDerivationReceipt> {
  const privateRoot = await resolveExistingDirectory(options.privateRootDirectory, "private source root");
  const publicRoot = path.resolve(options.publicRootDirectory);
  assertSeparateRoots(privateRoot, publicRoot);
  if (await lstat(publicRoot).catch(() => undefined) !== undefined) {
    throw new Error("publishable output root already exists; overwrite and replay are forbidden");
  }
  const allowPaths = normalizeAllowlist(options.allowPaths);
  const privateFiles = await collectPrivateSource(privateRoot);
  const privateByPath = new Map(privateFiles.map((entry) => [entry.path, entry]));
  const prepared: Array<{ entry: ArtifactFileEntry; content: Buffer }> = [];
  for (const relativePath of allowPaths) {
    const source = privateByPath.get(relativePath);
    if (source === undefined) throw new Error(`publishable allowlist path is missing from private source: ${relativePath}`);
    const content = await readFile(resolveInside(privateRoot, relativePath));
    assertPublishableArtifactContent(relativePath, content);
    prepared.push({
      entry: {
        path: relativePath,
        bytes: source.bytes,
        sha256: source.sha256,
        contentType: source.contentType,
      },
      content,
    });
  }
  const publicFiles = prepared.map((item) => item.entry);
  const withoutHash = {
    schemaVersion: PUBLISHABLE_DERIVATION_RECEIPT_SCHEMA_VERSION,
    claimBoundary: PUBLISHABLE_CLAIM_BOUNDARY,
    policy: {
      mode: "explicit-allowlist" as const,
      allowlistSha256: digestCanonical(allowPaths),
      privatePathsDisclosed: false as const,
      secretsCopied: false as const,
    },
    privateSource: {
      treeSha256: treeDigest(privateFiles),
      fileCount: privateFiles.length,
      byteCount: privateFiles.reduce((sum, item) => sum + item.bytes, 0),
    },
    publicDerivation: {
      treeSha256: treeDigest(publicFiles),
      fileCount: publicFiles.length,
      byteCount: publicFiles.reduce((sum, item) => sum + item.bytes, 0),
      excludedFileCount: privateFiles.length - publicFiles.length,
      files: publicFiles,
    },
  };
  const receipt: PublishableDerivationReceipt = {
    ...withoutHash,
    receiptSha256: digestCanonical(withoutHash),
  };
  await mkdir(publicRoot, { recursive: false });
  for (const item of prepared) {
    const target = resolveInside(publicRoot, item.entry.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeExclusive(target, item.content);
  }
  await writeExclusive(
    path.join(publicRoot, DEFAULT_DERIVATION_RECEIPT_PATH),
    serialize(receipt),
  );
  return verifyPublishableDerivation({ privateRootDirectory: privateRoot, publicRootDirectory: publicRoot });
}

export async function verifyPublishableDerivation(options: {
  privateRootDirectory: string;
  publicRootDirectory: string;
}): Promise<PublishableDerivationReceipt> {
  const privateRoot = await resolveExistingDirectory(options.privateRootDirectory, "private source root");
  const publicRoot = await resolveExistingDirectory(options.publicRootDirectory, "publishable output root");
  assertSeparateRoots(privateRoot, publicRoot);
  const receiptPath = path.join(publicRoot, DEFAULT_DERIVATION_RECEIPT_PATH);
  const receiptBytes = await readFile(receiptPath, "utf8").catch(() => {
    throw new Error("publishable derivation receipt is missing");
  });
  let receipt: unknown;
  try {
    receipt = JSON.parse(receiptBytes) as unknown;
  } catch {
    throw new Error("publishable derivation receipt is not valid JSON");
  }
  validatePublishableDerivationReceipt(receipt);
  if (receiptBytes !== serialize(receipt)) throw new Error("publishable derivation receipt is not canonical");

  const privateFiles = await collectPrivateSource(privateRoot);
  const privateByPath = new Map(privateFiles.map((entry) => [entry.path, entry]));
  if (receipt.privateSource.treeSha256 !== treeDigest(privateFiles)
    || receipt.privateSource.fileCount !== privateFiles.length
    || receipt.privateSource.byteCount !== privateFiles.reduce((sum, item) => sum + item.bytes, 0)) {
    throw new Error("private source digest, count, or bytes drifted after derivation");
  }

  const publicFiles = await collectPublicFiles(publicRoot);
  const expectedPaths = receipt.publicDerivation.files.map((entry) => entry.path);
  const actualPaths = publicFiles.map((entry) => entry.path);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    const missing = expectedPaths.filter((item) => !actualPaths.includes(item));
    const extra = actualPaths.filter((item) => !expectedPaths.includes(item));
    throw new Error(`publishable file set drift; missing=[${missing.join(",")}], extra=[${extra.join(",")}]`);
  }
  for (const expected of receipt.publicDerivation.files) {
    const actual = publicFiles.find((entry) => entry.path === expected.path)!;
    if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`publishable artifact digest drift: ${expected.path}`);
    const privateSource = privateByPath.get(expected.path);
    if (privateSource === undefined || canonicalJson(privateSource) !== canonicalJson(expected)) {
      throw new Error(`publishable artifact is not an exact derivation of private source: ${expected.path}`);
    }
  }
  if (receipt.publicDerivation.treeSha256 !== treeDigest(publicFiles)
    || receipt.publicDerivation.fileCount !== publicFiles.length
    || receipt.publicDerivation.byteCount !== publicFiles.reduce((sum, item) => sum + item.bytes, 0)
    || receipt.publicDerivation.excludedFileCount !== privateFiles.length - publicFiles.length) {
    throw new Error("publishable derivation summary drift");
  }
  if (receipt.policy.allowlistSha256 !== digestCanonical(actualPaths)) throw new Error("publishable allowlist digest drift");
  return receipt;
}

export function validatePublishableDerivationReceipt(value: unknown): asserts value is PublishableDerivationReceipt {
  if (!isRecord(value)) throw new Error("publishable receipt schema violation: root");
  exactKeys(value, ["schemaVersion", "claimBoundary", "policy", "privateSource", "publicDerivation", "receiptSha256"], "receipt");
  if (value.schemaVersion !== PUBLISHABLE_DERIVATION_RECEIPT_SCHEMA_VERSION) throw new Error("publishable receipt schema version mismatch");
  if (value.claimBoundary !== PUBLISHABLE_CLAIM_BOUNDARY) throw new Error("publishable receipt claim boundary mismatch");
  const policy = record(value.policy, "receipt.policy");
  exactKeys(policy, ["mode", "allowlistSha256", "privatePathsDisclosed", "secretsCopied"], "receipt.policy");
  if (policy.mode !== "explicit-allowlist" || policy.privatePathsDisclosed !== false || policy.secretsCopied !== false) {
    throw new Error("publishable receipt policy overclaims or discloses private data");
  }
  digest(policy.allowlistSha256, "receipt.policy.allowlistSha256");
  const privateSource = record(value.privateSource, "receipt.privateSource");
  exactKeys(privateSource, ["treeSha256", "fileCount", "byteCount"], "receipt.privateSource");
  digest(privateSource.treeSha256, "receipt.privateSource.treeSha256");
  nonNegativeInteger(privateSource.fileCount, "receipt.privateSource.fileCount");
  nonNegativeInteger(privateSource.byteCount, "receipt.privateSource.byteCount");
  const publicDerivation = record(value.publicDerivation, "receipt.publicDerivation");
  exactKeys(publicDerivation, ["treeSha256", "fileCount", "byteCount", "excludedFileCount", "files"], "receipt.publicDerivation");
  digest(publicDerivation.treeSha256, "receipt.publicDerivation.treeSha256");
  nonNegativeInteger(publicDerivation.fileCount, "receipt.publicDerivation.fileCount");
  nonNegativeInteger(publicDerivation.byteCount, "receipt.publicDerivation.byteCount");
  nonNegativeInteger(publicDerivation.excludedFileCount, "receipt.publicDerivation.excludedFileCount");
  if (!Array.isArray(publicDerivation.files)) throw new Error("publishable receipt files must be an array");
  let previous: string | undefined;
  const seen = new Set<string>();
  for (const [index, item] of publicDerivation.files.entries()) {
    const entry = record(item, `receipt.publicDerivation.files[${index}]`);
    exactKeys(entry, ["path", "bytes", "sha256", "contentType"], `receipt file[${index}]`);
    if (typeof entry.path !== "string") throw new Error("publishable receipt file path must be a string");
    const safePath = normalizeSafeRelativePath(entry.path, "publishable receipt file path");
    if (safePath === DEFAULT_DERIVATION_RECEIPT_PATH || seen.has(safePath) || (previous !== undefined && previous >= safePath)) {
      throw new Error("publishable receipt file order, uniqueness, or self-inclusion violation");
    }
    seen.add(safePath);
    previous = safePath;
    nonNegativeInteger(entry.bytes, `receipt file[${index}].bytes`);
    digest(entry.sha256, `receipt file[${index}].sha256`);
    if (entry.contentType !== inferContentType(safePath)) throw new Error("publishable receipt content type mismatch");
  }
  if (publicDerivation.fileCount !== publicDerivation.files.length) throw new Error("publishable receipt file count mismatch");
  digest(value.receiptSha256, "receipt.receiptSha256");
  const { receiptSha256: _omitted, ...withoutHash } = value;
  if (value.receiptSha256 !== digestCanonical(withoutHash)) throw new Error("publishable receipt digest mismatch");
}

async function collectPrivateSource(root: string): Promise<PrivateSourceEntry[]> {
  const files: PrivateSourceEntry[] = [];
  await walk("");
  return files.sort((left, right) => left.path.localeCompare(right.path, "en"));

  async function walk(relativeDirectory: string): Promise<void> {
    const directory = relativeDirectory === "" ? root : resolveInside(root, relativeDirectory);
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      const safePath = normalizeSafeRelativePath(relativePath, "private source path");
      if (entry.isSymbolicLink()) throw new Error(`symbolic links are forbidden in private sources: ${safePath}`);
      if (entry.isDirectory()) await walk(safePath);
      else if (entry.isFile()) {
        const content = await readFile(resolveInside(root, safePath));
        files.push({
          path: safePath,
          bytes: content.byteLength,
          sha256: createHash("sha256").update(content).digest("hex"),
          contentType: inferContentType(safePath),
        });
      } else throw new Error(`unsupported private source entry: ${safePath}`);
    }
  }
}

async function collectPublicFiles(root: string): Promise<ArtifactFileEntry[]> {
  const all = await collectPrivateSource(root);
  const files: ArtifactFileEntry[] = [];
  for (const entry of all) {
    if (entry.path === DEFAULT_DERIVATION_RECEIPT_PATH) continue;
    const content = await readFile(resolveInside(root, entry.path));
    assertPublishableArtifactContent(entry.path, content);
    files.push(entry);
  }
  return files;
}

function normalizeAllowlist(values: readonly string[]): string[] {
  if (values.length === 0) throw new Error("publishable allowlist cannot be empty");
  const normalized = values.map((value) => normalizeSafeRelativePath(value, "publishable allowlist path")).sort();
  if (new Set(normalized).size !== normalized.length) throw new Error("publishable allowlist contains duplicates");
  if (normalized.includes(DEFAULT_DERIVATION_RECEIPT_PATH)) throw new Error("publishable allowlist cannot include the receipt itself");
  return normalized;
}

async function resolveExistingDirectory(input: string, label: string): Promise<string> {
  const root = path.resolve(input);
  const status = await lstat(root).catch(() => undefined);
  if (status === undefined || !status.isDirectory() || status.isSymbolicLink()) throw new Error(`${label} must be an existing non-symbolic directory`);
  return root;
}

function assertSeparateRoots(privateRoot: string, publicRoot: string): void {
  const publicFromPrivate = path.relative(privateRoot, publicRoot);
  const privateFromPublic = path.relative(publicRoot, privateRoot);
  if (publicFromPrivate === "" || (!publicFromPrivate.startsWith(`..${path.sep}`) && !path.isAbsolute(publicFromPrivate))
    || (!privateFromPublic.startsWith(`..${path.sep}`) && !path.isAbsolute(privateFromPublic))) {
    throw new Error("private and publishable roots must be separate and non-nested");
  }
}

function resolveInside(root: string, relativePath: string): string {
  const safe = normalizeSafeRelativePath(relativePath, "artifact path");
  const absolute = path.resolve(root, ...safe.split("/"));
  const relative = path.relative(root, absolute);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("artifact path escapes root");
  return absolute;
}

async function writeExclusive(absolutePath: string, content: string | Buffer): Promise<void> {
  await writeFile(absolutePath, content, { flag: "wx" }).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "EEXIST") throw new Error("publishable derivation refuses overwrite or replay");
    throw error;
  });
}

function treeDigest(files: readonly Pick<PrivateSourceEntry, "path" | "bytes" | "sha256" | "contentType">[]): string {
  return digestCanonical(files);
}

function serialize(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function digestCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(`${label} key mismatch`);
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be SHA-256`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} must be a non-negative integer`);
  return Number(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
