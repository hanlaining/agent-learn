import { homedir } from "node:os";
import { join } from "node:path";

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
  JsonRpcPermissionGate,
} from "../permissions/json-rpc-permission-gate.js";
import {
  JsonFileRuntimePersistence,
} from "../runtime/json-file-runtime-persistence.js";
import {
  WorkspaceSandbox,
} from "../sandbox/workspace-sandbox.js";
import {
  WorkspaceCommandRunner,
} from "../sandbox/workspace-command-runner.js";
import {
  financeMonthlySummaryAgentTool,
} from "../tools/finance-monthly-summary-tool.js";
import {
  ToolRegistry,
} from "../tools/tool-registry.js";
import {
  createRunCommandTool,
} from "../tools/run-command-tool.js";
import {
  createWorkspaceTools,
} from "../tools/workspace-tools.js";
import {
  registerAppServerHandlers,
} from "./handlers.js";

const connection = new JsonRpcConnection((data) => {
  // stdout 只能输出 JSONL 协议消息
  process.stdout.write(data);
});

const apiKey = process.env.OPENAI_API_KEY;

// 默认状态进入用户数据目录，不在项目仓库产生运行时文件。
const defaultStateRoot =
  process.env.LOCALAPPDATA ??
  join(homedir(), ".local", "share");
const runtimePersistence = new JsonFileRuntimePersistence(
  process.env.AGENT_STATE_PATH ??
    join(defaultStateRoot, "god-agent", "runtime-state.json"),
);
const loadedRuntimeState = await runtimePersistence.load();
const {
  lifecycleStore,
  contextCheckpointStore,
} = loadedRuntimeState;

const defaultModel = "gpt-5.4-mini";
const defaultBaseUrl = "https://llmapi.lovbrowser.com";

const configuredBaseUrl = (
  process.env.OPENAI_BASE_URL ?? defaultBaseUrl
).replace(/\/+$/, "");

// 用户填写站点根地址即可；这里统一补成 OpenAI 兼容的 /v1 地址。
const apiBaseUrl = configuredBaseUrl.endsWith("/v1")
  ? configuredBaseUrl
  : `${configuredBaseUrl}/v1`;

const workspacePath =
  process.env.AGENT_WORKSPACE ?? process.cwd();
const workspaceTools = [];

if (apiKey !== undefined) {
  const workspaceSandbox = await WorkspaceSandbox.create(
    workspacePath,
  );
  const npmExecutable =
    process.platform === "win32" ? "npm.cmd" : "npm";
  const commandRunner = await WorkspaceCommandRunner.create(
    workspacePath,
    {
      recipes: {
        check: {
          executable: npmExecutable,
          arguments: ["run", "check"],
          display: "npm run check",
        },
        test: {
          executable: npmExecutable,
          arguments: ["test"],
          display: "npm test",
        },
      },
    },
  );

  workspaceTools.push(
    ...createWorkspaceTools(workspaceSandbox),
    createRunCommandTool(commandRunner),
  );
}

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
        // Tool 真正执行前，通过同一条双向 JSON-RPC 连接向 CLI 请求审批。
        permissionGate: new JsonRpcPermissionGate(connection),
        contextCheckpointStore,
        toolRegistry: new ToolRegistry([
          financeMonthlySummaryAgentTool,
          ...workspaceTools,
        ]),
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
  saveState: () => runtimePersistence.save(
    lifecycleStore,
    contextCheckpointStore,
  ),
  // 日志写 stderr，避免污染 stdout 上的 JSONL 协议数据。
  log: (message) => process.stderr.write(message),
});

if (loadedRuntimeState.restored) {
  process.stderr.write(
    "[app-server] runtime state restored\n",
  );
}

if (loadedRuntimeState.recoveredTurnIds.length > 0) {
  process.stderr.write(
    `[app-server] recovered ${loadedRuntimeState.recoveredTurnIds.length} ` +
      "interrupted turn(s)\n",
  );
}

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
