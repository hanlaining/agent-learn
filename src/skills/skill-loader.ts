import {
  readFile,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import {
  isAbsolute,
  join,
  relative,
  sep,
} from "node:path";

const DEFAULT_MAX_SKILLS = 64;
const DEFAULT_MAX_SKILL_BYTES = 64 * 1024;
const MAX_DESCRIPTION_CHARACTERS = 500;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface SkillSummary {
  name: string;
  description: string;
}

export interface SkillDocument extends SkillSummary {
  instructions: string;
}

export interface SkillLoaderOptions {
  roots: readonly string[];
  maxSkills?: number;
  maxSkillBytes?: number;
  allowMissingRoots?: boolean;
}

interface StoredSkill extends SkillDocument {
  filePath: string;
}

/**
 * 第一版 Skill Loader 只发现每个根目录下一层的 <name>/SKILL.md。
 * 启动时读取并校验文件，但对模型只公开目录；完整正文必须通过 read_skill 按需获取。
 */
export class SkillLoader {
  private constructor(
    private readonly skills: ReadonlyMap<string, StoredSkill>,
  ) {}

  static async create(
    options: SkillLoaderOptions,
  ): Promise<SkillLoader> {
    const maxSkills = options.maxSkills ?? DEFAULT_MAX_SKILLS;
    const maxSkillBytes =
      options.maxSkillBytes ?? DEFAULT_MAX_SKILL_BYTES;

    requirePositiveInteger(maxSkills, "maxSkills");
    requirePositiveInteger(maxSkillBytes, "maxSkillBytes");

    const skills = new Map<string, StoredSkill>();
    const seenRoots = new Set<string>();

    for (const configuredRoot of options.roots) {
      let rootPath: string;

      try {
        rootPath = await realpath(configuredRoot);
      } catch (error) {
        if (
          options.allowMissingRoots === true &&
          isMissingPathError(error)
        ) {
          continue;
        }

        throw error;
      }

      if (seenRoots.has(rootPath)) {
        continue;
      }

      seenRoots.add(rootPath);
      const rootStats = await stat(rootPath);

      if (!rootStats.isDirectory()) {
        throw new Error(`Skill root is not a directory: ${rootPath}`);
      }

      const entries = await readdir(rootPath, {
        withFileTypes: true,
      });

      for (const entry of entries.sort((left, right) =>
        left.name.localeCompare(right.name),
      )) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) {
          continue;
        }

        const skill = await readSkillDirectory(
          rootPath,
          entry.name,
          maxSkillBytes,
        );

        if (skill === undefined) {
          continue;
        }

        if (skills.has(skill.name)) {
          throw new Error(`Duplicate Skill name: ${skill.name}`);
        }

        skills.set(skill.name, skill);

        if (skills.size > maxSkills) {
          throw new Error(`Skill count exceeds ${maxSkills}`);
        }
      }
    }

    return new SkillLoader(skills);
  }

  list(): SkillSummary[] {
    return [...this.skills.values()]
      .map(({ name, description }) => ({ name, description }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  read(name: string): SkillDocument {
    const skill = this.skills.get(name);

    if (skill === undefined) {
      throw new Error(`Unknown Skill: ${name}`);
    }

    return {
      name: skill.name,
      description: skill.description,
      instructions: skill.instructions,
    };
  }

  createCatalogInstructions(): string {
    const summaries = this.list();

    if (summaries.length === 0) {
      return "";
    }

    return [
      "可用 Skills：",
      ...summaries.map(
        (skill) => `- ${skill.name}: ${skill.description}`,
      ),
      "当任务明确匹配某个 Skill 时，先调用 read_skill 获取完整说明，再按说明执行。",
      "不要根据名称猜测未读取的 Skill 内容。",
    ].join("\n");
  }
}

async function readSkillDirectory(
  rootPath: string,
  directoryName: string,
  maxSkillBytes: number,
): Promise<StoredSkill | undefined> {
  const configuredDirectory = join(rootPath, directoryName);
  const directoryPath = await realpath(configuredDirectory);

  assertWithinRoot(rootPath, directoryPath, "Skill directory");

  if (!(await stat(directoryPath)).isDirectory()) {
    return undefined;
  }

  let filePath: string;

  try {
    filePath = await realpath(join(directoryPath, "SKILL.md"));
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }

    throw error;
  }

  assertWithinRoot(rootPath, filePath, "SKILL.md");
  const fileStats = await stat(filePath);

  if (!fileStats.isFile()) {
    throw new Error(`SKILL.md is not a file: ${filePath}`);
  }

  if (fileStats.size > maxSkillBytes) {
    throw new Error(
      `SKILL.md exceeds ${maxSkillBytes} byte limit: ${directoryName}`,
    );
  }

  const data = await readFile(filePath);

  if (data.includes(0)) {
    throw new Error(`SKILL.md must be UTF-8 text: ${directoryName}`);
  }

  let text: string;

  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new Error(`SKILL.md must be UTF-8 text: ${directoryName}`);
  }

  const document = parseSkillDocument(text);

  if (document.name !== directoryName) {
    throw new Error(
      `Skill name must match directory: ${directoryName}`,
    );
  }

  return { ...document, filePath };
}

function parseSkillDocument(text: string): SkillDocument {
  const normalized = text.replace(/\r\n/g, "\n");

  if (!normalized.startsWith("---\n")) {
    throw new Error("SKILL.md must start with YAML frontmatter");
  }

  const frontmatterEnd = normalized.indexOf("\n---\n", 4);

  if (frontmatterEnd === -1) {
    throw new Error("SKILL.md frontmatter is not closed");
  }

  const metadata = new Map<string, string>();

  for (const line of normalized.slice(4, frontmatterEnd).split("\n")) {
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) {
      continue;
    }

    const match = /^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/.exec(line);

    if (match === null) {
      throw new Error(`Invalid SKILL.md frontmatter line: ${line}`);
    }

    const key = match[1]!;

    if (metadata.has(key)) {
      throw new Error(`Duplicate SKILL.md field: ${key}`);
    }

    metadata.set(key, unwrapQuotedValue(match[2]!.trim()));
  }

  const name = metadata.get("name") ?? "";
  const description = metadata.get("description") ?? "";
  const instructions = normalized
    .slice(frontmatterEnd + "\n---\n".length)
    .trim();

  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid Skill name: ${name}`);
  }

  if (
    description.length === 0 ||
    [...description].length > MAX_DESCRIPTION_CHARACTERS
  ) {
    throw new Error("Skill description is missing or too long");
  }

  if (instructions.length === 0) {
    throw new Error(`Skill instructions are empty: ${name}`);
  }

  return { name, description, instructions };
}

function unwrapQuotedValue(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }

  return value;
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

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}
