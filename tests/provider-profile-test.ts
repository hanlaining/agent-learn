import assert from "node:assert/strict";
import test from "node:test";

import {
  createBuiltinLlmProviderRegistry,
  loadConfiguredLlmProvider,
} from "../src/llm/provider-bootstrap.js";
import {
  loadLlmProviderProfiles,
  parseLlmProviderProfiles,
} from "../src/llm/provider-profile.js";
import {
  LlmProviderRegistry,
} from "../src/llm/provider-registry.js";

const defaults = {
  defaultModel: "gpt-default",
  defaultBaseUrl: "https://gateway.example.com",
  defaultModels: [{ id: "gpt-default", label: "Default" }],
  inputPolicy: {
    usePreviousResponseId: false,
    maxInputItems: 128,
  },
} as const;

test("旧 OPENAI_* 环境零迁移生成默认 Responses Profile", async () => {
  const loaded = await loadLlmProviderProfiles({
    env: {
      OPENAI_MODEL: "gpt-legacy",
      OPENAI_BASE_URL: "https://legacy.example.com",
    },
    defaultModel: defaults.defaultModel,
    defaultBaseUrl: defaults.defaultBaseUrl,
  });

  assert.equal(loaded.source, "legacy-env");
  assert.deepEqual(loaded.activeProfile, {
    id: "legacy-openai",
    displayName: "Legacy OPENAI_* environment",
    adapter: "openai-responses",
    model: "gpt-legacy",
    baseUrl: "https://legacy.example.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    apiKeyRequired: true,
  });

  const configured = await loadConfiguredLlmProvider({
    ...defaults,
    env: { OPENAI_API_KEY: "fixture" },
  });
  assert.equal(configured.invocationProvider, "openai_responses");
});

test("Profile 文件按 activeProfile 选择插座且不保存密钥明文", async () => {
  const document = JSON.stringify({
    activeProfile: "gundam",
    profiles: [
      {
        id: "responses",
        adapter: "openai-responses",
        model: "gpt-r",
        baseUrl: "https://responses.example.com/v1",
        apiKeyEnv: "RESPONSES_KEY",
      },
      {
        id: "gundam",
        displayName: "Gundam Bridge",
        adapter: "openai-compatible",
        model: "gundam-default",
        baseUrl: "http://127.0.0.1:18800",
        apiKeyEnv: "GUNDAM_KEY",
        apiKeyRequired: false,
        models: [{ id: "gundam-default", label: "Gundam" }],
      },
    ],
  });
  const configured = await loadConfiguredLlmProvider({
    ...defaults,
    env: {
      AGENT_LLM_PROFILES_PATH: "profiles.json",
    },
    readTextFile: async () => document,
  });

  assert.equal(configured.source, "profile-file");
  assert.equal(configured.profile.id, "gundam");
  assert.equal(configured.adapterId, "openai-compatible");
  assert.equal(configured.profile.baseUrl, "http://127.0.0.1:18800/v1");
  assert.equal(configured.provider?.getModel(), "gundam-default");
  assert.equal(configured.capabilities.hostedWebSearch, false);
  assert.equal(configured.unavailableReason, undefined);
  assert.equal(JSON.stringify(configured.profile).includes("GUNDAM_KEY"), true);
  assert.equal(JSON.stringify(configured.profile).includes("secret"), false);
});

test("需要密钥的 Profile 缺少环境变量时只禁用模型链路", async () => {
  const configured = await loadConfiguredLlmProvider({
    ...defaults,
    env: {},
  });

  assert.equal(configured.provider, undefined);
  assert.match(
    configured.unavailableReason ?? "",
    /legacy-openai.*OPENAI_API_KEY/,
  );
});

test("环境变量可把旧入口切换为无 Key 的本地兼容插座", async () => {
  const configured = await loadConfiguredLlmProvider({
    ...defaults,
    env: {
      AGENT_LLM_ADAPTER: "openai-compatible",
      AGENT_LLM_API_KEY_REQUIRED: "false",
      OPENAI_BASE_URL: "http://localhost:11434/v1",
      OPENAI_MODEL: "llama3",
    },
  });

  assert.equal(configured.provider?.getModel(), "llama3");
  assert.equal(configured.profile.baseUrl, "http://localhost:11434/v1");
  assert.equal(configured.invocationProvider, "openai-compatible:legacy-openai");
});

test("无 Key 的显式 Profile 不会把全局 OPENAI_API_KEY 泄露给第三方上游", async () => {
  const configured = await loadConfiguredLlmProvider({
    ...defaults,
    env: {
      AGENT_LLM_PROFILES_PATH: "profiles.json",
      OPENAI_API_KEY: "must-not-be-forwarded",
    },
    readTextFile: async () => JSON.stringify({
      profiles: [{
        id: "ollama",
        adapter: "openai-compatible",
        model: "llama3",
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKeyRequired: false,
      }],
    }),
  });

  assert.equal(configured.provider !== undefined, true);
  assert.equal(
    (configured.provider as unknown as { apiKey: string }).apiKey,
    "",
  );
});

test("需要 Key 的显式 Profile 必须明确声明 apiKeyEnv", async () => {
  const configured = await loadConfiguredLlmProvider({
    ...defaults,
    env: { AGENT_LLM_PROFILES_PATH: "profiles.json" },
    readTextFile: async () => JSON.stringify({
      profiles: [{
        id: "remote",
        adapter: "openai-compatible",
        model: "remote-model",
      }],
    }),
  });

  assert.equal(configured.provider, undefined);
  assert.match(configured.unavailableReason ?? "", /requires an apiKeyEnv/);
});

test("Profile 配置拒绝重复 id 和密钥明文字段", () => {
  assert.throws(
    () => parseLlmProviderProfiles(JSON.stringify({
      profiles: [
        { id: "same", adapter: "a", model: "m" },
        { id: "same", adapter: "b", model: "m" },
      ],
    })),
    /Duplicate LLM profile id/,
  );
  assert.throws(
    () => parseLlmProviderProfiles(JSON.stringify({
      profiles: [{
        id: "unsafe",
        adapter: "openai-compatible",
        model: "m",
        apiKey: "must-not-live-in-json",
      }],
    })),
    /must not contain apiKey; use apiKeyEnv/,
  );
  assert.throws(
    () => parseLlmProviderProfiles(JSON.stringify({
      profiles: [{
        id: "nested-unsafe",
        adapter: "openai-compatible",
        model: "m",
        options: {
          headers: { Authorization: "Bearer must-not-live-in-json" },
        },
      }],
    })),
    /must not contain Authorization; use apiKeyEnv/,
  );
});

test("Profile 配置拒绝重复模型 id 和重复 reasoning effort", () => {
  assert.throws(
    () => parseLlmProviderProfiles(JSON.stringify({
      profiles: [{
        id: "duplicate-models",
        adapter: "openai-compatible",
        model: "same",
        models: [{ id: "same" }, { id: "same" }],
      }],
    })),
    /Duplicate model id/,
  );
  assert.throws(
    () => parseLlmProviderProfiles(JSON.stringify({
      profiles: [{
        id: "duplicate-efforts",
        adapter: "openai-responses",
        model: "m",
        models: [{ id: "m", reasoningEfforts: ["high", "high"] }],
      }],
    })),
    /reasoningEfforts must not contain duplicates/,
  );
});

test("Adapter Registry 拒绝重复注册并公开能力清单", () => {
  const builtin = createBuiltinLlmProviderRegistry();

  assert.deepEqual(
    builtin.list().map((adapter) => adapter.id),
    ["openai-responses", "openai-compatible"],
  );

  const registry = new LlmProviderRegistry();
  const registration = {
    id: "fixture",
    capabilities: {
      toolCalling: true,
      reasoningSummary: false,
      hostedWebSearch: false,
      previousResponseId: false,
    },
    create: () => {
      throw new Error("not used");
    },
  };
  registry.register(registration);

  assert.throws(
    () => registry.register(registration),
    /already registered/,
  );
  assert.throws(
    () => registry.require("missing"),
    /Unknown LLM adapter/,
  );
});
