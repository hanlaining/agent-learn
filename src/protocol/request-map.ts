import type {
  JsonRpcErrorObject,
  JsonRpcId,
  JsonRpcResponse,
} from "./json-rpc.js";

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

export class JsonRpcRemoteError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "JsonRpcRemoteError";
  }
}

export class RequestMap {
  private readonly pendingRequests =
    new Map<JsonRpcId, PendingRequest>();

  get size(): number {
    return this.pendingRequests.size;
  }

  /**
   * 注册一个正在等待响应的请求。
   */
  create(id: JsonRpcId): Promise<unknown> {
    if (this.pendingRequests.has(id)) {
      throw new Error(`Duplicate JSON-RPC id: ${id}`);
    }

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve,
        reject,
      });
    });
  }

  /**
   * 收到 Response 后，通过 id 找到原 Request。
   */
  handleResponse(response: JsonRpcResponse): boolean {
    const pending = this.pendingRequests.get(response.id);

    if (pending === undefined) {
      return false;
    }

    this.pendingRequests.delete(response.id);

    if ("result" in response) {
      pending.resolve(response.result);
    } else {
      pending.reject(this.createRemoteError(response.error));
    }

    return true;
  }

  /**
   * 连接关闭时，拒绝所有尚未完成的请求。
   */
  rejectAll(
    error: Error = new Error("JSON-RPC connection closed"),
  ): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }

    this.pendingRequests.clear();
  }

  private createRemoteError(
    error: JsonRpcErrorObject,
  ): JsonRpcRemoteError {
    return new JsonRpcRemoteError(
      error.code,
      error.message,
      error.data,
    );
  }
}