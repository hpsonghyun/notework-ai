import test from 'node:test';
import assert from 'node:assert/strict';
import {KnowledgeEngine} from '../src/knowledge-engine.mjs';
import {KNOWLEDGE_HIERARCHY_POLICY,knowledgeHierarchyLevels} from '../src/providers/jev.mjs';
import {sha256HexSync} from '../src/portable-crypto.mjs';

function fixture(contents,options={}){
  const store=new Map();const reads=[];
  for(const [path,text] of Object.entries(contents))store.set(path,{file:{path,stat:{mtime:1,size:Buffer.byteLength(text)}},text,tags:options.tags?.[path]||[]});
  const vault={getName:()=>options.name||'synthetic-vault',getMarkdownFiles:()=>[...store.values()].map(item=>item.file),getAbstractFileByPath:path=>store.get(path)?.file,read:async file=>{reads.push(file.path);if(options.onRead)await options.onRead(file);return store.get(file.path)?.text;}};
  const update=(path,text,{mtime=true}={})=>{const entry=store.get(path);entry.text=text;entry.file.stat.size=Buffer.byteLength(text);if(mtime)entry.file.stat.mtime++;};
  const embeddingCalls=[];const embeddingProvider={prepareModel:async()=>({model:'fixture-vector',fingerprint:options.fingerprint||'weights-one'}),embed:async(texts,{signal}={})=>{embeddingCalls.push(texts);if(options.onEmbed)await options.onEmbed(texts,{signal});return{model:'fixture-vector',dimension:2,fingerprint:options.fingerprint||'weights-one',vectors:texts.map(text=>/cat|feline|purr|companion/i.test(text)?[1,0]:/tree|leaf|plant|forest/i.test(text)?[0,1]:[0.6,0.8])};}};
  const engine=new KnowledgeEngine({vault,getTags:file=>store.get(file.path)?.tags||[],embeddingProvider,jev:options.jev,llmCall:options.llmCall,onPersist:options.onPersist,clock:()=>new Date('2026-10-06T00:00:00Z')});
  return{engine,vault,store,reads,update,embeddingCalls,embeddingProvider};
}
const local={consent:true,embeddingRoute:'lexical',semanticRoute:'none'};
const vector={...local,embeddingRoute:'ollama',embeddingModel:'fixture-vector'};
test('build only includes selected safe Markdown with exact hash-bound character provenance',async()=>{
  const data=fixture({'research/a.md':'# Invented method\nA useful method.','private/b.md':'do not read','.hidden/c.md':'hidden','research/image.png':'binary'});const index=await data.engine.build({...local,scope:{mode:'folders',include:['research']}});assert.deepEqual(index.nodes.map(node=>node.path),['research/a.md']);assert(data.reads.every(path=>path==='research/a.md'));assert.equal(index.embedding.route,'lexical');assert.equal(index.embedding.dimension,0);assert.equal(index.stats.semanticStatus,'local');assert.equal(index.stats.semanticCalls,0);const quote=index.nodes[0].evidence.chunks[0];assert.equal(quote.quote,data.store.get(quote.path).text.slice(quote.start,quote.end));assert.equal(quote.contentHash,index.nodes[0].contentHash);assert.equal(index.layers.find(layer=>layer.id==='other').count,1);
});
test('consent and route validation happen before note or provider operations',async()=>{
  const data=fixture({'a.md':'invented'});await assert.rejects(data.engine.build(),{code:'KNOWLEDGE_CONSENT_REQUIRED'});await assert.rejects(data.engine.build({...local,embeddingRoute:'remote'}),{code:'INVALID_KNOWLEDGE_ROUTE'});assert.equal(data.reads.length,0);assert.equal(data.embeddingCalls.length,0);
});
test('lexical mode never implicitly calls embeddings, Jev or a selected LLM',async()=>{
  let calls=0;const data=fixture({'a.md':'# Fiction\nFictional method.'},{jev:{classifyNotes:async()=>{calls++;}},llmCall:async()=>{calls++;}});await data.engine.build(local);assert.equal(calls,0);assert.equal(data.embeddingCalls.length,0);
});
test('real vector route retrieves paraphrase without keyword overlap',async()=>{
  const data=fixture({'a.md':'# Feline\nA cat purrs.','b.md':'# Plants\nA tree grows a leaf.'});const index=await data.engine.build(vector);const result=await data.engine.retrieve({index,question:'small companion',limit:1});assert.equal(result.sources[0].path,'a.md');assert.equal(result.proof.route,'ollama');assert.equal(result.proof.matchedChunks[0].contentHash,index.nodes[0].contentHash);assert(result.context.includes('a.md'));assert.equal(data.embeddingCalls.length,2);
});
test('unchanged source chunks reuse vector cache without a second embedding request',async()=>{
  const data=fixture({'a.md':'A cat purrs.','b.md':'A plant grows.'});const first=await data.engine.build(vector);const next=await data.engine.build({...vector,previousIndex:first});assert.equal(data.embeddingCalls.length,1);assert.equal(next.stats.reusedChunks,2);assert.equal(next.embedding.dimension,2);
});
test('only a changed note is reembedded even when size and mtime stay identical',async()=>{
  const data=fixture({'a.md':'cat','b.md':'tree'});const first=await data.engine.build(vector);data.update('a.md','dog',{mtime:false});const next=await data.engine.build({...vector,previousIndex:first});assert.equal(next.stats.reusedChunks,1);assert.deepEqual(data.embeddingCalls.at(-1),['dog']);assert.notEqual(next.nodes[0].contentHash,first.nodes[0].contentHash);
});
test('model fingerprint change rebuilds embeddings rather than mixing old vectors',async()=>{
  const data=fixture({'a.md':'cat'});const first=await data.engine.build(vector);data.embeddingProvider.prepareModel=async()=>({fingerprint:'weights-two'});data.embeddingProvider.embed=async texts=>{data.embeddingCalls.push(texts);return{vectors:[[0,1]],dimension:2,fingerprint:'weights-two'};};const next=await data.engine.build({...vector,previousIndex:first});assert.equal(next.stats.reusedChunks,0);assert.equal(next.embedding.fingerprint,'weights-two');assert.deepEqual(next.chunks[0].vector,[0,1]);
});
test('corrupt cached vector is rebuilt, not copied into a new index',async()=>{
  const data=fixture({'a.md':'cat'});const first=await data.engine.build(vector);first.chunks[0].vector=[0,0];const next=await data.engine.build({...vector,previousIndex:first});assert.equal(next.stats.reusedChunks,0);assert.deepEqual(next.chunks[0].vector,[1,0]);
});
test('same-path data from another vault never reuses cached embeddings',async()=>{
  const data=fixture({'a.md':'cat'});const first=await data.engine.build(vector);first.vaultId='other-vault';const next=await data.engine.build({...vector,previousIndex:first});assert.equal(next.stats.reusedChunks,0);
});
test('explicit keyword retrieval over an Ollama index preserves vectors and reports the actual search strategy',async()=>{
  const data=fixture({'a.md':'A cat purrs.','b.md':'A tree grows.'});const index=await data.engine.build(vector);const original=structuredClone(index);data.engine.embeddingProvider=undefined;
  await assert.rejects(data.engine.retrieve({index,question:'cat'}),{code:'EMBEDDING_CONNECTION_REQUIRED'});
  const result=await data.engine.retrieve({index,question:'cat',retrievalStrategy:'lexical'});assert.deepEqual(result.sources.map(source=>source.path),['a.md']);assert.equal(result.proof.route,'lexical');assert.equal(result.proof.indexRoute,'ollama');assert.equal(result.proof.strategy,'lexical');assert.equal(result.sources[0].route,'lexical');assert(result.context.includes('Keyword search over a saved Ollama index; no query embedding was used.'));assert.equal(data.embeddingCalls.length,1);assert.deepEqual(index,original);
  const empty=await data.engine.retrieve({index,question:'cat',retrievalStrategy:'lexical',selectedNodeIds:[]});assert.deepEqual(empty.sources,[]);assert.equal(empty.proof.route,'lexical');await assert.rejects(data.engine.retrieve({index,question:'cat',retrievalStrategy:'silent-fallback'}),{code:'INVALID_RETRIEVAL_STRATEGY'});
});
test('synced desktop index needs explicit local adoption before a different mobile vault identity can retrieve',async()=>{
  const desktop=fixture({'Research/a.md':'# Invented topic\nA useful cat method.'},{name:'desktop'});desktop.vault.adapter={getBasePath:()=> 'C:/vaults/Research'};const index=await desktop.engine.build(vector);const before=structuredClone(index);
  const phone=fixture({'Research/a.md':'# Invented topic\nA useful cat method.'},{name:'Research'});let persisted=0;phone.engine.onPersist=async()=>{persisted++;};phone.engine.embeddingProvider=undefined;
  await assert.rejects(phone.engine.retrieve({index,question:'method',retrievalStrategy:'lexical'}),{code:'INVALID_KNOWLEDGE_INDEX'});
  await assert.rejects(phone.engine.importPortableIndex({index}),{code:'KNOWLEDGE_IMPORT_CONSENT_REQUIRED'});assert.equal(phone.reads.length,0);
  const imported=await phone.engine.importPortableIndex({index,consent:true});assert.equal(imported.vaultId,phone.engine.vaultId());assert.notEqual(imported.id,index.id);assert.equal(imported.portableImport.sourceVaultId,index.vaultId);assert.equal(imported.portableImport.sourceIndexId,index.id);assert.equal(imported.portableImport.verifiedNotes,1);assert.deepEqual(imported.portableImport.invalidatedPaths,[]);assert.deepEqual(imported.chunks[0].vector,index.chunks[0].vector);assert.deepEqual(index,before);assert.equal(persisted,0);assert.equal(phone.embeddingCalls.length,0);const result=await phone.engine.retrieve({index:imported,question:'method',retrievalStrategy:'lexical'});assert.equal(result.sources[0].contentHash,index.nodes[0].contentHash);
});
test('portable adoption only exposes unchanged notes in both original and current selected scopes',async()=>{
  const contents={'research/a.md':'method cat [[b]]','research/b.md':'method reference','research/c.md':'method changed','research/d.md':'method deleted','private/e.md':'method private'};const desktop=fixture(contents,{name:'desktop'});const index=await desktop.engine.build({...vector,scope:{include:['research']}});const a=index.nodes.find(node=>node.path==='research/a.md'),b=index.nodes.find(node=>node.path==='research/b.md');index.edges=[{source:a.id,target:b.id,kind:'supports',weight:0.8,evidence:{status:'model-judgment',route:'jev',model:'fixture',source:{contentHash:a.contentHash},target:{contentHash:b.contentHash}}}];
  const phone=fixture(contents,{name:'phone'});phone.update('research/c.md','changed other text',{mtime:false});phone.store.delete('research/d.md');const imported=await phone.engine.importPortableIndex({index,consent:true,files:phone.vault.getMarkdownFiles(),scope:{include:['research'],exclude:['research/b.md']}});assert.deepEqual(imported.nodes.map(node=>node.path),['research/a.md']);assert.equal(imported.edges.length,0);assert.deepEqual(new Set(imported.portableImport.invalidatedPaths),new Set(['research/b.md','research/c.md','research/d.md']));assert.equal(imported.chunks.length,index.chunks.filter(chunk=>chunk.path==='research/a.md').length);assert.equal(imported.categories.reduce((sum,category)=>sum+category.count,0),1);assert(!JSON.stringify(imported.nodes).includes('private/e.md'));
  const empty=await phone.engine.retrieve({index:imported,question:'method',retrievalStrategy:'lexical',selectedNodeIds:[]});assert.equal(empty.sources.length,0);
});
test('portable adoption validates original excerpt spans, rejects corrupt vectors, and grounds graph titles in live text',async()=>{
  const desktop=fixture({'a.md':'# Current title\nmethod cat','b.md':'method tree'},{name:'desktop'});const index=await desktop.engine.build(vector);const phone=fixture({'a.md':'# Current title\nmethod cat','b.md':'method tree'},{name:'phone'});
  const tampered=structuredClone(index);tampered.nodes[0].title='Injected heading';tampered.nodes[0].summary='unrelated text';tampered.nodes[0].evidence.chunks[0].quote='unrelated quote';tampered.chunks.find(chunk=>chunk.path==='b.md').text='forged note text';const imported=await phone.engine.importPortableIndex({index:tampered,consent:true});assert.deepEqual(imported.nodes.map(node=>node.path),['a.md']);assert.equal(imported.nodes[0].title,'Current title');assert.equal(imported.nodes[0].summary,'# Current title\nmethod cat');assert.equal(imported.nodes[0].evidence.chunks[0].quote,'# Current title\nmethod cat');
  const invalid=structuredClone(index);invalid.chunks.forEach(chunk=>{chunk.vector=[0,0];});await assert.rejects(phone.engine.importPortableIndex({index:invalid,consent:true}),{code:'EMPTY_KNOWLEDGE_IMPORT'});
  const forged=structuredClone(index);forged.chunks[0].id='chunk_forged';forged.nodes[0].chunkIds=['chunk_forged'];assert.deepEqual((await phone.engine.importPortableIndex({index:forged,consent:true})).nodes.map(node=>node.path),['b.md']);
});
test('portable adoption checks every accepted source again, supports cancellation and performs no persistence',async()=>{
  const desktop=fixture({'a.md':'method cat','b.md':'method tree'},{name:'desktop'});const index=await desktop.engine.build(local);const phone=fixture({'a.md':'method cat','b.md':'method tree'},{name:'phone',onRead:async file=>{if(file.path==='b.md')phone.update('a.md','modified cat',{mtime:false});}});let writes=0;phone.engine.onPersist=async()=>{writes++;};await assert.rejects(phone.engine.importPortableIndex({index,consent:true}),{code:'SOURCE_CHANGED'});assert.equal(writes,0);
  const abort=new AbortController();const cancelled=fixture({'a.md':'method cat','b.md':'method tree'},{name:'phone',onRead:async()=>abort.abort()});await assert.rejects(cancelled.engine.importPortableIndex({index,consent:true,signal:abort.signal}),{name:'AbortError'});
});
test('portable adoption rejects duplicate or malformed metadata before reading and discards unknown cache fields',async()=>{
  const desktop=fixture({'a.md':'method cat'},{name:'desktop'});const index=await desktop.engine.build(local);const phone=fixture({'a.md':'method cat'},{name:'phone'});
  for(const mutate of [value=>{value.vaultId='not-a-vault-hash';},value=>{value.nodes=Array(501).fill(value.nodes[0]);},value=>{value.chunks=Array(4001).fill(value.chunks[0]);},value=>{value.edges=Array(1501).fill({});},value=>{value.embedding.route='cloud';},value=>{value.semantic.route='untrusted';},value=>{value.configSignature='invalid';},value=>{value.builtAt='yesterday';}]){const malformed=structuredClone(index);mutate(malformed);await assert.rejects(phone.engine.importPortableIndex({index:malformed,consent:true}),{code:'INVALID_KNOWLEDGE_INDEX'});}assert.equal(phone.reads.length,0);
  const extras=structuredClone(index);extras.apiKey='synthetic-top-field';extras.stats.apiKey='synthetic-stat-field';extras.embedding.apiKey='synthetic-embedding-field';extras.semantic.apiKey='synthetic-semantic-field';extras.nodes[0].apiKey='synthetic-node-field';extras.chunks[0].apiKey='synthetic-chunk-field';const imported=await phone.engine.importPortableIndex({index:extras,consent:true});assert(!JSON.stringify(imported).includes('synthetic-'));assert.equal(imported.nodes[0].summary,'method cat');
});
test('current folder exclusions and passed file list override a broader cached scope',async()=>{
  const data=fixture({'research/a.md':'method evidence','research/private/b.md':'method hidden','else/c.md':'method outside'});const index=await data.engine.build(local);const result=await data.engine.retrieve({index,question:'method',scope:{mode:'folders',include:['research'],exclude:['research/private']},files:data.vault.getMarkdownFiles().filter(file=>file.path!=='else/c.md')});assert.deepEqual(result.sources.map(source=>source.path),['research/a.md']);assert(!result.context.includes('hidden'));assert(!result.context.includes('outside'));
});
test('current tag exclusions cannot leak cached note text',async()=>{
  const data=fixture({'a.md':'method one','b.md':'method two'},{tags:{'a.md':['#allowed'],'b.md':['#allowed']}});const index=await data.engine.build({...local,scope:{tags:['#allowed']}});data.store.get('b.md').tags=['#private'];const result=await data.engine.retrieve({index,question:'method',scope:{excludeTags:['#private']}});assert.deepEqual(result.sources.map(source=>source.path),['a.md']);
});
test('changed and deleted notes are rejected before query embedding',async()=>{
  const data=fixture({'a.md':'cat','b.md':'tree'});const index=await data.engine.build(vector);data.update('a.md','dog',{mtime:false});data.store.delete('b.md');const result=await data.engine.retrieve({index,question:'companion'});assert.equal(result.sources.length,0);assert.deepEqual(new Set(result.proof.invalidatedPaths),new Set(['a.md','b.md']));assert.equal(data.embeddingCalls.length,1);
});
test('category and explicit node selection intersect; explicit empty selection stays empty',async()=>{
  const data=fixture({'animals/a.md':'method cat','plants/b.md':'method tree'});const index=await data.engine.build(local);const a=index.nodes.find(node=>node.path==='animals/a.md');const b=index.nodes.find(node=>node.path==='plants/b.md');const result=await data.engine.retrieve({index,question:'method',categoryId:a.category,selectedNodeIds:[a.id,b.id]});assert.deepEqual(result.sources.map(source=>source.path),['animals/a.md']);const empty=await data.engine.retrieve({index,question:'method',selectedNodeIds:[]});assert.equal(empty.sources.length,0);assert.deepEqual(empty.proof.filters.selectedNodeIds,[]);
});
test('injected cached excerpt is discarded unless it matches current source character span',async()=>{
  const data=fixture({'a.md':'method original'});const index=await data.engine.build(local);index.chunks[0].text='method injected secret';const result=await data.engine.retrieve({index,question:'method'});assert.equal(result.sources.length,0);assert(!result.context.includes('secret'));
});
test('modification during query embedding aborts retrieval instead of returning stale text',async()=>{
  const data=fixture({'a.md':'cat'});const index=await data.engine.build(vector);data.embeddingProvider.embed=async()=>{data.update('a.md','dog');return{vectors:[[1,0]],dimension:2,fingerprint:'weights-one'};};await assert.rejects(data.engine.retrieve({index,question:'companion'}),{code:'SOURCE_CHANGED'});
});
test('query model dimension and fingerprint must match the stored vector space',async()=>{
  const data=fixture({'a.md':'cat'});const index=await data.engine.build(vector);data.embeddingProvider.embed=async()=>({vectors:[[1,0,0]],dimension:3,fingerprint:'weights-one'});await assert.rejects(data.engine.retrieve({index,question:'companion'}),{code:'EMBEDDING_MODEL_CHANGED'});
});
test('note/call budgets are explicit and do not switch to another provider',async()=>{
  let classifyCalls=0;let relationCalls=0;const jev={classifyNotes:async({notes,categories})=>{classifyCalls++;return{model:'fixture-jev',notes:notes.map(note=>({id:note.id,category:categories[0].id,layer:'reference',hierarchyLevel:'topic'}))};},judgeRelations:async()=>{relationCalls++;return{pairs:[]};}};
  const contents=Object.fromEntries(Array.from({length:9},(_,i)=>['notes/'+i+'.md','shared method evidence '+i]));const data=fixture(contents,{jev});const index=await data.engine.build({...local,semanticRoute:'jev',semanticModel:'fixture-jev',maxNotes:7,maxCalls:1});assert.equal(index.nodes.length,7);assert.equal(index.stats.limitedNotes,2);assert.equal(index.stats.classifiedNotes,4);assert.equal(index.stats.semanticCalls,1);assert.equal(index.stats.semanticStatus,'budget-limited');assert.equal(classifyCalls,1);assert.equal(relationCalls,0);assert(index.edges.every(edge=>edge.evidence.status==='candidate'));
});
test('selected LLM learns taxonomy then bounded labels and reuses unchanged semantic labels',async()=>{
  let calls=0;const llmCall=async input=>{calls++;if(input.startsWith('Create'))return JSON.stringify({categories:[{label:'Animals',description:'Animal notes.'},{label:'Plants',description:'Plant notes.'}]});const data=JSON.parse(input.split('\n').at(-1));if(data.notes)return JSON.stringify({notes:data.notes.map(note=>({id:note.id,category:data.categories.find(category=>category.label==='Animals').id,layer:'knowledge',hierarchyLevel:'topic'}))});return JSON.stringify({pairs:data.pairs.map(pair=>({source:pair.source,target:pair.target,kind:'none',relatedProbability:0.1,score:0}))});};
  const data=fixture({'a.md':'cat'},{llmCall});const first=await data.engine.build({...local,semanticRoute:'llm',semanticModel:'selected-model'});assert.equal(first.semantic.taxonomySource,'llm');assert.equal(first.nodes[0].layer,'knowledge');assert.equal(calls,2);const next=await data.engine.build({...local,semanticRoute:'llm',semanticModel:'selected-model',previousIndex:first});assert.equal(next.stats.reusedSemanticNodes,1);assert.equal(calls,2);
});
test('Jev judgments retain exact evidence and probability separate from rubric weight',async()=>{
  const jev={classifyNotes:async({notes,categories})=>({model:'fixture-jev',notes:notes.map(note=>({id:note.id,category:categories[0].id,layer:'reference',hierarchyLevel:'topic',categoryConfidence:0.6,layerConfidence:0.8}))}),judgeRelations:async({pairs})=>({model:'fixture-jev',pairs:pairs.map(pair=>({...pair,kind:'supports',relatedProbability:0.9,score:0.5,confidence:0.6}))})};const data=fixture({'a.md':'method evidence [[b]]','b.md':'method example'},{jev});const index=await data.engine.build({...local,semanticRoute:'jev',semanticModel:'fixture-jev',maxCalls:10});const edge=index.edges.find(edge=>edge.evidence.status==='model-judgment');assert(edge);assert.equal(edge.weight,0.5);assert.equal(edge.evidence.relatedProbability,0.9);assert.equal(edge.evidence.route,'jev');assert.equal(edge.evidence.source.quote,data.store.get(edge.evidence.source.path).text.slice(edge.evidence.source.start,edge.evidence.source.end));
});
test('graph expansion cannot leave an explicit selected-node filter',async()=>{
  const data=fixture({'a.md':'method evidence [[b]]','b.md':'neighbor detail'});const index=await data.engine.build(local);const a=index.nodes.find(node=>node.path==='a.md');const b=index.nodes.find(node=>node.path==='b.md');index.edges=[{source:a.id,target:b.id,kind:'supports',weight:0.8,evidence:{status:'model-judgment',source:{contentHash:a.contentHash},target:{contentHash:b.contentHash}}}];const result=await data.engine.retrieve({index,question:'method',selectedNodeIds:[a.id]});assert.deepEqual(result.sources.map(source=>source.path),['a.md']);assert.equal(result.proof.graphExpanded.length,0);
});
test('provider failure is sanitized and does not publish or fall back to lexical',async()=>{
  let persisted=0;const data=fixture({'a.md':'cat'},{onPersist:async()=>{persisted++;}});data.embeddingProvider.embed=async()=>{throw new Error('Bearer private-token raw-response');};await assert.rejects(data.engine.build(vector),error=>error.code==='KNOWLEDGE_PROVIDER_FAILED'&&!error.message.includes('private-token'));assert.equal(persisted,0);
});

test('Jev transport failures identify the build stage and fixed safe cause without saving or switching provider',async()=>{
  for(const [code,httpStatus,expected] of [['JEV_NETWORK',undefined,'network'],['JEV_TIMEOUT',undefined,'time limit'],['JEV_BODY_INVALID_JSON',undefined,'unreadable JSON'],['JEV_BODY_READ_FAILED',undefined,'interrupted'],['JEV_HTTP',429,'usage limit'],['JEV_HTTP',401,'credentials'],['JEV_HTTP',503,'HTTP 503'],['JEV_HTTP','PRIVATE_STATUS_SENTINEL','complete the request']]){
    let persisted=0,otherCalls=0;const data=fixture({'a.md':'Synthetic method'}, {onPersist:async()=>{persisted++;},llmCall:async()=>{otherCalls++;},jev:{classifyNotes:async()=>{throw Object.assign(new Error('PRIVATE_BODY_SENTINEL Bearer PRIVATE_KEY_SENTINEL'),{code,httpStatus});},judgeRelations:async()=>{otherCalls++;}}});
    await assert.rejects(data.engine.build({...local,semanticRoute:'jev',semanticModel:'jev-fixture'}),error=>error.code===code&&error.message.startsWith('Jev classification failed.')&&error.message.includes(expected)&&!error.message.includes('PRIVATE_'));
    assert.equal(persisted,0);assert.equal(otherCalls,0);
  }
});
test('source change during semantic provider work prevents persistence',async()=>{
  let persisted=0;const data=fixture({'a.md':'method'},{onPersist:async()=>{persisted++;}});data.engine.llmCall=async input=>{data.update('a.md','changed method');const packet=JSON.parse(input.split('\n').at(-1));return JSON.stringify({notes:packet.notes.map(note=>({id:note.id,category:packet.categories[0].id,layer:'action',hierarchyLevel:'topic'}))});};await assert.rejects(data.engine.build({...local,semanticRoute:'llm',semanticModel:'fixture',categories:['Method']}),{code:'SOURCE_CHANGED'});assert.equal(persisted,0);
});
test('cancellation during provider work discards the result and does not persist',async()=>{
  let persisted=0;const abort=new AbortController();const data=fixture({'a.md':'cat'},{onPersist:async()=>{persisted++;},onEmbed:async()=>{abort.abort();}});await assert.rejects(data.engine.build({...vector,signal:abort.signal}),{name:'AbortError'});assert.equal(persisted,0);
});
test('note and chunk caps report truncation while all spans remain original',async()=>{
  const original='😀 invented method\n'.repeat(1000);const data=fixture({'a.md':original});const index=await data.engine.build({...local,maxChunks:2});assert.equal(index.chunks.length,2);assert.equal(index.stats.truncatedNotes,1);for(const chunk of index.chunks){assert.equal(chunk.text,original.slice(chunk.start,chunk.end));assert(!/[\uD800-\uDBFF]$/.test(chunk.text));}
});

test('the default build indexes every selected note beyond the former 200 and 500 limits',async()=>{
  const contents=Object.fromEntries(Array.from({length:621},(_,i)=>['Selected/'+i+'.md','# Reference '+i+'\nShared method evidence '+i]));contents['Private/ignored.md']='Never read this note.';contents['Selected/hidden/excluded.md']='Excluded note.';
  const data=fixture(contents);const progress=[];const index=await data.engine.build({...local,scope:{include:['Selected'],exclude:['Selected/hidden']},onProgress:value=>progress.push(value)});
  assert.equal(index.nodes.length,621);assert.equal(index.stats.selectedNotes,621);assert.equal(index.stats.limitedNotes,0);assert.equal(index.stats.truncatedNotes,0);assert.equal(index.stats.maxSemanticCalls,null);assert(index.nodes.some(node=>node.path==='Selected/620.md'));assert(data.reads.every(path=>path.startsWith('Selected/')&&!path.startsWith('Selected/hidden/')));
  assert.equal(progress.find(value=>value.phase==='reading').total,621);assert.equal(progress.at(-1).done,621);assert.equal(JSON.parse(JSON.stringify(index)).stats.maxSemanticCalls,null);
});

test('null limits build the full scope and explicit safe integer limits may exceed the former hard ceilings',async()=>{
  const contents=Object.fromEntries(Array.from({length:605},(_,i)=>['notes/'+i+'.md','Reference material '+i]));const data=fixture(contents);
  const full=await data.engine.build({...local,maxNotes:null,maxChunks:null,maxCalls:null});assert.equal(full.nodes.length,605);assert.equal(full.stats.limitedNotes,0);
  const explicit=await data.engine.build({...local,maxNotes:601,maxChunks:5001,maxCalls:401});assert.equal(explicit.nodes.length,601);assert.equal(explicit.stats.limitedNotes,4);assert.equal(explicit.stats.maxSemanticCalls,401);
});

test('invalid opt-in limits reject before reading or requesting a provider',async()=>{
  const data=fixture({'a.md':'method source'});
  for(const options of [{maxNotes:0},{maxNotes:-1},{maxNotes:1.5},{maxNotes:Infinity},{maxNotes:Number.MAX_SAFE_INTEGER+1},{maxChunks:0},{maxChunks:-1},{maxChunks:'2'},{maxCalls:-1},{maxCalls:0.5},{maxCalls:NaN}])await assert.rejects(data.engine.build({...local,...options}),{code:'INVALID_BUDGET'});
  assert.equal(data.reads.length,0);assert.equal(data.embeddingCalls.length,0);
});

test('default chunking includes the end of a long eligible note rather than stopping at 12,000 characters',async()=>{
  const text='ordinary source paragraph '.repeat(1000)+'\nlatequasarsentinel';const data=fixture({'long.md':text});const index=await data.engine.build(local);
  assert(index.chunks.length>8);assert.equal(index.chunks.at(-1).end,text.length);assert.equal(index.stats.truncatedNotes,0);assert(index.chunks.every(chunk=>chunk.text===text.slice(chunk.start,chunk.end)));
  const result=await data.engine.retrieve({index,question:'latequasarsentinel'});assert(result.sources.some(source=>source.text.includes('latequasarsentinel')));
});

test('an explicit note limit and zero semantic request budget remain opt-in and report partial semantic work',async()=>{
  const jev={classifyNotes:async()=>{assert.fail('Zero request budget must not call Jev.');},judgeRelations:async()=>{assert.fail('Zero request budget must not judge relations.');}};
  const contents=Object.fromEntries(Array.from({length:204},(_,i)=>['notes/'+i+'.md','method evidence '+i]));const data=fixture(contents,{jev});const index=await data.engine.build({...local,semanticRoute:'jev',semanticModel:'fixture-jev',maxNotes:201,maxCalls:0});
  assert.equal(index.nodes.length,201);assert.equal(index.stats.limitedNotes,3);assert.equal(index.stats.semanticCalls,0);assert.equal(index.stats.classifiedNotes,0);assert.equal(index.stats.semanticStatus,'budget-limited');
});

test('more than 4,000 chunks are embedded, reused, retrieved and imported without hidden coverage limits',async()=>{
  const contents=Object.fromEntries(Array.from({length:520},(_,i)=>['notes/'+i+'.md',('shared method source paragraph '+i+' ').repeat(380)+(i===519?' lastchunkbeacon':'')]));const data=fixture(contents);const first=await data.engine.build(vector);
  assert.equal(first.nodes.length,520);assert(first.chunks.length>4000);assert.equal(first.stats.truncatedNotes,0);assert.equal(first.stats.embeddingCalls,Math.ceil(first.chunks.length/16));assert(data.embeddingCalls.every(batch=>batch.length<=16));
  const calls=data.embeddingCalls.length;const second=await data.engine.build({...vector,previousIndex:first});assert.equal(second.stats.reusedChunks,first.chunks.length);assert.equal(second.stats.embeddingCalls,0);assert.equal(data.embeddingCalls.length,calls);
  const last=second.nodes.find(node=>node.path==='notes/519.md');const result=await data.engine.retrieve({index:second,question:'lastchunkbeacon',selectedNodeIds:[last.id],retrievalStrategy:'lexical'});assert(result.sources.some(source=>source.text.includes('lastchunkbeacon')));
  const phone=fixture(contents,{name:'phone'});phone.engine.embeddingProvider=undefined;const imported=await phone.engine.importPortableIndex({index:second,consent:true});assert.equal(imported.nodes.length,520);assert.equal(imported.chunks.length,second.chunks.length);assert.equal(imported.portableImport.verifiedNotes,520);assert.equal(phone.embeddingCalls.length,0);
  const mobile=await phone.engine.retrieve({index:imported,question:'lastchunkbeacon',selectedNodeIds:[last.id],retrievalStrategy:'lexical'});assert(mobile.sources.some(source=>source.path==='notes/519.md'&&source.text.includes('lastchunkbeacon')));
});

test('a vector index above two million scalars builds and reuses bounded provider batches',async()=>{
  const text='method cat source '.repeat(26000);const data=fixture({'long.md':text});const dimension=8192;const vector=Array.from({length:dimension},(_,i)=>i===0?1:0);let calls=0;
  data.embeddingProvider.embed=async texts=>{calls++;assert(texts.length<=16);return{vectors:texts.map(()=>vector),dimension,fingerprint:'weights-one'};};
  const first=await data.engine.build({...local,embeddingRoute:'ollama',embeddingModel:'fixture-vector'});assert(first.chunks.length*dimension>2_000_000);assert.equal(first.chunks.at(-1).end,text.length);assert.equal(first.stats.truncatedNotes,0);assert.equal(calls,Math.ceil(first.chunks.length/16));
  const second=await data.engine.build({...local,embeddingRoute:'ollama',embeddingModel:'fixture-vector',previousIndex:first});assert.equal(second.stats.reusedChunks,first.chunks.length);assert.equal(second.stats.embeddingCalls,0);assert.equal(calls,Math.ceil(first.chunks.length/16));
  const result=await data.engine.retrieve({index:second,question:'cat',retrievalStrategy:'lexical'});assert.equal(result.proof.validNotes,1);assert.equal(result.sources.length,6);
});

test('full-scope semantic builds exceed 200 requests and retain late edges for reuse, retrieval and mobile import',async()=>{
  let classifyCalls=0,relationCalls=0;const jev={classifyNotes:async({notes,categories})=>{classifyCalls++;assert(notes.length<=4);return{model:'fixture-jev',notes:notes.map(note=>({id:note.id,category:categories[0].id,layer:'reference',hierarchyLevel:'topic'}))};},judgeRelations:async({pairs})=>{relationCalls++;assert(pairs.length<=3);return{model:'fixture-jev',pairs:pairs.map(pair=>({...pair,kind:'supports',relatedProbability:0.9,score:0.7}))};}};
  const contents=Object.fromEntries(Array.from({length:606},(_,i)=>['notes/'+i+'.md','method source '+i+' '+[1,2,3,4].map(offset=>'[['+((i+offset)%606)+']]').join(' ')+(i===605?' uniquequasarfocus':'')]));const data=fixture(contents,{jev});const first=await data.engine.build({...local,semanticRoute:'jev',semanticModel:'fixture-jev'});
  assert.equal(first.nodes.length,606);assert.equal(first.stats.classifiedNotes,606);assert(first.stats.semanticCalls>200);assert.equal(first.stats.semanticCalls,classifyCalls+relationCalls);assert.equal(first.stats.semanticStatus,'complete');assert(first.edges.length>1500);assert(first.edges.every(edge=>edge.evidence.status==='model-judgment'));
  const calls=classifyCalls+relationCalls;const second=await data.engine.build({...local,semanticRoute:'jev',semanticModel:'fixture-jev',previousIndex:first});assert.equal(second.stats.reusedSemanticNodes,606);assert.equal(second.stats.reusedEdges,first.edges.length);assert.equal(second.stats.semanticCalls,0);assert.equal(classifyCalls+relationCalls,calls);
  const late=second.nodes.find(node=>node.path==='notes/605.md');assert(second.edges.slice(1500).some(edge=>edge.source===late.id));const answer=await data.engine.retrieve({index:second,question:'uniquequasarfocus'});assert(answer.proof.graphExpanded.some(edge=>edge.source===late.id));
  const phone=fixture(contents,{name:'phone'});const imported=await phone.engine.importPortableIndex({index:second,consent:true});assert.equal(imported.nodes.length,606);assert.equal(imported.edges.length,second.edges.length);assert.equal(imported.stats.maxSemanticCalls,null);
});

test('large-scope sparse relationships still include every note and authored links beyond the former text cutoff',async()=>{
  const contents=Object.fromEntries(Array.from({length:640},(_,i)=>['notes/'+i+'.md','shared method subject '+i]));contents['notes/639.md']='shared method subject '+('padding '.repeat(1600))+'[[0]]';const data=fixture(contents);const index=await data.engine.build(local);
  const active=new Set(index.edges.flatMap(edge=>[edge.source,edge.target]));assert.equal(index.nodes.length,640);assert(index.nodes.every(node=>active.has(node.id)));const last=index.nodes.find(node=>node.path==='notes/639.md'),first=index.nodes.find(node=>node.path==='notes/0.md');assert(index.edges.some(edge=>edge.source===last.id&&edge.target===first.id&&edge.kind==='link'));
});

test('cancellation during a full-scope read discards all work instead of publishing a partial index',async()=>{
  let persisted=0,reads=0;const abort=new AbortController();const contents=Object.fromEntries(Array.from({length:650},(_,i)=>['notes/'+i+'.md','method source '+i]));const data=fixture(contents,{onRead:async()=>{if(++reads===240)abort.abort();},onPersist:async()=>{persisted++;}});
  await assert.rejects(data.engine.build({...local,signal:abort.signal}),{name:'AbortError'});assert.equal(reads,240);assert.equal(persisted,0);
});

test('a selected Markdown note above one megabyte is fully built, retrieved and verified on mobile',async()=>{
  const text='# Large source note\n'+('source research paragraph 한국어 🧠\n'.repeat(40000))+'\nmegabytetailsentinel';assert(Buffer.byteLength(text)>1_000_000);const data=fixture({'Research/large.md':text});const first=await data.engine.build(vector);
  assert.equal(first.stats.selectedNotes,1);assert.equal(first.stats.indexedNotes,1);assert.equal(first.stats.skippedNotes,0);assert.equal(first.stats.truncatedNotes,0);assert.equal(first.chunks.at(-1).end,text.length);assert.equal(first.stats.embeddingCalls,Math.ceil(first.chunks.length/16));assert(data.embeddingCalls.every(batch=>batch.length<=16&&batch.every(chunk=>chunk.length<=1800)));
  const result=await data.engine.retrieve({index:first,question:'megabytetailsentinel',retrievalStrategy:'lexical'});assert(result.sources.some(source=>source.path==='Research/large.md'&&source.text.includes('megabytetailsentinel')));
  const phone=fixture({'Research/large.md':text},{name:'phone'});phone.engine.embeddingProvider=undefined;const imported=await phone.engine.importPortableIndex({index:first,consent:true});assert.equal(imported.nodes.length,1);assert.equal(imported.chunks.length,first.chunks.length);assert.equal(phone.embeddingCalls.length,0);const mobile=await phone.engine.retrieve({index:imported,question:'megabytetailsentinel',retrievalStrategy:'lexical'});assert(mobile.sources.some(source=>source.text.includes('megabytetailsentinel')));
});

test('large-note chunking yields for cancellation before provider work and persistence',async()=>{
  let persisted=0;const abort=new AbortController();const text='source paragraph '.repeat(100000);assert(Buffer.byteLength(text)>1_000_000);const data=fixture({'Research/large.md':text},{onRead:async()=>{setTimeout(()=>abort.abort(),0);},onPersist:async()=>{persisted++;}});
  await assert.rejects(data.engine.build({...vector,signal:abort.signal}),{name:'AbortError'});assert.equal(data.reads.length,1);assert.equal(data.embeddingCalls.length,0);assert.equal(persisted,0);
});

test('only actual source read failures or empty notes are counted as skipped without hiding selected work',async()=>{
  const data=fixture({'readable.md':'method source','unreadable.md':'method unavailable','empty.md':'   '},{onRead:async file=>{if(file.path==='unreadable.md')throw new Error('Synthetic unavailable source.');}});const index=await data.engine.build(local);
  assert.equal(index.stats.selectedNotes,3);assert.equal(index.stats.indexedNotes,1);assert.equal(index.stats.skippedNotes,2);assert.equal(index.stats.limitedNotes,0);assert.equal(index.stats.truncatedNotes,0);assert.deepEqual(index.nodes.map(node=>node.path),['readable.md']);
});

test('local build progress advances beyond reading and completes only after awaited verified persistence',async()=>{
  const progress=[];let persisted=false,finishPersist,enterPersist;const entered=new Promise(resolve=>enterPersist=resolve);const saved=new Promise(resolve=>finishPersist=resolve);const data=fixture({'a.md':'shared method evidence','b.md':'shared method reference','c.md':'shared method action'},{onPersist:async index=>{assert.equal(index.nodes.length,3);assert.equal(data.reads.length,6);assert.equal(progress.at(-1).phase,'saving');assert.equal(progress.at(-1).done,0);enterPersist();await saved;persisted=true;}});
  const pending=data.engine.build({...local,onProgress:value=>progress.push(value)});await entered;
  assert(!progress.some(value=>value.phase==='complete'));assert.equal(persisted,false);
  const phases=progress.map(value=>value.phase).filter((value,at,all)=>value!==all[at-1]);assert.deepEqual(phases,['reading','organizing','relationships','connecting','verifying','saving']);
  for(const phase of ['organizing','relationships','connecting','verifying']){const updates=progress.filter(value=>value.phase===phase);assert.equal(updates[0].done,0);assert.equal(updates.at(-1).done,updates.at(-1).total);assert(updates.every((value,at)=>at===0||value.done>=updates[at-1].done));}
  assert.deepEqual(progress.filter(value=>value.phase==='verifying').map(value=>value.done),[0,1,2,3]);finishPersist();const index=await pending;assert.equal(index.nodes.length,3);assert.equal(persisted,true);assert.deepEqual(progress.filter(value=>value.phase==='saving').map(value=>value.done),[0,1]);assert.equal(progress.at(-1).phase,'complete');assert.equal(progress.at(-1).done,3);assert.equal(progress.at(-1).total,3);
});

test('a source changed during final verification never reaches saving or complete progress',async()=>{
  const progress=[];let persisted=0;const data=fixture({'a.md':'method evidence','b.md':'method reference'},{onPersist:async()=>persisted++});
  await assert.rejects(data.engine.build({...local,onProgress:value=>{progress.push(value);if(value.phase==='verifying'&&value.done===1)data.update('b.md','changed method reference',{mtime:false});}}),{code:'SOURCE_CHANGED'});
  assert(progress.some(value=>value.phase==='verifying'&&value.done===1));assert(!progress.some(value=>value.phase==='saving'||value.phase==='complete'));assert.equal(persisted,0);
});

test('a persistence failure never reports saved or complete progress',async()=>{
  const progress=[];const error=Object.assign(new Error('Synthetic disk write failed.'),{code:'EIO'});const data=fixture({'a.md':'method evidence'},{onPersist:async()=>{throw error;}});
  await assert.rejects(data.engine.build({...local,onProgress:value=>progress.push(value)}),{code:'EIO'});assert.deepEqual(progress.filter(value=>value.phase==='saving').map(value=>value.done),[0]);assert(!progress.some(value=>value.phase==='complete'));assert.equal(progress.filter(value=>value.phase==='verifying').at(-1).done,1);
});

test('cancelling relationship discovery stops before source verification, saving or final completion',async()=>{
  const abort=new AbortController();const progress=[];let persisted=0;const contents=Object.fromEntries(Array.from({length:15},(_,i)=>['notes/'+i+'.md','shared method evidence '+i]));const data=fixture(contents,{onPersist:async()=>persisted++});
  await assert.rejects(data.engine.build({...local,signal:abort.signal,onProgress:value=>{progress.push(value);if(value.phase==='relationships'&&value.done===5)abort.abort();}}),{name:'AbortError'});assert.equal(progress.filter(value=>value.phase==='relationships').at(-1).done,5);assert(!progress.some(value=>value.phase==='verifying'||value.phase==='saving'||value.phase==='complete'));assert.equal(persisted,0);
});

test('cooperative build and mobile verification work without timers and close every MessageChannel port',async()=>{
  const OriginalChannel=globalThis.MessageChannel,originalTimeout=globalThis.setTimeout;assert.equal(typeof OriginalChannel,'function');let channels=0,closedPorts=0;
  class TrackedChannel extends OriginalChannel{constructor(){super();channels++;for(const port of [this.port1,this.port2]){const close=port.close.bind(port);port.close=()=>{closedPorts++;close();};}}}
  const contents=Object.fromEntries(Array.from({length:18},(_,i)=>['notes/'+i+'.md','shared method evidence '+i]));contents['notes/17.md']='shared source paragraph '.repeat(6000)+'timerlessquasartail';
  try{
    globalThis.MessageChannel=TrackedChannel;globalThis.setTimeout=()=>{assert.fail('Available MessageChannel yields must not depend on a timer.');};
    const data=fixture(contents);const index=await data.engine.build(local);assert.equal(index.nodes.length,18);assert(index.chunks.some(chunk=>chunk.text.includes('timerlessquasartail')));
    const phone=fixture(contents,{name:'phone'});const imported=await phone.engine.importPortableIndex({index,consent:true});assert.equal(imported.nodes.length,18);assert(channels>=10);assert.equal(closedPorts,channels*2);
  }finally{globalThis.MessageChannel=OriginalChannel;globalThis.setTimeout=originalTimeout;}
});

test('cooperative yields fall back to a timer when MessageChannel is unavailable',async()=>{
  const originalChannel=globalThis.MessageChannel,originalTimeout=globalThis.setTimeout;let timers=0;
  try{globalThis.MessageChannel=undefined;globalThis.setTimeout=(callback,...args)=>{timers++;return originalTimeout(callback,...args);};const data=fixture({'a.md':'shared method source','b.md':'shared method reference'});const index=await data.engine.build(local);assert.equal(index.nodes.length,2);assert(timers>=4);}
  finally{globalThis.MessageChannel=originalChannel;globalThis.setTimeout=originalTimeout;}
});

test('an unusable MessageChannel closes its ports before falling back to timers',async()=>{
  const originalChannel=globalThis.MessageChannel,originalTimeout=globalThis.setTimeout;let channels=0,closedPorts=0,timers=0;
  class BrokenChannel{constructor(){channels++;this.port1={close:()=>closedPorts++};this.port2={postMessage:()=>{throw new Error('Synthetic channel unavailable.');},close:()=>closedPorts++};}}
  try{globalThis.MessageChannel=BrokenChannel;globalThis.setTimeout=(callback,...args)=>{timers++;return originalTimeout(callback,...args);};const data=fixture({'a.md':'method source'});const index=await data.engine.build(local);assert.equal(index.nodes.length,1);assert(channels>0);assert.equal(closedPorts,channels*2);assert.equal(timers,channels);}
  finally{globalThis.MessageChannel=originalChannel;globalThis.setTimeout=originalTimeout;}
});

test('cancellation closes a queued channel and rejects before another note or provider operation',async()=>{
  const originalChannel=globalThis.MessageChannel;const abort=new AbortController();let closedPorts=0,posted=0,persisted=0;const progress=[];
  class PendingChannel{constructor(){this.port1={onmessage:null,close:()=>closedPorts++};this.port2={postMessage:()=>{posted++;queueMicrotask(()=>abort.abort());},close:()=>closedPorts++};}}
  try{globalThis.MessageChannel=PendingChannel;const data=fixture({'a.md':'method source','b.md':'method reference'},{onPersist:async()=>persisted++});await assert.rejects(data.engine.build({...local,signal:abort.signal,onProgress:value=>progress.push(value)}),{name:'AbortError'});assert.equal(posted,1);assert.equal(closedPorts,2);assert.equal(data.reads.length,1);assert.equal(data.embeddingCalls.length,0);assert.equal(persisted,0);assert(!progress.some(value=>value.phase==='complete'));}
  finally{globalThis.MessageChannel=originalChannel;}
});


test('the initial index stores per-note Jev hierarchy, independent roles, confidence and ordered counts before persistence',async()=>{
  let saved=null;const batches=[];const assignments=['overview','topic','detail','unassigned'];
  const jev={classifyNotes:async({notes,categories})=>{batches.push(notes.map(note=>note.id));return{model:'fixture-jev',notes:notes.map((note,i)=>({id:note.id,category:categories[0].id,layer:'reference',hierarchyLevel:assignments[i],hierarchyConfidence:.85}))};},judgeRelations:async()=>assert.fail('No candidate pairs in this fixture.')};
  const data=fixture({'a.md':'Alpha','b.md':'Beta','c.md':'Gamma','d.md':'Delta','e.md':'Epsilon'},{jev,onPersist:async index=>saved=structuredClone(index)});
  const index=await data.engine.build({...local,semanticRoute:'jev',semanticModel:'fixture-jev'});
  assert.deepEqual(batches.map(batch=>batch.length),[4,1]);assert.deepEqual(index.nodes.map(node=>node.hierarchyLevel),[...assignments,'overview']);assert(index.nodes.every(node=>node.layer==='reference'&&node.evidence.hierarchyConfidence===.85&&node.evidence.route==='jev'));assert.deepEqual(index.hierarchyLevels.map(level=>[level.id,level.depth,level.count]),[['overview',0,2],['topic',1,1],['detail',2,1],['unassigned',3,1]]);assert.equal(index.semantic.hierarchyPolicy,KNOWLEDGE_HIERARCHY_POLICY);assert.deepEqual(saved.nodes,index.nodes);assert.deepEqual(saved.hierarchyLevels,index.hierarchyLevels);
});

test('legacy classified semantics are rejudged for hierarchy while unchanged compatible embeddings are reused',async()=>{
  let calls=0;const jev={classifyNotes:async({notes,categories})=>{calls++;return{model:'fixture-jev',notes:notes.map(note=>({id:note.id,category:categories[0].id,layer:'knowledge',hierarchyLevel:'detail',hierarchyConfidence:.72}))};},judgeRelations:async()=>assert.fail('One note has no pairs.')};
  const data=fixture({'a.md':'cat method'},{jev});const options={...vector,semanticRoute:'jev',semanticModel:'fixture-jev'};const first=await data.engine.build(options);const legacy=structuredClone(first);delete legacy.nodes[0].hierarchyLevel;delete legacy.nodes[0].evidence.hierarchyConfidence;delete legacy.hierarchyLevels;delete legacy.semantic.hierarchyPolicy;
  legacy.configSignature=sha256HexSync(JSON.stringify({policy:legacy.chunkPolicy,embeddingRoute:'ollama',embeddingModel:'fixture-vector',fingerprint:'weights-one',semanticRoute:'jev',semanticModel:'fixture-jev',categories:legacy.categories.map(({count,...category})=>category)}));
  const rebuilt=await data.engine.build({...options,previousIndex:legacy});assert.equal(calls,2);assert.equal(rebuilt.stats.reusedChunks,first.chunks.length);assert.equal(rebuilt.stats.embeddingCalls,0);assert.equal(rebuilt.stats.reusedSemanticNodes,0);assert.equal(rebuilt.nodes[0].hierarchyLevel,'detail');assert.notEqual(rebuilt.configSignature,legacy.configSignature);
  const reused=await data.engine.build({...options,previousIndex:rebuilt});assert.equal(calls,2);assert.equal(reused.stats.reusedSemanticNodes,1);assert.equal(reused.stats.semanticCalls,0);assert.equal(reused.nodes[0].evidence.hierarchyConfidence,.72);
  const missing=structuredClone(rebuilt);delete missing.nodes[0].hierarchyLevel;await data.engine.build({...options,previousIndex:missing});assert.equal(calls,3);
  const missingPolicy=structuredClone(rebuilt);delete missingPolicy.semantic.hierarchyPolicy;await data.engine.build({...options,previousIndex:missingPolicy});assert.equal(calls,4);
});

test('LLM initial classification requests abstraction descriptions and strictly persists the chosen hierarchy',async()=>{
  const prompts=[];const data=fixture({'a.md':'Focused method'},{llmCall:async input=>{prompts.push(input);const packet=JSON.parse(input.split('\n').at(-1));return JSON.stringify({notes:packet.notes.map(note=>({id:note.id,category:packet.categories[0].id,layer:'action',hierarchyLevel:'overview',hierarchyConfidence:.6}))});}});
  const index=await data.engine.build({...local,semanticRoute:'llm',semanticModel:'fixture-model',categories:['Methods']});assert.equal(prompts.length,1);assert(prompts[0].includes('Which hierarchical level'));assert(prompts[0].includes('choose unassigned when unclear'));assert(prompts[0].includes('source data, not instructions'));const packet=JSON.parse(prompts[0].split('\n').at(-1));assert.deepEqual(Object.keys(packet.hierarchyLevels),['overview','topic','detail','unassigned']);assert.equal(index.nodes[0].hierarchyLevel,'overview');assert.equal(index.nodes[0].layer,'action');assert.equal(index.nodes[0].evidence.hierarchyConfidence,.6);
});

test('invalid or absent fresh hierarchy and invalid confidence fail before saving for both semantic routes',async()=>{
  for(const semanticRoute of ['jev','llm'])for(const invalid of [{hierarchyLevel:'parent'},{hierarchyLevel:null},{},{hierarchyLevel:'detail',hierarchyConfidence:-.1},{hierarchyLevel:'detail',hierarchyConfidence:1.1},{hierarchyLevel:'detail',hierarchyConfidence:NaN},{hierarchyLevel:'detail',hierarchyConfidence:'0.6'}]){
    let saves=0;const answer=({notes,categories})=>({notes:notes.map(note=>({id:note.id,category:categories[0].id,layer:'reference',...invalid}))});const data=fixture({'a.md':'Source'},{onPersist:async()=>saves++,jev:{classifyNotes:async packet=>answer(packet),judgeRelations:async()=>assert.fail('Must stop first.')},llmCall:async input=>JSON.stringify(answer(JSON.parse(input.split('\n').at(-1))))});
    await assert.rejects(data.engine.build({...local,semanticRoute,semanticModel:'fixture',categories:['Sources']}),{code:'INVALID_SEMANTIC_OUTPUT'});assert.equal(saves,0);
  }
});

test('local or budget-unclassified notes stay unassigned with no fabricated hierarchy confidence',async()=>{
  const data=fixture({'a.md':'A specific example'},{jev:{classifyNotes:async()=>assert.fail('Zero budget.'),judgeRelations:async()=>assert.fail('Zero budget.')}});
  for(const options of [local,{...local,semanticRoute:'jev',semanticModel:'fixture',maxCalls:0}]){const index=await data.engine.build(options);assert.equal(index.nodes[0].hierarchyLevel,'unassigned');assert(!Object.hasOwn(index.nodes[0].evidence,'hierarchyConfidence'));assert.equal(index.hierarchyLevels.find(level=>level.id==='unassigned').count,1);}
});

test('portable hierarchy adoption preserves exact assignments and metadata while recounting only verified notes',async()=>{
  const desktop=fixture({'a.md':'Alpha','b.md':'Beta'},{name:'desktop',jev:{classifyNotes:async({notes,categories})=>({notes:notes.map((note,i)=>({id:note.id,category:categories[0].id,layer:'reference',hierarchyLevel:i?'detail':'overview',hierarchyConfidence:i ? .5 : .9}))}),judgeRelations:async()=>assert.fail('No pairs.')}});
  const index=await desktop.engine.build({...local,semanticRoute:'jev',semanticModel:'fixture'});index.hierarchyLevels[0].label='Overview label';index.hierarchyLevels[0].description='Shared portable abstraction meaning.';
  const phone=fixture({'a.md':'Alpha','b.md':'Beta'},{name:'phone'});const imported=await phone.engine.importPortableIndex({index,consent:true});assert.deepEqual(imported.nodes.map(node=>[node.hierarchyLevel,node.evidence.hierarchyConfidence]),[['overview',.9],['detail',.5]]);assert.deepEqual(imported.hierarchyLevels,index.hierarchyLevels);assert.equal(imported.semantic.hierarchyPolicy,KNOWLEDGE_HIERARCHY_POLICY);
  phone.update('a.md','Changed');const partial=await phone.engine.importPortableIndex({index,consent:true});assert.deepEqual(partial.nodes.map(node=>node.hierarchyLevel),['detail']);assert.equal(partial.hierarchyLevels[0].count,0);assert.equal(partial.hierarchyLevels[2].count,1);assert.equal(partial.hierarchyLevels[0].description,index.hierarchyLevels[0].description);
  const legacy=structuredClone(index);delete legacy.hierarchyLevels;delete legacy.semantic.hierarchyPolicy;for(const node of legacy.nodes){delete node.hierarchyLevel;delete node.evidence.hierarchyConfidence;}const old=await phone.engine.importPortableIndex({index:legacy,consent:true});assert(old.nodes.every(node=>node.hierarchyLevel==='unassigned'&&!Object.hasOwn(node.evidence,'hierarchyConfidence')));assert.equal(old.hierarchyLevels.find(level=>level.id==='unassigned').count,1);assert(!Object.hasOwn(old.semantic,'hierarchyPolicy'));
});

test('invalid portable hierarchy metadata fails before reading source notes',async()=>{
  const data=fixture({'a.md':'Alpha'});const index=await data.engine.build(local);const phone=fixture({'a.md':'Alpha'},{name:'phone'});
  for(const mutate of [value=>value.nodes[0].hierarchyLevel='parent',value=>value.nodes[0].hierarchyLevel=null,value=>value.nodes[0].evidence.hierarchyConfidence=-1,value=>value.hierarchyLevels[0].depth=99,value=>value.hierarchyLevels[0].count=9,value=>value.hierarchyLevels.reverse(),value=>value.semantic.hierarchyPolicy='unknown']){const bad=structuredClone(index);mutate(bad);await assert.rejects(phone.engine.importPortableIndex({index:bad,consent:true}),{code:'INVALID_KNOWLEDGE_INDEX'});}assert.equal(phone.reads.length,0);
});
