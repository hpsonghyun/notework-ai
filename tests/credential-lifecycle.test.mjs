import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import {SecretStore} from '../src/secret-store.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
async function runtimeFixture(){
  const events=[],values=new Map();
  class Provider {
    constructor(options){this.options=options;this.active=new Set();}
    async connect(options){events.push({kind:'connect',options});return{connected:true};}
    async listModels(options){events.push({kind:'models',options});return[{id:'gpt-6.1-sol'}];}
    async generate(input,options){events.push({kind:'generate',options});return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));}
    disconnect(){assert.fail('Unload must never call disconnect.');}
  }
  class ChatGPT extends Provider {dispose(){events.push({kind:'chatgpt-dispose'});}}
  const sandbox={AbortController,AbortSignal,Set,JSON,Promise,Error,shell:{openExternal:()=>assert.fail('No browser login is allowed.')},os:{tmpdir:()=>'/synthetic-temp'},path,mkdir:async()=>{},ChatGPTSubscription:ChatGPT,CodexSubscriptionProvider:Provider,ClaudeCodeProvider:Provider,OllamaEmbeddingsProvider:Provider,desktopFetch:async(url,options)=>{events.push({kind:'fetch',url,options});return{ok:true};}};
  const source=(await readFile(new URL('../src/desktop-runtime.mjs',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'').replace('export async function createDesktopRuntime','async function createDesktopRuntime');
  vm.runInNewContext(source+'\nglobalThis.create=createDesktopRuntime;',sandbox);
  const secrets={get:async name=>values.get(name),set:async(name,value)=>{events.push({kind:'secret-write',name});values.set(name,value);},delete:async()=>assert.fail('Runtime cleanup cannot delete a credential.')};
  const runtime=await sandbox.create({secrets,settings:{claude:{}},pluginId:'notework-ai',saveSettings:async()=>events.push({kind:'settings-save'})});
  return{runtime,events,values};
}

test('desktop runtime cleanup cancels provider work and rejects future work without logout or credential writes',async()=>{
  const f=await runtimeFixture(),pending=f.runtime.providers.codex.generate('synthetic input',{model:'gpt-6.1-sol'});
  const cancelled=assert.rejects(pending,{name:'AbortError',code:'CANCELLED'});await Promise.resolve();f.runtime.dispose();f.runtime.dispose();await cancelled;
  await assert.rejects(f.runtime.providers.codex.connect({reuseSession:true}),{code:'CANCELLED'});await assert.rejects(f.runtime.fetch('https://api.openai.com/v1/models'),{code:'CANCELLED'});
  assert.equal(f.events.filter(event=>event.kind==='chatgpt-dispose').length,1);assert.equal(f.events.filter(event=>['fetch','secret-write','settings-save'].includes(event.kind)).length,0);
});

test('desktop cleanup closes only owned Codex sessions and Claude children, including replaced Claude providers',async()=>{
  const f=await runtimeFixture(),events=[];
  f.runtime.providers.codex.active.add({close:()=>events.push('codex-close')});
  f.runtime.providers['claude-code'].active.add({kill:signal=>events.push('initial-claude-'+signal)});
  const replacement=f.runtime.createClaude();replacement.active.add({kill:signal=>events.push('replacement-claude-'+signal)});
  f.runtime.dispose();f.runtime.dispose();assert.deepEqual(events,['codex-close','initial-claude-SIGTERM','replacement-claude-SIGTERM']);
  assert.throws(()=>f.runtime.createClaude(),{code:'CANCELLED'});assert.equal(f.events.filter(event=>event.kind==='secret-write').length,0);
});

test('disposing an old runtime during reload cannot close the replacement connection or abort its work',async()=>{
  const old=await runtimeFixture(),replacement=await runtimeFixture(),closed=[];
  replacement.runtime.providers.codex.active.add({close:()=>closed.push('replacement-closed')});
  old.runtime.dispose();assert.deepEqual(closed,[]);
  assert.equal((await replacement.runtime.providers.codex.connect({reuseSession:true})).connected,true);
  const pending=replacement.runtime.providers.codex.generate('synthetic replacement input',{model:'gpt-6.1-sol'}),cancelled=assert.rejects(pending,{code:'CANCELLED'});
  await Promise.resolve();const operation=replacement.events.find(event=>event.kind==='generate');assert.equal(operation.options.signal.aborted,false);assert.deepEqual(closed,[]);
  replacement.runtime.dispose();await cancelled;assert.deepEqual(closed,['replacement-closed']);
});

async function pluginClass(overrides={}){
  class Plugin{constructor(app,manifest){this.app=app;this.manifest=manifest;}register(){}registerEvent(){}registerView(){}addRibbonIcon(){}addCommand(){}addSettingTab(){}}
  const sandbox={Plugin,ItemView:class{},PluginSettingTab:class{constructor(app,plugin){this.app=app;this.plugin=plugin;}},Notice:class{},Platform:{isDesktopApp:true},SecretStore,normalizeScope:value=>value,normalizeArchiveFolder:value=>value,normalizePromptFolder:value=>value,normalizeKnowledgeSettings:value=>value,DEFAULT_PROMPT_FOLDER:'Notework/Prompts',Set,JSON,Promise,Error,setTimeout,clearTimeout,...overrides};
  const source=(await readFile(new URL('../src/main.mjs',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'').replace('export default class NoteworkPlugin','class NoteworkPlugin').replace("await (await import('./desktop-runtime.mjs')).createDesktopRuntime(",'await createDesktopRuntime(');
  vm.runInNewContext(source+'\nglobalThis.PluginClass=NoteworkPlugin;',sandbox);return sandbox.PluginClass;
}
async function restoreFixture({mode='codex',key=true,connected=true,connectHook}={}){
  const Class=await pluginClass(),events=[],values=new Map();let generation=0;
  const controller={epoch:0,disposed:false,state:{mode,busy:false,models:[],model:'',verified:false},set:patch=>Object.assign(controller.state,patch),
    connect:async options=>{events.push({kind:'connect',options});if(connectHook)return connectHook(options,controller);controller.epoch++;controller.state.models=[{id:'other'},{id:'gpt-6.1-sol'}];controller.state.model='other';controller.state.verified=true;},
    selectModel:(model,options)=>{events.push({kind:'select',model,options});controller.state.model=model;},dispose:()=>{controller.disposed=true;events.push({kind:'controller-dispose'});}};
  const plugin=new Class({}, {id:'notework-ai'});plugin.controller=controller;plugin.desktopSettings={model:'gpt-6.1-sol'};plugin.mobileSettings={};plugin.secrets={get:async name=>{events.push({kind:'key-presence',name});return key?'synthetic-preserved-value':null;},delete:async()=>assert.fail('Reload must retain credentials.')};
  plugin.providers={chatgpt:{status:async()=>({connected}),generate:async()=>{generation++;assert.fail('Restore must never infer.');}}};plugin.runtime={dispose:()=>events.push({kind:'runtime-dispose'})};
  return{plugin,controller,events,values,get generation(){return generation;}};
}

test('every saved subscription and API route reuses its connection and restores a listed saved model without inference',async()=>{
  for(const mode of ['codex','chatgpt','claude-code','openai','anthropic']){
    const f=await restoreFixture({mode});assert.equal(await f.plugin.restoreSavedConnection(),true);
    const connected=f.events.find(event=>event.kind==='connect');assert.deepEqual({...connected.options},{reuseSession:true});assert.deepEqual({...f.events.find(event=>event.kind==='select').options},{persist:false});assert.equal(f.controller.state.model,'gpt-6.1-sol');assert.equal(f.generation,0);
    assert.equal(f.events.some(event=>event.kind==='key-presence'),['openai','anthropic'].includes(mode));
  }
});

test('missing saved API key or unavailable ChatGPT grant never starts a reconnect or browser sign-in',async()=>{
  for(const options of [{mode:'openai',key:false},{mode:'anthropic',key:false},{mode:'chatgpt',connected:false},{mode:'ollama'}]){
    const f=await restoreFixture(options);assert.equal(await f.plugin.restoreSavedConnection(),false);assert.equal(f.events.filter(event=>event.kind==='connect').length,0);assert.equal(f.generation,0);
  }
});

test('route changes and unload during credential presence checks cannot restore a stale connection',async()=>{
  for(const operation of ['route','unload']){
    const f=await restoreFixture({mode:'openai'}),wait=deferred();f.plugin.secrets.get=async()=>wait.promise;
    const restoring=f.plugin.restoreSavedConnection();if(operation==='route')f.controller.state.mode='anthropic';else f.plugin.onunload();wait.resolve('synthetic-preserved-key');
    assert.equal(await restoring,false);assert.equal(f.events.filter(event=>event.kind==='connect').length,0);
  }
});

test('a later same-route operation or model selection cannot be overwritten by background restoration',async()=>{
  for(const operation of ['epoch','selection','unchanged']){
    const waiting=deferred(),f=await restoreFixture({connectHook:async(_options,controller)=>{controller.epoch++;await waiting.promise;controller.state.models=[{id:'default'},{id:'gpt-6.1-sol'},{id:'selected-by-user'}];controller.state.model=operation==='selection'?'selected-by-user':operation==='unchanged'?'gpt-6.1-sol':'default';controller.state.verified=true;}});
    const restoring=f.plugin.restoreSavedConnection();if(operation==='epoch')f.controller.epoch++;waiting.resolve();
    assert.equal(await restoring,operation!=='epoch');assert.equal(f.events.filter(event=>event.kind==='select').length,0);
    assert.equal(f.controller.state.model,operation==='selection'?'selected-by-user':operation==='unchanged'?'gpt-6.1-sol':'default');
  }
});

test('plugin unload cleans runtime even if controller cleanup throws and never disconnects an account',async()=>{
  const f=await restoreFixture();f.controller.dispose=()=>{throw new Error('Synthetic cleanup failure');};
  assert.throws(()=>f.plugin.onunload(),/Synthetic cleanup failure/);assert.equal(f.plugin.unloaded,true);assert.equal(f.events.filter(event=>event.kind==='runtime-dispose').length,1);
});

test('startup registration completes while saved connection metadata is still loading in the background',async()=>{
  const waiting=deferred(),initializing=deferred(),initializationStarted=deferred(),connectionStarted=deferred(),events=[],layoutCallbacks=[];
  class Controller{constructor({settings}){this.settings=settings;this.epoch=0;this.state={mode:settings.mode,busy:false,models:[],model:'',verified:false};}async initializeRuntime(){events.push({kind:'initialize'});initializationStarted.resolve();await initializing.promise;}async connect(options){events.push({kind:'connect',options});connectionStarted.resolve();await waiting.promise;this.state.models=[{id:'gpt-6.1-sol'}];this.state.model='gpt-6.1-sol';this.state.verified=true;}selectModel(){}dispose(){events.push({kind:'controller-dispose'});this.disposed=true;}set(patch){Object.assign(this.state,patch);}}
  const empty=class{constructor(){}};
  const Class=await pluginClass({ConnectionController:Controller,KnowledgeEngine:empty,SyncKnowledgeStore:empty,PromptLibrary:empty,KnowledgeIndexStore:empty,ConversationArchive:empty,WorkspaceHost:empty,ApiKeyProvider:empty,JevProvider:empty,PANEL_VIEW:'panel',GRAPH_VIEW:'graph',fileTags:()=>[],createDesktopRuntime:async()=>({providers:{codex:{}},fetch:()=>assert.fail('No network request.'),dispose:()=>events.push({kind:'runtime-dispose'})})});
  const app={secretStorage:{getSecret:()=>'',setSecret:()=>assert.fail('Startup must not alter credentials.')},vault:{adapter:{},configDir:'.obsidian',on:()=>({})},metadataCache:{on:()=>({})},workspace:{onLayoutReady:callback=>layoutCallbacks.push(callback)}};
  const plugin=new Class(app,{id:'notework-ai'});plugin.loadData=async()=>({mode:'codex',model:'gpt-6.1-sol',reasoningEffort:'high'});
  plugin.registerView=()=>events.push({kind:'view'});plugin.addSettingTab=()=>events.push({kind:'settings'});await plugin.onload();
  assert.equal(events.filter(event=>event.kind==='view').length,2);assert.equal(events.filter(event=>event.kind==='settings').length,1);assert.equal(events.filter(event=>['initialize','connect'].includes(event.kind)).length,0);
  layoutCallbacks[0]();await initializationStarted.promise;assert.equal(events.filter(event=>event.kind==='connect').length,0);assert.equal(plugin.controller.state.verified,false);
  initializing.resolve();await connectionStarted.promise;assert.equal(events.filter(event=>event.kind==='connect').length,1);assert.equal(plugin.controller.state.verified,false);
  waiting.resolve();await plugin.restorePromise;assert.equal(plugin.controller.state.verified,true);plugin.onunload();assert.equal(events.filter(event=>event.kind==='runtime-dispose').length,1);
});

test('unload before layout resolves restoration and prevents late initialization or observer registration',async()=>{
  const events=[],layoutCallbacks=[],empty=class{};
  class Controller{constructor(){this.epoch=0;this.state={mode:'codex',busy:false};}initializeRuntime(){assert.fail('An unloaded plugin cannot restore storage.');}dispose(){this.disposed=true;}set(){}}
  const Class=await pluginClass({ConnectionController:Controller,KnowledgeEngine:empty,SyncKnowledgeStore:empty,PromptLibrary:empty,KnowledgeIndexStore:empty,ConversationArchive:empty,WorkspaceHost:empty,ApiKeyProvider:empty,JevProvider:empty,PANEL_VIEW:'panel',GRAPH_VIEW:'graph',fileTags:()=>[],createDesktopRuntime:async()=>({providers:{codex:{}},dispose:()=>events.push('runtime-dispose')})});
  const app={secretStorage:{getSecret:()=>'',setSecret:()=>assert.fail('No credential writes.')},vault:{adapter:{},configDir:'.obsidian',on:()=>{events.push('observer');return{};}},metadataCache:{on:()=>{events.push('observer');return{};}},workspace:{onLayoutReady:callback=>layoutCallbacks.push(callback)}};
  const plugin=new Class(app,{id:'notework-ai'});plugin.loadData=async()=>({mode:'codex'});await plugin.onload();plugin.onunload();assert.equal(await plugin.restorePromise,false);layoutCallbacks[0]();assert.deepEqual(events,['runtime-dispose']);
});

test('a user route change during deferred storage restoration prevents automatic reconnect',async()=>{
  const f=await restoreFixture(),waiting=deferred();f.controller.initializeRuntime=()=>waiting.promise;
  const restoring=f.plugin.restoreAfterLayout();f.controller.state.mode='openai';f.controller.epoch++;waiting.resolve();assert.equal(await restoring,false);assert.equal(f.events.filter(event=>event.kind==='connect').length,0);f.plugin.onunload();
});

test('deferred storage failures report a recoverable state without reconnecting or rejecting startup',async()=>{
  const f=await restoreFixture();f.controller.initializeRuntime=async()=>{throw new Error('Synthetic unreadable index.');};
  assert.equal(await f.plugin.restoreAfterLayout(),false);assert.match(f.controller.state.status,/could not be restored/);assert.equal(f.events.filter(event=>event.kind==='connect').length,0);f.plugin.onunload();
});

test('unload during desktop runtime creation immediately disposes the late runtime without reading or deleting keys',async()=>{
  const waiting=deferred(),started=deferred(),events=[],empty=class{};
  const Class=await pluginClass({ApiKeyProvider:empty,createDesktopRuntime:async()=>{started.resolve();return waiting.promise;}});
  const app={secretStorage:{getSecret:()=>'',setSecret:()=>assert.fail('No credential writes allowed.')},vault:{adapter:{},configDir:'.obsidian'}};
  const plugin=new Class(app,{id:'notework-ai'});plugin.loadData=async()=>({mode:'codex'});const loading=plugin.onload();await started.promise;plugin.onunload();
  waiting.resolve({dispose:()=>events.push('late-runtime-dispose')});await loading;assert.deepEqual(events,['late-runtime-dispose']);assert.equal(plugin.controller,undefined);
});

test('installer retains the credential namespace and limits copies to the three executable plugin assets',async()=>{
  const source=await readFile(new URL('../install.ps1',import.meta.url),'utf8');
  assert(source.includes("$packageManifest.id -ne 'notework-ai'"));assert(source.includes("plugins/notework-ai"));
  const lists=[...source.matchAll(/foreach \(\$fileName in @\(([^)]+)\)\)/g)].map(match=>match[1]);
  assert.equal(lists.length,3);assert(lists.every(list=>list==="'main.js','manifest.json','styles.css'"));assert(!/Remove-Item|Clear-Content|data\.json|secretStorage|SecretStorage/.test(source));
});
