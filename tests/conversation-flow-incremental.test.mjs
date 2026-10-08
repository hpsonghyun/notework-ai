import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeConversationFlow,normalizeConversationFlow,FLOW_LIMITS} from '../src/conversation-flow.mjs';

const MODEL='fixture-incremental-jev',CONTEXT='fixture-current-context',TIME='2026-10-07T02:00:00.000Z';
function messages(count=3){return Array.from({length:count},(_,at)=>at+1).flatMap(turn=>[{id:'u'+turn,role:'user',content:`Research goal ${turn}`,contextKey:CONTEXT},{id:'a'+turn,role:'assistant',content:'PRIVATE_ASSISTANT_TEXT_'+turn,contextKey:CONTEXT,sources:[{path:'Research/source-'+turn+'.md',chunkId:'chunk-'+turn,contentHash:'a'.repeat(64),text:'PRIVATE_VAULT_EXCERPT'}]}]);}
function fixture({choose,onRequest}={}){
  const calls=[];
  const jev={evaluate:async request=>{calls.push(structuredClone({...request,signal:undefined}));onRequest?.(request,calls.length);const answers=Object.fromEntries(Object.entries(request.questions).map(([key,question])=>{
    if(question.type==='noul')return[key,{type:'noul',noul:.8}];
    const choice=choose?.(request,calls.length,key)||(key==='thread'?(Object.keys(question.criteria).find(value=>value.startsWith('thread_'))||'new_topic'):'continue');
    return[key,{type:'choice',choice,confidence:.9,probabilities:Object.fromEntries(Object.keys(question.criteria).map(value=>[value,value===choice?1:0]))}];
  }));return{model:request.model,answers};}};
  const analyze=options=>analyzeConversationFlow({messages:messages(),contextKey:CONTEXT,model:MODEL,jev,consent:true,verified:true,maxTurns:20,clock:()=>new Date(TIME),...options});
  return{calls,analyze};
}

test('automatic extension sends only the new user turn and returns actual new request count',async()=>{
  const f=fixture();const original=messages(3);const previousResult=await f.analyze({messages:original});const newer=messages(4);const before=structuredClone(newer);const oldCalls=f.calls.length;
  const result=await f.analyze({messages:newer,previousResult});
  assert.equal(f.calls.length-oldCalls,1);assert.equal(f.calls.at(-1).state.current.id,'u4');assert.equal(f.calls.at(-1).state.previous.id,'u3');assert.equal(f.calls.at(-1).state.goalAnchors[0].messageId,'u1');
  assert.equal(result.requestCount,1);assert.equal(result.reusedTurns,3);assert.equal(result.analyzedTurns,4);assert.equal(result.totalUserTurns,4);assert.equal(result.omittedUserTurns,0);assert.deepEqual(result.observations.slice(0,3),previousResult.observations);
  assert.deepEqual(normalizeConversationFlow(result,{messages:newer}),result);assert.deepEqual(newer,before);assert(!JSON.stringify(f.calls).includes('PRIVATE_ASSISTANT_TEXT'));assert(!JSON.stringify(f.calls).includes('PRIVATE_VAULT_EXCERPT'));
});

test('same valid messages avoid duplicate analysis with zero calls and normalized truthful counts',async()=>{
  const f=fixture();const current=messages(20);const previousResult=await f.analyze({messages:current});const before=f.calls.length;
  const result=await f.analyze({messages:current,previousResult});assert.equal(f.calls.length,before);assert.equal(result.requestCount,0);assert.equal(result.reusedTurns,20);assert.equal(result.analyzedTurns,20);assert.deepEqual(result.observations,previousResult.observations);assert.deepEqual(normalizeConversationFlow(result,{messages:current}),result);
  const again=await f.analyze({messages:current,previousResult:result});assert.equal(again.requestCount,0);assert.equal(f.calls.length,before);
});

test('full-source digests reject modifications beyond clipped excerpts and require a fresh bounded pass',async()=>{
  const f=fixture();const current=messages(2);current[0].content='Exact visible prefix '.repeat(500)+'original tail';const previousResult=await f.analyze({messages:current});const edited=structuredClone(current);edited[0].content=edited[0].content.replace('original tail','modified tail');const before=f.calls.length;
  assert.equal(previousResult.observations[0].sourceContentHash.length,64);assert(edited[0].content.startsWith(previousResult.observations[0].excerpt));
  const result=await f.analyze({messages:edited,previousResult});assert.equal(f.calls.length-before,2);assert.equal(result.reusedTurns,0);assert.equal(result.requestCount,2);
  assert.throws(()=>normalizeConversationFlow(previousResult,{messages:edited}),{code:'FLOW_INVALID_DATA'});
});

test('changed source references and malformed prior groups never enter an incremental request',async()=>{
  const f=fixture();const current=messages(3);const original=await f.analyze({messages:current});
  for(const modify of [value=>{value.observations[0].sourceRefs[0].path='Research/forged.md';},value=>{value.threads[0].anchorMessageId='u2';},value=>{value.observations[0].excerpt='invented source';},value=>{value.requestCount=19;}]){
    const previousResult=structuredClone(original);modify(previousResult);const before=f.calls.length;const result=await f.analyze({messages:current,previousResult});assert.equal(f.calls.length-before,3);assert.equal(result.reusedTurns,0);
  }
  const edited=structuredClone(current);edited[1].sources[0].contentHash='b'.repeat(64);const before=f.calls.length;const result=await f.analyze({messages:edited,previousResult:original});assert.equal(f.calls.length-before,3);assert.equal(result.reusedTurns,0);
});

test('model or context changes require fresh observations without trusting the prior analysis',async()=>{
  const f=fixture();const prior=await f.analyze();const before=f.calls.length;const modelResult=await f.analyze({model:'other-fixture-model',previousResult:prior});assert.equal(f.calls.length-before,3);assert.equal(modelResult.reusedTurns,0);assert.equal(modelResult.model,'other-fixture-model');
  const newer=messages().map(message=>({...message,contextKey:'new-context'}));const next=f.calls.length;const contextResult=await f.analyze({messages:newer,contextKey:'new-context',previousResult:prior});assert.equal(f.calls.length-next,3);assert.equal(contextResult.reusedTurns,0);
});

test('legacy unclipped turns can be reused but legacy clipped turns cannot attest changed suffixes',async()=>{
  const f=fixture();const short=messages(2);const previousResult=await f.analyze({messages:short});previousResult.observations.forEach(value=>delete value.sourceContentHash);const before=f.calls.length;
  const reused=await f.analyze({messages:short,previousResult});assert.equal(reused.requestCount,0);assert.equal(f.calls.length,before);
  const long=messages(1);long[0].content='long user content '.repeat(500);const clipped=await f.analyze({messages:long});delete clipped.observations[0].sourceContentHash;const next=f.calls.length;const result=await f.analyze({messages:long,previousResult:clipped});assert.equal(result.requestCount,1);assert.equal(f.calls.length-next,1);assert.equal(result.reusedTurns,0);
});

test('a shifted 20-turn window falls back when its quoted original goal anchor was omitted',async()=>{
  const f=fixture();const previousResult=await f.analyze({messages:messages(20)});const before=f.calls.length;const result=await f.analyze({messages:messages(21),previousResult});
  assert.equal(f.calls.length-before,20);assert.equal(result.requestCount,20);assert.equal(result.reusedTurns,0);assert.equal(result.analyzedTurns,20);assert.equal(result.omittedUserTurns,1);assert.equal(result.observations[0].messageId,'u2');assert.equal(result.observations[0].transition,'start');assert(f.calls.slice(before).every(request=>request.state.goalAnchors.length<=FLOW_LIMITS.maxAnchors));
});

test('shifted window reuses verified overlap when its goal anchors remain present and new IDs stay unique',async()=>{
  const f=fixture({choose:(request,count,key)=>key==='thread'?(request.state.current.id==='u1'||request.state.current.id==='u2'?'new_topic':request.state.goalAnchors.at(-1)?.id):undefined});
  const previousResult=await f.analyze({messages:messages(20)});assert.equal(previousResult.observations[1].anchorMessageId,'u2');const before=f.calls.length;
  const result=await f.analyze({messages:messages(21),previousResult});assert.equal(f.calls.length-before,1);assert.equal(result.requestCount,1);assert.equal(result.reusedTurns,19);assert.equal(result.analyzedTurns,20);assert.equal(result.omittedUserTurns,1);assert.equal(result.observations[0].messageId,'u2');assert.equal(result.threads[0].anchorMessageId,'u2');assert.equal(result.observations.at(-1).messageId,'u21');assert.equal(new Set(result.observations.map(value=>value.id)).size,20);assert.deepEqual(normalizeConversationFlow(result,{messages:messages(21)}),result);
});

test('request budget is applied to new work while a valid retained window stays complete',async()=>{
  const f=fixture();const previousResult=await f.analyze({messages:messages(8)});const before=f.calls.length;
  const result=await f.analyze({messages:messages(9),previousResult,maxTurns:20,maxRequests:1});assert.equal(f.calls.length-before,1);assert.equal(result.analyzedTurns,9);assert.equal(result.reusedTurns,8);assert.equal(result.requestCount,1);
  const fresh=await f.analyze({messages:messages(12),previousResult:result,maxTurns:20,maxRequests:1});assert.equal(fresh.analyzedTurns,1);assert.equal(fresh.omittedUserTurns,11);assert.equal(fresh.reusedTurns,0);assert.equal(fresh.requestCount,1);
});

test('new goals after a shifted retained group get a distinct thread ID and preserve validated anchors',async()=>{
  const f=fixture({choose:(request,count,key)=>key==='thread'?(['u1','u2','u21'].includes(request.state.current.id)?'new_topic':request.state.goalAnchors.at(-1)?.id):undefined});
  const previousResult=await f.analyze({messages:messages(20)});const before=f.calls.length;const result=await f.analyze({messages:messages(21),previousResult});
  assert.equal(f.calls.length-before,1);assert.equal(result.reusedTurns,19);assert.equal(new Set(result.threads.map(thread=>thread.id)).size,2);assert.deepEqual(result.threads.map(thread=>thread.anchorMessageId),['u2','u21']);assert.equal(result.observations.at(-1).transition,'change');assert.equal(result.observations.at(-1).anchorMessageId,'u21');assert.deepEqual(normalizeConversationFlow(result,{messages:messages(21)}),result);
});

test('a normalized incremental result round-trips through the actual conversation archive with zero new calls',async()=>{
  const {ConversationArchive}=await import('../src/conversation-archive.mjs');const stored=new Map();const fileMap=new Map();const folders=new Map();
  const vault={adapter:{exists:async path=>fileMap.has(path)||folders.has(path),read:async path=>stored.get(path)},getMarkdownFiles:()=>[...fileMap.values()],getAbstractFileByPath:path=>fileMap.get(path)||folders.get(path),createFolder:async path=>{const folder={path,children:[]};folders.set(path,folder);return folder;},create:async(path,content)=>{const file={path,stat:{size:Buffer.byteLength(content)}};fileMap.set(path,file);stored.set(path,content);return file;},read:async file=>stored.get(file.path),process:async(file,callback)=>{const content=callback(stored.get(file.path));stored.set(file.path,content);return content;}};
  const f=fixture();const current=messages(3);const original=await f.analyze({messages:current});const flow=await f.analyze({messages:current,previousResult:original});assert.equal(flow.requestCount,0);
  const archive=new ConversationArchive({vault,idFactory:()=> 'incremental-flow-fixture',clock:()=>new Date(TIME)});const saved=await archive.save({messages:current,flow});const loaded=await archive.load({path:saved.path});assert.deepEqual(loaded.flow,flow);
});

test('manual default continues to request all chosen turns without incremental count fields',async()=>{
  const f=fixture();const first=await f.analyze();const before=f.calls.length;const result=await f.analyze();assert.equal(f.calls.length-before,3);assert.equal(result.requestCount,3);assert.equal(Object.hasOwn(result,'reusedTurns'),false);assert.deepEqual(result,first);
  const forged=structuredClone(result);forged.requestCount=0;assert.throws(()=>normalizeConversationFlow(forged),{code:'FLOW_INVALID_DATA'});
  const mismatch={...result,reusedTurns:1};assert.throws(()=>normalizeConversationFlow(mismatch),{code:'FLOW_INVALID_DATA'});
});

test('incremental cancellation returns no partial result, snapshots input and never edits prior data',async()=>{
  const f=fixture();const original=messages(2);const previousResult=await f.analyze({messages:original});const prior=structuredClone(previousResult);const newer=messages(3);const before=structuredClone(newer);const abort=new AbortController();const count=f.calls.length;
  await assert.rejects(f.analyze({messages:newer,previousResult,signal:abort.signal,onProgress:value=>{if(value.done===2)abort.abort();}}),{name:'AbortError'});assert.equal(f.calls.length,count);assert.deepEqual(previousResult,prior);assert.deepEqual(newer,before);
  const lateAbort=new AbortController();const g=fixture({onRequest:()=>{newer[4].content='CHANGED_DURING_CALL';lateAbort.abort();}});await assert.rejects(g.analyze({messages:newer,previousResult,signal:lateAbort.signal}),{name:'AbortError'});assert.equal(g.calls.length,1);assert(!JSON.stringify(g.calls).includes('CHANGED_DURING_CALL'));assert.deepEqual(previousResult,prior);
});
