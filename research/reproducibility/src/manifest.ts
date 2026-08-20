import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ARTIFACT_MANIFEST_SCHEMA_VERSION,
  DEFAULT_MANIFEST_PATH,
  type ArtifactContentType,
  type ArtifactFileEntry,
  type ArtifactManifest,
  type ArtifactProviderKind,
  type CreateArtifactManifestOptions,
  type VerifyArtifactManifestOptions,
} from "./types.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const SAFE_OS_VALUE_PATTERN = /^[A-Za-z0-9._+-]+$/u;
const SENSITIVE_FILE_PATTERN = /^(?:\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?)$/iu;
const SENSITIVE_EXTENSION_PATTERN = /\.(?:key|pem|p12|pfx)$/iu;
const SECRET_CONTENT_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\bsk-[A-Za-z0-9_-]{20,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/iu,
] as const;
const MACHINE_ABSOLUTE_PATH_PATTERN = /(?:^|[\s"'=:,[{(])(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|root|tmp|var|etc)\/)/imu;

export async function createArtifactManifest(
  options: CreateArtifactManifestOptions,
): Promise<ArtifactManifest> {
  const layout = await resolveLayout(options.rootDirectory, options.manifestPath);
  const metadata = validateCreateMetadata(options);
  const files = await collectArtifactFiles(layout.rootDirectory, layout.manifestPath);
  const manifest: ArtifactManifest = {
    schemaVersion: ARTIFACT_MANIFEST_SCHEMA_VERSION,
    baselineCommit: metadata.baselineCommit,
    run: {
      command: metadata.command,
      startedAt: metadata.startedAt,
      finishedAt: metadata.finishedAt,
    },
    environment: {
      node: process.version,
      os: {
        platform: process.platform,
        arch: process.arch,
        release: os.release(),
      },
    },
    provider: {
      kind: metadata.providerKind,
      realApiCalls: false,
      credentialsRead: false,
    },
    files,
  };
  validateArtifactManifest(manifest, layout.manifestPath);
  await assertWritableManifestTarget(layout.manifestAbsolutePath);
  await mkdir(path.dirname(layout.manifestAbsolutePath), { recursive: true });
  await writeFile(layout.manifestAbsolutePath, serializeArtifactManifest(manifest, layout.manifestPath), {
    encoding: "utf8",
  });
  return manifest;
}

export async function verifyArtifactManifest(
  options: VerifyArtifactManifestOptions,
): Promise<ArtifactManifest> {
  const layout = await resolveLayout(options.rootDirectory, options.manifestPath);
  await assertRegularFile(layout.manifestAbsolutePath, "manifest is missing or is not a regular file");
  const serialized = await readFile(layout.manifestAbsolutePath, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error("manifest is not valid JSON");
  }
  validateArtifactManifest(value, layout.manifestPath);
  if (serialized !== serializeArtifactManifest(value, layout.manifestPath)) {
    throw new Error("manifest is not in canonical serialized form");
  }

  const actualFiles = await collectArtifactFiles(layout.rootDirectory, layout.manifestPath);
  const expectedByPath = new Map(value.files.map((entry) => [entry.path, entry]));
  const actualByPath = new Map(actualFiles.map((entry) => [entry.path, entry]));
  const missing = value.files.filter((entry) => !actualByPath.has(entry.path)).map((entry) => entry.path);
  const extra = actualFiles.filter((entry) => !expectedByPath.has(entry.path)).map((entry) => entry.path);
  if (missing.length > 0) throw new Error(`artifact files are missing: ${missing.join(", ")}`);
  if (extra.length > 0) throw new Error(`unexpected artifact files found: ${extra.join(", ")}`);

  for (const expected of value.files) {
    const actual = actualByPath.get(expected.path);
    if (actual === undefined) throw new Error(`artifact file is missing: ${expected.path}`);
    if (actual.bytes !== expected.bytes) throw new Error(`artifact byte count mismatch: ${expected.path}`);
    if (actual.sha256 !== expected.sha256) throw new Error(`artifact SHA-256 mismatch: ${expected.path}`);
    if (actual.contentType !== expected.contentType) throw new Error(`artifact content type mismatch: ${expected.path}`);
  }
  return value;
}

export function serializeArtifactManifest(
  manifest: ArtifactManifest,
  manifestPath: string = DEFAULT_MANIFEST_PATH,
): string {
  validateArtifactManifest(manifest, manifestPath);
  return `${JSON.stringify(sortObjectKeys(manifest), null, 2)}\n`;
}

export function validateArtifactManifest(
  value: unknown,
  manifestPath: string = DEFAULT_MANIFEST_PATH,
): asserts value is ArtifactManifest {
  if (!isRecord(value)) throw new Error("manifest schema violation: root");
  assertExactKeys(value, ["baselineCommit", "environment", "files", "provider", "run", "schemaVersion"], "root");
  if (value.schemaVersion !== ARTIFACT_MANIFEST_SCHEMA_VERSION) throw new Error("manifest schema violation: schemaVersion");
  if (typeof value.baselineCommit !== "string" || !COMMIT_PATTERN.test(value.baselineCommit)) {
    throw new Error("manifest schema violation: baselineCommit must be a lowercase 40-character commit hash");
  }
  validateRun(value.run);
  validateEnvironment(value.environment);
  validateProvider(value.provider);
  if (!Array.isArray(value.files)) throw new Error("manifest schema violation: files");

  const safeManifestPath = normalizeSafeRelativePath(manifestPath, "manifest path");
  const paths = new Set<string>();
  let previousPath: string | undefined;
  for (const item of value.files) {
    if (!isRecord(item)) throw new Error("manifest schema violation: file entry");
    assertExactKeys(item, ["bytes", "contentType", "path", "sha256"], "file entry");
    if (typeof item.path !== "string") throw new Error("manifest schema violation: file path");
    const safePath = normalizeSafeRelativePath(item.path, "artifact path");
    if (safePath !== item.path) throw new Error(`artifact path is not normalized: ${item.path}`);
    if (safePath === safeManifestPath) throw new Error("manifest must not include itself");
    if (paths.has(safePath)) throw new Error(`duplicate artifact path: ${safePath}`);
    if (previousPath !== undefined && compareStrings(previousPath, safePath) >= 0) {
      throw new Error("artifact file entries are not in deterministic path order");
    }
    paths.add(safePath);
    previousPath = safePath;
    assertArtifactFileNameSafe(safePath);
    if (!Number.isSafeInteger(item.bytes) || Number(item.bytes) < 0) throw new Error(`invalid byte count: ${safePath}`);
    if (typeof item.sha256 !== "string" || !SHA256_PATTERN.test(item.sha256)) throw new Error(`invalid SHA-256: ${safePath}`);
    if (item.contentType !== inferContentType(safePath)) throw new Error(`invalid content type: ${safePath}`);
  }
}

export function normalizeSafeRelativePath(value: string, label = "path"): string {
  if (value.length === 0 || value.includes("\0") || value.includes("\\")) throw new Error(`${label} must be a safe relative POSIX path`);
  if (value !== value.normalize("NFC") || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new Error(`${label} must be a normalized relative path`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`${label} contains an unsafe path segment`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized.startsWith("../")) throw new Error(`${label} escapes the artifact root`);
  return normalized;
}

export function inferContentType(relativePath: string): ArtifactContentType {
  switch (path.posix.extname(relativePath).toLowerCase()) {
    case ".json": return "application/json";
    case ".jsonl":
    case ".ndjson": return "application/x-ndjson";
    case ".csv": return "text/csv";
    case ".md": return "text/markdown";
    case ".txt":
    case ".log":
    case ".repro": return "text/plain";
    case ".yaml":
    case ".yml": return "application/yaml";
    case ".pdf": return "application/pdf";
    case ".zip": return "application/zip";
    default: return "application/octet-stream";
  }
}

async function collectArtifactFiles(rootDirectory: string, manifestPath: string): Promise<ArtifactFileEntry[]> {
  const files: ArtifactFileEntry[] = [];
  await walk("");
  files.sort((left, right) => compareStrings(left.path, right.path));
  return files;

  async function walk(relativeDirectory: string): Promise<void> {
    const absoluteDirectory = relativeDirectory === "" ? rootDirectory : path.join(rootDirectory, ...relativeDirectory.split("/"));
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    entries.sort((left, right) => compareStrings(left.name, right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      const safePath = normalizeSafeRelativePath(relativePath, "artifact path");
      if (entry.isSymbolicLink()) throw new Error(`symbolic links are not allowed in artifacts: ${safePath}`);
      if (entry.isDirectory()) {
        await walk(safePath);
      } else if (entry.isFile()) {
        if (safePath === manifestPath) continue;
        assertArtifactFileNameSafe(safePath);
        const content = await readFile(path.join(rootDirectory, ...safePath.split("/")));
        assertNoHighConfidenceSecrets(content, safePath, inferContentType(safePath));
        files.push({
          path: safePath,
          bytes: content.byteLength,
          sha256: createHash("sha256").update(content).digest("hex"),
          contentType: inferContentType(safePath),
        });
      } else {
        throw new Error(`unsupported filesystem entry in artifact: ${safePath}`);
      }
    }
  }
}

async function resolveLayout(rootInput: string, manifestInput: string = DEFAULT_MANIFEST_PATH): Promise<{
  rootDirectory: string;
  manifestPath: string;
  manifestAbsolutePath: string;
}> {
  if (rootInput.length === 0) throw new Error("artifact root is required");
  const rootDirectory = path.resolve(rootInput);
  const rootStatus = await lstat(rootDirectory).catch(() => undefined);
  if (rootStatus === undefined || !rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
    throw new Error("artifact root must be an existing, non-symbolic-link directory");
  }
  const manifestPath = normalizeSafeRelativePath(manifestInput, "manifest path");
  const manifestAbsolutePath = path.resolve(rootDirectory, ...manifestPath.split("/"));
  const relativeCheck = path.relative(rootDirectory, manifestAbsolutePath);
  if (relativeCheck === "" || relativeCheck.startsWith(`..${path.sep}`) || path.isAbsolute(relativeCheck)) {
    throw new Error("manifest path escapes the artifact root");
  }
  return { rootDirectory, manifestPath, manifestAbsolutePath };
}

function validateCreateMetadata(options: CreateArtifactManifestOptions): {
  baselineCommit: string;
  command: string;
  startedAt: string;
  finishedAt: string;
  providerKind: ArtifactProviderKind;
} {
  const probe: ArtifactManifest = {
    schemaVersion: ARTIFACT_MANIFEST_SCHEMA_VERSION,
    baselineCommit: options.baselineCommit,
    run: { command: options.command, startedAt: options.startedAt, finishedAt: options.finishedAt },
    environment: { node: process.version, os: { platform: process.platform, arch: process.arch, release: os.release() } },
    provider: { kind: options.providerKind, realApiCalls: false, credentialsRead: false },
    files: [],
  };
  validateArtifactManifest(probe, options.manifestPath);
  return {
    baselineCommit: probe.baselineCommit,
    command: probe.run.command,
    startedAt: probe.run.startedAt,
    finishedAt: probe.run.finishedAt,
    providerKind: probe.provider.kind,
  };
}

function validateRun(value: unknown): void {
  if (!isRecord(value)) throw new Error("manifest schema violation: run");
  assertExactKeys(value, ["command", "finishedAt", "startedAt"], "run");
  if (typeof value.command !== "string" || value.command.length === 0 || value.command.length > 4096 || /[\r\n]/u.test(value.command)) {
    throw new Error("manifest schema violation: run command");
  }
  assertCommandContainsNoSensitiveData(value.command);
  const startedAt = validateIsoTimestamp(value.startedAt, "startedAt");
  const finishedAt = validateIsoTimestamp(value.finishedAt, "finishedAt");
  if (finishedAt < startedAt) throw new Error("manifest schema violation: finishedAt precedes startedAt");
}

function validateEnvironment(value: unknown): void {
  if (!isRecord(value)) throw new Error("manifest schema violation: environment");
  assertExactKeys(value, ["node", "os"], "environment");
  if (typeof value.node !== "string" || !/^v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(value.node)) {
    throw new Error("manifest schema violation: Node version");
  }
  if (!isRecord(value.os)) throw new Error("manifest schema violation: OS");
  assertExactKeys(value.os, ["arch", "platform", "release"], "OS");
  for (const key of ["platform", "arch", "release"] as const) {
    if (typeof value.os[key] !== "string" || !SAFE_OS_VALUE_PATTERN.test(value.os[key])) {
      throw new Error(`manifest schema violation: OS ${key}`);
    }
  }
}

function validateProvider(value: unknown): void {
  if (!isRecord(value)) throw new Error("manifest schema violation: provider");
  assertExactKeys(value, ["credentialsRead", "kind", "realApiCalls"], "provider");
  if (value.kind !== "none" && value.kind !== "deterministic-fake") throw new Error("manifest schema violation: provider kind");
  if (value.realApiCalls !== false || value.credentialsRead !== false) {
    throw new Error("manifest must declare zero real Provider calls and zero credential reads");
  }
}

function validateIsoTimestamp(value: unknown, label: string): number {
  if (typeof value !== "string") throw new Error(`manifest schema violation: ${label}`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error(`manifest schema violation: ${label} must be canonical ISO-8601 UTC`);
  }
  return timestamp;
}

function assertCommandContainsNoSensitiveData(command: string): void {
  const containsAbsolutePath = /(?:^|[\s"'=])(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|root|tmp|var|etc)\/)/u.test(command);
  const containsEnvironmentValue = /(?:^|\s)[A-Za-z_][A-Za-z0-9_]*=\S+/u.test(command);
  const containsCredentialArgument = /(?:api[-_]?key|access[-_]?key|token|secret|password|authorization)\s*(?:=|:)\s*\S+/iu.test(command);
  const containsKnownSecret = SECRET_CONTENT_PATTERNS.some((pattern) => pattern.test(command));
  if (containsAbsolutePath || containsEnvironmentValue || containsCredentialArgument || containsKnownSecret) {
    throw new Error("run command must not contain absolute paths, environment values, tokens, keys, or credentials");
  }
}

function assertArtifactFileNameSafe(relativePath: string): void {
  const baseName = path.posix.basename(relativePath);
  if (SENSITIVE_FILE_PATTERN.test(baseName) || SENSITIVE_EXTENSION_PATTERN.test(baseName)) {
    throw new Error(`sensitive file is not allowed in an artifact: ${relativePath}`);
  }
}

function assertNoHighConfidenceSecrets(content: Buffer, relativePath: string, contentType: ArtifactContentType): void {
  if (!(contentType.startsWith("text/") || contentType === "application/json" || contentType === "application/x-ndjson" || contentType === "application/yaml")) return;
  const text = content.toString("utf8");
  if (text.includes("\uFFFD") || SECRET_CONTENT_PATTERNS.some((pattern) => pattern.test(text)) || MACHINE_ABSOLUTE_PATH_PATTERN.test(text)) {
    throw new Error(`artifact contains data that resembles a credential or machine-local absolute path: ${relativePath}`);
  }
}

async function assertWritableManifestTarget(absolutePath: string): Promise<void> {
  const status = await lstat(absolutePath).catch(() => undefined);
  if (status !== undefined && (!status.isFile() || status.isSymbolicLink())) {
    throw new Error("manifest target must be a regular file or not yet exist");
  }
}

async function assertRegularFile(absolutePath: string, message: string): Promise<void> {
  const status = await lstat(absolutePath).catch(() => undefined);
  if (status === undefined || !status.isFile() || status.isSymbolicLink()) throw new Error(message);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(compareStrings);
  const wanted = [...expected].sort(compareStrings);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`manifest schema violation: unexpected ${label} fields`);
  }
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort(compareStrings).map((key) => [key, sortObjectKeys(value[key])]));
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
