import {
  OpenAiChatCompletionsProvider,
} from "./openai-chat-completions.js";
import {
  OpenAiResponsesProvider,
  type OpenAiReasoningEffort,
} from "./openai-responses.js";
import {
  loadLlmProviderProfiles,
  type LlmProviderProfile,
  type LlmProviderProfileModel,
} from "./provider-profile.js";
import {
  LlmProviderRegistry,
  type LlmAdapterCapabilities,
  type LlmAdapterCreateContext,
} from "./provider-registry.js";
import type {
  ConfigurableLlmProvider,
  ReasoningSummary,
} from "./types.js";

export interface ProviderInputPolicy {
  usePreviousResponseId: boolean;
  maxInputItems: number;
}

export interface LoadConfiguredLlmProviderOptions {
  env?: NodeJS.ProcessEnv;
  defaultModel: string;
  defaultBaseUrl: string;
  defaultModels: readonly LlmProviderProfileModel[];
  inputPolicy: ProviderInputPolicy;
  registry?: LlmProviderRegistry;
  readTextFile?: (path: string) => Promise<string>;
}

export interface ConfiguredLlmProvider {
  source: "legacy-env" | "profile-file";
  profile: LlmProviderProfile;
  profiles: LlmProviderProfile[];
  adapterId: string;
  invocationProvider: string;
  capabilities: LlmAdapterCapabilities;
  models: LlmProviderProfileModel[];
  provider?: ConfigurableLlmProvider;
  unavailableReason?: string;
}

export async function loadConfiguredLlmProvider(
  options: LoadConfiguredLlmProviderOptions,
): Promise<ConfiguredLlmProvider> {
  const env = options.env ?? process.env;
  const loaded = await loadLlmProviderProfiles({
    env,
    defaultModel: options.defaultModel,
    defaultBaseUrl: options.defaultBaseUrl,
    ...(options.readTextFile === undefined
      ? {}
      : { readTextFile: options.readTextFile }),
  });
  const registry = options.registry ?? createBuiltinLlmProviderRegistry();
  const registration = registry.require(loaded.activeProfile.adapter);
  // 只有旧 OPENAI_* 入口允许隐式继承 OPENAI_API_KEY。显式 Profile 若没有
  // 声明 apiKeyEnv，必须保持无密钥，避免把全局密钥泄露给本地或第三方上游。
  const apiKeyEnv = loaded.activeProfile.apiKeyEnv ??
    (loaded.source === "legacy-env" ? "OPENAI_API_KEY" : undefined);
  const apiKey = apiKeyEnv === undefined
    ? undefined
    : env[apiKeyEnv]?.trim();
  const apiKeyRequired =
    loaded.activeProfile.apiKeyRequired ?? true;
  const models = createModelCatalog(
    loaded.activeProfile,
    loaded.source === "legacy-env"
      ? options.defaultModels
      : [],
  );
  const capabilities = {
    ...registration.capabilities,
    hostedWebSearch:
      registration.capabilities.hostedWebSearch &&
      loaded.activeProfile.options?.webSearch !== false,
  };
  const common = {
    source: loaded.source,
    profile: loaded.activeProfile,
    profiles: loaded.profiles,
    adapterId: registration.id,
    invocationProvider:
      loaded.source === "legacy-env" &&
      registration.id === "openai-responses"
        ? "openai_responses"
        : `${registration.id}:${loaded.activeProfile.id}`,
    capabilities,
    models,
  } as const;

  if (apiKeyRequired && apiKeyEnv === undefined) {
    return {
      ...common,
      unavailableReason:
        `LLM profile "${loaded.activeProfile.id}" requires an ` +
        "apiKeyEnv configuration",
    };
  }

  if (apiKeyRequired && (apiKey === undefined || apiKey.length === 0)) {
    return {
      ...common,
      unavailableReason:
        `LLM profile "${loaded.activeProfile.id}" requires ` +
        `environment variable ${apiKeyEnv ?? "<missing>"}`,
    };
  }

  const provider = registration.create({
    profile: loaded.activeProfile,
    ...(apiKey === undefined || apiKey.length === 0
      ? {}
      : { apiKey }),
    inputPolicy: options.inputPolicy,
  });

  return {
    ...common,
    provider,
  };
}

export function createBuiltinLlmProviderRegistry(): LlmProviderRegistry {
  return new LlmProviderRegistry([
    {
      id: "openai-responses",
      capabilities: {
        toolCalling: true,
        reasoningSummary: true,
        hostedWebSearch: true,
        previousResponseId: true,
      },
      create: createOpenAiResponsesProvider,
    },
    {
      id: "openai-compatible",
      capabilities: {
        toolCalling: true,
        reasoningSummary: false,
        hostedWebSearch: false,
        previousResponseId: false,
      },
      create: createOpenAiCompatibleProvider,
    },
  ]);
}

function createOpenAiResponsesProvider(
  context: LlmAdapterCreateContext,
): ConfigurableLlmProvider {
  const options = context.profile.options ?? {};
  const apiKey = context.apiKey ?? "";

  return new OpenAiResponsesProvider({
    apiKey,
    model: context.profile.model,
    ...(context.profile.baseUrl === undefined
      ? {}
      : { baseUrl: context.profile.baseUrl }),
    timeoutMs: positiveIntegerOption(
      options.timeoutMs,
      "timeoutMs",
      120_000,
    ),
    // WAL 的一次 submitted 只能对应一次远端 POST，Adapter 不得暗中重试。
    maxRetries: 0,
    usePreviousResponseId:
      context.inputPolicy.usePreviousResponseId,
    maxInputItems: context.inputPolicy.maxInputItems,
    reasoningSummary: reasoningSummaryOption(
      options.reasoningSummary,
    ),
    reasoningEffort: reasoningEffortOption(
      options.reasoningEffort,
    ),
    serviceTier: stringOption(
      options.serviceTier,
      "serviceTier",
      "fast",
    ),
    includeReasoningEncryptedContent: booleanOption(
      options.includeReasoningEncryptedContent,
      "includeReasoningEncryptedContent",
      true,
    ),
    ...(options.webSearch === false
      ? {}
      : {
          webSearch: {
            externalWebAccess: true,
            searchContextSize: searchContextSizeOption(
              isRecord(options.webSearch)
                ? options.webSearch.searchContextSize
                : undefined,
            ),
          },
        }),
  });
}

function createOpenAiCompatibleProvider(
  context: LlmAdapterCreateContext,
): ConfigurableLlmProvider {
  const options = context.profile.options ?? {};

  return new OpenAiChatCompletionsProvider({
    ...(context.apiKey === undefined ? {} : { apiKey: context.apiKey }),
    model: context.profile.model,
    ...(context.profile.baseUrl === undefined
      ? {}
      : { baseUrl: context.profile.baseUrl }),
    timeoutMs: positiveIntegerOption(
      options.timeoutMs,
      "timeoutMs",
      120_000,
    ),
    maxInputItems: context.inputPolicy.maxInputItems,
  });
}

function createModelCatalog(
  profile: LlmProviderProfile,
  fallback: readonly LlmProviderProfileModel[],
): LlmProviderProfileModel[] {
  const source = profile.models ?? fallback;
  const models = source.map((model) => ({
    ...model,
    ...(model.reasoningEfforts === undefined
      ? {}
      : { reasoningEfforts: [...model.reasoningEfforts] }),
  }));

  if (!models.some((model) => model.id === profile.model)) {
    models.push({ id: profile.model, label: profile.model });
  }

  return models;
}

function positiveIntegerOption(
  value: unknown,
  field: string,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`LLM profile option ${field} must be a positive integer`);
  }

  return value as number;
}

function booleanOption(
  value: unknown,
  field: string,
  fallback: boolean,
): boolean {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "boolean") {
    throw new Error(`LLM profile option ${field} must be a boolean`);
  }

  return value;
}

function stringOption(
  value: unknown,
  field: string,
  fallback: string,
): string {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`LLM profile option ${field} must be a non-empty string`);
  }

  return value.trim();
}

function reasoningSummaryOption(value: unknown): ReasoningSummary {
  if (value === undefined) {
    return "auto";
  }

  if (
    value === "auto" ||
    value === "concise" ||
    value === "detailed" ||
    value === "none"
  ) {
    return value;
  }

  throw new Error(
    "LLM profile option reasoningSummary is invalid",
  );
}

function reasoningEffortOption(value: unknown): OpenAiReasoningEffort {
  if (value === undefined) {
    return "high";
  }

  if (
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max" ||
    value === "ultra"
  ) {
    return value;
  }

  throw new Error(
    "LLM profile option reasoningEffort is invalid",
  );
}

function searchContextSizeOption(
  value: unknown,
): "low" | "medium" | "high" {
  if (value === undefined) {
    return "low";
  }

  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }

  throw new Error(
    "LLM profile option webSearch.searchContextSize is invalid",
  );
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
