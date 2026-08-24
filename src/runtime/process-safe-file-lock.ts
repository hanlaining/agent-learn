import { randomUUID } from "node:crypto";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import {
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ProcessSafeFileLockOptions {
  lockTimeoutMs?: number;
  staleLockMs?: number;
  retryDelayMs?: number;
}

interface HeldFileLock {
  token: string;
  claimPath: string;
}

interface FileLockClaim {
  token: string;
  incarnation: string;
  processId: number;
  phase: "choosing" | "ticket";
  ticket?: number;
  path: string;
}

const processIncarnation = randomUUID();
// Keep the established endpoint name so live processes from the pre-extraction
// implementation remain detectable during rolling local upgrades.
const processLivenessEndpoint = process.platform === "win32"
  ? `\\\\.\\pipe\\god-agent-runtime-lease-${processIncarnation}`
  : join(tmpdir(), `.god-agent-runtime-lease-${processIncarnation}.sock`);
let processLivenessReady: Promise<void> | undefined;
const processLivenessServers = new Set<Server>();

/**
 * Cross-process mutex backed by immutable Bakery-algorithm claim files.
 *
 * A crashed process only abandons its own claim. Once the claim is old enough,
 * liveness is checked through a per-process endpoint before recovery removes
 * it, so a live slow holder is never stolen merely because time elapsed.
 */
export class ProcessSafeFileLock {
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly retryDelayMs: number;

  constructor(
    private readonly lockPath: string,
    options: ProcessSafeFileLockOptions = {},
    private readonly description = "file",
  ) {
    if (lockPath.trim().length === 0) throw new Error("Lock path must not be empty");
    this.staleLockMs = positiveInteger(options.staleLockMs ?? 30_000, "staleLockMs");
    this.lockTimeoutMs = positiveInteger(
      options.lockTimeoutMs ?? this.staleLockMs + 10_000,
      "lockTimeoutMs",
    );
    this.retryDelayMs = positiveInteger(options.retryDelayMs ?? 10, "retryDelayMs");
  }

  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const held = await this.acquire();
    try {
      return await operation();
    } finally {
      await this.release(held);
    }
  }

  private async acquire(): Promise<HeldFileLock> {
    await mkdir(dirname(this.lockPath), { recursive: true });
    await mkdir(this.lockPath, { recursive: true });
    await ensureProcessLivenessEndpoint();
    const timeoutAt = Date.now() + this.lockTimeoutMs;
    const token = `${process.pid}_${processIncarnation}_${randomUUID()}`;
    let claimPath = join(this.lockPath, `choosing-${token}`);

    try {
      await writeFile(claimPath, "", { flag: "wx" });
      const ticket = await this.nextTicket();
      const ticketPath = join(
        this.lockPath,
        `ticket-${String(ticket).padStart(16, "0")}-${token}`,
      );
      await rename(claimPath, ticketPath);
      claimPath = ticketPath;

      while (true) {
        const claims = await this.readClaims();
        await this.removeStaleClaims(claims, token);
        const blockers = (await this.readClaims()).filter((claim) => {
          if (claim.token === token) return false;
          if (claim.phase === "choosing") return true;
          return compareClaims(claim, { token, ticket }) < 0;
        });
        if (blockers.length === 0) return { token, claimPath };
        if (Date.now() >= timeoutAt) {
          throw new Error(`Timed out acquiring ${this.description} lock: ${this.lockPath}`);
        }
        await sleep(this.retryDelayMs);
      }
    } catch (error) {
      await rm(claimPath, { force: true });
      throw error;
    }
  }

  private async nextTicket(): Promise<number> {
    const tickets = (await this.readClaims())
      .flatMap((claim) => claim.ticket === undefined ? [] : [claim.ticket]);
    const ticket = Math.max(0, ...tickets) + 1;
    if (!Number.isSafeInteger(ticket)) throw new Error(`${this.description} lock ticket overflow`);
    return ticket;
  }

  private async readClaims(): Promise<FileLockClaim[]> {
    const names = await readdir(this.lockPath);
    return names.flatMap((name) => {
      const claim = parseClaim(name, this.lockPath);
      return claim === undefined ? [] : [claim];
    });
  }

  private async removeStaleClaims(
    claims: FileLockClaim[],
    ownToken: string,
  ): Promise<void> {
    await Promise.all(claims.map(async (claim) => {
      if (claim.token === ownToken) return;
      let claimStat;
      try {
        claimStat = await stat(claim.path);
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) return;
        // Windows can report EPERM during another contender's atomic rename or
        // release. An indeterminate claim stays live until the next scan.
        if (process.platform === "win32" && hasErrorCode(error, "EPERM")) return;
        throw error;
      }
      if (Date.now() - claimStat.mtimeMs < this.staleLockMs) return;
      if (await isProcessAlive(claim)) return;
      await rm(claim.path, { force: true });
    }));
  }

  private async release(held: HeldFileLock): Promise<void> {
    try {
      await rm(held.claimPath);
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
      throw new Error(`${this.description} lock was lost before release`);
    }
  }
}

function parseClaim(name: string, lockPath: string): FileLockClaim | undefined {
  const choosing = /^choosing-(\d+)_([0-9a-f-]+)_([0-9a-f-]+)$/u.exec(name);
  if (choosing !== null) {
    const processId = Number(choosing[1]);
    const incarnation = choosing[2]!;
    if (!Number.isSafeInteger(processId) || processId <= 0) return undefined;
    return {
      token: `${choosing[1]}_${incarnation}_${choosing[3]}`,
      incarnation,
      processId,
      phase: "choosing",
      path: join(lockPath, name),
    };
  }
  const ticket = /^ticket-(\d+)-(\d+)_([0-9a-f-]+)_([0-9a-f-]+)$/u.exec(name);
  if (ticket === null) return undefined;
  const ticketNumber = Number(ticket[1]);
  const processId = Number(ticket[2]);
  const incarnation = ticket[3]!;
  if (
    !Number.isSafeInteger(ticketNumber) || ticketNumber <= 0 ||
    !Number.isSafeInteger(processId) || processId <= 0
  ) return undefined;
  return {
    token: `${ticket[2]}_${incarnation}_${ticket[4]}`,
    incarnation,
    processId,
    phase: "ticket",
    ticket: ticketNumber,
    path: join(lockPath, name),
  };
}

function compareClaims(
  left: Pick<FileLockClaim, "ticket" | "token">,
  right: Pick<FileLockClaim, "ticket" | "token">,
): number {
  const ticketDifference = left.ticket! - right.ticket!;
  if (ticketDifference !== 0) return ticketDifference;
  return left.token < right.token ? -1 : left.token > right.token ? 1 : 0;
}

async function ensureProcessLivenessEndpoint(): Promise<void> {
  processLivenessReady ??= (async () => {
    if (process.platform !== "win32") await rm(processLivenessEndpoint, { force: true });
    await new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => socket.end());
      processLivenessServers.add(server);
      server.unref();
      server.once("error", reject);
      server.listen(processLivenessEndpoint, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  })();
  return processLivenessReady;
}

function isProcessAlive(claim: FileLockClaim): Promise<boolean> {
  if (claim.incarnation === processIncarnation) return Promise.resolve(true);
  const endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\god-agent-runtime-lease-${claim.incarnation}`
    : join(tmpdir(), `.god-agent-runtime-lease-${claim.incarnation}.sock`);
  return new Promise((resolve) => {
    const socket = createConnection(endpoint);
    let settled = false;
    const finish = (alive: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(alive);
    };
    const timeout = setTimeout(() => finish(true), 250);
    timeout.unref();
    socket.once("connect", () => finish(true));
    socket.once("error", (error) => finish(!(
      hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ECONNREFUSED")
    )));
  });
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
