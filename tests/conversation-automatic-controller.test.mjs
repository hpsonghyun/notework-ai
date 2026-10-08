import test from 'node:test';
import assert from 'node:assert/strict';
import {ConnectionController} from '../src/controller.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
function structure(input){const data=JSON.parse(input.split('\nDATA_JSON\n')[1]);return JSON.stringify({cards:data.cards.map((card,index)=>({id:card.id,parentId:index?data.cards[index-1].id:null,relation:index?'continue':'start',topic:'Synthetic conversation'}))});}
function fixture(t){
  const calls=[],hooks={};let jevCalls=0;
  const provider={generate:async(input,options)=>{const kind=input.startsWith('NOTEWORK_CONVERSATION_STRUCTURE_V1')?'structure':'answer';calls.push({kind,input,options});if(hooks[kind])return hooks[kind](input,options);if(kind==='structure')return structure(input);options.onDelta?.('Preview.');return 'Exact completed answer.';}};
  const controller=new ConnectionController({providers:{codex:provider},availableModes:['codex'],jev:{evaluate:async()=>{jevCalls++;assert.fail('Conversation structuring must not use Jev.');}},secrets:{},vault:{getMarkdownFiles:()=>[]},settings:{mode:'codex',scope:{mode:'all'},reasoningEffort:'high'},saveSettings:async()=>{}});
  controller.set({authenticated:true,verified:true,connection:'catalog-confirmed',model:'gpt-6.1-sol',models:[{id:'gpt-6.1-sol',supportedReasoningEfforts:['high']},{id:'other-model',supportedReasoningEfforts:['high']}],reasoningEffort:'high'});
  const ask=async(question='Original question.')=>{controller.set({draft:question,consent:true});await controller.ask();};
  t.after(()=>controller.dispose());return {controller,calls,hooks,ask,get jevCalls(){return jevCalls;}};
}

test('default completed answers record exact cards and trigger exactly one selected-LLM structure request each',async t=>{
  const f=fixture(t),c=f.controller;assert(!Object.hasOwn(c.state,'conversationMapConsent'));assert.equal(typeof c.setConversationMapConsent,'undefined');
  for(const question of ['Original question.','Follow-up question.']){await f.ask(question);await c.mapPromise;}
  assert.deepEqual(f.calls.map(call=>call.kind),['answer','structure','answer','structure']);
  for(const call of f.calls){assert.equal(call.options.model,'gpt-6.1-sol');assert.equal(call.options.reasoningEffort,'high');}
  assert.equal(f.jevCalls,0);assert.equal(c.state.messages.length,4);assert.equal(c.state.conversationMap.cards.length,2);assert.equal(c.state.conversationMap.aiBuilt,true);
  assert.equal(c.state.conversationMap.cards[0].question,'Original question.');assert.equal(c.state.conversationMap.cards[1].answer,'Exact completed answer.');
  for(const open of [true,false,true,false])c.setConversationSummaryOpen(open);
  assert.equal(f.calls.length,4);
});

test('concurrent identical completed prefixes share one request and identical message clones do not abort it',async t=>{
  const f=fixture(t),c=f.controller,started=deferred(),finish=deferred();f.hooks.structure=async input=>{started.resolve();await finish.promise;return structure(input);};
  await f.ask();await started.promise;const originalAbort=c.mapAbort,originalPromise=c.mapPromise;
  const same1=c.updateAutomaticConversationMap(),same2=c.updateConversationMap();
  c.set({messages:structuredClone(c.state.messages)});
  assert.equal(c.mapAbort,originalAbort);assert.equal(originalAbort.signal.aborted,false);assert.equal(f.calls.length,2);
  finish.resolve();await Promise.all([originalPromise,same1,same2]);
  assert.equal(c.state.conversationMap.aiBuilt,true);assert.equal(f.calls.length,2);
  await c.updateAutomaticConversationMap();await c.updateConversationMap();assert.equal(f.calls.length,2);
});

test('structure errors preserve completed turns and answer and cannot repeatedly charge the same prefix',async t=>{
  const f=fixture(t),c=f.controller;f.hooks.structure=async()=>{throw new Error('Synthetic structure failure');};
  await f.ask();const mainStatus=c.state.status;await c.mapPromise;
  assert.equal(c.state.conversationMap.phase,'failed');assert.equal(c.state.messages.length,2);assert.equal(c.state.conversationMap.cards.length,1);assert.equal(c.state.answer,'Exact completed answer.');assert.equal(c.state.status,mainStatus);
  await c.updateAutomaticConversationMap();await c.updateConversationMap();c.setConversationSummaryOpen(true);c.setConversationSummaryOpen(false);assert.equal(f.calls.length,2);
  f.hooks.structure=undefined;await f.ask('A genuinely new completed exchange.');await c.mapPromise;
  assert.equal(f.calls.length,4);assert.equal(c.state.conversationMap.aiBuilt,true);assert.equal(c.state.messages.length,4);
});

test('a failed answer never creates a map request or a completed card',async t=>{
  const f=fixture(t);f.hooks.answer=async()=>{throw new Error('Synthetic answer failure');};await f.ask();
  assert.deepEqual(f.calls.map(call=>call.kind),['answer']);assert.equal(f.controller.state.messages.length,0);assert.equal(f.controller.state.conversationMap.cards.length,0);assert.equal(f.controller.mapAbort,null);
});

test('the next question cancels an older structure response while recording and structuring the new completed pair',async t=>{
  const f=fixture(t),c=f.controller,started=deferred(),finish=deferred();let passes=0;
  f.hooks.structure=async input=>{if(++passes===1){started.resolve();await finish.promise;}return structure(input);};
  await f.ask('First question.');await started.promise;const oldAbort=c.mapAbort,oldPromise=c.mapPromise;
  await f.ask('Next question.');await c.mapPromise;assert.equal(oldAbort.signal.aborted,true);await oldPromise;finish.resolve();await Promise.resolve();
  assert.deepEqual(f.calls.map(call=>call.kind),['answer','structure','answer','structure']);assert.equal(c.state.messages.length,4);assert.equal(c.state.conversationMap.cards.length,2);assert.equal(c.state.conversationMapAnalysis.decisions.length,2);
});

test('scope, model, verification, stop, new chat and disposal reject late structure without losing completed records',async t=>{
  for(const operation of ['scope','model','verification','stop','new-chat','dispose']){
    const f=fixture(t),c=f.controller,started=deferred(),finish=deferred();f.hooks.structure=async input=>{started.resolve();await finish.promise;return structure(input);};
    await f.ask();await started.promise;const abort=c.mapAbort,pending=c.mapPromise,messages=structuredClone(c.state.messages);
    if(operation==='scope')c.setScope({mode:'folders',include:['Other']});
    else if(operation==='model')c.selectModel('other-model');
    else if(operation==='verification')c.set({verified:false});
    else if(operation==='stop')c.stop();
    else if(operation==='new-chat')c.newConversation();
    else c.dispose();
    assert.equal(abort.signal.aborted,true);await pending;finish.resolve();await Promise.resolve();
    assert.equal(c.state.conversationMapAnalysis,null);assert.equal(f.calls.length,2);assert.equal(f.jevCalls,0);
    if(operation==='new-chat'){assert.equal(c.state.messages.length,0);assert.equal(c.state.conversationMap.cards.length,0);}
    else{assert.deepEqual(c.state.messages,messages);assert.equal(c.state.conversationMap.cards.length,1);}
  }
});

test('stop, new chat and disposal before the background microtask prevent a structure request',async t=>{
  for(const operation of ['stop','new-chat','dispose']){
    const f=fixture(t),c=f.controller;let changed=false;
    const unsubscribe=c.subscribe(state=>{if(changed||state.conversationMap.phase!=='analyzing')return;changed=true;if(operation==='stop')c.stop();else if(operation==='new-chat')c.newConversation();else c.dispose();});
    await f.ask();await c.mapPromise;unsubscribe();assert.equal(changed,true);assert.deepEqual(f.calls.map(call=>call.kind),['answer']);assert.equal(f.jevCalls,0);
    assert.equal(c.state.messages.length,operation==='new-chat'?0:2);
  }
});

test('attachment exchanges structure their original context after files clear without transmitting file bodies again',async t=>{
  const f=fixture(t),c=f.controller,ordinaryContext=c.contextKey();
  assert.equal(c.addAttachments([{name:'reference.txt',text:'ATTACHMENT_BODY_ONLY_IN_ANSWER_REQUEST'}]),true);const attachmentContext=c.contextKey();
  await f.ask('Explain the attached reference.');await c.mapPromise;
  assert.notEqual(attachmentContext,ordinaryContext);assert.equal(c.contextKey(),ordinaryContext);assert.deepEqual(c.state.attachments,[]);assert.equal(c.state.messages[1].contextKey,attachmentContext);
  assert.equal(c.state.conversationMapAnalysis.contextKey,attachmentContext);assert.equal(c.state.conversationMap.aiBuilt,true);assert.equal(f.calls.length,2);
  assert(f.calls[0].input.includes('ATTACHMENT_BODY_ONLY_IN_ANSWER_REQUEST'));assert(!f.calls[1].input.includes('ATTACHMENT_BODY_ONLY_IN_ANSWER_REQUEST'));assert(f.calls[1].input.includes('Attached files: reference.txt'));
  const analysis=c.state.conversationMapAnalysis;c.set({messages:structuredClone(c.state.messages)});assert.equal(c.state.conversationMapAnalysis,analysis);assert.equal(c.state.conversationMap.aiBuilt,true);
  await f.ask('An ordinary follow-up.');await c.mapPromise;
  assert(!f.calls[2].input.includes('ATTACHMENT_BODY_ONLY_IN_ANSWER_REQUEST'));assert.equal(c.state.messages.length,4);assert.equal(c.state.conversationMap.cards.length,2);assert.equal(f.calls.length,4);
});
