import test from 'node:test';
import assert from 'node:assert/strict';
import {ConnectionController} from '../src/controller.mjs';
import {KnowledgeEngine} from '../src/knowledge-engine.mjs';

function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
async function settle(predicate){for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,1));}assert.fail('Synthetic controller operation did not settle.');}
function typedAnswers(request){return Object.fromEntries(Object.entries(request.questions).map(([id,question])=>{
  if(question.type==='noul')return[id,{type:'noul',noul:0.8}];
  if(question.type==='score')return[id,{type:'score',score:2,confidence:0.8,probabilities:{0:0,1:0,2:1,3:0}}];
  const keys=Object.keys(question.criteria);const choice=id==='thread'?(keys.find(key=>key.startsWith('thread_'))||'new_topic'):'unclear';return[id,{type:'choice',choice,confidence:0.8,probabilities:Object.fromEntries(keys.map(key=>[key,key===choice?1:0]))}];
}));}
function structureResponse(input){const data=JSON.parse(input.split('\nDATA_JSON\n')[1]);return JSON.stringify({cards:data.cards.map(card=>({id:card.id,parentId:null,relation:'start',topic:'Research'}))});}
async function fixture(t,{activePath='',mobile=false,embeddingProvider,index=true}={}){
  const contents=new Map([
    ['Research/alpha.md','# Alpha\nRetrieval evidence ALPHA_MARKER.'],
    ['Research/beta.md','# Beta\nRetrieval evidence BETA_MARKER.'],
    ['Research/open.md','# Open\nUnrelated currently displayed OPEN_MARKER.'],
    ['Private/secret.md','# Secret\nRetrieval evidence PRIVATE_MARKER.'],
    ['Other/fresh.md','# Other\nOutside the selected folder OTHER_MARKER.'],
    ['Notework/Chats/old.md','# Old\nRetrieval evidence ARCHIVE_MARKER.'],
  ]);
  const files=new Map([...contents].map(([path,text])=>[path,{path,basename:path.split('/').at(-1).slice(0,-3),stat:{mtime:1,ctime:1,size:Buffer.byteLength(text)}}]));
  const llmCalls=[],jevCalls=[],reads=[],saves=[];const hooks={};
  const read=async file=>{reads.push(file.path);if(hooks.read)return hooks.read(file);return contents.get(file.path);};
  const vault={getName:()=> 'Synthetic setup QA',getMarkdownFiles:()=>[...files.values()],getAbstractFileByPath:path=>files.get(path),read,cachedRead:read};
  const provider={connect:async()=>{},listModels:async()=>[{id:'gpt-6.1-sol'}],generate:async(input,options)=>{llmCalls.push({input,options});if(input.startsWith('NOTEWORK_CONVERSATION_STRUCTURE_V1'))return hooks.classify?hooks.classify(input,options):structureResponse(input);if(hooks.generate)return hooks.generate(input,options);return 'Completed answer grounded in the supplied source excerpts.';}};
  const jev={evaluate:async request=>{jevCalls.push(request);if(hooks.jev)return hooks.jev(request);return{model:request.model,answers:typedAnswers(request)};}};
  const engine=new KnowledgeEngine({vault,getTags:()=>[]});
  const settings={mode:'openai',scope:{mode:'folders',include:['Research'],exclude:[]},knowledge:{embeddingRoute:'lexical',semanticRoute:'none'}};
  const controller=new ConnectionController({providers:{openai:provider},availableModes:['openai'],retrievalStrategy:mobile?'lexical':undefined,requiresSyncedIndex:mobile,jev,secrets:{},vault,getTags:()=>[],getActiveNote:()=>activePath,settings,saveSettings:async value=>saves.push(structuredClone(value)),knowledgeEngine:engine,embeddingProvider});
  if(index){const built=await engine.build({files:controller.scopeFiles(),scope:controller.effectiveScope(),embeddingRoute:'lexical',semanticRoute:'none',consent:true});controller.knowledge({index:built,phase:'ready'});}
  controller.set({model:'gpt-6.1-sol',models:[{id:'gpt-6.1-sol'}],authenticated:true,connection:'catalog-confirmed',verified:true,jevModels:[{id:'synthetic-jev'}],jevModel:'synthetic-jev',jevVerified:true});
  llmCalls.length=0;jevCalls.length=0;reads.length=0;
  t.after(()=>controller.dispose());
  const ask=async(question='retrieval')=>{controller.set({draft:question,consent:true});await controller.ask();};
  return{controller,contents,files,reads,llmCalls,jevCalls,hooks,saves,settings,engine,ask};
}

test('embedding downloads require explicit consent, desktop capability and an available pull provider',async t=>{
  let pulls=0;const embeddingProvider={pullModel:async()=>{pulls++;return{model:'synthetic-embed:latest'};},listModels:async()=>[{id:'synthetic-embed:latest',capabilities:['embedding']}]};
  const desktop=await fixture(t,{embeddingProvider});await desktop.controller.downloadEmbeddingModel('synthetic-embed:latest');assert.equal(pulls,0);assert.match(desktop.controller.state.status,/allow|Download/i);
  const mobile=await fixture(t,{embeddingProvider,mobile:true});await mobile.controller.downloadEmbeddingModel('synthetic-embed:latest',{consent:true});assert.equal(pulls,0);assert.match(mobile.controller.state.status,/computer/);
  const absent=await fixture(t);await absent.controller.downloadEmbeddingModel('synthetic-embed:latest',{consent:true});assert.equal(pulls,0);assert.equal(absent.controller.state.embeddingDiscovery,'unchecked');
});
test('download success selects the verified canonical model and persists the actual discovered catalog',async t=>{
  const calls=[];const embeddingProvider={pullModel:async(model,{signal,onProgress})=>{calls.push({model,signal});onProgress({model,phase:'downloading',status:'Downloading weights.',percent:50});return{model:'synthetic-embed:latest',fingerprint:'fixture',capabilities:['embedding']};},listModels:async()=>[{id:'synthetic-embed:latest',capabilities:['embedding']}]};
  const f=await fixture(t,{embeddingProvider});await f.controller.downloadEmbeddingModel('synthetic-embed',{consent:true});assert.equal(calls.length,1);assert.equal(calls[0].signal.aborted,false);assert.equal(f.settings.knowledge.embeddingRoute,'ollama');assert.equal(f.settings.knowledge.embeddingModel,'synthetic-embed:latest');assert.equal(f.controller.state.embeddingDiscovery,'ready');assert.equal(f.controller.state.embeddingDownload.phase,'ready');assert.equal(f.saves.at(-1).knowledge.embeddingModel,'synthetic-embed:latest');assert.equal(f.llmCalls.length,0);assert.equal(f.jevCalls.length,0);
});
test('a model removed between preparation and discovery is not selected or announced ready',async t=>{
  const embeddingProvider={pullModel:async()=>({model:'vanished:latest',capabilities:['embedding']}),listModels:async()=>[]};const f=await fixture(t,{embeddingProvider});
  await f.controller.downloadEmbeddingModel('vanished:latest',{consent:true});assert.notEqual(f.controller.state.embeddingDownload.phase,'ready');assert.notEqual(f.settings.knowledge.embeddingModel,'vanished:latest');
});
test('download failure is sanitized and a cancelled late result cannot replace prior settings',async t=>{
  const failed=await fixture(t,{embeddingProvider:{pullModel:async()=>{throw new Error('Bearer synthetic-secret could not prepare');}}});await failed.controller.downloadEmbeddingModel('fixture',{consent:true});assert.equal(failed.controller.state.embeddingDownload.phase,'failed');assert(!failed.controller.state.status.includes('synthetic-secret'));assert.equal(failed.settings.knowledge.embeddingRoute,'lexical');
  const waiting=deferred(),started=deferred();let discoveryCalls=0;
  const f=await fixture(t,{embeddingProvider:{pullModel:async()=>{started.resolve();return waiting.promise;},listModels:async()=>{discoveryCalls++;return[{id:'late:latest'}];}}});const pending=f.controller.downloadEmbeddingModel('late',{consent:true});await started.promise;f.controller.stop();waiting.resolve({model:'late:latest',capabilities:['embedding']});await pending;assert.equal(discoveryCalls,0);assert.equal(f.controller.state.embeddingDownload.phase,'stopped');assert.equal(f.settings.knowledge.embeddingRoute,'lexical');assert.equal(f.controller.state.busy,false);
});
test('index coverage discards an older async check after scope revision',async t=>{
  const f=await fixture(t);const waiting=deferred(),started=deferred();let blocked=false;
  f.hooks.read=async file=>{if(file.path==='Research/alpha.md'&&!blocked){blocked=true;started.resolve();await waiting.promise;}return f.contents.get(file.path);};
  const old=f.controller.refreshIndexCoverage({force:true});await started.promise;f.controller.setScope({mode:'folders',include:['Other'],exclude:[]});await settle(()=>!f.controller.state.coverageChecking);const newCoverage=f.controller.state.indexCoverage;
  assert.deepEqual(newCoverage.files.map(file=>file.path),['Other/fresh.md']);waiting.resolve();await old;assert.equal(f.controller.state.indexCoverage,newCoverage);assert.equal(f.controller.state.indexCoverage.counts.notIndexedNotes,1);
});
test('explicit path invalidation detects same-size same-mtime content changes',async t=>{
  const f=await fixture(t);await f.controller.refreshIndexCoverage();assert.equal(f.controller.state.indexCoverage.counts.upToDateNotes,3);
  const file=f.files.get('Research/alpha.md');const before={...file.stat};f.contents.set(file.path,f.contents.get(file.path).replace('ALPHA_MARKER','ALPHE_MARKER'));assert.deepEqual(file.stat,before);
  f.controller.invalidateKnowledgeCoverage(file.path);assert.notEqual(f.controller.state.indexCoverage.files.find(item=>item.path===file.path).status,'Up to date');await f.controller.refreshIndexCoverage();assert.equal(f.controller.state.indexCoverage.files.find(item=>item.path===file.path).status,'Changed');assert(!f.reads.includes('Private/secret.md'));
});
test('currently open note is included without keyword overlap only when it is within Scope',async t=>{
  const f=await fixture(t,{activePath:'Research/open.md'});await f.ask();assert(f.llmCalls[0].input.includes('OPEN_MARKER'));assert.equal(f.controller.state.retrievalProof.activeNote.path,'Research/open.md');assert(f.controller.state.sources.some(item=>item.route==='open-note'));assert(!f.llmCalls[0].input.includes('PRIVATE_MARKER'));
  const excluded=await fixture(t,{activePath:'Private/secret.md'});await excluded.ask();assert(!excluded.llmCalls[0].input.includes('PRIVATE_MARKER'));assert(!excluded.reads.includes('Private/secret.md'));assert.equal(excluded.controller.state.retrievalProof.activeNote,undefined);
});
test('category and pinned source selection prevent unrelated open notes from widening evidence',async t=>{
  const f=await fixture(t,{activePath:'Research/open.md'});const index=f.controller.state.knowledge.index;
  index.categories=[{id:'alpha',label:'Alpha'},{id:'beta',label:'Beta'}];for(const node of index.nodes)node.category=node.path.endsWith('alpha.md')?'alpha':'beta';
  f.controller.setKnowledgeSelection({categoryId:'alpha'});await f.ask();assert.deepEqual(f.controller.state.sources.map(item=>item.path),['Research/alpha.md']);assert(!f.llmCalls.filter(call=>!call.input.startsWith('NOTEWORK_CONVERSATION_STRUCTURE_V1')).at(-1).input.includes('OPEN_MARKER'));
  f.controller.clearKnowledgeSelection();const beta=index.nodes.find(node=>node.path==='Research/beta.md');f.controller.setKnowledgeSelection({nodeIds:[beta.id]});await f.ask();assert.deepEqual(f.controller.state.sources.map(item=>item.path),['Research/beta.md']);assert(!f.llmCalls.filter(call=>!call.input.startsWith('NOTEWORK_CONVERSATION_STRUCTURE_V1')).at(-1).input.includes('OPEN_MARKER'));
});
test('archived open notes remain outside retrieval and active-note transmission',async t=>{
  const f=await fixture(t,{activePath:'Notework/Chats/old.md',index:false});f.controller.setScope({mode:'all'});await f.ask();assert(!f.llmCalls[0].input.includes('ARCHIVE_MARKER'));assert(!f.reads.includes('Notework/Chats/old.md'));
});
test('local conversation map receives cards only after completed answers',async t=>{
  const f=await fixture(t);const waiting=deferred(),started=deferred();f.hooks.generate=async(input,{onDelta})=>{onDelta?.('Partial stream');started.resolve();return waiting.promise;};const pending=f.ask();await started.promise;
  assert.equal(f.controller.state.conversationMap.cards.length,0);assert.equal(f.controller.state.messages.length,0);waiting.resolve('A completed source-grounded answer.');await pending;assert.equal(f.controller.state.conversationMap.cards.length,1);assert.equal(f.controller.state.conversationMap.cards[0].answer,'A completed source-grounded answer.');assert.equal(f.jevCalls.length,0);
});
test('failed or stopped answers do not create completed local map cards',async t=>{
  const failed=await fixture(t);failed.hooks.generate=async()=>{throw new Error('Synthetic provider failure');};await failed.ask();assert.equal(failed.controller.state.conversationMap.cards.length,0);assert.equal(failed.controller.state.messages.length,0);assert.equal(failed.jevCalls.length,0);assert.equal(failed.llmCalls.length,1);
  const f=await fixture(t),waiting=deferred(),started=deferred();f.hooks.generate=async()=>{started.resolve();return waiting.promise;};const pending=f.ask();await started.promise;f.controller.stop();waiting.resolve('Late completed answer');await pending;assert.equal(f.controller.state.conversationMap.cards.length,0);assert.equal(f.controller.state.messages.length,0);assert.equal(f.jevCalls.length,0);assert.equal(f.llmCalls.length,1);
});
test('default chat automatically structures each completed exchange with the selected AI and viewing is local',async t=>{
  const f=await fixture(t);await f.ask();await f.controller.mapPromise;assert.equal(f.jevCalls.length,0);assert.equal(f.llmCalls.length,2);assert(f.llmCalls[1].input.startsWith('NOTEWORK_CONVERSATION_STRUCTURE_V1'));assert.equal(f.llmCalls[1].options.model,'gpt-6.1-sol');assert(!Object.hasOwn(f.controller.state,'conversationMapConsent'));assert.equal(f.controller.state.conversationMap.aiBuilt,true);assert.equal(f.controller.state.retrievalProof.jev,undefined);f.controller.setConversationSummaryOpen(true);f.controller.setConversationSummaryOpen(false);assert.equal(f.llmCalls.length,2);
});
test('automatic structure runs once after each complete answer and a new conversation discards a late result',async t=>{
  const f=await fixture(t);f.hooks.generate=async()=> 'Complete source answer';
  await f.ask();await settle(()=>f.controller.state.conversationMap.phase==='ready');assert.equal(f.llmCalls.length,2);assert.equal(f.jevCalls.length,0);assert.equal(f.controller.state.messages.length,2);assert.equal(f.controller.state.answer,'Complete source answer');assert.equal(f.controller.state.conversationMap.aiBuilt,true);
  const waiting=deferred(),started=deferred();f.hooks.classify=async()=>{started.resolve();return waiting.promise;};await f.ask('A completed follow-up');await started.promise;const pending=f.controller.mapPromise;assert.equal(f.llmCalls.length,4);f.controller.newConversation();waiting.resolve('{}');await pending;assert.notEqual(f.controller.state.conversationMap.phase,'analyzing');assert.equal(f.controller.state.messages.length,0);assert.equal(f.controller.state.conversationMap.cards.length,0);
});
test('graph pinning uses actual retrieved notes and follow mode restores query matching within Scope',async t=>{
  const f=await fixture(t);await f.ask('Alpha');const alpha=f.controller.state.knowledge.index.nodes.find(node=>node.path==='Research/alpha.md');f.controller.setGraphMode('pinned');assert.equal(f.controller.state.graphMode,'pinned');assert.equal(f.controller.state.knowledge.selectedNodesActive,true);assert.deepEqual(f.controller.state.knowledge.selectedNodeIds,[alpha.id]);
  await f.ask('Beta');assert(f.controller.state.sources.every(item=>item.path==='Research/alpha.md'));assert.deepEqual(f.controller.state.retrievalProof.filters.selectedNodeIds,[alpha.id]);assert(!f.llmCalls.filter(call=>!call.input.startsWith('NOTEWORK_CONVERSATION_STRUCTURE_V1')).at(-1).input.includes('BETA_MARKER'));
  f.controller.setGraphMode('follow');assert.equal(f.controller.state.knowledge.selectedNodesActive,false);await f.ask('Beta');assert(f.controller.state.sources.some(item=>item.path==='Research/beta.md'));assert(!f.llmCalls.filter(call=>!call.input.startsWith('NOTEWORK_CONVERSATION_STRUCTURE_V1')).at(-1).input.includes('PRIVATE_MARKER'));assert.equal(f.controller.state.scope.include[0],'Research');
});
