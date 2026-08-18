import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, {
  type TestContext,
} from "node:test";

import {
  JsonFileRuntimePersistence,
} from "../src/runtime/json-file-runtime-persistence.js";
import {
  createModelRequestDigest,
} from "../src/runtime/model-invocation.js";
import {
  createToolArgumentsDigest,
} from "../src/runtime/tool-invocation.js";

async function createFixture(t: TestContext) {
  const directory = await mkdtemp(
    join(tmpdir(), "agent-runtime-state-"),
  );
  t.after(() => rm(directory, {
    recursive: true,
    force: true,
  }));

  return {
    statePath: join(directory, "nested", "state.json"),
  };
}

test("状态文件不存在时返回新的空 Store", async (t) => {
  const fixture = await createFixture(t);
  const persistence = new JsonFileRuntimePersistence(
    fixture.statePath,
  );

  const loaded = await persistence.load();

  assert.equal(loaded.restored, false);
  assert.deepEqual(loaded.recoveredTurnIds, []);
  assert.deepEqual(
    loaded.lifecycleStore.exportSnapshot().threads,
    [],
  );
  assert.deepEqual(
    loaded.contextCheckpointStore.exportSnapshot().checkpoints,
    [],
  );
});

test("原子保存并在新实例中恢复 Runtime 状态", async (t) => {
  const fixture = await createFixture(t);
  const persistence = new JsonFileRuntimePersistence(
    fixture.statePath,
  );
  const loaded = await persistence.load();
  const thread = loaded.lifecycleStore.createThread();
  const turn = loaded.lifecycleStore.createTurn(thread.id);
  loaded.lifecycleStore.appendItem(
    turn.id,
    "user_message",
    { text: "持久化测试" },
  );
  loaded.lifecycleStore.completeTurn(turn.id);
  loaded.contextCheckpointStore.record({
    threadId: thread.id,
    throughTurnId: turn.id,
    replacementMessages: [
      { role: "user", text: "持久化测试" },
    ],
    beforeTokens: 20,
    afterTokens: 10,
  });

  await persistence.save(
    loaded.lifecycleStore,
    loaded.contextCheckpointStore,
  );

  const restored = await new JsonFileRuntimePersistence(
    fixture.statePath,
  ).load();

  assert.equal(restored.restored, true);
  assert.deepEqual(
    restored.lifecycleStore.getThread(thread.id),
    thread,
  );
  assert.equal(
    restored.contextCheckpointStore
      .getLatest(thread.id)?.throughTurnId,
    turn.id,
  );

  const json = JSON.parse(
    await readFile(fixture.statePath, "utf8"),
  ) as { version: number };
  assert.equal(json.version, 6);
});

test("后续保存覆盖旧快照且保持合法 JSON", async (t) => {
  const fixture = await createFixture(t);
  const persistence = new JsonFileRuntimePersistence(
    fixture.statePath,
  );
  const loaded = await persistence.load();

  loaded.lifecycleStore.createThread();
  await persistence.save(
    loaded.lifecycleStore,
    loaded.contextCheckpointStore,
  );
  loaded.lifecycleStore.createThread();
  await persistence.save(
    loaded.lifecycleStore,
    loaded.contextCheckpointStore,
  );

  const restored = await persistence.load();
  assert.equal(
    restored.lifecycleStore.exportSnapshot().threads.length,
    2,
  );
});

test("拒绝损坏的 Runtime 状态文件", async (t) => {
  const fixture = await createFixture(t);
  await mkdir(join(fixture.statePath, ".."), {
    recursive: true,
  });
  await writeFile(fixture.statePath, "not-json", "utf8");

  await assert.rejects(
    () => new JsonFileRuntimePersistence(
      fixture.statePath,
    ).load(),
    /Invalid runtime state file/,
  );
});

test("重启时把遗留的 in_progress Turn 恢复为 interrupted", async (t) => {
  const fixture = await createFixture(t);
  const persistence = new JsonFileRuntimePersistence(
    fixture.statePath,
  );
  const loaded = await persistence.load();
  const thread = loaded.lifecycleStore.createThread();
  const turn = loaded.lifecycleStore.createTurn(thread.id);
  loaded.lifecycleStore.appendItem(
    turn.id,
    "user_message",
    { text: "进程中断前的问题" },
  );
  await persistence.save(
    loaded.lifecycleStore,
    loaded.contextCheckpointStore,
  );

  const restored = await new JsonFileRuntimePersistence(
    fixture.statePath,
  ).load();

  assert.deepEqual(restored.recoveredTurnIds, [turn.id]);
  assert.equal(
    restored.lifecycleStore.getTurn(turn.id)?.status,
    "interrupted",
  );

  const persistedAgain = await new JsonFileRuntimePersistence(
    fixture.statePath,
  ).load();
  assert.deepEqual(persistedAgain.recoveredTurnIds, []);
  assert.equal(
    persistedAgain.lifecycleStore.getTurn(turn.id)?.status,
    "interrupted",
  );
});

test("v1 快照迁移到 v6 并初始化 Agent Runtime 与 Requirement 数据", async (t) => {
  const fixture = await createFixture(t);
  const base = await new JsonFileRuntimePersistence(fixture.statePath).load();
  const legacy = {
    version: 1,
    lifecycle: base.lifecycleStore.exportSnapshot(),
    contextCheckpoints: base.contextCheckpointStore.exportSnapshot(),
  };
  await mkdir(join(fixture.statePath, ".."), { recursive: true });
  await writeFile(fixture.statePath, JSON.stringify(legacy), "utf8");
  const loaded = await new JsonFileRuntimePersistence(fixture.statePath).load();
  assert.equal(loaded.restored, true);
  assert.deepEqual(loaded.agentRunStore.list(), []);
  await new JsonFileRuntimePersistence(fixture.statePath).save(
    loaded.lifecycleStore, loaded.contextCheckpointStore, loaded.agentRunStore,
  );
  const persisted = JSON.parse(await readFile(fixture.statePath, "utf8")) as { version: number };
  assert.equal(persisted.version, 6);
});

test("v4 快照加载后 ModelInvocation 默认为空", async (t) => {
  const fixture = await createFixture(t);
  const persistence = new JsonFileRuntimePersistence(fixture.statePath);
  const base = await persistence.load();
  await persistence.save(
    base.lifecycleStore,
    base.contextCheckpointStore,
    base.agentRunStore,
    base.threadConfigs,
    base.agentProfiles,
    base.runtimeSessions,
    base.agentRuntimeStore,
    base.requirementStore,
    base.modelInvocationStore,
  );

  const legacy = JSON.parse(
    await readFile(fixture.statePath, "utf8"),
  ) as { version: number; modelInvocations?: unknown };
  legacy.version = 4;
  delete legacy.modelInvocations;
  await writeFile(fixture.statePath, JSON.stringify(legacy), "utf8");

  const loaded = await new JsonFileRuntimePersistence(fixture.statePath).load();
  assert.equal(loaded.restored, true);
  assert.deepEqual(loaded.modelInvocationStore.list(), []);
});

test("v5 快照加载后 ToolInvocation 默认为空", async (t) => {
  const fixture = await createFixture(t);
  const persistence = new JsonFileRuntimePersistence(fixture.statePath);
  const base = await persistence.load();
  await persistence.save(
    base.lifecycleStore,
    base.contextCheckpointStore,
    base.agentRunStore,
    base.threadConfigs,
    base.agentProfiles,
    base.runtimeSessions,
    base.agentRuntimeStore,
    base.requirementStore,
    base.modelInvocationStore,
    base.toolInvocationStore,
  );

  const legacy = JSON.parse(
    await readFile(fixture.statePath, "utf8"),
  ) as { version: number; toolInvocations?: unknown };
  legacy.version = 5;
  delete legacy.toolInvocations;
  await writeFile(fixture.statePath, JSON.stringify(legacy), "utf8");

  const loaded = await new JsonFileRuntimePersistence(fixture.statePath).load();
  assert.equal(loaded.restored, true);
  assert.deepEqual(loaded.toolInvocationStore.list(), []);
});

test("v6 快照往返保留 ModelInvocation WAL", async (t) => {
  const fixture = await createFixture(t);
  const persistence = new JsonFileRuntimePersistence(fixture.statePath);
  const loaded = await persistence.load();
  const invocation = loaded.modelInvocationStore.prepare({
    threadId: "thread-wal",
    turnId: "turn-wal",
    round: 0,
    purpose: "workflow_stage",
    jobId: "job-wal",
    jobAttempt: 1,
    stageId: "product",
    stageAttempt: 1,
    requestDigest: createModelRequestDigest({ prompt: "persist WAL" }),
    provider: "openai",
    model: "gpt-5.6",
  });
  loaded.modelInvocationStore.markSubmitted(invocation.invocationId);
  loaded.modelInvocationStore.recordResponse(invocation.invocationId, {
    providerResponseId: "response-wal",
    normalizedResult: { text: "persisted result", functionCalls: [] },
  });
  const expected = loaded.modelInvocationStore.exportSnapshot();

  await persistence.save(
    loaded.lifecycleStore,
    loaded.contextCheckpointStore,
    loaded.agentRunStore,
    loaded.threadConfigs,
    loaded.agentProfiles,
    loaded.runtimeSessions,
    loaded.agentRuntimeStore,
    loaded.requirementStore,
    loaded.modelInvocationStore,
  );

  const persisted = JSON.parse(
    await readFile(fixture.statePath, "utf8"),
  ) as { version: number; modelInvocations?: unknown };
  assert.equal(persisted.version, 6);
  assert.deepEqual(persisted.modelInvocations, expected);

  const restored = await new JsonFileRuntimePersistence(fixture.statePath).load();
  assert.deepEqual(restored.modelInvocationStore.exportSnapshot(), expected);
  assert.equal(
    restored.modelInvocationStore.get(invocation.invocationId)?.status,
    "response_received",
  );
  assert.deepEqual(
    restored.modelInvocationStore.get(invocation.invocationId)?.normalizedResult,
    { text: "persisted result", functionCalls: [] },
  );
});

test("v6 快照往返保留 ToolInvocation WAL", async (t) => {
  const fixture = await createFixture(t);
  const persistence = new JsonFileRuntimePersistence(fixture.statePath);
  const loaded = await persistence.load();
  const invocation = loaded.toolInvocationStore.prepare({
    modelInvocationId: "model-invocation-tool-wal",
    callId: "call-tool-wal",
    toolName: "durable_tool",
    argumentsDigest: createToolArgumentsDigest({
      path: "README.md",
      value: 1,
    }),
  });
  loaded.toolInvocationStore.markExecuting(invocation.toolInvocationId);
  loaded.toolInvocationStore.recordResult(invocation.toolInvocationId, {
    result: { ok: true, value: 1 },
    output: '{"ok":true,"value":1}',
  });
  const expected = loaded.toolInvocationStore.exportSnapshot();

  await persistence.save(
    loaded.lifecycleStore,
    loaded.contextCheckpointStore,
    loaded.agentRunStore,
    loaded.threadConfigs,
    loaded.agentProfiles,
    loaded.runtimeSessions,
    loaded.agentRuntimeStore,
    loaded.requirementStore,
    loaded.modelInvocationStore,
    loaded.toolInvocationStore,
  );

  const persisted = JSON.parse(
    await readFile(fixture.statePath, "utf8"),
  ) as { version: number; toolInvocations?: unknown };
  assert.equal(persisted.version, 6);
  assert.deepEqual(persisted.toolInvocations, expected);

  const restored = await new JsonFileRuntimePersistence(fixture.statePath).load();
  assert.deepEqual(restored.toolInvocationStore.exportSnapshot(), expected);
  assert.equal(
    restored.toolInvocationStore.get(invocation.toolInvocationId)?.status,
    "result_received",
  );
  assert.equal(
    restored.toolInvocationStore.get(invocation.toolInvocationId)?.toolName,
    "durable_tool",
  );
});

test("Runtime Snapshot 保留恢复所需业务原文，仅排除 Provider 凭据与认证头", async (t) => {
  const fixture = await createFixture(t);
  const persistence = new JsonFileRuntimePersistence(fixture.statePath);
  const loaded = await persistence.load();
  const thread = loaded.lifecycleStore.createThread();
  const turn = loaded.lifecycleStore.createTurn(thread.id);
  loaded.lifecycleStore.appendItem(turn.id, "user_message", {
    text: "用户业务原文：论文实验与项目路径必须可恢复",
  });
  const modelInvocation = loaded.modelInvocationStore.prepare({
    threadId: thread.id,
    turnId: turn.id,
    round: 0,
    purpose: "initial",
    requestDigest: createModelRequestDigest({ prompt: "论文实验" }),
    provider: "openai",
    model: "test-model",
  });
  loaded.modelInvocationStore.markSubmitted(modelInvocation.invocationId);
  loaded.modelInvocationStore.recordResponse(modelInvocation.invocationId, {
    providerResponseId: "response-business-content",
    normalizedResult: {
      text: "模型业务文本：保留研究结论",
      functionCalls: [{
        callId: "call-business",
        name: "research_tool",
        arguments: JSON.stringify({ topic: "科研恢复", authorization: "Bearer provider-secret" }),
      }],
    },
  });
  const toolInvocation = loaded.toolInvocationStore.prepare({
    modelInvocationId: modelInvocation.invocationId,
    callId: "call-business",
    toolName: "research_tool",
    argumentsDigest: createToolArgumentsDigest({ topic: "科研恢复" }),
  });
  loaded.toolInvocationStore.markExecuting(toolInvocation.toolInvocationId);
  loaded.toolInvocationStore.recordResult(toolInvocation.toolInvocationId, {
    result: {
      businessText: "工具业务结果：实验通过",
      tokenCount: 42,
      apiKey: "sk-provider-secret",
    },
    output: JSON.stringify({
      businessText: "工具输出原文",
      authorization: "Bearer provider-secret",
    }),
  });

  await persistence.save(
    loaded.lifecycleStore,
    loaded.contextCheckpointStore,
    loaded.agentRunStore,
    loaded.threadConfigs,
    loaded.agentProfiles,
    loaded.runtimeSessions,
    loaded.agentRuntimeStore,
    loaded.requirementStore,
    loaded.modelInvocationStore,
    loaded.toolInvocationStore,
  );

  const serialized = await readFile(fixture.statePath, "utf8");
  assert.match(serialized, /用户业务原文：论文实验与项目路径必须可恢复/);
  assert.match(serialized, /模型业务文本：保留研究结论/);
  assert.match(serialized, /科研恢复/);
  assert.match(serialized, /工具业务结果：实验通过/);
  assert.match(serialized, /工具输出原文/);
  assert.match(serialized, /tokenCount/);
  assert.doesNotMatch(serialized, /provider-secret|sk-provider-secret/);
  assert.match(serialized, /\[REDACTED\]/);
});

test("v2 恢复 Thread 配置、RuntimeSession 和 run_return 收据", async (t) => {
  const fixture = await createFixture(t);
  const persistence = new JsonFileRuntimePersistence(fixture.statePath);
  const loaded = await persistence.load();
  const thread = loaded.lifecycleStore.createThread();
  const turn = loaded.lifecycleStore.createTurn(thread.id);
  loaded.lifecycleStore.appendItem(turn.id, "user_message", { text: "restore" });
  const run = loaded.agentRunStore.ensureRoot(thread.id, turn.id);
  const result = { runId: run.id, status: "completed" as const, summary: "done" };
  loaded.agentRunStore.complete(run.id, result);
  loaded.agentRunStore.receiveReturn(result);
  await persistence.save(
    loaded.lifecycleStore,
    loaded.contextCheckpointStore,
    loaded.agentRunStore,
    [{ threadId: thread.id, model: "gpt-5.6-terra", reasoningEffort: "xhigh", agentProfileId: "orchestrator" }],
    [],
    [{
      threadId: thread.id,
      turnState: "completed",
      session: { turnId: turn.id, status: "completed", startedAt: "2026-08-12T00:00:00.000Z", completedAt: "2026-08-12T00:00:01.000Z", items: [] },
    }],
  );
  const restored = await new JsonFileRuntimePersistence(fixture.statePath).load();
  assert.equal(restored.threadConfigs[0]?.model, "gpt-5.6-terra");
  assert.equal(restored.runtimeSessions[0]?.session.status, "completed");
  assert.equal(restored.agentRunStore.receiveReturn(result), false);
});
