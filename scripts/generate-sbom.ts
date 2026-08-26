import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface Manifest {
  name?: unknown;
  version?: unknown;
  license?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  optionalDependencies?: unknown;
  peerDependencies?: unknown;
}

interface LockPackage {
  name?: unknown;
  version?: unknown;
  license?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  optionalDependencies?: unknown;
  peerDependencies?: unknown;
  dev?: unknown;
  optional?: unknown;
  link?: unknown;
}

interface PackageLock {
  name?: unknown;
  version?: unknown;
  lockfileVersion?: unknown;
  packages?: unknown;
}

export interface CycloneDxComponent {
  type: "application" | "library";
  "bom-ref": string;
  name: string;
  version: string;
  purl: string;
  licenses?: Array<{ license: { name: string } }>;
  properties?: Array<{ name: string; value: string }>;
}

export interface CycloneDxSbom {
  bomFormat: "CycloneDX";
  specVersion: "1.5";
  version: 1;
  metadata: {
    component: CycloneDxComponent;
    properties: Array<{ name: string; value: string }>;
  };
  components: CycloneDxComponent[];
}

export interface GenerateSbomOptions {
  lockfilePath?: string;
  manifestPath?: string;
}

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;
const INSTALL_PATH_PATTERN = /^node_modules\/(?:@[A-Za-z0-9._~-]+\/[A-Za-z0-9._~-]+|[A-Za-z0-9._~-]+)(?:\/node_modules\/(?:@[A-Za-z0-9._~-]+\/[A-Za-z0-9._~-]+|[A-Za-z0-9._~-]+))*$/u;

export async function generateCycloneDxSbom(
  workspaceRoot: string,
  options: GenerateSbomOptions = {},
): Promise<CycloneDxSbom> {
  const root = await realpath(path.resolve(workspaceRoot));
  const [lockPath, manifestPath] = await Promise.all([
    resolveSafeInput(root, options.lockfilePath ?? "package-lock.json", "lockfile"),
    resolveSafeInput(root, options.manifestPath ?? "package.json", "manifest"),
  ]);
  const [lockText, manifestText] = await Promise.all([
    readFile(lockPath, "utf8"),
    readFile(manifestPath, "utf8"),
  ]);
  const lock = parseJsonObject<PackageLock>(lockText, "package-lock.json");
  const manifest = parseJsonObject<Manifest>(manifestText, "package.json");
  const packages = asRecord<LockPackage>(lock.packages, "package-lock.json packages");
  const rootLock = packages[""];
  if (rootLock === undefined) throw new Error("package-lock.json drift: missing packages root entry");
  if (lock.lockfileVersion !== 3) throw new Error(`unsupported package-lock version: ${String(lock.lockfileVersion)}`);

  const rootName = requireString(manifest.name, "package.json name");
  const rootVersion = requireString(manifest.version, "package.json version");
  assertEqual(rootName, lock.name, "package-lock top-level name");
  assertEqual(rootVersion, lock.version, "package-lock top-level version");
  assertEqual(rootName, rootLock.name, "package-lock root name");
  assertEqual(rootVersion, rootLock.version, "package-lock root version");
  assertDependencyMapsMatch(manifest, rootLock);

  const directNames = new Set<string>();
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of Object.keys(optionalStringRecord(manifest[field], `package.json ${field}`))) {
      validatePackageName(name, `package.json ${field}`);
      directNames.add(name);
    }
  }
  for (const name of directNames) {
    if (packages[`node_modules/${name}`] === undefined) {
      throw new Error(`package-lock.json drift: direct dependency is not locked at node_modules/${name}`);
    }
  }

  const components: CycloneDxComponent[] = [];
  const sortedEntries = Object.entries(packages)
    .filter(([installPath]) => installPath !== "")
    .sort(([left], [right]) => left.localeCompare(right, "en"));
  for (const [installPath, entry] of sortedEntries) {
    if (!INSTALL_PATH_PATTERN.test(installPath)) {
      throw new Error(`illegal package-lock install path: ${installPath}`);
    }
    if (!isObject(entry)) throw new Error(`invalid package-lock entry: ${installPath}`);
    if (entry.link === true) throw new Error(`unsupported linked dependency in package-lock: ${installPath}`);
    const derivedName = installPath.split("/node_modules/").at(-1)?.replace(/^node_modules\//u, "");
    if (derivedName === undefined) throw new Error(`cannot derive package name: ${installPath}`);
    const name = entry.name === undefined ? derivedName : requireString(entry.name, `${installPath} name`);
    validatePackageName(name, installPath);
    if (name !== derivedName) throw new Error(`package-lock name/path mismatch: ${installPath}`);
    const version = requireString(entry.version, `${installPath} version`);
    const level = installPath === `node_modules/${name}` && directNames.has(name) ? "direct" : "transitive";
    const dependencyKind = entry.dev === true ? "development" : entry.optional === true ? "optional" : "runtime";
    components.push(makeComponent("library", name, version, entry.license, [
      { name: "god-agent:install-path", value: installPath },
      { name: "god-agent:dependency-level", value: level },
      { name: "god-agent:dependency-kind", value: dependencyKind },
    ], installPath));
  }
  const dependencyGraphSha256 = createHash("sha256")
    .update(JSON.stringify(components))
    .digest("hex");
  const licenseEvidenceCount = components.filter((component) => component.licenses !== undefined).length;

  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      component: makeComponent("application", rootName, rootVersion, manifest.license, undefined, ""),
      properties: [
        { name: "god-agent:source-lockfile", value: "package-lock.json" },
        { name: "god-agent:source-lockfile-sha256", value: createHash("sha256").update(lockText).digest("hex") },
        { name: "god-agent:source-manifest-sha256", value: createHash("sha256").update(manifestText).digest("hex") },
        { name: "god-agent:dependency-graph-sha256", value: dependencyGraphSha256 },
        { name: "god-agent:component-count", value: String(components.length) },
        { name: "god-agent:license-evidence-count", value: String(licenseEvidenceCount) },
        { name: "god-agent:license-evidence-missing-count", value: String(components.length - licenseEvidenceCount) },
      ],
    },
    components,
  };
}

export function serializeCycloneDxSbom(sbom: CycloneDxSbom): string {
  return `${JSON.stringify(sbom, null, 2)}\n`;
}

function makeComponent(
  type: "application" | "library",
  name: string,
  version: string,
  licenseEvidence: unknown,
  properties: CycloneDxComponent["properties"],
  installPath: string,
): CycloneDxComponent {
  const purl = npmPurl(name, version);
  const uniqueMaterial = `${installPath}\0${name}\0${version}`;
  const bomRef = installPath.length === 0
    ? purl
    : `urn:god-agent:npm-instance:${createHash("sha256").update(uniqueMaterial).digest("hex")}`;
  const license = typeof licenseEvidence === "string" && licenseEvidence.trim().length > 0
    ? [{ license: { name: licenseEvidence.trim() } }]
    : undefined;
  return {
    type,
    "bom-ref": bomRef,
    name,
    version,
    purl,
    ...(license === undefined ? {} : { licenses: license }),
    ...(properties === undefined ? {} : { properties }),
  };
}

function npmPurl(name: string, version: string): string {
  if (name.startsWith("@")) {
    const [scope, packageName] = name.split("/");
    if (scope === undefined || packageName === undefined) throw new Error(`invalid scoped package name: ${name}`);
    return `pkg:npm/${encodeURIComponent(scope)}/${encodeURIComponent(packageName)}@${encodeURIComponent(version)}`;
  }
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

function assertDependencyMapsMatch(manifest: Manifest, lockRoot: LockPackage): void {
  for (const field of DEPENDENCY_FIELDS) {
    const expected = optionalStringRecord(manifest[field], `package.json ${field}`);
    const actual = optionalStringRecord(lockRoot[field], `package-lock root ${field}`);
    if (JSON.stringify(sortedRecord(expected)) !== JSON.stringify(sortedRecord(actual))) {
      throw new Error(`package-lock.json drift: ${field} does not match package.json`);
    }
  }
}

function optionalStringRecord(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  if (!isObject(value) || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) result[key] = requireString(item, `${label}.${key}`);
  return result;
}

function sortedRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right, "en")));
}

export async function resolveSafeInput(root: string, candidate: string, label: string, allowMissing = false): Promise<string> {
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`illegal ${label} path outside workspace: ${candidate}`);
  }
  let metadata;
  try {
    metadata = await lstat(resolved);
  } catch (error) {
    if (allowMissing && error instanceof Error && "code" in error && error.code === "ENOENT") return resolved;
    throw new Error(`illegal ${label} path is unavailable: ${candidate}`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`illegal ${label} path must be a regular file: ${candidate}`);
  }
  const physical = await realpath(resolved);
  const physicalRelative = path.relative(root, physical);
  if (physicalRelative === "" || physicalRelative.startsWith("..") || path.isAbsolute(physicalRelative)) {
    throw new Error(`illegal ${label} path outside workspace: ${candidate}`);
  }
  return physical;
}

function validatePackageName(name: string, label: string): void {
  if (!/^(?:@[A-Za-z0-9._~-]+\/[A-Za-z0-9._~-]+|[A-Za-z0-9._~-]+)$/u.test(name)) {
    throw new Error(`invalid package name in ${label}: ${name}`);
  }
}

function parseJsonObject<T>(text: string, label: string): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (!isObject(value) || Array.isArray(value)) throw new Error(`${label} must contain an object`);
  return value as T;
}

function asRecord<T>(value: unknown, label: string): Record<string, T> {
  if (!isObject(value) || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, T>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function assertEqual(expected: string, actual: unknown, label: string): void {
  if (actual !== expected) throw new Error(`package-lock.json drift: ${label} does not match package.json`);
}

function parseCliArgs(args: readonly string[]): { output?: string } {
  let output: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--output") {
      output = args[index + 1];
      if (output === undefined) throw new Error("--output requires a path");
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write("Usage: npx --no-install tsx scripts/generate-sbom.ts [--output <workspace-relative-path>]\n");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${String(arg)}`);
  }
  return output === undefined ? {} : { output };
}

async function main(): Promise<void> {
  const { output } = parseCliArgs(process.argv.slice(2));
  const sbom = await generateCycloneDxSbom(DEFAULT_ROOT);
  const serialized = serializeCycloneDxSbom(sbom);
  if (output === undefined) {
    process.stdout.write(serialized);
    return;
  }
  const outputPath = await resolveSafeInput(DEFAULT_ROOT, output, "output", true);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serialized, "utf8");
  process.stdout.write(`CycloneDX SBOM written: ${path.relative(DEFAULT_ROOT, outputPath).replaceAll("\\", "/")}\n`);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === SCRIPT_PATH) await main();
