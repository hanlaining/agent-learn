import { rm } from "node:fs/promises";
import { join } from "node:path";

import type { LlmProvider } from "../llm/types.js";
import type { DistillableChatMessage } from "./chat-skill-distiller.js";
import { distillChatToSkill } from "./chat-skill-distiller.js";
import { SkillLoader, type SkillLoaderOptions, type SkillSummary } from "./skill-loader.js";
import {
  writeDistilledSkill,
  type SkillWriteResult,
} from "./skill-writer.js";
import { writeDistilledSop, type SopWriteResult } from "./sop-writer.js";

export interface SkillRuntimeOptions {
  roots: readonly string[];
  writableRoot: string;
  sopWritableRoot?: string;
  allowMissingRoots?: boolean;
  loaderOptions?: Omit<SkillLoaderOptions, "roots" | "allowMissingRoots">;
}

export type KnowledgeOutputKind = "skill" | "sop";

export interface KnowledgeWriteResult {
  kind: KnowledgeOutputKind;
  status: "created" | "already_exists";
  name: string;
  description: string;
  path: string;
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

  async distillThreadKnowledge(
    llm: LlmProvider,
    messages: readonly DistillableChatMessage[],
    kind: KnowledgeOutputKind,
  ): Promise<KnowledgeWriteResult> {
    const draft = await distillChatToSkill({ llm, messages });
    if (kind === "sop") {
      const result: SopWriteResult = await writeDistilledSop(
        this.options.sopWritableRoot ?? join(this.options.writableRoot, "..", "docs", "generated-sops"),
        draft,
      );
      return {
        kind,
        status: result.status,
        name: result.document.name,
        description: result.document.description,
        path: result.document.path,
      };
    }

    const result = await writeDistilledSkill(this.options.writableRoot, draft);
    await this.refresh();
    return {
      kind,
      status: result.status,
      name: result.skill.name,
      description: result.skill.description,
      path: join(this.options.writableRoot, result.skill.name, "SKILL.md"),
    };
  }

  async refresh(): Promise<void> {
    const refreshed = await createLoader(this.options);
    this.loader = refreshed;
  }
}

function createLoader(options: SkillRuntimeOptions): Promise<SkillLoader> {
  return SkillLoader.create({
    roots: options.roots,
    ...(options.loaderOptions ?? {}),
    ...(options.allowMissingRoots === undefined
      ? {}
      : { allowMissingRoots: options.allowMissingRoots }),
  });
}
