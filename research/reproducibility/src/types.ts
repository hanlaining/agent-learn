export const ARTIFACT_MANIFEST_SCHEMA_VERSION = "research-artifact-manifest-v1" as const;
export const DEFAULT_MANIFEST_PATH = "artifact-manifest.json" as const;

export type ArtifactContentType =
  | "application/json"
  | "application/octet-stream"
  | "application/pdf"
  | "application/zip"
  | "application/x-ndjson"
  | "application/yaml"
  | "text/csv"
  | "text/markdown"
  | "text/plain";

export type ArtifactProviderKind = "none" | "deterministic-fake";

export interface ArtifactFileEntry {
  path: string;
  bytes: number;
  sha256: string;
  contentType: ArtifactContentType;
}

export interface ArtifactManifest {
  schemaVersion: typeof ARTIFACT_MANIFEST_SCHEMA_VERSION;
  baselineCommit: string;
  run: {
    command: string;
    startedAt: string;
    finishedAt: string;
  };
  environment: {
    node: string;
    os: {
      platform: NodeJS.Platform;
      arch: string;
      release: string;
    };
  };
  provider: {
    kind: ArtifactProviderKind;
    realApiCalls: false;
    credentialsRead: false;
  };
  files: ArtifactFileEntry[];
}

export interface CreateArtifactManifestOptions {
  rootDirectory: string;
  manifestPath?: string;
  baselineCommit: string;
  command: string;
  startedAt: string;
  finishedAt: string;
  providerKind: ArtifactProviderKind;
}

export interface VerifyArtifactManifestOptions {
  rootDirectory: string;
  manifestPath?: string;
}
