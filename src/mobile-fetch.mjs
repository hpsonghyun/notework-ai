// Obsidian's native HTTP API works on iOS/Android without browser CORS.
// It buffers the response and does not expose native cancellation or redirect control.
const HOSTS=new Set(['api.openai.com','api.anthropic.com','api.typesafe.ai']);
const LIMIT=4*1024*1024;
function fail(code,message){const error=new Error(message);error.code=code;return error;}
function stopped(){const error=fail('CANCELLED','Operation stopped. A submitted provider request may still finish.');error.name='AbortError';return error;}
export function createMobileFetch(requestUrl,{timeoutMs=180000,maxBytes=LIMIT}={}) {
  if(typeof requestUrl!=='function')throw fail('MOBILE_HTTP_UNAVAILABLE','The mobile HTTP service is unavailable. Update Obsidian.');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>180000||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>16*1024*1024)throw fail('INVALID_HTTP_LIMIT','Use bounded mobile HTTP limits.');
  return async(input,init={})=>{
    let url;try{url=new URL(input);}catch{throw fail('UNSAFE_ENDPOINT','Use an official HTTPS provider endpoint.');}
    if(url.protocol!=='https:'||!HOSTS.has(url.hostname)||url.port||url.username||url.password||url.hash||!/^\/v1\/(?:models|responses|messages|systemone)$/.test(url.pathname)||(/\/.+/.test(url.search)&&url.hostname!=='api.anthropic.com'))throw fail('UNSAFE_ENDPOINT','Use an official HTTPS provider endpoint.');
    const allowedPaths=url.hostname==='api.openai.com'?['/v1/models','/v1/responses']:url.hostname==='api.anthropic.com'?['/v1/models','/v1/messages']:['/v1/models','/v1/systemone'];
    if(!allowedPaths.includes(url.pathname)||[...url.searchParams.keys()].some(key=>url.hostname!=='api.anthropic.com'||url.pathname!=='/v1/models'||!['limit','after_id'].includes(key)))throw fail('UNSAFE_ENDPOINT','Use an official provider API route.');
    const method=String(init.method||'GET').toUpperCase();if(!['GET','POST'].includes(method))throw fail('UNSAFE_METHOD','This provider request method is unavailable.');
    const headers={};for(const [key,value] of Object.entries(init.headers||{})){const name=key.toLowerCase();if(!['authorization','x-api-key','anthropic-version','content-type'].includes(name)||typeof value!=='string'||/[\r\n]/.test(value))throw fail('UNSAFE_HEADERS','Use supported provider request headers.');headers[name]=value;}
    if(init.body!==undefined&&(typeof init.body!=='string'||new TextEncoder().encode(init.body).byteLength>10*1024*1024))throw fail('BODY_TOO_LARGE','The provider request exceeds the mobile size limit.');
    if(init.signal?.aborted)throw stopped();
    let timer;let abort;
    const response=await new Promise((resolve,reject)=>{
      let settled=false;const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);init.signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
      abort=()=>{if(init.signal?.reason?.name==='TimeoutError'){const error=fail('HTTP_TIMEOUT','The request timed out. The submitted provider request may still finish.');error.name='TimeoutError';finish(error);}else finish(stopped());};init.signal?.addEventListener('abort',abort,{once:true});
      timer=setTimeout(()=>{const error=fail('HTTP_TIMEOUT','The request timed out. The submitted provider request may still finish.');error.name='TimeoutError';finish(error);},timeoutMs);
      if(init.signal?.aborted){abort();return;}
      Promise.resolve().then(()=>{if(settled||init.signal?.aborted)return;return requestUrl({url:url.href,method,headers,...(init.body!==undefined?{body:init.body}:{}),throw:false});}).then(value=>finish(null,value),()=>finish(fail('MOBILE_NETWORK_ERROR','Could not connect to the official provider. Check your network.')));
    });
    if(init.signal?.aborted)throw stopped();
    if(!Number.isInteger(response?.status)||response.status<100||response.status>599)throw fail('INVALID_RESPONSE','The provider returned an invalid HTTP response.');
    // Native clients may follow redirects internally; reject any reported redirect.
    if(response.status>=300&&response.status<400)throw fail('HTTP_REDIRECT','The official provider returned a redirect.');
    const text=typeof response.text==='string'?response.text:'';
    if(new TextEncoder().encode(text).byteLength>maxBytes||response.arrayBuffer?.byteLength>maxBytes)throw fail('BODY_TOO_LARGE','The provider response exceeds the mobile size limit.');
    return {ok:response.status>=200&&response.status<300,status:response.status,headers:response.headers||{},body:null,text:async()=>text,json:async()=>JSON.parse(text)};
  };
}
