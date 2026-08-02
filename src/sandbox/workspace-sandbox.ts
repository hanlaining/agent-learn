import {
  readFile,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import {
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

const DEFAULT_MAX_FILE_BYTES = 64 * 1024;
const DEFAULT_MAX_LIST_ENTRIES = 100;

export interface WorkspaceSandboxOptions {
  maxFileBytes?: number;
  maxListEntries?: number;
}

export interface SandboxFileEntry {
  path: string;
  type: "file" | "directory" | "symbolic_link";
}

export interface SandboxListResult {
  path: string;
  entries: SandboxFileEntry[];
  truncated: boolean;
}

export interface SandboxReadResult {
  path: string;
  text: string;
  sizeBytes: number;
}

/**
 * 教学级 Workspace Sandbox：所有文件能力都先经过这一层路径与容量检查。
 */
export class WorkspaceSandbox {
  private constructor(
    private readonly rootPath: string,
    private readonly maxFileBytes: number,
    private readonly maxListEntries: number,
  ) {}

  static async create(
    workspacePath: string,
    options: WorkspaceSandboxOptions = {},
  ): Promise<WorkspaceSandbox> {
    const rootPath = await realpath(workspacePath);
    const rootStats = await stat(rootPath);

    if (!rootStats.isDirectory()) {
      throw new Error("Workspace must be a directory");
    }

    const maxFileBytes =
      options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    const maxListEntries =
      options.maxListEntries ?? DEFAULT_MAX_LIST_ENTRIES;

    assertPositiveInteger(maxFileBytes, "maxFileBytes");
    assertPositiveInteger(
      maxListEntries,
      "maxListEntries",
    );

    return new WorkspaceSandbox(
      rootPath,
      maxFileBytes,
      maxListEntries,
    );
  }

  async readTextFile(
    requestedPath: string,
  ): Promise<SandboxReadResult> {
    const resolved = await this.resolveExistingPath(
      requestedPath,
    );
    const fileStats = await stat(resolved.absolutePath);

    if (!fileStats.isFile()) {
      throw new Error("Sandbox path is not a file");
    }

    if (fileStats.size > this.maxFileBytes) {
      throw new Error(
        `File exceeds ${this.maxFileBytes} byte limit`,
      );
    }

    const data = await readFile(resolved.absolutePath);

    if (data.includes(0)) {
      throw new Error("Binary file is not allowed");
    }

    let text: string;

    try {
      // fatal 模式会拒绝无效 UTF-8，避免把任意二进制误交给模型。
      text = new TextDecoder("utf-8", {
        fatal: true,
      }).decode(data);
    } catch {
      throw new Error("Binary file is not allowed");
    }

    return {
      path: resolved.relativePath,
      text,
      sizeBytes: fileStats.size,
    };
  }

  async listFiles(
    requestedPath = ".",
  ): Promise<SandboxListResult> {
    const resolved = await this.resolveExistingPath(
      requestedPath,
    );
    const directoryStats = await stat(
      resolved.absolutePath,
    );

    if (!directoryStats.isDirectory()) {
      throw new Error("Sandbox path is not a directory");
    }

    const directoryEntries = await readdir(
      resolved.absolutePath,
      { withFileTypes: true },
    );
    const safeEntries: SandboxFileEntry[] = [];

    for (
      const entry of directoryEntries.sort((left, right) =>
        left.name.localeCompare(right.name),
      )
    ) {
      const childRequestedPath =
        resolved.relativePath === "."
          ? entry.name
          : `${resolved.relativePath}/${entry.name}`;

      if (entry.isSymbolicLink()) {
        try {
          // 越界链接既不跟随，也不把外部目标信息暴露给调用方。
          await this.resolveExistingPath(childRequestedPath);
        } catch {
          continue;
        }
      }

      safeEntries.push({
        path: normalizeRelativePath(childRequestedPath),
        type: entry.isSymbolicLink()
          ? "symbolic_link"
          : entry.isDirectory()
            ? "directory"
            : "file",
      });
    }

    return {
      path: resolved.relativePath,
      entries: safeEntries.slice(0, this.maxListEntries),
      truncated: safeEntries.length > this.maxListEntries,
    };
  }

  private async resolveExistingPath(
    requestedPath: string,
  ): Promise<{
    absolutePath: string;
    relativePath: string;
  }> {
    if (
      requestedPath.length === 0 ||
      isAbsolute(requestedPath)
    ) {
      throw new Error("Path escapes workspace");
    }

    const candidatePath = resolve(
      this.rootPath,
      requestedPath,
    );

    if (!isWithin(this.rootPath, candidatePath)) {
      throw new Error("Path escapes workspace");
    }

    const realCandidatePath = await realpath(candidatePath);

    if (!isWithin(this.rootPath, realCandidatePath)) {
      throw new Error(
        "Path escapes workspace through symbolic link",
      );
    }

    const pathFromRoot = relative(
      this.rootPath,
      realCandidatePath,
    );

    return {
      absolutePath: realCandidatePath,
      relativePath:
        pathFromRoot.length === 0
          ? "."
          : normalizeRelativePath(pathFromRoot),
    };
  }
}

function isWithin(rootPath: string, targetPath: string): boolean {
  const pathFromRoot = relative(rootPath, targetPath);

  return (
    pathFromRoot.length === 0 ||
    (
      pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot)
    )
  );
}

function normalizeRelativePath(path: string): string {
  return path.split(sep).join("/");
}

function assertPositiveInteger(
  value: number,
  name: string,
): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}
