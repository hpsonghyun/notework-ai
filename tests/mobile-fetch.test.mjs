import test from 'node:test';
import assert from 'node:assert/strict';
import {createMobileFetch} from '../src/mobile-fetch.mjs';
import {ApiKeyProvider} from '../src/providers/api-key.mjs';
const json=data=>({status:200,text:JSON.stringify(data),headers:{}});
test('mobile native transport permits official API routes and returns bounded buffered JSON',async()=>{
 const calls=[];const fetch=createMobileFetch(async options=>{calls.push(options);return json({data:[{id:'fixture-model'}]});});
 const response=await fetch('https://api.openai.com/v1/models',{headers:{authorization:'Bearer fixture-only'}});
 assert.deepEqual(await response.json(),{data:[{id:'fixture-model'}]});assert.equal(response.body,null);assert.equal(calls[0].throw,false);assert.equal(calls[0].headers.authorization,'Bearer fixture-only');
});
test('mobile transport refuses arbitrary hosts, credential URLs, local models and unsupported headers before native HTTP',async()=>{
 let calls=0;const fetch=createMobileFetch(async()=>{calls++;return json({});});
 for(const url of ['http://127.0.0.1:11434/api/chat','https://api.openai.com.evil.test/v1/models','https://user:pass@api.openai.com/v1/models','https://api.openai.com/v1/models#token','https://api.openai.com/v1/messages','https://api.typesafe.ai/v1/models?key=value','https://api.openai.com/v1/models?redirect=evil'])await assert.rejects(fetch(url));
 await assert.rejects(fetch('https://api.openai.com/v1/models',{headers:{cookie:'fixture'}}));assert.equal(calls,0);
});
test('mobile pagination allows only the Anthropic model cursor fields',async()=>{
 const calls=[];const fetch=createMobileFetch(async options=>{calls.push(options);return json({data:[]});});
 await fetch('https://api.anthropic.com/v1/models?limit=100&after_id=fixture%2Fid');assert.equal(calls.length,1);
 await assert.rejects(fetch('https://api.anthropic.com/v1/messages?after_id=x'));
});
test('mobile Stop discards a late native response without retry or unhandled rejection',async()=>{
 let settle;let calls=0;const fetch=createMobileFetch(()=>{calls++;return new Promise(resolve=>{settle=resolve;});});
 const abort=new AbortController();const pending=fetch('https://api.openai.com/v1/models',{signal:abort.signal});await Promise.resolve();abort.abort();await assert.rejects(pending,{name:'AbortError'});settle(json({data:[]}));await new Promise(resolve=>setTimeout(resolve,5));assert.equal(calls,1);
 const already=new AbortController();already.abort();await assert.rejects(fetch('https://api.openai.com/v1/models',{signal:already.signal}),{name:'AbortError'});assert.equal(calls,1);
});
test('mobile timeout discards late native rejection and enforces post-buffer size limit',async()=>{
 let reject;const fetch=createMobileFetch(()=>new Promise((_,no)=>{reject=no;}),{timeoutMs:5});await assert.rejects(fetch('https://api.openai.com/v1/models'),{name:'TimeoutError'});reject(new Error('fixture-private-body'));await Promise.resolve();
 const limited=createMobileFetch(async()=>({status:200,text:'🙂'.repeat(5)}),{maxBytes:16});await assert.rejects(limited('https://api.openai.com/v1/models'),{code:'BODY_TOO_LARGE'});
 const redirect=createMobileFetch(async()=>({status:302,text:'',headers:{location:'https://evil.test'}}));await assert.rejects(redirect('https://api.openai.com/v1/models'),{code:'HTTP_REDIRECT'});
});
test('immediate mobile cancellation makes no native request, including providers without AbortSignal static helpers',async()=>{
 let calls=0;const fetch=createMobileFetch(async()=>{calls++;return json({});});const abort=new AbortController();const result=fetch('https://api.openai.com/v1/models',{signal:abort.signal});abort.abort();await assert.rejects(result,{name:'AbortError'});await Promise.resolve();assert.equal(calls,0);
 const deadline=new AbortController();const timed=fetch('https://api.openai.com/v1/models',{signal:deadline.signal});deadline.abort(new DOMException('Fixture deadline','TimeoutError'));await assert.rejects(timed,{name:'TimeoutError'});assert.equal(calls,0);
});
for(const provider of ['openai','anthropic'])test(`mobile ${provider} uses native buffered API replies and real catalog model selection`,async()=>{
 const calls=[];const catalog={data:[{id:'synthetic-live-model'}],has_more:false};
 const answer=provider==='openai'?{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Grounded answer.'}]}]}:{type:'message',role:'assistant',stop_reason:'end_turn',content:[{type:'text',text:'Grounded answer.'}]};
 const transport=createMobileFetch(async options=>{calls.push(options);return json(options.method==='POST'?answer:catalog);});
 const api=new ApiKeyProvider({provider,streamResponses:false,secrets:new Map([['api-'+provider,'fixture-key-only']]),fetchImpl:transport});await api.connect();const deltas=[];assert.equal(await api.generate('Question with a note.',{model:'synthetic-live-model',onDelta:text=>deltas.push(text)}),'Grounded answer.');
 assert.deepEqual(deltas,['Grounded answer.']);assert.equal(JSON.parse(calls[1].body).stream,false);assert.ok(!JSON.stringify(api).includes('fixture-key-only'));
 if(provider==='openai')assert.equal(JSON.parse(calls[1].body).store,false);
});
test('mobile buffered provider rejects incomplete, quota-error and nontext replies rather than storing partial output',async()=>{
 for(const data of [{status:'incomplete',output:[]},{status:'completed',output:[]},{error:{message:'fixture-private-key'}}]){
  const api=new ApiKeyProvider({provider:'openai',streamResponses:false,secrets:new Map([['api-openai','fixture-only']]),fetchImpl:createMobileFetch(async options=>json(options.method==='POST'?data:{data:[{id:'m'}]}))});
  await api.connect();await assert.rejects(api.generate('Question',{model:'m'}),error=>['INCOMPLETE_RESPONSE','EMPTY_RESPONSE','PROVIDER_REQUEST_FAILED'].includes(error.code)&&!error.message.includes('fixture-private-key'));
 }
});
