import { rm } from "node:fs/promises";
import { join } from "node:path";

import type { LlmProvider } from "../llm/types.js";
import type { DistillableChatMessage } from "./chat-skill-distiller.js";
import { distillChatToSkill } from "./chat-skill-distiller.js";
import { SkillLoader, type SkillSummary } from "./skill-loader.js";
import {
  writeDistilledSkill,
  type SkillWriteResult,
} from "./skill-writer.js";

export interface SkillRuntimeOptions {
  roots: readonly string[];
  writableRoot: string;
  allowMissingRoots?: boolean;
}

export class SkillRuntime {
  private loader: SkillLoader;

  private constructor(
    private readonly options: SkillRuntimeOptions,
    loader: SkillLoader,
  ) {
    this.loader = loader;
  }

  static async create(options: SkillRuntimeOptions): Promise<SkillRuntime> {
    return new SkillRuntime(options, await createLoader(options));
  }

  getLoader(): SkillLoader {
    return this.loader;
  }

  list(): SkillSummary[] {
    return this.loader.list();
  }

  createCatalogInstructions(): string {
    return this.loader.createCatalogInstructions();
  }

  async distillThread(
    llm: LlmProvider,
    messages: readonly DistillableChatMessage[],
  ): Promise<SkillWriteResult> {
    const draft = await distillChatToSkill({ llm, messages });
    const result = await writeDistilledSkill(this.options.writableRoot, draft);

    if (result.status === "already_exists") {
      await this.refresh();
      return result;
    }

    try {
      await this.refresh();
      return result;
    } catch (error) {
      await rm(join(this.options.writableRoot, result.skill.name), {
        recursive: true,
        force: true,
      });
      await this.refresh();
      throw error;
    }
  }

  async refresh(): Promise<void> {
    const refreshed = await createLoader(this.options);
    this.loader = refreshed;
  }
}

function createLoader(options: SkillRuntimeOptions): Promise<SkillLoader> {
  return SkillLoader.create({
    roots: options.roots,
    ...(options.allowMissingRoots === undefined
      ? {}
      : { allowMissingRoots: options.allowMissingRoots }),
  });
}
