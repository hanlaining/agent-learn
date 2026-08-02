import { JsonRpcConnection } from "../protocol/connection.js";
import {
  AgentLoop,
} from "../agent/agent-loop.js";
import type {
  AgentEventSink,
} from "../agent/events.js";
import {
  OpenAiResponsesProvider,
} from "../llm/openai-responses.js";
import {
  LifecycleStore,
} from "../runtime/lifecycle-store.js";
import {
  registerAppServerHandlers,
} from "./handlers.js";

const connection = new JsonRpcConnection((data) => {
  // stdout 只能输出 JSONL 协议消息
  process.stdout.write(data);
});

// main.ts 是组合入口：在这里创建真实依赖，再注入处理器层。
const lifecycleStore = new LifecycleStore();
const apiKey = process.env.OPENAI_API_KEY;

const defaultModel = "gpt-5.4-mini";
const defaultBaseUrl = "https://llmapi.lovbrowser.com";

const configuredBaseUrl = (
  process.env.OPENAI_BASE_URL ?? defaultBaseUrl
).replace(/\/+$/, "");

// 用户填写站点根地址即可；这里统一补成 OpenAI 兼容的 /v1 地址。
const apiBaseUrl = configuredBaseUrl.endsWith("/v1")
  ? configuredBaseUrl
  : `${configuredBaseUrl}/v1`;

// Runtime 事件通过反向 JSON-RPC Notification 实时推给 Client。
const events: AgentEventSink = {
  emit: (event) => {
    connection.sendNotification("agent/event", event);
  },
};

// 没有 Key 时协议和 Runtime 仍可启动，只有 turn/run 会明确报错。
const agentLoop =
  apiKey === undefined
    ? undefined
    : new AgentLoop({
        lifecycleStore,
        events,
        llm: new OpenAiResponsesProvider({
          apiKey,
          model: process.env.OPENAI_MODEL ?? defaultModel,
          baseUrl: apiBaseUrl,
          // LovBrowser 中转不保存 previous_response_id，使用显式回放。
          usePreviousResponseId: false,
        }),
      });

registerAppServerHandlers(connection, {
  lifecycleStore,
  events,
  ...(agentLoop === undefined ? {} : { agentLoop }),
  // 日志写 stderr，避免污染 stdout 上的 JSONL 协议数据。
  log: (message) => process.stderr.write(message),
});

if (agentLoop === undefined) {
  process.stderr.write(
    "[app-server] OPENAI_API_KEY missing; turn/run disabled\n",
  );
}

process.stdin.setEncoding("utf8");

process.stdin.on("data", (chunk: string) => {
  void connection.receive(chunk).catch((error: unknown) => {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    process.stderr.write(
      `[app-server] protocol error: ${message}\n`,
    );
  });
});

process.stdin.on("end", () => {
  connection.close();

  process.stderr.write(
    "[app-server] connection closed\n",
  );
});

process.stderr.write("[app-server] ready\n");
