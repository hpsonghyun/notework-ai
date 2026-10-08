import test from 'node:test';
import assert from 'node:assert/strict';
import {KnowledgeEngine,knowledgeChunkingForPolicy,KNOWLEDGE_CHUNK_POLICY} from '../src/knowledge-engine.mjs';
import {OllamaEmbeddingsProvider} from '../src/providers/ollama-embeddings.mjs';
import {sha256HexSync} from '../src/portable-crypto.mjs';

function fixture(contents,{contextLength=256,name='Synthetic adaptive desktop',onEmbed}={}){
  const files=new Map(Object.entries(contents).map(([path,text])=>[path,{path,stat:{mtime:1,size:Buffer.byteLength(text)}}]));const calls=[];let preparedContext=contextLength;
  const vault={getName:()=>name,getMarkdownFiles:()=>[...files.values()],getAbstractFileByPath:path=>files.get(path),read:async file=>contents[file.path]};
  const embeddingProvider={prepareModel:async()=>({model:'synthetic-small:latest',fingerprint:'fixture-weights',...(preparedContext!==undefined?{contextLength:preparedContext}:{})}),embed:async(texts,options)=>{calls.push(texts);if(onEmbed)await onEmbed(texts,options);return{model:'synthetic-small:latest',fingerprint:'fixture-weights',dimension:2,vectors:texts.map(()=>[1,0])};}};
  const engine=new KnowledgeEngine({vault,getTags:()=>[],embeddingProvider,clock:()=>new Date('2026-10-07T12:00:00Z')});return{engine,vault,calls,setContext:value=>{preparedContext=value;}};
}
const vector={embeddingRoute:'ollama',embeddingModel:'synthetic-small:latest',semanticRoute:'none',consent:true};
function fullOriginalCoverage(index,path,original){
  const chunks=index.chunks.filter(chunk=>chunk.path===path);let covered=0;
  assert.equal(chunks[0].start,0);
  for(const chunk of chunks){assert.equal(chunk.text,original.slice(chunk.start,chunk.end));assert.equal(chunk.contentHash,sha256HexSync(original));assert(chunk.start<=covered,'No original-text gap is hidden.');assert(chunk.end>chunk.start);assert(!/^[\uDC00-\uDFFF]/.test(chunk.text));assert(!/[\uD800-\uDBFF]$/.test(chunk.text));covered=Math.max(covered,chunk.end);}
  assert.equal(covered,original.length);
}
test('small verified context uses bounded multilingual UTF-8 windows while indexing every original span',async()=>{
  const original=('# Korean evidence\n한국어😀 한자漢字 code é token retrieval. '.repeat(180))+'\nLATE_SOURCE_SENTINEL';
  const f=fixture({'Research/long.md':original,'Research/last.md':'A final independently selected note.'});const index=await f.engine.build(vector);const policy=knowledgeChunkingForPolicy(index.chunkPolicy);
  assert.notEqual(index.chunkPolicy,KNOWLEDGE_CHUNK_POLICY);assert.deepEqual(policy,{maxChars:1800,maxBytes:168,overlapChars:21});assert.equal(index.embedding.contextLength,256);assert.equal(index.stats.selectedNotes,2);assert.equal(index.nodes.length,2);assert.equal(index.stats.truncatedNotes,0);assert.equal(index.stats.limitedNotes,0);assert.equal(index.stats.skippedNotes,0);
  fullOriginalCoverage(index,'Research/long.md',original);assert(index.chunks.some(chunk=>chunk.text.includes('LATE_SOURCE_SENTINEL')));
  const inputs=f.calls.flat();assert.equal(inputs.length,index.chunks.length);assert(inputs.every(text=>Buffer.byteLength(text)<=policy.maxBytes));assert(f.calls.every(batch=>batch.length<=16));
});
test('unchanged adaptive policy reuses all vectors; changed verified context recuts and reembeds',async()=>{
  const original='한글😀 exact unchanged original evidence '.repeat(90);const f=fixture({'long.md':original});const first=await f.engine.build(vector);const calls=f.calls.length;
  const same=await f.engine.build({...vector,previousIndex:first});assert.equal(f.calls.length,calls);assert.equal(same.stats.reusedChunks,first.chunks.length);assert.equal(same.chunkPolicy,first.chunkPolicy);
  f.setContext(128);const smaller=await f.engine.build({...vector,previousIndex:same});assert.notEqual(smaller.chunkPolicy,same.chunkPolicy);assert.equal(smaller.stats.reusedChunks,0);assert(smaller.chunks.length>same.chunks.length);assert.notEqual(smaller.configSignature,same.configSignature);assert.equal(smaller.datasetHash,same.datasetHash);fullOriginalCoverage(smaller,'long.md',original);assert(smaller.chunks.every(chunk=>Buffer.byteLength(chunk.text)<=72));
});
test('unavailable model context retains the legacy policy and lexical builds never consult embeddings',async()=>{
  const f=fixture({'a.md':'Source '.repeat(500)});f.setContext(undefined);const unknown=await f.engine.build(vector);assert.equal(unknown.chunkPolicy,KNOWLEDGE_CHUNK_POLICY);assert.equal(unknown.embedding.contextLength,undefined);
  f.engine.embeddingProvider.prepareModel=async()=>{throw new Error('Must not prepare lexical builds');};const lexical=await f.engine.build({consent:true,embeddingRoute:'lexical',semanticRoute:'none'});assert.equal(lexical.chunkPolicy,KNOWLEDGE_CHUNK_POLICY);assert.equal(lexical.stats.embeddingCalls,0);
});
test('adaptive policy remains usable in retrieval and mobile adoption without embedding calls',async()=>{
  const original='한국어😀 evidence retrieval '.repeat(120);const desktop=fixture({'Research/a.md':original});const index=await desktop.engine.build(vector);const calls=desktop.calls.length;
  const retrieval=await desktop.engine.retrieve({index,question:'evidence',retrievalStrategy:'lexical'});assert(retrieval.sources.length);assert.equal(desktop.calls.length,calls);
  const phone=fixture({'Research/a.md':original},{name:'Synthetic adaptive phone'});phone.engine.embeddingProvider=undefined;
  const adopted=await phone.engine.importPortableIndex({index,consent:true});assert.equal(adopted.chunkPolicy,index.chunkPolicy);assert.equal(adopted.chunks.length,index.chunks.length);fullOriginalCoverage(adopted,'Research/a.md',original);const found=await phone.engine.retrieve({index:adopted,question:'evidence',retrievalStrategy:'lexical'});assert(found.sources.length);assert.equal(phone.calls.length,0);
});
test('actual strict embedding rejection remains visible rather than truncating or silently changing routes',async()=>{
  const f=fixture({'a.md':'An adversarial tokenizer input '.repeat(30)},{onEmbed:()=>{throw new Error('Synthetic strict model context failure');}});let saved=0;f.engine.onPersist=async()=>{saved++;};await assert.rejects(f.engine.build(vector),{code:'KNOWLEDGE_PROVIDER_FAILED'});assert.equal(saved,0);assert.equal(f.calls.length,1);
});
test('adaptive policies reject malformed bounds and bad metadata before reading or embedding',async()=>{
  for(const policy of ['knowledge-v2-char1800-utf8168-overlap200','knowledge-v2-char1800-utf80168-overlap21','knowledge-v2-char1800-utf823-overlap2','knowledge-v2-char1800-utf87201-overlap200','knowledge-v2-char1800-utf8168-overlap021','knowledge-v2-char900-utf8168-overlap21'])assert.equal(knowledgeChunkingForPolicy(policy),null);
  for(const contextLength of [1,63,-1,1.5,Infinity,'256',1048577]){const f=fixture({'a.md':'Safe note.'},{contextLength});await assert.rejects(f.engine.build(vector),{code:'INVALID_EMBEDDING_CONTEXT'});assert.equal(f.calls.length,0);}
});
test('minimum supported adaptive window does not split multibyte code points or drop any span',async()=>{
  const original='😀漢한字🧭'.repeat(200);const f=fixture({'symbols.md':original},{contextLength:64});const index=await f.engine.build(vector);assert(index.chunks.every(chunk=>Buffer.byteLength(chunk.text)<=24));fullOriginalCoverage(index,'symbols.md',original);assert.equal(index.stats.truncatedNotes,0);
});
test('provider exposes only verified architecture context and honors a smaller explicit num_ctx',async()=>{
  for(const [details,expected]of [
    [{model_info:{'general.architecture':'bert','bert.context_length':512},parameters:'num_ctx 256\nstop "ignored"'},256],
    [{model_info:{'general.architecture':'gemma','gemma.context_length':2048}},2048],
    [{model_info:{'general.architecture':'bert','bert.context_length':512},parameters:'num_ctx 8192'},512],
    [{model_info:{'general.architecture':'bert','unrelated.context_length':512}},undefined],
    [{model_info:{'general.architecture':'bert','bert.context_length':'256'}},undefined],
    [{model_info:{'general.architecture':'bert','bert.context_length':Infinity}},undefined],
  ]){
    const provider=new OllamaEmbeddingsProvider({fetchImpl:async(url,options)=>new Response(JSON.stringify(new URL(url).pathname==='/api/tags'?{models:[{name:'verified-small:latest',digest:'fixture'}]}:{capabilities:['embedding'],...details}))});
    assert.equal((await provider.prepareModel('verified-small')).contextLength,expected);
  }
});
