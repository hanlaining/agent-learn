import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  CliAgentEventRenderer,
  extractReasoningHeader,
  formatReasoningSummary,
} from "../src/cli/main.js";
import { intersectCapabilities, replaceArrayContents } from "../src/app-server/handlers.js";
import type { AgentEvent } from "../src/agent/events.js";

function environment(statePath: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    AGENT_STATE_PATH: statePath,
    AGENT_SKILLS_PATH: join(dirname(statePath), "skills"),
  };
  for (const name of ["PATH","Path","PATHEXT","SystemRoot","SYSTEMROOT","TEMP","TMP"]) {
    if (process.env[name] !== undefined) result[name]=process.env[name];
  }
  return result;
}

function startCli(env: NodeJS.ProcessEnv, args: string[] = []) {
  const child=spawn(process.execPath,["--import","tsx","src/cli/main.ts",...args],{cwd:process.cwd(),env,stdio:["pipe","pipe","pipe"],windowsHide:true});
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  let stdout=""; let stderr="";
  child.stdout.on("data",(chunk:string)=>{stdout+=chunk;}); child.stderr.on("data",(chunk:string)=>{stderr+=chunk;});
  return {child,stdout:()=>stdout,stderr:()=>stderr,exit:new Promise<number|null>((resolve,reject)=>{child.once("error",reject);child.once("exit",resolve);})};
}

async function waitFor(cli: ReturnType<typeof startCli>, value: string): Promise<void> {
  const deadline=Date.now()+10_000;
  while(!cli.stdout().includes(value) && !cli.stderr().includes(value)) {
    if(Date.now()>deadline){cli.child.kill();throw new Error(`CLI timeout waiting for ${value}\nstdout=${cli.stdout()}\nstderr=${cli.stderr()}`);}
    await new Promise((resolve)=>setTimeout(resolve,10));
  }
}

async function tempState(t: test.TestContext): Promise<string> {
  const directory=await mkdtemp(join(tmpdir(),"god-cli-coverage3-"));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  return join(directory,"state.json");
}

test("CLI 直接入口覆盖 help、version 与未知选项的可观察退出契约", async (t) => {
  const state=await tempState(t);
  for(const [args,code,expected] of [
    [["--help"],0,/Usage:/], [["--version"],0,/god-agent 1\.0\.0/], [["--bad-option"],1,/Unknown option/],
  ] as const){
    const cli=startCli(environment(state),[...args]);
    assert.equal(await cli.exit,code,cli.stderr());
    assert.match(cli.stdout()+cli.stderr(),expected);
  }
});

test("CLI 空闲命令、未知命令与离线 Provider 失败后仍可继续交互并安全退出", async (t) => {
  const cli=startCli(environment(await tempState(t)));
  await waitFor(cli,"god-agent 已启动");
  cli.child.stdin.write("\n/cancel\n/not-a-command\n离线调用\n");
  await waitFor(cli,"本轮结束");
  cli.child.stdin.end("/status\n/threads\n/exit\n");
  assert.equal(await cli.exit,0,cli.stderr());
  assert.match(cli.stdout(),/当前没有正在运行的 Turn/);
  assert.match(cli.stdout(),/未知命令：\/not-a-command/);
  assert.match(cli.stdout()+cli.stderr(),/本轮结束/);
  assert.match(cli.stdout(),/Turn：idle/);
  assert.match(cli.stdout(),/已保存的 Thread/);
});

test("CLI 运行中展示状态、限制命令、排队消息并允许取消", async (t) => {
  const server=createServer((request,response)=>{request.resume(); response.on("close",()=>undefined);});
  const baseUrl=await listen(server); t.after(()=>close(server));
  const cli=startCli({...environment(await tempState(t)),OPENAI_API_KEY:"test-key",OPENAI_BASE_URL:baseUrl});
  await waitFor(cli,"god-agent 已启动");
  cli.child.stdin.write("保持运行\n"); await waitFor(cli,"Thinking…");
  cli.child.stdin.write("/status\n/help\n排队消息\n/cancel\n");
  await waitFor(cli,"Turn 已取消");
  cli.child.stdin.end("/exit\n");
  assert.equal(await cli.exit,0,cli.stderr());
  assert.match(cli.stdout(),/Turn：turn-.*\(running\)/);
  assert.match(cli.stdout(),/Turn 运行期间可使用/);
  assert.match(cli.stdout(),/消息已进入队列/);
  assert.match(cli.stdout(),/已请求取消 Turn/);
});

test("CLI 运行中直接退出会等待原 Turn 完成而不读取已清空状态", async (t) => {
  const server=createServer((request,response)=>{request.resume(); response.on("close",()=>undefined);});
  const baseUrl=await listen(server); t.after(()=>close(server));
  const cli=startCli({...environment(await tempState(t)),OPENAI_API_KEY:"test-key",OPENAI_BASE_URL:baseUrl});
  await waitFor(cli,"god-agent 已启动");
  cli.child.stdin.write("保持运行后退出\n"); await waitFor(cli,"Thinking…");
  cli.child.stdin.end("/exit\n");
  assert.equal(await cli.exit,0,cli.stderr());
  assert.match(cli.stdout(),/已请求取消 Turn/);
  assert.doesNotMatch(cli.stderr(),/reading 'completion'/);
});

test("CLI debug 模式逐类渲染公开推理、搜索、引用和 Assistant 流", async (t) => {
  const server=createServer((request,response)=>{
    request.resume(); response.writeHead(200,{"content-type":"text/event-stream"});
    response.end([
      'event: response.created\ndata: {"type":"response.created","response":{"id":"response-debug"}}',
      'event: response.reasoning_summary_part.added\ndata: {"type":"response.reasoning_summary_part.added","summary_index":0}',
      'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","summary_index":0,"delta":"**Debug reasoning**\\nbody"}',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"reasoning","summary":[{"type":"summary_text","text":"**Debug reasoning**\\nbody"}]}}',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"id":"search-1","type":"web_search_call","status":"in_progress"}}',
      'event: response.web_search_call.searching\ndata: {"type":"response.web_search_call.searching","item_id":"search-1"}',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"id":"search-1","type":"web_search_call","status":"completed","action":{"type":"search","query":"coverage query"}}}',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"debug answer"}',
      'event: response.output_text.annotation.added\ndata: {"type":"response.output_text.annotation.added","annotation":{"type":"url_citation","start_index":0,"end_index":5,"title":"Source","url":"https://example.com/source"}}',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"debug answer"}]}}',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"response-debug"}}', "",
    ].join("\n\n"));
  });
  const baseUrl=await listen(server); t.after(()=>close(server));
  const cli=startCli({...environment(await tempState(t)),OPENAI_API_KEY:"test-key",OPENAI_BASE_URL:baseUrl},["--debug"]);
  await waitFor(cli,"god-agent 已启动"); cli.child.stdin.write("debug request\n");
  await waitFor(cli,"[Turn] completed"); cli.child.stdin.end("/exit\n");
  assert.equal(await cli.exit,0,cli.stderr());
  const output=cli.stdout();
  assert.match(output,/Turn 已创建/); assert.match(output,/\[Model\] round 1 started/);
  assert.match(output,/\[Reasoning summary\]/); assert.match(output,/\[Web Search\] started/);
  assert.match(output,/\[Web Search\] completed/); assert.match(output,/\[Assistant\]\s*debug answer/);
  assert.match(output,/\[Citation\] Source https:\/\/example\.com\/source/);
});

test("CLI 非 debug Renderer 覆盖摘要、工具、权限、取消、超时和引用去重", () => {
  const renderer = new CliAgentEventRenderer(false);
  renderer.beginTurn();
  const events: AgentEvent[] = [
    { type: "turn/started", threadId: "thread", turnId: "turn" },
    { type: "model/started", turnId: "turn", round: 0 },
    { type: "reasoning/summary_part_added", turnId: "turn", round: 0, summaryIndex: 0 },
    { type: "reasoning/summary_delta", turnId: "turn", round: 0, summaryIndex: 0, delta: "**检查**\n正文" },
    { type: "reasoning/summary_delta", turnId: "turn", round: 0, summaryIndex: 0, delta: "\n续行" },
    { type: "reasoning/summary_completed", turnId: "turn", round: 0 },
    { type: "web_search/started", turnId: "turn", callId: "search" },
    { type: "web_search/searching", turnId: "turn", callId: "search" },
    { type: "web_search/completed", turnId: "turn", callId: "search" },
    { type: "citation/url_added", turnId: "turn", title: "", url: "https://example.test/a", startIndex: 0, endIndex: 1 },
    { type: "citation/url_added", turnId: "turn", title: "重复", url: "https://example.test/a", startIndex: 0, endIndex: 1 },
    { type: "model/output_text_delta", turnId: "turn", round: 0, delta: "答案" },
    { type: "model/output_text_completed", turnId: "turn", round: 0, classification: "assistant", text: "答案" },
    { type: "model/completed", turnId: "turn", round: 0, functionCallCount: 0 },
    { type: "permission/requested", turnId: "turn", callId: "call", toolName: "write_file" },
    { type: "permission/decided", turnId: "turn", callId: "call", toolName: "write_file", decision: "deny", reason: "拒绝" },
    { type: "tool/started", turnId: "turn", callId: "call", toolName: "write_file" },
    { type: "tool/completed", turnId: "turn", callId: "call", toolName: "write_file" },
    { type: "turn/interrupted", turnId: "turn", message: "取消" },
    { type: "turn/timed_out", turnId: "turn", message: "超时" },
    { type: "turn/failed", turnId: "turn", message: "失败" },
  ];
  for (const event of events) renderer.render(event);
  renderer.beginTurn();
  assert.equal(renderer.receivedAssistantDelta, false);
});

function captureRendererOutput(run: () => void): string {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write;
  const originalLog = console.log;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  console.log = (...args: unknown[]) => {
    chunks.push(`${args.map((arg) => String(arg)).join(" ")}\n`);
  };
  try {
    run();
  } finally {
    process.stdout.write = originalWrite;
    console.log = originalLog;
  }
  return chunks.join("");
}

test("CLI Renderer debug context compacted 事件输出 token 变化并关闭流", () => {
  const renderer = new CliAgentEventRenderer(true);
  const output = captureRendererOutput(() => {
    renderer.render({ type: "model/output_text_delta", turnId: "turn", round: 0, delta: "partial" });
    renderer.render({ type: "context/compacted", turnId: "turn", beforeTokens: 900, afterTokens: 300 });
  });
  assert.match(output, /partial/);
  assert.match(output, /\[Context\] compacted 900 → 300 tokens/);
});

test("CLI Renderer 非 debug reasoning header 在首个完整标记出现时只提示一次", () => {
  const renderer = new CliAgentEventRenderer(false);
  const output = captureRendererOutput(() => {
    renderer.render({ type: "reasoning/summary_delta", turnId: "turn", round: 0, summaryIndex: 0, delta: "前导 **计划**" });
    renderer.render({ type: "reasoning/summary_delta", turnId: "turn", round: 0, summaryIndex: 0, delta: "继续" });
  });
  assert.equal((output.match(/Thinking: 计划/g) ?? []).length, 1);
});

test("CLI Renderer reasoning summary 空文本不输出伪摘要，普通正文使用圆点格式", () => {
  assert.equal(formatReasoningSummary("  \n  "), undefined);
  assert.equal(formatReasoningSummary("检查输入\n确认边界"), "• 检查输入\n  确认边界");
  assert.equal(formatReasoningSummary("**结论**"), "• 结论");
  assert.equal(extractReasoningHeader("没有粗体标题"), undefined);
  assert.equal(extractReasoningHeader("**  标题  **"), "标题");
});

test("CLI Renderer 非 debug 搜索完成分支展示 query，并完成 reasoning 流", () => {
  const renderer = new CliAgentEventRenderer(false);
  const output = captureRendererOutput(() => {
    renderer.render({ type: "reasoning/summary_delta", turnId: "turn", round: 0, summaryIndex: 0, delta: "**查找**\n资料" });
    renderer.render({ type: "web_search/started", turnId: "turn", callId: "search" });
    renderer.render({ type: "web_search/completed", turnId: "turn", callId: "search", query: "可靠性" });
  });
  assert.match(output, /• 资料/);
  assert.match(output, /Search ✓ 可靠性/);
});

test("CLI Renderer assistant delta 兜底设置 receivedAssistantDelta 并渲染无标题引用", () => {
  const renderer = new CliAgentEventRenderer(false);
  const output = captureRendererOutput(() => {
    renderer.render({ type: "citation/url_added", turnId: "turn", title: "", url: "https://example.test/no-title", startIndex: 0, endIndex: 1 });
    renderer.render({ type: "model/output_text_delta", turnId: "turn", round: 0, delta: "answer" });
    renderer.render({ type: "model/completed", turnId: "turn", round: 0, functionCallCount: 0 });
  });
  assert.equal(renderer.receivedAssistantDelta, false, "delta alone does not mark completed assistant output");
  assert.match(output, /Assistant › answer/);
  assert.match(output, /• https:\/\/example\.test\/no-title/);
});

test("CLI Renderer assistant output completed 才标记 receivedAssistantDelta 并保留引用去重", () => {
  const renderer = new CliAgentEventRenderer(false);
  const output = captureRendererOutput(() => {
    renderer.render({ type: "model/output_text_delta", turnId: "turn", round: 0, delta: "answer" });
    renderer.render({ type: "model/output_text_completed", turnId: "turn", round: 0, classification: "assistant", text: "answer" });
    renderer.render({ type: "citation/url_added", turnId: "turn", title: "Source", url: "https://example.test/source", startIndex: 0, endIndex: 1 });
    renderer.render({ type: "model/completed", turnId: "turn", round: 0, functionCallCount: 0 });
  });
  assert.equal(renderer.receivedAssistantDelta, true);
  assert.equal((output.match(/https:\/\/example\.test\/source/g) ?? []).length, 1);
});

test("CLI Renderer 有 Tool Function Call 时不提前渲染 citations", () => {
  const renderer = new CliAgentEventRenderer(false);
  const output = captureRendererOutput(() => {
    renderer.render({ type: "citation/url_added", turnId: "turn", title: "Source", url: "https://example.test/tool", startIndex: 0, endIndex: 1 });
    renderer.render({ type: "model/completed", turnId: "turn", round: 0, functionCallCount: 1 });
  });
  assert.doesNotMatch(output, /Sources:/);
});

test("CLI Renderer debug permission 和 Tool 事件按顺序公开", () => {
  const renderer = new CliAgentEventRenderer(true);
  const output = captureRendererOutput(() => {
    renderer.render({ type: "permission/requested", turnId: "turn", callId: "call", toolName: "write_file" });
    renderer.render({ type: "permission/decided", turnId: "turn", callId: "call", toolName: "write_file", decision: "deny", reason: "拒绝" });
    renderer.render({ type: "tool/started", turnId: "turn", callId: "call", toolName: "write_file" });
    renderer.render({ type: "tool/completed", turnId: "turn", callId: "call", toolName: "write_file" });
  });
  assert.match(output, /\[Permission\] requested write_file/);
  assert.match(output, /\[Permission\] deny write_file/);
  assert.match(output, /\[Tool\] started write_file/);
  assert.match(output, /\[Tool\] completed write_file/);
});

test("CLI Renderer interrupted 和 timed_out 会清理 reasoning/citation 状态", () => {
  const renderer = new CliAgentEventRenderer(false);
  const output = captureRendererOutput(() => {
    renderer.render({ type: "reasoning/summary_delta", turnId: "turn", round: 0, summaryIndex: 0, delta: "**旧摘要**\n旧正文" });
    renderer.render({ type: "citation/url_added", turnId: "turn", title: "Old", url: "https://example.test/old", startIndex: 0, endIndex: 1 });
    renderer.render({ type: "turn/interrupted", turnId: "turn", message: "cancelled" });
    renderer.render({ type: "turn/timed_out", turnId: "turn", message: "timeout" });
    renderer.render({ type: "model/completed", turnId: "turn", round: 0, functionCallCount: 0 });
  });
  assert.match(output, /Turn 已取消/);
  assert.match(output, /Turn 已超时/);
  assert.doesNotMatch(output, /Old/);
});

test("CLI Renderer debug failed Turn 输出安全错误文案并关闭流", () => {
  const renderer = new CliAgentEventRenderer(true);
  const output = captureRendererOutput(() => {
    renderer.render({ type: "model/output_text_delta", turnId: "turn", round: 0, delta: "partial" });
    renderer.render({ type: "turn/failed", turnId: "turn", message: "provider unavailable" });
  });
  assert.match(output, /\[Turn\] failed turn: provider unavailable/);
  assert.match(output, /partial/);
});

test("CLI Renderer beginTurn 结束迟到流并清空前一轮 citations", () => {
  const renderer = new CliAgentEventRenderer(false);
  const output = captureRendererOutput(() => {
    renderer.render({ type: "model/output_text_delta", turnId: "old", round: 0, delta: "old answer" });
    renderer.render({ type: "citation/url_added", turnId: "old", title: "Old", url: "https://example.test/old", startIndex: 0, endIndex: 1 });
    renderer.beginTurn();
    renderer.render({ type: "model/output_text_completed", turnId: "new", round: 0, classification: "assistant", text: "new answer" });
    renderer.render({ type: "model/completed", turnId: "new", round: 0, functionCallCount: 0 });
  });
  assert.doesNotMatch(output, /Old/);
  assert.equal(renderer.receivedAssistantDelta, true);
});

test("App Server capability intersection preserves explicit wildcard", () => {
  assert.deepEqual(intersectCapabilities(["*"], ["read", "write"]), ["read", "write"]);
});

test("App Server capability intersection defaults omitted right side to wildcard", () => {
  assert.deepEqual(intersectCapabilities(["read", "write"], undefined), ["read", "write"]);
});

test("App Server capability intersection preserves left order for wildcard right side", () => {
  assert.deepEqual(intersectCapabilities(["write", "read"], ["*"]), ["write", "read"]);
});

test("App Server capability intersection returns only exact shared capabilities", () => {
  assert.deepEqual(intersectCapabilities(["read", "write", "read"], ["write", "execute"]), ["write"]);
});

test("App Server capability intersection returns empty for two empty scopes", () => {
  assert.deepEqual(intersectCapabilities([], []), []);
});

test("App Server capability intersection does not mutate inputs", () => {
  const left = ["read", "write"];
  const right = ["write"];
  assert.deepEqual(intersectCapabilities(left, right), ["write"]);
  assert.deepEqual(left, ["read", "write"]);
  assert.deepEqual(right, ["write"]);
});

test("App Server capability intersection handles left wildcard with omitted right side", () => {
  assert.deepEqual(intersectCapabilities(["*"], undefined), ["*"]);
});

test("App Server capability intersection does not widen an empty right scope", () => {
  assert.deepEqual(intersectCapabilities(["read"], []), []);
});

test("App Server array replacement removes stale entries", () => {
  const target = ["stale-1", "stale-2"];
  replaceArrayContents(target, ["fresh"]);
  assert.deepEqual(target, ["fresh"]);
});

test("App Server array replacement supports clearing persisted collections", () => {
  const target = [{ id: "old" }];
  replaceArrayContents(target, []);
  assert.deepEqual(target, []);
});

test("App Server array replacement copies source values", () => {
  const source = [1, 2];
  const target = [0];
  replaceArrayContents(target, source);
  source.push(3);
  assert.deepEqual(target, [1, 2]);
});

test("App Server array replacement preserves target identity", () => {
  const target = ["old"];
  const identity = target;
  replaceArrayContents(target, ["new"]);
  assert.strictEqual(target, identity);
  assert.deepEqual(identity, ["new"]);
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve)=>server.close(()=>resolve()));
}
