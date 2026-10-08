import test from 'node:test';
import assert from 'node:assert/strict';
import {KnowledgeEngine,knowledgeChunkingForPolicy} from '../src/knowledge-engine.mjs';
import {knowledgeHierarchyLevels} from '../src/providers/jev.mjs';
import {sha256HexSync} from '../src/portable-crypto.mjs';
import {SyncKnowledgeStore,DEFAULT_SYNC_KNOWLEDGE_PATH,normalizeSyncKnowledgeIndex,normalizeSyncKnowledgePath} from '../src/sync-knowledge.mjs';

const TARGET=DEFAULT_SYNC_KNOWLEDGE_PATH,PENDING=TARGET+'.pending',PREVIOUS=TARGET+'.previous';
function vaultFixture(name='fixture-desktop',contents={'Research/a.md':'# Synthetic method\nA cat method [[b]].','Research/b.md':'# Synthetic reference\nA cat reference.'}){
  const values=new Map(Object.entries(contents).map(([path,text])=>[path,{text,file:{path,stat:{mtime:1,size:text.length}}}]));const reads=[];
  const vault={getName:()=>name,getMarkdownFiles:()=>[...values.values()].map(item=>item.file),getAbstractFileByPath:path=>values.get(path)?.file,read:async file=>{reads.push(file.path);return values.get(file.path).text;}};
  const engine=new KnowledgeEngine({vault,clock:()=>new Date('2026-10-07T00:00:00Z'),embeddingProvider:{prepareModel:async()=>({fingerprint:'fixture-weights'}),embed:async texts=>({dimension:2,fingerprint:'fixture-weights',vectors:texts.map(()=>[.6,.8])})}});
  return {values,reads,engine};
}
async function indexFixture({vector=false}={}){return vaultFixture().engine.build({consent:true,embeddingRoute:vector?'ollama':'lexical',embeddingModel:vector?'fixture-vector':'',semanticRoute:'none'});}

test('adaptive UTF-8 chunk policies survive export and local adoption without changing source hashes or byte limits',async()=>{
  const contents={'Research/a.md':'한글 원문 🧠 '.repeat(300)};const desktop=vaultFixture('adaptive-desktop',contents);desktop.engine.embeddingProvider.prepareModel=async()=>({fingerprint:'fixture-weights',contextLength:256});
  const index=await desktop.engine.build({consent:true,embeddingRoute:'ollama',embeddingModel:'fixture-vector',semanticRoute:'none'});const chunking=knowledgeChunkingForPolicy(index.chunkPolicy);
  assert(index.chunkPolicy.startsWith('knowledge-v2-'));assert(chunking);assert(index.chunks.length>1);assert(index.chunks.every(chunk=>Buffer.byteLength(chunk.text,'utf8')<=chunking.maxBytes));
  const h=adapterFixture();await h.store.export(index);const source=await h.store.load();assert.equal(source.chunkPolicy,index.chunkPolicy);assert.equal(source.nodes[0].contentHash,index.nodes[0].contentHash);
  const phone=vaultFixture('adaptive-phone',contents);const imported=await h.store.import({engine:phone.engine,consent:true});assert.equal(imported.chunkPolicy,index.chunkPolicy);assert.equal(imported.nodes[0].contentHash,index.nodes[0].contentHash);assert.deepEqual(imported.chunks.map(chunk=>chunk.text),index.chunks.map(chunk=>chunk.text));
});

test('adaptive policy byte bounds reject multilingual oversized chunks even when all original hash and character spans remain valid',async()=>{
  const contents={'Research/a.md':'한글 문장 🧠 '.repeat(300)};const desktop=vaultFixture('adaptive-byte-check',contents);const legacy=await desktop.engine.build({consent:true,embeddingRoute:'lexical',semanticRoute:'none'});
  desktop.engine.embeddingProvider.prepareModel=async()=>({fingerprint:'fixture-weights',contextLength:256});const adaptive=await desktop.engine.build({consent:true,embeddingRoute:'ollama',embeddingModel:'fixture-vector',semanticRoute:'none'});const chunking=knowledgeChunkingForPolicy(adaptive.chunkPolicy);
  legacy.chunkPolicy=adaptive.chunkPolicy;assert(legacy.chunks.some(chunk=>chunk.text.length<=chunking.maxChars&&Buffer.byteLength(chunk.text,'utf8')>chunking.maxBytes));
  assert.throws(()=>normalizeSyncKnowledgeIndex(legacy),{code:'INVALID_SYNC_KNOWLEDGE'});const h=adapterFixture();await assert.rejects(h.store.export(legacy),{code:'INVALID_SYNC_KNOWLEDGE'});assert.equal(h.events.length,0);
});

test('sync policy allowlist rejects malformed or malicious dynamic policies before writes',async()=>{
  const index=await indexFixture();const h=adapterFixture();for(const chunkPolicy of ['knowledge-v3-char1800-utf81024-overlap200','knowledge-v2-char999999999-utf8999999999-overlap0','knowledge-v2-char1800-utf81e3-overlap200','knowledge-v2-char1800-utf8512-overlap999999','knowledge-v2-char1800-utf8512-overlap200/../']){
    await assert.rejects(h.store.export({...index,chunkPolicy}),{code:'INVALID_SYNC_KNOWLEDGE'});
  }assert.equal(h.events.length,0);
});
function adapterFixture(initial=[]){
  const values=new Map(initial),folders=new Set(),events=[],hooks={before:null,after:null};
  const mutate=async(event,action)=>{events.push(event);await hooks.before?.(event);const result=action();await hooks.after?.(event);return result;};
  const adapter={
    exists:async path=>values.has(path)||folders.has(path),read:async path=>{if(!values.has(path))throw new Error('Missing fixture file');return values.get(path);},
    mkdir:async path=>mutate({kind:'mkdir',path},()=>{if(folders.has(path)||values.has(path))throw new Error('Already exists');folders.add(path);}),
    write:async(path,text)=>mutate({kind:'write',path},()=>values.set(path,text)),
    rename:async(from,to)=>mutate({kind:'rename',from,to},()=>{if(!values.has(from)||values.has(to)||folders.has(to))throw new Error('Rename destination must be absent');values.set(to,values.get(from));values.delete(from);}),
    remove:async path=>mutate({kind:'remove',path},()=>{if(!values.delete(path))throw new Error('Missing fixture file');})
  };
  return {adapter,values,folders,events,hooks,store:new SyncKnowledgeStore({adapter})};
}
function freeze(value){if(value&&typeof value==='object'){Object.freeze(value);Object.values(value).forEach(freeze);}return value;}

test('ordinary vault knowledge export preserves selected text, vectors and graph metadata while dropping all unknown settings, credentials and archive bodies',async()=>{
  const index=await indexFixture({vector:true});index.apiKey='TOP_PRIVATE_KEY';index.providerSettings={credential:'PROVIDER_PRIVATE_KEY'};index.messages=[{content:'ARCHIVE_PRIVATE_BODY'}];index.embedding.apiKey='EMBEDDING_PRIVATE_KEY';index.nodes[0].apiKey='NODE_PRIVATE_KEY';index.nodes[0].evidence.secret='EVIDENCE_PRIVATE_KEY';index.chunks[0].apiKey='CHUNK_PRIVATE_KEY';index.edges[0].evidence.apiKey='EDGE_PRIVATE_KEY';index.stats.apiKey='STATS_PRIVATE_KEY';index.portableImport={sourceIndexId:index.id,verifiedNotes:2,secret:'FORGED_ADOPTION'};
  freeze(index);const before=JSON.stringify(index);const h=adapterFixture();const result=await h.store.export(index);const raw=h.values.get(TARGET),exported=JSON.parse(raw);
  assert.equal(result.path,'Notework/Sync/knowledge-index.json');assert.equal(result.bytes,Buffer.byteLength(raw));assert.equal(result.noteCount,2);assert.deepEqual(exported.chunks[0].vector,index.chunks[0].vector);assert.equal(exported.chunks[0].text,index.chunks[0].text);assert.deepEqual(exported.edges.map(edge=>edge.kind),index.edges.map(edge=>edge.kind));assert.equal(JSON.stringify(index),before);assert.ok(!raw.includes('PRIVATE_'));assert.ok(!Object.hasOwn(exported,'portableImport'));assert.equal(h.values.size,1);assert.ok(h.events.every(event=>![event.path,event.from,event.to].filter(Boolean).some(path=>path.startsWith('.obsidian'))));
});
test('constructor and a missing sync source perform no exports and load returns null',async()=>{const h=adapterFixture();assert.equal(await h.store.load(),null);assert.deepEqual(h.events,[]);});
test('load only returns a sanitized source; adoption requires local verification and returns current vault identity',async()=>{
  const index=await indexFixture();const h=adapterFixture();await h.store.export(index);const source=await h.store.load();assert.equal(source.vaultId,index.vaultId);assert.equal(Object.hasOwn(source,'portableImport'),false);
  const phone=vaultFixture('fixture-phone');await assert.rejects(h.store.import({engine:phone.engine}),{code:'KNOWLEDGE_IMPORT_CONSENT_REQUIRED'});assert.equal(phone.reads.length,0);
  await assert.rejects(phone.engine.retrieve({index:source,question:'cat',retrievalStrategy:'lexical'}),{code:'INVALID_KNOWLEDGE_INDEX'});
  const imported=await h.store.import({engine:phone.engine,consent:true});assert.equal(imported.vaultId,phone.engine.vaultId());assert.equal(imported.portableImport.sourceIndexId,index.id);assert.equal(imported.portableImport.verifiedNotes,2);assert.ok(phone.reads.length>=4);assert.equal(h.values.size,1);
});
test('changed or scope-excluded original notes cannot enter an adopted mobile index',async()=>{
  const index=await indexFixture();const h=adapterFixture();await h.store.export(index);const phone=vaultFixture('fixture-phone');phone.values.get('Research/a.md').text='Changed content of a selected original note.';
  const imported=await h.store.import({engine:phone.engine,consent:true});assert.deepEqual(imported.nodes.map(node=>node.path),['Research/b.md']);assert.deepEqual(imported.portableImport.invalidatedPaths,['Research/a.md']);
  await assert.rejects(h.store.import({engine:phone.engine,consent:true,scope:{include:['Missing']}}),{code:'EMPTY_KNOWLEDGE_IMPORT'});
});
test('literal sync paths reject traversal, absolute, desktop-only, encoded and hidden configuration paths before adapter writes',()=>{
  const h=adapterFixture();for(const path of ['../outside.json','Notework/../outside.json','C:/outside.json','C:\\outside.json','/outside.json','\\\\host\\share.json','.obsidian/knowledge-index.json','.Obsidian/knowledge-index.json','visible/.obsidian/index.json','Notework//index.json','Notework/%2e%2e/index.json','Notework/index.json?x=1','Notework/index.txt',' Notework/index.json','Notework/.hidden.json','Notework/CON.json','Notework/AUX/index.json','Notework./index.json','Notework/*/index.json'])assert.throws(()=>new SyncKnowledgeStore({adapter:h.adapter,path}),{code:'INVALID_SYNC_PATH'});
  assert.equal(normalizeSyncKnowledgePath('한글 폴더/knowledge-index.json'),'한글 폴더/knowledge-index.json');assert.equal(h.events.length,0);
});
test('malicious JSON indexes, duplicate ownership and schema/provider changes are rejected before export mutation',async()=>{
  const index=await indexFixture();const h=adapterFixture();
  const changes=[value=>value.schema=2,value=>value.chunkPolicy='unknown',value=>value.vaultId='C:/desktop-only',value=>value.embedding.route='cloud',value=>value.semantic.route='untrusted',value=>value.nodes.push({...value.nodes[0]}),value=>value.chunks[0].path='../outside.md',value=>value.chunks[0].text='Fabricated unmatched length',value=>value.nodes[0].chunkIds=[value.nodes[1].chunkIds[0]],value=>value.edges[0].source='foreign-node',value=>value.scope.include=['/outside'],value=>value.nodes[0].evidence.chunks[0].quote='fabricated'];
  for(const mutate of changes){const bad=structuredClone(index);mutate(bad);await assert.rejects(h.store.export(bad),error=>['INVALID_SYNC_KNOWLEDGE','INVALID_SYNC_PATH'].includes(error.code));}
  assert.equal(h.events.length,0);const withProto=JSON.parse(JSON.stringify(index));Object.defineProperty(withProto.nodes[0],'__proto__',{value:{polluted:true},enumerable:true});assert.throws(()=>normalizeSyncKnowledgeIndex(withProto),{code:'INVALID_SYNC_KNOWLEDGE'});assert.equal({}.polluted,undefined);
});
test('invalid dimensions, nonfinite or zero vectors are rejected while valid normalized vectors remain byte-for-byte numeric values',async()=>{
  const index=await indexFixture({vector:true});for(const vector of [[0,0],[1],[NaN,.8],[Infinity,0],[2,0],[.3,.4]]){const malformed=structuredClone(index);malformed.chunks[0].vector=vector;assert.throws(()=>normalizeSyncKnowledgeIndex(malformed),{code:'INVALID_SYNC_KNOWLEDGE'});}
  assert.deepEqual(normalizeSyncKnowledgeIndex(index).chunks[0].vector,index.chunks[0].vector);
});
test('cosine rounding just above one is clamped only in the export copy so portable verification retains the edge',async()=>{
  const index=await indexFixture({vector:true});index.edges[0].weight=1+Number.EPSILON;const normalized=normalizeSyncKnowledgeIndex(index);assert.equal(normalized.edges[0].weight,1);assert.equal(index.edges[0].weight,1+Number.EPSILON);
  const h=adapterFixture();await h.store.export(index);const phone=vaultFixture('fixture-phone');const imported=await h.store.import({engine:phone.engine,consent:true});assert.equal(imported.edges.length,index.edges.length);index.edges[0].weight=1.001;assert.throws(()=>normalizeSyncKnowledgeIndex(index),{code:'INVALID_SYNC_KNOWLEDGE'});
});
test('a complete sparse-vector index above four million scalars exports within the byte budget without dropping selected notes',async()=>{
  const index=await indexFixture({vector:true});const sampleNode=index.nodes[0],sampleChunk=index.chunks.find(chunk=>chunk.id===sampleNode.chunkIds[0]);const vector=Array(16384).fill(0);vector[0]=1;index.embedding.dimension=vector.length;index.nodes=[];index.chunks=[];index.edges=[];
  for(let at=0;at<257;at++){
    const path='Research/synthetic-'+at+'.md';const id='chunk_'+sha256HexSync(JSON.stringify([path,sampleChunk.contentHash,sampleChunk.start,sampleChunk.end])).slice(0,24);
    index.chunks.push({...sampleChunk,id,path,vector});index.nodes.push({...sampleNode,id:'note_'+sha256HexSync(path).slice(0,20),path,chunkIds:[id],evidence:{...sampleNode.evidence,path,chunks:sampleNode.evidence.chunks.map(quote=>({...quote,path,chunkId:id}))}});
  }
  for(const category of index.categories)category.count=index.nodes.filter(node=>node.category===category.id).length;for(const layer of index.layers)layer.count=index.nodes.filter(node=>node.layer===layer.id).length;index.stats.selectedNotes=index.stats.indexedNotes=index.stats.chunks=257;index.hierarchyLevels=knowledgeHierarchyLevels(index.nodes);
  const h=adapterFixture();const result=await h.store.export(index);assert.ok(result.bytes<64*1024*1024);assert.equal(result.noteCount,257);assert.equal(result.chunkCount,257);const source=await h.store.load();assert.equal(source.nodes.length,257);assert.equal(source.chunks.length*source.embedding.dimension,4210688);assert.equal(source.chunks.at(-1).vector[0],1);assert.equal(source.chunks.at(-1).vector.at(-1),0);
});
test('UTF-8 serialized limits apply to both export and import before committed bytes change',async()=>{
  const index=await indexFixture();const h=adapterFixture([[TARGET,JSON.stringify(index)]]);const small=new SyncKnowledgeStore({adapter:h.adapter,maxBytes:10});await assert.rejects(small.export(index),{code:'SYNC_KNOWLEDGE_TOO_LARGE'});assert.equal(h.events.length,0);await assert.rejects(small.load(),{code:'SYNC_KNOWLEDGE_TOO_LARGE'});
  const raw='한'.repeat(10);h.values.set(TARGET,raw);const bounded=new SyncKnowledgeStore({adapter:h.adapter,maxBytes:20});await assert.rejects(bounded.load(),{code:'SYNC_KNOWLEDGE_TOO_LARGE'});
});
test('atomic replacement succeeds with a rename adapter that refuses existing destinations',async()=>{
  const index=await indexFixture();const h=adapterFixture();await h.store.export(index);const next=structuredClone(index);next.builtAt='2026-10-07T01:00:00.000Z';await h.store.export(next);
  assert.equal((await h.store.load()).builtAt,next.builtAt);assert.equal(h.values.size,1);assert.ok(!h.values.has(PREVIOUS));assert.ok(!h.values.has(PENDING));
});
test('cancellation after staging, old-file backup, replacement or backup cleanup restores the exact previous committed bytes',async()=>{
  const index=await indexFixture();const oldRaw=JSON.stringify(index);const next={...index,builtAt:'2026-10-07T02:00:00.000Z'};
  for(const step of ['stage','backup','replace','cleanup']){
    const h=adapterFixture([[TARGET,oldRaw]]);const abort=new AbortController();let triggered=false;
    h.hooks.after=event=>{if(triggered)return;const matches=step==='stage'&&event.kind==='write'&&event.path===PENDING||step==='backup'&&event.kind==='rename'&&event.to===PREVIOUS||step==='replace'&&event.kind==='rename'&&event.to===TARGET||step==='cleanup'&&event.kind==='remove'&&event.path===PREVIOUS;if(matches){triggered=true;abort.abort();}};
    await assert.rejects(h.store.export(next,{signal:abort.signal}),{name:'AbortError'});assert.equal(h.values.get(TARGET),oldRaw,step);assert.equal(h.values.size,1,step);assert.equal((await h.store.load()).builtAt,index.builtAt);
  }
});
test('cancellation of a first export after replacement leaves no falsely committed sync file',async()=>{
  const index=await indexFixture();const h=adapterFixture();const abort=new AbortController();h.hooks.after=event=>{if(event.kind==='rename'&&event.to===TARGET)abort.abort();};await assert.rejects(h.store.export(index,{signal:abort.signal}),{name:'AbortError'});assert.equal(h.values.size,0);assert.equal(await h.store.load(),null);
});
test('pre-aborted export and import do not write or read original notes',async()=>{
  const index=await indexFixture();const h=adapterFixture();const abort=new AbortController();abort.abort();await assert.rejects(h.store.export(index,{signal:abort.signal}),{name:'AbortError'});const phone=vaultFixture('phone');await assert.rejects(h.store.import({engine:phone.engine,consent:true,signal:abort.signal}),{name:'AbortError'});assert.equal(h.events.length,0);assert.equal(phone.reads.length,0);
});
test('staging corruption and replacement failure retain old bytes and discard uncommitted stage files',async()=>{
  const index=await indexFixture();const oldRaw=JSON.stringify(index);
  for(const kind of ['corrupt-stage','rename-failure']){
    const h=adapterFixture([[TARGET,oldRaw]]);let once=false;h.hooks.after=event=>{if(kind==='corrupt-stage'&&event.kind==='write'&&event.path===PENDING)h.values.set(PENDING,'CORRUPTED');};h.hooks.before=event=>{if(kind==='rename-failure'&&!once&&event.kind==='rename'&&event.from===PENDING){once=true;throw new Error('Fixture rename failure');}};
    await assert.rejects(h.store.export(index));assert.equal(h.values.get(TARGET),oldRaw);assert.equal(h.values.size,1);
  }
});
test('load recovers a valid prior export and refuses a corrupted recovery file without destroying the target',async()=>{
  const index=await indexFixture();const oldRaw=JSON.stringify(index);const h=adapterFixture([[TARGET,'uncommitted file'],[PREVIOUS,oldRaw],[PENDING,'uncommitted stage']]);assert.equal((await h.store.load()).id,index.id);assert.equal(h.values.get(TARGET),oldRaw);assert.equal(h.values.size,1);
  const broken=adapterFixture([[TARGET,oldRaw],[PREVIOUS,'malicious invalid recovery JSON']]);await assert.rejects(broken.store.load(),{code:'INVALID_SYNC_KNOWLEDGE'});assert.equal(broken.values.get(TARGET),oldRaw);assert.equal(broken.events.length,0);
});
test('adapters without atomic replacement are refused without a direct-write fallback',async()=>{
  const index=await indexFixture();const h=adapterFixture();const adapter={exists:h.adapter.exists,read:h.adapter.read,write:h.adapter.write};const store=new SyncKnowledgeStore({adapter});await assert.rejects(store.export(index),{code:'SYNC_ATOMIC_UNAVAILABLE'});assert.equal(h.events.length,0);
});
test('separate store instances on the same adapter and path serialize operations so a reader cannot observe replacement gaps',async()=>{
  const index=await indexFixture();const h=adapterFixture();await h.store.export(index);const next={...index,builtAt:'2026-10-07T03:00:00.000Z'};let release;const gate=new Promise(resolve=>{release=resolve;});let entered;const started=new Promise(resolve=>{entered=resolve;});h.hooks.after=async event=>{if(event.kind==='rename'&&event.to===PREVIOUS){entered();await gate;}};
  const exportWork=h.store.export(next);await started;const second=new SyncKnowledgeStore({adapter:h.adapter});let loaded=false;const loadWork=second.load().then(value=>{loaded=true;return value;});await Promise.resolve();assert.equal(loaded,false);release();await exportWork;assert.equal((await loadWork).builtAt,next.builtAt);
});


test('typed hierarchy assignments, confidence and ordered metadata survive export, load and mobile import exactly',async()=>{
  const desktop=vaultFixture();desktop.engine.jev={classifyNotes:async({notes,categories})=>({model:'fixture-jev',notes:notes.map((note,i)=>({id:note.id,category:categories[0].id,layer:'reference',hierarchyLevel:i?'detail':'overview',hierarchyConfidence:i ? .55 : .91}))}),judgeRelations:async({pairs})=>({pairs:pairs.map(pair=>({...pair,kind:'none',relatedProbability:0,score:0}))})};
  const index=await desktop.engine.build({consent:true,semanticRoute:'jev',semanticModel:'fixture-jev'});index.hierarchyLevels[0].label='Overview';index.hierarchyLevels[0].description='A portable hierarchy definition.';const h=adapterFixture();await h.store.export(index);const loaded=await h.store.load();
  assert.deepEqual(loaded.hierarchyLevels,index.hierarchyLevels);assert.deepEqual(loaded.nodes.map(node=>[node.hierarchyLevel,node.evidence.hierarchyConfidence]),index.nodes.map(node=>[node.hierarchyLevel,node.evidence.hierarchyConfidence]));assert.equal(loaded.semantic.hierarchyPolicy,index.semantic.hierarchyPolicy);
  const phone=vaultFixture('fixture-phone');const imported=await h.store.import({engine:phone.engine,consent:true});assert.deepEqual(imported.hierarchyLevels,index.hierarchyLevels);assert.deepEqual(imported.nodes.map(node=>[node.hierarchyLevel,node.evidence.hierarchyConfidence]),index.nodes.map(node=>[node.hierarchyLevel,node.evidence.hierarchyConfidence]));assert.equal(imported.semantic.hierarchyPolicy,index.semantic.hierarchyPolicy);
});

test('legacy schema-one sync assigns absent hierarchy to unassigned without inventing confidence',async()=>{
  const legacy=await indexFixture();delete legacy.hierarchyLevels;delete legacy.semantic.hierarchyPolicy;for(const node of legacy.nodes){delete node.hierarchyLevel;delete node.evidence.hierarchyConfidence;node.evidence.status='classified';node.evidence.route='jev';node.evidence.model='fixture-jev';}legacy.semantic.route='jev';legacy.semantic.model='fixture-jev';
  const raw=JSON.stringify(legacy);const h=adapterFixture([[TARGET,raw]]);const loaded=await h.store.load();assert(loaded.nodes.every(node=>node.hierarchyLevel==='unassigned'&&!Object.hasOwn(node.evidence,'hierarchyConfidence')));assert.equal(loaded.hierarchyLevels.find(level=>level.id==='unassigned').count,2);assert(!Object.hasOwn(loaded.semantic,'hierarchyPolicy'));const phone=vaultFixture('fixture-phone');const imported=await h.store.import({engine:phone.engine,consent:true});assert(imported.nodes.every(node=>node.hierarchyLevel==='unassigned'));assert.equal(h.values.get(TARGET),raw);
});

test('invalid sync hierarchy IDs, confidence, ordering and counts are rejected before adapter mutation',async()=>{
  const index=await indexFixture();const h=adapterFixture();
  for(const mutate of [value=>value.nodes[0].hierarchyLevel='parent',value=>value.nodes[0].hierarchyLevel=null,value=>value.nodes[0].evidence.hierarchyConfidence=1.1,value=>value.nodes[0].evidence.hierarchyConfidence=NaN,value=>value.nodes[0].evidence.hierarchyConfidence='0.7',value=>value.hierarchyLevels[0].depth=8,value=>value.hierarchyLevels[0].count=1,value=>value.hierarchyLevels.reverse(),value=>value.hierarchyLevels.pop(),value=>value.semantic.hierarchyPolicy='unknown']){const bad=structuredClone(index);mutate(bad);await assert.rejects(h.store.export(bad),{code:'INVALID_SYNC_KNOWLEDGE'});}assert.equal(h.events.length,0);
});
