import {
  sampleTransactions,
} from "../domains/finance/fixtures.js";
import {
  parseMonthlySummaryRequest,
  summarizeMonthlyTransactions,
} from "../domains/finance/summary.js";
import type {
  JsonRpcConnection,
} from "../protocol/connection.js";
import type {
  LifecycleStore,
} from "../runtime/lifecycle-store.js";
import {
  parseTurnStartParams,
  type TurnStartResult,
} from "../runtime/turn-start.js";
import {
  parseTurnRunParams,
} from "../runtime/turn-run.js";
import type {
  AgentLoop,
} from "../agent/agent-loop.js";
import {
  NOOP_AGENT_EVENT_SINK,
  type AgentEventSink,
} from "../agent/events.js";

export interface AppServerDependencies {
  lifecycleStore: LifecycleStore;
  agentLoop?: AgentLoop;
  events?: AgentEventSink;
  log?: (message: string) => void;
}

/**
 * 把业务处理器注册到 Connection。
 *
 * Connection 只理解 JSON-RPC；LifecycleStore 只管理运行时状态。
 * 这个函数位于两者中间，负责把 RPC method 翻译成具体业务动作。
 */
export function registerAppServerHandlers(
  connection: JsonRpcConnection,
  dependencies: AppServerDependencies,
): void {
  const {
    lifecycleStore,
    agentLoop,
    events = NOOP_AGENT_EVENT_SINK,
    log = () => undefined,
  } = dependencies;

  let clientInitialized = false;

  function requireInitialized(): void {
    if (!clientInitialized) {
      throw new Error(
        "Client must complete initialize handshake first",
      );
    }
  }

  connection.onRequest("initialize", (params) => {
    log(`[app-server] initialize: ${JSON.stringify(params)}\n`);

    return {
      serverName: "agent-app-server",
      protocolVersion: 1,
      capabilities: {
        bidirectionalRequests: true,
        notifications: true,
        threads: true,
        turns: true,
        llm: agentLoop !== undefined,
      },
    };
  });

  connection.onNotification("initialized", () => {
    // Client 明确确认握手完成后，才开放 Runtime 和业务方法。
    clientInitialized = true;
    log("[app-server] client initialized\n");
  });

  connection.onRequest("thread/start", () => {
    requireInitialized();

    // Thread 是持久会话容器；这里只创建容器，还没有启动 Turn。
    const thread = lifecycleStore.createThread();

    log(`[app-server] thread started: ${thread.id}\n`);
    return thread;
  });

  connection.onRequest("turn/start", (params) => {
    requireInitialized();

    // 第一道边界：验证来自 JSON-RPC 的不可信参数。
    const request = parseTurnStartParams(params);

    // 第二道边界：Store 验证 Thread 存在且仍然 active。
    const turn = lifecycleStore.createTurn(
      request.threadId,
    );

    // 用户输入是这个 Turn 产生的第一个 Item。
    const userMessage = lifecycleStore.appendItem(
      turn.id,
      "user_message",
      {
        text: request.input,
      },
    );

    const result: TurnStartResult = {
      turn,
      userMessage,
    };

    events.emit({
      type: "turn/started",
      threadId: turn.threadId,
      turnId: turn.id,
    });

    log(
      `[app-server] turn started: ${turn.id} ` +
        `for thread: ${turn.threadId}\n`,
    );

    return result;
  });

  connection.onRequest("turn/run", async (params) => {
    requireInitialized();

    if (agentLoop === undefined) {
      throw new Error(
        "LLM is unavailable: set OPENAI_API_KEY",
      );
    }

    const request = parseTurnRunParams(params);
    const result = await agentLoop.run(request.turnId);

    log(
      `[app-server] turn completed: ${result.turn.id}\n`,
    );

    return result;
  });

  connection.onRequest(
    "finance/monthly-summary",
    (params) => {
      requireInitialized();

      // RPC params 属于不可信边界，先校验再进入金融计算。
      const request = parseMonthlySummaryRequest(params);

      // 金额由确定性代码汇总，未来的 LLM 只能解释这个结果。
      const summary = summarizeMonthlyTransactions(
        sampleTransactions,
        request,
      );

      log(
        `[app-server] finance summary ready: ${request.period}\n`,
      );

      return summary;
    },
  );
}
