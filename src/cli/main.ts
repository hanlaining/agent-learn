import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  isAgentEvent,
  type AgentEvent,
} from "../agent/events.js";
import { JsonRpcConnection } from "../protocol/connection.js";
import { JsonRpcRemoteError } from "../protocol/request-map.js";
import {
  isThread,
  type Thread,
  type TurnId,
} from "../runtime/lifecycle.js";
import {
  isTurnCancelResult,
} from "../runtime/turn-cancel.js";
import {
  isTurnRunResult,
} from "../runtime/turn-run.js";
import {
  isTurnStartResult,
  type TurnStartResult,
} from "../runtime/turn-start.js";
import { CLI_COMMAND_REGISTRY } from "../shortcuts/builtins.js";
import { CliInputRouter } from "./input-router.js";
import {
  registerCliInterruptHandler,
} from "./interrupt-handler.js";
import { CliMessageQueue } from "./message-queue.js";
import {
  registerCliPermissionHandler,
} from "./permission-handler.js";
import {
  CLI_USAGE,
  CLI_VERSION,
  parseCliOptions,
  type CliOptions,
} from "./options.js";

const CLI_NAME = "god-agent";

interface ActiveTurn {
  turnId: TurnId;
  completion: Promise<void>;
  cancelRequested: boolean;
}

async function main(options: CliOptions): Promise<void> {
  const appServerEntry = fileURLToPath(
    new URL("../app-server/main.ts", import.meta.url),
  );
  const child = spawn(
    process.execPath,
    ["--import", "tsx", appServerEntry],
    {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  const connection = new JsonRpcConnection((data) => {
    child.stdin.write(data);
  });
  const inputReader = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const inputRouter = new CliInputRouter((text) => {
    process.stdout.write(text);
  });
  const eventRenderer = new CliAgentEventRenderer(options.debug);
  const messageQueue = new CliMessageQueue();
  let activeTurn: ActiveTurn | undefined;
  let exitRequested = false;

  registerCliPermissionHandler(
    connection,
    (prompt) => inputRouter.requestPermission(prompt),
  );

  connection.onNotification("agent/event", (params) => {
    if (!isAgentEvent(params)) {
      if (options.debug) {
        process.stderr.write(
          "[client] ignored invalid agent/event\n",
        );
      }
      return;
    }

    eventRenderer.render(params);
  });

  child.stdout.on("data", (chunk: string) => {
    void connection.receive(chunk).catch((error: unknown) => {
      process.stderr.write(
        `[client] protocol error: ${readErrorMessage(error)}\n`,
      );
    });
  });
  child.stderr.on("data", (chunk: string) => {
    // 产品模式保持简洁；--debug 仍完整保留学习阶段内部日志。
    if (options.debug) {
      process.stderr.write(chunk);
    }
  });
  child.on("exit", () => {
    connection.close();
    inputRouter.close();
    inputReader.close();
  });

  try {
    const initializeResult = await connection.sendRequest(
      "initialize",
      {
        clientName: CLI_NAME,
        protocolVersion: 1,
      },
    );

    if (options.debug) {
      console.log(`[${CLI_NAME}] Initialize result:`);
      console.log(initializeResult);
    }
    connection.sendNotification("initialized");

    let currentThread = await restoreOrCreateThread(
      connection,
      options.debug,
    );
    let launchTurn: (input: string) => Promise<void>;

    launchTurn = async (input: string): Promise<void> => {
      const turnStart = await startTurn(
        connection,
        eventRenderer,
        currentThread.id,
        input,
        options.debug,
      );
      const runningTurn: ActiveTurn = {
        turnId: turnStart.turn.id,
        completion: Promise.resolve(),
        cancelRequested: false,
      };

      activeTurn = runningTurn;
      runningTurn.completion = runStartedTurn(
        connection,
        eventRenderer,
        turnStart,
      )
        .catch((error: unknown) => {
          console.error(
            `\n本轮结束：${readErrorMessage(error)}`,
          );
        })
        .finally(async () => {
          if (activeTurn === runningTurn) {
            activeTurn = undefined;
          }

          if (exitRequested) {
            return;
          }

          const nextInput = messageQueue.dequeue();

          if (nextInput !== undefined) {
            console.log(
              `\n正在发送队列中的下一条消息，` +
                `剩余 ${messageQueue.size} 条。`,
            );

            try {
              await launchTurn(nextInput);
            } catch (error) {
              console.error(
                `\n无法启动排队消息：${readErrorMessage(error)}`,
              );
              writePrompt(false);
            }
            return;
          }

          writePrompt(false);
        });

      writePrompt(true);
    };

    registerCliInterruptHandler(inputReader, {
      hasActiveTurn: () => activeTurn !== undefined,
      denyPendingPermission: () => {
        inputRouter.denyPendingPermission();
      },
      cancelActiveTurn: async () => {
        const turn = activeTurn;

        if (turn !== undefined) {
          await requestTurnCancel(connection, turn);
        }
      },
      exitIdle: () => {
        exitRequested = true;
        messageQueue.clear();
        inputReader.close();
      },
      reportError: (error) => {
        console.error(
          `\n取消失败：${readErrorMessage(error)}`,
        );
      },
    });

    printWelcome(currentThread, options.debug);
    writePrompt(false);

    // readline 是唯一 stdin 消费者；Permission 只在 Router 中等待下一行。
    for await (const line of inputReader) {
      const routed = inputRouter.consumeLine(line);

      if (routed.handled) {
        if (
          routed.cancelRequested &&
          activeTurn !== undefined
        ) {
          await requestTurnCancel(connection, activeTurn);
        }

        if (activeTurn !== undefined) {
          writePrompt(true);
        }
        continue;
      }

      const input = line.trim();
      const command = CLI_COMMAND_REGISTRY.resolve(input);

      if (activeTurn !== undefined) {
        if (command.kind === "matched" && command.action.id === "turn.cancel") {
          await requestTurnCancel(connection, activeTurn);
        } else if (command.kind === "matched" && command.action.id === "session.status") {
          printStatus(
            currentThread,
            activeTurn,
            messageQueue.size,
          );
        } else if (command.kind === "matched" && command.action.id === "app.exit") {
          exitRequested = true;
          messageQueue.clear();
          // Cancel may finish the turn immediately and clear activeTurn in the
          // completion handler. Keep the selected turn stable across the await.
          const turnToCancel = activeTurn;
          await requestTurnCancel(connection, turnToCancel);
          await turnToCancel.completion.catch(() => undefined);
          break;
        } else if (command.kind !== "not-command") {
          console.log(
            "\nTurn 运行期间可使用 " +
              CLI_COMMAND_REGISTRY.formatAvailableCommands("running") +
              "。",
          );
        } else if (input.length > 0) {
          const position = messageQueue.enqueue(input);
          console.log(
            `\n消息已进入队列，当前位置 ${position}。`,
          );
        }

        if (!exitRequested && activeTurn !== undefined) {
          writePrompt(true);
        }
        continue;
      }

      if (input.length === 0) {
        writePrompt(false);
        continue;
      }

      if (command.kind === "matched") {
        switch (command.action.id) {
          case "app.exit":
            exitRequested = true;
            messageQueue.clear();
            break;
          case "app.help":
            printHelp();
            break;
          case "session.status":
            printStatus(currentThread, undefined, messageQueue.size);
            break;
          case "chat.list": {
            const threads = await listThreads(connection);
            printThreads(threads, currentThread.id);
            break;
          }
          case "chat.new":
            currentThread = await startThread(connection);
            console.log(`\n已创建新 Thread：${currentThread.id}`);
            break;
          case "turn.cancel":
            console.log("\n当前没有正在运行的 Turn。");
            break;
          default:
            throw new Error(`Unhandled CLI Action: ${command.action.id}`);
        }

        if (exitRequested) break;
        writePrompt(false);
        continue;
      }

      if (command.kind === "unknown") {
        console.log(`\n未知命令：${command.input}；输入 /help 查看帮助。`);
        writePrompt(false);
        continue;
      }

      try {
        await launchTurn(input);
      } catch (error) {
        console.error(
          `\n无法启动 Turn：${readErrorMessage(error)}`,
        );
        writePrompt(false);
      }
    }
  } finally {
    exitRequested = true;
    messageQueue.clear();
    inputRouter.close();

    if (activeTurn !== undefined) {
      // The cancellation acknowledgement can race with completion.finally.
      const turnToCancel = activeTurn;
      await requestTurnCancel(connection, turnToCancel).catch(
        () => undefined,
      );
      await turnToCancel.completion.catch(() => undefined);
    }

    inputReader.close();
    // 先监听 exit，再关闭 stdin，避免快速退出发生在 once 注册之前。
    const childExit =
      child.exitCode === null
        ? once(child, "exit")
        : undefined;
    child.stdin.end();

    if (childExit !== undefined) {
      await childExit;
    }
  }

  console.log(`\n${CLI_NAME} 已退出。`);
}

async function restoreOrCreateThread(
  connection: JsonRpcConnection,
  debug: boolean,
): Promise<Thread> {
  const threads = await listThreads(connection);
  const resumable = threads.filter(
    (thread) => thread.status === "active",
  );
  const latest = resumable.at(-1);

  if (latest !== undefined) {
    console.log(
      debug
        ? `\n已恢复最近 Thread：${latest.id}`
        : "\n已恢复上次会话。",
    );
    return latest;
  }

  const thread = await startThread(connection);
  console.log(
    debug
      ? `\n已创建 Thread：${thread.id}`
      : "\n已创建新会话。",
  );
  return thread;
}

async function listThreads(
  connection: JsonRpcConnection,
): Promise<Thread[]> {
  const result = await connection.sendRequest("thread/list");

  if (
    !Array.isArray(result) ||
    !result.every(isThread)
  ) {
    throw new Error("Invalid thread/list response");
  }

  return result;
}

async function startThread(
  connection: JsonRpcConnection,
): Promise<Thread> {
  const result = await connection.sendRequest("thread/start");

  if (!isThread(result)) {
    throw new Error("Invalid thread/start response");
  }

  return result;
}

async function startTurn(
  connection: JsonRpcConnection,
  eventRenderer: CliAgentEventRenderer,
  threadId: string,
  input: string,
  debug: boolean,
): Promise<TurnStartResult> {
  eventRenderer.beginTurn();
  const result = await connection.sendRequest(
    "turn/start",
    { threadId, input },
  );

  if (!isTurnStartResult(result)) {
    throw new Error("Invalid turn/start response");
  }

  if (debug) {
    console.log(
      `\nTurn 已创建：${result.turn.id} (${result.turn.status})`,
    );
    console.log(`用户消息 Item：${result.userMessage.id}`);
  }

  return result;
}

async function runStartedTurn(
  connection: JsonRpcConnection,
  eventRenderer: CliAgentEventRenderer,
  turnStart: TurnStartResult,
): Promise<void> {
  const result = await connection.sendRequest(
    "turn/run",
    { turnId: turnStart.turn.id },
  );

  if (!isTurnRunResult(result)) {
    throw new Error("Invalid turn/run response");
  }

  // 非流式 Provider 没有 delta 时，使用最终 Item 作为降级展示。
  if (!eventRenderer.receivedAssistantDelta) {
    console.log(
      `\nAssistant › ${readItemText(
        result.assistantMessage.content,
      )}`,
    );
  }
}

async function requestTurnCancel(
  connection: JsonRpcConnection,
  activeTurn: ActiveTurn,
): Promise<void> {
  if (activeTurn.cancelRequested) {
    console.log("\n取消请求已发送，请等待 Runtime 清理。");
    return;
  }

  activeTurn.cancelRequested = true;

  try {
    const result = await connection.sendRequest(
      "turn/cancel",
      { turnId: activeTurn.turnId },
    );

    if (!isTurnCancelResult(result)) {
      throw new Error("Invalid turn/cancel response");
    }

    console.log(`\n已请求取消 Turn：${result.turnId}`);
  } catch (error) {
    if (
      error instanceof JsonRpcRemoteError &&
      error.code === -32603 &&
      error.message ===
        `Turn is not running: ${activeTurn.turnId}`
    ) {
      // Assistant 已输出但 completion.finally 尚未清空 activeTurn 时，
      // Runtime 可能已经完成该 Turn；此时取消天然已经达到目标。
      return;
    }

    activeTurn.cancelRequested = false;
    throw error;
  }
}

function printWelcome(thread: Thread, debug: boolean): void {
  console.log(`\n${CLI_NAME} 已启动。`);
  if (debug) {
    console.log(`当前 Thread：${thread.id}`);
  }
  console.log("输入 /help 查看命令；Ctrl+C 可取消运行中的 Turn。");
}

function printHelp(): void {
  console.log(`
${CLI_COMMAND_REGISTRY.formatHelp()}

Turn 运行期间继续输入普通消息会进入 FIFO 队列。
Tool 执行前会显示审批提示；输入 y/yes 允许，其他输入拒绝。`);
}

function printStatus(
  thread: Thread,
  activeTurn: ActiveTurn | undefined,
  queuedMessageCount: number,
): void {
  console.log(`\nThread：${thread.id} (${thread.status})`);
  console.log(
    activeTurn === undefined
      ? "Turn：idle"
      : `Turn：${activeTurn.turnId} (running)`,
  );
  console.log(`Queue：${queuedMessageCount}`);
}

function printThreads(
  threads: readonly Thread[],
  currentThreadId: string,
): void {
  if (threads.length === 0) {
    console.log("\n没有已保存的 Thread。");
    return;
  }

  console.log("\n已保存的 Thread：");

  for (const thread of threads) {
    const current =
      thread.id === currentThreadId ? " *current" : "";
    console.log(
      `- ${thread.id} [${thread.status}] ` +
        `turns=${thread.turnIds.length}${current}`,
    );
  }
}

function writePrompt(running: boolean): void {
  process.stdout.write(
    running
      ? "\nYou [running] › "
      : "\nYou › ",
  );
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

export class CliAgentEventRenderer {
  receivedAssistantDelta = false;

  private reasoningBuffer = "";
  private reasoningHeader: string | undefined;
  private readonly citations = new Map<
    string,
    { title: string; url: string }
  >();

  private openStream:
    | "reasoning"
    | "assistant"
    | undefined;

  constructor(private readonly debug: boolean) {}

  beginTurn(): void {
    this.endOpenStream();
    this.resetReasoningSummary();
    this.citations.clear();
    this.receivedAssistantDelta = false;
  }

  render(event: AgentEvent): void {
    switch (event.type) {
      case "turn/started":
        this.endOpenStream();
        this.debugLog(`[Turn] started ${event.turnId}`);
        return;

      case "model/started":
        this.endOpenStream();
        this.resetReasoningSummary();
        if (this.debug) {
          console.log(`[Model] round ${event.round + 1} started`);
        } else {
          console.log("\nThinking…");
        }
        return;

      case "context/compacted":
        this.endOpenStream();
        this.debugLog(
          `[Context] compacted ${event.beforeTokens} → ` +
            `${event.afterTokens} tokens`,
        );
        return;

      case "reasoning/summary_part_added":
        // 行式 CLI 暂不改变布局，但保留分段事件，后续全屏 TUI 可直接据此折叠展示。
        this.endOpenStream();
        this.debugLog(
          `[Reasoning summary] part ${event.summaryIndex + 1}`,
        );
        return;

      case "reasoning/summary_delta":
        if (this.debug) {
          this.writeDelta(
            "reasoning",
            "[Reasoning summary]\n",
            event.delta,
          );
        } else {
          this.reasoningBuffer += event.delta;
          const header = extractReasoningHeader(
            this.reasoningBuffer,
          );

          if (
            header !== undefined &&
            header !== this.reasoningHeader
          ) {
            this.reasoningHeader = header;
            console.log(`Thinking: ${header}`);
          }
        }
        return;

      case "reasoning/summary_completed":
        this.completeReasoningSummary();
        return;

      case "web_search/started":
        this.completeReasoningSummary();
        this.endOpenStream();
        if (this.debug) {
          console.log(`[Web Search] started ${event.callId}`);
        } else {
          console.log("\nSearch › 正在联网搜索…");
        }
        return;

      case "web_search/searching":
        this.endOpenStream();
        this.debugLog(`[Web Search] searching ${event.callId}`);
        return;

      case "web_search/completed":
        this.endOpenStream();
        if (this.debug) {
          console.log(`[Web Search] completed ${event.callId}`);
        } else {
          console.log(
            event.query === undefined
              ? "Search ✓ 已完成"
              : `Search ✓ ${event.query}`,
          );
        }
        return;

      case "citation/url_added":
        // SSE 可能重复发送同一 annotation；按 URL 去重，最后统一显示。
        if (!this.citations.has(event.url)) {
          this.citations.set(event.url, {
            title: event.title,
            url: event.url,
          });
        }
        this.debugLog(`[Citation] ${event.title} ${event.url}`);
        return;

      case "model/output_text_delta":
        // Provider 正常会先发 completed；这里是兼容不完整中转事件的兜底。
        this.completeReasoningSummary();
        this.writeDelta(
          "assistant",
          this.debug ? "[Assistant]\n" : "\nAssistant › ",
          event.delta,
        );
        return;

      case "model/output_text_completed":
        this.endOpenStream();
        if (event.classification === "assistant") {
          this.receivedAssistantDelta = true;
        }
        this.debugLog(
          `[Model output] ${event.classification} round ${event.round + 1}`,
        );
        return;

      case "model/completed":
        this.completeReasoningSummary();
        this.endOpenStream();
        if (event.functionCallCount === 0) {
          this.renderCitations();
        }
        this.debugLog(
          event.functionCallCount > 0
            ? `[Model] selected ${event.functionCallCount} tool(s)`
            : "[Model] final response completed",
        );
        return;

      case "permission/requested":
        this.endOpenStream();
        this.debugLog(`[Permission] requested ${event.toolName}`);
        return;

      case "permission/decided":
        this.endOpenStream();
        this.debugLog(
          `[Permission] ${event.decision} ${event.toolName}`,
        );
        return;

      case "tool/started":
        this.endOpenStream();
        this.debugLog(`[Tool] started ${event.toolName}`);
        return;

      case "tool/completed":
        this.endOpenStream();
        this.debugLog(`[Tool] completed ${event.toolName}`);
        return;

      case "turn/completed":
        this.endOpenStream();
        this.debugLog(`[Turn] completed ${event.turnId}`);
        return;

      case "turn/interrupted":
        this.endOpenStream();
        this.resetReasoningSummary();
        this.citations.clear();
        console.log(
          this.debug
            ? `[Turn] interrupted ${event.turnId}`
            : "\nTurn 已取消。",
        );
        return;

      case "turn/timed_out":
        this.endOpenStream();
        this.resetReasoningSummary();
        this.citations.clear();
        console.log(
          this.debug
            ? `[Turn] timed out ${event.turnId}`
            : "\nTurn 已超时。",
        );
        return;

      case "turn/failed":
        this.endOpenStream();
        this.resetReasoningSummary();
        this.citations.clear();
        if (this.debug) {
          console.log(
            `[Turn] failed ${event.turnId}: ${event.message}`,
          );
        }
    }
  }

  private writeDelta(
    stream: "reasoning" | "assistant",
    heading: string,
    delta: string,
  ): void {
    if (this.openStream !== stream) {
      this.endOpenStream();
      process.stdout.write(heading);
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

  private completeReasoningSummary(): void {
    if (this.debug) {
      this.endOpenStream();
      this.resetReasoningSummary();
      return;
    }

    const summary = formatReasoningSummary(
      this.reasoningBuffer,
    );
    this.resetReasoningSummary();

    if (summary !== undefined) {
      console.log(summary);
    }
  }

  private resetReasoningSummary(): void {
    this.reasoningBuffer = "";
    this.reasoningHeader = undefined;
  }

  private renderCitations(): void {
    if (this.debug || this.citations.size === 0) {
      this.citations.clear();
      return;
    }

    console.log("Sources:");
    for (const citation of this.citations.values()) {
      const title = citation.title.trim();
      console.log(
        title.length === 0
          ? `• ${citation.url}`
          : `• ${title} — ${citation.url}`,
      );
    }
    this.citations.clear();
  }

  private debugLog(message: string): void {
    if (this.debug) {
      console.log(message);
    }
  }
}

export function extractReasoningHeader(
  value: string,
): string | undefined {
  const match = /\*\*([^*\n]+)\*\*/.exec(value);
  const header = match?.[1]?.trim();

  return header === undefined || header.length === 0
    ? undefined
    : header;
}

export function formatReasoningSummary(
  value: string,
): string | undefined {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return undefined;
  }

  const headerMatch = /\*\*([^*\n]+)\*\*/.exec(trimmed);
  const header = headerMatch?.[1]?.trim();
  const body = headerMatch === null
    ? trimmed
    : trimmed
        .slice(headerMatch.index + headerMatch[0].length)
        .trim() || header;

  if (body === undefined || body.length === 0) {
    return undefined;
  }

  // 与 Codex 的 ReasoningSummaryCell 一样，正文首行使用圆点，续行缩进。
  return body
    .split("\n")
    .map((line, index) =>
      index === 0 ? `• ${line}` : `  ${line}`,
    )
    .join("\n");
}

async function runCliEntry(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));

  if (options.help) {
    console.log(CLI_USAGE);
    return;
  }

  if (options.version) {
    console.log(`${CLI_NAME} ${CLI_VERSION}`);
    return;
  }

  await main(options);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void runCliEntry().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
