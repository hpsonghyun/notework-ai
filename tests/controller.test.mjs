import test from 'node:test';
import assert from 'node:assert/strict';
import {ConnectionController} from '../src/controller.mjs';
import {selectedFiles,searchVault} from '../src/vault-search.mjs';
import {SecretStore} from '../src/secret-store.mjs';
import {JevProvider} from '../src/providers/jev.mjs';
function structureResponse(input){const data=JSON.parse(input.split('\nDATA_JSON\n')[1]);return JSON.stringify({cards:data.cards.map(card=>({id:card.id,parentId:null,relation:'start',topic:'Synthetic research'}))});}

function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function fixture({getTags,scope}={}) {
  const calls=[];const values=new Map();
  const files=[{path:'notes/a.md',stat:{size:20}},{path:'notes/sub/b.md',stat:{size:20}},{path:'notes-copy/private.md',stat:{size:20}},{path:'secret/c.md',stat:{size:20}}];
  const vault={getMarkdownFiles:()=>files,getAbstractFileByPath:p=>files.find(f=>f.path===p),cachedRead:async f=>'연구 질문 '+f.path};
  const provider=(name)=>({connect:async()=>{calls.push(name+':connect');},listModels:async()=>{calls.push(name+':models');return [{id:name+'-arbitrary-live-model',name:name+' model'}];},generate:async(input,{signal,onDelta}={})=>{calls.push({provider:name,input});if(input.startsWith('NOTEWORK_CONVERSATION_STRUCTURE_V1'))return structureResponse(input);onDelta?.('연결 ');return '연결 확인';},disconnect:async()=>({connected:false})});
  const providers=Object.fromEntries(['chatgpt','claude-code','openai','anthropic','ollama'].map(name=>[name,provider(name)]));
  const secrets={get:async name=>values.get(name),set:async(name,value)=>values.set(name,value),delete:async name=>values.delete(name)};
  const settings={mode:'chatgpt',scope:scope || {mode:'all',include:[],exclude:[]}};
  let writes=[];
  const controller=new ConnectionController({providers,jev:{listModels:async()=>[],verify:async()=>{}},secrets,vault,getTags,settings,saveSettings:async settings=>writes.push(structuredClone(settings))});
  return {controller,providers,secrets,values,calls,vault,files,writes};
}
test('new plugin defaults to subscription without any provider call',()=>{const f=fixture();assert.equal(f.controller.state.mode,'chatgpt');assert.equal(f.calls.length,0);});
test('choosing Claude while ChatGPT login waits cancels the old flow and starts Claude',async()=>{
  const f=fixture();const pending=deferred();let oldSignal;
  f.providers.chatgpt.connect=({signal})=>{oldSignal=signal;return pending.promise;};
  const old=f.controller.connectMode('chatgpt');assert.equal(f.controller.state.busy,true);
  await f.controller.connectMode('claude-code');assert.equal(oldSignal.aborted,true);assert.equal(f.controller.state.mode,'claude-code');assert.equal(f.controller.state.connection,'catalog-confirmed');
  pending.resolve();await old;assert.equal(f.controller.state.model,'claude-code-arbitrary-live-model');assert.equal(f.controller.state.busy,false);
});
test('Claude installation failure preserves a safe actionable code without claiming connection',async()=>{
  const f=fixture();f.providers['claude-code'].connect=async()=>{throw Object.assign(new Error('공식 설치가 필요합니다.'),{code:'CLI_NOT_FOUND'});};
  await f.controller.connectMode('claude-code');assert.equal(f.controller.state.connection,'failed');assert.equal(f.controller.state.connectionIssue,'CLI_NOT_FOUND');assert.equal(f.controller.state.busy,false);assert.equal(f.controller.state.verified,false);assert.equal(f.controller.state.status,'공식 설치가 필요합니다.');
});
test('official Claude login URL is transient, clears on stop, and late login status is ignored',async()=>{
  const f=fixture();const pending=deferred();let onStatus;
  f.providers['claude-code'].connect=({onStatus:report})=>{onStatus=report;report({state:'waiting-login',message:'브라우저 로그인 대기',loginUrl:'https://claude.ai/oauth/authorize?state=fixture'});return pending.promise;};
  const run=f.controller.connectMode('claude-code');assert.ok(f.controller.state.loginUrl.startsWith('https://claude.ai/'));await f.controller.persist();assert.ok(!JSON.stringify(f.writes).includes('oauth/authorize'));
  f.controller.stop();onStatus({state:'waiting-login',message:'late',loginUrl:'https://claude.ai/oauth/authorize?state=late'});pending.resolve();await run;assert.equal(f.controller.state.loginUrl,'');assert.equal(f.controller.state.status,'Operation stopped.');
});
test('Claude login links reject untrusted origins and reconnect forwards explicit account selection',async()=>{
  const f=fixture();const pending=deferred();let received;
  f.providers['claude-code'].connect=options=>{received=options;options.onStatus({state:'waiting-login',message:'기다리는 중',loginUrl:'https://claude.ai.evil.example/oauth'});return pending.promise;};
  const run=f.controller.connectMode('claude-code',{newAccount:true});assert.equal(received.newAccount,true);assert.equal(f.controller.state.loginUrl,'');
  received.onStatus({state:'waiting-login',loginUrl:'https://user:password@claude.ai/oauth'});assert.equal(f.controller.state.loginUrl,'');
  pending.resolve();await run;assert.equal(f.controller.state.connection,'catalog-confirmed');
});
test('authenticated live catalog makes chat ready without a paid test request',async()=>{const f=fixture();await f.controller.connect();assert.equal(f.controller.state.verified,true);assert.equal(f.controller.state.authenticated,true);assert.equal(f.controller.state.inferenceConfirmed,false);assert.equal(f.controller.state.connection,'catalog-confirmed');assert.equal(f.calls.filter(x=>typeof x==='object').length,0);f.controller.set({draft:'연구 질문',consent:true});await f.controller.ask();await f.controller.mapPromise;assert.equal(f.calls.filter(x=>typeof x==='object').length,2);assert(f.calls.filter(x=>typeof x==='object')[1].input.startsWith('NOTEWORK_CONVERSATION_STRUCTURE_V1'));assert.equal(f.controller.state.messages.length,2);assert.equal(f.controller.state.inferenceConfirmed,true);});
test('changing provider, selected model, account login, or API key invalidates consent',async()=>{const f=fixture();f.controller.set({consent:true});f.controller.selectMode('openai');assert.equal(f.controller.state.consent,false);await f.controller.connect();f.controller.set({consent:true});f.controller.selectModel(f.controller.state.model);assert.equal(f.controller.state.consent,false);f.controller.set({consent:true});await f.controller.saveApiKey('openai','fixture-key');assert.equal(f.controller.state.consent,false);f.controller.set({consent:true});await f.controller.connect();assert.equal(f.controller.state.consent,false);});
test('stale catalog response after provider change cannot replace a new connection',async()=>{const f=fixture();const pending=deferred();f.providers.chatgpt.listModels=()=>pending.promise;const old=f.controller.connect();await Promise.resolve();f.controller.selectMode('openai');await f.controller.connect();const model=f.controller.state.model;pending.resolve([{id:'stale',name:'stale'}]);await old;assert.equal(f.controller.state.mode,'openai');assert.equal(f.controller.state.model,model);});
test('first real question reports quota failure without a test, API retry or fallback',async()=>{const f=fixture();await f.controller.connect();let requests=0;f.providers.chatgpt.generate=async()=>{requests++;throw new Error('구독 한도 초과');};f.controller.set({draft:'연구 질문',consent:true});await f.controller.ask();await f.controller.mapPromise;assert.equal(requests,1);assert.equal(f.controller.state.verified,true);assert.equal(f.controller.state.inferenceConfirmed,false);assert.equal(f.controller.state.mode,'chatgpt');assert.equal(f.controller.state.messages.length,0);assert.ok(f.controller.state.status.includes('한도'));assert.ok(!f.calls.some(x=>typeof x==='object'&&x.provider==='openai'));});
test('asking without transmission consent makes no note read or request',async()=>{const f=fixture();await f.controller.connect();await f.controller.verify();const count=f.calls.length;let reads=0;f.vault.cachedRead=async()=>{reads++;return '';};f.controller.set({draft:'연구 질문',consent:false});await f.controller.ask();await f.controller.mapPromise;assert.equal(reads,0);assert.equal(f.calls.length,count);});
test('selected folder boundary and excluded folder restrict actual transmitted context',async()=>{const f=fixture();await f.controller.connect();await f.controller.verify();f.controller.setScope({mode:'folders',include:['notes','notes/sub'],exclude:['notes/sub']});f.controller.set({draft:'연구 질문',consent:true});await f.controller.ask();await f.controller.mapPromise;assert.equal(f.calls.filter(x=>typeof x==='object'&&x.input.startsWith('NOTEWORK_CONVERSATION_STRUCTURE_V1')).length,1);const request=f.calls.filter(x=>typeof x==='object'&&!x.input.startsWith('NOTEWORK_CONVERSATION_STRUCTURE_V1')).at(-1);assert.ok(request.input.includes('notes/a.md'));assert.ok(!request.input.includes('notes-copy/private.md'));assert.ok(!request.input.includes('notes/sub/b.md'));assert.deepEqual(f.controller.state.sources.map(x=>x.path),['notes/a.md']);});
test('folder selection with no folders selects zero notes rather than entire vault',()=>{const f=fixture();assert.equal(selectedFiles(f.files,{mode:'folders',include:[],exclude:[]}).length,0);});
test('scope with parent-child overlaps is deduplicated; exclusion wins',()=>{const f=fixture();assert.deepEqual(selectedFiles(f.files,{mode:'folders',include:['notes','notes/sub'],exclude:['notes/sub']}).map(x=>x.path),['notes/a.md']);});
test('scope rejects absolute or traversing paths before writing settings',()=>{const f=fixture();assert.throws(()=>f.controller.setScope({include:['../secret'],exclude:[]}));assert.equal(f.writes.length,0);assert.throws(()=>selectedFiles(f.files,{include:['C:/vault'],exclude:[]}));});
test('a note moving outside scope during cachedRead is not included',async()=>{const f=fixture();f.vault.cachedRead=async file=>{file.path='secret/moved.md';return '연구 질문';};const result=await searchVault(f.vault,'연구',{mode:'folders',include:['notes'],exclude:[]});assert.equal(result.length,0);});
test('cancel during note read rejects before returning sources',async()=>{const f=fixture();const pending=deferred();f.vault.cachedRead=()=>pending.promise;const abort=new AbortController();const run=searchVault(f.vault,'연구',{include:['notes'],exclude:[]},{signal:abort.signal});abort.abort();pending.resolve('연구 질문');await assert.rejects(run,{name:'AbortError'});});
test('empty catalog refresh before connect does not advertise false readiness',async()=>{const f=fixture();await f.controller.refreshModels();assert.equal(f.calls.length,0);assert.equal(f.controller.state.connection,'unconfigured');});
test('late disconnect cannot clear a newly selected connection and reports revoke warnings',async()=>{const f=fixture();await f.controller.connect();const pending=deferred();f.providers.chatgpt.disconnect=()=>pending.promise;const old=f.controller.disconnect();f.controller.selectMode('openai');await f.controller.connect();const model=f.controller.state.model;pending.resolve({warning:'원격 해제 확인 필요'});await old;assert.equal(f.controller.state.model,model);assert.equal(f.controller.state.mode,'openai');f.providers.openai.disconnect=async()=>({warning:'원격 해제 확인 필요'});await f.controller.disconnect();assert.equal(f.controller.state.status,'원격 해제 확인 필요');});
test('late key save does not clear newer provider models',async()=>{const f=fixture();f.controller.selectMode('openai');const pending=deferred();f.secrets.set=()=>pending.promise;const old=f.controller.saveApiKey('openai','fixture-key');f.controller.selectMode('anthropic');await f.controller.connect();const model=f.controller.state.model;pending.resolve();await old;assert.equal(f.controller.state.model,model);});
test('ordinary persisted settings never include credential text',async()=>{const f=fixture();await f.controller.saveApiKey('openai','fixture-private-value');f.controller.selectMode('openai');await Promise.resolve();assert.ok(!JSON.stringify(f.writes).includes('fixture-private-value'));assert.equal(f.values.get('api-openai'),'fixture-private-value');});
test('API disconnect clears only its own key',async()=>{const f=fixture();f.values.set('api-openai','first');f.values.set('api-anthropic','second');f.controller.selectMode('openai');await f.controller.disconnect();assert.equal(f.values.has('api-openai'),false);assert.equal(f.values.get('api-anthropic'),'second');});
test('SecretStorage uses private valid IDs, one atomic token value, and clears only owned key',async()=>{const values=new Map();const store=new SecretStore({getSecret:k=>values.get(k),setSecret:(k,v)=>values.set(k,v)});await store.set('chatgpt.session','{"accessToken":"fixture"}');await store.set('jev','other');assert.match(store.id('chatgpt.session'),/^[a-z0-9-]+$/);assert.equal(await store.get('chatgpt.session'),'{"accessToken":"fixture"}');await store.delete('chatgpt.session');assert.equal(await store.get('chatgpt.session'),null);assert.equal(await store.get('jev'),'other');});
test('Jev malformed provider JSON is sanitized before reaching the UI',async()=>{const jev=new JevProvider({secrets:{get:async()=> 'fixture-key'},fetchImpl:async()=>({ok:true,json:async()=>{throw new SyntaxError('fixture-private-echo');}})});await assert.rejects(jev.listModels(),error=>error.code==='JEV_BODY_INVALID_JSON'&&error.phase==='reading-response'&&!error.message.includes('fixture-private-echo')&&!error.message.includes('fixture-key'));});
test('Jev catalog and short typed request use only personal key, no vault text',async()=>{const calls=[];const jev=new JevProvider({secrets:{get:async()=> 'fixture-key'},fetchImpl:async(url,init)=>{calls.push({url,init});return {ok:true,json:async()=>url.endsWith('/models')?{models:[{name:'jev-fixture-model'}]}:{model:'jev-fixture-model',answers:{connection:{type:'noul',noul:.9}}}};}});await jev.listModels();await jev.verify({model:'jev-fixture-model'});assert.equal(calls[1].url,'https://api.typesafe.ai/v1/systemone');assert.ok(JSON.parse(calls[1].init.body).state.includes('No vault notes'));assert.equal(calls[1].init.headers.Authorization,'Bearer fixture-key');});

test('folder and tag selections persist together and survive a new controller',async()=>{
  const getTags=file=>file.path==='notes/a.md'?['#research/ai']:[];const f=fixture({getTags});
  f.controller.set({consent:true,answer:'Previous answer',sources:[{path:'secret/c.md'}]});
  f.controller.setScope({mode:'folders',include:['notes'],exclude:['notes/sub'],tags:['Research','research'],excludeTags:['#private'],untrustedField:'drop'});await Promise.resolve();
  assert.deepEqual(f.writes.at(-1).scope,{mode:'folders',include:['notes'],exclude:['notes/sub'],tags:['#research'],excludeTags:['#private']});
  assert.equal(f.controller.state.consent,false);assert.equal(f.controller.state.answer,'');assert.deepEqual(f.controller.state.sources,[]);
  const restored=fixture({getTags,scope:f.writes.at(-1).scope});assert.deepEqual(restored.controller.state.scope,f.controller.state.scope);assert.deepEqual(restored.controller.scopeFiles().map(x=>x.path),['notes/a.md']);
});
test('current official Claude login URL reaches the card, stays transient and clears after connection',async()=>{
  const f=fixture();const pending=deferred();let report;
  const url='https://claude.com/cai/oauth/authorize?code=true&state=fixture&code_challenge=fixture';
  f.providers['claude-code'].connect=({onStatus})=>{report=onStatus;onStatus({state:'waiting-login',loginUrl:url});return pending.promise;};
  const run=f.controller.connectMode('claude-code',{newAccount:true});assert.equal(f.controller.state.loginUrl,url);
  await f.controller.persist();assert.ok(!JSON.stringify(f.writes).includes('oauth/authorize'));
  for(const unsafe of [url.replace('code=true','code=returned-private-code'),url+'#private',url.replace('claude.com','claude.com.evil.example')]){report({state:'waiting-login',loginUrl:unsafe});assert.equal(f.controller.state.loginUrl,'');}
  report({state:'waiting-login',loginUrl:url});pending.resolve();await run;assert.equal(f.controller.state.loginUrl,'');assert.equal(f.controller.state.connection,'catalog-confirmed');
});
test('manual Claude browser code is forwarded transiently while waiting and never persisted',async()=>{
 const f=fixture();const pending=deferred();let input;
 f.providers['claude-code'].connect=({onStatus})=>{onStatus({state:'waiting-login',loginUrl:'https://claude.com/cai/oauth/authorize?code=true&state=fixture'});return pending.promise;};
 f.providers['claude-code'].submitLoginCode=async value=>{input=value;return true;};
 assert.equal(await f.controller.submitClaudeLoginCode('fixture-login-code'),false);
 const run=f.controller.connectMode('claude-code',{newAccount:true});assert.equal(await f.controller.submitClaudeLoginCode('fixture-login-code'),true);assert.equal(input,'fixture-login-code');
 await f.controller.persist();assert.ok(!JSON.stringify(f.writes).includes('fixture-login-code'));assert.ok(!JSON.stringify(f.controller.state).includes('fixture-login-code'));
 f.controller.stop();input=null;assert.equal(await f.controller.submitClaudeLoginCode('fixture-login-code'),false);assert.equal(input,null);pending.resolve();await run;
});
test('controller retrieval reads and sends only the intersection of folders and nested tags',async()=>{
  const getTags=file=>file.path==='notes/a.md'?['#research/ai']:file.path==='notes/sub/b.md'?['#other']:['#research/ai'];const f=fixture({getTags});const reads=[];f.vault.cachedRead=async file=>{reads.push(file.path);return 'Research evidence '+file.path;};
  await f.controller.connect();await f.controller.verify();f.controller.setScope({mode:'folders',include:['notes'],exclude:[],tags:['#research'],excludeTags:[]});f.controller.set({draft:'Research',consent:true});await f.controller.ask();await f.controller.mapPromise;
  assert.deepEqual([...new Set(reads)],['notes/a.md']);assert.deepEqual(f.controller.state.sources.map(x=>x.path),[...new Set(reads)]);assert.equal(f.calls.filter(x=>typeof x==='object'&&x.input.startsWith('NOTEWORK_CONVERSATION_STRUCTURE_V1')).length,1);const request=f.calls.filter(x=>typeof x==='object'&&!x.input.startsWith('NOTEWORK_CONVERSATION_STRUCTURE_V1')).at(-1);assert.ok(request.input.includes('notes/a.md'));assert.ok(!request.input.includes('notes/sub/b.md'));assert.ok(!request.input.includes('notes-copy/private.md'));assert.ok(!request.input.includes('secret/c.md'));
});
test('controller tag exclusions and unknown metadata prevent reads before AI transmission',async()=>{
  const getTags=file=>file.path==='notes/a.md'?['#research','#private/internal']:file.path==='notes/sub/b.md'?null:['#research'];const f=fixture({getTags});const reads=[];f.vault.cachedRead=async file=>{reads.push(file.path);return 'Research';};
  await f.controller.connect();await f.controller.verify();f.controller.setScope({mode:'folders',include:['notes'],exclude:[],tags:['#research'],excludeTags:['#private']});f.controller.set({draft:'Research',consent:true});await f.controller.ask();await f.controller.mapPromise;assert.deepEqual(reads,[]);assert.deepEqual(f.controller.state.sources,[]);assert.equal(f.controller.state.progress,null);
});
test('invalid tag scope is rejected before replacing accepted selections or saving',()=>{
  const f=fixture({getTags:()=>[]});const before=structuredClone(f.controller.state.scope);assert.throws(()=>f.controller.setScope({mode:'all',include:[],exclude:[],tags:['invalid tag']}));assert.deepEqual(f.controller.state.scope,before);assert.equal(f.writes.length,0);
});

