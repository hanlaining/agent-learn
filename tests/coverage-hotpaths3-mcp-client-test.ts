import assert from "node:assert/strict";
import test from "node:test";

import { McpStdioClient } from "../src/mcp/stdio-mcp-client.js";

const serverScript=String.raw`
const readline=require('node:readline'); const mode=process.argv[1]; let toolCallCount=0;
const tool=(name)=>({name,inputSchema:{type:'object',properties:{}}});
function send(value){process.stdout.write(JSON.stringify(value)+'\n');}
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); if(!('id' in m)) return;
	 if(m.method==='server/discover'){
	   if(mode==='legacy') return send({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Method not found'}});
	   if(mode==='unsupported') return send({jsonrpc:'2.0',id:m.id,result:{supportedVersions:['2099-01-01'],capabilities:{tools:{}},serverInfo:{name:'future',version:'1'}}});
	   if(mode==='discovery-timeout') return;
	   if(mode==='bad-discovery') return send({jsonrpc:'2.0',id:m.id,result:{supportedVersions:[],capabilities:{}}});
	   send({jsonrpc:'2.0',method:'server/log',params:{level:'info'}});
   send({jsonrpc:'2.0',id:'reverse-1',method:'sampling/createMessage',params:{}});
   send({jsonrpc:'2.0',id:m.id,result:{supportedVersions:['2026-07-28'],capabilities:mode==='no-tools'?{}:{tools:{}},instructions:'coverage server'}});
	   if(mode==='exit-after-discover') setTimeout(()=>process.exit(0),10); return;
	 }
	 if(m.method==='initialize' && mode==='legacy') return send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'legacy-server',version:'1.0.0'},instructions:'legacy coverage'}});
	 if(m.method==='tools/list'){
	   if(mode==='bad-list') return send({jsonrpc:'2.0',id:m.id,result:{tools:'not-an-array'}});
	   if(mode==='bad-jsonrpc') return send({jsonrpc:'1.0',id:m.id,result:{tools:[]}});
	   if(mode==='unknown-response'){ send({jsonrpc:'2.0',id:'unknown-list-id',result:{tools:[]}}); return send({jsonrpc:'2.0',id:m.id,result:{tools:[]}}); }
   const cursor=m.params.cursor;
   if(mode==='duplicate-pages') return send({jsonrpc:'2.0',id:m.id,result:cursor?{tools:[tool('same')]}:{tools:[tool('same')],nextCursor:'next'}});
   if(mode==='repeat-cursor') return send({jsonrpc:'2.0',id:m.id,result:{tools:[tool(cursor?'b':'a')],nextCursor:'same'}});
   if(mode==='empty-cursor') return send({jsonrpc:'2.0',id:m.id,result:{tools:[tool('a')],nextCursor:''}});
   return send({jsonrpc:'2.0',id:m.id,result:{tools:[tool('ok')]}});
 }
	 if(m.method==='tools/call'){
	   if(mode==='remote-error') return send({jsonrpc:'2.0',id:m.id,error:{code:-32001,message:'tool backend failed',data:{retryable:true}}});
	   if(mode==='bad-call') return send({jsonrpc:'2.0',id:m.id,result:{content:[{type:''}]}});
	   if(mode==='slow-call') { const delay=toolCallCount++===0?300:0; return setTimeout(()=>send({jsonrpc:'2.0',id:m.id,result:{content:[],structuredContent:{ok:true},isError:false}}),delay); }
	   return send({jsonrpc:'2.0',id:m.id,result:{content:[],structuredContent:{ok:true},isError:false}});
	 }
});
`;

function options(mode:string, extra: { requestTimeoutMs?: number; discoveryTimeoutMs?: number } = {}) {
  return { command: process.execPath, args: ["-e", serverScript, mode], requestTimeoutMs: 1_000, ...extra };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test("MCP Client 校验启动选项并保持 discovery 防御性拷贝", async (t) => {
  await assert.rejects(()=>McpStdioClient.start({command:" "}),/command must not be empty/);
  await assert.rejects(()=>McpStdioClient.start({command:process.execPath,args:[1 as unknown as string]}),/args must contain only strings/);
  await assert.rejects(()=>McpStdioClient.start({command:process.execPath,requestTimeoutMs:0}),/positive integer/);
  await assert.rejects(()=>McpStdioClient.start({command:process.execPath,requestTimeoutMs:1.5}),/positive integer/);
  const client=await McpStdioClient.start(options("happy")); t.after(()=>client.close());
  const first=client.discovery; first.supportedVersions.push("mutated"); first.capabilities.changed=true;
  assert.deepEqual(client.discovery,{supportedVersions:["2026-07-28"],capabilities:{tools:{}},instructions:"coverage server"});
});

test("MCP Client 拒绝无 Tool 能力、空 Tool 名和预先中止的调用", async (t) => {
  const noTools=await McpStdioClient.start(options("no-tools")); t.after(()=>noTools.close());
  await assert.rejects(()=>noTools.listTools(),/does not advertise tools/);
  const client=await McpStdioClient.start(options("happy")); t.after(()=>client.close());
  await assert.rejects(()=>client.callTool("   ",{}),/name must not be empty/);
  const controller=new AbortController(); controller.abort("stop");
  await assert.rejects(()=>client.callTool("ok",{},controller.signal),/MCP request aborted/);
  assert.deepEqual((await client.callTool("ok",{})).structuredContent,{ok:true});
  await client.close(); await client.close();
  await assert.rejects(()=>client.listTools(),/Client is closed/);
});

test("MCP Client 全量分页拒绝跨页重名、重复与空 cursor", async (t) => {
  for(const [mode,expected] of [
    ["duplicate-pages",/Duplicate MCP Tool name across pages/],
    ["repeat-cursor",/Invalid repeated MCP tools\/list cursor/],
    ["empty-cursor",/Invalid repeated MCP tools\/list cursor/],
  ] as const){
    const client=await McpStdioClient.start(options(mode)); t.after(()=>client.close());
    await assert.rejects(()=>client.listAllTools(),expected);
  }
});

test("MCP Server 意外退出后 Client fail closed", async () => {
  const client=await McpStdioClient.start(options("exit-after-discover"));
  const deadline=Date.now()+2_000; while(!client.isClosed&&Date.now()<deadline) await new Promise((resolve)=>setTimeout(resolve,10));
  assert.equal(client.isClosed,true);
  await assert.rejects(()=>client.listTools(),/closed/);
});

test("MCP Client 回退 legacy initialize 并固定 2025-11-25 协议版本", async (t) => {
  const client = await McpStdioClient.start(options("legacy"));
  t.after(() => client.close());
  assert.equal(client.protocolVersion, "2025-11-25");
  assert.deepEqual(client.discovery, {
    supportedVersions: ["2025-11-25"],
    capabilities: { tools: {} },
    instructions: "legacy coverage",
  });
  assert.equal((await client.listTools()).tools[0]?.name, "ok");
});

test("MCP Client 拒绝不支持首选协议、畸形 discovery 与 discovery 超时", async () => {
  await assert.rejects(() => McpStdioClient.start(options("unsupported")), /does not support protocol/);
  await assert.rejects(() => McpStdioClient.start(options("bad-discovery")), /Invalid MCP server\/discover result/);
  await assert.rejects(() => McpStdioClient.start(options("discovery-timeout", { discoveryTimeoutMs: 20 })), /timed out: server\/discover/);
});

test("MCP request timeout 发出取消通知，迟到响应被忽略且连接可继续使用", async (t) => {
  const client = await McpStdioClient.start(options("slow-call", { requestTimeoutMs: 100 }));
  t.after(() => client.close());
  await assert.rejects(() => client.callTool("ok", {}), /timed out: tools\/call/);
  await delay(350);
  assert.equal(client.isClosed, false);
  assert.deepEqual((await client.callTool("ok", {})).structuredContent, { ok: true });
});

test("MCP 主动 Abort 只拒绝当前请求，迟到响应不关闭 Client", async (t) => {
  const client = await McpStdioClient.start(options("slow-call", { requestTimeoutMs: 1_000 }));
  t.after(() => client.close());
  const controller = new AbortController();
  const pending = client.callTool("ok", {}, controller.signal);
  await delay(10);
  controller.abort("user-cancelled");
  await assert.rejects(pending, /MCP request aborted/);
  await delay(150);
  assert.equal(client.isClosed, false);
  assert.deepEqual((await client.callTool("ok", {})).structuredContent, { ok: true });
});

test("MCP close 竞态拒绝 pending request 并保持幂等 closed", async (t) => {
  const client = await McpStdioClient.start(options("slow-call", { requestTimeoutMs: 1_000 }));
  t.after(() => client.close());
  const pending = client.callTool("ok", {});
  const rejected = assert.rejects(pending, /Client closed/);
  await delay(10);
  await client.close();
  await rejected;
  assert.equal(client.isClosed, true);
  await client.close();
});

test("MCP 无效 JSON-RPC 版本 fail closed，未知 response id 也不被静默吞掉", async (t) => {
  const malformed = await McpStdioClient.start(options("bad-jsonrpc"));
  await assert.rejects(() => malformed.listTools(), /jsonrpc must be 2\.0/);
  assert.equal(malformed.isClosed, true);
  t.after(() => malformed.close());

  const unknown = await McpStdioClient.start(options("unknown-response"));
  await assert.rejects(() => unknown.listTools(), /Unknown MCP response id/);
  assert.equal(unknown.isClosed, true);
  t.after(() => unknown.close());
});

test("MCP tools/list 畸形结果只拒绝本次解析，不伪造 Tool 或关闭连接", async (t) => {
  const client = await McpStdioClient.start(options("bad-list"));
  t.after(() => client.close());
  await assert.rejects(() => client.listTools(), /Invalid MCP tools\/list result/);
  assert.equal(client.isClosed, false);
});

test("MCP tools/call 畸形 content 在契约边界拒绝且 transport 保持 open", async (t) => {
  const client = await McpStdioClient.start(options("bad-call"));
  t.after(() => client.close());
  await assert.rejects(() => client.callTool("ok", {}), /Invalid MCP content block/);
  assert.equal(client.isClosed, false);
});

test("MCP remote tools/call error 保留服务端错误语义并允许关闭", async (t) => {
  const client = await McpStdioClient.start(options("remote-error"));
  t.after(() => client.close());
  await assert.rejects(() => client.callTool("ok", {}), /tool backend failed/);
  assert.equal(client.isClosed, false);
});

test("MCP 启动命令 spawn 失败时 fail closed，不泄露环境并可重复捕获错误", async () => {
  await assert.rejects(() => McpStdioClient.start({ command: "definitely-command-does-not-exist-rt95" }), /ENOENT|spawn/);
});
