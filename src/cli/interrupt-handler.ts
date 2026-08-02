export interface CliInterruptSource {
  on(event: "SIGINT", listener: () => void): unknown;
}

export interface CliInterruptActions {
  hasActiveTurn: () => boolean;
  denyPendingPermission: () => void;
  cancelActiveTurn: () => void | Promise<void>;
  exitIdle: () => void;
  reportError: (error: unknown) => void;
}

/**
 * Ctrl+C 只负责路由意图；真正取消仍统一走 turn/cancel RPC。
 */
export function registerCliInterruptHandler(
  source: CliInterruptSource,
  actions: CliInterruptActions,
): void {
  source.on("SIGINT", () => {
    if (!actions.hasActiveTurn()) {
      actions.exitIdle();
      return;
    }

    // 防止审批仍挂起时 Tool 在取消竞态中被意外放行。
    actions.denyPendingPermission();
    void Promise.resolve(actions.cancelActiveTurn()).catch(
      actions.reportError,
    );
  });
}
