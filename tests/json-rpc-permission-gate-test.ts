import assert from "node:assert/strict";
import test from "node:test";

import {
  JsonRpcPermissionGate,
  shouldAutomaticallyAllowTool,
} from "../src/permissions/json-rpc-permission-gate.js";
import {
  JsonRpcConnection,
} from "../src/protocol/connection.js";

function createConnectionPair() {
  const clientToServer: string[] = [];
  const serverToClient: string[] = [];

  const client = new JsonRpcConnection((data) => {
    clientToServer.push(data);
  });
  const server = new JsonRpcConnection((data) => {
    serverToClient.push(data);
  });

  async function flushPermissionRequest(): Promise<void> {
    await client.receive(serverToClient.shift()!);
    await server.receive(clientToServer.shift()!);
  }

  return {
    client,
    server,
    serverToClient,
    flushPermissionRequest,
  };
}

const permissionRequest = {
  turnId: "turn-1",
  callId: "call-1",
  toolName: "finance_monthly_summary",
  arguments: '{"period":"2026-07"}',
};

test("JSON-RPC PermissionGate 接受 Client allow", async () => {
  const pair = createConnectionPair();
  const gate = new JsonRpcPermissionGate(pair.server);

  pair.client.onRequest(
    "tool/request-permission",
    (params) => {
      // 审批界面只需要身份信息，不跨进程暴露原始 Tool 参数。
      assert.deepEqual(params, {
        turnId: "turn-1",
        callId: "call-1",
        toolName: "finance_monthly_summary",
      });

      return { decision: "allow" };
    },
  );

  const decisionPromise = gate.request(permissionRequest);
  await pair.flushPermissionRequest();

  assert.deepEqual(await decisionPromise, {
    decision: "allow",
  });
});

test("JSON-RPC PermissionGate 保留 Client deny 原因", async () => {
  const pair = createConnectionPair();
  const gate = new JsonRpcPermissionGate(pair.server);

  pair.client.onRequest(
    "tool/request-permission",
    () => ({
      decision: "deny",
      reason: "user denied",
    }),
  );

  const decisionPromise = gate.request(permissionRequest);
  await pair.flushPermissionRequest();

  assert.deepEqual(await decisionPromise, {
    decision: "deny",
    reason: "user denied",
  });
});

test("JSON-RPC PermissionGate 拒绝非法 Client 响应", async () => {
  const pair = createConnectionPair();
  const gate = new JsonRpcPermissionGate(pair.server);

  pair.client.onRequest(
    "tool/request-permission",
    () => ({ decision: "allow_once" }),
  );

  const decisionPromise = gate.request(permissionRequest);
  const rejectionPromise = assert.rejects(
    decisionPromise,
    /Invalid tool permission response/,
  );

  await pair.flushPermissionRequest();
  await rejectionPromise;
});

test("JSON-RPC PermissionGate 复用同一会话的精确审批", async () => {
  const pair = createConnectionPair();
  const gate = new JsonRpcPermissionGate(pair.server);
  let requestCount = 0;

  pair.client.onRequest(
    "tool/request-permission",
    () => {
      requestCount += 1;
      return { decision: "allow", scope: "session" };
    },
  );

  const scopedRequest = {
    ...permissionRequest,
    description: "执行敏感财务汇总操作",
    riskLevel: "sensitive" as const,
  };
  const firstDecision = gate.request(scopedRequest);
  await pair.flushPermissionRequest();

  assert.deepEqual(await firstDecision, {
    decision: "allow",
    scope: "session",
  });
  assert.deepEqual(await gate.request({
    ...scopedRequest,
    callId: "call-2",
  }), {
    decision: "allow",
    scope: "session",
  });
  assert.equal(requestCount, 1);
  assert.equal(pair.serverToClient.length, 0);
});

test("访问模式只自动放行对应风险等级，敏感操作始终审批", () => {
  assert.equal(shouldAutomaticallyAllowTool("read_only", { toolName: "run_command", riskLevel: "execute" }), false);
  assert.equal(shouldAutomaticallyAllowTool("workspace", { toolName: "run_command", riskLevel: "execute" }), true);
  assert.equal(shouldAutomaticallyAllowTool("workspace", { toolName: "mcp__server__write", riskLevel: "execute" }), false);
  assert.equal(shouldAutomaticallyAllowTool("full_access", { toolName: "mcp__server__write", riskLevel: "execute" }), true);
  for (const mode of ["read_only", "workspace", "full_access"] as const) {
    assert.equal(shouldAutomaticallyAllowTool(mode, { toolName: "dangerous_tool", riskLevel: "sensitive" }), false);
    assert.equal(shouldAutomaticallyAllowTool(mode, { toolName: "read_file", riskLevel: "read" }), true);
  }
});

test("PermissionGate 根据同一 Job 快照为父子 Agent 解析访问模式", async () => {
  const pair = createConnectionPair();
  const jobModes = new Map([["job-1", "full_access" as const]]);
  const gate = new JsonRpcPermissionGate(pair.server, {
    resolveAccessMode: (request) => request.jobId === undefined ? undefined : jobModes.get(request.jobId),
  });
  const parent = gate.request({ ...permissionRequest, jobId: "job-1", agentId: "parent", riskLevel: "execute" });
  const child = gate.request({ ...permissionRequest, callId: "call-2", jobId: "job-1", agentId: "child", riskLevel: "execute" });
  assert.deepEqual(await parent, { decision: "allow" });
  assert.deepEqual(await child, { decision: "allow" });
  assert.equal(pair.serverToClient.length, 0);
});

test("只读与敏感操作仍发送审批请求", async () => {
  const pair = createConnectionPair();
  const gate = new JsonRpcPermissionGate(pair.server, {
    resolveAccessMode: () => "read_only",
  });
  pair.client.onRequest("tool/request-permission", () => ({ decision: "deny" }));
  const executeDecision = gate.request({ ...permissionRequest, riskLevel: "execute" });
  await pair.flushPermissionRequest();
  assert.deepEqual(await executeDecision, { decision: "deny" });

  const fullGate = new JsonRpcPermissionGate(pair.server, {
    resolveAccessMode: () => "full_access",
  });
  const sensitiveDecision = fullGate.request({ ...permissionRequest, callId: "call-sensitive", riskLevel: "sensitive" });
  await pair.flushPermissionRequest();
  assert.deepEqual(await sensitiveDecision, { decision: "deny" });
});
