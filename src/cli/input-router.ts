export interface CliInputRoute {
  handled: boolean;
  cancelRequested: boolean;
}

interface PendingPermissionInput {
  resolve: (answer: string) => void;
}

/**
 * readline 永远只有主循环这一个消费者；反向审批通过 Router 等待下一行。
 */
export class CliInputRouter {
  private pendingPermission:
    | PendingPermissionInput
    | undefined;
  private closed = false;

  constructor(
    private readonly write: (text: string) => void,
  ) {}

  async requestPermission(prompt: string): Promise<string> {
    if (this.closed) {
      throw new Error("CLI input router is closed");
    }

    if (this.pendingPermission !== undefined) {
      throw new Error("Permission input is already pending");
    }

    this.write(prompt);

    return new Promise<string>((resolve) => {
      this.pendingPermission = { resolve };
    });
  }

  consumeLine(line: string): CliInputRoute {
    const pending = this.pendingPermission;

    if (pending === undefined) {
      return {
        handled: false,
        cancelRequested: false,
      };
    }

    this.pendingPermission = undefined;
    const cancelRequested =
      line.trim().toLowerCase() === "/cancel";

    // /cancel 先作为 deny 回答审批，保证 Tool 不会在取消竞态中启动。
    pending.resolve(cancelRequested ? "n" : line);

    return {
      handled: true,
      cancelRequested,
    };
  }

  denyPendingPermission(): boolean {
    const pending = this.pendingPermission;

    if (pending === undefined) {
      return false;
    }

    this.pendingPermission = undefined;
    pending.resolve("n");
    return true;
  }

  close(): void {
    this.closed = true;
    this.denyPendingPermission();
  }
}
