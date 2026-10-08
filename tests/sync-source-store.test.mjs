import test from 'node:test';
import assert from 'node:assert/strict';
import {KnowledgeIndexStore} from '../src/runtime-storage.mjs';

test('ordinary-vault PC export authorizes a matching mobile cache without requiring a hidden PC cache',async()=>{
  const source={schema:1,id:'pc-current',nodes:[],chunks:[],categories:[],scope:{mode:'all'}};
  const mobile={...source,id:'mobile-copy',portableImport:{sourceIndexId:source.id}};
  const values=new Map([['.obsidian/plugins/notework-ai/knowledge-index-mobile.json',JSON.stringify(mobile)]]);
  const adapter={exists:async path=>values.has(path),read:async path=>values.get(path)};
  const store=new KnowledgeIndexStore({adapter,directory:'.obsidian/plugins/notework-ai',device:'mobile',syncedSourceLoader:async()=>source});
  assert.equal((await store.loadSyncedSource()).id,source.id);assert.equal((await store.load()).id,mobile.id);
  const newer={...source,id:'pc-newer'};store.syncedSourceLoader=async()=>newer;
  assert.equal((await store.load()).id,newer.id);
  store.syncedSourceLoader=async()=>null;assert.equal(await store.load(),null);
});

test('a malformed ordinary export is never silently replaced by an older hidden source',async()=>{
  const store=new KnowledgeIndexStore({adapter:{exists:async()=>true,read:async()=>JSON.stringify({schema:1,id:'old',nodes:[],chunks:[],categories:[]})},directory:'.obsidian/plugins/notework-ai',device:'mobile',syncedSourceLoader:async()=>{throw new Error('Invalid exported knowledge.');}});
  await assert.rejects(store.load(),/Invalid exported knowledge/);
});
