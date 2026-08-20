import {
  createArtifactManifest,
  verifyArtifactManifest,
} from "./manifest.js";
import type { ArtifactProviderKind } from "./types.js";

type CliOptions =
  | {
    action: "create";
    rootDirectory: string;
    manifestPath?: string;
    baselineCommit: string;
    command: string;
    startedAt: string;
    finishedAt: string;
    providerKind: ArtifactProviderKind;
  }
  | {
    action: "verify";
    rootDirectory: string;
    manifestPath?: string;
  };

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.action === "create") {
    const manifest = await createArtifactManifest(options);
    process.stdout.write(`${JSON.stringify({
      action: "create",
      manifest: options.manifestPath ?? "artifact-manifest.json",
      files: manifest.files.length,
      provider: manifest.provider,
    })}\n`);
    return;
  }
  const manifest = await verifyArtifactManifest(options);
  process.stdout.write(`${JSON.stringify({
    action: "verify",
    manifest: options.manifestPath ?? "artifact-manifest.json",
    files: manifest.files.length,
    verified: true,
  })}\n`);
}

function parseArgs(args: string[]): CliOptions {
  const action = args[0];
  if (action !== "create" && action !== "verify") throw new Error("first argument must be create or verify");
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || !flag.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error("all CLI options must use --name value pairs");
    }
    if (values.has(flag)) throw new Error(`duplicate option: ${flag}`);
    values.set(flag, value);
  }
  const allowed = action === "create"
    ? new Set(["--root", "--manifest", "--baseline-commit", "--command", "--started-at", "--finished-at", "--provider"])
    : new Set(["--root", "--manifest"]);
  const unknown = [...values.keys()].find((flag) => !allowed.has(flag));
  if (unknown !== undefined) throw new Error(`unknown option: ${unknown}`);
  const rootDirectory = required(values, "--root");
  const manifestPath = values.get("--manifest");
  if (action === "verify") return { action, rootDirectory, ...(manifestPath === undefined ? {} : { manifestPath }) };

  const providerKind = required(values, "--provider");
  if (providerKind !== "none" && providerKind !== "deterministic-fake") {
    throw new Error("--provider must be none or deterministic-fake");
  }
  return {
    action,
    rootDirectory,
    ...(manifestPath === undefined ? {} : { manifestPath }),
    baselineCommit: required(values, "--baseline-commit"),
    command: required(values, "--command"),
    startedAt: required(values, "--started-at"),
    finishedAt: required(values, "--finished-at"),
    providerKind,
  };
}

function required(values: ReadonlyMap<string, string>, flag: string): string {
  const value = values.get(flag);
  if (value === undefined || value.length === 0) throw new Error(`missing required option: ${flag}`);
  return value;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown failure";
  process.stderr.write(`artifact manifest error: ${message}\n`);
  process.exitCode = 1;
});
