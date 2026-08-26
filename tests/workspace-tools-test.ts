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
  WorkspaceSandbox,
} from "../src/sandbox/workspace-sandbox.js";
import {
  assertWorkspacePathWithinTaskScope,
  createWorkspaceTools,
} from "../src/tools/workspace-tools.js";
import {
  ToolRegistry,
} from "../src/tools/tool-registry.js";
import { createWriteAuthorization } from "../src/app-server/write-authorization.js";
import type { AgentJob, AgentTask } from "../src/agents/agent-runtime.js";
import type { Requirement } from "../src/requirements/requirement.js";

async function createRegistry(t: TestContext) {
  const workspace = await mkdtemp(
    join(tmpdir(), "agent-workspace-tools-"),
  );
  t.after(() => rm(workspace, {
    recursive: true,
    force: true,
  }));
  await writeFile(
    join(workspace, "README.md"),
    "Workspace guide",
    "utf8",
  );
  const sandbox = await WorkspaceSandbox.create(workspace);

  return new ToolRegistry(createWorkspaceTools(sandbox));
}

test("read_file 通过 Sandbox 读取文本", async (t) => {
  const registry = await createRegistry(t);

  const execution = await registry.execute(
    "read_file",
    '{"path":"README.md"}',
  );

  assert.deepEqual(execution.result, {
    path: "README.md",
    text: "Workspace guide",
    sizeBytes: 15,
  });
  assert.equal(
    execution.output,
    '{"path":"README.md","text":"Workspace guide","sizeBytes":15}',
  );
});

test("list_files 返回受数量限制的目录结果", async (t) => {
  const registry = await createRegistry(t);
  const definition = registry.getDefinitions().find(
    (candidate) => candidate.name === "list_files",
  );

  assert.deepEqual(definition?.parameters.required, ["path"]);

  const execution = await registry.execute(
    "list_files",
    '{"path":"."}',
  );

  assert.deepEqual(execution.result, {
    path: ".",
    entries: [
      {
        path: "README.md",
        type: "file",
      },
    ],
    truncated: false,
  });
});

test("read_file 不能绕过 Workspace 边界", async (t) => {
  const registry = await createRegistry(t);

  await assert.rejects(
    () => registry.execute(
      "read_file",
      '{"path":"../secret.txt"}',
    ),
    /Path escapes workspace/,
  );
});

test("Workspace Tool 拒绝非法 JSON 参数", async (t) => {
  const registry = await createRegistry(t);

  await assert.rejects(
    () => registry.execute("read_file", "not-json"),
    /read_file arguments must be valid JSON/,
  );
});

test("write_file 只能在 Workspace 内写入 UTF-8 文本", async (t) => {
  const registry = await createRegistry(t);
  const execution = await registry.execute("write_file", JSON.stringify({ path: "result.txt", text: "done" }));
  assert.deepEqual(execution.result, { path: "result.txt", sizeBytes: 4 });
  assert.deepEqual((await registry.execute("read_file", '{"path":"result.txt"}')).result, {
    path: "result.txt", text: "done", sizeBytes: 4,
  });
  await assert.rejects(() => registry.execute("write_file", JSON.stringify({ path: "../outside.txt", text: "no" })), /Path escapes workspace/);
});

test("v3 Task 文件边界在 write_file 真正执行前拒绝越界路径", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "agent-v3-boundary-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const sandbox = await WorkspaceSandbox.create(workspace);
  await mkdir(join(workspace, "src", "electron"), { recursive: true });
  const scopes = new Map<string, { allowedPaths: string[]; deniedPaths: string[] }>([
    ["front-turn", { allowedPaths: ["src/electron"], deniedPaths: ["src/app-server"] }],
    ["back-turn", { allowedPaths: ["src/app-server"], deniedPaths: ["src/electron"] }],
    ["integration-turn", { allowedPaths: ["tests"], deniedPaths: ["src/electron", "src/app-server"] }],
  ]);
  const registry = new ToolRegistry(createWorkspaceTools(sandbox, { authorizeWrite: ({ turnId, path }) => {
    const scope = turnId === undefined ? undefined : scopes.get(turnId);
    if (scope === undefined) throw new Error("Task scope unavailable");
    assertWorkspacePathWithinTaskScope(path, scope);
  } }));
  await registry.execute("write_file", JSON.stringify({ path: "src/electron/App.tsx", text: "ok" }), undefined, "front-turn");
  await assert.rejects(() => registry.execute("write_file", JSON.stringify({ path: "src/app-server/main.ts", text: "no" }), undefined, "front-turn"), /file boundary rejected/);
  await assert.rejects(() => registry.execute("write_file", JSON.stringify({ path: "src/electron/../app-server/main.ts", text: "no" }), undefined, "front-turn"), /non-canonical path/);
  await assert.rejects(() => registry.execute("write_file", JSON.stringify({ path: "src\\electron\\..\\app-server\\main.ts", text: "no" }), undefined, "front-turn"), /non-canonical path/);
  await assert.rejects(() => registry.execute("write_file", JSON.stringify({ path: "src/electron/./App.tsx", text: "no" }), undefined, "front-turn"), /non-canonical path/);
  await registry.execute("write_file", JSON.stringify({ path: "src//electron//Nested.tsx", text: "ok" }), undefined, "front-turn");
  await assert.rejects(() => registry.execute("write_file", JSON.stringify({ path: "src/electron/App.tsx", text: "no" }), undefined, "back-turn"), /file boundary rejected/);
  await assert.rejects(() => registry.execute("write_file", JSON.stringify({ path: "src/app-server/main.ts", text: "no" }), undefined, "integration-turn"), /file boundary rejected/);
});

function writeAuthorizationFixture(options: {
  workflowVersion?: string;
  turnId?: string;
  task?: AgentTask;
  requirement?: Requirement;
  run?: { jobId: string; taskId?: string } | null;
}) {
  const job = {
    id: "job-v3",
    workflowVersion: options.workflowVersion ?? "software_product_delivery_v3",
    requirementId: options.requirement === undefined ? "requirement-1" : options.requirement.id,
  } as AgentJob;
  const run: { jobId: string; taskId?: string } | undefined = options.run === null
    ? undefined
    : options.run === undefined
      ? (options.task === undefined ? { jobId: job.id } : { jobId: job.id, taskId: options.task.id })
      : options.run;
  const authorize = createWriteAuthorization({
    runStore: { getByTurn: (turnId) => turnId === (options.turnId ?? "turn-1") ? run : undefined },
    runtimeStore: {
      getTask: (id) => id === options.task?.id ? options.task : undefined,
      getJob: (id) => id === job.id ? job : undefined,
    },
    requirementStore: {
      get: (id) => id === options.requirement?.id ? options.requirement : undefined,
    },
  });
  return { authorize, turnId: options.turnId ?? "turn-1" };
}

function confirmedRequirement(): Requirement {
  return {
    id: "requirement-1", parentThreadId: "thread-1", revision: 1,
    executionKind: "software_product_delivery", title: "t", objective: "o",
    scope: ["src/electron"], nonGoals: [], constraints: [], deliverables: [],
    acceptanceCriteria: [], testCases: [], executionSteps: [], status: "confirmed",
    executionState: "not_started", planArtifact: { path: "plan.md", contentHash: "plan-hash", generatedAt: "2026-01-01" },
    confirmedRevision: 1, confirmedContentHash: "plan-hash", designStatus: "confirmed",
    designArtifact: { path: "design.md", contentHash: "design-hash", generatedAt: "2026-01-01" },
    designConfirmedRevision: 1, designConfirmedContentHash: "design-hash", createdAt: "2026-01-01", updatedAt: "2026-01-01",
  };
}

function taskWithScope(scope: AgentTask["scope"]): AgentTask {
  return { id: "task-1", jobId: "job-v3", rootRunId: "run-1", ownerRunId: "run-1", profileId: "engineering_role", title: "t", objective: "o", scope,
    requiredOutputs: [], acceptanceCriteria: [], dependencyIds: [], fileClaims: [], attempt: 1, jobAttempt: 1, maxAttempts: 1,
    status: "running", createdAt: "2026-01-01", updatedAt: "2026-01-01" };
}

test("V3 write_file 授权回调覆盖状态、任务和路径边界", () => {
  const requirement = confirmedRequirement();
  const task = taskWithScope({ allowedPaths: ["src/electron"], deniedPaths: ["src/electron/private"], nonGoals: [] });

  // 无 turn、未知 run 和非 V3 Job 都保持向后兼容的直接放行。
  assert.doesNotThrow(() => writeAuthorizationFixture({}).authorize({ path: "src/electron/App.tsx" }));
  assert.doesNotThrow(() => writeAuthorizationFixture({ run: null }).authorize({ turnId: "turn-1", path: "src/electron/App.tsx" }));
  assert.doesNotThrow(() => writeAuthorizationFixture({ workflowVersion: "software_product_delivery_v2", task, requirement }).authorize({ turnId: "turn-1", path: "src/app-server/main.ts" }));

  // V3 必须同时具备设计确认、绑定 Task 和合法的规范化 scope。
  assert.throws(() => writeAuthorizationFixture({ task }).authorize({ turnId: "turn-1", path: "src/electron/App.tsx" }), /Design confirmation/);
  assert.throws(() => writeAuthorizationFixture({ requirement }).authorize({ turnId: "turn-1", path: "src/electron/App.tsx" }), /bound Task/);
  assert.throws(() => writeAuthorizationFixture({ task, requirement: { ...requirement, designStatus: "draft_ready" } }).authorize({ turnId: "turn-1", path: "src/electron/App.tsx" }), /Design confirmation/);
  assert.throws(() => writeAuthorizationFixture({ task: taskWithScope({ allowedPaths: [], deniedPaths: [], nonGoals: [] }), requirement }).authorize({ turnId: "turn-1", path: "README.md" }), /file boundary/);
  assert.throws(() => writeAuthorizationFixture({ task, requirement }).authorize({ turnId: "turn-1", path: "src/electron/private/App.tsx" }), /file boundary/);
  assert.throws(() => writeAuthorizationFixture({ task, requirement }).authorize({ turnId: "turn-1", path: "src/electron/../app-server/main.ts" }), /non-canonical/);
  assert.throws(() => writeAuthorizationFixture({ task, requirement }).authorize({ turnId: "turn-1", path: "src\\electron\\..\\app-server\\main.ts" }), /non-canonical/);
  assert.doesNotThrow(() => writeAuthorizationFixture({ task, requirement }).authorize({ turnId: "turn-1", path: "src/electron/App.tsx" }));

  // 相同状态和请求重复判定必须稳定，不扩大授权范围。
  const fixture = writeAuthorizationFixture({ task, requirement });
  assert.doesNotThrow(() => fixture.authorize({ turnId: fixture.turnId, path: "src/electron/App.tsx" }));
  assert.doesNotThrow(() => fixture.authorize({ turnId: fixture.turnId, path: "src/electron/App.tsx" }));
});

async function createAuthorizedWorkspace(
  t: TestContext,
  options: Parameters<typeof writeAuthorizationFixture>[0] = {},
) {
  const workspace = await mkdtemp(join(tmpdir(), "agent-v3-write-auth-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(join(workspace, "src", "electron"), { recursive: true });
  const sandbox = await WorkspaceSandbox.create(workspace);
  const fixture = writeAuthorizationFixture({
    task: taskWithScope({
      allowedPaths: ["src/electron"],
      deniedPaths: ["src/electron/private"],
      nonGoals: [],
    }),
    requirement: confirmedRequirement(),
    ...options,
  });
  const registry = new ToolRegistry(createWorkspaceTools(sandbox, {
    authorizeWrite: ({ turnId, path }) => fixture.authorize({ ...(turnId === undefined ? {} : { turnId }), path }),
  }));
  return { workspace, registry, turnId: fixture.turnId };
}

test("V3 write_file 未确认设计时 fail-closed 且不创建目标文件", async (t) => {
  const setup = await createAuthorizedWorkspace(t, {
    requirement: { ...confirmedRequirement(), designStatus: "draft_ready" },
  });
  await assert.rejects(
    () => setup.registry.execute("write_file", JSON.stringify({ path: "src/electron/Blocked.ts", text: "must not write" }), undefined, setup.turnId),
    /Design confirmation is required/,
  );
  await assert.rejects(() => readFile(join(setup.workspace, "src/electron/Blocked.ts"), "utf8"), /ENOENT/);
});

test("V3 write_file 缺少绑定 Task 时拒绝并保留目录状态", async (t) => {
  const setup = await createAuthorizedWorkspace(t, { run: { jobId: "job-v3", taskId: "missing-task" } });
  await assert.rejects(
    () => setup.registry.execute("write_file", JSON.stringify({ path: "src/electron/NoTask.ts", text: "must not write" }), undefined, setup.turnId),
    /requires a bound Task/,
  );
  await assert.rejects(() => readFile(join(setup.workspace, "src/electron/NoTask.ts"), "utf8"), /ENOENT/);
});

test("V3 write_file 未知 Turn 维持兼容放行但仍受 Workspace Sandbox 约束", async (t) => {
  const setup = await createAuthorizedWorkspace(t);
  await setup.registry.execute("write_file", JSON.stringify({ path: "src/electron/Legacy.ts", text: "legacy" }), undefined, "unknown-turn");
  assert.equal(await readFile(join(setup.workspace, "src/electron/Legacy.ts"), "utf8"), "legacy");
  await assert.rejects(
    () => setup.registry.execute("write_file", JSON.stringify({ path: "../outside.ts", text: "escape" }), undefined, "unknown-turn"),
    /Path escapes workspace/,
  );
});

test("V3 write_file denied path 优先于 allowed path 且不覆盖原内容", async (t) => {
  const setup = await createAuthorizedWorkspace(t);
  await mkdir(join(setup.workspace, "src", "electron", "private"), { recursive: true });
  await writeFile(join(setup.workspace, "src", "electron", "private", "Secret.ts"), "original", "utf8");
  await assert.rejects(
    () => setup.registry.execute("write_file", JSON.stringify({ path: "src/electron/private/Secret.ts", text: "tampered" }), undefined, setup.turnId),
    /file boundary rejected/,
  );
  assert.equal(await readFile(join(setup.workspace, "src", "electron", "private", "Secret.ts"), "utf8"), "original");
});

test("V3 write_file 拒绝 .. 规范化绕过且不触发外部写入", async (t) => {
  const setup = await createAuthorizedWorkspace(t);
  await assert.rejects(
    () => setup.registry.execute("write_file", JSON.stringify({ path: "src/electron/../Escape.ts", text: "escape" }), undefined, setup.turnId),
    /non-canonical path/,
  );
  await assert.rejects(() => readFile(join(setup.workspace, "src", "Escape.ts"), "utf8"), /ENOENT/);
});

test("V3 write_file 拒绝 Windows 反斜杠和点段路径", async (t) => {
  const setup = await createAuthorizedWorkspace(t);
  for (const path of ["src\\electron\\..\\Escape.ts", "src/electron/./Escape.ts"]) {
    await assert.rejects(
      () => setup.registry.execute("write_file", JSON.stringify({ path, text: "escape" }), undefined, setup.turnId),
      /non-canonical path/,
    );
  }
  await assert.rejects(() => readFile(join(setup.workspace, "src", "Escape.ts"), "utf8"), /ENOENT/);
});

test("V3 write_file 空 scope fail-closed，即使路径位于工作区也不落盘", async (t) => {
  const setup = await createAuthorizedWorkspace(t, {
    task: taskWithScope({ allowedPaths: [], deniedPaths: [], nonGoals: [] }),
  });
  await assert.rejects(
    () => setup.registry.execute("write_file", JSON.stringify({ path: "src/electron/EmptyScope.ts", text: "no" }), undefined, setup.turnId),
    /file boundary rejected/,
  );
  await assert.rejects(() => readFile(join(setup.workspace, "src/electron/EmptyScope.ts"), "utf8"), /ENOENT/);
});

test("V3 write_file 通配 denied scope 拒绝全部路径", async (t) => {
  const setup = await createAuthorizedWorkspace(t, {
    task: taskWithScope({ allowedPaths: ["src/electron"], deniedPaths: ["*"], nonGoals: [] }),
  });
  await assert.rejects(
    () => setup.registry.execute("write_file", JSON.stringify({ path: "src/electron/DeniedAll.ts", text: "no" }), undefined, setup.turnId),
    /file boundary rejected/,
  );
  await assert.rejects(() => readFile(join(setup.workspace, "src/electron/DeniedAll.ts"), "utf8"), /ENOENT/);
});

test("V3 write_file 已取消 Signal 在授权和 Sandbox 前中止且不创建文件", async (t) => {
  const setup = await createAuthorizedWorkspace(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => setup.registry.execute("write_file", JSON.stringify({ path: "src/electron/Cancelled.ts", text: "no" }), controller.signal, setup.turnId),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  await assert.rejects(() => readFile(join(setup.workspace, "src/electron/Cancelled.ts"), "utf8"), /ENOENT/);
});

test("V3 write_file 空文本是合法的确定性覆盖并返回零字节 receipt", async (t) => {
  const setup = await createAuthorizedWorkspace(t);
  const result = await setup.registry.execute("write_file", JSON.stringify({ path: "src/electron/Empty.ts", text: "" }), undefined, setup.turnId);
  assert.deepEqual(result.result, { path: "src/electron/Empty.ts", sizeBytes: 0 });
  assert.equal(await readFile(join(setup.workspace, "src/electron/Empty.ts"), "utf8"), "");
});

test("V3 write_file 重复请求只替换同一授权范围内文件且不扩大 scope", async (t) => {
  const setup = await createAuthorizedWorkspace(t);
  await setup.registry.execute("write_file", JSON.stringify({ path: "src/electron/Repeat.ts", text: "first" }), undefined, setup.turnId);
  await setup.registry.execute("write_file", JSON.stringify({ path: "src//electron//Repeat.ts", text: "second" }), undefined, setup.turnId);
  assert.equal(await readFile(join(setup.workspace, "src/electron/Repeat.ts"), "utf8"), "second");
  await assert.rejects(
    () => setup.registry.execute("write_file", JSON.stringify({ path: "src/app-server/Repeat.ts", text: "outside-task" }), undefined, setup.turnId),
    /file boundary rejected/,
  );
});

test("V3 write_file 重新创建授权 Registry 后可恢复同一 confirmed scope", async (t) => {
  const first = await createAuthorizedWorkspace(t);
  await first.registry.execute("write_file", JSON.stringify({ path: "src/electron/BeforeRestart.ts", text: "before" }), undefined, first.turnId);
  const recoveredSandbox = await WorkspaceSandbox.create(first.workspace);
  const recoveredFixture = writeAuthorizationFixture({
    task: taskWithScope({ allowedPaths: ["src/electron"], deniedPaths: ["src/electron/private"], nonGoals: [] }),
    requirement: confirmedRequirement(),
  });
  const recovered = new ToolRegistry(createWorkspaceTools(recoveredSandbox, {
    authorizeWrite: ({ turnId, path }) => recoveredFixture.authorize({ ...(turnId === undefined ? {} : { turnId }), path }),
  }));
  await recovered.execute("write_file", JSON.stringify({ path: "src/electron/AfterRestart.ts", text: "after" }), undefined, recoveredFixture.turnId);
  assert.equal(await readFile(join(first.workspace, "src/electron/BeforeRestart.ts"), "utf8"), "before");
  assert.equal(await readFile(join(first.workspace, "src/electron/AfterRestart.ts"), "utf8"), "after");
});

test("V3 write_file 参数含未知字段时在授权前拒绝且不创建文件", async (t) => {
  const setup = await createAuthorizedWorkspace(t);
  await assert.rejects(
    () => setup.registry.execute("write_file", JSON.stringify({ path: "src/electron/Unknown.ts", text: "no", turnId: setup.turnId }), undefined, setup.turnId),
    /contain unknown fields/,
  );
  await assert.rejects(() => readFile(join(setup.workspace, "src/electron/Unknown.ts"), "utf8"), /ENOENT/);
});

test("V3 write_file 非字符串 text 在授权前拒绝且保留已有文件", async (t) => {
  const setup = await createAuthorizedWorkspace(t);
  const target = join(setup.workspace, "src/electron/TypeGuard.ts");
  await writeFile(target, "original", "utf8");
  await assert.rejects(
    () => setup.registry.execute("write_file", JSON.stringify({ path: "src/electron/TypeGuard.ts", text: 42 }), undefined, setup.turnId),
    /text must be a string/,
  );
  assert.equal(await readFile(target, "utf8"), "original");
});
