import test from 'node:test';
import assert from 'node:assert/strict';
import {ConnectionController} from '../src/controller.mjs';

function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
async function until(check){for(let i=0;i<100&&!check();i++)await new Promise(resolve=>setImmediate(resolve));assert(check(),'Expected asynchronous metadata update.');}
const installed=[{id:'nomic-embed-text:latest',capabilities:['embedding'],source:'local-installed'},{id:'embeddinggemma:latest',capabilities:['embedding'],source:'local-installed'}];
function fixture({key=null,models=installed,jevModels=[{id:'jev-version'},{id:'jev-latest'}],knowledge={},mobile=false,hardware}={}){
  const calls=[],saves=[],keys=new Map(key===null?[]:[['jev',key]]),hooks={};
  const secrets={get:async name=>{calls.push('key-presence');return hooks.get?hooks.get(name):keys.get(name);},set:async(name,value)=>{calls.push('key-save');if(hooks.save)await hooks.save(name,value);keys.set(name,value);},delete:async name=>{calls.push('key-remove');if(hooks.remove)await hooks.remove(name);keys.delete(name);}};
  const jev={models:[],listModels:async options=>{calls.push('jev-catalog');const values=hooks.jev?await hooks.jev(options):structuredClone(jevModels);jev.models=values;return values;},verify:async()=>assert.fail('No paid Jev connection test.'),classifyNotes:async()=>assert.fail('No Jev analysis.'),judgeRelations:async()=>assert.fail('No Jev relationships.')};
  const embeddingProvider={listModels:async options=>{calls.push('embedding-catalog');return hooks.embedding?hooks.embedding(options):structuredClone(models);},embed:async()=>assert.fail('No embeddings.'),prepareModel:async()=>assert.fail('No inference preparation.'),pullModel:async()=>assert.fail('No downloads.')};
  const provider={connect:async()=>{calls.push('chat-connect');},listModels:async()=>{calls.push('chat-catalog');return[{id:'chat-current'}];},generate:async()=>assert.fail('No answer generation.')};
  const settings={mode:'openai',scope:{mode:'all'},knowledge:{embeddingRoute:'lexical',semanticRoute:'none',...knowledge}};
  const controller=new ConnectionController({providers:{openai:provider},availableModes:['openai'],secrets,jev,embeddingProvider,hardware,requiresSyncedIndex:mobile,settings,saveSettings:async value=>{saves.push(structuredClone(value));if(hooks.persist)await hooks.persist();},vault:{getMarkdownFiles:()=>[],read:async()=>assert.fail('No note reads.'),cachedRead:async()=>assert.fail('No note reads.')}});
  return{controller,calls,saves,keys,hooks,jev,embeddingProvider,settings};
}

test('initial Build preparation selects an installed compact embedding and Jev latest using catalogs only',async()=>{
  const f=fixture({key:'PRIVATE_KEY_SENTINEL',knowledge:{embeddingRoute:'lexical',semanticRoute:'none'}}),c=f.controller;
  assert.equal(c.state.jevKeyPresent,null);assert.equal(c.state.buildModelPreparation.phase,'unchecked');assert.deepEqual(f.calls,[]);
  await c.prepareBuildModels();assert.equal(c.state.buildModelPreparation.phase,'ready');assert.equal(c.state.jevKeyPresent,true);assert.equal(c.state.jevKeyMissing,false);assert.equal(c.state.jevModel,'jev-latest');assert.equal(c.state.jevVerified,true);assert.equal(c.settings.knowledge.embeddingModel,'embeddinggemma:latest');assert.equal(c.state.embeddingAutoSelection.source,'automatic');assert.deepEqual([c.settings.knowledge.embeddingRoute,c.settings.knowledge.semanticRoute],['lexical','none']);assert.equal(f.saves.at(-1).knowledge.embeddingModel,'embeddinggemma:latest');assert(!JSON.stringify(c.state).includes('PRIVATE_KEY'));assert(!JSON.stringify(f.saves).includes('PRIVATE_KEY'));assert.equal(c.state.busy,false);
  const count=f.calls.length;await c.prepareBuildModels();assert.equal(f.calls.length,count);assert.deepEqual(new Set(f.calls),new Set(['embedding-catalog','key-presence','jev-catalog']));
});

test('valid saved embedding and current Jev choices survive automatic and explicit catalog refresh',async()=>{
  const f=fixture({key:'fixture',knowledge:{embeddingRoute:'ollama',semanticRoute:'jev',embeddingModel:'nomic-embed-text:latest'}}),c=f.controller;c.set({jevModel:'jev-version'});
  await c.prepareBuildModels();assert.equal(c.settings.knowledge.embeddingModel,'nomic-embed-text:latest');assert.equal(c.state.jevModel,'jev-version');assert.equal(c.state.embeddingAutoSelection.source,'saved');assert.equal(f.saves.length,0);await c.prepareBuildModels({refresh:true});assert.equal(c.state.jevModel,'jev-version');assert.equal(c.settings.knowledge.embeddingModel,'nomic-embed-text:latest');
});

test('missing key clears Jev readiness and invokes no Jev endpoint while local preparation remains usable',async()=>{
  const f=fixture(),c=f.controller;c.set({jevModels:[{id:'old'}],jevModel:'old',jevVerified:true});await c.prepareBuildModels();assert.equal(c.state.jevKeyPresent,false);assert.equal(c.state.jevKeyMissing,true);assert.equal(c.state.jevVerified,false);assert.deepEqual(c.state.jevModels,[]);assert.equal(c.state.jevModel,'');assert.equal(f.calls.includes('jev-catalog'),false);assert.equal(c.state.buildModelPreparation.phase,'ready');assert.match(c.state.jevStatus,/own Jev API key/);
});

test('automatic model selection rejects chat and cloud models and respects measured limited memory',async()=>{
  const models=[{id:'chat:latest',capabilities:['completion']},{id:'embeddinggemma:cloud',capabilities:['embedding']},{id:'remote:latest',capabilities:['embedding'],remote_host:'host'},{id:'all-minilm:latest',capabilities:['embedding'],source:'local-installed'},...installed];
  const f=fixture({models,hardware:()=>({ramGiB:3,freeGiB:1})});await f.controller.prepareBuildModels();assert.equal(f.settings.knowledge.embeddingModel,'all-minilm:latest');assert.deepEqual(f.controller.state.embeddingModels.map(model=>model.id),['all-minilm:latest',...installed.map(model=>model.id)]);
  const none=fixture({models:models.slice(0,3)});await none.controller.prepareBuildModels();assert.equal(none.settings.knowledge.embeddingModel,'');assert.equal(none.controller.state.embeddingAutoSelection.source,'none');assert.match(none.controller.state.embeddingAutoSelection.status,/No installed/);
});

test('unranked installed embeddings are chosen deterministically without downloads or chat-model fallback',async()=>{
  const f=fixture({models:[{id:'z-embedding:latest',capabilities:['embedding']},{id:'a-embedding:latest',capabilities:['embedding']}]});await f.controller.prepareBuildModels();assert.equal(f.settings.knowledge.embeddingModel,'a-embedding:latest');assert.equal(f.calls.includes('chat-catalog'),false);
});

test('concurrent Build entries share one metadata promise without changing chat busy or authentication',async()=>{
  const f=fixture({key:'fixture'}),c=f.controller,pending=deferred();f.hooks.embedding=()=>pending.promise;c.set({busy:true,connection:'catalog-confirmed',authenticated:true,verified:true,model:'chat-model',models:[{id:'chat-model'}],status:'Chat operation in progress.'});
  const first=c.prepareBuildModels(),second=c.prepareBuildModels({refresh:true});assert.equal(first,second);await until(()=>c.state.jevVerified);assert.equal(c.state.buildModelPreparation.phase,'loading');assert.equal(c.state.busy,true);assert.equal(c.state.model,'chat-model');assert.equal(c.state.status,'Chat operation in progress.');pending.resolve(installed);await first;assert.equal(f.calls.filter(call=>call==='embedding-catalog').length,1);assert.equal(f.calls.filter(call=>call==='jev-catalog').length,1);assert.equal(c.state.busy,true);assert.equal(c.state.authenticated,true);
});

test('Jev readiness publishes before slow or unavailable Ollama and remains usable after local discovery failure',async()=>{
  const f=fixture({key:'fixture'}),waiting=deferred();f.hooks.embedding=()=>waiting.promise;const preparing=f.controller.prepareBuildModels();await until(()=>f.controller.state.jevVerified);assert.equal(f.controller.state.jevModel,'jev-latest');waiting.reject(new Error('PRIVATE_FAILURE_SENTINEL'));await preparing;assert.equal(f.controller.state.buildModelPreparation.phase,'failed');assert.equal(f.controller.state.jevVerified,true);assert.equal(f.controller.state.embeddingDiscovery,'failed');assert(!JSON.stringify(f.controller.state).includes('PRIVATE_FAILURE'));assert.equal(f.settings.knowledge.embeddingRoute,'lexical');
});

test('manual embedding and Jev selections made during discovery cannot be overwritten by late metadata',async()=>{
  const f=fixture({key:'fixture'}),c=f.controller,local=deferred(),jev=deferred();f.hooks.embedding=()=>local.promise;f.hooks.jev=()=>jev.promise;const preparing=c.prepareBuildModels();await until(()=>f.calls.includes('jev-catalog'));c.configureKnowledge({embeddingModel:'nomic-embed-text:latest'});c.set({jevModel:'jev-version'});local.resolve(installed);jev.resolve([{id:'jev-latest'},{id:'jev-version'}]);await preparing;assert.equal(c.settings.knowledge.embeddingModel,'nomic-embed-text:latest');assert.equal(c.state.jevModel,'jev-version');assert.equal(c.state.jevVerified,true);
});

test('invalid manual selections stay explicit and are not silently replaced during metadata preparation',async()=>{
  const f=fixture({key:'fixture'}),c=f.controller,local=deferred(),jev=deferred();f.hooks.embedding=()=>local.promise;f.hooks.jev=()=>jev.promise;const preparing=c.prepareBuildModels();await until(()=>f.calls.includes('jev-catalog'));c.configureKnowledge({embeddingModel:'manual-missing'});c.set({jevModel:'manual-missing'});local.resolve(installed);jev.resolve([{id:'jev-latest'}]);await preparing;assert.equal(c.settings.knowledge.embeddingModel,'manual-missing');assert.equal(c.state.jevModel,'manual-missing');assert.equal(c.state.jevVerified,false);assert.match(c.state.embeddingAutoSelection.status,/not an installed/);assert.match(c.state.jevStatus,/not in the current catalog/);
});

test('save key starts catalog preparation automatically and never invokes Jev verify or systemone',async()=>{
  const f=fixture(),c=f.controller;await c.prepareBuildModels();assert.equal(f.calls.includes('jev-catalog'),false);await c.saveApiKey('jev','PRIVATE_NEW_KEY_SENTINEL');await until(()=>c.state.jevVerified&&c.state.buildModelPreparation.phase==='ready');assert.equal(c.state.jevKeyPresent,true);assert.equal(c.state.jevModel,'jev-latest');assert.equal(f.keys.get('jev'),'PRIVATE_NEW_KEY_SENTINEL');assert.equal(f.calls.filter(call=>call==='jev-catalog').length,1);assert(!JSON.stringify(c.state).includes('PRIVATE_NEW'));assert(!JSON.stringify(f.saves).includes('PRIVATE_NEW'));
});

test('removing a saved key cancels pending old-key discovery and discards its late controller and provider catalog',async()=>{
  const f=fixture({key:'old'}),c=f.controller,waiting=deferred();f.hooks.jev=()=>waiting.promise;const preparing=c.prepareBuildModels();await until(()=>f.calls.includes('jev-catalog'));await c.removeJev();await preparing;waiting.resolve([{id:'old-catalog-model'}]);await new Promise(resolve=>setImmediate(resolve));assert.equal(c.state.jevKeyPresent,false);assert.equal(c.state.jevKeyMissing,true);assert.equal(c.state.jevVerified,false);assert.equal(c.state.jevModel,'');assert.deepEqual(c.state.jevModels,[]);assert.deepEqual(f.jev.models,[]);assert.equal(f.keys.has('jev'),false);
});

test('replacing a key cancels old metadata and an old late catalog cannot replace the new catalog',async()=>{
  const f=fixture({key:'old'}),c=f.controller,waiting=deferred();let catalogCalls=0;f.hooks.jev=()=>++catalogCalls===1?waiting.promise:Promise.resolve([{id:'jev-latest'},{id:'new-model'}]);const old=c.prepareBuildModels();await until(()=>catalogCalls===1);await c.saveApiKey('jev','new');await until(()=>c.state.jevVerified&&c.state.jevModels.some(model=>model.id==='new-model'));await old;waiting.resolve([{id:'old-model'}]);await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(c.state.jevModels.map(model=>model.id),['jev-latest','new-model']);assert.deepEqual(f.jev.models.map(model=>model.id),['jev-latest','new-model']);assert.equal(c.state.jevModel,'jev-latest');
});

test('key mutation ordering prevents a late older save from undoing a subsequent removal',async()=>{
  const f=fixture(),c=f.controller,waiting=deferred();f.hooks.save=()=>waiting.promise;const saving=c.saveApiKey('jev','late-key');await until(()=>f.calls.includes('key-save'));const removing=c.removeJev();waiting.resolve();await Promise.all([saving,removing]);assert.equal(f.keys.has('jev'),false);assert.equal(c.state.jevKeyPresent,false);assert.equal(c.state.jevVerified,false);assert.equal(f.calls.includes('jev-catalog'),false);
});

test('stop or disposal cancels preparation immediately even if metadata adapters ignore abort',async()=>{
  for(const dispose of [false,true]){const f=fixture({key:'fixture'}),c=f.controller,waiting=deferred();let signal;f.hooks.embedding=options=>{signal=options.signal;return waiting.promise;};const pending=c.prepareBuildModels();await until(()=>f.calls.includes('embedding-catalog'));if(dispose)c.dispose();else c.stop();await pending;assert.equal(signal.aborted,true);waiting.resolve(installed);await new Promise(resolve=>setImmediate(resolve));assert.equal(c.settings.knowledge.embeddingModel,'');assert.notEqual(c.state.buildModelPreparation.phase,'ready');assert.equal(f.saves.length,0);}
});

test('mobile Build preparation does not read keys or call local discovery or Jev metadata',async()=>{
  const f=fixture({key:'fixture',mobile:true});await f.controller.prepareBuildModels({refresh:true});assert.equal(f.controller.state.buildModelPreparation.phase,'ready');assert.match(f.controller.state.buildModelPreparation.status,/synced PC/);assert.deepEqual(f.calls,[]);assert.equal(f.saves.length,0);assert.equal(f.controller.state.jevKeyPresent,null);
});

test('catalog and secret-storage failures use fixed safe messages and leave routes and chat readiness intact',async()=>{
  const f=fixture({key:'fixture'});f.hooks.jev=async()=>{throw new Error('PRIVATE_PROVIDER_BODY_SENTINEL');};await f.controller.prepareBuildModels();assert.equal(f.controller.state.buildModelPreparation.phase,'failed');assert.equal(f.controller.state.jevKeyPresent,true);assert.equal(f.controller.state.jevVerified,false);assert(!JSON.stringify(f.controller.state).includes('PRIVATE_PROVIDER'));
  const broken=fixture();broken.hooks.get=async()=>{throw new Error('PRIVATE_KEYSTORE_SENTINEL');};await broken.controller.prepareBuildModels();assert.equal(broken.controller.state.jevKeyPresent,null);assert.equal(broken.controller.state.buildModelPreparation.phase,'failed');assert.equal(broken.calls.includes('jev-catalog'),false);assert(!JSON.stringify(broken.controller.state).includes('PRIVATE_KEYSTORE'));
});

test('empty catalogs do not invent readiness or a model and malformed catalogs cannot enter state',async()=>{
  const empty=fixture({key:'fixture',models:[],jevModels:[]});await empty.controller.prepareBuildModels();assert.equal(empty.controller.state.jevVerified,false);assert.equal(empty.controller.state.jevModel,'');assert.equal(empty.settings.knowledge.embeddingModel,'');assert.equal(empty.controller.state.buildModelPreparation.phase,'ready');
  const malformed=fixture({key:'fixture',models:null,jevModels:[{id:''}]});await malformed.controller.prepareBuildModels();assert.equal(malformed.controller.state.buildModelPreparation.phase,'failed');assert.equal(malformed.controller.state.jevVerified,false);assert.deepEqual(malformed.controller.state.jevModels,[]);assert.deepEqual(malformed.controller.state.embeddingModels,[]);
});

test('explicit Jev model refresh preserves a valid manual choice instead of reverting to the first item',async()=>{
  const f=fixture({key:'fixture'});f.controller.set({jevModel:'jev-version'});await f.controller.loadJev();assert.equal(f.controller.state.jevModel,'jev-version');assert.equal(f.controller.state.jevVerified,true);assert.equal(f.calls.includes('embedding-catalog'),false);
});

test('a missing secret-storage reader leaves availability unknown and never calls Jev',async()=>{
  const f=fixture();f.controller.secrets={};await f.controller.prepareBuildModels();assert.equal(f.controller.state.jevKeyPresent,null);assert.equal(f.controller.state.jevKeyMissing,false);assert.equal(f.controller.state.buildModelPreparation.phase,'failed');assert.equal(f.calls.includes('jev-catalog'),false);
});

test('embedding capability must be an actual metadata array and cannot be inferred from a chat model name',async()=>{
  const f=fixture({models:[{id:'embeddinggemma:latest',capabilities:'embedding'},{id:'nomic-embed-text:latest',capabilities:['completion']}]});await f.controller.prepareBuildModels();assert.deepEqual(f.controller.state.embeddingModels,[]);assert.equal(f.settings.knowledge.embeddingModel,'');
});

test('stopping model discovery clears loading state so a later Build entry can prepare again',async()=>{
  const f=fixture(),waiting=deferred();f.hooks.embedding=()=>waiting.promise;const pending=f.controller.prepareBuildModels();f.controller.stop();await pending;assert.equal(f.controller.state.embeddingDiscovery,'unchecked');assert.equal(f.controller.state.buildModelPreparation.phase,'unchecked');f.hooks.embedding=null;await f.controller.prepareBuildModels();assert.equal(f.controller.state.embeddingDiscovery,'ready');waiting.resolve(installed);
});

test('failed or pending discovery blocks Ollama builds while explicit keyword builds remain possible',async()=>{
  const f=fixture({knowledge:{embeddingRoute:'ollama',embeddingModel:'nomic-embed-text:latest'}}),c=f.controller;let builds=0;c.vault.getMarkdownFiles=()=>[{path:'Scope/a.md'}];c.knowledgeEngine={build:async()=>{builds++;return{schema:1,id:'synthetic',nodes:[],chunks:[],categories:[],stats:{selectedNotes:1}};}};
  f.hooks.embedding=async()=>{throw new Error('PRIVATE_LOCAL_FAILURE');};await c.prepareBuildModels();await c.buildKnowledge({consent:true});assert.equal(builds,0);assert.match(c.state.knowledge.status,/refresh the models/);c.state.embeddingDiscovery='loading';await c.buildKnowledge({consent:true});assert.equal(builds,0);assert.match(c.state.knowledge.status,/finish loading/);c.configureKnowledge({embeddingRoute:'lexical'});await c.buildKnowledge({consent:true});assert.equal(builds,1);
});

test('an automatic selection whose persistence failed is saved again when preparation is retried',async()=>{
  const f=fixture();let writes=0;f.hooks.persist=async()=>{if(++writes===1)throw new Error('PRIVATE_WRITE_FAILURE');};await f.controller.prepareBuildModels();assert.equal(f.controller.state.buildModelPreparation.phase,'failed');assert(!JSON.stringify(f.controller.state).includes('PRIVATE_WRITE'));await f.controller.prepareBuildModels({refresh:true});assert.equal(f.controller.state.buildModelPreparation.phase,'ready');assert.equal(writes,2);assert.equal(f.saves.at(-1).knowledge.embeddingModel,'embeddinggemma:latest');
});
