import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {OllamaEmbeddingsProvider} from '../src/providers/ollama-embeddings.mjs';
import {desktopFetch} from '../src/desktop-fetch.mjs';

const encoder=new TextEncoder();
function downloadFixture({frames=[{status:'pulling manifest'},{status:'pulling layer',total:200,completed:100},{status:'success'}],text,models=[{name:'embeddinggemma:latest',digest:'synthetic-digest'}],details={capabilities:['embedding']},streamError,headers,split=11,pullTimeoutMs,hang=false}={}){
  const calls=[];let cancelled=false;
  const provider=new OllamaEmbeddingsProvider({pullTimeoutMs,fetchImpl:async(url,options)=>{
    const path=new URL(url).pathname;calls.push({path,options,body:options.body?JSON.parse(options.body):null});
    if(path==='/api/tags')return new Response(JSON.stringify({models}));
    if(path==='/api/show')return new Response(JSON.stringify(details));
    const bytes=encoder.encode(text??frames.map(frame=>JSON.stringify(frame)).join('\n'));let offset=0;
    return {ok:true,status:200,headers:new Headers(headers),body:new ReadableStream({
      pull(controller){if(offset<bytes.length){controller.enqueue(bytes.slice(offset,offset+split));offset+=split;}else if(streamError)controller.error(new Error('secret server stream body'));else if(!hang)controller.close();},
      cancel(){cancelled=true;},
    })};
  }});
  return {provider,calls,wasCancelled:()=>cancelled};
}
test('explicit download consumes split NDJSON and verifies installed embedding metadata before ready',async()=>{
  const {provider,calls}=downloadFixture();const progress=[];
  const prepared=await provider.pullModel('embeddinggemma',{onProgress:item=>progress.push(item)});
  assert.deepEqual(prepared,{model:'embeddinggemma:latest',fingerprint:'synthetic-digest',capabilities:['embedding']});
  assert.deepEqual(calls.map(call=>call.path),['/api/pull','/api/tags','/api/show']);
  assert.deepEqual(calls[0].body,{model:'embeddinggemma',stream:true});assert.equal(calls[0].options.timeoutMs,600000);assert.equal(calls[0].options.redirect,'error');assert.equal(calls[0].options.headers.authorization,undefined);
  assert.equal(progress.find(item=>item.phase==='downloading').percent,50);assert.equal(progress.at(-1).phase,'ready');assert(progress.every(item=>!item.status.includes('layer')));
});
test('single final success response is accepted, while capability remains verified',async()=>{
  const {provider,calls}=downloadFixture({frames:[{status:'success'}]});assert.equal((await provider.pullModel('embeddinggemma:latest')).model,'embeddinggemma:latest');assert.equal(calls.length,3);
});
test('chat-only download never publishes a ready embedding model',async()=>{
  const {provider}=downloadFixture({details:{capabilities:['completion']}});const progress=[];
  await assert.rejects(provider.pullModel('embeddinggemma',{onProgress:item=>progress.push(item)}),{code:'EMBEDDING_NOT_SUPPORTED'});assert(!progress.some(item=>item.phase==='ready'));
});
test('download success without an installed entry is not ready',async()=>{
  const {provider,calls}=downloadFixture({models:[]});await assert.rejects(provider.pullModel('embeddinggemma'),{code:'MODEL_NOT_INSTALLED'});assert.equal(calls.length,2);
});
test('cloud-backed metadata cannot become a prepared local model',async()=>{
  const {provider}=downloadFixture({details:{capabilities:['embedding'],remote_host:'https://private.invalid'}});await assert.rejects(provider.pullModel('embeddinggemma'),{code:'REMOTE_MODEL_NOT_ALLOWED'});
});
test('server error in HTTP 200 progress remains sanitized and does not discover a model',async()=>{
  const {provider,calls}=downloadFixture({frames:[{status:'pulling manifest'},{error:'private token fixture'}]});
  await assert.rejects(provider.pullModel('embeddinggemma'),error=>error.code==='OLLAMA_PULL_FAILED'&&!error.message.includes('private'));assert.equal(calls.length,1);
});
test('stream failure and missing terminal success are not reported as ready',async()=>{
  for(const options of [{frames:[{status:'pulling manifest'}]},{frames:[{status:'success'}],streamError:true}]){
    const {provider,calls}=downloadFixture(options);const progress=[];
    await assert.rejects(provider.pullModel('embeddinggemma',{onProgress:item=>progress.push(item)}),error=>['OLLAMA_PULL_INCOMPLETE','INVALID_OLLAMA_RESPONSE'].includes(error.code)&&!error.message.includes('secret'));
    assert.equal(calls.length,1);assert(!progress.some(item=>item.phase==='ready'));
  }
});
test('malformed, invalid byte counts and progress after terminal success are rejected',async()=>{
  const values=['not JSON','null','[]','{"status":2}','{"status":"pulling x","total":-1}','{"status":"pulling x","total":2,"completed":3}','{"status":"success"}\n{"error":"secret"}','{"status":"success"}\n{"status":"pulling x"}'];
  for(const text of values){const {provider,calls}=downloadFixture({text});await assert.rejects(provider.pullModel('embeddinggemma'));assert.equal(calls.length,1);}
});
test('oversized line, declared body and accumulated stream are bounded and cancelled',async()=>{
  for(const options of [
    {text:JSON.stringify({status:'pulling manifest',extra:'x'.repeat(65536)}),split:70000},
    {headers:{'content-length':String(17*1024*1024)}},
    {text:(JSON.stringify({status:'pulling manifest',extra:'x'.repeat(64000)})+'\n').repeat(270),split:65536},
  ]){
    const {provider,calls,wasCancelled}=downloadFixture({...options,hang:true});await assert.rejects(provider.pullModel('embeddinggemma'),{code:'PULL_RESPONSE_TOO_LARGE'});assert.equal(calls.length,1);assert.equal(wasCancelled(),true);
  }
});
test('download abort before network and during progress never prepares or publishes ready',async()=>{
  const first=downloadFixture();const already=new AbortController();already.abort();await assert.rejects(first.provider.pullModel('embeddinggemma',{signal:already.signal}),{name:'AbortError'});assert.equal(first.calls.length,0);
  const second=downloadFixture();const abort=new AbortController();const progress=[];
  await assert.rejects(second.provider.pullModel('embeddinggemma',{signal:abort.signal,onProgress:item=>{progress.push(item);abort.abort();}}),{name:'AbortError'});assert.equal(second.calls.length,1);assert.equal(second.wasCancelled(),true);assert(!progress.some(item=>item.phase==='ready'));
});
test('timeout cancels a stalled progress body even if its transport ignores AbortSignal',async()=>{
  const {provider,calls,wasCancelled}=downloadFixture({frames:[{status:'pulling manifest'}],hang:true,pullTimeoutMs:15});
  await assert.rejects(provider.pullModel('embeddinggemma'),{code:'OLLAMA_TIMEOUT'});assert.equal(calls.length,1);assert.equal(wasCancelled(),true);
});
test('unsafe model names and cloud tags never initiate a download',async()=>{
  const {provider,calls}=downloadFixture();for(const model of ['', '../model','https://remote.invalid/model','a/b/c','x:cloud','x:cloud-large','a\nprivate'])await assert.rejects(provider.pullModel(model));assert.equal(calls.length,0);
});
test('real desktop transport aborts a pending download stream and closes the local connection',async t=>{
  let closed;const disconnected=new Promise(resolve=>{closed=resolve;});const server=createServer((request,response)=>{response.writeHead(200,{'Content-Type':'application/x-ndjson'});response.write('{"status":"pulling manifest"}\n');response.on('close',closed);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const provider=new OllamaEmbeddingsProvider({baseUrl:`http://127.0.0.1:${server.address().port}`,fetchImpl:desktopFetch});const abort=new AbortController();
  await assert.rejects(provider.pullModel('embeddinggemma',{signal:abort.signal,onProgress:()=>abort.abort()}),{name:'AbortError'});await disconnected;
});
