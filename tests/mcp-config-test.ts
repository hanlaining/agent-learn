import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  loadMcpServerConfigs,
} from "../src/mcp/mcp-config.js";

test("读取 MCP JSON 配置并相对配置文件解析 cwd", async (context) => {
  const directory = await mkdtemp(
    join(tmpdir(), "god-agent-mcp-config-"),
  );
  const configPath = join(directory, "mcp.json");

  context.after(() => rm(directory, {
    recursive: true,
    force: true,
  }));

  await writeFile(
    configPath,
    JSON.stringify({
      mcpServers: {
        demo: {
          command: "node",
          args: ["server.mjs"],
          cwd: "fixtures",
          requestTimeoutMs: 2_000,
        },
      },
    }),
    "utf8",
  );

  assert.deepEqual(
    await loadMcpServerConfigs(configPath),
    [
      {
        name: "demo",
        command: "node",
        args: ["server.mjs"],
        cwd: resolve(directory, "fixtures"),
        requestTimeoutMs: 2_000,
      },
    ],
  );
});

test("MCP 配置保留独立 discoveryTimeoutMs，并兼容未配置旧条目", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "god-agent-mcp-config-timeout-"));
  const configPath = join(directory, "mcp.json");
  context.after(() => rm(directory, { recursive: true, force: true }));

  await writeFile(configPath, JSON.stringify({
    mcpServers: {
      slowStartup: { command: "node", requestTimeoutMs: 250, discoveryTimeoutMs: 2_500 },
      legacyConfig: { command: "node", requestTimeoutMs: 250 },
    },
  }), "utf8");

  assert.deepEqual(await loadMcpServerConfigs(configPath), [
    { name: "slowStartup", command: "node", args: [], requestTimeoutMs: 250, discoveryTimeoutMs: 2_500 },
    { name: "legacyConfig", command: "node", args: [], requestTimeoutMs: 250 },
  ]);
});

test("MCP 配置拒绝非正 discoveryTimeoutMs", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "god-agent-mcp-config-timeout-invalid-"));
  const configPath = join(directory, "mcp.json");
  context.after(() => rm(directory, { recursive: true, force: true }));

  for (const discoveryTimeoutMs of [0, -1, 1.5]) {
    await writeFile(configPath, JSON.stringify({ mcpServers: { bad: { command: "node", discoveryTimeoutMs } } }), "utf8");
    await assert.rejects(() => loadMcpServerConfigs(configPath), /Invalid MCP Server discoveryTimeoutMs: bad/);
  }
});

test("MCP 配置拒绝 env 和其他未支持字段", async (context) => {
  const directory = await mkdtemp(
    join(tmpdir(), "god-agent-mcp-config-"),
  );
  const configPath = join(directory, "mcp.json");

  context.after(() => rm(directory, {
    recursive: true,
    force: true,
  }));

  await writeFile(
    configPath,
    JSON.stringify({
      mcpServers: {
        unsafe: {
          command: "node",
          env: { SECRET: "must-not-pass" },
        },
      },
    }),
    "utf8",
  );

  await assert.rejects(
    () => loadMcpServerConfigs(configPath),
    /unsupported field: env/,
  );
});

test("MCP 配置拒绝会破坏 Tool 命名空间的 Server 名称", async (context) => {
  const directory = await mkdtemp(
    join(tmpdir(), "god-agent-mcp-config-"),
  );
  const configPath = join(directory, "mcp.json");

  context.after(() => rm(directory, {
    recursive: true,
    force: true,
  }));

  await writeFile(
    configPath,
    JSON.stringify({
      mcpServers: {
        "bad server": { command: "node" },
      },
    }),
    "utf8",
  );

  await assert.rejects(
    () => loadMcpServerConfigs(configPath),
    /Invalid MCP Server name/,
  );
});
