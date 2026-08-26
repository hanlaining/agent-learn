import assert from "node:assert/strict";
import test from "node:test";

import type { AgentEvent } from "../src/agent/events.js";
import type { RuntimeCapabilities } from "../src/app-server/runtime-capabilities.js";
import { DesktopController, type DesktopRuntimeClient } from "../src/electron/desktop-controller.js";
import type { DesktopAgentConfig, DesktopMessageInput } from "../src/electron/desktop-types.js";
import type { Item, Thread, Turn } from "../src/runtime/lifecycle.js";

const now = "2026-08-24T00:00:00.000Z";

class CoverageRuntime implements DesktopRuntimeClient {
  readonly listeners = new Set<(event: AgentEvent) => void>();
  readonly saved: DesktopAgentConfig[] = [];
  readonly threads: Thread[] = [
    { id:"thread-older", title:"Older", status:"active", createdAt:"2026-08-20T00:00:00.000Z", turnIds:[] },
    { id:"thread-main", status:"active", createdAt:"2026-08-24T00:00:00.000Z", turnIds:["turn-old"] },
  ];
  runMode: "events" | "failure" | "cancelled" = "events";
  cancelFails = false;
  closed = false;
  lastAdvance: unknown;
  lastConfirm: unknown;
  private turnSequence = 1;

  async listThreads() { return structuredClone(this.threads); }
  async startThread() {
    const thread: Thread = { id:`thread-new-${this.threads.length}`, status:"active", createdAt:now, turnIds:[] };
    this.threads.push(thread); return structuredClone(thread);
  }
  async renameThread(threadId: string, title: string) { const thread=this.threads.find((x)=>x.id===threadId)!; thread.title=title; return structuredClone(thread); }
  async softDeleteThreads(threadIds: string[]) { return this.threads.filter((x)=>threadIds.includes(x.id)); }
  async restoreThread(threadId: string) { return structuredClone(this.threads.find((x)=>x.id===threadId)!); }
  async listTrash() { return [{ id:"trash",status:"closed",createdAt:now,turnIds:[],deletedAt:now,trashExpiresAt:now,deleteBatchId:"batch" } as unknown as Thread]; }
  async getAgentRuntime() { return { tasks:[],edges:[],evidence:[],board:[],returns:[] }; }
  async advanceFixedProduct(threadId: string, expectedStage: any) { this.lastAdvance={threadId,expectedStage}; return {}; }
  async getRequirement() { return { id:"req-1",threadId:"thread-main",status:"planned",revision:2,planArtifact:{contentHash:"hash"} } as any; }
  async confirmRequirement(requirementId: string, revision: number, contentHash: string) { this.lastConfirm={requirementId,revision,contentHash}; return {} as any; }
  async readThreadHistory(threadId: string) {
    const thread = this.threads.find((x)=>x.id===threadId) ?? { id:threadId,status:"active",createdAt:now,turnIds:[] } as Thread;
    return { thread:structuredClone(thread), messages: threadId === "thread-main" ? [
      {id:"m1",turnId:"turn-old",role:"assistant" as const,text:"assistant first",createdAt:now},
      {id:"m2",turnId:"turn-old",role:"user" as const,text:"这是一个超过四十二字符的标题用于覆盖截断逻辑abcdefghijklmnopqrstuvwxyz",createdAt:now},
    ] : [] };
  }
  async getCapabilities(): Promise<RuntimeCapabilities> { return {
    llm:true,currentModel:"model-a",models:[
      {id:"model-a",label:"A",reasoningEfforts:["low"]},
      {id:"model-b",label:"B",reasoningEfforts:["medium","high"]},
      {id:"model-c",label:"C"},
    ],webSearch:true,tools:[],skills:[{name:"skill-a",description:"a"}],mcpServers:[],agents:[{id:"orchestrator",name:"Agent",description:"a"}],multiAgent:{maxConcurrentRuns:4,maxDepth:2,maxChildrenPerRun:3},
  }; }
  async searchWorkspaceFiles(query: string) { return {query,paths:[],truncated:false}; }
  async selectModel() { return this.getCapabilities(); }
  async startTurn(threadId: string, input: string, _context: Omit<DesktopMessageInput,"text"> = {}) {
    const turnId=`turn-${this.turnSequence++}`;
    const turn: Turn={id:turnId,threadId,status:"in_progress",createdAt:now,itemIds:[`user-${turnId}`]};
    const userMessage: Item={id:`user-${turnId}`,threadId,turnId,type:"user_message",content:{text:input},createdAt:now};
    return {turn,userMessage};
  }
  async runTurn(turnId: string) {
    if (this.runMode === "failure") throw new Error("private failure");
    this.emit({type:"model/started",turnId,round:0});
    this.emit({type:"reasoning/summary_part_added",turnId,round:0,summaryIndex:0});
    this.emit({type:"reasoning/summary_delta",turnId,round:0,summaryIndex:0,delta:"reason"});
    this.emit({type:"reasoning/summary_completed",turnId,round:0});
    this.emit({type:"context/compacted",turnId,beforeTokens:10,afterTokens:5});
    this.emit({type:"web_search/started",turnId,callId:"search"});
    this.emit({type:"web_search/searching",turnId,callId:"search"});
    this.emit({type:"web_search/completed",turnId,callId:"search",query:"query"});
    this.emit({type:"web_search/completed",turnId,callId:"search-2"});
    this.emit({type:"citation/url_added",turnId,title:"source",url:"https://example.com",startIndex:0,endIndex:1});
    this.emit({type:"permission/requested",turnId,callId:"call",toolName:"read"});
    this.emit({type:"permission/decided",turnId,callId:"call",toolName:"read",decision:"deny"});
    this.emit({type:"tool/started",turnId,callId:"call",toolName:"read"});
    this.emit({type:"tool/completed",turnId,callId:"call",toolName:"read"});
    this.emit({type:"model/output_text_delta",turnId,round:0,delta:"part1"});
    this.emit({type:"model/output_text_delta",turnId,round:0,delta:"part2"});
    this.emit({type:"model/output_text_completed",turnId,round:0,classification:"commentary",text:"part1part2"});
    this.emit({type:"model/completed",turnId,round:0,functionCallCount:1});
    if (this.runMode === "cancelled") {
      this.emit({type:"turn/interrupted",turnId,message:"private"}); throw new Error("cancelled");
    }
    this.emit({type:"model/started",turnId,round:1});
    this.emit({type:"model/output_text_completed",turnId,round:1,classification:"assistant",text:"done"});
    this.emit({type:"model/completed",turnId,round:1,functionCallCount:0});
    this.emit({type:"turn/completed",turnId});
    const threadId=this.threads.at(-1)?.id ?? "thread-main";
    const assistantMessage: Item={id:`assistant-${turnId}`,threadId,turnId,type:"assistant_message",content:{text:"done"},createdAt:now};
    const turn: Turn={id:turnId,threadId,status:"completed",createdAt:now,completedAt:now,itemIds:[assistantMessage.id]};
    return {turn,assistantMessage};
  }
  async listAgentRuns() { return [
    {id:"root",jobId:"job",rootRunId:"root",attempt:1,threadId:"thread-main",turnId:"turn-persist",agentProfileId:"orchestrator",status:"running",task:"root",depth:0},
    {id:"child",jobId:"job",rootRunId:"root",attempt:1,taskId:"task",threadId:"thread-child",turnId:"turn-child",agentProfileId:"worker",parentRunId:"root",status:"failed",coordinationStatus:"blocked",attentionLevel:"critical",statusMessage:"help",failureOrigin:"tool",task:"child",depth:1,result:{safeError:"safe"}},
    {id:"other",jobId:"other",rootRunId:"other",attempt:1,threadId:"other",turnId:"other",agentProfileId:"worker",status:"queued",task:"other",depth:0},
  ] as any; }
  async getThreadConfig(threadId: string) { return threadId === "thread-main" ? {model:"model-b",reasoningEffort:"medium",agentProfileId:"orchestrator"} as DesktopAgentConfig : undefined; }
  async setThreadConfig(_threadId: string, config: DesktopAgentConfig) { this.saved.push(structuredClone(config)); }
  async listRuntimeSessions() { return [{threadId:"thread-main",turnState:"thinking" as const,session:{turnId:"turn-persist",status:"running" as const,startedAt:now,items:[{id:"r",turnId:"turn-persist",kind:"reasoning_summary" as const,round:3,summaryIndex:0,status:"streaming" as const,markdown:"old"}]}}]; }
  async listOutcomeUnknown() { return []; }
  async resolveOutcomeUnknown(input: any) { return input; }
  async setRuntimeSession() { /* persistence is asserted indirectly through emitted sessions */ }
  async cancelTurn(turnId: string) { if(this.cancelFails) throw new Error("race"); return {turnId,cancelled:true as const}; }
  onAgentEvent(listener: (event: AgentEvent)=>void) { this.listeners.add(listener); return ()=>this.listeners.delete(listener); }
  async close() { this.closed=true; }
  emit(event: AgentEvent) { for(const listener of this.listeners) listener(event); }
}

test("DesktopController 覆盖持久快照、管理操作、配置边界与子 Agent 选择", async () => {
  const runtime=new CoverageRuntime();
  const controller=new DesktopController(runtime);
  const events: any[]=[]; const remove=controller.onEvent((event)=>events.push(event));
  const snapshot=await controller.getSnapshot();
  assert.equal(snapshot.activeThreadId,"thread-main");
  assert.equal(snapshot.turnState,"idle");
  assert.equal(snapshot.runtimeSession?.status,"interrupted");
  assert.equal(snapshot.threads[0]?.title.endsWith("…"),true);
  assert.equal(snapshot.trash?.[0]?.title,"未命名 Chat");
  assert.equal(snapshot.agentRuns.length,2);
  assert.equal(snapshot.agentRuntime?.tasks.length,0);
  assert.equal(snapshot.requirement?.status,"planned");

  assert.equal((await controller.selectReasoningEffort("high")).agentConfig.reasoningEffort,"high");
  await assert.rejects(()=>controller.selectReasoningEffort("ultra"),/Unsupported/);
  assert.equal((await controller.selectModel("model-a")).agentConfig.reasoningEffort,"low");
  assert.equal((await controller.selectModel("model-c")).agentConfig.model,"model-c");
  await assert.rejects(()=>controller.selectModel("missing"),/Unsupported/);
  await assert.rejects(()=>controller.selectModelSettings({model:"model-a",reasoningEffort:"medium"}),/Unsupported/);
  await assert.rejects(()=>controller.selectModelSettings({model:"model-c",reasoningEffort:"bogus" as any}),/Unsupported/);
  assert.equal((await controller.updateAgentTeam({maxConcurrent:2})).agentConfig.agentTeam?.maxConcurrent,2);

  assert.equal((await controller.renameThread("thread-main","Renamed")).threads.some((x)=>x.title==="Renamed"),true);
  await controller.restoreThread("thread-main");
  await assert.rejects(()=>controller.selectThread(""),/required/);
  await assert.rejects(()=>controller.selectThread("missing"),/unavailable/);
  await controller.selectThread("thread-main");
  assert.equal((await controller.selectAgentThread("thread-child")).activeAgentThreadId,"thread-child");
  await controller.selectAgentThread();
  await assert.rejects(()=>controller.selectAgentThread("missing-child"),/不属于/);
  await controller.advanceFixedProduct("implemented" as any);
  assert.ok(runtime.lastAdvance);
  assert.deepEqual(await controller.searchWorkspaceFiles(""),{query:"",paths:[],truncated:false});
  await assert.rejects(()=>controller.searchWorkspaceFiles("x".repeat(241)),/Invalid/);
  assert.deepEqual(controller.getPermissionContext("unknown"),{agentName:"Agent"});

  runtime.emit({type:"agent/run_updated",threadId:"thread-main",turnId:"turn-agent",run:{id:"live",jobId:"job",rootRunId:"root",attempt:2,taskId:"task",threadId:"thread-child",turnId:"turn-agent",agentProfileId:"researcher",parentRunId:"root",status:"failed",coordinationStatus:"blocked",attentionLevel:"critical",statusMessage:"help",failureOrigin:"tool",task:"research",depth:1,result:{safeError:"safe"},createdAt:now,updatedAt:now} as any});
  assert.deepEqual(controller.getPermissionContext("turn-agent"),{threadId:"thread-main",agentName:"researcher"});
  remove();
  assert.ok(events.some((event)=>event.type==="agent/run_updated"));
});

test("DesktopController 通过完整事件序列形成可审计 RuntimeSession", async () => {
  const runtime=new CoverageRuntime();
  runtime.threads.splice(0,1);
  const controller=new DesktopController(runtime);
  await controller.getSnapshot();
  const events:any[]=[]; controller.onEvent((event)=>events.push(event));
  const result=await controller.sendMessage({text:"  first message  ",mentions:[{kind:"file",path:"a.ts"}],explicitSkills:["skill-a"]});
  assert.match(result.turnId,/turn-/);
  assert.ok(events.some((event)=>event.type==="source/added"));
  assert.ok(events.some((event)=>event.type==="activity/upsert" && event.activity.status==="denied"));
  const sessions=events.filter((event)=>event.type==="runtime/session");
  assert.equal(sessions.at(-1).session.status,"completed");
  assert.ok(sessions.at(-1).session.items.some((item:any)=>item.kind==="commentary"));
  assert.ok(events.some((event)=>event.type==="assistant/completed" && event.text==="done"));

  await assert.rejects(()=>controller.sendMessage("   "),/请输入任务内容/);
  await assert.rejects(()=>controller.sendMessage(42 as any),/消息必须是文本/);
  await assert.rejects(()=>controller.sendMessage({text:"x",mentions:Array.from({length:21},(_,index)=>({kind:"file" as const,path:`a-${index}`}))}),/Invalid/);
  await assert.rejects(()=>controller.sendMessage({text:"x",explicitSkills:["missing"]}),/Invalid/);
  assert.equal(await controller.cancelTurn(),true);
  runtime.cancelFails=true;
  assert.equal(await controller.cancelTurn(),false);
  await controller.close();
  assert.equal(runtime.closed,true);
});

test("DesktopController 草稿、删除、缺失能力与安全失败分支", async () => {
  const runtime=new CoverageRuntime();
  const controller=new DesktopController(runtime);
  await controller.getSnapshot();
  const draft=await controller.createThread();
  assert.equal(draft.activeThreadId,undefined);
  await assert.rejects(()=>controller.advanceFixedProduct("implemented" as any),/当前没有/);
  await assert.rejects(()=>controller.selectAgentThread("child"),/请先选择/);
  const sent=await controller.sendMessage("draft first");
  assert.match(sent.turnId,/turn-/);
  assert.ok(runtime.saved.length>0);
  await controller.softDeleteThreads([runtime.threads.at(-1)!.id],"batch");

  const unavailable=new DesktopController({
    ...runtime,
    onAgentEvent: runtime.onAgentEvent.bind(runtime),listThreads:runtime.listThreads.bind(runtime),startThread:runtime.startThread.bind(runtime),
    readThreadHistory:runtime.readThreadHistory.bind(runtime),getCapabilities:runtime.getCapabilities.bind(runtime),selectModel:runtime.selectModel.bind(runtime),
    startTurn:runtime.startTurn.bind(runtime),runTurn:runtime.runTurn.bind(runtime),listAgentRuns:runtime.listAgentRuns.bind(runtime),getThreadConfig:runtime.getThreadConfig.bind(runtime),setThreadConfig:runtime.setThreadConfig.bind(runtime),listRuntimeSessions:runtime.listRuntimeSessions.bind(runtime),setRuntimeSession:runtime.setRuntimeSession.bind(runtime),cancelTurn:runtime.cancelTurn.bind(runtime),close:runtime.close.bind(runtime),
  } as DesktopRuntimeClient);
  await unavailable.getSnapshot();
  await assert.rejects(()=>unavailable.renameThread("x","x"),/unavailable/);
  await assert.rejects(()=>unavailable.softDeleteThreads(["x"],"b"),/unavailable/);
  await assert.rejects(()=>unavailable.restoreThread("x"),/unavailable/);
  await assert.rejects(()=>unavailable.resolveOutcomeUnknown({} as any),/unavailable/);
  await assert.rejects(()=>unavailable.searchWorkspaceFiles("x"),/unavailable/);
  await assert.rejects(()=>unavailable.confirmRequirement(),/没有可确认/);

  const failing=new CoverageRuntime(); failing.runMode="failure";
  const failureController=new DesktopController(failing); await failureController.getSnapshot();
  const failureEvents:any[]=[]; failureController.onEvent((event)=>failureEvents.push(event));
  await assert.rejects(()=>failureController.sendMessage("fail"),/Agent 执行失败/);
  assert.ok(failureEvents.some((event)=>event.type==="turn/state" && event.state==="failed"));

  const cancelled=new CoverageRuntime(); cancelled.runMode="cancelled";
  const cancelledController=new DesktopController(cancelled); await cancelledController.getSnapshot();
  assert.match((await cancelledController.sendMessage("cancel")).turnId,/turn-/);
});

test("DesktopController 需求确认、设计确认和设计反馈只使用当前 revision 的 artifact", async () => {
  const runtime = new CoverageRuntime();
  let requirement: any = {
    id: "req-1", threadId: "thread-main", status: "planned", revision: 2,
    planArtifact: { contentHash: "plan-hash" },
    designStatus: "draft_ready",
    designArtifact: { contentHash: "design-hash", path: "design.md", generatedAt: now },
  };
  runtime.getRequirement = async () => structuredClone(requirement);
  runtime.confirmRequirement = async (id: string, revision: number, hash: string) => {
    assert.deepEqual({ id, revision, hash }, { id: "req-1", revision: 2, hash: "plan-hash" });
    requirement.status = "confirmed";
    return structuredClone(requirement);
  };
  (runtime as any).confirmDesign = async (id: string, revision: number, hash: string) => {
    assert.deepEqual({ id, revision, hash }, { id: "req-1", revision: 2, hash: "design-hash" });
    requirement.designStatus = "confirmed";
    return structuredClone(requirement);
  };
  (runtime as any).submitDesignFeedback = async (id: string, feedback: string) => {
    assert.equal(id, "req-1");
    assert.equal(feedback, "把错误态写清楚");
    requirement.designStatus = "draft_ready";
  };
  const controller = new DesktopController(runtime);
  await controller.getSnapshot();
  const confirmed = await controller.confirmRequirement();
  assert.match(confirmed.turnId, /turn-/);

  requirement.status = "confirmed";
  await assert.rejects(() => controller.confirmRequirement(), /无需确认/);
  const design = await controller.confirmDesign();
  assert.equal(design.requirement?.designStatus, "confirmed");
  requirement.designStatus = "draft_ready";
  await controller.submitDesignFeedback("把错误态写清楚");
  requirement.designStatus = "confirmed";
  await assert.rejects(() => controller.submitDesignFeedback("late"), /尚未就绪/);
});

test("DesktopController 在同一 Chat 已运行时拒绝第二条消息并等待首轮收敛", async () => {
  const runtime = new CoverageRuntime();
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const originalRun = runtime.runTurn.bind(runtime);
  (runtime as any).runTurn = async (turnId: string) => {
    notifyStarted();
    await gate;
    return originalRun(turnId);
  };
  const controller = new DesktopController(runtime);
  await controller.getSnapshot();
  const first = controller.sendMessage("first");
  await started;
  await assert.rejects(() => controller.sendMessage("second"), /仍在运行/);
  release();
  await first;
});
