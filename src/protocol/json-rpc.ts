/**
 * 本项目对齐 Codex App Server 的线上消息结构，
 * 暂时省略标准 JSON-RPC 的 jsonrpc: "2.0" 字段。
 */

export type JsonRpcId = string | number;

/**
 * 请求：有 id，发送方等待响应。
 */
export interface JsonRpcRequest<TParams = unknown> {
  id: JsonRpcId;
  method: string;
  params?: TParams;
}

/**
 * 通知：没有 id，发送后不等待响应。
 */
export interface JsonRpcNotification<TParams = unknown> {
  method: string;
  params?: TParams;
}

/**
 * 请求成功后的响应。
 * id 必须与原请求一致。
 */
export interface JsonRpcSuccessResponse<TResult = unknown> {
  id: JsonRpcId;
  result: TResult;
}

/**
 * 错误的详细信息。
 */
export interface JsonRpcErrorObject<TData = unknown> {
  code: number;
  message: string;
  data?: TData;
}

/**
 * 请求失败后的响应。
 * id 必须与原请求一致。
 */
export interface JsonRpcErrorResponse<TData = unknown> {
  id: JsonRpcId;
  error: JsonRpcErrorObject<TData>;
}

/**
 * 系统允许传输的所有 JSON-RPC 消息。
 */
export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccessResponse
    | JsonRpcErrorResponse;

    function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || typeof value === "number";
}

export function isJsonRpcRequest(
  value: unknown,
): value is JsonRpcRequest {
  return (
    isObject(value) &&
    isJsonRpcId(value.id) &&
    typeof value.method === "string" &&
    !("result" in value) &&
    !("error" in value)
  );
}

export function isJsonRpcNotification(
  value: unknown,
): value is JsonRpcNotification {
  return (
    isObject(value) &&
    !("id" in value) &&
    typeof value.method === "string" &&
    !("result" in value) &&
    !("error" in value)
  );
}

export function isJsonRpcSuccessResponse(
  value: unknown,
): value is JsonRpcSuccessResponse {
  return (
    isObject(value) &&
    isJsonRpcId(value.id) &&
    "result" in value &&
    !("method" in value) &&
    !("error" in value)
  );
}

export function isJsonRpcErrorResponse(
  value: unknown,
): value is JsonRpcErrorResponse {
  if (
    !isObject(value) ||
    !isJsonRpcId(value.id) ||
    !isObject(value.error)
  ) {
    return false;
  }

  return (
    typeof value.error.code === "number" &&
    typeof value.error.message === "string" &&
    !("method" in value) &&
    !("result" in value)
  );
}
export type JsonRpcMessageKind =
  | "request"
  | "notification"
  | "success-response"
  | "error-response"
  | "invalid";

export function classifyJsonRpcMessage(
  value: unknown,
): JsonRpcMessageKind {
  if (isJsonRpcRequest(value)) {
    return "request";
  }

  if (isJsonRpcNotification(value)) {
    return "notification";
  }

  if (isJsonRpcSuccessResponse(value)) {
    return "success-response";
  }

  if (isJsonRpcErrorResponse(value)) {
    return "error-response";
  }

  return "invalid";
}
export function isJsonRpcMessage(
  value: unknown,
): value is JsonRpcMessage {
  return (
    isJsonRpcRequest(value) ||
    isJsonRpcNotification(value) ||
    isJsonRpcSuccessResponse(value) ||
    isJsonRpcErrorResponse(value)
  );
}

export type JsonRpcResponse =
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse;
