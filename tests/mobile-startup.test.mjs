import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import vm from 'node:vm';

const PAUSED_NOTICE='Notework AI is currently desktop-only. Mobile support is paused.';
const MOBILE={isMobileApp:true,isMobile:true,isDesktopApp:false};

async function fixture(options={}) {
  const behavior=options.behavior||'saved',platform=Object.hasOwn(options,'platform')?options.platform:MOBILE;
  const calls=[],required=[],notices=[];
  // A saved legacy key and hostile settings must remain completely unread.
  const saved=new Proxy({mode:'codex',apiKey:'synthetic-legacy-private-key',scope:{mode:'all'},mobile:{mode:'openai'}},{get(_target,key){calls.push('saved.'+String(key));assert.fail('Blocked startup must not inspect saved settings or credentials.');}});
  const forbidden=name=>(..._args)=>{calls.push(name);assert.fail('Blocked startup attempted '+name);};
  class Plugin {
    constructor(app,manifest){this.app=app;this.manifest=manifest;this.views=new Map();this.commands=[];}
    async loadData(){
      calls.push('loadData');
      if(behavior==='pending')return new Promise(()=>{});
      if(behavior==='throwing')throw new Error('Synthetic unreadable plugin settings.');
      return saved;
    }
    async saveData(){forbidden('saveData')();}
    register(){forbidden('register')();}
    registerEvent(){forbidden('registerEvent')();}
    registerView(name,callback){this.views.set(name,callback);forbidden('registerView')();}
    addRibbonIcon(){forbidden('addRibbonIcon')();}
    addCommand(command){this.commands.push(command);forbidden('addCommand')();}
    addSettingTab(tab){this.tab=tab;forbidden('addSettingTab')();}
  }
  class ItemView{constructor(){forbidden('ItemView')();}}
  class PluginSettingTab{constructor(){forbidden('PluginSettingTab')();}}
  const obsidian={Plugin,ItemView,PluginSettingTab,Notice:class{constructor(message){notices.push(message);}},getAllTags:forbidden('getAllTags'),Platform:platform,requestUrl:forbidden('requestUrl')};
  const sandbox={module:{exports:{}},exports:{},require:name=>{required.push(name);if(name==='obsidian')return obsidian;throw new Error('Unexpected blocked-platform import: '+name);},crypto:webcrypto,TextEncoder,TextDecoder,URL,URLSearchParams,AbortController,AbortSignal,DOMException,ArrayBuffer,Uint8Array,structuredClone,console,
    setTimeout:forbidden('setTimeout'),clearTimeout:forbidden('clearTimeout'),window:{open:forbidden('window.open')},document:new Proxy({},{get:forbidden('document')})};
  sandbox.exports=sandbox.module.exports;
  const context=vm.createContext(sandbox);
  assert.equal(vm.runInContext('typeof Buffer+":"+typeof process',context),'undefined:undefined');
  vm.runInContext(await readFile(new URL('../dist/notework-ai/main.js',import.meta.url),'utf8'),context,{filename:'notework-blocked-platform-main.js'});
  // Any app access covers secrets, vault adapters, query enumeration, indexes,
  // listeners, layout recovery and UI mounting before they can be used.
  const app=new Proxy({},{get(_target,key){calls.push('app.'+String(key));assert.fail('Blocked startup must not access the app.');}});
  const plugin=new sandbox.module.exports.default(app,{id:'notework-ai',dir:'.obsidian/plugins/notework-ai',version:'0.4.7',isDesktopOnly:false});
  for(const method of ['mount','registerVaultObservers','restoreAfterLayout','restoreSavedConnection'])plugin[method]=forbidden(method);
  return{plugin,calls,required,notices};
}

async function promptly(operation) {
  let timer;
  try{return await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Blocked plugin startup waited for settings or storage.')),250);})]);}
  finally{clearTimeout(timer);}
}

function assertBlocked(f) {
  assert.deepEqual(f.calls,[],'The desktop-only guard must precede all settings, app and UI work.');
  assert.deepEqual(f.required,['obsidian'],'No Node or Electron dependency may load.');
  assert.deepEqual(f.notices,[PAUSED_NOTICE]);
  assert.equal(f.plugin.views.size,0);assert.equal(f.plugin.commands.length,0);assert.equal(f.plugin.tab,undefined);
  for(const key of ['settings','desktopSettings','mobileSettings','secrets','runtime','providers','jev','embeddingProvider','knowledgeEngine','syncStore','promptLibrary','controller','host','settingsTab','observersRegistered','restorePromise'])assert.equal(f.plugin[key],undefined,key+' must not initialize.');
}

for(const behavior of ['pending','throwing','saved'])test('compiled mobile startup returns before '+behavior+' loadData and all app access',async()=>{
  const f=await fixture({behavior});
  await promptly(f.plugin.onload());assertBlocked(f);
  assert.doesNotThrow(()=>f.plugin.onunload());assertBlocked(f);assert.equal(f.plugin.unloaded,true);
});

for(const [name,platform] of [
  ['mobile-app flag despite a desktop flag',{isDesktopApp:true,isMobileApp:true,isMobile:false}],
  ['mobile flag despite a desktop flag',{isDesktopApp:true,isMobileApp:false,isMobile:true}],
  ['non-desktop platform',{isDesktopApp:false,isMobileApp:false,isMobile:false}],
  ['missing desktop flag',{}],
  ['unknown platform',undefined],
  ['null platform',null]
])test('compiled startup blocks '+name+' even when legacy manifest permits mobile',async()=>{
  const f=await fixture({platform});await promptly(f.plugin.onload());assertBlocked(f);f.plugin.onunload();assertBlocked(f);
});

test('compiled desktop startup passes the guard and retains normal settings error handling',async()=>{
  const f=await fixture({behavior:'throwing',platform:{isDesktopApp:true,isMobileApp:false,isMobile:false}});
  await assert.rejects(f.plugin.onload(),/Synthetic unreadable plugin settings/);
  assert.deepEqual(f.calls,['loadData']);assert.deepEqual(f.required,['obsidian']);
  assert.deepEqual(f.notices,['Could not open Notework. Synthetic unreadable plugin settings.']);
  assert.doesNotThrow(()=>f.plugin.onunload());assert.deepEqual(f.calls,['loadData']);
});

test('compiled blocked startup shows the pause notice once and repeated unload remains safe',async()=>{
  const f=await fixture({behavior:'pending'});
  await promptly(f.plugin.onload());await promptly(f.plugin.onload());assertBlocked(f);
  assert.doesNotThrow(()=>f.plugin.onunload());assert.doesNotThrow(()=>f.plugin.onunload());assertBlocked(f);
});

test('compiled unload before any startup is safe and does not touch credentials or storage',async()=>{
  const f=await fixture();assert.doesNotThrow(()=>f.plugin.onunload());assert.doesNotThrow(()=>f.plugin.onunload());
  assert.deepEqual(f.calls,[]);assert.deepEqual(f.notices,[]);assert.equal(f.plugin.unloaded,true);
});
