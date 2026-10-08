import test from 'node:test';
import assert from 'node:assert/strict';
import {OllamaEmbeddingsProvider,normalizeVector} from '../src/providers/ollama-embeddings.mjs';

function fixture({models=[{name:'fixture-embed:latest',digest:'weights-a'},{name:'fixture-chat:latest',digest:'weights-b'}],vectors=[[3,4],[0,2]],status=200}={}){
  const calls=[];const provider=new OllamaEmbeddingsProvider({fetchImpl:async(url,options)=>{
    calls.push({url,options,body:options.body?JSON.parse(options.body):null});
    const path=new URL(url).pathname;const body=path==='/api/tags'?{models}:path==='/api/show'?{capabilities:JSON.parse(options.body).model.includes('embed')?['embedding']:['completion']}:{embeddings:vectors};
    return{ok:status===200,status,body:{cancel:async()=>{}},json:async()=>body};
  }});return{provider,calls};
}
test('catalog includes actual installed embedding capabilities, not general chat models',async()=>{
  const {provider,calls}=fixture();const models=await provider.listModels();assert.deepEqual(models.map(model=>model.id),['fixture-embed:latest']);assert.equal(models[0].digest,'weights-a');assert.equal(calls.length,3);assert(calls.every(call=>['/api/tags','/api/show'].includes(new URL(call.url).pathname)));
});
test('embedding request is batched, non-truncating, installed-only and normalized',async()=>{
  const {provider,calls}=fixture();const result=await provider.embed(['invented alpha','invented beta'],{model:'fixture-embed:latest'});assert.deepEqual(result.vectors,[[0.6,0.8],[0,1]]);assert.equal(result.dimension,2);assert.equal(result.fingerprint,'weights-a');const call=calls.at(-1);assert.deepEqual(call.body,{model:'fixture-embed:latest',input:['invented alpha','invented beta'],truncate:false,keep_alive:'5m'});assert.equal(call.options.redirect,'error');assert.equal(call.options.headers.authorization,undefined);assert(!calls.some(call=>call.url.includes('/pull')));
});
test('uninstalled model cannot cause embed or pull calls',async()=>{
  const {provider,calls}=fixture();await assert.rejects(provider.embed(['fiction'],{model:'missing'}),{code:'MODEL_NOT_INSTALLED'});assert.equal(calls.length,1);
});
test('installed chat model cannot be silently treated as embeddings',async()=>{
  const {provider,calls}=fixture();await assert.rejects(provider.embed(['fiction'],{model:'fixture-chat:latest'}),{code:'EMBEDDING_NOT_SUPPORTED'});assert.equal(calls.length,2);
});
test('cloud-backed tags are omitted and cannot be embedded',async()=>{
  const {provider,calls}=fixture({models:[{name:'fake:cloud',digest:'a'},{name:'remote-embed',remote_host:'https://example.invalid'},{name:'fixture-embed:latest',digest:'b'}]});const models=await provider.listModels();assert.deepEqual(models.map(model=>model.id),['fixture-embed:latest']);assert(!calls.some(call=>call.body?.model==='fake:cloud'||call.body?.model==='remote-embed'));
});
for(const endpoint of ['https://127.0.0.1:11434','http://example.com:11434','http://127.0.0.1:11434/path','http://user:secret@localhost:11434','http://127.0.0.1:11434/?secret=value'])test('rejects nonlocal or credential endpoint '+endpoint,()=>{assert.throws(()=>new OllamaEmbeddingsProvider({baseUrl:endpoint}),{code:'INVALID_LOCAL_ENDPOINT'});});
test('accepts IPv6 loopback without credentials',()=>{assert.equal(new OllamaEmbeddingsProvider({baseUrl:'http://[::1]:11434'}).baseUrl,'http://[::1]:11434');});
test('malformed dimensions, zero vectors and nonfinite values fail',()=>{
  for(const vector of [[],[0,0],[NaN,1],[Infinity,2],['1',2]])assert.throws(()=>normalizeVector(vector),{code:'INVALID_EMBEDDING'});assert.throws(()=>normalizeVector([1,2],3),{code:'INVALID_EMBEDDING'});assert.deepEqual(normalizeVector([1e300,0]),[1,0]);
});
test('response cardinality must match requested inputs',async()=>{
  const {provider}=fixture({vectors:[[1,0]]});await assert.rejects(provider.embed(['one','two'],{model:'fixture-embed:latest'}),{code:'INVALID_EMBEDDING'});
});
test('response vectors must all have the same dimension',async()=>{
  const {provider}=fixture({vectors:[[1,0],[1,0,0]]});await assert.rejects(provider.embed(['one','two'],{model:'fixture-embed:latest'}),{code:'INVALID_EMBEDDING'});
});
test('abort before discovery performs no network operation',async()=>{
  const {provider,calls}=fixture();const abort=new AbortController();abort.abort();await assert.rejects(provider.listModels({signal:abort.signal}),{name:'AbortError'});assert.equal(calls.length,0);
});
test('abort during a local request propagates cancellation without provider text',async()=>{
  const abort=new AbortController();const provider=new OllamaEmbeddingsProvider({fetchImpl:async()=>{abort.abort();throw new Error('private value');}});await assert.rejects(provider.listModels({signal:abort.signal}),error=>error.name==='AbortError'&&!error.message.includes('private'));
});
test('HTTP failure never reads or echoes a raw server error body',async()=>{
  const {provider}=fixture({status:500});await assert.rejects(provider.listModels(),error=>error.code==='OLLAMA_REQUEST_FAILED'&&error.message.includes('500')&&!error.message.includes('weights'));
});
