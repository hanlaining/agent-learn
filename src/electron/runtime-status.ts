export type RuntimeConnectionState =
  | "connecting"
  | "connected"
  | "failed"
  | "closed";

export type RuntimeFailureCode =
  | "start_failed"
  | "handshake_failed"
  | "unexpected_exit";

export type RuntimeStatus =
  | {
      state: "connecting";
      message: "Runtime 正在连接…";
    }
  | {
      state: "connected";
      message: "Runtime 已连接";
    }
  | {
      state: "failed";
      code: RuntimeFailureCode;
      message: string;
    }
  | {
      state: "closed";
      message: "Runtime 已关闭";
    };

export const CONNECTING_RUNTIME_STATUS: RuntimeStatus = {
  state: "connecting",
  message: "Runtime 正在连接…",
};

export const CONNECTED_RUNTIME_STATUS: RuntimeStatus = {
  state: "connected",
  message: "Runtime 已连接",
};

export const CLOSED_RUNTIME_STATUS: RuntimeStatus = {
  state: "closed",
  message: "Runtime 已关闭",
};

const SAFE_FAILURE_MESSAGES: Record<
  RuntimeFailureCode,
  string
> = {
  start_failed: "Runtime 启动失败，请关闭后重试",
  handshake_failed: "Runtime 连接失败，请关闭后重试",
  unexpected_exit: "Runtime 意外关闭，请关闭后重试",
};

/**
 * Renderer 只能得到固定错误码和安全文案，不能得到原始异常、路径或环境变量。
 */
export function createSafeRuntimeFailure(
  code: RuntimeFailureCode,
): RuntimeStatus {
  return {
    state: "failed",
    code,
    message: SAFE_FAILURE_MESSAGES[code],
  };
}

