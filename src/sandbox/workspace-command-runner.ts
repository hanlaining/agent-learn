import {
  spawn,
  type ChildProcess,
} from "node:child_process";
import {
  realpath,
  stat,
} from "node:fs/promises";
import {
  join,
} from "node:path";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

export interface CommandRecipe {
  executable: string;
  arguments: readonly string[];
  display?: string;
}

export interface WorkspaceCommandRunnerOptions {
  recipes: Readonly<Record<string, CommandRecipe>>;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface CommandExecutionResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class CommandTimeoutError extends Error {
  constructor(command: string, timeoutMs: number) {
    super(`Command timed out after ${timeoutMs}ms: ${command}`);
    this.name = "CommandTimeoutError";
  }
}

export class CommandOutputLimitError extends Error {
  constructor(command: string, maxOutputBytes: number) {
    super(
      `Command output exceeds ${maxOutputBytes} byte limit: ` +
        command,
    );
    this.name = "CommandOutputLimitError";
  }
}

/**
 * 教学级命令 Sandbox：只运行预注册配方，不接受模型拼出的 shell 字符串。
 * 它提供最小执行边界，但不等同于容器、虚拟机或 OS 级隔离。
 */
export class WorkspaceCommandRunner {
  private constructor(
    private readonly workspacePath: string,
    private readonly recipes: Readonly<
      Record<string, CommandRecipe>
    >,
    private readonly timeoutMs: number,
    private readonly maxOutputBytes: number,
  ) {}

  static async create(
    workspacePath: string,
    options: WorkspaceCommandRunnerOptions,
  ): Promise<WorkspaceCommandRunner> {
    const resolvedWorkspace = await realpath(workspacePath);
    const workspaceStats = await stat(resolvedWorkspace);

    if (!workspaceStats.isDirectory()) {
      throw new Error("Workspace must be a directory");
    }

    const timeoutMs =
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutputBytes =
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

    assertPositiveInteger(timeoutMs, "timeoutMs");
    assertPositiveInteger(
      maxOutputBytes,
      "maxOutputBytes",
    );

    return new WorkspaceCommandRunner(
      resolvedWorkspace,
      { ...options.recipes },
      timeoutMs,
      maxOutputBytes,
    );
  }

  async run(
    command: string,
    signal: AbortSignal,
  ): Promise<CommandExecutionResult> {
    signal.throwIfAborted();
    const recipe = this.recipes[command];

    if (recipe === undefined) {
      throw new Error(
        `Command recipe is not allowed: ${command}`,
      );
    }

    const child = spawn(
      recipe.executable,
      [...recipe.arguments],
      {
        cwd: this.workspacePath,
        env: createFilteredEnvironment(),
        shell: false,
        // POSIX 使用独立进程组，取消时可以连同孙进程一起终止。
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    return new Promise((resolve, reject) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      let pendingError: unknown;

      const cleanup = () => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", handleAbort);
      };

      const rejectNow = (error: unknown) => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();

        reject(error);
      };

      const stopAndReject = (error: unknown) => {
        if (settled || pendingError !== undefined) {
          return;
        }

        pendingError = error;
        cleanup();

        if (child.exitCode === null) {
          terminateProcessTree(child);
          return;
        }

        rejectNow(error);
      };

      const capture = (
        chunks: Buffer[],
        chunk: Buffer,
      ) => {
        outputBytes += chunk.byteLength;

        if (outputBytes > this.maxOutputBytes) {
          stopAndReject(
            new CommandOutputLimitError(
              command,
              this.maxOutputBytes,
            ),
          );
          return;
        }

        chunks.push(chunk);
      };

      const handleAbort = () => {
        stopAndReject(signal.reason);
      };
      const timeout = setTimeout(() => {
        stopAndReject(
          new CommandTimeoutError(command, this.timeoutMs),
        );
      }, this.timeoutMs);

      signal.addEventListener("abort", handleAbort, {
        once: true,
      });
      child.stdout.on("data", (chunk: Buffer) => {
        capture(stdoutChunks, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        capture(stderrChunks, chunk);
      });
      child.once("error", (error) => {
        rejectNow(pendingError ?? error);
      });
      child.once("close", (exitCode) => {
        if (settled) {
          return;
        }

        if (pendingError !== undefined) {
          rejectNow(pendingError);
          return;
        }

        settled = true;
        cleanup();
        resolve({
          command,
          exitCode: exitCode ?? -1,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
        });
      });
    });
  }

  listCommands(): string[] {
    return Object.keys(this.recipes).sort();
  }

  getCommandDisplay(command: string): string | undefined {
    const recipe = this.recipes[command];

    if (recipe === undefined) {
      return undefined;
    }

    return (
      recipe.display ??
      [recipe.executable, ...recipe.arguments].join(" ")
    );
  }
}

/**
 * 只终止本 Runner 刚创建的 PID/进程组。Windows 使用系统 taskkill 的 /T，
 * POSIX 使用负 PID 定位独立进程组；失败时退回 Node 的单进程 kill。
 */
function terminateProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) {
    child.kill();
    return;
  }

  if (process.platform === "win32") {
    const systemRoot =
      process.env.SystemRoot ?? process.env.SYSTEMROOT;

    if (systemRoot === undefined) {
      child.kill();
      return;
    }

    const killer = spawn(
      join(systemRoot, "System32", "taskkill.exe"),
      ["/PID", String(child.pid), "/T", "/F"],
      {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      },
    );

    killer.once("error", () => {
      child.kill();
    });
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill();
  }
}

function createFilteredEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const allowedNames = [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
  ];

  for (const name of allowedNames) {
    const value = process.env[name];

    if (value !== undefined) {
      environment[name] = value;
    }
  }

  return environment;
}

function assertPositiveInteger(
  value: number,
  name: string,
): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}
