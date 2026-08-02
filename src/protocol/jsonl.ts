import {
  isJsonRpcMessage,
  type JsonRpcMessage,
} from "./json-rpc.js";

/**
 * 将 JSON-RPC 消息编码成一行 JSONL。
 */
export function encodeJsonRpcMessage(
  message: JsonRpcMessage,
): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * 将一行 JSONL 解码并校验为 JSON-RPC 消息。
 */
export function decodeJsonRpcLine(
  line: string,
): JsonRpcMessage {
  const normalizedLine = line.trim();

  if (normalizedLine.length === 0) {
    throw new Error("JSONL line cannot be empty");
  }

  let value: unknown;

  try {
    value = JSON.parse(normalizedLine);
  } catch {
    throw new Error("Invalid JSON");
  }

  if (!isJsonRpcMessage(value)) {
    throw new Error("Invalid JSON-RPC message");
  }

  return value;
}
/**
 * 将任意分块的文本流还原为完整 JSON-RPC 消息。
 */
export class JsonlMessageBuffer {
  private buffer = "";

  push(chunk: string): JsonRpcMessage[] {
    this.buffer += chunk;

    const messages: JsonRpcMessage[] = [];

    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");

      if (newlineIndex === -1) {
        break;
      }

      const line = this.buffer.slice(0, newlineIndex);

      this.buffer = this.buffer.slice(newlineIndex + 1);

      // 忽略空行
      if (line.trim().length === 0) {
        continue;
      }

      messages.push(decodeJsonRpcLine(line));
    }

    return messages;
  }

  /**
   * 数据流关闭时，处理最后一条没有换行符的消息。
   */
  finish(): JsonRpcMessage[] {
    const remaining = this.buffer;

    this.buffer = "";

    if (remaining.trim().length === 0) {
      return [];
    }

    return [decodeJsonRpcLine(remaining)];
  }
}