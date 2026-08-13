import { BUILTIN_AGENT_PROFILES, type AgentProfile } from "./agent-profile.js";

export class AgentRegistry {
  private readonly profiles = new Map<string, AgentProfile>();

  constructor(profiles: readonly AgentProfile[] = BUILTIN_AGENT_PROFILES) {
    profiles.forEach((profile) => this.register(profile));
  }

  register(profile: AgentProfile): void {
    if (this.profiles.has(profile.id)) throw new Error(`Agent profile already exists: ${profile.id}`);
    this.profiles.set(profile.id, structuredClone(profile));
  }

  require(id: string): AgentProfile {
    const profile = this.profiles.get(id);
    if (profile === undefined) throw new Error(`Unknown agent profile: ${id}`);
    return structuredClone(profile);
  }

  list(): AgentProfile[] { return [...this.profiles.values()].map((item) => structuredClone(item)); }
}
