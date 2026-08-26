import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import type { AgentEvent } from "../src/agent/events.js";
import {
  cloneRuntimeCapabilities,
  isRuntimeCapabilities,
  type RuntimeCapabilities,
} from "../src/app-server/runtime-capabilities.js";
import {
  DesktopController,
  type DesktopRuntimeClient,
} from "../src/electron/desktop-controller.js";
import {
  createSafeRuntimeFailure,
} from "../src/electron/runtime-status.js";
import {
  parseMcpDiscovery,
  parseLegacyMcpInitializeResult,
  parseMcpToolCallResult,
  parseMcpToolListPage,
} from "../src/mcp/mcp-protocol.js";
import {
  ALLOW_ALL_PERMISSION_GATE,
} from "../src/permissions/permission-gate.js";
import {
  parseToolPermissionDecision,
  parseToolPermissionPrompt,
} from "../src/permissions/json-rpc-permission-gate.js";
import {
  assertRuntimeCorrelation,
  createRuntimeCorrelation,
  deriveLegacyUnattributedCorrelationId,
} from "../src/runtime/runtime-correlation.js";
import { CommandRegistry } from "../src/shortcuts/command-registry.js";
import type { ActionDefinition } from "../src/shortcuts/action-types.js";
import {
  createProcessChaosLocalEffectTool,
  effectToolExecution,
  requireLoopbackHelperUrl,
  type ProcessChaosEffectRecord,
} from "../src/tools/process-chaos-local-effect-tool.js";

const NOW = "2026-08-24T00:00:00.000Z";

test("Runtime capabilities 校验所有能力族并深拷贝可选字段", () => {
  const capabilities: RuntimeCapabilities = {
    llm: true,
    currentModel: "model-a",
    models: [{ id: "model-a", label: "Model A", reasoningEfforts: ["low", "high"] }],
    webSearch: true,
    tools: [{ name: "read_file", description: "读取文件", source: "workspace" }],
    skills: [{ name: "review", description: "审查" }],
    mcpServers: [{ name: "local", protocolVersion: "2026-07-28", toolCount: 2 }],
    agents: [{ id: "reviewer", name: "Reviewer", description: "独立复核" }],
    multiAgent: { maxConcurrentRuns: 2, maxDepth: 3, maxChildrenPerRun: 4 },
  };
  assert.equal(isRuntimeCapabilities(capabilities), true);

  const cloned = cloneRuntimeCapabilities(capabilities);
  assert.deepEqual(cloned, capabilities);
  cloned.models[0]!.reasoningEfforts!.push("medium");
  cloned.tools[0]!.description = "changed";
  cloned.agents![0]!.name = "Changed";
  cloned.multiAgent!.maxDepth = 99;
  assert.deepEqual(capabilities.models[0]!.reasoningEfforts, ["low", "high"]);
  assert.equal(capabilities.tools[0]!.description, "读取文件");
  assert.equal(capabilities.agents![0]!.name, "Reviewer");
  assert.equal(capabilities.multiAgent!.maxDepth, 3);

  const invalidValues: unknown[] = [
    null,
    [],
    { ...capabilities, llm: "true" },
    { ...capabilities, currentModel: " " },
    { ...capabilities, models: [{ id: "", label: "Model A" }] },
    { ...capabilities, models: [{ id: "model-a", label: "Model A", reasoningEfforts: [" "] }] },
    { ...capabilities, tools: [{ name: "read_file", description: "x", source: "unknown" }] },
    { ...capabilities, skills: [{ name: " ", description: "x" }] },
    { ...capabilities, mcpServers: [{ name: "local", protocolVersion: "", toolCount: 0 }] },
    { ...capabilities, mcpServers: [{ name: "local", protocolVersion: "2026-07-28", toolCount: -1 }] },
    { ...capabilities, agents: ["reviewer"] },
    { ...capabilities, multiAgent: { maxConcurrentRuns: 1 } },
  ];
  for (const value of invalidValues) assert.equal(isRuntimeCapabilities(value), false);
});

test("权限边界默认 Gate 明确放行，并拒绝所有畸形 RPC 决策与提示", async () => {
  assert.deepEqual(await ALLOW_ALL_PERMISSION_GATE.request({
    turnId: "turn-1",
    callId: "call-1",
    toolName: "read_file",
    arguments: "{}",
  }), { decision: "allow" });

  for (const value of [null, [], "allow", 1, { decision: "allow", scope: "forever" }]) {
    assert.throws(
      () => parseToolPermissionDecision(value),
      /Invalid tool permission response/,
    );
  }

  assert.deepEqual(parseToolPermissionPrompt({
    turnId: "turn-1",
    threadId: "thread-1",
    jobId: "job-1",
    agentId: "agent-1",
    agentName: "Reviewer",
    taskId: "task-1",
    taskTitle: "安全审查",
    callId: "call-1",
    toolName: "write_file",
    description: "写入审计报告",
    riskLevel: "sensitive",
  }), {
    turnId: "turn-1",
    threadId: "thread-1",
    jobId: "job-1",
    agentId: "agent-1",
    agentName: "Reviewer",
    taskId: "task-1",
    taskTitle: "安全审查",
    callId: "call-1",
    toolName: "write_file",
    description: "写入审计报告",
    riskLevel: "sensitive",
  });

  for (const value of [
    null,
    [],
    { turnId: " ", callId: "call-1", toolName: "read_file" },
    { turnId: "turn-1", callId: " ", toolName: "read_file" },
    { turnId: "turn-1", callId: "call-1", toolName: " " },
    { turnId: "turn-1", callId: "call-1", toolName: "read_file", description: " " },
    { turnId: "turn-1", callId: "call-1", toolName: "read_file", riskLevel: "admin" },
  ]) {
    assert.throws(
      () => parseToolPermissionPrompt(value),
      /Invalid tool permission request/,
    );
  }
});

test("MCP IPC 解析器保留合法扩展副本，并对畸形能力、分页和内容块 fail closed", () => {
  const capabilities = { tools: {}, prompts: { listChanged: true } };
  assert.deepEqual(parseMcpDiscovery({
    supportedVersions: ["2026-07-28"],
    capabilities,
    instructions: "只读服务",
  }), {
    supportedVersions: ["2026-07-28"],
    capabilities,
    instructions: "只读服务",
  });
  assert.deepEqual(parseLegacyMcpInitializeResult({
    protocolVersion: "2025-11-25",
    capabilities,
    serverInfo: { name: "local-mcp", version: "1.0.0" },
    instructions: "legacy",
  }), {
    supportedVersions: ["2025-11-25"],
    capabilities,
    instructions: "legacy",
  });

  for (const value of [
    null,
    { supportedVersions: [], capabilities: {} },
    { supportedVersions: [""], capabilities: {} },
    { supportedVersions: ["2026-07-28"], capabilities: { tools: [] } },
    { supportedVersions: ["2026-07-28"], capabilities: {}, instructions: 1 },
  ]) assert.throws(() => parseMcpDiscovery(value), /Invalid MCP/);

  for (const value of [
    null,
    { protocolVersion: "", capabilities: {}, serverInfo: { name: "mcp", version: "1" } },
    { protocolVersion: "1", capabilities: {}, serverInfo: { name: "", version: "1" } },
    { protocolVersion: "1", capabilities: { tools: [] }, serverInfo: { name: "mcp", version: "1" } },
  ]) assert.throws(() => parseLegacyMcpInitializeResult(value), /Invalid MCP/);

  const tool = {
    name: "read_file",
    title: "Read",
    description: "Read a workspace file",
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
    _meta: { source: "workspace" },
  };
  const page = parseMcpToolListPage({ tools: [tool], nextCursor: "next" });
  assert.deepEqual(page, { tools: [tool], nextCursor: "next" });
  assert.notEqual(page.tools[0], tool);
  for (const value of [
    null,
    { tools: "bad" },
    { tools: [], nextCursor: 1 },
    { tools: [tool, { ...tool }] },
    { tools: [{ ...tool, inputSchema: { type: "array" } }] },
  ]) assert.throws(() => parseMcpToolListPage(value), /Invalid MCP|Duplicate MCP/);

  assert.deepEqual(parseMcpToolCallResult({
    content: [{ type: "text", text: "safe" }],
    structuredContent: { answer: 42 },
    isError: false,
  }), {
    content: [{ type: "text", text: "safe" }],
    structuredContent: { answer: 42 },
    isError: false,
  });
  for (const value of [
    null,
    { content: "bad" },
    { content: [], structuredContent: [] },
    { content: [], isError: "false" },
    { content: [null] },
    { content: [{ type: " " }] },
  ]) assert.throws(() => parseMcpToolCallResult(value), /Invalid MCP/);
});

test("命令注册表拒绝冲突或不完整的桌面与 CLI 动作元数据", () => {
  const base = action();
  assert.deepEqual(new CommandRegistry([base]).resolve(" /safe "), {
    kind: "matched",
    action: base,
  });

  const invalid: ActionDefinition[] = [
    action({ id: "invalid" }),
    action({ slashCommand: "safe" as `/${string}` }),
    action({ label: " " }),
    action({ description: " " }),
    action({ surfaces: [] }),
    action({ surfaces: ["cli", "cli"] }),
    action({ slashCommand: undefined } as unknown as Partial<ActionDefinition>),
    action({ cliAvailability: undefined } as unknown as Partial<ActionDefinition>),
    action({ cliAvailability: [] }),
    action({ cliAvailability: ["idle", "idle"] }),
  ];
  for (const definition of invalid) {
    assert.throws(() => new CommandRegistry([definition]), /Invalid|missing|Duplicate|incomplete/);
  }
  assert.throws(
    () => new CommandRegistry([base, action()]),
    /Duplicate Action id/,
  );
  assert.throws(
    () => new CommandRegistry([base, action({ id: "other.action" })]),
    /Duplicate slash command/,
  );
});

test("Runtime 关联身份拒绝不完整、伪造和非规范的权限归属链", () => {
  const valid = createRuntimeCorrelation({ threadId: "thread-1", turnId: "turn-1" });
  assert.doesNotThrow(() => assertRuntimeCorrelation(valid));
  const invalidCorrelations = [
    null,
    { ...valid, schemaVersion: 2 },
    { ...valid, requirementRevision: 1 },
    { ...valid, jobId: "job-1" },
    { ...valid, jobAttempt: 1 },
    { ...valid, taskId: "task-1" },
    { ...valid, runId: "run-1" },
    { ...valid, turnId: undefined, modelInvocationId: "model-1" },
    { ...valid, toolInvocationId: "tool-1" },
    { ...valid, workflowId: "workflow-1" },
    { ...valid, leaseResourceType: "database", leaseResourceId: "job-1" },
    { ...valid, leaseResourceType: "turn", leaseResourceId: "turn-other" },
    { ...valid, correlationId: "turn:forged" },
  ];
  invalidCorrelations.forEach((value, index) => assert.throws(
    () => assertRuntimeCorrelation(value),
    /Invalid|requires|does not match|incomplete/,
    `invalid correlation case ${index}`,
  ));

  assert.throws(
    () => createRuntimeCorrelation({
      threadId: "thread-1",
      attribution: "legacy_unattributed",
    }),
    /requires an explicit stable correlationId/,
  );
  for (const correlationId of [
    "legacy:missing",
    "legacy:%E0%A4%A:value",
    "legacy:job:%2f",
  ]) {
    assert.throws(() => assertRuntimeCorrelation({
      schemaVersion: 1,
      threadId: "thread-1",
      attribution: "legacy_unattributed",
      correlationId,
    }), /canonical encoding/);
  }
  const canonical = deriveLegacyUnattributedCorrelationId("job", "job-1");
  assert.doesNotThrow(() => assertRuntimeCorrelation({
    schemaVersion: 1,
    threadId: "thread-1",
    attribution: "legacy_unattributed",
    correlationId: canonical,
  }));
});

test("Process Chaos 本地效果工具只接受环回 URL、绝对目录和严格参数", async () => {
  assert.equal(requireLoopbackHelperUrl("http://127.0.0.1:43123/"), "http://127.0.0.1:43123");
  for (const url of [
    "not-a-url",
    "https://127.0.0.1:43123",
    "http://localhost:43123",
    "http://user@127.0.0.1:43123",
    "http://127.0.0.1:43123/path",
    "http://127.0.0.1:43123/?secret=1",
    "http://127.0.0.1:43123/#fragment",
    "http://127.0.0.1",
    "http://127.0.0.1:0",
  ]) assert.throws(() => requireLoopbackHelperUrl(url), /loopback|valid port/);

  assert.throws(() => createProcessChaosLocalEffectTool({
    helperBaseUrl: "http://127.0.0.1:43123",
    experimentDirectory: "relative/path",
  }), /must be absolute/);
  const tool = createProcessChaosLocalEffectTool({
    helperBaseUrl: "http://127.0.0.1:43123",
    experimentDirectory: resolve(".tmp", "process-chaos-contract-only"),
  });
  assert.equal(tool.definition.name, "process_chaos_local_effect");
  assert.equal(tool.requiresPermission, false);
  assert.equal(tool.riskLevel, "sensitive");

  const signal = new AbortController().signal;
  for (const argumentsJson of [
    "{bad-json",
    "null",
    JSON.stringify({ action: "create_effect", operationId: "op-1" }),
    JSON.stringify({ action: "delete_effect", operationId: "op-1", payload: "x" }),
    JSON.stringify({ action: "create_effect", operationId: "bad/id", payload: "x" }),
    JSON.stringify({ action: "create_effect", operationId: "op-1", payload: "" }),
  ]) await assert.rejects(async () => tool.execute(argumentsJson, { signal }), /arguments/);

  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    async () => tool.execute(JSON.stringify({ action: "create_effect", operationId: "op-1", payload: "x" }), { signal: aborted.signal }),
    (error: unknown) => error !== undefined,
  );

  const record = processChaosRecord();
  const execution = effectToolExecution("proof_verified", record);
  assert.deepEqual(execution.result, {
    action: "proof_verified",
    operationId: "op-1",
    effectId: record.effectId,
    effectDigest: record.effectDigest,
    receipt: record.receipt,
    proof: record.proof,
    effectApplyCount: 1,
  });
  assert.equal(execution.modelOutput, execution.result);
});

test("DesktopController 把 Runtime 失败与损坏消息统一收敛为安全事件", async () => {
  const failed = new SecurityDesktopRuntime("failed-event");
  const controller = new DesktopController(failed);
  await controller.getSnapshot();
  const events: AgentSafeEvent[] = [];
  controller.onEvent((event) => events.push(event));
  await assert.rejects(() => controller.sendMessage("检查权限边界"), /Agent 执行失败，请重试/);
  const lastSession = events.filter((event) => event.type === "runtime/session").at(-1);
  assert.equal(lastSession?.type === "runtime/session" ? lastSession.session.status : undefined, "failed");
  assert.ok(lastSession?.type === "runtime/session" && lastSession.session.items.some(
    (item) => item.kind === "error" && item.safeMessage === "Agent 执行失败，请重试",
  ));
  assert.equal(JSON.stringify(events).includes("private provider stack"), false);

  const corrupt = new SecurityDesktopRuntime("corrupt-assistant");
  const corruptController = new DesktopController(corrupt);
  await corruptController.getSnapshot();
  await assert.rejects(() => corruptController.sendMessage("验证响应"), /Agent 执行失败，请重试/);
  assert.equal(await new DesktopController(new SecurityDesktopRuntime("success")).cancelTurn(), false);

  await assert.rejects(
    () => controller.sendMessage("x".repeat(32_001)),
    /消息过长/,
  );
  await assert.rejects(
    () => controller.sendMessage({ text: "x", mentions: [{ kind: "file", path: "" }] }),
    /Invalid workspace file mention/,
  );

  assert.deepEqual([
    createSafeRuntimeFailure("start_failed"),
    createSafeRuntimeFailure("handshake_failed"),
    createSafeRuntimeFailure("unexpected_exit"),
  ].map((status) => status.state === "failed" ? status.message : ""), [
    "Runtime 启动失败，请关闭后重试",
    "Runtime 连接失败，请关闭后重试",
    "Runtime 意外关闭，请关闭后重试",
  ]);
});

function action(overrides: Partial<ActionDefinition> = {}): ActionDefinition {
  return {
    id: "safe.action",
    label: "Safe action",
    description: "Execute a safe local action",
    category: "chat",
    risk: "local-ui",
    userBindable: true,
    surfaces: ["cli"],
    slashCommand: "/safe",
    cliAvailability: ["idle"],
    ...overrides,
  };
}

function processChaosRecord(): ProcessChaosEffectRecord {
  return {
    operationId: "op-1",
    payload: "payload",
    effectId: "effect-id",
    effectDigest: `sha256:${"a".repeat(64)}`,
    receipt: {
      receiptId: "receipt-1",
      receiptDigest: `sha256:${"b".repeat(64)}`,
      receiptMac: `hmac-sha256:${"c".repeat(64)}`,
    },
    proof: {
      proofId: "proof-1",
      proofDigest: `sha256:${"d".repeat(64)}`,
      proofMac: `hmac-sha256:${"e".repeat(64)}`,
    },
    effectApplyCount: 1,
  };
}

type AgentSafeEvent = Parameters<Parameters<DesktopController["onEvent"]>[0]>[0];

class SecurityDesktopRuntime implements DesktopRuntimeClient {
  private listener: ((event: AgentEvent) => void) | undefined;

  constructor(private readonly mode: "failed-event" | "corrupt-assistant" | "success") {}

  async listThreads() {
    return [{ id: "thread-1", status: "active" as const, createdAt: NOW, turnIds: [] }];
  }
  async startThread() { return (await this.listThreads())[0]!; }
  async readThreadHistory() { return { thread: (await this.listThreads())[0]!, messages: [] }; }
  async getCapabilities(): Promise<RuntimeCapabilities> {
    return {
      llm: true,
      currentModel: "model-safe",
      models: [{ id: "model-safe", label: "Safe", reasoningEfforts: ["high"] }],
      webSearch: false,
      tools: [],
      skills: [],
      mcpServers: [],
    };
  }
  async selectModel() { return this.getCapabilities(); }
  async startTurn(threadId: string, input: string) {
    return {
      turn: { id: "turn-1", threadId, status: "in_progress" as const, createdAt: NOW, itemIds: ["user-1"] },
      userMessage: { id: "user-1", threadId, turnId: "turn-1", type: "user_message" as const, content: { text: input }, createdAt: NOW },
    };
  }
  async runTurn(turnId: string) {
    this.listener?.({ type: "reasoning/summary_part_added", turnId, round: 0, summaryIndex: 0 });
    this.listener?.({ type: "reasoning/summary_delta", turnId, round: 0, summaryIndex: 0, delta: "公开摘要" });
    if (this.mode === "failed-event") {
      this.listener?.({ type: "turn/failed", turnId, message: "private provider stack" });
      throw new Error("private provider stack");
    }
    this.listener?.({ type: "turn/completed", turnId });
    return {
      turn: { id: turnId, threadId: "thread-1", status: "completed" as const, createdAt: NOW, completedAt: NOW, itemIds: ["assistant-1"] },
      assistantMessage: {
        id: "assistant-1",
        threadId: "thread-1",
        turnId,
        type: "assistant_message" as const,
        content: this.mode === "corrupt-assistant" ? {} : { text: "safe result" },
        createdAt: NOW,
      },
    };
  }
  async listAgentRuns() { return []; }
  async getThreadConfig() { return undefined; }
  async setThreadConfig() {}
  async listRuntimeSessions() { return []; }
  async setRuntimeSession() {}
  async cancelTurn(turnId: string) { return { turnId, cancelled: true as const }; }
  onAgentEvent(listener: (event: AgentEvent) => void) { this.listener = listener; return () => { this.listener = undefined; }; }
  async close() {}
}
