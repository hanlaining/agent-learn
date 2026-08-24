import { readFile } from "node:fs/promises";

export interface LlmProviderProfileModel {
  id: string;
  label?: string;
  reasoningEfforts?: string[];
}

/**
 * 一个 Profile 描述一个可插拔上游。
 *
 * Profile 只保存环境变量名，不保存密钥明文；同一种 adapter 可以通过不同
 * Profile 连接 Gundam Bridge、LovBrowser Bridge、Ollama 或远程 API。
 */
export interface LlmProviderProfile {
  id: string;
  displayName?: string;
  adapter: string;
  model: string;
  models?: LlmProviderProfileModel[];
  baseUrl?: string;
  apiKeyEnv?: string;
  apiKeyRequired?: boolean;
  options?: Record<string, unknown>;
}

export interface LlmProviderProfilesDocument {
  activeProfile?: string;
  profiles: LlmProviderProfile[];
}

export interface LoadLlmProviderProfilesOptions {
  env?: NodeJS.ProcessEnv;
  readTextFile?: (path: string) => Promise<string>;
  defaultModel: string;
  defaultBaseUrl: string;
}

export interface LoadedLlmProviderProfiles {
  source: "legacy-env" | "profile-file";
  activeProfile: LlmProviderProfile;
  profiles: LlmProviderProfile[];
}

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export async function loadLlmProviderProfiles(
  options: LoadLlmProviderProfilesOptions,
): Promise<LoadedLlmProviderProfiles> {
  const env = options.env ?? process.env;
  const profilesPath = env.AGENT_LLM_PROFILES_PATH?.trim();

  if (profilesPath === undefined || profilesPath.length === 0) {
    const profile = createLegacyEnvironmentProfile(
      env,
      options.defaultModel,
      options.defaultBaseUrl,
    );

    return {
      source: "legacy-env",
      activeProfile: profile,
      profiles: [profile],
    };
  }

  const readTextFile = options.readTextFile ??
    ((path: string) => readFile(path, "utf8"));
  const text = await readTextFile(profilesPath);
  const document = parseLlmProviderProfiles(text);
  const activeProfileId =
    env.AGENT_LLM_PROFILE?.trim() ||
    document.activeProfile ||
    document.profiles[0]?.id;
  const activeProfile = document.profiles.find(
    (profile) => profile.id === activeProfileId,
  );

  if (activeProfile === undefined) {
    throw new Error(
      `Unknown active LLM profile: ${activeProfileId ?? "<missing>"}`,
    );
  }

  return {
    source: "profile-file",
    activeProfile,
    profiles: document.profiles,
  };
}

export function parseLlmProviderProfiles(
  text: string,
): LlmProviderProfilesDocument {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error("Invalid LLM profiles JSON", { cause: error });
  }

  if (!isRecord(value) || !Array.isArray(value.profiles)) {
    throw new Error("LLM profiles must contain a profiles array");
  }

  const profiles = value.profiles.map((profile, index) =>
    parseProfile(profile, index));
  const ids = new Set<string>();

  for (const profile of profiles) {
    if (ids.has(profile.id)) {
      throw new Error(`Duplicate LLM profile id: ${profile.id}`);
    }
    ids.add(profile.id);
  }

  if (profiles.length === 0) {
    throw new Error("LLM profiles must not be empty");
  }

  const activeProfile = optionalNonEmptyString(
    value.activeProfile,
    "activeProfile",
  );

  return {
    ...(activeProfile === undefined ? {} : { activeProfile }),
    profiles,
  };
}

export function createLegacyEnvironmentProfile(
  env: NodeJS.ProcessEnv,
  defaultModel: string,
  defaultBaseUrl: string,
): LlmProviderProfile {
  const adapter =
    env.AGENT_LLM_ADAPTER?.trim() || "openai-responses";
  const baseUrl = normalizeOpenAiBaseUrl(
    env.OPENAI_BASE_URL ?? defaultBaseUrl,
  );
  const apiKeyRequired = parseOptionalBoolean(
    env.AGENT_LLM_API_KEY_REQUIRED,
    "AGENT_LLM_API_KEY_REQUIRED",
  ) ?? true;

  return {
    id: "legacy-openai",
    displayName: "Legacy OPENAI_* environment",
    adapter,
    model: env.OPENAI_MODEL?.trim() || defaultModel,
    baseUrl,
    apiKeyEnv:
      env.AGENT_LLM_API_KEY_ENV?.trim() || "OPENAI_API_KEY",
    apiKeyRequired,
  };
}

export function normalizeOpenAiBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");

  if (trimmed.length === 0) {
    throw new Error("LLM profile baseUrl must not be empty");
  }

  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function parseProfile(
  value: unknown,
  index: number,
): LlmProviderProfile {
  if (!isRecord(value)) {
    throw new Error(`LLM profile at index ${index} must be an object`);
  }

  rejectSensitiveFields(value, `profiles[${index}]`);

  const id = requiredNonEmptyString(value.id, `profiles[${index}].id`);
  const adapter = requiredNonEmptyString(
    value.adapter,
    `profiles[${index}].adapter`,
  );
  const model = requiredNonEmptyString(
    value.model,
    `profiles[${index}].model`,
  );
  const displayName = optionalNonEmptyString(
    value.displayName,
    `profiles[${index}].displayName`,
  );
  const baseUrl = optionalNonEmptyString(
    value.baseUrl,
    `profiles[${index}].baseUrl`,
  );
  const apiKeyEnv = optionalNonEmptyString(
    value.apiKeyEnv,
    `profiles[${index}].apiKeyEnv`,
  );

  if (
    apiKeyEnv !== undefined &&
    !ENV_NAME_PATTERN.test(apiKeyEnv)
  ) {
    throw new Error(
      `profiles[${index}].apiKeyEnv must be an environment variable name`,
    );
  }

  const apiKeyRequired = parseOptionalBoolean(
    value.apiKeyRequired,
    `profiles[${index}].apiKeyRequired`,
  );
  const models = parseModels(value.models, index);

  if (value.options !== undefined && !isRecord(value.options)) {
    throw new Error(`profiles[${index}].options must be an object`);
  }

  return {
    id,
    ...(displayName === undefined ? {} : { displayName }),
    adapter,
    model,
    ...(models === undefined ? {} : { models }),
    ...(baseUrl === undefined
      ? {}
      : { baseUrl: normalizeOpenAiBaseUrl(baseUrl) }),
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    ...(apiKeyRequired === undefined ? {} : { apiKeyRequired }),
    ...(value.options === undefined
      ? {}
      : { options: structuredClone(value.options) }),
  };
}

function parseModels(
  value: unknown,
  profileIndex: number,
): LlmProviderProfileModel[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      `profiles[${profileIndex}].models must be a non-empty array`,
    );
  }

  const models = value.map((model, modelIndex) => {
    if (!isRecord(model)) {
      throw new Error(
        `profiles[${profileIndex}].models[${modelIndex}] must be an object`,
      );
    }

    const id = requiredNonEmptyString(
      model.id,
      `profiles[${profileIndex}].models[${modelIndex}].id`,
    );
    const label = optionalNonEmptyString(
      model.label,
      `profiles[${profileIndex}].models[${modelIndex}].label`,
    );
    let reasoningEfforts: string[] | undefined;

    if (model.reasoningEfforts !== undefined) {
      if (
        !Array.isArray(model.reasoningEfforts) ||
        !model.reasoningEfforts.every(
          (effort) =>
            typeof effort === "string" && effort.trim().length > 0,
        )
      ) {
        throw new Error(
          `profiles[${profileIndex}].models[${modelIndex}].reasoningEfforts must contain non-empty strings`,
        );
      }

      reasoningEfforts = model.reasoningEfforts.map(
        (effort) => effort.trim(),
      );

      if (new Set(reasoningEfforts).size !== reasoningEfforts.length) {
        throw new Error(
          `profiles[${profileIndex}].models[${modelIndex}].reasoningEfforts must not contain duplicates`,
        );
      }
    }

    return {
      id,
      ...(label === undefined ? {} : { label }),
      ...(reasoningEfforts === undefined
        ? {}
        : { reasoningEfforts }),
    };
  });

  const ids = new Set<string>();

  for (const model of models) {
    if (ids.has(model.id)) {
      throw new Error(
        `Duplicate model id in profiles[${profileIndex}]: ${model.id}`,
      );
    }
    ids.add(model.id);
  }

  return models;
}

function requiredNonEmptyString(
  value: unknown,
  field: string,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }

  return value.trim();
}

function optionalNonEmptyString(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return requiredNonEmptyString(value, field);
}

function parseOptionalBoolean(
  value: unknown,
  field: string,
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new Error(`${field} must be true or false`);
}

function rejectSensitiveFields(
  value: unknown,
  path: string,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      rejectSensitiveFields(item, `${path}[${index}]`);
    });
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    const canonicalKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");

    if (
      canonicalKey.endsWith("apikey") ||
      canonicalKey === "token" ||
      canonicalKey.endsWith("accesstoken") ||
      canonicalKey === "cookie" ||
      canonicalKey === "authorization"
    ) {
      throw new Error(
        `${path} must not contain ${key}; use apiKeyEnv`,
      );
    }

    rejectSensitiveFields(nested, `${path}.${key}`);
  }
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}
