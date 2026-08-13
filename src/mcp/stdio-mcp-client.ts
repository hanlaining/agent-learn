import {
  once,
} from "node:events";
import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";

import {
  isJsonRpcErrorResponse,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcSuccessResponse,
  type JsonRpcId,
  type JsonRpcMessage,
} from "../protocol/json-rpc.js";
import {
  JsonlMessageBuffer,
} from "../protocol/jsonl.js";
import {
  RequestMap,
  JsonRpcRemoteError,
} from "../protocol/request-map.js";
import {
  createMcpRequestMeta,
  MCP_JSON_RPC_VERSION,
  MCP_LEGACY_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION,
  parseLegacyMcpInitializeResult,
  parseMcpDiscovery,
  parseMcpToolCallResult,
  parseMcpToolListPage,
  type McpTool,
  type McpToolCallResult,
  type McpDiscovery,
  type McpImplementation,
  type McpToolListPage,
} from "./mcp-protocol.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 1_000;

export interface McpStdioClientOptions {
  command: string;
  args?: readonly string[];
  cwd?: string;
  clientInfo?: McpImplementation;
  protocolVersion?: string;
  requestTimeoutMs?: number;
}

type ClientState = "open" | "closing" | "closed";
type McpProtocolMode = "request-meta" | "legacy-initialize";

/**
 * MCP stdio Client 的第一个可验证切片。
 * stdout 只解析一行一个 JSON-RPC 2.0 消息；stderr 只排空，绝不混进协议或回显秘密。
 */
export class McpStdioClient {
  private nextRequestId = 1;
  private readonly requestMap = new RequestMap();
  private readonly messageBuffer = new JsonlMessageBuffer();
  private outputQueue: Promise<void> = Promise.resolve();
  private state: ClientState = "open";
  private protocolMode: McpProtocolMode = "request-meta";
  private activeProtocolVersion: string;
  private discoveryValue: McpDiscovery | undefined;
  private readonly ignoredResponseIds = new Set<JsonRpcId>();

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly preferredProtocolVersion: string,
    private readonly clientInfo: McpImplementation,
    private readonly requestTimeoutMs: number,
  ) {
    this.activeProtocolVersion = preferredProtocolVersion;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.outputQueue = this.outputQueue
        .then(() => this.receive(chunk))
        .catch((error: unknown) => {
          this.fail(toError(error));
        });
    });
    child.stdout.once("end", () => {
      this.outputQueue = this.outputQueue
        .then(() => this.finishOutput())
        .catch((error: unknown) => {
          this.fail(toError(error));
        });
    });

    // MCP Server 的诊断日志属于不可信输出；第一版只排空，不拼进异常消息。
    child.stderr.resume();
    child.once("error", (error) => {
      this.fail(error);
    });
    child.once("close", (code, signal) => {
      void this.outputQueue.finally(() => {
        if (this.state === "open") {
          this.fail(new Error(
            `MCP Server exited unexpectedly: code=${String(code)}, signal=${String(signal)}`,
          ));
        } else {
          this.state = "closed";
        }
      });
    });
  }

  static async start(
    options: McpStdioClientOptions,
  ): Promise<McpStdioClient> {
    validateOptions(options);
    const protocolVersion =
      options.protocolVersion ?? MCP_PROTOCOL_VERSION;
    const clientInfo = options.clientInfo ?? {
      name: "god-agent",
      version: "1.0.0",
    };
    const requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const child = spawn(
      options.command,
      [...(options.args ?? [])],
      {
        ...(options.cwd === undefined
          ? {}
          : { cwd: options.cwd }),
        env: createFilteredEnvironment(),
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const client = new McpStdioClient(
      child,
      protocolVersion,
      clientInfo,
      requestTimeoutMs,
    );

    try {
      await client.discover();
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  get discovery(): McpDiscovery {
    if (this.discoveryValue === undefined) {
      throw new Error("MCP Server discovery is not complete");
    }

    return {
      ...this.discoveryValue,
      supportedVersions: [
        ...this.discoveryValue.supportedVersions,
      ],
      capabilities: {
        ...this.discoveryValue.capabilities,
      },
    };
  }

  get isClosed(): boolean {
    return this.state === "closed";
  }

  get protocolVersion(): string {
    return this.activeProtocolVersion;
  }

  async listTools(cursor?: string): Promise<McpToolListPage> {
    const discovery = this.discovery;

    if (!("tools" in discovery.capabilities)) {
      throw new Error("MCP Server does not advertise tools");
    }

    const result = await this.sendRequest(
      "tools/list",
      cursor === undefined ? {} : { cursor },
    );

    return parseMcpToolListPage(result);
  }

  async listAllTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    const names = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;

    do {
      const page = await this.listTools(cursor);

      for (const tool of page.tools) {
        if (names.has(tool.name)) {
          throw new Error(
            `Duplicate MCP Tool name across pages: ${tool.name}`,
          );
        }

        names.add(tool.name);
        tools.push(tool);
      }

      cursor = page.nextCursor;

      if (cursor !== undefined) {
        if (cursor.length === 0 || cursors.has(cursor)) {
          throw new Error("Invalid repeated MCP tools/list cursor");
        }

        cursors.add(cursor);
      }
    } while (cursor !== undefined);

    return tools;
  }

  async callTool(
    name: string,
    argumentsValue: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpToolCallResult> {
    if (name.trim().length === 0) {
      throw new Error("MCP Tool name must not be empty");
    }

    const result = await this.sendRequest(
      "tools/call",
      {
        name,
        arguments: argumentsValue,
      },
      signal,
    );

    return parseMcpToolCallResult(result);
  }

  async close(): Promise<void> {
    if (this.state === "closed") {
      return;
    }

    this.state = "closing";
    this.requestMap.rejectAll(
      new Error("MCP stdio Client closed"),
    );
    this.ignoredResponseIds.clear();

    if (
      this.child.exitCode === null &&
      this.child.signalCode === null
    ) {
      const closePromise = waitForChildClose(this.child);

      this.child.kill();
      await closePromise;
    }

    this.state = "closed";
  }

  private async discover(): Promise<void> {
    try {
      const result = await this.sendRequest(
        "server/discover",
        {},
      );
      const discovery = parseMcpDiscovery(result);

      if (
        !discovery.supportedVersions.includes(
          this.preferredProtocolVersion,
        )
      ) {
        throw new Error(
          "MCP Server does not support protocol " +
            this.preferredProtocolVersion,
        );
      }

      this.discoveryValue = discovery;
    } catch (error) {
      if (
        !(error instanceof JsonRpcRemoteError) ||
        error.code !== -32601
      ) {
        throw error;
      }

      // 旧 Server 不认识 server/discover 时，再回退到 2025-11-25 握手。
      await this.initializeLegacyServer();
    }
  }

  private async initializeLegacyServer(): Promise<void> {
    this.protocolMode = "legacy-initialize";
    this.activeProtocolVersion = MCP_LEGACY_PROTOCOL_VERSION;

    const result = await this.sendRequest("initialize", {
      protocolVersion: MCP_LEGACY_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { ...this.clientInfo },
    });
    const discovery = parseLegacyMcpInitializeResult(result);

    if (
      !discovery.supportedVersions.includes(
        MCP_LEGACY_PROTOCOL_VERSION,
      )
    ) {
      throw new Error(
        `MCP Server does not support protocol ${MCP_LEGACY_PROTOCOL_VERSION}`,
      );
    }

    this.write({
      jsonrpc: MCP_JSON_RPC_VERSION,
      method: "notifications/initialized",
    });
    this.discoveryValue = discovery;
  }

  private sendRequest(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    this.assertOpen();
    if (signal?.aborted === true) {
      return Promise.reject(toAbortError(signal.reason));
    }

    const id = this.nextRequestId++;
    const resultPromise = this.requestMap.create(id);
    const requestParams =
      this.protocolMode === "request-meta"
        ? {
            ...params,
            _meta: createMcpRequestMeta(
              this.activeProtocolVersion,
              this.clientInfo,
            ),
          }
        : params;

    this.write({
      jsonrpc: MCP_JSON_RPC_VERSION,
      id,
      method,
      params: requestParams,
    });

    const timeout = setTimeout(() => {
      this.cancelPendingRequest(
        id,
        new Error(`MCP request timed out: ${method}`),
      );
    }, this.requestTimeoutMs);

    const handleAbort = () => {
      this.cancelPendingRequest(
        id,
        toAbortError(signal?.reason),
      );
    };

    signal?.addEventListener("abort", handleAbort, {
      once: true,
    });

    return resultPromise.finally(() => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", handleAbort);
    });
  }

  private cancelPendingRequest(
    id: JsonRpcId,
    error: Error,
  ): void {
    if (!this.requestMap.reject(id, error)) {
      return;
    }

    // Server 可能仍返回这个请求的结果；记录 ID 后忽略迟到响应，不关闭整条连接。
    this.ignoredResponseIds.add(id);
    if (this.state === "open") {
      this.write({
        jsonrpc: MCP_JSON_RPC_VERSION,
        method: "notifications/cancelled",
        params: {
          requestId: id,
          reason: "Client cancelled the request",
        },
      });
    }
  }

  private async receive(chunk: string): Promise<void> {
    for (const message of this.messageBuffer.push(chunk)) {
      await this.handleMessage(message);
    }
  }

  private async finishOutput(): Promise<void> {
    for (const message of this.messageBuffer.finish()) {
      await this.handleMessage(message);
    }
  }

  private async handleMessage(
    message: JsonRpcMessage,
  ): Promise<void> {
    if (!hasMcpJsonRpcVersion(message)) {
      throw new Error(
        "Invalid MCP message: jsonrpc must be 2.0",
      );
    }

    if (
      isJsonRpcSuccessResponse(message) ||
      isJsonRpcErrorResponse(message)
    ) {
      if (!this.requestMap.handleResponse(message)) {
        if (this.ignoredResponseIds.delete(message.id)) {
          return;
        }

        throw new Error(
          `Unknown MCP response id: ${String(message.id)}`,
        );
      }

      return;
    }

    if (isJsonRpcRequest(message)) {
      // 当前 Client 没有声明 sampling/elicitation 等反向能力，未知请求必须明确拒绝。
      this.write({
        jsonrpc: MCP_JSON_RPC_VERSION,
        id: message.id,
        error: {
          code: -32601,
          message: `Method not found: ${message.method}`,
        },
      });
      return;
    }

    if (isJsonRpcNotification(message)) {
      return;
    }
  }

  private write(
    message: JsonRpcMessage & { jsonrpc: "2.0" },
  ): void {
    this.assertOpen();
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private assertOpen(): void {
    if (this.state !== "open") {
      throw new Error("MCP stdio Client is closed");
    }
  }

  private fail(error: Error): void {
    if (this.state !== "open") {
      return;
    }

    this.state = "closed";
    this.requestMap.rejectAll(error);

    if (
      this.child.exitCode === null &&
      this.child.signalCode === null
    ) {
      this.child.kill();
    }
  }
}

function hasMcpJsonRpcVersion(
  message: JsonRpcMessage,
): boolean {
  return (
    "jsonrpc" in message &&
    message.jsonrpc === MCP_JSON_RPC_VERSION
  );
}

function validateOptions(options: McpStdioClientOptions): void {
  if (options.command.trim().length === 0) {
    throw new Error("MCP command must not be empty");
  }

  if (
    options.args?.some(
      (argument) => typeof argument !== "string",
    ) === true
  ) {
    throw new Error("MCP args must contain only strings");
  }

  const timeout =
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new Error(
      "MCP requestTimeoutMs must be a positive integer",
    );
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

async function waitForChildClose(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      once(child, "close").then(() => undefined),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, CLOSE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("Unknown MCP stdio error");
}

function toAbortError(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new Error("MCP request aborted");
}
