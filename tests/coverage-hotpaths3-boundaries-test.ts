import assert from "node:assert/strict";
import test from "node:test";

import type { DesktopEvent } from "../src/electron/desktop-types.js";
import { coalesceDesktopEvents, getActivityGroupStatus, isRuntimeItemAnimated, parseSafeInline } from "../src/electron/renderer/runtime-ui.js";
import { ExecutionLeaseCoordinator, ExecutionLeaseUnavailableError, type ExecutionLeaseStore } from "../src/runtime/execution-lease-coordinator.js";
import { RuntimeLeaseConflictError, type RuntimeLease } from "../src/runtime/runtime-lease.js";
import type { RuntimeContent, RuntimeSession } from "../src/runtime/runtime-session.js";
import { createWorkspaceTools } from "../src/tools/workspace-tools.js";
import type { WorkspaceSandbox } from "../src/sandbox/workspace-sandbox.js";

const timestamp="2026-08-24T00:00:00.000Z";
function lease(ownerId="owner",version=1): RuntimeLease { return {resource:{type:"job",id:"job"},ownerId,leaseVersion:version,fencingToken:1,expiresAt:"2026-08-24T00:01:00.000Z"}; }

test("Workspace Tools 的权限摘要和参数边界在调用 Sandbox 前 fail closed", async () => {
  const calls: string[]=[];
  const sandbox={
    listFiles:async(path:string)=>{calls.push(`list:${path}`);return {path,entries:[],truncated:false};},
    readTextFile:async(path:string)=>{calls.push(`read:${path}`);return {path,text:"ok",sizeBytes:2};},
    writeTextFile:async(path:string,text:string)=>{calls.push(`write:${path}:${text}`);return {path,sizeBytes:text.length};},
  } as unknown as WorkspaceSandbox;
  const tools=createWorkspaceTools(sandbox);
  const list=tools.find((item)=>item.definition.name==="list_files")!;
  const read=tools.find((item)=>item.definition.name==="read_file")!;
  const write=tools.find((item)=>item.definition.name==="write_file")!;
  assert.equal(list.describePermission?.('{"path":"."}'),"列出 Workspace 目录：.");
  assert.equal(read.describePermission?.('{"path":"a.txt"}'),"读取 Workspace 文件：a.txt");
  assert.equal(write.describePermission?.('{"path":"b.txt","text":"x"}'),"写入 Workspace 文件：b.txt");
  const context={signal:new AbortController().signal};
  assert.deepEqual((await list.execute('{"path":"."}',context)).result,{path:".",entries:[],truncated:false});
  assert.deepEqual((await read.execute('{"path":"a.txt"}',context)).result,{path:"a.txt",text:"ok",sizeBytes:2});
  assert.deepEqual((await write.execute('{"path":"b.txt","text":"x"}',context)).result,{path:"b.txt",sizeBytes:1});
  assert.deepEqual(calls,["list:.","read:a.txt","write:b.txt:x"]);
  for(const [tool,input,expected] of [
    [read,"[]",/must be an object/], [read,'{"path":"a","extra":1}',/unknown fields/],
    [read,'{"path":""}',/non-empty string/], [read,'{"path":3}',/non-empty string/],
    [write,'{"path":"a","text":3}',/text must be a string/],
  ] as const) await assert.rejects(async()=>tool.execute(input,context),expected);
});

test("Runtime UI 合并同帧增量、替换 Session，并拒绝危险链接", () => {
  const session=(turnId:string,markdown:string): RuntimeSession=>({turnId,status:"running",startedAt:timestamp,items:[{id:"p",turnId,kind:"pending_output",round:0,status:"streaming",markdown}]});
  const events: DesktopEvent[]=[
    {type:"assistant/delta",threadId:"thread",turnId:"turn",delta:"a"},
    {type:"assistant/delta",threadId:"thread",turnId:"turn",delta:"b"},
    {type:"reasoning/delta",threadId:"thread",turnId:"turn",summaryIndex:0,delta:"r1"},
    {type:"reasoning/delta",threadId:"other",turnId:"turn",summaryIndex:0,delta:"r2"},
    {type:"runtime/session",threadId:"thread",session:session("turn","old")},
    {type:"turn/state",threadId:"thread",turnId:"turn",state:"thinking"},
    {type:"runtime/session",threadId:"thread",session:session("turn","new")},
  ];
  const merged=coalesceDesktopEvents(events);
  assert.equal(merged.find((item)=>item.type==="assistant/delta")?.type==="assistant/delta" ? merged.find((item)=>item.type==="assistant/delta")!.delta : undefined,"ab");
  assert.equal(merged.find((item)=>item.type==="reasoning/delta")?.type==="reasoning/delta" ? merged.find((item)=>item.type==="reasoning/delta")!.delta : undefined,"r1r2");
  assert.equal(merged.filter((item)=>item.type==="runtime/session").length,1);
  const latest=merged.at(-1);
  assert.equal((latest?.type==="runtime/session" ? latest.session.items[0] : undefined)?.kind,"pending_output");
  const tokens=parseSafeInline("[ok](https://example.com/a) [auth](https://u:p@example.com) [js](javascript:alert) [bad](://)");
  assert.equal(tokens.filter((item)=>item.kind==="link"&&item.href!==undefined).length,1);
  const running:RuntimeSession={turnId:"t",status:"running",startedAt:timestamp,items:[]};
  const reasoning:RuntimeContent={id:"r",turnId:"t",kind:"reasoning_summary",round:0,summaryIndex:0,status:"streaming",markdown:"x"};
  const pending:RuntimeContent={id:"p",turnId:"t",kind:"pending_output",round:0,status:"streaming",markdown:"x"};
  const done:RuntimeContent={id:"d",turnId:"t",kind:"activity",activityKind:"read",round:0,status:"completed",title:"done"};
  assert.equal(isRuntimeItemAnimated(running,reasoning),true); assert.equal(isRuntimeItemAnimated(running,pending),true); assert.equal(isRuntimeItemAnimated(running,done),false);
  assert.equal(getActivityGroupStatus({kind:"activity_group",id:"g",round:0,activities:[{...done,status:"failed"}]}),"failed");
  assert.equal(getActivityGroupStatus({kind:"activity_group",id:"g",round:0,activities:[{...done,status:"cancelled"}]}),"cancelled");
});

test("ExecutionLeaseCoordinator 校验配置、等待语义、重试延迟和清理错误", async () => {
  const noop:ExecutionLeaseStore={acquire:async()=>lease(),renew:async(value)=>value,release:async()=>1,withFencedCommit:async(value,commit)=>commit(value.fencingToken)};
  for(const options of [
    {ownerId:" "},{ttlMs:0},{ttlMs:Number.MAX_SAFE_INTEGER+1},{ttlMs:10,renewIntervalMs:10},{maxAcquireAttempts:0},{maxRenewals:-1},{maxReleaseAttempts:0},
  ]) assert.throws(()=>new ExecutionLeaseCoordinator(noop,options),/must|less than/);
  const coordinator=new ExecutionLeaseCoordinator(noop,{ownerId:"owner",ttlMs:100,renewIntervalMs:50,maxRenewals:0});
  assert.equal(await coordinator.withActiveFencedCommit("runtime_state",(token)=>token),undefined);
  await assert.rejects(()=>coordinator.renewActiveLease(),/No active/);
  await assert.rejects(()=>coordinator.runWithJobLease("",async()=>undefined),/must not be empty/);

  const waitingStore:ExecutionLeaseStore={...noop,acquire:async()=>{throw new RuntimeLeaseConflictError("lease_held","held");}};
  const waiting=new ExecutionLeaseCoordinator(waitingStore,{ownerId:"wait",ttlMs:100,renewIntervalMs:50,maxRenewals:0});
  assert.equal((await waiting.runWithJobLease("job",async()=>assert.fail())).status,"waiting");
  await assert.rejects(()=>waiting.withJob("job",async()=>undefined),(error)=>error instanceof ExecutionLeaseUnavailableError&&error.jobId==="job");

  const badAcquireDelay=new ExecutionLeaseCoordinator(waitingStore,{ownerId:"wait",ttlMs:100,renewIntervalMs:50,maxAcquireAttempts:2,acquireRetryDelayMs:()=>-1,maxRenewals:0});
  await assert.rejects(()=>badAcquireDelay.runWithJobLease("job",async()=>undefined),/non-negative finite/);

  let releases=0;
  const releaseStore:ExecutionLeaseStore={...noop,release:async()=>{releases+=1;throw new Error("release failed");}};
  const badReleaseDelay=new ExecutionLeaseCoordinator(releaseStore,{ownerId:"release",ttlMs:100,renewIntervalMs:50,maxRenewals:0,maxReleaseAttempts:2,releaseRetryDelayMs:()=>Number.NaN});
  await assert.rejects(()=>badReleaseDelay.runWithJobLease("job",async()=>"done"),/non-negative finite/);
  assert.equal(releases,1);
});

test("ExecutionLeaseCoordinator 合并并发获取、支持嵌套同 Job 和续租", async () => {
  let allowAcquire!: () => void;
  const acquireGate = new Promise<void>((resolve) => { allowAcquire = resolve; });
  let renewals = 0;
  let commits = 0;
  const store: ExecutionLeaseStore = {
    acquire: async () => { await acquireGate; return lease("owner", 1); },
    renew: async (current) => { renewals += 1; return { ...current, leaseVersion: current.leaseVersion + 1, fencingToken: current.fencingToken + 1 }; },
    release: async () => 1,
    withFencedCommit: async (current, commit) => { commits += 1; return commit(current.fencingToken); },
  };
  const coordinator = new ExecutionLeaseCoordinator(store, { ownerId: "owner", ttlMs: 100, renewIntervalMs: 50, maxRenewals: 2 });
  let finishOwner!: () => void;
  const ownerGate = new Promise<void>((resolve) => { finishOwner = resolve; });
  const owner = coordinator.runWithJobLease("job", async (context) => {
    assert.equal(context.resource.id, "job");
    await coordinator.renewActiveLease();
    await coordinator.withRequiredActiveFencedCommit("runtime_state", (token) => token);
    await coordinator.runWithJobLease("job", async (nested) => nested.fencingToken);
    await assert.rejects(() => coordinator.runWithJobLease("other-job", async () => undefined), /different Jobs/);
    await ownerGate;
    return "owner";
  });
  const joined = coordinator.runWithJobLease("job", async () => "joined");
  allowAcquire();
  const joinedResult = await joined;
  assert.equal(joinedResult.status, "acquired");
  if (joinedResult.status === "acquired") assert.equal(joinedResult.value, "joined");
  finishOwner();
  const ownerResult = await owner;
  assert.equal(ownerResult.status, "acquired");
  if (ownerResult.status === "acquired") assert.equal(ownerResult.value, "owner");
  assert.equal(renewals, 1);
  assert.equal(commits, 1);
  await assert.rejects(() => coordinator.withRequiredActiveFencedCommit("runtime_state", () => 1), /No active execution lease/);
  assert.equal(await coordinator.withActiveFencedCommit("runtime_state", () => 7), 7);
});
