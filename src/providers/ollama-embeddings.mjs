function fail(code,message){const error=new Error(message);error.code=code;return error;}
function cancelled(){const error=fail('CANCELLED','Embedding stopped.');error.name='AbortError';return error;}
const REQUEST_TIMEOUT_MS=60000;
const PULL_TIMEOUT_MS=600000;
const PULL_LINE_BYTES=64*1024;
const PULL_RESPONSE_BYTES=16*1024*1024;
function checkedModel(model){
  if(typeof model!=='string'||model.length>200||! /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?(?::[a-z0-9][a-z0-9._-]*)?$/i.test(model))throw fail('EMBEDDING_MODEL_REQUIRED','Enter an Ollama library model name, such as embeddinggemma:latest.');
  if(/:cloud(?:$|-)/i.test(model))throw fail('REMOTE_MODEL_NOT_ALLOWED','Choose a local embedding model. Cloud Ollama models are not used for indexing.');
  return model;
}
function modelTag(model){return model.includes(':')?model:model+':latest';}
function verifiedContextLength(details){
  const info=details.model_info;const architecture=info?.['general.architecture'];
  const reported=typeof architecture==='string'&&/^[a-z0-9_]+$/i.test(architecture)?info?.[architecture+'.context_length']:undefined;
  if(!Number.isSafeInteger(reported)||reported<1||reported>1048576)return undefined;
  const configured=typeof details.parameters==='string'?details.parameters.match(/^\s*num_ctx\s+(\d+)\s*$/m):null;
  const override=configured?Number(configured[1]):null;
  return Number.isSafeInteger(override)&&override>0?Math.min(reported,override):reported;
}
function waitFor(operation,signal){
  if(signal.aborted){Promise.resolve(operation).catch(()=>{});return Promise.reject(signal.reason);}
  return new Promise((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason);};
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(operation).then(value=>{signal.removeEventListener('abort',abort);resolve(value);},problem=>{signal.removeEventListener('abort',abort);reject(problem);});
  });
}
export function normalizeVector(vector,dimension){
  if(!Array.isArray(vector) || !vector.length || vector.length>65536 || (dimension!==undefined&&vector.length!==dimension) || vector.some(value=>typeof value!=='number'||!Number.isFinite(value)))throw fail('INVALID_EMBEDDING','The embedding vector or dimension is invalid.');
  // Scale first: finite, large coordinates must not overflow their norm.
  const scale=Math.max(...vector.map(Math.abs));
  if(!scale)throw fail('INVALID_EMBEDDING','The embedding model returned a zero vector.');
  const norm=Math.sqrt(vector.reduce((sum,value)=>sum+(value/scale)**2,0));
  return vector.map(value=>(value/scale)/norm);
}

export class OllamaEmbeddingsProvider {
  constructor({fetchImpl=globalThis.fetch,baseUrl='http://127.0.0.1:11434',requestTimeoutMs=REQUEST_TIMEOUT_MS,pullTimeoutMs=PULL_TIMEOUT_MS}={}){
    let url;try{url=new URL(baseUrl);}catch{throw fail('INVALID_LOCAL_ENDPOINT','Enter a local Ollama address.');}
    if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw fail('INVALID_LOCAL_ENDPOINT','Embeddings only connect to an HTTP loopback Ollama server.');
    if([requestTimeoutMs,pullTimeoutMs].some(value=>!Number.isSafeInteger(value)||value<=0||value>PULL_TIMEOUT_MS))throw fail('INVALID_OLLAMA_TIMEOUT','Choose a local request timeout between 1 millisecond and 10 minutes.');
    this.baseUrl=url.origin;this.fetch=fetchImpl;this.models=[];this.requestTimeoutMs=requestTimeoutMs;this.pullTimeoutMs=pullTimeoutMs;
  }
  async withResponse(path,{body,signal,timeoutMs=REQUEST_TIMEOUT_MS}={},consume){
    if(signal?.aborted)throw cancelled();
    const deadline=new AbortController();const combined=AbortSignal.any([...(signal?[signal]:[]),deadline.signal]);
    const timer=setTimeout(()=>deadline.abort(fail('OLLAMA_TIMEOUT','The local Ollama request timed out. Try again; Ollama can resume a partial download.')),timeoutMs);
    let response;let connected=false;
    try{
      response=await waitFor(this.fetch(this.baseUrl+path,{method:body?'POST':'GET',headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined,redirect:'error',signal:combined,timeoutMs,maxBufferedBytes:PULL_RESPONSE_BYTES}),combined);
      connected=true;
      if(!response.ok)throw fail('OLLAMA_REQUEST_FAILED','The local Ollama request failed (HTTP '+response.status+'). Check the installed model and server.');
      return await consume(response,combined);
    }catch(problem){
      try{await response?.body?.cancel?.();}catch{/* Cancellation cleanup must not replace the request error. */}
      if(signal?.aborted)throw cancelled();
      if(deadline.signal.aborted||problem?.name==='TimeoutError'||problem?.code==='TIMEOUT')throw fail('OLLAMA_TIMEOUT','The local Ollama request timed out. Try again; Ollama can resume a partial download.');
      if(['OLLAMA_REQUEST_FAILED','INVALID_OLLAMA_RESPONSE','PULL_RESPONSE_TOO_LARGE','OLLAMA_PULL_FAILED','OLLAMA_PULL_INCOMPLETE'].includes(problem?.code))throw problem;
      throw fail(connected?'INVALID_OLLAMA_RESPONSE':'OLLAMA_UNAVAILABLE',connected?'Could not read the local Ollama response.':'Could not reach the local Ollama server. Start Ollama and try again.');
    }finally{clearTimeout(timer);}
  }
  async request(path,options={}){
    return this.withResponse(path,{timeoutMs:this.requestTimeoutMs,...options},async(response,signal)=>{
      const body=await waitFor(response.json(),signal);
      if(!body||typeof body!=='object'||Array.isArray(body))throw fail('INVALID_OLLAMA_RESPONSE','Could not read the local Ollama response.');
      return body;
    });
  }
  async installedModels({signal}={}){
    const body=await this.request('/api/tags',{signal});
    if(!Array.isArray(body.models)||body.models.length>256)throw fail('INVALID_CATALOG','Could not read the installed Ollama model list.');
    return [...new Map(body.models.filter(item=>typeof(item.model||item.name)==='string').filter(item=>!item.remote_host&&!item.remote_model&&!/:cloud(?:$|-)/i.test(item.model||item.name)).map(item=>{const id=item.model||item.name;return[id,{id,name:id,digest:typeof item.digest==='string'?item.digest:null,source:'local-installed'}];})).values()];
  }
  async details(model,{signal}={}){
    checkedModel(model);
    const body=await this.request('/api/show',{body:{model},signal});
    if(body.remote_host||body.remote_model)throw fail('REMOTE_MODEL_NOT_ALLOWED','Choose an installed local embedding model. Cloud Ollama models are not used for indexing.');
    return body;
  }
  async listModels({signal}={}){
    const installed=await this.installedModels({signal});const models=[];
    // Metadata checks do not run inference or pull weights.
    for(const item of installed.slice(0,64)){
      const details=await this.details(item.id,{signal});
      if(Array.isArray(details.capabilities)&&details.capabilities.includes('embedding'))models.push({...item,capabilities:['embedding']});
    }
    this.models=models;return models.map(item=>({...item}));
  }
  async prepareModel(model,{signal}={}){
    checkedModel(model);
    const installed=await this.installedModels({signal});const entry=installed.find(item=>modelTag(item.id)===modelTag(model));
    if(!entry)throw fail('MODEL_NOT_INSTALLED','The selected embedding model is not installed locally. Choose Download embedding model, then prepare it again.');
    const details=await this.details(entry.id,{signal});
    if(!Array.isArray(details.capabilities)||!details.capabilities.includes('embedding'))throw fail('EMBEDDING_NOT_SUPPORTED','The selected local model does not report embedding support. Choose an embedding model.');
    const contextLength=verifiedContextLength(details);
    return{model:entry.id,fingerprint:entry.digest,capabilities:['embedding'],...(contextLength!==undefined?{contextLength}:{})};
  }
  /** Explicit user action only. This method downloads weights, then checks local embedding metadata. */
  async pullModel(model,{signal,onProgress}={}){
    checkedModel(model);
    const report=progress=>{if(!signal?.aborted){try{onProgress?.({model,...progress});}catch{/* A progress callback must not interrupt the provider operation. */}}};
    await this.withResponse('/api/pull',{body:{model,stream:true},signal,timeoutMs:this.pullTimeoutMs},async(response,combined)=>{
      const reader=response.body?.getReader?.();
      if(!reader)throw fail('INVALID_OLLAMA_RESPONSE','Ollama did not provide readable download progress.');
      const decoder=new TextDecoder('utf-8',{fatal:true});let pending='';let bytes=0;let success=false;
      const parse=line=>{
        if(!line.trim())return;
        if(new TextEncoder().encode(line).byteLength>PULL_LINE_BYTES)throw fail('PULL_RESPONSE_TOO_LARGE','Ollama download progress exceeded the supported size.');
        let item;try{item=JSON.parse(line);}catch{throw fail('INVALID_OLLAMA_RESPONSE','Ollama returned malformed download progress.');}
        if(!item||typeof item!=='object'||Array.isArray(item))throw fail('INVALID_OLLAMA_RESPONSE','Ollama returned malformed download progress.');
        if(Object.hasOwn(item,'error'))throw fail('OLLAMA_PULL_FAILED','Ollama could not download the model. Check the model name, network connection and available disk space.');
        if(success||typeof item.status!=='string'||!item.status||item.status.length>256)throw fail('INVALID_OLLAMA_RESPONSE','Ollama returned malformed download progress.');
        for(const key of ['total','completed'])if(item[key]!==undefined&&(!Number.isSafeInteger(item[key])||item[key]<0))throw fail('INVALID_OLLAMA_RESPONSE','Ollama returned invalid download byte counts.');
        if(item.completed!==undefined&&item.total!==undefined&&item.completed>item.total)throw fail('INVALID_OLLAMA_RESPONSE','Ollama returned invalid download byte counts.');
        if(item.status==='success'){success=true;report({phase:'preparing',status:'Download finished. Checking local embedding capability.'});return;}
        const phase=item.status==='pulling manifest'?'manifest':item.status.startsWith('pulling ')?'downloading':item.status.startsWith('verifying ')?'verifying':'preparing';
        const status={manifest:'Reading the model manifest.',downloading:'Downloading model weights.',verifying:'Verifying model weights.',preparing:'Preparing the downloaded model.'}[phase];
        report({phase,status,...(item.total!==undefined?{total:item.total}:{}),...(item.completed!==undefined?{completed:item.completed}:{}),...(item.total>0?{percent:Math.floor(100*(item.completed||0)/item.total)}:{})});
      };
      try{
        const declared=Number(response.headers?.get?.('content-length'));
        if(Number.isFinite(declared)&&declared>PULL_RESPONSE_BYTES)throw fail('PULL_RESPONSE_TOO_LARGE','Ollama download progress exceeded the supported size.');
        while(true){
          const result=await waitFor(reader.read(),combined);if(result.done)break;
          bytes+=result.value.byteLength;if(bytes>PULL_RESPONSE_BYTES)throw fail('PULL_RESPONSE_TOO_LARGE','Ollama download progress exceeded the supported size.');
          pending+=decoder.decode(result.value,{stream:true});let newline;
          while((newline=pending.indexOf('\n'))>=0){parse(pending.slice(0,newline));pending=pending.slice(newline+1);}
          if(new TextEncoder().encode(pending).byteLength>PULL_LINE_BYTES)throw fail('PULL_RESPONSE_TOO_LARGE','Ollama download progress exceeded the supported size.');
        }
        pending+=decoder.decode();parse(pending);
        if(!success)throw fail('OLLAMA_PULL_INCOMPLETE','The model download did not finish. Try again; Ollama can resume partial downloads.');
      }catch(problem){try{await reader.cancel();}catch{/* Cancellation cleanup preserves the original stream error. */}throw problem;}
      finally{reader.releaseLock();}
    });
    if(signal?.aborted)throw cancelled();
    const prepared=await this.prepareModel(model,{signal});
    report({phase:'ready',status:'Installed locally and verified for embeddings.'});
    return prepared;
  }
  async embed(texts,{model,signal}={}){
    if(!Array.isArray(texts)||!texts.length||texts.length>32||texts.some(text=>typeof text!=='string'||!text.trim()||text.length>8000)||texts.reduce((sum,text)=>sum+Buffer.byteLength(text),0)>128000)throw fail('INVALID_EMBEDDING_INPUT','Use a bounded batch of nonempty text for embedding.');
    const prepared=await this.prepareModel(model,{signal});
    const body=await this.request('/api/embed',{body:{model,input:texts,truncate:false,keep_alive:'5m'},signal});
    if(signal?.aborted)throw cancelled();
    if(!Array.isArray(body.embeddings)||body.embeddings.length!==texts.length)throw fail('INVALID_EMBEDDING','The embedding response did not match the requested texts.');
    const dimension=body.embeddings[0]?.length;
    const vectors=body.embeddings.map(vector=>normalizeVector(vector,dimension));
    return{vectors,dimension,model,fingerprint:prepared.fingerprint};
  }
}
