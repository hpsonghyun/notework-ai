import test from 'node:test';
import assert from 'node:assert/strict';
import {ConnectionController,isFlowCurrent} from '../src/controller.mjs';
import {buildConversationStructureRequest,parseConversationStructureResponse,conversationStructureSourceHash,CONVERSATION_STRUCTURE_LIMITS} from '../src/conversation-structure.mjs';
import {buildConversationMap} from '../src/conversation-map.mjs';
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
function response(input){const data=JSON.parse(input.split('\nDATA_JSON\n')[1]);return JSON.stringify({cards:data.cards.map((card,index)=>({id:card.id,parentId:index?data.cards[index-1].id:null,relation:index?'refine':'start',topic:'Research'}))});}
function fixture(t){
  const calls=[];let jevCalls=0;let saved;const hooks={};
  const provider={generate:async(input,options)=>{calls.push({input,options});return hooks.generate?hooks.generate(input,options):response(input);}};
  const archive={save:async snapshot=>{saved=structuredClone(snapshot);return {id:'saved',path:'Notework/Chats/saved.md'};},list:async()=>saved?[{id:'saved',path:'Notework/Chats/saved.md'}]:[],load:async()=>({...saved,id:'saved',path:'Notework/Chats/saved.md'})};
  const controller=new ConnectionController({providers:{openai:provider},jev:{evaluate:async()=>{jevCalls++;throw new Error('Jev is prohibited in chat maps');}},secrets:{},vault:{getMarkdownFiles:()=>[],getName:()=> 'Map fixture'},getTags:()=>[],settings:{mode:'openai',scope:{mode:'all'},archive:{folder:'Notework/Chats'}},saveSettings:async()=>{},archive});
  controller.set({model:'selected-model',models:[{id:'selected-model',supportedReasoningEfforts:['high']}],authenticated:true,connection:'catalog-confirmed',verified:true,reasoningEffort:'high',answer:'The completed answer remains unchanged.'});
  const contextKey=controller.contextKey();const messages=[{id:'u1',role:'user',content:'Build research backend.',contextKey},{id:'a1',role:'assistant',content:'Actual answer ONE.',contextKey,contextSources:[]},{id:'u2',role:'user',content:'Add folder control.',contextKey},{id:'a2',role:'assistant',content:'Actual answer TWO.',contextKey,contextSources:[]},{id:'pending',role:'user',content:'Not yet answered.',contextKey}];
  controller.set({messages});t.after(()=>controller.dispose());return {controller,calls,hooks,get jevCalls(){return jevCalls;},get saved(){return saved;}};
}
test('conversation structure uses one selected connected AI request and preserves answer, model and saved turns',async t=>{
  const f=fixture(t);const before=structuredClone(f.controller.state.messages);await f.controller.updateConversationMap();
  assert.equal(f.calls.length,1);assert.equal(f.jevCalls,0);assert.equal(f.calls[0].options.model,'selected-model');assert.equal(f.calls[0].options.reasoningEffort,'high');assert.equal(f.calls[0].options.onDelta,undefined);
  assert.equal(f.controller.state.answer,'The completed answer remains unchanged.');assert.deepEqual(f.controller.state.messages,before);assert.equal(f.controller.state.model,'selected-model');assert.equal(f.controller.state.conversationMap.aiBuilt,true);assert.equal(f.controller.state.conversationMap.cards[1].answer,'Actual answer TWO.');assert.equal(f.controller.state.conversationMap.edges.length,1);assert(!Object.hasOwn(f.controller.state,'conversationMapConsent'));assert(!f.calls[0].input.includes('Not yet answered.'));
});
test('automatic map requires a verified selected provider and has no separate consent gate',async t=>{
  const f=fixture(t);await f.controller.updateAutomaticConversationMap();assert.equal(f.calls.length,1);f.controller.set({verified:false});await f.controller.updateAutomaticConversationMap();assert.equal(f.calls.length,1);assert.match(f.controller.state.conversationMap.status,/Connect.*model catalog/);assert.equal(f.jevCalls,0);assert.equal(typeof f.controller.setConversationMapConsent,'undefined');
});
test('invalid structure shows fallback actual cards without invented relationships or altering main status',async t=>{
  const f=fixture(t);const status=f.controller.state.status;f.hooks.generate=async()=>'{"cards":[{"id":"invented","parentId":null,"relation":"start","topic":"Fake"}]}';await f.controller.updateConversationMap();assert.equal(f.controller.state.conversationMap.phase,'failed');assert.equal(f.controller.state.conversationMap.aiBuilt,false);assert.equal(f.controller.state.conversationMap.edges.length,0);assert.equal(f.controller.state.answer,'The completed answer remains unchanged.');assert.equal(f.controller.state.status,status);assert.equal(f.controller.state.conversationMap.cards[0].question,'Build research backend.');
});
test('provider failure is a sanitized map-only error with no fallback call',async t=>{
  const f=fixture(t);f.hooks.generate=async()=>{throw new Error('Bearer synthetic-secret request failed');};await f.controller.updateConversationMap();assert.equal(f.calls.length,1);assert(!f.controller.state.conversationMap.status.includes('synthetic-secret'));assert.equal(f.controller.state.answer,'The completed answer remains unchanged.');assert.equal(f.controller.state.busy,false);
});

test('failed map refresh preserves proven earlier branches while appended pairs remain pending',async t=>{
  const f=fixture(t);await f.controller.updateConversationMap();const previous=structuredClone(f.controller.state.conversationMapAnalysis),contextKey=f.controller.contextKey();
  f.controller.set({messages:[...f.controller.state.messages.slice(0,4),{id:'u3',role:'user',content:'A newly completed question.',contextKey},{id:'a3',role:'assistant',content:'A newly completed answer.',contextKey,contextSources:[]}]});
  assert.equal(f.controller.state.conversationMap.edges.length,1);assert.equal(f.controller.state.conversationMap.cards[2].transitionMethod,'unclassified');
  f.hooks.generate=async()=>{throw new Error('Synthetic refresh failed');};await f.controller.updateConversationMap();
  assert.equal(f.calls.length,2);assert.equal(f.jevCalls,0);assert.equal(f.controller.state.conversationMap.phase,'failed');assert.equal(f.controller.state.conversationMap.edges.length,1);assert.equal(f.controller.state.conversationMap.cards[2].transitionMethod,'unclassified');assert.deepEqual(f.controller.state.conversationMapAnalysis,previous);assert.match(f.controller.state.conversationMap.status,/Previous validated structure remains/);assert.equal(f.controller.state.answer,'The completed answer remains unchanged.');
});
test('stop and context/model changes discard late map responses even when provider ignores abort',async t=>{
  for(const operation of ['stop','model','scope','session','verification']){
    const f=fixture(t),waiting=deferred(),started=deferred();f.hooks.generate=async input=>{started.resolve(input);await waiting.promise;return response(input);};const pending=f.controller.updateConversationMap();await started.promise;
    if(operation==='stop')f.controller.stop();else if(operation==='model')f.controller.set({model:'other'});else if(operation==='scope')f.controller.setScope({mode:'folders',include:['Other']});else if(operation==='verification')f.controller.set({verified:false});else f.controller.newConversation();
    await pending;waiting.resolve();assert.equal(f.controller.state.conversationMap.aiBuilt,false);assert.equal(f.controller.state.conversationMapAnalysis,null);assert.equal(f.jevCalls,0);
  }
});
test('stopping automatic structure cancels its pending request and keeps completed answer',async t=>{
  const f=fixture(t),waiting=deferred(),started=deferred();f.hooks.generate=async input=>{started.resolve(input);await waiting.promise;return response(input);};const pending=f.controller.updateAutomaticConversationMap();await started.promise;f.controller.stop();await pending;waiting.resolve();assert.equal(f.controller.state.conversationMap.aiBuilt,false);assert.equal(f.controller.state.answer,'The completed answer remains unchanged.');
});
test('validated AI metadata saves and reopens with zero additional requests',async t=>{
  const f=fixture(t);await f.controller.updateConversationMap();await f.controller.saveConversation();assert.equal(f.saved.conversationMapAnalysis.schema,1);assert(!JSON.stringify(f.saved.conversationMapAnalysis).includes('Actual answer'));f.controller.newConversation();await f.controller.loadConversation('saved');assert.equal(f.calls.length,1);assert.equal(f.controller.state.conversationMap.aiBuilt,true);assert.equal(f.controller.state.conversationMap.cards[1].answer,'Actual answer TWO.');
});
test('legacy currentness is only for reading old archive data',()=>{
  const contextKey='old';const messages=[{id:'u1',role:'user',content:'Old question',contextKey}];assert.equal(isFlowCurrent({contextKey,observations:[{messageId:'u1'}],analyzedTurns:1,totalUserTurns:1},messages,contextKey),true);assert.equal(typeof ConnectionController.prototype.analyzeConversationFlow,'undefined');assert.equal(typeof ConnectionController.prototype.setQueryJevConsent,'undefined');
});
test('large contexts and Unicode keep one request bounded to latest20 pairs and32KiB',()=>{
  const contextKey='selected-scope:'+('한글'.repeat(20000));const messages=Array.from({length:35},(_,i)=>[{id:'u'+i,role:'user',content:'질문🙂'.repeat(800),contextKey},{id:'a'+i,role:'assistant',content:'답변🧭'.repeat(800),contextKey}]).flat();assert.equal(buildConversationMap(messages,{contextKey}).cards.length,35);
  const request=buildConversationStructureRequest(messages,contextKey);assert(request.cards.length>0&&request.cards.length<=20);assert(new TextEncoder().encode(request.input).byteLength<=CONVERSATION_STRUCTURE_LIMITS.maxRequestBytes);assert(!request.input.includes(contextKey));assert.equal(request.cards.at(-1).userMessageId,'u34');const analysis=parseConversationStructureResponse(response(request.input),request,{messages,contextKey,model:'selected'});assert.equal(analysis.decisions.length,request.cards.length);assert.equal(analysis.sourceHash,conversationStructureSourceHash(messages.map(message=>({...message,status:'completed'})),contextKey));
});
test('validation rejects foreign and duplicate IDs, forward and self parents, unsafe relation/topic',()=>{
  const contextKey='test';const messages=[{id:'u',role:'user',content:'Q',contextKey},{id:'a',role:'assistant',content:'A',contextKey},{id:'u2',role:'user',content:'Q2',contextKey},{id:'a2',role:'assistant',content:'A2',contextKey}];const request=buildConversationStructureRequest(messages,contextKey);const valid=JSON.parse(response(request.input));
  const mutations=[cards=>cards[0].id='foreign',cards=>cards[1].id=cards[0].id,cards=>cards[0].parentId=cards[1].id,cards=>cards[1].parentId=cards[1].id,cards=>cards[0].relation='grade',cards=>cards[0].topic='<script>x</script>',cards=>cards[0].topic='x'.repeat(121),cards=>cards[0].topic='direction\u202e'];
  for(const change of mutations){const value=structuredClone(valid);change(value.cards);assert.throws(()=>parseConversationStructureResponse(JSON.stringify(value),request,{messages,contextKey,model:'m'}),/invalid/);}assert.throws(()=>parseConversationStructureResponse('not JSON',request,{messages,contextKey,model:'m'}),/invalid/);assert.throws(()=>parseConversationStructureResponse(JSON.stringify({...valid,rewrittenAnswer:'made up'}),request,{messages,contextKey,model:'m'}),/invalid/);
});
