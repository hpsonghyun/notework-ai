import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeConversationFlow, normalizeConversationFlow, FLOW_LIMITS} from '../src/conversation-flow.mjs';
import {ConversationArchive} from '../src/conversation-archive.mjs';
import {JevProvider} from '../src/providers/jev.mjs';

const TIME='2026-10-06T12:34:56.000Z';const CONTEXT='context-current';const MODEL='fixture-jev-model';
function turns(contents=['Build my research backend.','Add a tag filter.','Explain the selected sources.']) {
  return contents.flatMap((content,index)=>[
    {id:'u'+(index+1),role:'user',content,createdAt:TIME,contextKey:CONTEXT},
    {id:'a'+(index+1),role:'assistant',content:'ASSISTANT_PRIVATE_TEXT_'+index,createdAt:TIME,contextKey:CONTEXT,sources:[{path:'Research/note-'+index+'.md',chunkId:'chunk-'+index,contentHash:'f'.repeat(64),text:'PRIVATE_NOTE_EXCERPT_'+index,apiKey:'fixture-key-not-forwarded'}]},
  ]);
}
function answerFor(questions,{thread,transition='refine',continuity=.8}={}) {
  return Object.fromEntries(Object.entries(questions).map(([id,question])=>{
    if(question.type==='noul')return[id,{type:'noul',noul:continuity}];
    const choice=id==='thread'?(thread||Object.keys(question.criteria).find(key=>key.startsWith('thread_'))||'new_topic'):transition;
    return[id,{type:'choice',choice,confidence:.9,probabilities:Object.fromEntries(Object.keys(question.criteria).map(key=>[key,key===choice?1:0]))}];
  }));
}
function fixture({respond,mutate}={}) {
  const calls=[];
  const jev={async evaluate(request){calls.push(structuredClone({...request,signal:undefined}));const result={model:MODEL,answers:answerFor(request.questions,respond?.(request,calls.length)||{})};return mutate?mutate(result,request,calls.length):result;}};
  const analyze=options=>analyzeConversationFlow({messages:turns(),contextKey:CONTEXT,model:MODEL,jev,consent:true,verified:true,clock:()=>new Date(TIME),...options});
  return{jev,calls,analyze};
}
function archiveFixture() {
  const contents=new Map();const files=new Map();const folders=new Map();
  const vault={adapter:{exists:async path=>files.has(path)||folders.has(path),read:async path=>contents.get(path)},getMarkdownFiles:()=>[...files.values()],getAbstractFileByPath:path=>files.get(path)||folders.get(path),createFolder:async path=>{const folder={path,children:[]};folders.set(path,folder);return folder;},create:async(path,content)=>{const file={path,stat:{size:Buffer.byteLength(content)}};files.set(path,file);contents.set(path,content);return file;},read:async file=>contents.get(file.path),process:async(file,callback)=>{const content=callback(contents.get(file.path));contents.set(file.path,content);return content;}};
  return{contents,archive:new ConversationArchive({vault,idFactory:()=> 'flow-conversation',clock:()=>new Date(TIME)})};
}

test('flow analysis requires separate explicit consent and a verified Jev connection before any request',async()=>{
  const f=fixture();await assert.rejects(f.analyze({consent:false}),{code:'FLOW_CONSENT_REQUIRED'});await assert.rejects(f.analyze({verified:false}),{code:'FLOW_JEV_UNVERIFIED'});await assert.rejects(f.analyze({jev:{}}),{code:'FLOW_JEV_UNVERIFIED'});assert.equal(f.calls.length,0);
});
test('only user excerpts from the exact current context reach Jev; assistant text and note excerpts remain local',async()=>{
  const f=fixture();const messages=[{id:'old-u',role:'user',content:'OTHER_CONTEXT_PRIVATE_GOAL',contextKey:'old-context'},...turns()];const result=await f.analyze({messages});
  assert.equal(result.analyzedTurns,3);assert.equal(result.requestCount,3);assert.equal(result.totalUserTurns,3);assert.equal(result.observations[0].transition,'start');assert.equal(result.observations[1].transition,'refine');assert.equal(result.threads.length,1);
  const sent=JSON.stringify(f.calls);assert.ok(!sent.includes('OTHER_CONTEXT_PRIVATE_GOAL'));assert.ok(!sent.includes('ASSISTANT_PRIVATE_TEXT'));assert.ok(!sent.includes('PRIVATE_NOTE_EXCERPT'));assert.ok(!sent.includes('fixture-key-not-forwarded'));assert.ok(!sent.includes(CONTEXT));assert.ok(!sent.includes('Research/note'));
  assert.equal(result.observations[0].sourceRefs[0].path,'Research/note-0.md');assert.equal(result.observations[1].anchorMessageId,'u1');assert.equal(result.observations[1].continuity,.8);assert.ok(!Object.hasOwn(result.observations[1],'score'));
});
test('topic changes create quoted goal groups and returning to a prior goal rejoins its original anchor',async()=>{
  const f=fixture({respond:(request,count)=>count===2?{thread:'new_topic',transition:'change'}:count===3?{thread:'thread_1',transition:'continue'}:{}});const result=await f.analyze();
  assert.deepEqual(result.observations.map(item=>item.transition),['start','change','continue']);assert.deepEqual(result.threads.map(item=>item.turnIds),[['flow_1','flow_3'],['flow_2']]);assert.equal(result.threads[0].title,'Build my research backend.');assert.equal(result.threads[1].title,'Add a tag filter.');
});
test('ambiguous goal assignment is visibly unclear and never fabricated into an existing topic',async()=>{
  const f=fixture({respond:(request,count)=>count===2?{thread:'unclear',transition:'continue'}:{}});const result=await f.analyze();assert.equal(result.observations[1].transition,'unclear');assert.equal(result.observations[1].anchorMessageId,'u2');assert.equal(result.threads.length,2);
});
test('request budget takes the most recent matching turns and records omitted coverage accurately',async()=>{
  const f=fixture();const result=await f.analyze({messages:turns(['one','two','three','four','five']),maxTurns:5,maxRequests:2});assert.equal(f.calls.length,2);assert.equal(result.totalUserTurns,5);assert.equal(result.analyzedTurns,2);assert.equal(result.omittedUserTurns,3);assert.deepEqual(result.observations.map(item=>item.turn),[4,5]);assert.deepEqual(result.observations.map(item=>item.messageId),['u4','u5']);assert.equal(f.calls[0].state.current.excerpt,'four');
});
test('anchor candidates and total external requests remain bounded as every turn starts a new goal',async()=>{
  const f=fixture({respond:()=>({thread:'new_topic',transition:'change'})});const result=await f.analyze({messages:turns(Array.from({length:30},(_,i)=>'Different goal '+i))});assert.equal(f.calls.length,20);assert.equal(result.threads.length,20);assert.equal(result.omittedUserTurns,10);assert.ok(f.calls.every(call=>call.state.goalAnchors.length<=FLOW_LIMITS.maxAnchors));assert.equal(f.calls.at(-1).state.goalAnchors.length,8);
});
test('serialized Unicode and escaping stay inside the request limit without cutting surrogate pairs',async()=>{
  const content=('한글 🧠 \\"\n').repeat(20000);const f=fixture();const messages=turns([content,content]);const result=await f.analyze({messages});for(const call of f.calls){assert.ok(Buffer.byteLength(JSON.stringify({model:call.model,state:call.state,questions:call.questions}))<=32768);assert.ok(!/[\uD800-\uDBFF]$/.test(call.state.current.excerpt));}
  for(const observation of result.observations){assert.ok(content.startsWith(observation.excerpt));assert.equal(observation.excerptEnd,observation.excerpt.length);assert.ok(observation.excerpt.includes(observation.title));}assert.ok(result.observations[0].excerpt.length<content.length);
});
test('source refs are local, bounded, deduplicated and allowlisted; unsafe source paths are omitted',async()=>{
  const messages=turns(['Source test']);messages[1].sources.push({...messages[1].sources[0]}, {path:'.obsidian/secret.md',text:'secret'}, {path:'../outside.md'}, {path:'C:/private.md'}, {path:'Research/visible.md',apiKey:'fixture-key'});
  const f=fixture();const result=await f.analyze({messages});assert.equal(result.observations[0].sourceRefs.length,2);assert.deepEqual(result.observations[0].sourceRefs[1],{path:'Research/visible.md'});assert.ok(!JSON.stringify(result).includes('fixture-key'));assert.ok(!JSON.stringify(f.calls).includes('Research/visible.md'));
});
test('empty or mismatched-context conversation has a readable error and performs no external request',async()=>{
  const f=fixture();await assert.rejects(f.analyze({messages:[]}),{code:'FLOW_NO_TURNS'});await assert.rejects(f.analyze({contextKey:'other'}),{code:'FLOW_NO_TURNS'});await assert.rejects(f.analyze({messages:turns(['  \n '])}),{code:'FLOW_NO_TURNS'});assert.equal(f.calls.length,0);
});
test('invalid budgets, duplicate IDs, context signatures and empty bounded excerpts fail before a request',async()=>{
  const f=fixture();for(const options of [{maxTurns:21},{maxRequests:0},{maxTurns:1.1},{contextKey:''},{contextKey:'x'.repeat(20001)},{messages:[...turns(['one']),...turns(['two'])]},{messages:turns([' '.repeat(5000)+'late text'])}])await assert.rejects(f.analyze(options),{code:'FLOW_INVALID_DATA'});assert.equal(f.calls.length,0);
});
test('cancellation before and immediately after a response never returns a partial flow',async()=>{
  const early=new AbortController();early.abort();const f=fixture();await assert.rejects(f.analyze({signal:early.signal}),{name:'AbortError'});assert.equal(f.calls.length,0);
  const late=new AbortController();const g=fixture({mutate:result=>{late.abort();return result;}});await assert.rejects(g.analyze({signal:late.signal}),{name:'AbortError'});assert.equal(g.calls.length,1);
});
test('progress cancellation stops before the next request',async()=>{
  const cancel=new AbortController();const f=fixture();const progress=[];await assert.rejects(f.analyze({signal:cancel.signal,onProgress:value=>{progress.push(value);if(value.done===1)cancel.abort();}}),{name:'AbortError'});assert.equal(f.calls.length,1);assert.deepEqual(progress,[{done:0,total:3},{done:1,total:3}]);
});
for(const [name,mutate] of [
  ['foreign model',result=>({...result,model:'foreign-model'})],
  ['missing answers',result=>({...result,answers:{}})],
  ['unexpected answer',result=>({...result,answers:{...result.answers,extra:{type:'noul',noul:.5}}})],
  ['wrong type',result=>({...result,answers:{...result.answers,thread:{type:'score',score:1}}})],
  ['invented goal ID',result=>({...result,answers:{...result.answers,thread:{...result.answers.thread,choice:'invented'}}})],
  ['invalid choice probability',result=>({...result,answers:{...result.answers,thread:{...result.answers.thread,confidence:Infinity}}})],
  ['invalid distribution',result=>({...result,answers:{...result.answers,thread:{...result.answers.thread,probabilities:{new_topic:.1,unclear:.1}}}})],
])test('malformed flow response rejects '+name,async()=>{const f=fixture({mutate});await assert.rejects(f.analyze(),{code:'FLOW_INVALID_DATA'});assert.equal(f.calls.length,1);});
test('a malformed Noul on a later turn rejects the whole observation sequence',async()=>{
  const f=fixture({mutate:(result,request,count)=>count===2?({...result,answers:{...result.answers,continuity:{type:'noul',noul:1.2}}}):result});await assert.rejects(f.analyze(),{code:'FLOW_INVALID_DATA'});assert.equal(f.calls.length,2);
});
test('flow snapshots are immutable across provider awaits and never alter original answers',async()=>{
  const messages=turns();const original=structuredClone(messages);const f=fixture({mutate:(result,request,count)=>{if(count===1)messages[2].content='CHANGED_DURING_ANALYSIS';return result;}});const result=await f.analyze({messages});assert.equal(result.observations[1].excerpt,original[2].content);assert.ok(!JSON.stringify(f.calls).includes('CHANGED_DURING_ANALYSIS'));assert.deepEqual(messages.filter(item=>item.role==='assistant'),original.filter(item=>item.role==='assistant'));
});
test('flow normalization verifies exact user quotes, source refs and goal ownership',async()=>{
  const messages=turns();const f=fixture();const result=await f.analyze({messages});assert.deepEqual(normalizeConversationFlow(result,{messages}),result);
  for(const mutate of [value=>value.observations[0].excerpt='Made up source quote',value=>value.observations[0].title='Made up title',value=>value.observations[1].anchorMessageId='u2',value=>value.threads[0].turnIds.reverse(),value=>value.observations[0].sourceRefs[0].path='Research/forged.md',value=>value.observations[0].continuity=2,value=>value.requestCount=19]){const forged=structuredClone(result);mutate(forged);assert.throws(()=>normalizeConversationFlow(forged,{messages}),{code:'FLOW_INVALID_DATA'});}
});
test('flow allowlist drops arbitrary private settings and preserves a prior analysis after new turns',async()=>{
  const messages=turns();const f=fixture();const result=await f.analyze({messages});result.apiKey='fixture-top-secret';result.observations[0].cookie='fixture-cookie';result.threads[0].settings={token:'fixture-token'};const newer=[...messages,...turns(['New turn']).map(item=>({...item,id:'new-'+item.id}))];const normalized=normalizeConversationFlow(result,{messages:newer});assert.equal(normalized.totalUserTurns,3);assert.ok(!JSON.stringify(normalized).includes('fixture-top-secret'));assert.ok(!JSON.stringify(normalized).includes('fixture-cookie'));assert.ok(!JSON.stringify(normalized).includes('fixture-token'));
});
test('optional flow round-trips with readable quoted goal groups while old conversation archives still load',async()=>{
  const f=fixture();const messages=turns();const flow=await f.analyze({messages});const stored=archiveFixture();const saved=await stored.archive.save({messages,flow});const loaded=await stored.archive.load({path:saved.path});assert.deepEqual(loaded.flow,flow);const markdown=stored.contents.get(saved.path);assert.ok(markdown.includes('## Conversation flow (Jev)'));assert.ok(markdown.includes('Goal from user turn'));assert.ok(markdown.includes('does not change the answers'));assert.ok(markdown.includes('Build my research backend'));assert.ok(markdown.includes('**Turn 2:** refine'));
  const old=await stored.archive.save({id:'legacy',messages});assert.equal((await stored.archive.load({path:old.path})).flow,undefined);
});
test('archive rejects fabricated flow quotes instead of persisting an unsupported summary',async()=>{
  const f=fixture();const messages=turns();const flow=await f.analyze({messages});flow.observations[0].excerpt='INVENTED';const stored=archiveFixture();await assert.rejects(stored.archive.save({messages,flow}),{code:'FLOW_INVALID_DATA'});assert.equal(stored.contents.size,0);
});
test('actual JevProvider typed route accepts bounded flow state without a live network call or private vault',async()=>{
  const requests=[];const provider=new JevProvider({secrets:{get:async()=> 'fixture-only-key'},fetchImpl:async(url,options)=>{const payload=JSON.parse(options.body);requests.push({url,payload});return{ok:true,status:200,json:async()=>({model:payload.model,answers:answerFor(payload.questions),usage:{input_tokens:1,output_tokens:1}})};}});provider.models=[{id:MODEL}];const result=await analyzeConversationFlow({messages:turns(),contextKey:CONTEXT,model:MODEL,jev:provider,consent:true,verified:true,clock:()=>new Date(TIME)});assert.equal(result.analyzedTurns,3);assert.ok(requests.every(request=>request.url==='https://api.typesafe.ai/v1/systemone'));assert.ok(requests.every(request=>Buffer.byteLength(JSON.stringify(request.payload))<=32768));
});
