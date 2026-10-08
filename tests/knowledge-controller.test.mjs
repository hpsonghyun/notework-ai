import test from 'node:test';
import assert from 'node:assert/strict';
import {ConnectionController} from '../src/controller.mjs';
import {KnowledgeEngine} from '../src/knowledge-engine.mjs';
import {ConversationArchive} from '../src/conversation-archive.mjs';
import {KnowledgeIndexStore,normalizeKnowledgeSettings} from '../src/runtime-storage.mjs';
function structureResponse(input){const data=JSON.parse(input.split('\nDATA_JSON\n')[1]);return JSON.stringify({cards:data.cards.map(card=>({id:card.id,parentId:null,relation:'start',topic:'Synthetic knowledge question'}))});}
const answerCalls=f=>f.calls.filter(input=>!input.startsWith('NOTEWORK_CONVERSATION_STRUCTURE_V1'));

function fixture() {
  const contents=new Map([
    ['Research/search.md','# Retrieval design\nSemantic search retrieves grounded evidence. QUOTED_RETRIEVAL_EVIDENCE'],
    ['Research/decision.md','# Model decision\nChoose a model based on retrieval latency. DECISION_SOURCE'],
    ['Private/excluded.md','# Retrieval\nEXCLUDED_PRIVATE_MARKER'],
    ['Notework/Chats/old.md','# Retrieval\nRECURSIVE_ARCHIVE_MARKER']
  ]);
  const files=new Map();const folders=new Set(['Research','Private','Notework','Notework/Chats']);const calls=[];const writes=[];
  for(const [path,text] of contents)files.set(path,{path,basename:path.split('/').at(-1).slice(0,-3),stat:{mtime:1,ctime:1,size:text.length}});
  const vault={getName:()=> 'Synthetic Knowledge QA',getMarkdownFiles:()=>[...files.values()],getAbstractFileByPath:path=>files.get(path)||(folders.has(path)?{path,children:[]}:null),cachedRead:async file=>contents.get(file.path),read:async file=>contents.get(file.path),createFolder:async path=>{folders.add(path);},create:async(path,text)=>{if(files.has(path))throw new Error('Exists');const file={path,stat:{mtime:2,ctime:2,size:text.length}};files.set(path,file);contents.set(path,text);return file;},process:async(file,fn)=>{const text=fn(contents.get(file.path));contents.set(file.path,text);file.stat.mtime++;return text;}};
  const provider={connect:async()=>{},listModels:async()=>[{id:'synthetic-qa-model',name:'Synthetic model'}],generate:async(input,{onDelta}={})=>{calls.push(input);if(input.startsWith('NOTEWORK_CONVERSATION_STRUCTURE_V1'))return structureResponse(input);const answer='Grounded result [[Research/search.md]]';onDelta?.(answer);return answer;},disconnect:async()=>{}};
  const providers=Object.fromEntries(['chatgpt','claude-code','openai','anthropic','ollama'].map(mode=>[mode,provider]));
  const engine=new KnowledgeEngine({vault,getTags:()=>[],embeddingProvider:{},jev:{}});
  const archive=new ConversationArchive({vault});
  const settings={mode:'chatgpt',scope:{mode:'folders',include:['Research'],exclude:[]}};
  const controller=new ConnectionController({providers,jev:{},secrets:{},vault,getTags:()=>[],settings,knowledgeEngine:engine,archive,indexStore:{save:async index=>writes.push(structuredClone(index))},saveSettings:async()=>{}});
  return {controller,vault,calls,writes,contents,files,engine};
}
async function ready(f) {await f.controller.connect();await f.controller.verify();f.calls.length=0;await f.controller.buildKnowledge({consent:true});assert.equal(f.controller.state.knowledge.phase,'ready',f.controller.state.knowledge.status);}

test('building requires explicit scope consent and never makes an implicit semantic call',async()=>{
  const f=fixture();await f.controller.buildKnowledge();assert.equal(f.writes.length,0);assert.equal(f.calls.length,0);
  await f.controller.buildKnowledge({consent:true});assert.equal(f.writes.length,1);assert.equal(f.calls.length,0);assert.equal(f.controller.state.knowledge.index.embedding.route,'lexical');
  assert.deepEqual(f.controller.state.knowledge.index.nodes.map(node=>node.path).sort(),['Research/decision.md','Research/search.md']);
});
test('semantic build cannot use an unconnected LLM or Jev without a live catalog',async()=>{
  const f=fixture();f.controller.configureKnowledge({semanticRoute:'llm'});await f.controller.buildKnowledge({consent:true});assert.equal(f.writes.length,0);assert.match(f.controller.state.knowledge.status,/Connect.*catalog/i);
  f.controller.configureKnowledge({semanticRoute:'jev'});await f.controller.buildKnowledge({consent:true});assert.equal(f.writes.length,0);assert.match(f.controller.state.knowledge.status,/Jev/);
});
test('selected knowledge note is the actual retrieval boundary, and browsing makes no calls',async()=>{
  const f=fixture();await ready(f);const index=f.controller.state.knowledge.index;const selected=index.nodes.find(node=>node.path==='Research/search.md');
  f.controller.setKnowledgeSelection({nodeIds:[selected.id]});assert.equal(f.calls.length,0);
  f.controller.set({draft:'retrieval model',consent:true});await f.controller.ask();await f.controller.mapPromise;assert.equal(f.calls.length,2);assert(f.calls[1].startsWith('NOTEWORK_CONVERSATION_STRUCTURE_V1'));
  assert.ok(f.calls[0].includes('QUOTED_RETRIEVAL_EVIDENCE'));assert.ok(!f.calls[0].includes('DECISION_SOURCE'));assert.ok(!f.calls[0].includes('EXCLUDED_PRIVATE_MARKER'));assert.ok(!f.calls[0].includes('RECURSIVE_ARCHIVE_MARKER'));
  assert.deepEqual(f.controller.state.sources.map(source=>source.path),['Research/search.md']);assert.equal(f.controller.state.retrievalProof.indexId,index.id);assert.deepEqual(f.controller.state.retrievalProof.filters.selectedNodeIds,[selected.id]);assert.equal(f.controller.state.messages.length,2);
});
test('a narrowed selection does not retransmit a prior answer containing other sources',async()=>{
  const f=fixture();await ready(f);f.controller.set({draft:'model retrieval',consent:true});await f.controller.ask();
  f.controller.state.messages.at(-1).content='PREVIOUS_OUTSIDE_SELECTION_ANSWER';
  f.controller.setKnowledgeSelection({nodeIds:[f.controller.state.knowledge.index.nodes.find(node=>node.path==='Research/search.md').id]});
  f.controller.set({draft:'retrieval',consent:true});await f.controller.ask();assert.ok(!answerCalls(f).at(-1).includes('PREVIOUS_OUTSIDE_SELECTION_ANSWER'));assert.equal(f.controller.state.messages.length,4);
});
test('unchecking the final selected note does not broaden retrieval to the category',async()=>{
  const f=fixture();await ready(f);f.controller.setKnowledgeSelection({nodeIds:[f.controller.state.knowledge.index.nodes[0].id]});f.controller.setKnowledgeSelection({nodeIds:[]});
  assert.equal(f.controller.state.knowledge.selectedNodesActive,true);f.controller.set({draft:'retrieval',consent:true});await f.controller.ask();assert.equal(f.calls.length,0);assert.match(f.controller.state.status,/No notes/);
  f.controller.clearKnowledgeSelection();assert.equal(f.controller.state.knowledge.selectedNodesActive,false);f.controller.set({consent:true});await f.controller.ask();await f.controller.mapPromise;assert.equal(f.calls.length,2);assert(f.calls[1].startsWith('NOTEWORK_CONVERSATION_STRUCTURE_V1'));
});
test('previous turns are not silently transferred to another model or provider',async()=>{
  const f=fixture();await ready(f);f.controller.set({draft:'retrieval',consent:true});await f.controller.ask();f.controller.state.messages.at(-1).content='OLD_MODEL_CONVERSATION_MARKER';
  f.controller.state.models.push({id:'another-model',name:'Another model'});f.controller.selectModel('another-model');await f.controller.verify();f.controller.set({draft:'model',consent:true});await f.controller.ask();assert.ok(!answerCalls(f).at(-1).includes('OLD_MODEL_CONVERSATION_MARKER'));
});
test('source edits after build cannot reach the model through a stale cached excerpt',async()=>{
  const f=fixture();await ready(f);f.contents.set('Research/search.md','Changed source without old marker');f.files.get('Research/search.md').stat.mtime=2;
  f.controller.set({draft:'retrieval',consent:true});await f.controller.ask();assert.ok(!answerCalls(f).at(-1).includes('QUOTED_RETRIEVAL_EVIDENCE'));assert.ok(f.controller.state.retrievalProof.invalidatedPaths.includes('Research/search.md'));
});
test('conversation save and reopen preserve actual turns, sources, model and retrieval proof',async()=>{
  const f=fixture();await ready(f);f.controller.set({draft:'retrieval',consent:true});await f.controller.ask();assert.equal(f.controller.state.history.length,0);
  const saved=await f.controller.saveConversation();assert.ok(saved.path.startsWith('Notework/Chats/'));assert.equal(f.controller.state.history.length,1);assert.ok(!f.controller.scopeFiles().some(file=>file.path===saved.path));
  const messages=structuredClone(f.controller.state.messages);f.controller.newConversation();assert.equal(f.controller.state.messages.length,0);await f.controller.loadConversation(saved.id);
  assert.deepEqual(f.controller.state.messages.map(message=>[message.role,message.content,message.model]),messages.map(message=>[message.role,message.content,message.model]));assert.equal(f.controller.state.retrievalProof.indexId,f.controller.state.knowledge.index.id);assert.equal(f.controller.state.consent,false);
  assert.ok(f.contents.get(saved.path).includes('notework-conversation: true'));
});
test('auto-save is opt-in and saving a second turn updates the same archive',async()=>{
  const f=fixture();await ready(f);await f.controller.setArchiveSettings({folder:'AI/Conversations',autoSave:true});
  f.controller.set({draft:'retrieval',consent:true});await f.controller.ask();const path=f.controller.state.archivePath;assert.ok(path.startsWith('AI/Conversations/'));
  f.controller.set({draft:'model',consent:true});await f.controller.ask();assert.equal(f.controller.state.archivePath,path);assert.equal(f.controller.state.history.length,1);assert.equal(f.controller.state.history[0].turns,2);assert.ok(answerCalls(f).at(-1).includes('Previous turns'));
});
test('late cancelled build cannot replace a newer retained index',async()=>{
  const f=fixture();await ready(f);const old=f.controller.state.knowledge.index;let finish;
  f.controller.knowledgeEngine={build:()=>new Promise(resolve=>{finish=resolve;})};const pending=f.controller.buildKnowledge({consent:true});f.controller.stop();finish({...old,id:'late-index'});await pending;assert.equal(f.controller.state.knowledge.index.id,old.id);assert.equal(f.controller.state.busy,false);
});

test('a failed rebuild keeps the previous index and preserves its error after scope changes',async()=>{
  const f=fixture();await ready(f);const index=f.controller.state.knowledge.index;
  f.controller.knowledgeEngine={build:async()=>{throw new Error('Synthetic source changed. Rebuild the selected scope.');}};
  await f.controller.buildKnowledge({consent:true});assert.equal(f.controller.state.knowledge.index,index);assert.equal(f.controller.state.knowledge.phase,'ready');assert.match(f.controller.state.knowledge.lastBuildError,/Synthetic source changed/);assert.match(f.controller.state.knowledge.status,/previous saved index/);
  f.controller.setScope({mode:'folders',include:['Research'],exclude:[]});assert.match(f.controller.state.knowledge.lastBuildError,/Synthetic source changed/);
  f.controller.knowledgeEngine=f.engine;await f.controller.buildKnowledge({consent:true});assert.equal(f.controller.state.knowledge.phase,'ready');assert.equal(f.controller.state.knowledge.lastBuildError,'');
});

test('build progress keeps saving visible until local persistence completes',async()=>{
  const f=fixture();await ready(f);const old=f.controller.state.knowledge.index;
  const events=[];f.controller.subscribe(state=>{if(state.knowledge.progress)events.push({...state.knowledge.progress});});
  let release,started;const saved=new Promise(resolve=>{started=resolve;});
  f.controller.indexStore.save=async()=>{started();await new Promise(resolve=>{release=resolve;});};
  const pending=f.controller.buildKnowledge({consent:true});await saved;
  assert.equal(f.controller.state.busy,true);assert.equal(f.controller.state.knowledge.phase,'building');
  assert.equal(f.controller.state.knowledge.index,old);assert.equal(f.controller.state.knowledge.progress.phase,'saving');
  assert.equal(f.controller.state.knowledge.progress.done,0);assert.ok(!events.some(event=>event.phase==='complete'));
  for(const phase of ['reading','organizing','relationships','connecting','verifying'])assert.ok(events.some(event=>event.phase===phase&&event.done===event.total),phase);
  release();await pending;assert.equal(f.controller.state.busy,false);assert.equal(f.controller.state.knowledge.phase,'ready');assert.equal(f.controller.state.knowledge.progress,null);
});
test('private index storage checks format and plugin directory and serializes writes',async()=>{
  assert.throws(()=>new KnowledgeIndexStore({adapter:{},directory:'../private'}));assert.doesNotThrow(()=>new KnowledgeIndexStore({adapter:{},directory:'custom-config/plugins/notework-ai',configDir:'custom-config'}));assert.throws(()=>new KnowledgeIndexStore({adapter:{},directory:'.obsidian/plugins/another-plugin'}));const values=new Map();const adapter={exists:async path=>values.has(path),read:async path=>values.get(path),write:async(path,text)=>values.set(path,text),rename:async(from,to)=>{values.set(to,values.get(from));values.delete(from);}};
  const store=new KnowledgeIndexStore({adapter,directory:'.obsidian/plugins/notework-ai'});const first={schema:1,id:'first',nodes:[],chunks:[],categories:[],scope:{mode:'all'}};await Promise.all([store.save(first),store.save({...first,id:'second'})]);assert.equal((await store.load()).id,'second');
  values.set(store.path,'{"schema":1,"id":"bad"}');await assert.rejects(store.load(),/format/);
});

test('legacy automatic budgets migrate to full scope and only explicit flags enable limits',()=>{
  for(const old of [undefined,null,{}, {maxNotes:200,maxCalls:50,maxChunks:1000}]) {
    const settings=normalizeKnowledgeSettings(old);
    assert.equal(settings.limitNotes,false);assert.equal(settings.limitCalls,false);assert.equal(settings.limitChunks,false);
  }
  const chosen=normalizeKnowledgeSettings({limitNotes:true,maxNotes:601,limitCalls:true,maxCalls:401,limitChunks:true,maxChunks:5001});
  assert.deepEqual([chosen.limitNotes,chosen.maxNotes,chosen.limitCalls,chosen.maxCalls,chosen.limitChunks,chosen.maxChunks],[true,601,true,401,true,5001]);
  assert.equal(normalizeKnowledgeSettings({limitCalls:true,maxCalls:0}).maxCalls,0);
  assert.equal(normalizeKnowledgeSettings({maxCalls:''}).maxCalls,200);
  assert.equal(normalizeKnowledgeSettings({maxNotes:true}).maxNotes,200);
});

test('controller builds all 610 selected notes and reports the full progress denominator',async()=>{
  const f=fixture();
  for(let i=0;i<608;i++) {const path='Research/full-'+i+'.md',text='# Scope item '+i+'\nIndependent source evidence '+i;f.contents.set(path,text);f.files.set(path,{path,stat:{mtime:1,ctime:1,size:text.length}});}
  const reading=[];f.controller.subscribe(state=>{const p=state.knowledge.progress;if(p?.stage==='Reading notes'||p?.phase==='reading')reading.push({...p});});
  await f.controller.buildKnowledge({consent:true});
  const index=f.controller.state.knowledge.index;assert.equal(index.nodes.length,610);assert.equal(index.stats.selectedNotes,610);assert.equal(index.stats.limitedNotes,0);assert.equal(index.stats.maxSemanticCalls,null);
  assert.ok(reading.some(p=>p.total===610));assert.equal(reading.at(-1).done,610);assert.equal(f.calls.length,0);
  assert.match(f.controller.state.knowledge.status,/Indexed 610 of 610 selected notes/);
  assert.ok(index.nodes.every(node=>node.path.startsWith('Research/')));
});

test('controller forwards only opted-in limits and explains incomplete coverage',async()=>{
  const f=fixture();let received;
  f.controller.configureKnowledge({maxNotes:601,maxCalls:401,maxChunks:5001});
  f.controller.knowledgeEngine={build:async options=>{received=options;return {schema:1,id:'synthetic-budget',nodes:[{id:'one'}],stats:{selectedNotes:2,limitedNotes:1,skippedNotes:0,truncatedNotes:1,semanticStatus:'budget-limited'},chunks:[],categories:[]};}};
  await f.controller.buildKnowledge({consent:true});assert.deepEqual([received.maxNotes,received.maxCalls,received.maxChunks],[null,null,null]);
  f.controller.configureKnowledge({limitNotes:true,maxNotes:1,limitCalls:true,maxCalls:0,limitChunks:true,maxChunks:2});
  await f.controller.buildKnowledge({consent:true});assert.deepEqual([received.maxNotes,received.maxCalls,received.maxChunks],[1,0,2]);
  assert.match(f.controller.state.knowledge.status,/Indexed 1 of 2 selected notes/);assert.match(f.controller.state.knowledge.status,/1 omitted by your note limit/);assert.match(f.controller.state.knowledge.status,/1 partly indexed/);assert.match(f.controller.state.knowledge.status,/AI request limit was reached/);
});

test('large graph selections use a deterministic bounded context signature without changing legacy keys',()=>{
  const f=fixture(),c=f.controller;
  assert.deepEqual(JSON.parse(c.contextKey()),{scope:c.effectiveScope(),indexId:'',categoryId:'all',nodeIds:null,route:'chatgpt',model:''});
  c.state.knowledge.selectedNodesActive=true;c.state.knowledge.selectedNodeIds=Array.from({length:1200},(_,i)=>'node_'+String(i).padStart(4,'0')+'_long_identifier');
  const key=c.contextKey();assert.match(key,/^context_[a-f0-9]{64}$/);c.state.knowledge.selectedNodeIds.reverse();assert.equal(c.contextKey(),key);
  c.state.knowledge.selectedNodeIds.pop();assert.notEqual(c.contextKey(),key);
});

test('private cache saves and reloads an index larger than the former 40MB cutoff',async()=>{
  const values=new Map(),adapter={exists:async path=>values.has(path),read:async path=>values.get(path),write:async(path,text)=>values.set(path,text),rename:async(from,to)=>{values.set(to,values.get(from));values.delete(from);}};
  const store=new KnowledgeIndexStore({adapter,directory:'.obsidian/plugins/notework-ai'});
  const index={schema:1,id:'large-synthetic-index',scope:{mode:'all'},nodes:[],categories:[],chunks:Array.from({length:4100},(_,i)=>({id:'chunk_'+i,text:'evidence '.repeat(1112)}))};
  await store.save(index);assert.ok(values.get(store.path).length>40_000_000);const loaded=await store.load();assert.equal(loaded.chunks.length,4100);assert.equal(loaded.chunks.at(-1).text,index.chunks.at(-1).text);assert.ok(!values.has(store.path+'.pending'));
});
