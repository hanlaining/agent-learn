import type {
  ConfigurableLlmProvider,
} from "./types.js";
import type {
  LlmProviderProfile,
} from "./provider-profile.js";

export interface LlmAdapterCapabilities {
  toolCalling: boolean;
  reasoningSummary: boolean;
  hostedWebSearch: boolean;
  previousResponseId: boolean;
}

export interface LlmAdapterCreateContext {
  profile: LlmProviderProfile;
  apiKey?: string;
  inputPolicy: {
    usePreviousResponseId: boolean;
    maxInputItems: number;
  };
}

export interface LlmAdapterRegistration {
  id: string;
  capabilities: LlmAdapterCapabilities;
  create(
    context: LlmAdapterCreateContext,
  ): ConfigurableLlmProvider;
}

/**
 * Provider 插座注册表。
 *
 * Runtime 只认识统一的 LlmProvider；新增协议时注册一个 Adapter，新增同协议
 * 上游时只增加 Profile，不改 Agent Loop。
 */
export class LlmProviderRegistry {
  private readonly adapters = new Map<
    string,
    LlmAdapterRegistration
  >();

  constructor(
    registrations: readonly LlmAdapterRegistration[] = [],
  ) {
    registrations.forEach((registration) => {
      this.register(registration);
    });
  }

  register(registration: LlmAdapterRegistration): void {
    const id = registration.id.trim();

    if (id.length === 0) {
      throw new Error("LLM adapter id must not be empty");
    }

    if (this.adapters.has(id)) {
      throw new Error(`LLM adapter already registered: ${id}`);
    }

    this.adapters.set(id, {
      ...registration,
      id,
      capabilities: { ...registration.capabilities },
    });
  }

  require(id: string): LlmAdapterRegistration {
    const registration = this.adapters.get(id);

    if (registration === undefined) {
      throw new Error(`Unknown LLM adapter: ${id}`);
    }

    return registration;
  }

  list(): Array<{
    id: string;
    capabilities: LlmAdapterCapabilities;
  }> {
    return [...this.adapters.values()].map((registration) => ({
      id: registration.id,
      capabilities: { ...registration.capabilities },
    }));
  }
}
