import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentEvent,
} from "../src/agent/events.js";
import type {
  RuntimeCapabilities,
} from "../src/app-server/runtime-capabilities.js";
import {
  DesktopController,
  type DesktopRuntimeClient,
} from "../src/electron/desktop-controller.js";
import type {
  Item,
  Thread,
  Turn,
} from "../src/runtime/lifecycle.js";
import {
  InputItemBudgetExceededError,
} from "../src/runtime/item-budget.js";

test("DesktopController 恢复历史并生成确定性任务标题", async () => {
  const runtime = new FakeDesktopRuntime();
  const controller = new DesktopController(runtime);

  const snapshot = await controller.getSnapshot();

  assert.equal(snapshot.threads.length, 1);
  assert.equal(snapshot.threads[0]?.title, "实现 Codex 风格 Electron 客户端");
  assert.equal(snapshot.activeThreadId, "thread-1");
  assert.equal(snapshot.messages.length, 2);
  assert.equal(snapshot.capabilities.tools.length, 1);
  assert.equal(snapshot.capabilities.skills.length, 1);
});

test("点击新建任务只进入草稿，第一条消息发送时才创建 Thread", async () => {
  const runtime = new FakeDesktopRuntime();
  const controller = new DesktopController(runtime);
  await controller.getSnapshot();

  const draft = await controller.createThread();
  assert.equal(draft.activeThreadId, undefined);
  assert.deepEqual(draft.messages, []);
  assert.equal(runtime.startThreadCount, 0);

  await controller.sendMessage("草稿的第一条消息");
  assert.equal(runtime.startThreadCount, 1);
});

test("DesktopController 空闲时切换模型并刷新快照", async () => {
  const runtime = new FakeDesktopRuntime();
  const controller = new DesktopController(runtime);
  await controller.getSnapshot();

  const snapshot = await controller.selectModel("gpt-5.6-terra");

  assert.equal(snapshot.agentConfig.model, "gpt-5.6-terra");
});

test("DesktopController atomically persists model settings", async () => {
  const runtime = new FakeDesktopRuntime();
  const controller = new DesktopController(runtime);
  await controller.getSnapshot();

  const snapshot = await controller.selectModelSettings({
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
  });

  assert.equal(snapshot.agentConfig.model, "gpt-5.6-terra");
  assert.equal(snapshot.agentConfig.reasoningEffort, "medium");
  assert.equal(runtime.savedConfigs.length, 1);
  assert.equal(runtime.savedConfigs[0]?.model, "gpt-5.6-terra");
  assert.equal(runtime.savedConfigs[0]?.reasoningEffort, "medium");
});

test("DesktopController rejects unsupported atomic model settings", async () => {
  const runtime = new FakeDesktopRuntime();
  const controller = new DesktopController(runtime);
  await controller.getSnapshot();

  await assert.rejects(
    controller.selectModelSettings({ model: "missing", reasoningEffort: "high" }),
    /Unsupported model/,
  );
  await assert.rejects(
    controller.selectModelSettings({ model: "gpt-5.6-sol", reasoningEffort: "ultra" }),
    /Unsupported reasoning effort/,
  );
  assert.equal(runtime.savedConfigs.length, 0);
});

test("DesktopController keeps atomic model settings in a new Chat draft", async () => {
  const runtime = new FakeDesktopRuntime();
  const controller = new DesktopController(runtime);
  await controller.getSnapshot();
  await controller.createThread();

  const snapshot = await controller.selectModelSettings({
    model: "gpt-5.6-terra",
    reasoningEffort: "low",
  });

  assert.equal(snapshot.activeThreadId, undefined);
  assert.equal(snapshot.agentConfig.model, "gpt-5.6-terra");
  assert.equal(snapshot.agentConfig.reasoningEffort, "low");
  assert.equal(runtime.startThreadCount, 0);
  assert.equal(runtime.savedConfigs.length, 0);
});

test("DesktopController 运行中仍可切换模型", async () => {
  const runtime = new DeferredDesktopRuntime();
  const controller = new DesktopController(runtime);
  await controller.getSnapshot();

  const turnPromise = controller.sendMessage("保持运行");
  await runtime.started;
  const snapshot = await controller.selectModel("gpt-5.6-terra");
  assert.equal(snapshot.agentConfig.model, "gpt-5.6-terra");
  runtime.finish();
  await turnPromise;
});

test("运行时仍可进入新任务草稿并切回原 Chat", async () => {
  const runtime = new DeferredDesktopRuntime();
  const controller = new DesktopController(runtime);
  await controller.getSnapshot();

  const turnPromise = controller.sendMessage("Chat A 保持运行");
  await runtime.started;
  const draft = await controller.createThread();
  assert.equal(draft.activeThreadId, undefined);
  const restored = await controller.selectThread("thread-1");
  assert.equal(restored.activeThreadId, "thread-1");
  assert.equal(restored.turnState, "thinking");

  runtime.finish();
  await turnPromise;
});

test("两个 Chat 可以真实并行并独立取消", async () => {
  const runtime = new ParallelDesktopRuntime();
  const controller = new DesktopController(runtime);
  await controller.getSnapshot();

  const first = controller.sendMessage("Chat A");
  await runtime.waitStarted(1);
  await controller.createThread();
  const second = controller.sendMessage("Chat B");
  await runtime.waitStarted(2);

  assert.equal(runtime.running.size, 2);
  assert.equal((await controller.selectThread("thread-1")).turnState, "thinking");
  assert.equal((await controller.selectThread("thread-2")).turnState, "thinking");
  assert.equal(await controller.cancelTurn(), true);
  assert.deepEqual([...runtime.cancelled], ["turn-2"]);
  assert.equal(runtime.running.has("turn-1"), true);

  runtime.finishAll();
  await Promise.all([first, second]);
});

test("DesktopController 把真实 delta 和 Activity 映射成安全桌面事件", async () => {
  const runtime = new FakeDesktopRuntime();
  const controller = new DesktopController(runtime);
  const events: string[] = [];
  controller.onEvent((event) => {
    events.push(event.type);
  });
  await controller.getSnapshot();

  const result = await controller.sendMessage("继续实现聊天主链路");

  assert.equal(result.turnId, "turn-2");
  assert.ok(events.includes("message/user"));
  assert.ok(events.includes("activity/upsert"));
  assert.ok(events.includes("runtime/session"));
  assert.ok(events.includes("assistant/completed"));
  assert.ok(events.includes("turn/state"));
});

test("DesktopController 不把 Item Budget 原始错误送入 Renderer", async () => {
  const runtime = new ItemBudgetFailureRuntime();
  const controller = new DesktopController(runtime);
  const visibleMessages: string[] = [];
  const sessions: import("../src/runtime/runtime-session.js").RuntimeSession[] = [];
  controller.onEvent((event) => {
    if (
      event.type === "turn/state" &&
      event.message !== undefined
    ) {
      visibleMessages.push(event.message);
    }
    if (event.type === "runtime/session") {
      sessions.push(event.session);
    }
  });
  await controller.getSnapshot();

  await assert.rejects(
    () => controller.sendMessage("private-user-message"),
    /Agent 执行失败，请重试/,
  );

  assert.deepEqual(
    visibleMessages.filter((message) =>
      message.includes("Agent 执行失败")
    ),
    ["Agent 执行失败，请重试"],
  );
  const rendererText = visibleMessages.join("\n");
  assert.doesNotMatch(rendererText, /130 > 128/);
  assert.doesNotMatch(rendererText, /private-user-message/);
  assert.doesNotMatch(rendererText, /private-tool-argument/);
  const finalSession = sessions.at(-1);
  assert.equal(finalSession?.status, "failed");
  assert.equal(
    finalSession?.items.some(
      (item) => "status" in item && item.status === "running",
    ),
    false,
  );
  assert.equal(
    finalSession?.items.filter((item) => item.kind === "error").length,
    1,
  );
});

test("RuntimeSession 按真实顺序归类 Commentary、Activity 和最终回答", async () => {
  const runtime = new CommentaryDesktopRuntime();
  const controller = new DesktopController(runtime);
  const sessions: Array<Extract<
    import("../src/electron/desktop-types.js").DesktopEvent,
    { type: "runtime/session" }
  >["session"]> = [];
  controller.onEvent((event) => {
    if (event.type === "runtime/session") {
      sessions.push(event.session);
    }
  });
  await controller.getSnapshot();

  await controller.sendMessage("检查 Runtime Commentary");

  const final = sessions.at(-1);
  assert.ok(final);
  assert.equal(final.status, "completed");
  assert.equal(
    final.items.filter((item) => item.kind === "assistant").length,
    1,
  );
  const commentary = final.items.find(
    (item) => item.kind === "commentary",
  );
  assert.deepEqual(commentary, {
    id: "output-0",
    turnId: "turn-2",
    kind: "commentary",
    round: 0,
    status: "completed",
    markdown: "我先检查相关实现。",
  });
  const reasoning = final.items.find(
    (item) => item.kind === "reasoning_summary",
  );
  assert.deepEqual(reasoning, {
    id: "reasoning-0-1",
    turnId: "turn-2",
    kind: "reasoning_summary",
    round: 0,
    summaryIndex: 1,
    status: "completed",
    markdown: "确认调用边界。",
  });
  const tool = final.items.find(
    (item) => item.kind === "activity" && item.activityKind === "ran",
  );
  assert.equal(
    tool?.kind === "activity" ? tool.status : undefined,
    "completed",
  );
  const assistant = final.items.find(
    (item) => item.kind === "assistant",
  );
  assert.deepEqual(assistant, {
    id: "output-1",
    turnId: "turn-2",
    kind: "assistant",
    round: 1,
    status: "completed",
    markdown: "最终只显示一次。",
  });
  assert.ok(
    final.items.indexOf(commentary!) < final.items.indexOf(tool!),
  );
  assert.ok(
    final.items.indexOf(tool!) < final.items.indexOf(assistant!),
  );
  assert.equal(
    final.items.some((item) => item.kind === "pending_output"),
    false,
  );
});

test("取消和超时都会保留过程并结束全部运行状态", async () => {
  for (const terminal of ["cancelled", "timed_out"] as const) {
    const runtime = new TerminalDesktopRuntime(terminal);
    const controller = new DesktopController(runtime);
    const sessions: import("../src/runtime/runtime-session.js").RuntimeSession[] = [];
    controller.onEvent((event) => {
      if (event.type === "runtime/session") {
        sessions.push(event.session);
      }
    });
    await controller.getSnapshot();

    const result = await controller.sendMessage(`测试 ${terminal}`);
    assert.equal(result.turnId, "turn-2");

    const final = sessions.at(-1);
    assert.equal(final?.status, terminal);
    assert.equal(
      final?.items.some(
        (item) => "status" in item &&
          (item.status === "running" || item.status === "streaming"),
      ),
      false,
    );
    const commentary = final?.items.find(
      (item) => item.kind === "commentary",
    );
    assert.equal(
      commentary?.kind === "commentary"
        ? commentary.markdown
        : undefined,
      "已经产生的过程",
    );
  }
});

class FakeDesktopRuntime implements DesktopRuntimeClient {
  startThreadCount = 0;
  readonly savedConfigs: import("../src/electron/desktop-types.js").DesktopAgentConfig[] = [];
  private readonly listeners = new Set<(event: AgentEvent) => void>();

  private readonly thread: Thread = {
    id: "thread-1",
    status: "active",
    createdAt: "2026-08-06T08:00:00.000Z",
    turnIds: ["turn-1"],
  };

  private readonly capabilities: RuntimeCapabilities = {
    llm: true,
    currentModel: "gpt-5.6-sol",
    models: [
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", reasoningEfforts: ["low", "medium", "high", "xhigh"] },
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", reasoningEfforts: ["low", "medium", "high", "xhigh"] },
    ],
    webSearch: true,
    tools: [{
      name: "read_file",
      description: "读取工作区文本",
      source: "workspace",
    }],
    skills: [{
      name: "demo-skill",
      description: "演示 Skill",
    }],
    mcpServers: [],
  };

  async listThreads(): Promise<Thread[]> {
    return [{ ...this.thread, turnIds: [...this.thread.turnIds] }];
  }

  async startThread(): Promise<Thread> {
    this.startThreadCount += 1;
    return this.thread;
  }

  async readThreadHistory() {
    return {
      thread: this.thread,
      messages: [
        {
          id: "item-1",
          turnId: "turn-1",
          role: "user" as const,
          text: "实现 Codex 风格 Electron 客户端",
          createdAt: "2026-08-06T08:00:00.000Z",
        },
        {
          id: "item-2",
          turnId: "turn-1",
          role: "assistant" as const,
          text: "已完成方案。",
          createdAt: "2026-08-06T08:01:00.000Z",
        },
      ],
    };
  }

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return this.capabilities;
  }

  async listAgentRuns() { return []; }
  async getThreadConfig() { return undefined; }
  async setThreadConfig(
    _threadId: string,
    config: import("../src/electron/desktop-types.js").DesktopAgentConfig,
  ) {
    this.savedConfigs.push(structuredClone(config));
  }
  async listRuntimeSessions() { return []; }
  async setRuntimeSession() {}

  async selectModel(model: string): Promise<RuntimeCapabilities> {
    this.capabilities.currentModel = model;
    return this.capabilities;
  }

  async startTurn(
    threadId: string,
    input: string,
  ) {
    const turn: Turn = {
      id: "turn-2",
      threadId,
      status: "in_progress",
      createdAt: "2026-08-06T09:00:00.000Z",
      itemIds: ["item-3"],
    };
    const userMessage: Item = {
      id: "item-3",
      threadId,
      turnId: turn.id,
      type: "user_message",
      content: { text: input },
      createdAt: turn.createdAt,
    };

    return { turn, userMessage };
  }

  async runTurn(turnId: string) {
    this.emitForTest({ type: "model/started", turnId, round: 0 });
    this.emitForTest({
      type: "model/output_text_delta",
      turnId,
      round: 0,
      delta: "流式",
    });
    this.emitForTest({
      type: "model/output_text_delta",
      turnId,
      round: 0,
      delta: "回复",
    });
    this.emitForTest({
      type: "model/output_text_completed",
      turnId,
      round: 0,
      classification: "assistant",
      text: "流式回复",
    });
    this.emitForTest({ type: "turn/completed", turnId });

    const turn: Turn = {
      id: turnId,
      threadId: this.thread.id,
      status: "completed",
      createdAt: "2026-08-06T09:00:00.000Z",
      completedAt: "2026-08-06T09:01:00.000Z",
      itemIds: ["item-3", "item-4"],
    };
    const assistantMessage: Item = {
      id: "item-4",
      threadId: this.thread.id,
      turnId,
      type: "assistant_message",
      content: { text: "流式回复" },
      createdAt: turn.completedAt!,
    };

    return { turn, assistantMessage };
  }

  async cancelTurn(turnId: string) {
    return { turnId, cancelled: true as const };
  }

  onAgentEvent(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {}

  protected emitForTest(event: AgentEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

class ItemBudgetFailureRuntime extends FakeDesktopRuntime {
  override async runTurn(_turnId: string): Promise<never> {
    const error = new InputItemBudgetExceededError(130, 128);
    error.message +=
      " private-user-message private-tool-argument";
    throw error;
  }
}

class DeferredDesktopRuntime extends FakeDesktopRuntime {
  private finishTurn: (() => void) | undefined;
  private resolveStarted!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.resolveStarted = resolve;
  });

  finish(): void {
    this.finishTurn?.();
  }

  override async runTurn(turnId: string) {
    this.resolveStarted();
    await new Promise<void>((resolve) => {
      this.finishTurn = resolve;
    });
    return super.runTurn(turnId);
  }
}

class ParallelDesktopRuntime implements DesktopRuntimeClient {
  readonly threads = new Map<string, Thread>();
  readonly running = new Set<string>();
  readonly cancelled = new Set<string>();
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly finishers = new Map<string, () => void>();
  private startedCount = 0;
  private readonly startedWaiters: Array<() => void> = [];
  private id = 0;

  constructor() {
    this.threads.set("thread-1", {
      id: "thread-1", status: "active",
      createdAt: "2026-08-12T00:00:00.000Z", turnIds: [],
    });
    this.id = 1;
  }

  async listThreads() { return [...this.threads.values()]; }
  async startThread() {
    this.id += 1;
    const thread: Thread = {
      id: `thread-${this.id}`, status: "active",
      createdAt: `2026-08-12T00:00:0${this.id}.000Z`, turnIds: [],
    };
    this.threads.set(thread.id, thread);
    return thread;
  }
  async readThreadHistory(threadId: string) {
    return { thread: this.threads.get(threadId)!, messages: [] };
  }
  async getCapabilities(): Promise<RuntimeCapabilities> {
    return { llm: true, currentModel: "gpt-5.6-sol", models: [], webSearch: false, tools: [], skills: [], mcpServers: [] };
  }
  async listAgentRuns() { return []; }
  async getThreadConfig() { return undefined; }
  async setThreadConfig() {}
  async listRuntimeSessions() { return []; }
  async setRuntimeSession() {}
  async selectModel() { return this.getCapabilities(); }
  async startTurn(threadId: string, input: string) {
    const turnId = `turn-${threadId.split("-")[1]}`;
    const turn: Turn = {
      id: turnId, threadId, status: "in_progress",
      createdAt: new Date().toISOString(), itemIds: [`item-${turnId}`],
    };
    this.threads.get(threadId)!.turnIds.push(turnId);
    return {
      turn,
      userMessage: {
        id: `item-${turnId}`, threadId, turnId,
        type: "user_message" as const, content: { text: input },
        createdAt: turn.createdAt,
      },
    };
  }
  async runTurn(turnId: string) {
    this.running.add(turnId);
    this.emit({ type: "model/started", turnId, round: 0 });
    this.startedCount += 1;
    this.startedWaiters.splice(0).forEach((resolve) => resolve());
    await new Promise<void>((resolve) => this.finishers.set(turnId, resolve));
    this.running.delete(turnId);
    this.emit({ type: "turn/completed", turnId });
    const threadId = `thread-${turnId.split("-")[1]}`;
    const completedAt = new Date().toISOString();
    const assistantMessage: Item = {
      id: `assistant-${turnId}`, threadId, turnId,
      type: "assistant_message", content: { text: `done ${turnId}` },
      createdAt: completedAt,
    };
    return {
      turn: { id: turnId, threadId, status: "completed" as const,
        createdAt: completedAt, completedAt, itemIds: [assistantMessage.id] },
      assistantMessage,
    };
  }
  async cancelTurn(turnId: string) {
    this.cancelled.add(turnId);
    return { turnId, cancelled: true as const };
  }
  onAgentEvent(listener: (event: AgentEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async close() {}
  async waitStarted(count: number) {
    while (this.startedCount < count) {
      await new Promise<void>((resolve) => this.startedWaiters.push(resolve));
    }
  }
  finishAll() { this.finishers.forEach((finish) => finish()); }
  private emit(event: AgentEvent) { this.listeners.forEach((listener) => listener(event)); }
}

class CommentaryDesktopRuntime extends FakeDesktopRuntime {
  override async runTurn(turnId: string) {
    this.emitForTest({ type: "model/started", turnId, round: 0 });
    this.emitForTest({
      type: "reasoning/summary_part_added",
      turnId,
      round: 0,
      summaryIndex: 1,
    });
    this.emitForTest({
      type: "reasoning/summary_delta",
      turnId,
      round: 0,
      summaryIndex: 1,
      delta: "确认调用边界。",
    });
    this.emitForTest({
      type: "reasoning/summary_completed",
      turnId,
      round: 0,
    });
    this.emitForTest({
      type: "model/output_text_delta",
      turnId,
      round: 0,
      delta: "我先检查相关实现。",
    });
    this.emitForTest({
      type: "model/output_text_completed",
      turnId,
      round: 0,
      classification: "commentary",
      text: "我先检查相关实现。",
    });
    this.emitForTest({
      type: "model/completed",
      turnId,
      round: 0,
      functionCallCount: 1,
    });
    this.emitForTest({
      type: "tool/started",
      turnId,
      callId: "call-1",
      toolName: "read_file",
    });
    this.emitForTest({
      type: "tool/completed",
      turnId,
      callId: "call-1",
      toolName: "read_file",
    });
    this.emitForTest({ type: "model/started", turnId, round: 1 });
    this.emitForTest({
      type: "model/output_text_delta",
      turnId,
      round: 1,
      delta: "最终只显示一次。",
    });
    this.emitForTest({
      type: "model/output_text_completed",
      turnId,
      round: 1,
      classification: "assistant",
      text: "最终只显示一次。",
    });
    this.emitForTest({
      type: "model/completed",
      turnId,
      round: 1,
      functionCallCount: 0,
    });
    this.emitForTest({ type: "turn/completed", turnId });

    return {
      turn: {
        id: turnId,
        threadId: "thread-1",
        status: "completed" as const,
        createdAt: "2026-08-06T09:00:00.000Z",
        completedAt: "2026-08-06T09:01:00.000Z",
        itemIds: ["item-3", "item-4"],
      },
      assistantMessage: {
        id: "item-4",
        threadId: "thread-1",
        turnId,
        type: "assistant_message" as const,
        content: { text: "最终只显示一次。" },
        createdAt: "2026-08-06T09:01:00.000Z",
      },
    };
  }
}

class TerminalDesktopRuntime extends FakeDesktopRuntime {
  constructor(
    private readonly terminal: "cancelled" | "timed_out",
  ) {
    super();
  }

  override async runTurn(turnId: string): Promise<never> {
    this.emitForTest({ type: "model/started", turnId, round: 0 });
    this.emitForTest({
      type: "model/output_text_delta",
      turnId,
      round: 0,
      delta: "已经产生的过程",
    });
    this.emitForTest({
      type: "tool/started",
      turnId,
      callId: "call-running",
      toolName: "read_file",
    });

    if (this.terminal === "cancelled") {
      this.emitForTest({
        type: "turn/interrupted",
        turnId,
        message: "internal cancellation details",
      });
    } else {
      this.emitForTest({
        type: "turn/timed_out",
        turnId,
        message: "internal timeout details",
      });
    }

    throw new Error("internal terminal error");
  }
}
