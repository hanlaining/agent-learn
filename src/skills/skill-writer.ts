import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  isAbsolute,
  join,
  relative,
  sep,
} from "node:path";

import {
  type DistilledSkillDraft,
  validateDistilledSkillDraft,
} from "./chat-skill-distiller.js";
import { SkillLoader } from "./skill-loader.js";

export interface SkillWriteResult {
  status: "created" | "already_exists";
  skill: {
    name: string;
    description: string;
  };
}

const writeQueues = new Map<string, Promise<void>>();

export async function writeDistilledSkill(
  skillsRoot: string,
  draftInput: DistilledSkillDraft,
): Promise<SkillWriteResult> {
  const draft = validateDistilledSkillDraft(draftInput);
  await mkdir(skillsRoot, { recursive: true });
  const configuredRootStats = await lstat(skillsRoot);

  if (configuredRootStats.isSymbolicLink()) {
    throw new Error("Skill root must not be a symbolic link");
  }

  const rootPath = await realpath(skillsRoot);
  const rootStats = await lstat(rootPath);

  if (!rootStats.isDirectory()) {
    throw new Error("Skill root must be a directory");
  }

  return withWriteQueue(rootPath, async () => {
    const candidate = await selectCandidate(rootPath, draft);

    if (candidate.status === "already_exists") {
      return {
        status: "already_exists",
        skill: {
          name: candidate.name,
          description: draft.description,
        },
      };
    }

    const finalDraft = { ...draft, name: candidate.name };
    const stagingRoot = await mkdtemp(join(rootPath, ".chat-skill-"));
    assertWithinRoot(rootPath, stagingRoot, "Temporary Skill directory");

    try {
      const stagingSkillDirectory = join(stagingRoot, finalDraft.name);
      await mkdir(stagingSkillDirectory);
      await writeFile(
        join(stagingSkillDirectory, "SKILL.md"),
        renderSkillDocument(finalDraft),
        { encoding: "utf8", flag: "wx" },
      );

      const stagedLoader = await SkillLoader.create({ roots: [stagingRoot] });
      const stagedSkill = stagedLoader.read(finalDraft.name);

      if (!sameSkillContent(stagedSkill, finalDraft)) {
        throw new Error("Staged Skill failed reload validation");
      }

      const finalDirectory = join(rootPath, finalDraft.name);
      assertWithinRoot(rootPath, finalDirectory, "Skill directory");

      if (await pathExists(finalDirectory)) {
        throw new Error("Skill destination changed during creation");
      }

      await rename(stagingSkillDirectory, finalDirectory);

      return {
        status: "created",
        skill: {
          name: finalDraft.name,
          description: finalDraft.description,
        },
      };
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  });
}

function renderSkillDocument(draft: DistilledSkillDraft): string {
  return [
    "---",
    `name: ${draft.name}`,
    `description: ${draft.description}`,
    "---",
    "",
    draft.instructions,
    "",
  ].join("\n");
}

async function selectCandidate(
  rootPath: string,
  draft: DistilledSkillDraft,
): Promise<
  | { status: "create"; name: string }
  | { status: "already_exists"; name: string }
> {
  let suffix = 1;

  while (true) {
    const suffixText = suffix === 1 ? "" : `-${suffix}`;
    const baseName = draft.name
      .slice(0, 64 - suffixText.length)
      .replace(/-+$/u, "");
    const name = `${baseName}${suffixText}`;

    if (baseName.length === 0) {
      throw new Error("Skill name leaves no room for a conflict suffix");
    }

    const directory = join(rootPath, name);
    assertWithinRoot(rootPath, directory, "Skill directory");
    const stats = await tryLstat(directory);

    if (stats === undefined) {
      return { status: "create", name };
    }

    if (stats.isSymbolicLink()) {
      throw new Error("Skill destination must not be a symbolic link");
    }

    if (!stats.isDirectory()) {
      throw new Error("Skill destination must be a directory");
    }

    const loader = await SkillLoader.create({ roots: [rootPath] });
    const existing = loader.read(name);

    if (sameSkillContent(existing, draft)) {
      return { status: "already_exists", name };
    }

    suffix += 1;
  }
}

function sameSkillContent(
  left: { description: string; instructions: string },
  right: { description: string; instructions: string },
): boolean {
  return (
    left.description === right.description &&
    left.instructions.replace(/\r\n?/gu, "\n").trim() ===
      right.instructions.replace(/\r\n?/gu, "\n").trim()
  );
}

async function withWriteQueue<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = writeQueues.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  writeQueues.set(key, queued);

  await previous;

  try {
    return await operation();
  } finally {
    release();

    if (writeQueues.get(key) === queued) {
      writeQueues.delete(key);
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  return (await tryLstat(path)) !== undefined;
}

async function tryLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }

    throw error;
  }
}

function assertWithinRoot(
  rootPath: string,
  targetPath: string,
  label: string,
): void {
  const pathFromRoot = relative(rootPath, targetPath);

  if (
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error(`${label} escapes Skill root`);
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
