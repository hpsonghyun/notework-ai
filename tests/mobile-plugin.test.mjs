import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {KnowledgeEngine} from '../src/knowledge-engine.mjs';
import {KnowledgeIndexStore} from '../src/runtime-storage.mjs';
import {ConnectionController} from '../src/controller.mjs';
import {ApiKeyProvider} from '../src/providers/api-key.mjs';
import {SecretStore} from '../src/secret-store.mjs';
import {createMobileFetch} from '../src/mobile-fetch.mjs';
import {ConversationArchive} from '../src/conversation-archive.mjs';
import {PromptLibrary} from '../src/prompt-library.mjs';
import {SyncKnowledgeStore,normalizeSyncKnowledgeIndex,DEFAULT_SYNC_KNOWLEDGE_PATH} from '../src/sync-knowledge.mjs';

// These are reusable module checks for a future mobile redesign. The compiled
// plugin's mobile no-start boundary is verified in mobile-startup.test.mjs.
const DIR='.obsidian/plugins/notework-ai';
async function host({withIndex=true,phoneCacheOnly=false,initialize=true}={}) {
  const data=new Map([['Research/ontology.md','# Ontology\nOntology connects source notes and relationships. ALLOWED_MOBILE_SOURCE.'],['Private/outside.md','# Private\nOUTSIDE_MOBILE_SOURCE.']]);
  const files=new Map(),folders=new Set(['Research','Private']),reads=[],nativeCalls=[],secretValues=new Map();let savedData;
  const file=path=>{if(!files.has(path))files.set(path,{path,name:path.split('/').at(-1),extension:'md',stat:{size:new TextEncoder().encode(data.get(path)||'').byteLength,mtime:1,ctime:1}});return files.get(path);};for(const path of data.keys())file(path);
  const adapterCalls=[];
  const adapter={exists:async path=>{adapterCalls.push(['exists',path]);return data.has(path)||folders.has(path);},read:async path=>{adapterCalls.push(['read',path]);return data.get(path);},write:async(path,text)=>data.set(path,text),mkdir:async path=>folders.add(path),remove:async path=>data.delete(path),rename:async(from,to)=>{data.set(to,data.get(from));data.delete(from);}};
  const vault={adapter,configDir:'.obsidian',getName:()=> 'Synthetic portable-module vault',getMarkdownFiles:()=>[...files.values()],getFiles:()=>[...files.values()],getAbstractFileByPath:path=>files.get(path)||(folders.has(path)?{path,children:[]}:null),getAllLoadedFiles:()=>[...files.values(),...[...folders].map(path=>({path,children:[]}))],read:async note=>{reads.push(note.path);return data.get(note.path);},cachedRead:async note=>{reads.push(note.path);return data.get(note.path);},createFolder:async path=>folders.add(path),create:async(path,text)=>{data.set(path,text);return file(path);},process:async(note,action)=>{const text=action(data.get(note.path));data.set(note.path,text);note.stat.size=new TextEncoder().encode(text).byteLength;return text;}};
  const desktopVault={...vault,adapter:{...adapter,getBasePath:()=> 'C:/synthetic-desktop-vault'}},engine=new KnowledgeEngine({vault:desktopVault});
  const scope={mode:'folders',include:['Research'],exclude:[],tags:[],tagMode:'any'};
  const index=await engine.build({files:desktopVault.getMarkdownFiles(),scope,embeddingRoute:'lexical',semanticRoute:'none',consent:true});reads.length=0;adapterCalls.length=0;
  if(withIndex)data.set(DIR+'/knowledge-index.json',JSON.stringify(index));
  if(phoneCacheOnly){data.delete(DIR+'/knowledge-index.json');data.set(DIR+'/knowledge-index-mobile.json',JSON.stringify({...index,portableImport:{sourceIndexId:index.id}}));}
  const settings={mode:'openai',scope,knowledge:{embeddingRoute:'lexical',semanticRoute:'none'},archive:{folder:'Notework/Chats',autoSave:false}};
  const secrets=new SecretStore({getSecret:name=>secretValues.get(name)||'',setSecret:(name,value)=>secretValues.set(name,value)},'notework-ai');
  const fetchImpl=createMobileFetch(async options=>{
    nativeCalls.push(options);const body=options.body?JSON.parse(options.body):null;
    const response=options.url.includes('/models')?{data:[{id:'fixture-module-model'}]}:{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:body.input[0].content[0].text.startsWith('This is a connection test.')?'Connection confirmed.':'Answer grounded in ALLOWED_MOBILE_SOURCE.'}]}]};
    return{status:200,headers:{},text:JSON.stringify(response)};
  });
  const providers=Object.fromEntries(['openai','anthropic'].map(provider=>[provider,new ApiKeyProvider({provider,secrets,fetchImpl,streamResponses:false})]));
  const knowledgeEngine=new KnowledgeEngine({vault,getTags:()=>[]}),syncStore=new SyncKnowledgeStore({adapter});
  const controller=new ConnectionController({providers,availableModes:['openai','anthropic'],retrievalStrategy:'lexical',requiresSyncedIndex:true,secrets,vault,getTags:()=>[],isArchiveFile:()=>false,isPromptFile:()=>false,promptLibrary:new PromptLibrary({vault,folder:'Notework/Prompts'}),settings,saveSettings:async()=>{savedData=structuredClone(settings);},knowledgeEngine,syncStore,indexStore:new KnowledgeIndexStore({adapter,directory:DIR,device:'mobile',syncedSourceLoader:()=>syncStore.load()}),archive:new ConversationArchive({vault})});
  assert.equal(adapterCalls.length,0,'Constructing reusable modules must keep knowledge loading explicit.');
  assert.equal(reads.length,0);assert.equal(nativeCalls.length,0);
  if(initialize)await controller.initializeRuntime();
  return{controller,data,files,index,reads,nativeCalls,secretValues,adapterCalls,settings:()=>savedData};
}

test('reusable synced-knowledge controller keeps export loading and verification explicit',async()=>{
  const h=await host({withIndex:false,initialize:false}),controller=h.controller;
  assert.equal(controller.state.knowledge.phase,'empty');assert.equal(h.adapterCalls.length,0);
  h.data.set(DEFAULT_SYNC_KNOWLEDGE_PATH,JSON.stringify(normalizeSyncKnowledgeIndex(h.index)));await controller.loadSyncKnowledge();
  assert.equal(controller.state.knowledge.phase,'import-required');assert.equal(controller.state.knowledge.pendingImport.id,h.index.id);assert.equal(h.reads.length,0);
  await controller.importSyncedKnowledge({consent:true});assert.equal(controller.state.knowledge.phase,'ready');assert.equal(controller.state.knowledge.index.nodes.length,1);assert.ok(h.reads.includes('Research/ontology.md'));assert.equal(h.nativeCalls.length,0);controller.dispose();
});

test('compiled desktop workspace and sidebar actions close the modal before revealing the working view',async()=>{
  class Plugin{constructor(app){this.app=app;}}
  const obsidian={Plugin,ItemView:class{},PluginSettingTab:class{},Platform:{isDesktopApp:true}};
  const sandbox={module:{exports:{}},exports:{},require:name=>{assert.equal(name,'obsidian');return obsidian;},console,setTimeout,clearTimeout};sandbox.exports=sandbox.module.exports;
  vm.runInNewContext(await readFile(new URL('../dist/notework-ai/main.js',import.meta.url),'utf8'),sandbox);
  const events=[],plugin=new sandbox.module.exports.default({setting:{close:()=>events.push('close-settings')}});
  plugin.host={openWorkspace:async()=>{events.push('workspace');return 'visible-workspace';},openPanel:async view=>{events.push('panel:'+view);return 'visible-panel';}};
  assert.equal(await plugin.openWorkspace({closeSettings:true}),'visible-workspace');assert.deepEqual(events,['close-settings','workspace']);
  events.length=0;await plugin.openWorkspace();assert.deepEqual(events,['workspace']);
  events.length=0;assert.equal(await plugin.openPanel('chat',{closeSettings:true}),'visible-panel');assert.deepEqual(events,['close-settings','panel:chat']);plugin.onunload();
});

test('reusable synced-knowledge controller blocks build and chat before PC source verification',async()=>{
  for(const options of [{withIndex:false},{phoneCacheOnly:true},{withIndex:true}]){
    const h=await host(options),controller=h.controller;controller.set({draft:'Ontology?',verified:true,consent:true});await controller.buildKnowledge({consent:true});assert.equal(controller.state.knowledge.index,null);await controller.ask();assert.match(controller.state.status,/PC-built knowledge/);assert.equal(h.nativeCalls.length,0);assert.equal(h.reads.length,0);
    await controller.connectMode('claude-code');assert.equal(controller.state.mode,'openai');assert.match(controller.state.status,/desktop/);await controller.refreshHistory();assert.equal(controller.state.history.length,0);controller.dispose();
  }
});

test('reusable portable modules verify scoped notes, perform synthetic API chat and preserve Unicode archives',async()=>{
  const h=await host(),controller=h.controller,pcCache=h.data.get(DIR+'/knowledge-index.json');await controller.importSyncedKnowledge({consent:true});assert.equal(controller.state.knowledge.phase,'ready');assert.equal(controller.state.knowledge.index.nodes.length,1);assert.ok(controller.state.knowledge.index.portableImport);assert.ok(h.data.has(DIR+'/knowledge-index-mobile.json'));assert.equal(h.data.get(DIR+'/knowledge-index.json'),pcCache);assert.ok(!h.reads.includes('Private/outside.md'));
  await controller.saveApiKey('openai','fixture-module-private-key');await controller.connect();await controller.verify();assert.equal(controller.state.verified,true);controller.set({draft:'Ontology 관계는 무엇인가?',consent:true});await controller.ask();assert.equal(controller.state.messages.length,2);assert.equal(controller.state.retrievalProof.route,'lexical');assert.equal(controller.state.sources[0].path,'Research/ontology.md');
  const paidBody=JSON.parse(h.nativeCalls.at(-1).body);assert.equal(paidBody.stream,false);assert.ok(paidBody.input[0].content[0].text.includes('ALLOWED_MOBILE_SOURCE'));assert.ok(!JSON.stringify(h.nativeCalls).includes('OUTSIDE_MOBILE_SOURCE'));
  const saved=await controller.saveConversation();assert.ok(saved.path.startsWith('Notework/Chats/'));assert.ok(h.data.get(saved.path).includes('Ontology 관계는 무엇인가?'));controller.newConversation();await controller.loadConversation(saved.id);assert.equal(controller.state.messages.length,2);assert.equal(controller.state.retrievalProof.route,'lexical');await controller.persist();assert.ok(!JSON.stringify(h.settings()).includes('fixture-module-private-key'));assert.ok(!h.data.get(saved.path).includes('fixture-module-private-key'));controller.dispose();
});

test('reusable portable cache requires its matching PC source; new PC index requires verification',async()=>{
  const memory=new Map(),adapter={exists:async path=>memory.has(path),read:async path=>memory.get(path),write:async(path,text)=>memory.set(path,text)},store=new KnowledgeIndexStore({adapter,directory:DIR,device:'mobile'});
  const desktop={schema:1,id:'pc-index',nodes:[],chunks:[],categories:[],scope:{mode:'all',include:[],exclude:[]}},mobile={...desktop,id:'phone-index',portableImport:{sourceIndexId:'pc-index'}};
  await store.save(mobile);assert.equal(await store.load(),null);memory.set(DIR+'/knowledge-index.json',JSON.stringify(desktop));assert.equal((await store.load()).id,'phone-index');memory.set(DIR+'/knowledge-index.json',JSON.stringify({...desktop,id:'new-pc-index'}));assert.equal((await store.load()).id,'new-pc-index');assert.equal(JSON.parse(memory.get(DIR+'/knowledge-index-mobile.json')).id,'phone-index');
  memory.set(DIR+'/knowledge-index-mobile.json','broken optional copy');assert.equal((await store.load()).id,'new-pc-index');assert.equal((await store.loadSyncedSource()).id,'new-pc-index');
});

test('reusable synced-knowledge scope widening re-verifies PC source instead of a pruned portable copy',async()=>{
  const h=await host(),c=h.controller;await c.importSyncedKnowledge({consent:true});assert.equal(c.state.knowledge.index.nodes.length,1);c.setScope({mode:'folders',include:['Private'],exclude:[]});assert.equal(c.state.knowledge.index,null);assert.equal(c.state.knowledge.pendingImport.id,h.index.id);await c.importSyncedKnowledge({consent:true});assert.equal(c.state.knowledge.index,null);assert.equal(c.state.knowledge.phase,'import-required');c.setScope({mode:'folders',include:['Research'],exclude:[]});await c.importSyncedKnowledge({consent:true});assert.equal(c.state.knowledge.index.nodes[0].path,'Research/ontology.md');assert.equal(h.nativeCalls.length,0);c.dispose();
});

test('disposing the reusable controller during portable initialization prevents late hashing and persistence',async()=>{
  let resolve,imports=0,saves=0;const controller=new ConnectionController({providers:{openai:{}},availableModes:['openai'],requiresSyncedIndex:true,settings:{mode:'openai',scope:{mode:'all'}},saveSettings:async()=>{},vault:{getMarkdownFiles:()=>[]},indexStore:{load:()=>new Promise(done=>{resolve=done;}),save:async()=>{saves++;}},knowledgeEngine:{vaultId:()=> 'phone',importPortableIndex:async()=>{imports++;return {};}}});const initializing=controller.initializeRuntime();await Promise.resolve();controller.dispose();resolve({vaultId:'phone',portableImport:{},nodes:[]});await initializing;assert.equal(imports,0);assert.equal(saves,0);assert.equal(controller.state.knowledge.index,null);
});

test('reusable synced-note controller never calls a provider after verified notes are deleted',async()=>{
  const h=await host(),c=h.controller;await c.importSyncedKnowledge({consent:true});await c.saveApiKey('openai','fixture-only');await c.connect();await c.verify();const calls=h.nativeCalls.length;h.files.delete('Research/ontology.md');c.set({draft:'Ontology?',consent:true});await c.ask();assert.match(c.state.status,/No unchanged synced PC notes/);assert.equal(h.nativeCalls.length,calls);assert.equal(c.state.messages.length,0);c.dispose();
});
