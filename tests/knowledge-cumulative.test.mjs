import test from 'node:test';
import assert from 'node:assert/strict';
import {KnowledgeEngine,knowledgeChunkingForPolicy} from '../src/knowledge-engine.mjs';
import {ConnectionController} from '../src/controller.mjs';
import {KnowledgeIndexStore} from '../src/runtime-storage.mjs';
import {normalizeSyncKnowledgeIndex,SyncKnowledgeStore} from '../src/sync-knowledge.mjs';
import {computeIndexCoverage} from '../src/index-coverage.mjs';

const local={consent:true,embeddingRoute:'lexical',semanticRoute:'none'};
const folders=(...include)=>({mode:'folders',include});
function fixture(initial){
  const contents=new Map(),files=new Map(),reads=[],embeddingCalls=[],cache=new Map(),hooks={};let tick=0;
  const update=(path,text,tags=[])=>{contents.set(path,text);const file=files.get(path)||{path,stat:{mtime:0,size:0},tags};file.stat.mtime++;file.stat.size=Buffer.byteLength(text);file.tags=tags;files.set(path,file);};
  for(const [path,text] of Object.entries(initial))update(path,text);
  const adapter={getBasePath:()=> 'synthetic-cumulative-vault',exists:async path=>cache.has(path),read:async path=>{if(!cache.has(path))throw new Error('Missing cache');return cache.get(path);},write:async(path,data)=>{cache.set(path,data);await hooks.storage?.({phase:'write',path});},rename:async(from,to)=>{if(cache.has(to)||!cache.has(from))throw new Error('Unsafe rename');cache.set(to,cache.get(from));cache.delete(from);await hooks.storage?.({phase:'rename',from,to});},remove:async path=>{cache.delete(path);await hooks.storage?.({phase:'remove',path});}};
  const vault={adapter,getName:()=> 'Synthetic cumulative vault',getMarkdownFiles:()=>[...files.values()],getAbstractFileByPath:path=>files.get(path),read:async file=>{reads.push(file.path);await hooks.read?.(file);return contents.get(file.path);}};
  const metadata={fingerprint:'weights-one',dimension:2,contextLength:null};
  const embeddingProvider={prepareModel:async model=>({model,...metadata}),embed:async(texts,{model})=>{embeddingCalls.push({texts:[...texts],model});await hooks.embed?.(texts);return {model,dimension:metadata.dimension,fingerprint:metadata.fingerprint,vectors:texts.map(()=>Array.from({length:metadata.dimension},(_,i)=>i?0:1))};}};
  const clock=()=>new Date(Date.UTC(2026,9,8,0,0,tick++));
  const engine=new KnowledgeEngine({vault,getTags:file=>file.tags,embeddingProvider,clock});
  const indexStore=new KnowledgeIndexStore({adapter,directory:'.obsidian/plugins/notework-ai'});
  const settings={mode:'openai',scope:folders('A'),knowledge:{embeddingRoute:'lexical',semanticRoute:'none'}};
  const provider={connect:async()=>{},listModels:async()=>[{id:'selected-answer'}],generate:async()=> 'Synthetic answer'};
  const controller=new ConnectionController({providers:{openai:provider},availableModes:['openai'],vault,getTags:file=>file.tags,settings,knowledgeEngine:engine,indexStore,embeddingProvider,secrets:{},jev:{},saveSettings:async()=>{},clock});
  return {contents,files,cache,adapter,vault,engine,indexStore,controller,settings,metadata,embeddingCalls,reads,hooks,update};
}

test('successive authorized folder builds accumulate and reload while retrieval stays inside current scope',async t=>{
  const f=fixture({'A/a.md':'# Old A\nAlpha exact evidence','B/b.md':'# New B\nBeta exact evidence','Private/secret.md':'secret evidence'});t.after(()=>f.controller.dispose());
  await f.controller.buildKnowledge({consent:true});const old=f.controller.state.knowledge.index,before=structuredClone(old);f.controller.setScope(folders('B'));await f.controller.buildKnowledge({consent:true});const combined=f.controller.state.knowledge.index;
  assert.deepEqual(combined.nodes.map(node=>node.path),['A/a.md','B/b.md']);assert.deepEqual(old,before);assert.equal(combined.stats.builtNowNotes,1);assert.equal(combined.stats.retainedNotes,1);assert.equal(combined.stats.addedNotes,1);assert.equal(combined.stats.indexedNotes,2);assert.match(f.controller.state.knowledge.status,/Indexed 1 of 1 selected notes/);assert.match(f.controller.state.knowledge.status,/retained 1; saved total 2/);assert(!f.reads.includes('Private/secret.md'));
  const loaded=await f.indexStore.load();assert.deepEqual(loaded,combined);assert.deepEqual(loaded.scope.include,['A/a.md','B/b.md']);assert.equal((await f.engine.retrieve({index:loaded,question:'evidence',scope:folders('B')})).sources[0].path,'B/b.md');assert.equal((await f.engine.retrieve({index:loaded,question:'Alpha',scope:folders('A')})).sources[0].path,'A/a.md');
  f.controller.setScope(folders('A'));f.update('A/c.md','Alpha additional evidence');await f.controller.buildKnowledge({consent:true});assert.equal(f.controller.state.knowledge.index.nodes.length,3);assert.equal(f.controller.state.knowledge.index.stats.replacedNotes,1);assert.equal(f.controller.state.knowledge.index.stats.retainedNotes,1);
});
test('rebuilding one note replaces all its old chunks and incident edges, preserving untouched real edges',async()=>{
  const f=fixture({'A/a.md':'shared research [[b]]','A/b.md':'shared research [[c]]','A/c.md':'shared research topic'});const first=await f.engine.build(local),before=structuredClone(first);const oldA=first.nodes.find(node=>node.path==='A/a.md'),oldIds=new Set(oldA.chunkIds);assert(first.edges.some(edge=>edge.source===oldA.id||edge.target===oldA.id));
  f.update('A/a.md','# Revised A\nCompletely rewritten evidence');const next=await f.engine.build({...local,files:[f.files.get('A/a.md')],previousIndex:first});assert.deepEqual(first,before);assert.equal(next.nodes.length,3);assert.equal(next.stats.replacedNotes,1);assert.equal(next.stats.retainedNotes,2);assert(next.chunks.every(chunk=>!oldIds.has(chunk.id)));assert(next.edges.every(edge=>edge.source!==oldA.id&&edge.target!==oldA.id));assert(next.edges.some(edge=>edge.source!==oldA.id&&edge.target!==oldA.id));assert.equal(new Set(next.chunks.map(chunk=>chunk.id)).size,next.chunks.length);assert.equal(new Set(next.nodes.map(node=>node.path)).size,3);
});
test('explicit note and chunk limits preserve unchanged previously built but unprocessed eligible notes',async()=>{
  const f=fixture({'A/a.md':'alpha method','A/b.md':'beta method','A/c.md':'gamma method'});const first=await f.engine.build(local);
  const limited=await f.engine.build({...local,maxNotes:1,previousIndex:first});assert.equal(limited.nodes.length,3);assert.equal(limited.stats.builtNowNotes,1);assert.equal(limited.stats.limitedNotes,2);assert.equal(limited.stats.retainedNotes,2);
  const chunkLimited=await f.engine.build({...local,maxChunks:1,previousIndex:limited});assert.equal(chunkLimited.nodes.length,3);assert.equal(chunkLimited.stats.builtNowNotes,1);assert.equal(chunkLimited.stats.retainedNotes,2);
  f.update('A/c.md','Changed source beyond the explicit note budget');const changed=await f.engine.build({...local,maxNotes:1,previousIndex:chunkLimited});assert.equal(changed.nodes.length,2);assert.equal(changed.stats.removedNotes,1);assert(!changed.nodes.some(node=>node.path==='A/c.md'));
});
test('changed, deleted, hidden, newly unselected and explicitly excluded sources cannot enter retained knowledge',async()=>{
  const f=fixture({'A/keep.md':'keep method','A/change.md':'old method','A/delete.md':'delete method','A/exclude.md':'private method','A/tag.md':'tag method','B/new.md':'new method','Private/unselected.md':'unselected method'});const first=await f.engine.build({...local,scope:folders('A')});f.update('A/change.md','changed original');f.files.delete('A/delete.md');f.update('A/tag.md','tag method',['#private']);f.reads.length=0;
  const second=await f.engine.build({...local,scope:{...folders('B'),exclude:['A/exclude.md'],excludeTags:['#private']},previousIndex:first});assert.deepEqual(second.nodes.map(node=>node.path),['A/keep.md','B/new.md']);assert.equal(second.stats.removedNotes,4);assert(!f.reads.includes('A/exclude.md'));assert(!f.reads.includes('A/tag.md'));assert(!f.reads.includes('Private/unselected.md'));
});
test('foreign vault metadata and forged cached excerpts are never retained as local evidence',async()=>{
  const f=fixture({'A/a.md':'alpha evidence','B/b.md':'beta evidence'});const first=await f.engine.build({...local,scope:folders('A')});const foreign={...first,vaultId:'a'.repeat(64)};const next=await f.engine.build({...local,scope:folders('B'),previousIndex:foreign});assert.deepEqual(next.nodes.map(node=>node.path),['B/b.md']);
  const forged=structuredClone(first);forged.chunks[0].text='injected cached excerpt';const sanitized=await f.engine.build({...local,scope:folders('B'),previousIndex:forged});assert.deepEqual(sanitized.nodes.map(node=>node.path),['B/b.md']);assert.equal(sanitized.stats.removedNotes,1);
});
test('compatible vectors remain reusable and incompatible retained models become explicit keyword-only data without extra embedding calls',async()=>{
  const f=fixture({'A/a.md':'alpha evidence','B/b.md':'beta evidence'}),vector={...local,embeddingRoute:'ollama',embeddingModel:'embed-one'};
  const first=await f.engine.build({...vector,scope:folders('A')});const second=await f.engine.build({...vector,scope:folders('B'),previousIndex:first});assert.equal(second.stats.retainedLexicalNotes,0);assert(second.chunks.every(chunk=>Array.isArray(chunk.vector)));assert.equal(f.embeddingCalls.length,2);
  f.metadata.fingerprint='weights-two';f.metadata.dimension=3;const third=await f.engine.build({...vector,embeddingModel:'embed-two',scope:folders('B'),previousIndex:second});assert.equal(f.embeddingCalls.length,3);assert.equal(third.stats.retainedLexicalNotes,1);assert.equal(third.embedding.model,'embed-two');const oldChunks=third.chunks.filter(chunk=>chunk.path==='A/a.md');assert(oldChunks.every(chunk=>chunk.vectorState==='lexical-only'&&chunk.vector===undefined));assert(third.chunks.filter(chunk=>chunk.path==='B/b.md').every(chunk=>chunk.vector.length===3));
  const before=f.embeddingCalls.length;const result=await f.engine.retrieve({index:third,question:'alpha',scope:folders('A')});assert.equal(f.embeddingCalls.length,before);assert.equal(result.sources[0].route,'lexical');assert.equal(result.proof.retainedLexicalSources,1);assert.equal(result.proof.route,'lexical');assert.equal(result.proof.strategy,'lexical');
  const exported=normalizeSyncKnowledgeIndex(third);assert.equal(exported.stats.retainedLexicalNotes,1);assert.deepEqual(exported.chunks.find(chunk=>chunk.path==='A/a.md'),oldChunks[0]);const imported=await f.engine.importPortableIndex({index:exported,consent:true});assert.equal(imported.nodes.length,2);assert.equal((await f.engine.retrieve({index:imported,question:'alpha',scope:folders('A')})).sources[0].route,'lexical');
  const coverage=await computeIndexCoverage({index:third,files:[...f.files.values()],scope:{},getTags:file=>file.tags,read:file=>f.contents.get(file.path)});assert.equal(coverage.files.find(file=>file.path==='A/a.md').status,'Partial');assert.equal(coverage.files.find(file=>file.path==='A/a.md').reason,'embedding-pending');assert.equal(coverage.files.find(file=>file.path==='B/b.md').status,'Up to date');
});
test('new embedding chunk policies recut retained text into validated keyword spans without provider migration',async()=>{
  const f=fixture({'A/a.md':'한글🧭 evidence '.repeat(200),'B/b.md':'new beta evidence'}),vector={...local,embeddingRoute:'ollama',embeddingModel:'embed'};const old=await f.engine.build({...vector,scope:folders('A')});const calls=f.embeddingCalls.length;f.metadata.contextLength=128;f.metadata.fingerprint='small-context';const next=await f.engine.build({...vector,scope:folders('B'),previousIndex:old});assert.equal(f.embeddingCalls.length,calls+1);const policy=knowledgeChunkingForPolicy(next.chunkPolicy);assert(next.chunks.filter(chunk=>chunk.path==='A/a.md').every(chunk=>Buffer.byteLength(chunk.text)<=policy.maxBytes&&chunk.vectorState==='lexical-only'&&f.contents.get(chunk.path).slice(chunk.start,chunk.end)===chunk.text));assert.equal(new Set(next.chunks.map(chunk=>chunk.id)).size,next.chunks.length);assert.equal(normalizeSyncKnowledgeIndex(next).nodes.length,2);assert.equal((await f.engine.importPortableIndex({index:next,consent:true})).nodes.length,2);
});
test('adaptive retained edges keep exact migrated excerpts and judgment provenance through sync export and import',async()=>{
  for(const semanticRoute of ['none','jev']){
    const f=fixture({'A/a.md':'shared topic [[b]] '+ 'alpha '.repeat(180),'A/b.md':'shared topic '+ 'beta '.repeat(180),'B/new.md':'new incoming evidence'});
    f.engine.embeddingProvider.embed=async(texts,{model})=>{f.embeddingCalls.push({texts:[...texts],model});return {model,dimension:2,fingerprint:f.metadata.fingerprint,vectors:texts.map(text=>text.includes('beta')?[0,1]:[1,0])};};
    let judgments=0;
    f.engine.jev={classifyNotes:async({model,notes,categories})=>({model,notes:notes.map(note=>({id:note.id,category:categories[0].id,layer:'knowledge',hierarchyLevel:'topic'}))}),judgeRelations:async({model,pairs})=>{judgments++;return {model,pairs:pairs.map(pair=>({...pair,kind:'supports',relatedProbability:.9,score:.6,scoreAdjusted:true,reportedScore:.95,scoreSource:'probabilities'}))};}};
    const vector={...local,embeddingRoute:'ollama',embeddingModel:'embed'};
    const prior=await f.engine.build({...vector,semanticRoute,semanticModel:'synthetic',scope:folders('A')}),before=structuredClone(prior);
    assert.equal(prior.edges.length,1);assert.equal(prior.edges[0].kind,semanticRoute==='jev'?'supports':'link');const oldChunks=new Set(prior.chunks.map(chunk=>chunk.id)),calls=f.embeddingCalls.length,oldJudgments=judgments;
    f.metadata.contextLength=128;f.metadata.fingerprint='small-context';
    const next=await f.engine.build({...vector,scope:folders('B'),previousIndex:prior});
    assert.deepEqual(prior,before);assert.equal(next.stats.retainedNotes,2);assert.equal(f.embeddingCalls.length,calls+1);assert.equal(judgments,oldJudgments);assert.equal(next.edges.length,1);
    const edge=next.edges[0],chunkMap=new Map(next.chunks.map(chunk=>[chunk.id,chunk]));
    for(const side of ['source','target']){const node=next.nodes.find(node=>node.id===edge[side]),quote=edge.evidence[side],chunk=chunkMap.get(quote.chunkId);assert(chunk);assert(!oldChunks.has(chunk.id));assert(node.chunkIds.includes(chunk.id));assert.equal(quote.path,node.path);assert.equal(quote.contentHash,node.contentHash);assert.equal(quote.start,chunk.start);assert.equal(quote.quote,f.contents.get(node.path).slice(quote.start,quote.end));assert.equal(chunk.vectorState,'lexical-only');}
    const {source:oldSource,target:oldTarget,...oldMetadata}=prior.edges[0].evidence,{source:newSource,target:newTarget,...newMetadata}=edge.evidence;
    assert.deepEqual(newMetadata,oldMetadata);assert.equal(edge.weight,prior.edges[0].weight);assert.equal(edge.kind,prior.edges[0].kind);
    const normalized=normalizeSyncKnowledgeIndex(next);assert.deepEqual(normalized.edges,next.edges);
    const sync=new SyncKnowledgeStore({adapter:{...f.adapter,mkdir:async path=>f.cache.set(path,'')},path:'Sync/knowledge.json'});await sync.export(next);
    const exported=await sync.load();assert.deepEqual(exported.edges,next.edges);const imported=await sync.import({engine:f.engine,consent:true});assert.equal(imported.nodes.length,3);assert.deepEqual(imported.edges,next.edges);
  }
});

test('malformed keyword-only markers and mixed-model vectors are rejected by sync and import',async()=>{
  const f=fixture({'A/a.md':'alpha evidence','B/b.md':'beta evidence'}),vector={...local,embeddingRoute:'ollama',embeddingModel:'embed'};const first=await f.engine.build({...vector,scope:folders('A')});f.metadata.fingerprint='new';const next=await f.engine.build({...vector,scope:folders('B'),previousIndex:first});
  for(const change of [chunk=>chunk.vector=[1,0],chunk=>chunk.vectorState='unknown']){const bad=structuredClone(next);change(bad.chunks.find(chunk=>chunk.path==='A/a.md'));assert.throws(()=>normalizeSyncKnowledgeIndex(bad),{code:'INVALID_SYNC_KNOWLEDGE'});const adopted=await f.engine.importPortableIndex({index:bad,consent:true});assert.deepEqual(adopted.nodes.map(node=>node.path),['B/b.md']);}
});
test('a retained source changing during merge stops publication and leaves the previous index unchanged',async()=>{
  const f=fixture({'A/a.md':'old alpha evidence','B/b.md':'new beta evidence'});const first=await f.engine.build({...local,scope:folders('A')}),before=structuredClone(first);let persisted=0;f.engine.onPersist=async()=>persisted++;
  await assert.rejects(f.engine.build({...local,scope:folders('B'),previousIndex:first,onProgress:progress=>{if(progress.phase==='retaining'&&progress.done===1)f.update('A/a.md','changed during merge');}}),{code:'SOURCE_CHANGED'});assert.equal(persisted,0);assert.deepEqual(first,before);
});
test('actual controller/store transaction rolls back failed cumulative saves and keeps a usable ready previous index',async t=>{
  const f=fixture({'A/a.md':'alpha evidence','B/b.md':'beta evidence'});t.after(()=>f.controller.dispose());await f.controller.buildKnowledge({consent:true});const previous=f.controller.state.knowledge.index,raw=f.cache.get(f.indexStore.path);f.controller.setScope(folders('B'));let thrown=false;f.hooks.storage=event=>{if(!thrown&&event.phase==='rename'&&event.from.endsWith('.pending')){thrown=true;throw new Error('Synthetic save commit failure');}};
  await f.controller.buildKnowledge({consent:true});assert.equal(f.controller.state.knowledge.index,previous);assert.equal(f.controller.state.knowledge.phase,'ready');assert.equal(f.controller.state.knowledge.lastBuildStage,'saving');assert.match(f.controller.state.knowledge.lastBuildError,/Synthetic save commit failure/);assert.equal(f.cache.get(f.indexStore.path),raw);assert.equal((await f.indexStore.load()).id,previous.id);assert(!f.cache.has(f.indexStore.path+'.previous'));assert(!f.cache.has(f.indexStore.path+'.pending'));
  f.hooks.storage=null;await f.controller.buildKnowledge({consent:true});assert.equal(f.controller.state.knowledge.index.nodes.length,2);assert.equal(f.controller.state.knowledge.lastBuildError,'');
});
test('semantic errors retain saved index and stage/code without any automatic provider retry',async t=>{
  const f=fixture({'A/a.md':'alpha evidence','B/b.md':'beta evidence'});t.after(()=>f.controller.dispose());await f.controller.buildKnowledge({consent:true});const previous=f.controller.state.knowledge.index;let calls=0;f.engine.jev={classifyNotes:async()=>{calls++;const error=new Error('Synthetic failure');error.code='JEV_TIMEOUT';throw error;},judgeRelations:async()=>{assert.fail('No relation fallback');}};f.controller.setScope(folders('B'));f.controller.configureKnowledge({semanticRoute:'jev'});f.controller.set({jevVerified:true,jevModel:'synthetic',jevModels:[{id:'synthetic'}]});await f.controller.buildKnowledge({consent:true});assert.equal(calls,1);assert.equal(f.controller.state.knowledge.index,previous);assert.equal(f.controller.state.knowledge.phase,'ready');assert.equal(f.controller.state.knowledge.lastBuildErrorCode,'JEV_TIMEOUT');assert.match(f.controller.state.knowledge.lastBuildError,/time limit/);assert.equal(f.controller.state.knowledge.lastBuildStage,'classifying');
});
test('adjusted Jev probabilities preserve scored provenance, counts and sync metadata without rejudging retained edges',async()=>{
  const f=fixture({'A/a.md':'shared method [[b]]','A/b.md':'shared method evidence','B/new.md':'new evidence'});let judges=0;
  f.engine.jev={classifyNotes:async({model,notes,categories})=>({model,notes:notes.map(note=>({id:note.id,category:categories[0].id,layer:'knowledge',hierarchyLevel:'topic'}))}),judgeRelations:async({model,pairs})=>{judges++;return {model,pairs:pairs.map(pair=>({...pair,kind:'supports',relatedProbability:.9,score:.6,scoreAdjusted:true,reportedScore:.95,scoreSource:'probabilities'}))};}};
  const old=await f.engine.build({...local,semanticRoute:'jev',semanticModel:'synthetic',scope:folders('A')});assert(old.stats.scoreAdjustments>0);assert(old.edges.every(edge=>edge.evidence.scoreSource==='probabilities'&&edge.evidence.reportedScore===.95));const before=judges;
  const next=await f.engine.build({...local,scope:folders('B'),previousIndex:old});assert.equal(judges,before);assert(next.edges.every(edge=>edge.evidence.reportedScore===.95));const serialized=normalizeSyncKnowledgeIndex(next);assert(serialized.edges.every(edge=>edge.evidence.scoreSource==='probabilities'&&edge.evidence.reportedScore===.95));
});
