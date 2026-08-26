import assert from "node:assert/strict";
import test from "node:test";

import { AppServerClient } from "../src/electron/app-server-client.js";

const fakeServer = String.raw`
const readline = require('node:readline');
const thread = { id:'thread-1', status:'active', createdAt:'2026-01-01T00:00:00.000Z', turnIds:[] };
const capabilities = { llm:true, currentModel:'model-a', models:[{id:'model-a',label:'Model A',reasoningEfforts:['high']}], webSearch:false, tools:[], skills:[], mcpServers:[] };
const outcome = { resolutionId:'resolution-1', invocationKind:'tool', invocationId:'inv-1', requestDigest:'sha256:'+'d'.repeat(64), identity:{threadId:'thread-1',turnId:'turn-1',displayName:'tool',toolName:'write',callId:'call-1'}, sideEffectRisk:'possible', state:'outcome_unknown', version:1, unknownReasonCode:'unknown', createdAt:'2026-01-01T00:00:00.000Z', updatedAt:'2026-01-01T00:00:00.000Z', audit:[] };
function send(value){ process.stdout.write(JSON.stringify(value)+'\n'); }
readline.createInterface({input:process.stdin}).on('line', line => {
  const m=JSON.parse(line); if (!('id' in m)) {
    if(m.method==='initialized') {
      process.stderr.write('diagnostic-only');
      send({method:'agent/event',params:{type:'model/started',turnId:'turn-1',round:0}});
      send({method:'agent/event',params:{type:'bad-event'}});
      send({id:'permission-1',method:'tool/request-permission',params:{turnId:'turn-1',callId:'call-1',toolName:'read_file',riskLevel:'read'}});
    }
    return;
  }
  let result;
  switch(m.method){
    case 'initialize': result={serverName:'agent-app-server',protocolVersion:1,capabilities:{}}; break;
    case 'thread/list': result=[thread]; break;
    case 'thread/start': case 'thread/rename': case 'thread/restore': result=thread; break;
    case 'thread/soft-delete': case 'thread/trash/list': result=[thread]; break;
    case 'agent/runtime': result={tasks:[]}; break;
    case 'agent/fixed-product/advance': result={stage:'implemented'}; break;
    case 'requirement/get': result=null; break;
    case 'requirement/confirm': result={id:'req-1'}; break;
    case 'thread/history': result={thread,messages:[]}; break;
    case 'runtime/capabilities': case 'runtime/select-model': result=capabilities; break;
    case 'workspace/search-files': result={query:m.params.query,paths:['src/a.ts'],truncated:false}; break;
    case 'invocation/outcome-unknown/list': case 'invocation/outcome-unknown/resolve': result=[outcome]; if(m.method.endsWith('resolve')) result=outcome; break;
    case 'agent-run/list': result=[]; break;
    case 'thread/config/get': result={model:'model-a',reasoningEffort:'high',agentProfileId:'orchestrator'}; break;
    case 'thread/config/set': case 'runtime-session/set': result=null; break;
    case 'runtime-session/list': result=[]; break;
    case 'turn/start': { const turn={id:'turn-1',threadId:'thread-1',status:'in_progress',createdAt:'2026-01-01T00:00:00.000Z',itemIds:['item-user']}; result={turn,userMessage:{id:'item-user',threadId:'thread-1',turnId:'turn-1',type:'user_message',content:{text:'hi'},createdAt:turn.createdAt}}; break; }
    case 'turn/run': { const turn={id:'turn-1',threadId:'thread-1',status:'completed',createdAt:'2026-01-01T00:00:00.000Z',completedAt:'2026-01-01T00:01:00.000Z',itemIds:['item-assistant']}; result={turn,assistantMessage:{id:'item-assistant',threadId:'thread-1',turnId:'turn-1',type:'assistant_message',content:{text:'done'},createdAt:turn.completedAt}}; break; }
    case 'turn/cancel': result={turnId:'turn-1',cancelled:true}; break;
    default: result={echo:m.params};
  }
  send({id:m.id,result});
});
`;

function client(script = fakeServer, options: { handshakeTimeoutMs?: number; shutdownTimeoutMs?: number } = {}) {
  return new AppServerClient({
    command: process.execPath,
    args: ["-e", script],
    cwd: process.cwd(),
    env: process.env,
    ...options,
  });
}

test("AppServerClient 的公开 RPC 正常路径全部经过真实 JSON-RPC 子进程", async (t) => {
  const diagnostics: string[] = [];
  const events: unknown[] = [];
  const permissions: unknown[] = [];
  const statuses: string[] = [];
  const value = new AppServerClient({
    command: process.execPath, args: ["-e", fakeServer], cwd: process.cwd(), env: process.env,
    onDiagnostic: (message) => diagnostics.push(message),
    onPermissionRequest: async (request) => { permissions.push(request); return { decision: "allow", scope: "once" }; },
  });
  t.after(() => value.close());
  const removeStatus = value.onStatusChange((status) => statuses.push(status.state));
  const removeEvent = value.onAgentEvent((event) => events.push(event));
  assert.equal(value.getStatus().state, "closed");
  await assert.rejects(() => value.listThreads(), /not connected/);
  const firstStart = value.start();
  assert.equal(value.start(), firstStart);
  assert.equal((await firstStart).state, "connected");
  assert.ok(value.getChildPid());

  assert.equal((await value.listThreads()).length, 1);
  assert.equal((await value.startThread()).id, "thread-1");
  assert.equal((await value.renameThread("thread-1", "new")).id, "thread-1");
  assert.equal((await value.softDeleteThreads(["thread-1"], "batch")).length, 1);
  assert.equal((await value.restoreThread("thread-1")).id, "thread-1");
  assert.equal((await value.listTrash()).length, 1);
  assert.deepEqual(await value.getAgentRuntime("thread-1"), { tasks: [] });
  assert.deepEqual(await value.advanceFixedProduct("thread-1", "completed"), { stage: "implemented" });
  assert.equal(await value.getRequirement("thread-1"), undefined);
  assert.deepEqual(await value.confirmRequirement("req-1", 1, "hash"), { id: "req-1" });
  assert.equal((await value.readThreadHistory("thread-1")).thread.id, "thread-1");
  assert.equal((await value.getCapabilities()).currentModel, "model-a");
  assert.deepEqual(await value.searchWorkspaceFiles("a"), { query: "a", paths: ["src/a.ts"], truncated: false });
  assert.equal((await value.listOutcomeUnknown())[0]?.resolutionId, "resolution-1");
  assert.equal((await value.listOutcomeUnknown("thread-1"))[0]?.resolutionId, "resolution-1");
  assert.equal((await value.resolveOutcomeUnknown({ resolutionId:"resolution-1", expectedVersion:1, idempotencyKey:"key", resolution:{action:"abandon",reason:"done"} })).state, "outcome_unknown");
  assert.deepEqual(await value.listAgentRuns(), []);
  assert.deepEqual(await value.listAgentRuns("thread-1"), []);
  assert.equal((await value.getThreadConfig("thread-1"))?.model, "model-a");
  await value.setThreadConfig("thread-1", { model:"model-a",reasoningEffort:"high",agentProfileId:"orchestrator" });
  assert.deepEqual(await value.listRuntimeSessions(), []);
  await value.setRuntimeSession("thread-1", "idle", { turnId:"turn-1", status:"completed", startedAt:"2026-01-01T00:00:00.000Z", completedAt:"2026-01-01T00:01:00.000Z", items:[] });
  assert.equal((await value.selectModel("model-a")).currentModel, "model-a");
  assert.equal((await value.startTurn("thread-1", "hi")).turn.id, "turn-1");
  assert.equal((await value.runTurn("turn-1", { model:"model-a",reasoningEffort:"high" })).assistantMessage.type, "assistant_message");
  assert.equal((await value.cancelTurn("turn-1")).cancelled, true);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(statuses.slice(0, 2), ["connecting", "connected"]);
  assert.equal(events.length, 1);
  assert.equal(permissions.length, 1);
  assert.match(diagnostics.join(""), /diagnostic-only/);
  removeStatus(); removeEvent();
  const close = value.close();
  assert.equal(value.close(), close);
  await close;
  assert.equal(value.getStatus().state, "closed");
});

test("AppServerClient 将启动、握手和响应异常固定映射为安全失败", async (t) => {
  const missing = client("", { handshakeTimeoutMs: 30, shutdownTimeoutMs: 20 });
  t.after(() => missing.close());
  assert.equal((await missing.start()).state, "failed");

  const malformed = client("process.stdout.write('not-json\\n')", { handshakeTimeoutMs: 100, shutdownTimeoutMs: 20 });
  t.after(() => malformed.close());
  assert.equal((await malformed.start()).state, "failed");

  const invalidInit = client(String.raw`const r=require('node:readline').createInterface({input:process.stdin});r.on('line',l=>{const m=JSON.parse(l);if(m.id)process.stdout.write(JSON.stringify({id:m.id,result:{serverName:'wrong'}})+'\n')})`, { handshakeTimeoutMs: 100, shutdownTimeoutMs: 20 });
  t.after(() => invalidInit.close());
  assert.equal((await invalidInit.start()).state, "failed");

  const notFound = new AppServerClient({ command: "definitely-not-a-real-command-coverage", args: [], cwd: process.cwd(), env: process.env, handshakeTimeoutMs: 30 });
  t.after(() => notFound.close());
  assert.equal((await notFound.start()).state, "failed");
});

test("AppServerClient 拒绝服务端给出的非法业务响应", async (t) => {
  const invalidServer = fakeServer.replace("let result;", "let result; if(m.method !== 'initialize') { send({id:m.id,result:{bad:true}}); return; }");
  const value = client(invalidServer);
  t.after(() => value.close());
  assert.equal((await value.start()).state, "connected");
  const calls: Array<() => Promise<unknown>> = [
    () => value.listThreads(), () => value.startThread(), () => value.renameThread("x","y"),
    () => value.softDeleteThreads(["x"],"b"), () => value.restoreThread("x"), () => value.listTrash(),
    () => value.readThreadHistory("x"), () => value.getCapabilities(), () => value.searchWorkspaceFiles("x"),
    () => value.listOutcomeUnknown(), () => value.resolveOutcomeUnknown({resolutionId:"x",expectedVersion:1,idempotencyKey:"k",resolution:{action:"abandon",reason:"x"}}),
    () => value.listAgentRuns(), () => value.getThreadConfig("x"), () => value.listRuntimeSessions(),
    () => value.selectModel("x"), () => value.startTurn("x","x"), () => value.runTurn("x"), () => value.cancelTurn("x"),
  ];
  for (const call of calls) await assert.rejects(call, /Invalid/);
});
