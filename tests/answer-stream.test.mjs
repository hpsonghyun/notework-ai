import test from 'node:test';
import assert from 'node:assert/strict';
import {createAnswerStream} from '../src/answer-stream.mjs';

function scheduler(){
  let time=0,id=0;const jobs=new Map();
  return {now:()=>time,setTimer:(fn,delay)=>{jobs.set(++id,{fn,due:time+delay});return id;},clearTimer:id=>jobs.delete(id),advance(ms){const end=time+ms;while(true){const next=[...jobs].filter(([,job])=>job.due<=end).sort((a,b)=>a[1].due-b[1].due)[0];if(!next)break;time=next[1].due;jobs.delete(next[0]);next[1].fn();}time=end;},get pending(){return jobs.size;}};
}

test('buffered provider bursts keep every character and publish once per display interval',()=>{
  const clock=scheduler(),published=[];const stream=createAnswerStream({...clock,publish:text=>published.push(text)});
  const expected=Array.from({length:1600},(_,i)=>`part ${i}\n`).join('');
  for(let i=0;i<1600;i++)stream.append(`part ${i}\n`);
  assert.equal(published.length,0);clock.advance(79);assert.equal(published.length,0);
  clock.advance(1);assert.deepEqual(published,[expected]);stream.close();assert.equal(clock.pending,0);
});

test('failure flush retains the partial answer and close cancels all future publication',()=>{
  const clock=scheduler(),published=[];const stream=createAnswerStream({...clock,publish:text=>published.push(text)});
  stream.append('partial **answer**');stream.flush();stream.close();stream.append('late');clock.advance(200);
  assert.deepEqual(published,['partial **answer**']);assert.equal(clock.pending,0);
});

test('abort or obsolete requests cannot publish late deltas into a new conversation',()=>{
  for(const abort of [false,true]){
    const clock=scheduler(),published=[],signal=new AbortController();let current=true;
    const stream=createAnswerStream({...clock,signal:signal.signal,isCurrent:()=>current,publish:text=>published.push(text)});
    stream.append('old answer');if(abort)signal.abort();else current=false;
    clock.advance(200);stream.append('late old answer');stream.flush();stream.close();assert.deepEqual(published,[]);
  }
});

test('awaiting buffered transports yield to the event loop without losing final text',async()=>{
  let beats=0;const heartbeat=setInterval(()=>beats++,0),published=[];
  const stream=createAnswerStream({intervalMs:5,publish:text=>published.push(text)});
  try{for(let i=0;i<640;i++)await stream.append('x');stream.flush();assert.ok(beats>0);assert.equal(published.at(-1),'x'.repeat(640));}
  finally{stream.close();clearInterval(heartbeat);}
});
