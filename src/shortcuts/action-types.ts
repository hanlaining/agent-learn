export type ActionCategory =
  | "chat"
  | "composer"
  | "session"
  | "turn"
  | "skill"
  | "output"
  | "settings"
  | "app";

export type ActionSurface = "cli" | "desktop";

export type ActionRisk =
  | "local-ui"
  | "read"
  | "write"
  | "execute"
  | "external"
  | "destructive";

export type CliActionAvailability = "idle" | "running";

export interface ActionDefinition {
  id: string;
  label: string;
  description: string;
  category: ActionCategory;
  risk: ActionRisk;
  userBindable: boolean;
  surfaces: readonly ActionSurface[];
  slashCommand?: `/${string}`;
  defaultBindings?: readonly string[];
  cliAvailability?: readonly CliActionAvailability[];
}

export type SlashCommandResolution =
  | { kind: "not-command" }
  | { kind: "unknown"; input: string }
  | { kind: "matched"; action: ActionDefinition };
