import test from 'node:test';
import assert from 'node:assert/strict';
import {KnowledgeEngine} from '../src/knowledge-engine.mjs';
import {KNOWLEDGE_HIERARCHY_POLICY} from '../src/providers/jev.mjs';
import {knowledgeChunkingForPolicy} from '../src/knowledge-engine.mjs';
import {computeIndexCoverage,indexCoverageSnapshot,indexSettingsCompatibility,IndexCoverageCache} from '../src/index-coverage.mjs';

function fixture(count=540){
  const store=new Map(Array.from({length:count},(_,i)=>{const path=`Research/group-${Math.floor(i/30)}/note-${i}.md`;return[path,{file:{path,stat:{mtime:100,size:30}},text:`# Topic ${i}\nResearch method ${i}.`,tags:i%7===0?['#private']:['#research/ai']}];}));
  const calls=[];const reads=[];
  const vault={getName:()=> 'coverage-fixture',getMarkdownFiles:()=>[...store.values()].map(value=>value.file),getAbstractFileByPath:path=>store.get(path)?.file,read:async file=>{reads.push(file.path);return store.get(file.path)?.text;}};
  const getTags=file=>store.get(file.path)?.tags||[];
  const embeddingProvider={prepareModel:async()=>({fingerprint:'fixture-weights'}),embed:async texts=>{calls.push([...texts]);return{vectors:texts.map(()=>[1,0]),dimension:2,fingerprint:'fixture-weights'};}};
  const engine=new KnowledgeEngine({vault,getTags,embeddingProvider,clock:()=>new Date('2026-10-07T01:00:00Z')});
  const options=()=>({files:vault.getMarkdownFiles(),currentFiles:vault.getMarkdownFiles(),read:file=>vault.read(file),getTags,clock:()=>new Date('2026-10-07T02:00:00Z')});
  return{store,vault,engine,calls,reads,options};
}
const local={consent:true,embeddingRoute:'lexical',semanticRoute:'none'};
const vector={...local,embeddingRoute:'ollama',embeddingModel:'fixture-embed'};

test('540-note index distinguishes saved Indexed from hash-verified Up to date and aggregates descendants',async()=>{
  const data=fixture();const index=await data.engine.build(local);data.reads.length=0;
  const snapshot=indexCoverageSnapshot({...data.options(),index});
  assert.equal(snapshot.status,'Indexed');assert.equal(snapshot.counts.selectedNotes,540);assert.equal(snapshot.counts.uncheckedNotes,540);assert.equal(data.reads.length,0);
  const coverage=await computeIndexCoverage({...data.options(),index});
  assert.equal(coverage.status,'Up to date');assert.equal(coverage.counts.upToDateNotes,540);assert.equal(coverage.reads,540);assert.equal(coverage.builtAt,'2026-10-07T01:00:00.000Z');assert.equal(coverage.checkedAt,'2026-10-07T02:00:00.000Z');
  assert.equal(coverage.folders.find(row=>row.path==='Research').selectedNotes,540);assert.equal(coverage.folders.find(row=>row.path==='Research/group-0').selectedNotes,30);
  assert.equal(coverage.files.every(row=>row.reason==='hash-verified'),true);
});

test('old 540-node index without coverage metadata is verified from hashes and original chunk bytes',async()=>{
  const data=fixture();const index=await data.engine.build(local);delete index.buildSettings;for(const node of index.nodes)delete node.sourceLength;
  const result=await computeIndexCoverage({...data.options(),index,settings:{embeddingRoute:'lexical',semanticRoute:'none',limitNotes:false,maxNotes:200,limitChunks:false,maxChunks:1000,categoriesText:''}});
  assert.equal(result.status,'Up to date');assert.equal(result.compatibility.compatible,true);assert.equal(result.counts.partialNotes,0);
});

test('same-stat changed, added and deleted sources cannot appear complete in a 540-note selection',async()=>{
  const data=fixture();const index=await data.engine.build(local);const paths=[...data.store.keys()];
  data.store.get(paths[0]).text='# Changed source';data.store.delete(paths[1]);const path='Research/group-0/added.md';data.store.set(path,{file:{path,stat:{mtime:100,size:30}},text:'new note',tags:['#research']});
  const result=await computeIndexCoverage({...data.options(),index});
  assert.equal(result.status,'Changed');assert.equal(result.counts.upToDateNotes,538);assert.equal(result.counts.changedNotes,1);assert.equal(result.counts.notIndexedNotes,1);assert.equal(result.counts.removedNotes,1);assert.equal(result.counts.selectedNotes,540);
  assert.equal(result.files.find(row=>row.path===paths[0]).reason,'source-changed');assert.equal(result.files.find(row=>row.path===path).status,'Not indexed');assert.equal(result.folders.find(row=>row.path==='Research/group-0').removedNotes,1);
});

test('event-invalidated cache performs zero rereads for checkbox scope changes and catches same-stat writes',async()=>{
  const data=fixture();const index=await data.engine.build(local);const cache=new IndexCoverageCache();
  const first=await computeIndexCoverage({...data.options(),index,cache});assert.equal(first.reads,540);
  data.reads.length=0;const narrow=await computeIndexCoverage({...data.options(),index,cache,scope:{mode:'folders',include:['Research/group-0']}});
  assert.equal(narrow.reads,0);assert.equal(narrow.cacheHits,30);assert.equal(data.reads.length,0);
  const path=[...data.store.keys()][0];data.store.get(path).text='same mtime changed bytes';cache.invalidate(path);
  const changed=await computeIndexCoverage({...data.options(),index,cache,scope:{include:['Research/group-0']}});
  assert.equal(changed.reads,1);assert.equal(changed.cacheHits,29);assert.equal(changed.counts.changedNotes,1);
  const forced=await computeIndexCoverage({...data.options(),index,cache,force:true,scope:{include:['Research/group-0']}});assert.equal(forced.reads,30);
  const entries=JSON.stringify([...cache.entries]);assert(!entries.includes('Research method'));assert(!entries.includes('same mtime changed bytes'));
});

test('tag and folder exclusions use the current selected inventory and never read excluded notes',async()=>{
  const data=fixture();const scope={include:['Research'],exclude:['Research/group-1'],tags:['#research'],excludeTags:['#private']};
  const index=await data.engine.build({...local,scope});data.reads.length=0;
  const selected=data.vault.getMarkdownFiles().filter(file=>data.options().getTags(file)[0]!=='#private'&&!file.path.startsWith('Research/group-1/'));
  const result=await computeIndexCoverage({...data.options(),files:selected,index,scope});
  assert.equal(result.status,'Up to date');assert.equal(result.counts.selectedNotes,selected.length);assert.equal(result.counts.notIndexedNotes,0);assert.equal(result.counts.removedNotes,0);
  assert(data.reads.every(path=>!path.startsWith('Research/group-1/')&&data.store.get(path).tags[0]!=='#private'));
  assert.equal(result.folders.some(row=>row.path==='Research/group-1'),false);
});

test('explicit note and text chunk limits report Partial from real absent nodes and actual spans',async()=>{
  const data=fixture();const limited=await data.engine.build({...local,maxNotes:510});const result=await computeIndexCoverage({...data.options(),index:limited});
  assert.equal(result.status,'Partial');assert.equal(result.counts.upToDateNotes,510);assert.equal(result.counts.notIndexedNotes,30);assert.equal(limited.buildSettings.maxNotes,510);
  const long=fixture(1);long.store.values().next().value.text='Long original source '.repeat(300);const index=await long.engine.build({...local,maxChunks:1});
  assert.equal(index.nodes[0].sourceLength,long.store.values().next().value.text.length);assert.equal(index.stats.truncatedNotes,1);
  const coverage=await computeIndexCoverage({...long.options(),index});assert.equal(coverage.status,'Partial');assert.equal(coverage.files[0].reason,'incomplete-text');assert.equal(coverage.counts.partialNotes,1);
});

test('configuration drift checks routes, models, verified fingerprint, chunk policy, labels and explicit limits',async()=>{
  const data=fixture(1);const index=await data.engine.build(vector);
  for(const [settings,reason] of [[{embeddingRoute:'lexical'},'embeddingRoute'],[{embeddingModel:'other-model'},'embeddingModel'],[{embeddingFingerprint:'changed-weights'},'embedding-fingerprint'],[{embeddingDimension:3},'embedding-dimension'],[{chunkPolicy:'other-policy'},'chunk-policy'],[{semanticRoute:'llm'},'semanticRoute'],[{categoriesText:'New label'},'categories'],[{limitChunks:true,maxChunks:1},'maxChunks']]){
    const compatibility=indexSettingsCompatibility(index,settings);assert.equal(compatibility.compatible,false);assert(compatibility.reasons.includes(reason));
    const result=await computeIndexCoverage({...data.options(),index,settings});assert.equal(result.status,'Changed');assert.equal(result.counts.upToDateNotes,0);
  }
  const known=indexSettingsCompatibility(index,{embeddingRoute:'ollama',embeddingModel:'fixture-embed',embeddingFingerprint:'fixture-weights'});assert.equal(known.compatible,true);assert.equal(known.modelFingerprintVerified,true);
  assert.equal(indexSettingsCompatibility(index,{}).modelFingerprintVerified,false);
});

test('corrupt cached spans, duplicate nodes, malformed vectors and incomplete semantics are Partial',async()=>{
  const data=fixture(1);const index=await data.engine.build(vector);
  const corrupt=structuredClone(index);corrupt.chunks[0].text='forged excerpt';const bad=await computeIndexCoverage({...data.options(),index:corrupt});assert.equal(bad.status,'Partial');
  const vectors=structuredClone(index);vectors.chunks[0].vector=[0,0];assert.equal((await computeIndexCoverage({...data.options(),index:vectors})).status,'Partial');
  const duplicate=structuredClone(index);duplicate.nodes.push(duplicate.nodes[0]);assert.equal((await computeIndexCoverage({...data.options(),index:duplicate})).files[0].reason,'invalid-source');
  const semantic=structuredClone(index);semantic.semantic.route='llm';semantic.semantic.model='fake';const result=await computeIndexCoverage({...data.options(),index:semantic});assert.equal(result.status,'Partial');assert.equal(result.counts.semanticPendingNotes,1);
  semantic.nodes[0].evidence.status='classified';semantic.stats.semanticStatus='budget-limited';assert.equal((await computeIndexCoverage({...data.options(),index:semantic})).status,'Partial');
});

test('sanitized coverage returns no source text, digests, vectors, provider properties or raw read failures',async()=>{
  const data=fixture(1);const index=await data.engine.build(local);index.secret='synthetic-top-secret';index.nodes[0].token='synthetic-node-secret';
  const result=await computeIndexCoverage({...data.options(),index,read:async()=>{throw new Error('Bearer synthetic-read-secret');}});
  const serialized=JSON.stringify(result);assert.equal(result.status,'Partial');assert.equal(result.counts.unreadableNotes,1);assert(!serialized.includes('synthetic'));assert(!serialized.includes(index.nodes[0].contentHash));assert(!serialized.includes(index.chunks[0].text));assert(!serialized.includes('vector'));
  const noIndex=await computeIndexCoverage({...data.options(),read:async()=>{throw new Error('must not read');}});assert.equal(noIndex.status,'Not indexed');assert.equal(noIndex.reads,0);
});

test('abort and mid-read same-stat invalidation do not publish a fresh status',async()=>{
  const data=fixture(1);const index=await data.engine.build(local);const abort=new AbortController();abort.abort();await assert.rejects(computeIndexCoverage({...data.options(),index,signal:abort.signal}),{name:'AbortError'});
  const cache=new IndexCoverageCache();const result=await computeIndexCoverage({...data.options(),index,cache,read:async file=>{const text=await data.vault.read(file);cache.invalidate(file.path);return text;}});
  assert.equal(result.status,'Changed');assert.equal(result.files[0].reason,'source-changed');assert.equal(cache.entries.size,0);
});

test('earlier verified sources invalidated during a later read cannot produce Up to date',async()=>{
  const data=fixture(2);const index=await data.engine.build(local);const paths=[...data.store.keys()];const cache=new IndexCoverageCache();
  const result=await computeIndexCoverage({...data.options(),index,cache,read:async file=>{const text=await data.vault.read(file);if(file.path===paths[1]){data.store.get(paths[0]).text='changed after first check';cache.invalidate(paths[0]);}return text;}});
  assert.equal(result.status,'Changed');assert.equal(result.counts.changedNotes,1);assert.equal(result.files[0].reason,'source-changed');
});

test('cache span verification is renewed when an index is modified in place',async()=>{
  const data=fixture(1);const index=await data.engine.build(local);const cache=new IndexCoverageCache();
  assert.equal((await computeIndexCoverage({...data.options(),index,cache})).status,'Up to date');index.chunks[0].text='same-index-id forged excerpt';
  const result=await computeIndexCoverage({...data.options(),index,cache});assert.equal(result.status,'Partial');assert.equal(result.reads,1);
});

test('540-note incremental rebuild reuses compatible vectors and rebuilds exactly changed and added sources',async()=>{
  const data=fixture();const index=await data.engine.build(vector);const paths=[...data.store.keys()];const priorCalls=data.calls.length;
  data.store.get(paths[0]).text='changed source';data.store.delete(paths[1]);const path='Research/group-0/new.md';data.store.set(path,{file:{path,stat:{mtime:100,size:30}},text:'new source',tags:['#research']});
  const rebuilt=await data.engine.build({...vector,previousIndex:index});assert.equal(rebuilt.nodes.length,540);assert.equal(rebuilt.stats.reusedChunks,538);assert.equal(data.calls.length-priorCalls,1);assert.deepEqual(new Set(data.calls.at(-1)),new Set(['changed source','new source']));assert(!rebuilt.nodes.some(node=>node.path===paths[1]));
  const coverage=await computeIndexCoverage({...data.options(),index:rebuilt});assert.equal(coverage.status,'Up to date');assert.equal(coverage.counts.removedNotes,0);
});

test('adaptive multilingual source coverage accepts recognized policies and enforces UTF-8 bytes independently of characters',async()=>{
  const data=fixture(1);data.store.values().next().value.text='한글 문장 🧠 '.repeat(300);data.engine.embeddingProvider.prepareModel=async()=>({fingerprint:'fixture-weights',contextLength:256});
  const index=await data.engine.build(vector);const chunking=knowledgeChunkingForPolicy(index.chunkPolicy);
  assert(index.chunkPolicy.startsWith('knowledge-v2-'));assert(chunking);assert(index.chunks.length>1);assert(index.chunks.every(chunk=>Buffer.byteLength(chunk.text,'utf8')<=chunking.maxBytes));
  assert.equal((await computeIndexCoverage({...data.options(),index})).status,'Up to date');
  // A legacy char-bounded chunk can remain shorter than 1800 UTF-16 units while
  // exceeding the adaptive byte policy. The source hashes/spans are unchanged.
  const legacy=await data.engine.build(local);legacy.chunkPolicy=index.chunkPolicy;assert(legacy.chunks.some(chunk=>chunk.text.length<=chunking.maxChars&&Buffer.byteLength(chunk.text,'utf8')>chunking.maxBytes));
  const result=await computeIndexCoverage({...data.options(),index:legacy});assert.equal(result.status,'Partial');assert.equal(result.files[0].reason,'incomplete-text');
});

test('unknown and malicious adaptive policies cannot claim compatible or up-to-date coverage',async()=>{
  const data=fixture(1);const index=await data.engine.build(local);
  for(const policy of ['knowledge-v3-char1800-utf81024-overlap200','knowledge-v2-char999999999-utf8999999999-overlap0','knowledge-v2-char1800-utf81e3-overlap200','knowledge-v2-char1800-utf8512-overlap999999','knowledge-v2-char1800-utf8512-overlap200/../']){
    const changed={...index,chunkPolicy:policy};assert.equal(knowledgeChunkingForPolicy(policy),null);assert.equal(indexSettingsCompatibility(changed).compatible,false);assert.equal((await computeIndexCoverage({...data.options(),index:changed})).status,'Changed');
  }
});


test('legacy classified nodes are semantic-pending until abstraction hierarchy is classified by the current policy',async()=>{
  const data=fixture(1);const index=await data.engine.build(local);index.semantic={...index.semantic,route:'jev',model:'fixture'};index.stats.semanticStatus='complete';index.nodes[0].evidence={...index.nodes[0].evidence,status:'classified',route:'jev',model:'fixture'};delete index.nodes[0].hierarchyLevel;delete index.semantic.hierarchyPolicy;
  let coverage=await computeIndexCoverage({...data.options(),index});assert.equal(coverage.status,'Partial');assert.equal(coverage.counts.semanticPendingNotes,1);
  index.nodes[0].hierarchyLevel='topic';index.semantic.hierarchyPolicy=KNOWLEDGE_HIERARCHY_POLICY;coverage=await computeIndexCoverage({...data.options(),index});assert.equal(coverage.status,'Up to date');assert.equal(coverage.counts.semanticPendingNotes,0);
  index.nodes[0].hierarchyLevel='unassigned';coverage=await computeIndexCoverage({...data.options(),index});assert.equal(coverage.status,'Up to date');
});
