import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import {
  type DistilledSkillDraft,
  validateDistilledSkillDraft,
} from "./chat-skill-distiller.js";

export interface SopWriteResult {
  status: "created" | "already_exists";
  document: {
    name: string;
    description: string;
    path: string;
  };
}

const writeQueues = new Map<string, Promise<void>>();

export async function writeDistilledSop(
  sopsRoot: string,
  draftInput: DistilledSkillDraft,
): Promise<SopWriteResult> {
  const draft = validateDistilledSkillDraft(draftInput);
  await mkdir(sopsRoot, { recursive: true });
  const configuredRootStats = await lstat(sopsRoot);
  if (configuredRootStats.isSymbolicLink()) {
    throw new Error("SOP root must not be a symbolic link");
  }

  const rootPath = await realpath(sopsRoot);
  const rootStats = await lstat(rootPath);
  if (!rootStats.isDirectory()) throw new Error("SOP root must be a directory");

  return withWriteQueue(rootPath, async () => {
    const baseName = draft.name;
    let suffix = 1;
    while (true) {
      const suffixText = suffix === 1 ? "" : `-${suffix}`;
      const name = `${baseName.slice(0, 64 - suffixText.length)}${suffixText}`.replace(/-+$/u, "");
      const filePath = join(rootPath, `${name}.md`);
      assertWithinRoot(rootPath, filePath, "SOP file");
      const existing = await tryLstat(filePath);
      if (existing === undefined) {
        const stagingRoot = await mkdtemp(join(rootPath, ".chat-sop-"));
        try {
          const stagingFile = join(stagingRoot, `${name}.md`);
          await writeFile(stagingFile, renderSopDocument(draft), { encoding: "utf8", flag: "wx" });
          await rename(stagingFile, filePath);
          return { status: "created", document: { name, description: draft.description, path: filePath } };
        } finally {
          await rm(stagingRoot, { recursive: true, force: true });
        }
      }
      if (existing.isSymbolicLink()) throw new Error("SOP destination must not be a symbolic link");
      if (!existing.isFile()) throw new Error("SOP destination must be a file");
      const existingText = await readFile(filePath, "utf8");
      if (existingText === renderSopDocument(draft)) {
        return { status: "already_exists", document: { name, description: draft.description, path: filePath } };
      }
      suffix += 1;
    }
  });
}

function renderSopDocument(draft: DistilledSkillDraft): string {
  return [
    `# ${draft.description}`,
    "",
    "> 本文由已完成的 Chat 工作记录提炼生成，使用前请结合当前项目环境复核。",
    "",
    "## 适用场景",
    "",
    draft.description,
    "",
    "## 前置条件与输入",
    "",
    "- 明确本次任务目标、范围和验收标准。",
    "- 将项目路径、网址、账号角色等一次性值替换为当前环境变量。",
    "",
    "## 操作步骤",
    "",
    draft.instructions,
    "",
    "## 验收标准",
    "",
    "- 关键步骤有可复核的产物、测试或证据支持。",
    "- 不把未确认结论、秘密值或机器专属临时信息写入结果。",
    "",
    "## 安全边界",
    "",
    "- 密码、Token、Cookie、私钥和个人信息只能在运行时安全提供。",
    "- 发现路径、权限或结果与当前环境不一致时，应暂停并重新确认。",
    "",
    "## 来源",
    "",
    "- 来源：当前 Chat 的已确认工作记录。",
    "- 生成方式：安全过滤后由 Skill 提炼器生成。",
    "",
  ].join("\n");
}

async function withWriteQueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  writeQueues.set(key, queued);
  await previous;
  try { return await operation(); } finally { release(); if (writeQueues.get(key) === queued) writeQueues.delete(key); }
}

function assertWithinRoot(rootPath: string, targetPath: string, label: string): void {
  const pathFromRoot = relative(rootPath, targetPath);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) throw new Error(`${label} escapes SOP root`);
}

async function tryLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try { return await lstat(path); } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}
