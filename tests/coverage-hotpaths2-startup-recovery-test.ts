import assert from "node:assert/strict";
import test from "node:test";

import { LifecycleStore } from "../src/runtime/lifecycle-store.js";
import { createModelRequestDigest, type ModelInvocationStatus } from "../src/runtime/model-invocation.js";
import { ModelInvocationStore } from "../src/runtime/model-invocation-store.js";
import { ModelInvocationStartupRecovery } from "../src/runtime/model-invocation-startup-recovery.js";
import { createToolArgumentsDigest } from "../src/runtime/tool-invocation.js";
import { ToolInvocationStore } from "../src/runtime/tool-invocation-store.js";

function interrupted(suffix: string, assistant = false) {
  const lifecycleStore = new LifecycleStore({ now:()=>"2026-08-24T00:00:00.000Z" });
  const thread=lifecycleStore.createThread(); const turn=lifecycleStore.createTurn(thread.id);
  lifecycleStore.appendItem(turn.id,"user_message",{text:suffix});
  if(assistant) lifecycleStore.appendItem(turn.id,"assistant_message",{text:"already durable"});
  lifecycleStore.interruptTurn(turn.id);
  return {lifecycleStore,turn};
}

function invocation(turnId: string, input: {status: ModelInvocationStatus; purpose?: string; text?: string; calls?: Array<{callId:string;name:string;arguments:string}>; target?: string}) {
  const store=new ModelInvocationStore(()=>"2026-08-24T00:00:00.000Z");
  const prepared=store.prepare({threadId:`thread-${turnId}`,turnId,round:0,purpose:input.purpose??"turn",requestDigest:createModelRequestDigest({turnId}),provider:"test",model:"test",...(input.target===undefined?{}:{targetCommitKey:input.target})});
  if(input.status==="prepared") return {store,prepared};
  store.markSubmitted(prepared.invocationId);
  if(input.status==="submitted") return {store,prepared};
  if(input.status==="outcome_unknown") { store.markOutcomeUnknown(prepared.invocationId); return {store,prepared}; }
  if(input.status==="failed_retryable"||input.status==="failed_terminal") { store.markFailed(prepared.invocationId,input.status,"failed"); return {store,prepared}; }
  store.recordResponse(prepared.invocationId,{providerResponseId:"response",normalizedResult:{text:input.text??"done",functionCalls:input.calls??[]}});
  if(input.status==="committed") store.markCommitted(prepared.invocationId,input.target);
  return {store,prepared};
}

async function action(input: {status: ModelInvocationStatus; purpose?: string; text?: string; calls?: Array<{callId:string;name:string;arguments:string}>; target?: string; assistant?: boolean; canReplay?: boolean; tools?: ToolInvocationStore}) {
  const life=interrupted(input.status,input.assistant); const model=invocation(life.turn.id,input);
  let persisted=0;
  const recovery=new ModelInvocationStartupRecovery({lifecycleStore:life.lifecycleStore,modelInvocationStore:model.store,persist:()=>{persisted+=1;},...(input.canReplay===undefined?{}:{canReplayTurn:()=>input.canReplay!}),...(input.tools===undefined?{}:{toolInvocationStore:input.tools})});
  return {result:await recovery.recoverTurn(life.turn.id),persisted,life,model,recovery};
}

test("启动恢复穷举基础状态并保持同 Turn 去重", async () => {
  const emptyLife=new LifecycleStore(); const emptyRecovery=new ModelInvocationStartupRecovery({lifecycleStore:emptyLife,modelInvocationStore:new ModelInvocationStore(),persist:()=>{}});
  assert.equal((await emptyRecovery.recover(["missing","missing"]))[0]?.diagnosticCode,"turn_not_found");

  const noInvocation=interrupted("none");
  assert.equal((await new ModelInvocationStartupRecovery({lifecycleStore:noInvocation.lifecycleStore,modelInvocationStore:new ModelInvocationStore(),persist:()=>{}}).recoverTurn(noInvocation.turn.id)).diagnosticCode,"invocation_not_found");

  assert.equal((await action({status:"submitted"})).result.diagnosticCode,"submitted_outcome_unknown");
  assert.equal((await action({status:"outcome_unknown"})).result.diagnosticCode,"outcome_unknown_requires_explicit_resolution");
  assert.equal((await action({status:"prepared"})).result.diagnosticCode,"startup_recovery_blocked_prepared");
  assert.equal((await action({status:"failed_retryable"})).result.diagnosticCode,"startup_recovery_blocked_failed_retryable");
  assert.equal((await action({status:"failed_terminal"})).result.diagnosticCode,"startup_recovery_blocked_failed_terminal");
  assert.equal((await action({status:"response_received",canReplay:false})).result.diagnosticCode,"turn_owned_by_execution_recovery");
  assert.equal((await action({status:"response_received",purpose:"compaction"})).result.diagnosticCode,"explicit_resume_required");
  assert.equal((await action({status:"response_received",text:""})).result.diagnosticCode,"response_received_has_no_assistant_text");

  const concurrent=await action({status:"response_received",text:"replay"});
  assert.equal(concurrent.result.action,"replayed_response");
  assert.equal(concurrent.life.lifecycleStore.getTurn(concurrent.life.turn.id)?.status,"completed");
});

test("提交态恢复只补终态，并拒绝缺失 assistant 或非 assistant commit", async () => {
  const good=await action({status:"committed",assistant:true});
  // targetCommitKey 未指向 assistant 时必须显式恢复。
  assert.equal(good.result.diagnosticCode,"explicit_resume_required");
  const targetLife=interrupted("committed",true);
  const target=`turn:${targetLife.turn.id}:assistant`;
  const targetInvocation=invocation(targetLife.turn.id,{status:"committed",target});
  let persisted=0;
  const recovery=new ModelInvocationStartupRecovery({lifecycleStore:targetLife.lifecycleStore,modelInvocationStore:targetInvocation.store,persist:()=>{persisted+=1;}});
  assert.equal((await recovery.recoverTurn(targetLife.turn.id)).action,"completed_turn");
  assert.equal(persisted,1);

  const missing=interrupted("missing-assistant"); const missingTarget=`turn:${missing.turn.id}:assistant`;
  const missingInvocation=invocation(missing.turn.id,{status:"committed",target:missingTarget});
  assert.equal((await new ModelInvocationStartupRecovery({lifecycleStore:missing.lifecycleStore,modelInvocationStore:missingInvocation.store,persist:()=>{}}).recoverTurn(missing.turn.id)).diagnosticCode,"committed_assistant_item_missing");
});

test("工具型响应依据 Tool WAL 的每个耐久状态决定恢复动作", async () => {
  const call={callId:"call-1",name:"write",arguments:'{"x":1}'};
  assert.equal((await action({status:"response_received",calls:[call]})).result.diagnosticCode,"response_received_requires_tool_wal");

  const missingTools=new ToolInvocationStore();
  assert.equal((await action({status:"response_received",calls:[call],tools:missingTools})).result.diagnosticCode,"tool_invocation_missing");

  for(const toolStatus of ["prepared","executing","outcome_unknown","result_received"] as const){
    const life=interrupted(`tool-${toolStatus}`); const model=invocation(life.turn.id,{status:"response_received",calls:[call]});
    const modelId=model.prepared.invocationId;
    const tools=new ToolInvocationStore(()=>"2026-08-24T00:00:00.000Z");
    const prepared=tools.prepare({modelInvocationId:modelId,callId:call.callId,toolName:call.name,argumentsDigest:createToolArgumentsDigest(call.arguments)});
    if(toolStatus!=="prepared") tools.markExecuting(prepared.toolInvocationId);
    if(toolStatus==="outcome_unknown") tools.markOutcomeUnknown(prepared.toolInvocationId);
    if(toolStatus==="result_received") tools.recordResult(prepared.toolInvocationId,{result:{ok:true},output:"ok"});
    let persisted=0;
    const result=await new ModelInvocationStartupRecovery({lifecycleStore:life.lifecycleStore,modelInvocationStore:model.store,toolInvocationStore:tools,persist:()=>{persisted+=1;}}).recoverTurn(life.turn.id);
    const expected=toolStatus==="prepared"?"tool_invocation_not_executed":toolStatus==="result_received"?"explicit_resume_required":"tool_invocation_outcome_unknown";
    assert.equal(result.diagnosticCode,expected);
    if(toolStatus==="executing") assert.equal(persisted,1);
  }
});
