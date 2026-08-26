import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve } from "node:path";

interface PackageJson {
  scripts?: Record<string, string>;
}

export interface TestDiscoveryResult {
  discovered: string[];
  referenced: string[];
  missingFromScripts: string[];
  staleScriptReferences: string[];
}

const TEST_REFERENCE = /\b(?:tests|research)[\\/][^\s"'&|;]*test\.ts\b/g;

export async function discoverFormalTests(workspaceRoot: string): Promise<string[]> {
  const discovered = [
    ...await walk(resolve(workspaceRoot, "tests"), workspaceRoot, (path) => path.endsWith("-test.ts")),
    ...await walk(resolve(workspaceRoot, "research"), workspaceRoot, (path) => path.endsWith("test.ts")),
  ];
  return [...new Set(discovered)].sort();
}

export function collectScriptTestReferences(scripts: Record<string, string>): string[] {
  const references = Object.entries(scripts)
    .filter(([name]) => isTestScript(name))
    .flatMap(([, command]) => command.match(TEST_REFERENCE) ?? [])
    .map(normalizePath);
  return [...new Set(references)].sort();
}

export async function verifyTestDiscovery(workspaceRoot: string): Promise<TestDiscoveryResult> {
  const packagePath = resolve(workspaceRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as PackageJson;
  const discovered = await discoverFormalTests(workspaceRoot);
  const referenced = collectScriptTestReferences(packageJson.scripts ?? {});
  const discoveredSet = new Set(discovered);
  const referencedSet = new Set(referenced);
  return {
    discovered,
    referenced,
    missingFromScripts: discovered.filter((path) => !referencedSet.has(path)),
    staleScriptReferences: referenced.filter((path) => !discoveredSet.has(path)),
  };
}

async function walk(
  directory: string,
  workspaceRoot: string,
  include: (relativePath: string) => boolean,
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return walk(path, workspaceRoot, include);
    if (!entry.isFile()) return [];
    const relativePath = normalizePath(relative(workspaceRoot, path));
    return include(relativePath) ? [relativePath] : [];
  }));
  return nested.flat();
}

function isTestScript(name: string): boolean {
  return name === "pretest" || name === "test" || name === "posttest" || name.startsWith("test:");
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function main(): Promise<void> {
  const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = await verifyTestDiscovery(workspaceRoot);
  if (result.missingFromScripts.length > 0 || result.staleScriptReferences.length > 0) {
    if (result.missingFromScripts.length > 0) {
      process.stderr.write(`Formal tests missing from package scripts:\n${result.missingFromScripts.map((path) => `- ${path}`).join("\n")}\n`);
    }
    if (result.staleScriptReferences.length > 0) {
      process.stderr.write(`Stale test references in package scripts:\n${result.staleScriptReferences.map((path) => `- ${path}`).join("\n")}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`Test discovery verified: ${result.discovered.length} formal test files are explicitly covered by package scripts.\n`);
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) await main();

