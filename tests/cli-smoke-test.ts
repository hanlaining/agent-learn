import assert from "node:assert/strict";
import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("god-agent 可执行入口直接输出版本", async () => {
  const result = await runProcess(
    ["bin/god-agent.js", "--version"],
    createSmokeEnvironment("unused-state.json"),
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout.trim(), "god-agent 1.0.0");
  assert.equal(result.stderr, "");
});

test("god-agent CLI 可恢复 Thread、执行命令并安全退出", async (t) => {
  const stateDirectory = await mkdtemp(
    join(tmpdir(), "god-agent-cli-smoke-"),
  );
  t.after(() => rm(stateDirectory, {
    recursive: true,
    force: true,
  }));
  const environment = createSmokeEnvironment(
    join(stateDirectory, "state.json"),
  );
  const first = await runInteractiveCli(
    environment,
    "/exit\n",
  );
  const second = await runInteractiveCli(
    environment,
    "/help\n/status\n/threads\n/new\n/exit\n",
  );

  assert.equal(first.exitCode, 0, first.stderr);
  assert.equal(second.exitCode, 0, second.stderr);
  assert.match(second.stdout, /已恢复上次会话/);
  assert.match(second.stdout, /god-agent 已启动/);
  assert.match(second.stdout, /You ›/);
  assert.match(second.stdout, /命令：/);
  assert.match(second.stdout, /Turn：idle/);
  assert.match(second.stdout, /Queue：0/);
  assert.match(second.stdout, /已保存的 Thread/);
  assert.match(second.stdout, /已创建新 Thread/);
  assert.match(second.stdout, /god-agent 已退出/);
  assert.doesNotMatch(second.stdout, /\[Turn\]|\[Model\]/);
  assert.equal(second.stderr, "");
});

test("--debug 保留 Runtime 内部日志", async (t) => {
  const stateDirectory = await mkdtemp(
    join(tmpdir(), "god-agent-cli-debug-"),
  );
  t.after(() => rm(stateDirectory, {
    recursive: true,
    force: true,
  }));
  const result = await runInteractiveCli(
    createSmokeEnvironment(
      join(stateDirectory, "state.json"),
    ),
    "/exit\n",
    ["--debug"],
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /Initialize result/);
  assert.match(result.stderr, /\[app-server\]/);
});

test("运行中的第二条消息进入队列并携带上一轮 Context", async (t) => {
  const stateDirectory = await mkdtemp(
    join(tmpdir(), "god-agent-cli-queue-"),
  );
  t.after(() => rm(stateDirectory, {
    recursive: true,
    force: true,
  }));
  const requestBodies: Array<Record<string, unknown>> = [];
  let responseSequence = 0;
  const server = createServer((request, response) => {
    void readRequestBody(request).then((body) => {
      requestBodies.push(
        JSON.parse(body) as Record<string, unknown>,
      );
      responseSequence += 1;
      const currentSequence = responseSequence;
      const text =
        currentSequence === 1
          ? "第一轮完成"
          : "第二轮完成";

      setTimeout(() => {
        response.writeHead(200, {
          "content-type": "application/json",
        });
        response.end(JSON.stringify({
          id: `response-${currentSequence}`,
          output: [
            {
              type: "message",
              content: [
                { type: "output_text", text },
              ],
            },
          ],
        }));
      }, currentSequence === 1 ? 150 : 0);
    });
  });
  const baseUrl = await listenOnRandomPort(server);
  t.after(() => closeServer(server));
  const environment = {
    ...createSmokeEnvironment(
      join(stateDirectory, "state.json"),
    ),
    OPENAI_API_KEY: "test-only-key",
    OPENAI_BASE_URL: baseUrl,
  };
  const cli = startCli(environment);

  await waitForText(cli, "god-agent 已启动");
  cli.child.stdin.write("第一条\n第二条\n");
  await waitForText(cli, "第二轮完成");
  cli.child.stdin.end("/exit\n");
  const exitCode = await cli.exit;

  assert.equal(exitCode, 0, cli.stderr());
  assert.match(cli.stdout(), /消息已进入队列/);
  assert.match(cli.stdout(), /Assistant › 第一轮完成/);
  assert.match(cli.stdout(), /Assistant › 第二轮完成/);
  assert.equal(requestBodies.length, 2);
  assert.deepEqual(requestBodies[1]?.input, [
    {
      role: "user",
      content: [
        { type: "input_text", text: "第一条" },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "output_text", text: "第一轮完成" },
      ],
    },
    {
      role: "user",
      content: [
        { type: "input_text", text: "第二条" },
      ],
    },
  ]);
});

test("/cancel 端到端中断挂起模型请求", async (t) => {
  const stateDirectory = await mkdtemp(
    join(tmpdir(), "god-agent-cli-cancel-"),
  );
  t.after(() => rm(stateDirectory, {
    recursive: true,
    force: true,
  }));
  let requestStarted = false;
  let requestClosed = false;
  const server = createServer((request, response) => {
    requestStarted = true;
    response.on("close", () => {
      requestClosed = true;
    });
    request.resume();
    // 故意不响应，只有 AbortSignal 能结束本次模型调用。
  });
  const baseUrl = await listenOnRandomPort(server);
  t.after(() => closeServer(server));
  const cli = startCli({
    ...createSmokeEnvironment(
      join(stateDirectory, "state.json"),
    ),
    OPENAI_API_KEY: "test-only-key",
    OPENAI_BASE_URL: baseUrl,
  });

  await waitForText(cli, "god-agent 已启动");
  cli.child.stdin.write("等待取消\n");
  await waitForText(cli, "Thinking…");
  await waitForCondition(
    () => requestStarted,
    "fake model request to start",
  );
  cli.child.stdin.write("/cancel\n");
  await waitForText(cli, "Turn 已取消");
  await waitForCondition(
    () => requestClosed,
    "aborted model response to close",
  );
  cli.child.stdin.end("/exit\n");
  const exitCode = await cli.exit;

  assert.equal(exitCode, 0, cli.stderr());
  assert.equal(requestClosed, true);
  assert.match(cli.stdout(), /已请求取消 Turn/);
});

function createSmokeEnvironment(
  statePath: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    AGENT_STATE_PATH: statePath,
  };

  // 只继承 Node/tsx 启动所需的系统变量，明确不继承任何 Provider Key。
  for (const name of [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
  ]) {
    const value = process.env[name];

    if (value !== undefined) {
      environment[name] = value;
    }
  }

  return environment;
}

async function runProcess(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(
    process.execPath,
    [...arguments_],
    {
      cwd: process.cwd(),
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number | null>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    },
  );

  return { exitCode, stdout, stderr };
}

async function runInteractiveCli(
  environment: NodeJS.ProcessEnv,
  commands: string,
  options: readonly string[] = [],
): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/cli/main.ts",
      ...options,
    ],
    {
      cwd: process.cwd(),
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  let commandsSent = false;

  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;

    if (
      !commandsSent &&
      stdout.includes("god-agent 已启动")
    ) {
      commandsSent = true;
      child.stdin.end(commands);
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number | null>(
    (resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(
          "CLI smoke timeout\n" +
            `stdout:\n${stdout}\n` +
            `stderr:\n${stderr}`,
        ));
      }, 10_000);

      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    },
  );

  return { exitCode, stdout, stderr };
}

function startCli(environment: NodeJS.ProcessEnv): {
  child: ChildProcessWithoutNullStreams;
  stdout: () => string;
  stderr: () => string;
  exit: Promise<number | null>;
} {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/cli/main.ts"],
    {
      cwd: process.cwd(),
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    exit: new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    }),
  };
}

async function waitForText(
  cli: ReturnType<typeof startCli>,
  expected: string,
): Promise<void> {
  const startedAt = Date.now();

  while (!cli.stdout().includes(expected)) {
    if (Date.now() - startedAt > 10_000) {
      cli.child.kill();
      throw new Error(
        `Timed out waiting for: ${expected}\n` +
          `stdout:\n${cli.stdout()}\n` +
          `stderr:\n${cli.stderr()}`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForCondition(
  condition: () => boolean,
  description: string,
): Promise<void> {
  const startedAt = Date.now();

  while (!condition()) {
    if (Date.now() - startedAt > 10_000) {
      throw new Error(`Timed out waiting for ${description}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function readRequestBody(
  request: import("node:http").IncomingMessage,
): Promise<string> {
  request.setEncoding("utf8");
  let body = "";

  for await (const chunk of request) {
    body += String(chunk);
  }

  return body;
}

async function listenOnRandomPort(
  server: import("node:http").Server,
): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;

  return `http://127.0.0.1:${address.port}`;
}

function closeServer(
  server: import("node:http").Server,
): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}
