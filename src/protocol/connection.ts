import {
  isJsonRpcErrorResponse,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcSuccessResponse,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
} from "./json-rpc.js";

import {
  encodeJsonRpcMessage,
  JsonlMessageBuffer,
} from "./jsonl.js";

import { RequestMap } from "./request-map.js";

export type RequestHandler = (
  params: unknown,
  request: JsonRpcRequest,
) => unknown | Promise<unknown>;

export type NotificationHandler = (
  params: unknown,
  notification: JsonRpcNotification,
) => void | Promise<void>;

export class JsonRpcConnection {
  private nextRequestId = 1;

  private readonly requestMap = new RequestMap();
  private readonly messageBuffer = new JsonlMessageBuffer();

  private readonly requestHandlers =
    new Map<string, RequestHandler>();

  private readonly notificationHandlers =
    new Map<string, NotificationHandler>();

  constructor(
    private readonly write: (data: string) => void,
  ) {}

  /**
   * 发送 Request 并等待对应 Response。
   */
  sendRequest(
    method: string,
    params?: unknown,
  ): Promise<unknown> {
    const id = this.nextRequestId++;

    const request: JsonRpcRequest =
      params === undefined
        ? {
            id,
            method,
          }
        : {
            id,
            method,
            params,
          };

    const resultPromise = this.requestMap.create(id);

    this.sendMessage(request);

    return resultPromise;
  }

  /**
   * 发送不需要响应的 Notification。
   */
  sendNotification(
    method: string,
    params?: unknown,
  ): void {
    const notification: JsonRpcNotification =
      params === undefined
        ? {
            method,
          }
        : {
            method,
            params,
          };

    this.sendMessage(notification);
  }

  /**
   * 注册 Request 处理函数。
   */
  onRequest(
    method: string,
    handler: RequestHandler,
  ): void {
    this.requestHandlers.set(method, handler);
  }

  /**
   * 注册 Notification 处理函数。
   */
  onNotification(
    method: string,
    handler: NotificationHandler,
  ): void {
    this.notificationHandlers.set(method, handler);
  }

  /**
   * 接收任意长度的数据块。
   */
  async receive(chunk: string): Promise<void> {
    const messages = this.messageBuffer.push(chunk);

    for (const message of messages) {
      await this.handleMessage(message);
    }
  }

  /**
   * 连接关闭时清理仍在等待的请求。
   */
  close(): void {
    this.requestMap.rejectAll(
      new Error("JSON-RPC connection closed"),
    );
  }

  private sendMessage(message: JsonRpcMessage): void {
    const line = encodeJsonRpcMessage(message);

    this.write(line);
  }

  private async handleMessage(
    message: JsonRpcMessage,
  ): Promise<void> {
    if (
      isJsonRpcSuccessResponse(message) ||
      isJsonRpcErrorResponse(message)
    ) {
      this.requestMap.handleResponse(message);
      return;
    }

    if (isJsonRpcRequest(message)) {
      await this.handleRequest(message);
      return;
    }

    if (isJsonRpcNotification(message)) {
      await this.handleNotification(message);
    }
  }

  private async handleRequest(
    request: JsonRpcRequest,
  ): Promise<void> {
    const handler = this.requestHandlers.get(
      request.method,
    );

    if (handler === undefined) {
      this.sendMessage({
        id: request.id,
        error: {
          code: -32601,
          message: `Method not found: ${request.method}`,
        },
      });

      return;
    }

    try {
      const result = await handler(
        request.params,
        request,
      );

      this.sendMessage({
        id: request.id,
        result,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unknown internal error";

      this.sendMessage({
        id: request.id,
        error: {
          code: -32603,
          message,
        },
      });
    }
  }

  private async handleNotification(
    notification: JsonRpcNotification,
  ): Promise<void> {
    const handler = this.notificationHandlers.get(
      notification.method,
    );

    if (handler === undefined) {
      return;
    }

    await handler(
      notification.params,
      notification,
    );
  }
}