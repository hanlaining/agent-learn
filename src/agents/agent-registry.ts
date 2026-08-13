import { BUILTIN_AGENT_PROFILES, type AgentProfile } from "./agent-profile.js";

export class AgentRegistry {
  private readonly profiles = new Map<string, AgentProfile>();

  constructor(persistedProfiles: readonly AgentProfile[] = []) {
    // 内置角色是 Runtime 合同的一部分，旧快照不能删除或放宽它们。
    BUILTIN_AGENT_PROFILES.forEach((profile) => this.register(profile));
    persistedProfiles
      .filter((profile) => !this.profiles.has(profile.id))
      .forEach((profile) => this.register(profile));
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

  requireAll(ids: readonly string[]): void {
    for (const id of new Set(ids)) this.require(id);
  }

  list(): AgentProfile[] { return [...this.profiles.values()].map((item) => structuredClone(item)); }
}
