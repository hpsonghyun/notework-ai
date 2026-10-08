/** Coalesce text display work without dropping any provider text. */
export function createAnswerStream({publish,isCurrent=()=>true,signal,intervalMs=80,now=()=>Date.now(),setTimer=setTimeout,clearTimer=clearTimeout}={}) {
  let text='',timer=null,closed=false,burst=0,lastYield=now();
  const cancelTimer=()=>{if(timer!==null){clearTimer(timer);timer=null;}};
  function flush(){cancelTimer();if(!closed&&isCurrent()&&text)publish(text);}
  function close(){if(closed)return;closed=true;cancelTimer();text='';signal?.removeEventListener('abort',close);}
  signal?.addEventListener('abort',close,{once:true});if(signal?.aborted)close();
  function append(delta){
    if(closed||!isCurrent()||!delta)return;
    text+=String(delta);
    if(timer===null)timer=setTimer(()=>{timer=null;flush();},intervalMs);
    // Awaiting transports yield to input/timer tasks during buffered SSE bursts.
    // Stdio transports can ignore this Promise and still receive coalesced UI work.
    if(++burst>=64||now()-lastYield>=16){burst=0;lastYield=now();return new Promise(resolve=>setTimer(resolve,0));}
  }
  return {append,flush,close};
}
