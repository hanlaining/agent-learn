import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  createInterface,
  type Interface as ReadlineInterface,
} from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { JsonRpcConnection } from "../protocol/connection.js";
import {
  isAgentEvent,
  type AgentEvent,
} from "../agent/events.js";
import { isThread } from "../runtime/lifecycle.js";
import {
  isTurnStartResult,
} from "../runtime/turn-start.js";
import {
  isTurnRunResult,
} from "../runtime/turn-run.js";

const CLI_NAME = "god-agent";

async function main(): Promise<void> {
  let inputReader: ReadlineInterface | undefined;

  const appServerEntry = fileURLToPath(
    new URL("../app-server/main.ts", import.meta.url),
  );

  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      appServerEntry,
    ],
    {
      stdio: [
        "pipe",
        "pipe",
        "pipe",
      ],
    },
  );

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  const connection = new JsonRpcConnection((data) => {
    child.stdin.write(data);
  });

  const eventRenderer = new CliAgentEventRenderer();

  connection.onNotification("agent/event", (params) => {
    if (!isAgentEvent(params)) {
      process.stderr.write(
        "[client] ignored invalid agent/event\n",
      );
      return;
    }

    eventRenderer.render(params);
  });

  child.stdout.on("data", (chunk: string) => {
    void connection.receive(chunk);
  });

  child.stderr.on("data", (chunk: string) => {
    process.stderr.write(chunk);
  });

  child.on("exit", () => {
    connection.close();
    inputReader?.close();
  });

  try {
    const result = await connection.sendRequest(
      "initialize",
      {
        clientName: CLI_NAME,
        protocolVersion: 1,
      },
    );

    console.log(`[${CLI_NAME}] Initialize result:`);
    console.log(result);

    connection.sendNotification("initialized");

    // 握手后通过 RPC 创建 Thread，而不是在 CLI 内部直接 new 一个对象。
    const threadResult = await connection.sendRequest(
      "thread/start",
    );

    if (!isThread(threadResult)) {
      throw new Error("Invalid thread/start response");
    }

    console.log(
      `\nThread 已创建：${threadResult.id} (${threadResult.status})`,
    );

    inputReader = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    console.log(
      `${CLI_NAME} 已启动。输入问题并按回车，输入 /exit 退出。`,
    );
    console.log(
      "当前多个 Turn 共用同一 Thread；跨 Turn 上下文将在下一步接入。",
    );

    writePrompt();

    // 一个 CLI 会话只创建一个 Thread；每一行用户输入创建一个新 Turn。
    for await (const line of inputReader) {
      const input = line.trim();

      if (input === "/exit") {
        console.log(`\n${CLI_NAME} 已退出。`);
        break;
      }

      if (input.length === 0) {
        writePrompt();
        continue;
      }

      try {
        await runTurn(
          connection,
          eventRenderer,
          threadResult.id,
          input,
        );
      } catch (error) {
        console.error(
          `\n[CLI] 本轮执行失败：${readErrorMessage(error)}`,
        );

        if (child.exitCode !== null) {
          break;
        }
      }

      writePrompt();
    }
  } finally {
    inputReader?.close();

    // 成功、API 错误或超时都必须关闭子进程，避免 CLI 永久挂住。
    child.stdin.end();

    if (child.exitCode === null) {
      await once(child, "exit");
    }
  }
}

async function runTurn(
  connection: JsonRpcConnection,
  eventRenderer: CliAgentEventRenderer,
  threadId: string,
  input: string,
): Promise<void> {
  eventRenderer.beginTurn();

  // 用户每输入一次，就在同一 Thread 下创建一个独立 Turn。
  const turnResult = await connection.sendRequest(
    "turn/start",
    {
      threadId,
      input,
    },
  );

  if (!isTurnStartResult(turnResult)) {
    throw new Error("Invalid turn/start response");
  }

  console.log(
    `Turn 已创建：${turnResult.turn.id} (${turnResult.turn.status})`,
  );
  console.log(
    `用户消息 Item：${turnResult.userMessage.id}`,
  );

  // Agent Loop 会让 LLM 选择 Tool，再把确定性 Tool 结果交还给 LLM。
  const runResult = await connection.sendRequest(
    "turn/run",
    {
      turnId: turnResult.turn.id,
    },
  );

  if (!isTurnRunResult(runResult)) {
    throw new Error("Invalid turn/run response");
  }

  // 非流式 Provider 没有 delta 时，使用最终 Item 作为降级展示。
  if (!eventRenderer.receivedAssistantDelta) {
    console.log(
      `\n[Assistant]\n${readItemText(
        runResult.assistantMessage.content,
      )}`,
    );
  }
}

function writePrompt(): void {
  process.stdout.write(`\n${CLI_NAME}> `);
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : String(error);
}

function readItemText(content: unknown): string {
  if (
    typeof content !== "object" ||
    content === null ||
    !("text" in content) ||
    typeof content.text !== "string"
  ) {
    throw new Error("Assistant Item has no text");
  }

  return content.text;
}

class CliAgentEventRenderer {
  receivedAssistantDelta = false;

  private openStream:
    | "reasoning"
    | "assistant"
    | undefined;

  beginTurn(): void {
    this.endOpenStream();
    this.receivedAssistantDelta = false;
  }

  render(event: AgentEvent): void {
    switch (event.type) {
      case "turn/started":
        this.endOpenStream();
        console.log(
          `[Turn] started ${event.turnId}`,
        );
        return;

      case "model/started":
        this.endOpenStream();
        console.log(
          `[Model] round ${event.round + 1} started`,
        );
        return;

      case "reasoning/summary_delta":
        this.writeDelta(
          "reasoning",
          "[Reasoning summary]\n",
          event.delta,
        );
        return;

      case "assistant/delta":
        this.receivedAssistantDelta = true;
        this.writeDelta(
          "assistant",
          "[Assistant]\n",
          event.delta,
        );
        return;

      case "model/completed":
        this.endOpenStream();
        console.log(
          event.functionCallCount > 0
            ? `[Model] selected ${event.functionCallCount} tool(s)`
            : "[Model] final response completed",
        );
        return;

      case "tool/started":
        this.endOpenStream();
        console.log(
          `[Tool] started ${event.toolName}`,
        );
        return;

      case "tool/completed":
        this.endOpenStream();
        console.log(
          `[Tool] completed ${event.toolName}`,
        );
        return;

      case "turn/completed":
        this.endOpenStream();
        console.log(
          `[Turn] completed ${event.turnId}`,
        );
        return;

      case "turn/failed":
        this.endOpenStream();
        console.log(
          `[Turn] failed ${event.turnId}: ${event.message}`,
        );
    }
  }

  private writeDelta(
    stream: "reasoning" | "assistant",
    heading: string,
    delta: string,
  ): void {
    if (this.openStream !== stream) {
      this.endOpenStream();
      process.stdout.write(`${heading}`);
      this.openStream = stream;
    }

    process.stdout.write(delta);
  }

  private endOpenStream(): void {
    if (this.openStream !== undefined) {
      process.stdout.write("\n");
      this.openStream = undefined;
    }
  }
}

// class 声明完成后再启动 CLI，避免在初始化前访问 CliAgentEventRenderer。
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
