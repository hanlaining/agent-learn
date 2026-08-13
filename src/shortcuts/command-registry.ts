import type {
  ActionDefinition,
  CliActionAvailability,
  SlashCommandResolution,
} from "./action-types.js";

const ACTION_ID_PATTERN = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/;
const SLASH_COMMAND_PATTERN = /^\/[a-z][a-z0-9-]*$/;

export class CommandRegistry {
  private readonly actions: readonly ActionDefinition[];
  private readonly bySlashCommand: ReadonlyMap<string, ActionDefinition>;

  constructor(actions: readonly ActionDefinition[]) {
    const byId = new Set<string>();
    const bySlashCommand = new Map<string, ActionDefinition>();

    for (const action of actions) {
      validateAction(action);

      if (byId.has(action.id)) {
        throw new Error(`Duplicate Action id: ${action.id}`);
      }
      if (
        action.slashCommand !== undefined &&
        bySlashCommand.has(action.slashCommand)
      ) {
        throw new Error(`Duplicate slash command: ${action.slashCommand}`);
      }

      byId.add(action.id);
      if (action.slashCommand !== undefined) {
        bySlashCommand.set(action.slashCommand, action);
      }
    }

    this.actions = [...actions];
    this.bySlashCommand = bySlashCommand;
  }

  list(): readonly ActionDefinition[] {
    return this.actions;
  }

  listAvailable(
    availability: CliActionAvailability,
  ): readonly ActionDefinition[] {
    return this.actions.filter((action) =>
      action.cliAvailability?.includes(availability) === true,
    );
  }

  resolve(input: string): SlashCommandResolution {
    const normalized = input.trim();

    if (!normalized.startsWith("/")) {
      return { kind: "not-command" };
    }

    const action = this.bySlashCommand.get(normalized);

    return action === undefined
      ? { kind: "unknown", input: normalized }
      : { kind: "matched", action };
  }

  formatHelp(): string {
    const commands = this.actions.filter(
      (action) => action.slashCommand !== undefined,
    );
    const commandWidth = Math.max(
      ...commands.map((action) => action.slashCommand?.length ?? 0),
      0,
    );

    return [
      "命令：",
      ...commands.map((action) =>
        `  ${action.slashCommand!.padEnd(commandWidth)}  ${action.description}`,
      ),
    ].join("\n");
  }

  formatAvailableCommands(
    availability: CliActionAvailability,
  ): string {
    return this.listAvailable(availability)
      .flatMap((action) =>
        action.slashCommand === undefined ? [] : [action.slashCommand],
      )
      .join("、");
  }
}

function validateAction(action: ActionDefinition): void {
  if (!ACTION_ID_PATTERN.test(action.id)) {
    throw new Error(`Invalid Action id: ${action.id}`);
  }
  if (
    action.slashCommand !== undefined &&
    !SLASH_COMMAND_PATTERN.test(action.slashCommand)
  ) {
    throw new Error(`Invalid slash command: ${action.slashCommand}`);
  }
  if (action.label.trim().length === 0) {
    throw new Error(`Action label is missing: ${action.id}`);
  }
  if (action.description.trim().length === 0) {
    throw new Error(`Action description is missing: ${action.id}`);
  }
  if (action.surfaces.length === 0) {
    throw new Error(`Action surface is missing: ${action.id}`);
  }
  if (new Set(action.surfaces).size !== action.surfaces.length) {
    throw new Error(`Duplicate Action surface: ${action.id}`);
  }
  if (
    action.surfaces.includes("cli") &&
    (action.slashCommand === undefined ||
      action.cliAvailability === undefined ||
      action.cliAvailability.length === 0)
  ) {
    throw new Error(`CLI Action metadata is incomplete: ${action.id}`);
  }
  if (
    action.cliAvailability !== undefined &&
    new Set(action.cliAvailability).size !== action.cliAvailability.length
  ) {
    throw new Error(`Duplicate Action availability: ${action.id}`);
  }
}
