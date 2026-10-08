import test from 'node:test';
import assert from 'node:assert/strict';
import {ConnectionController} from '../src/controller.mjs';
import {buildConversationStructureRequest,parseConversationStructureResponse} from '../src/conversation-structure.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
function response(input){const data=JSON.parse(input.split('\nDATA_JSON\n')[1]);return JSON.stringify({cards:data.cards.map((card,i)=>({id:card.id,parentId:i?data.cards[0].id:null,relation:i?'refine':'start',topic:'Synthetic research'}))});}
function fixture(t,{mobile=false}={}){
  const calls={provider:[],jev:0,persist:0,retrieval:0},hooks={};let saved;
  const provider={generate:async(input,options)=>{calls.provider.push({input,options});return hooks.generate?hooks.generate(input,options):response(input);}};
  const archive={save:async snapshot=>{saved=structuredClone(snapshot);return {id:'summary-saved',path:'Notework/Chats/summary-saved.md'};},list:async()=>saved?[{id:'summary-saved',path:'Notework/Chats/summary-saved.md'}]:[],load:async()=>({...saved,id:'summary-saved',path:'Notework/Chats/summary-saved.md'})};
  const engine={retrieve:async()=>{calls.retrieval++;return {sources:[],proof:{validNotes:1,invalidatedPaths:[]}};}};
  const settings={mode:'openai',scope:{mode:'all'},archive:{folder:'Notework/Chats'},prompts:{folder:'Notework/Prompts'}};
  const controller=new ConnectionController({providers:{openai:provider},availableModes:mobile?['openai','anthropic']:undefined,retrievalStrategy:mobile?'lexical':undefined,requiresSyncedIndex:mobile,jev:{evaluate:async()=>{calls.jev++;throw new Error('Unexpected Jev request');}},secrets:{},vault:{getMarkdownFiles:()=>[],getName:()=> 'Summary synthetic vault'},getTags:()=>[],settings,saveSettings:async()=>{calls.persist++;},knowledgeEngine:engine,archive});
  const index={id:'synthetic-summary-index',nodes:[{id:'pinned-source',path:'Research/source.md'}],...(mobile?{portableImport:{sourceIndexId:'pc-built-index'}}:{})};
  controller.set({model:'selected-answer',models:[{id:'selected-answer',supportedReasoningEfforts:['high']},{id:'other-answer'}],reasoningEffort:'high',authenticated:true,verified:true,connection:'catalog-confirmed',consent:true,graphMode:'pinned',knowledge:{...controller.state.knowledge,index,phase:'ready',selectedCategory:'all',selectedNodeIds:['pinned-source'],selectedNodesActive:true}});
  t.after(()=>controller.dispose());return {controller,calls,hooks,settings};
}
function pairs(controller,count=2){const contextKey=controller.contextKey();return Array.from({length:count},(_,i)=>[{id:'u'+i,role:'user',content:'Exact question '+i+'\n한국어?',contextKey},{id:'a'+i,role:'assistant',content:'Exact **answer** '+i+'\n\n```txt\noriginal\n```',contextKey,contextSources:[]}]).flat();}
function classified(controller){const messages=pairs(controller),contextKey=controller.contextKey(),request=buildConversationStructureRequest(messages,contextKey),analysis=parseConversationStructureResponse(response(request.input),request,{messages,contextKey,model:controller.state.model});controller.set({messages,conversationMapAnalysis:analysis,answer:messages.at(-1).content,draft:'Unsent draft remains exact.\n'});return analysis;}

test('summary defaults closed on desktop and mobile without provider or persisted preference calls',t=>{
  for(const mobile of [false,true]){const f=fixture(t,{mobile});assert.equal(f.controller.state.conversationSummaryOpen,false);assert.equal(f.calls.provider.length,0);assert.equal(f.calls.jev,0);assert.equal(f.calls.persist,0);assert(!Object.hasOwn(f.settings,'conversationSummaryOpen'));}
});

test('open and close are local emissions preserving exact turns, AI proof, pin, model, draft and context',async t=>{
  const f=fixture(t),c=f.controller;classified(c);const before={messages:c.state.messages,analysis:c.state.conversationMapAnalysis,map:c.state.conversationMap,knowledge:c.state.knowledge,sources:c.state.sources,models:c.state.models,settings:structuredClone(c.settings),draft:c.state.draft,context:c.contextKey(),owner:c.conversationOwner,epoch:c.epoch};let emissions=0;const unsub=c.subscribe(()=>emissions++);emissions=0;
  for(const open of [true,false,true,false]){await c.setConversationSummaryOpen(open);assert.equal(c.state.conversationSummaryOpen,open);assert.equal(c.state.messages,before.messages);assert.equal(c.state.conversationMapAnalysis,before.analysis);assert.equal(c.state.conversationMap,before.map);assert.equal(c.state.knowledge,before.knowledge);assert.equal(c.state.sources,before.sources);assert.equal(c.state.models,before.models);assert.deepEqual(c.settings,before.settings);assert.equal(c.state.draft,before.draft);assert.equal(c.contextKey(),before.context);assert.equal(c.conversationOwner,before.owner);assert.equal(c.epoch,before.epoch);assert.equal(c.state.graphMode,'pinned');assert.deepEqual(c.state.knowledge.selectedNodeIds,['pinned-source']);}
  assert.equal(emissions,4);assert.equal(f.calls.provider.length,0);assert.equal(f.calls.jev,0);assert.equal(f.calls.persist,0);unsub();
});

test('repeating visibility and toggling after disposal are no-ops',async t=>{
  const f=fixture(t),c=f.controller;let emissions=0;const unsub=c.subscribe(()=>emissions++);emissions=0;await c.setConversationSummaryOpen(false);assert.equal(emissions,0);await c.setConversationSummaryOpen(true);await c.setConversationSummaryOpen(true);assert.equal(emissions,1);c.dispose();const epoch=c.epoch,open=c.state.conversationSummaryOpen;await c.setConversationSummaryOpen(false);assert.equal(c.state.conversationSummaryOpen,open);assert.equal(c.epoch,epoch);unsub();
});

test('summary toggles cannot abort an active answer and completed pairs update while hidden',async t=>{
  const f=fixture(t),c=f.controller,started=deferred(),finish=deferred();c.set({draft:'Please answer this exact question.'});f.hooks.generate=async(input,options)=>{if(input.startsWith('NOTEWORK_CONVERSATION_STRUCTURE_V1'))return response(input);options.onDelta?.('Partial answer');started.resolve();await finish.promise;return 'Completed **answer**\nwith original Markdown.';};
  const pending=c.ask();await started.promise;const epoch=c.epoch,abort=c.abort,context=c.contextKey();assert.equal(c.state.busy,true);assert.equal(c.state.conversationMap.cards.length,0);
  await c.setConversationSummaryOpen(true);await c.setConversationSummaryOpen(false);assert.equal(c.state.busy,true);assert.equal(c.epoch,epoch);assert.equal(c.abort,abort);assert.equal(abort.signal.aborted,false);assert.equal(c.contextKey(),context);assert.equal(c.state.draft,'Please answer this exact question.');
  finish.resolve();await pending;await c.mapPromise;assert.equal(c.state.busy,false);assert.equal(c.state.conversationSummaryOpen,false);assert.equal(c.state.messages.length,2);assert.equal(c.state.conversationMap.cards.length,1);assert.equal(c.state.conversationMap.cards[0].question,'Please answer this exact question.');assert.equal(c.state.conversationMap.cards[0].answer,'Completed **answer**\nwith original Markdown.');assert.equal(c.state.conversationMap.cards[0].transitionMethod,'connected-llm');assert.equal(f.calls.provider.length,2);assert.equal(f.calls.jev,0);await c.setConversationSummaryOpen(true);assert.equal(f.calls.provider.length,2);
});

test('closing a summary during a selected LLM map request keeps that request alive and publishes validated structure',async t=>{
  const f=fixture(t),c=f.controller;c.set({messages:pairs(c)});await c.setConversationSummaryOpen(true);const started=deferred(),finish=deferred();f.hooks.generate=async input=>{started.resolve();await finish.promise;return response(input);};const pending=c.updateConversationMap();await started.promise;const abort=c.mapAbort,epoch=c.epoch;await c.setConversationSummaryOpen(false);assert.equal(c.mapAbort,abort);assert.equal(abort.signal.aborted,false);assert.equal(c.epoch,epoch);finish.resolve();await pending;assert.equal(c.state.conversationSummaryOpen,false);assert.equal(c.state.conversationMap.aiBuilt,true);assert.equal(c.state.conversationMap.edges.length,1);assert.equal(f.calls.provider.length,1);assert.equal(f.calls.jev,0);await c.setConversationSummaryOpen(true);assert.equal(f.calls.provider.length,1);
});

test('an appended completed pair appears pending with prior validated classifications retained regardless of dock visibility',async t=>{
  const f=fixture(t),c=f.controller,analysis=classified(c);await c.setConversationSummaryOpen(true);const contextKey=c.contextKey();c.set({messages:[...c.state.messages,{id:'u-new',role:'user',content:'New question',contextKey}]});assert.equal(c.state.conversationMap.cards.length,2);await c.setConversationSummaryOpen(false);c.set({messages:[...c.state.messages,{id:'a-new',role:'assistant',content:'New completed answer',contextKey}]});assert.equal(c.state.conversationMap.cards.length,3);assert.equal(c.state.conversationMapAnalysis,analysis);assert.equal(c.state.conversationMap.edges.length,1);assert.equal(c.state.conversationMap.cards[2].transitionMethod,'unclassified');await c.setConversationSummaryOpen(true);assert.equal(c.state.conversationMap.cards[2].answer,'New completed answer');assert.equal(f.calls.provider.length,0);assert.equal(f.calls.jev,0);
});

test('new conversation empties summary data while retaining visibility, pinned scope and selected model',async t=>{
  const f=fixture(t),c=f.controller;classified(c);await c.setConversationSummaryOpen(true);const model=c.state.model,ids=[...c.state.knowledge.selectedNodeIds];c.newConversation();assert.equal(c.state.conversationSummaryOpen,true);assert.deepEqual(c.state.messages,[]);assert.equal(c.state.conversationMap.cards.length,0);assert.equal(c.state.conversationMapAnalysis,null);assert.equal(c.state.model,model);assert.deepEqual(c.state.knowledge.selectedNodeIds,ids);assert.equal(f.calls.provider.length,0);assert.equal(f.calls.jev,0);
});

test('archive reload restores exact turns and AI structure into an already open summary without another LLM request',async t=>{
  const f=fixture(t),c=f.controller;classified(c);const messages=structuredClone(c.state.messages),analysis=structuredClone(c.state.conversationMapAnalysis);await c.setConversationSummaryOpen(true);await c.saveConversation();c.newConversation();await c.loadConversation('summary-saved');assert.equal(c.state.conversationSummaryOpen,true);assert.deepEqual(c.state.messages,messages);assert.deepEqual(c.state.conversationMapAnalysis,analysis);assert.equal(c.state.conversationMap.cards.length,2);assert.equal(c.state.conversationMap.edges.length,1);assert.equal(f.calls.provider.length,0);assert.equal(f.calls.jev,0);
});

test('model and scope context changes retain dock visibility without preserving stale classifications',async t=>{
  const f=fixture(t),c=f.controller;classified(c);await c.setConversationSummaryOpen(true);c.selectModel('other-answer');assert.equal(c.state.conversationSummaryOpen,true);assert.equal(c.state.conversationMapAnalysis,null);c.setScope({mode:'folders',include:['Another scope']});assert.equal(c.state.conversationSummaryOpen,true);assert.equal(c.state.conversationMapAnalysis,null);assert.equal(f.calls.provider.length,0);assert.equal(f.calls.jev,0);
});
