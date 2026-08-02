import assert from "node:assert/strict";
import test from "node:test";

import {
  ToolRegistry,
  type AgentTool,
} from "../src/tools/tool-registry.js";

const echoTool: AgentTool = {
  definition: {
    name: "echo",
    description: "回显输入",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  execute(argumentsJson) {
    const input = JSON.parse(argumentsJson) as {
      text: string;
    };

    return {
      result: {
        echoed: input.text,
      },
      modelOutput: {
        safeEcho: input.text,
      },
    };
  },
};

test("注册 Tool 并返回定义和执行结果", async () => {
  const registry = new ToolRegistry([echoTool]);

  assert.deepEqual(registry.getDefinitions(), [
    echoTool.definition,
  ]);

  const execution = await registry.execute(
    "echo",
    '{"text":"hello"}',
  );

  assert.deepEqual(execution.result, {
    echoed: "hello",
  });
  assert.equal(
    execution.output,
    '{"safeEcho":"hello"}',
  );
});

test("拒绝重复注册同名 Tool", () => {
  assert.throws(
    () => new ToolRegistry([echoTool, echoTool]),
    /Tool already registered: echo/,
  );
});

test("拒绝执行未知 Tool", async () => {
  const registry = new ToolRegistry();

  await assert.rejects(
    () => registry.execute("missing", "{}"),
    /Unknown tool: missing/,
  );
});
