import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {SecretStore} from '../src/secret-store.mjs';

test('portable secret IDs keep every existing desktop credential lookup unchanged',async()=>{
  const values=new Map();const names=['jev','api-openai','api-anthropic','chatgpt.session','chatgpt-host-config','한국어 🧠'];
  const storage={getSecret:key=>values.get(key),setSecret:(key,value)=>values.set(key,value)};const store=new SecretStore(storage);
  for(const name of names){const id='notework-ai-'+createHash('sha256').update(name).digest('hex').slice(0,32);values.set(id,'synthetic-'+name);assert.equal(store.id(name),id);assert.equal(await store.get(name),'synthetic-'+name);await store.set(name,'updated-fixture');assert.equal(values.get(id),'updated-fixture');await store.delete(name);assert.equal(values.get(id),'');assert.equal(await store.get(name),null);}
  assert.equal(new SecretStore(storage,'custom').id('jev'),'custom-'+createHash('sha256').update('jev').digest('hex').slice(0,32));
});
test('credential storage still requires Obsidian SecretStorage and never silently persists plaintext',async()=>{
  for(const storage of [null,{}, {getSecret(){}}])assert.throws(()=>new SecretStore(storage),/SecretStorage support is required/);
  let calls=0;const store=new SecretStore({getSecret:()=>null,setSecret:()=>{calls++;}});await assert.rejects(store.set('jev',{}),/Invalid credential format/);assert.equal(calls,0);
});

test('reload instances keep every credential ID and never rewrite or delete values merely by being constructed',async()=>{
  const values=new Map(),mutations=[];const storage={getSecret:async key=>values.get(key),setSecret:(key,value)=>{mutations.push(key);values.set(key,value);}};
  const before=new SecretStore(storage,'notework-ai');
  for(const name of ['api-openai','api-anthropic','jev','chatgpt.session','chatgpt-host-config'])values.set(before.id(name),'synthetic-preserved-'+name);
  const replacement=new SecretStore(storage,'notework-ai');
  for(const name of ['api-openai','api-anthropic','jev','chatgpt.session','chatgpt-host-config']){assert.equal(replacement.id(name),before.id(name));assert.equal(await replacement.get(name),'synthetic-preserved-'+name);}
  assert.deepEqual(mutations,[]);
});

test('asynchronous writes are awaited and stores using the same backend serialize the same key',async()=>{
  const values=new Map(),started=[];let finish;
  const storage={getSecret:async key=>values.get(key),setSecret:async(key,value)=>{started.push(value);if(value==='first')await new Promise(resolve=>{finish=resolve;});values.set(key,value);}};
  const original=new SecretStore(storage),replacement=new SecretStore(storage);
  let completed=false;const first=original.set('chatgpt.session','first').then(()=>{completed=true;});
  await Promise.resolve();await Promise.resolve();assert.equal(completed,false);
  const second=replacement.set('chatgpt.session','second'),reading=replacement.get('chatgpt.session');
  await Promise.resolve();assert.deepEqual(started,['first']);finish();await Promise.all([first,second]);assert.equal(await reading,'second');assert.equal(await replacement.get('chatgpt.session'),'second');
});

test('write failures reach the caller without deleting other stored credentials',async()=>{
  const values=new Map();let fail=false;const storage={getSecret:key=>values.get(key),setSecret:async(key,value)=>{if(fail)throw new Error('Synthetic storage failure');values.set(key,value);}};
  const store=new SecretStore(storage);await store.set('api-openai','synthetic-retained');fail=true;
  await assert.rejects(store.set('api-anthropic','synthetic-new'),/Synthetic storage failure/);assert.equal(await store.get('api-openai'),'synthetic-retained');assert.equal(await store.get('api-anthropic'),null);
});
