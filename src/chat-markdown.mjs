// Host rendering owns parsing and internal-note links. This module owns only
// async publication, lifetime, and prevention of passive answer-image requests.
// Official API: https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts
import {splitChatMarkdownSections} from './markdown-sections.mjs';
export function safeChatMarkdown(value) {
  const text=String(value??'');
  const columns=(value,start=0)=>[...value].reduce((column,char)=>char==='\t'?column+4-column%4:column+1,start);
  // Dataview's official processor checks code.innerText.trim().startsWith its
  // query prefix. WORD JOINER is invisible and is not removed by String.trim.
  // Keep known inline queries visible as literal code without evaluating them.
  const inertCode=value=>value.replace(/^(\s*)(?=\$=|=)/,'$1\u2060');
  let fence=null,list=null,inlineRun=null;
  return text.split(/(?<=\n)|(?<=\r)(?!\n)/).map(line=>{
    const outerIndent=columns(line.match(/^[ \t]*/)[0]);
    let quotePrefix=line.match(/^(?: {0,3}>[ \t]?)+/)?.[0]||'';
    if(!quotePrefix&&list&&outerIndent>=list.indent){
      const whitespace=line.match(/^[ \t]*/)[0];
      const nestedPrefix=line.slice(whitespace.length).match(/^(?: {0,3}>[ \t]?)+/)?.[0];
      if(nestedPrefix)quotePrefix=whitespace+nestedPrefix;
    }
    const quoteDepth=(quotePrefix.match(/>/g)||[]).length;
    let body=line.slice(quotePrefix.length);
    if(!body.trim())inlineRun=null;
    if(inlineRun){body=inertCode(body);line=quotePrefix+body;}
    const prefixColumns=columns(quotePrefix);
    const indent=columns(body.match(/^[ \t]*/)[0],prefixColumns)-prefixColumns;
    if(fence){
      // Leaving a quote/list ends its fenced block. Do not treat the next
      // ordinary paragraph as protected code merely because no closer arrived.
      if(quoteDepth<fence.quoteDepth||(!body.trim()?false:indent<fence.listIndent||outerIndent<fence.outerIndent))fence=null;
      else {
        const closing=body.match(/^[ \t]*(`{3,}|~{3,})[ \t]*\r?\n?$/);
        if(quoteDepth===fence.quoteDepth&&indent<=fence.listIndent+3&&closing&&closing[1][0]===fence.char&&closing[1].length>=fence.length)fence=null;
        return quotePrefix+inertCode(body);
      }
    }
    const enclosingIndent=list&&list.quoteDepth<quoteDepth?list.indent:list?.outerIndent||0;
    const marker=body.match(/^([ \t]*)(?:[-+*]|\d+[.)])[ \t]+/);
    if(marker&&(indent<=3||list))list={quoteDepth,indent:columns(marker[0],prefixColumns)-prefixColumns,outerIndent:enclosingIndent};
    else if(list&&(quoteDepth<list.quoteDepth||(body.trim()&&(quoteDepth===list.quoteDepth?indent<list.indent:outerIndent<list.indent))))list=null;
    const opening=body.match(/^([ \t]*)(?:(?:[-+*]|\d+[.)])[ \t]+)?(`{3,}|~{3,})([^\r\n]*)(\r?\n?)$/);
    if(opening&&(indent<=3||list)&& (opening[2][0]!=='`'||!opening[3].includes('`'))){
      fence={char:opening[2][0],length:opening[2].length,quoteDepth,listIndent:list?.quoteDepth===quoteDepth?list.indent:0,outerIndent:list?.quoteDepth<quoteDepth?list.indent:list?.outerIndent||0};
      inlineRun=null;
      // Language processors (e.g. dataviewjs) must never execute model output.
      // Removing only the info string retains every literal line in the block.
      return quotePrefix+body.slice(0,body.indexOf(opening[2]))+opening[2]+opening[4];
    }
    let output='',i=0;
    while(i<line.length){
      if(line[i]==='`'){
        let slashes=0;for(let j=i-1;j>=0&&line[j]==='\\';j--)slashes++;
        if(slashes%2===0){
          const run=line.slice(i).match(/^`+/)[0];let end=i+run.length;
          if(inlineRun===run){output+=run;i+=run.length;inlineRun=null;continue;}
          while((end=line.indexOf(run,end))!==-1){
            if(line[end-1]!=='`'&&line[end+run.length]!=='`')break;
            end+=run.length;
          }
          if(end!==-1){output+=run+inertCode(line.slice(i+run.length,end))+run;i=end+run.length;continue;}
          inlineRun=run;line=line.slice(0,i+run.length)+inertCode(line.slice(i+run.length));output+=run;i+=run.length;continue;
        }
      }
      const char=line[i];
      // An entity cannot turn back into Markdown image syntax during parsing.
      // Escaping with a backslash instead would be unsafe after an existing slash.
      output+=char==='!'&&line[i+1]==='['?'&#33;':char==='<'?'&lt;':char;
      i++;
    }
    return output;
  }).join('');
}

export function createChatMarkdownRenderer({renderMarkdown,createComponent,sourcePath='',maxConcurrent=2,onBeforeCommit,onRendered,streamIntervalMs=250,now=()=>Date.now(),setTimer=setTimeout,clearTimer=clearTimeout,yieldToHost}={}) {
  const entries=new Map(),pending=new Set();
  const limit=Math.max(1,Math.min(4,Math.floor(maxConcurrent)||2));
  let active=0,destroyed=false;
  const native=typeof renderMarkdown==='function'&&typeof createComponent==='function';
  const unload=component=>{try{component?.unload();}catch{/* Cleanup must not break the chat. */}};
  const notify=(element,memory)=>{try{onRendered?.(element,memory);}catch{/* Layout observers cannot break rendering. */}};
  const yieldTask=yieldToHost||(()=>new Promise(resolve=>setTimer(resolve,0)));
  function clearDisplay(entry){for(const part of entry.parts)unload(part.component);entry.parts=[];entry.stage=null;entry.display=null;}
  function publishText(entry){clearDisplay(entry);entry.element.textContent=entry.text;notify(entry.element);}
  function cancelTimer(entry){if(entry.timer!==null){clearTimer(entry.timer);entry.timer=null;}}
  function schedule(entry){
    if(destroyed||entry.disposed)return;
    cancelTimer(entry);
    if(entry.flight){pending.add(entry);return;}
    const wait=entry.streaming?Math.max(0,streamIntervalMs-(now()-entry.lastStarted)):0;
    if(wait){pending.delete(entry);entry.timer=setTimer(()=>{entry.timer=null;schedule(entry);},wait);return;}
    pending.add(entry);pump();
  }
  function pump(){
    if(destroyed)return;
    while(active<limit){
      const entry=[...pending].find(item=>!item.flight&&!item.disposed);
      if(!entry)return;
      pending.delete(entry);void render(entry);
    }
  }
  async function render(entry){
    const version=entry.version,text=entry.text,path=entry.path;
    const sections=splitChatMarkdownSections(safeChatMarkdown(text));
    const stage=sections.length>1&&entry.parts.length>1&&entry.stage?entry.stage:entry.element.ownerDocument.createElement('div');
    stage.className='nw-markdown-content markdown-rendered';
    const flight={created:[],parts:[],stage};entry.flight=flight;entry.lastStarted=now();active++;
    try{
      for(let i=0;i<sections.length;i++){
        if(destroyed||entry.disposed||entry.version!==version)return;
        const previous=entry.parts[i];
        if(previous?.text===sections[i]&&previous.path===path){flight.parts.push(previous);continue;}
        // Bounded independent Markdown blocks let the host process input between
        // sections. Unchanged completed sections retain their DOM/components.
        if(flight.created.length){await yieldTask();if(destroyed||entry.disposed||entry.version!==version)return;}
        const node=sections.length===1?stage:entry.element.ownerDocument.createElement('div');if(sections.length>1)node.className='nw-markdown-section';
        const part={text:sections[i],path,element:node,component:createComponent()};flight.created.push(part);flight.parts.push(part);part.component.load();
        await renderMarkdown(part.text,node,path,part.component);
      }
      if(!destroyed&&!entry.disposed&&entry.version===version){
        let memory;try{memory=onBeforeCommit?.(entry.element);}catch{/* Layout observers cannot break rendering. */}
        const retained=new Set(flight.parts);for(const part of entry.parts)if(!retained.has(part))unload(part.component);
        if(sections.length>1){
          if(stage===entry.stage){let prefix=0;while(prefix<entry.parts.length&&prefix<flight.parts.length&&entry.parts[prefix]===flight.parts[prefix])prefix++;while(stage.childNodes.length>prefix)stage.lastChild.remove();for(let i=prefix;i<flight.parts.length;i++)stage.append(flight.parts[i].element);}
          else stage.replaceChildren(...flight.parts.map(part=>part.element));
        }
        entry.parts=flight.parts;entry.stage=stage;entry.display=true;flight.created=[];
        if(entry.element.firstChild!==stage||entry.element.childNodes.length!==1)entry.element.replaceChildren(stage);
        entry.renderedVersion=version;notify(entry.element,memory);
      }
    }catch{
      // Errors never insert partially rendered content or leak answer text to logs.
      if(!destroyed&&!entry.disposed&&entry.version===version)publishText(entry);
    }finally{
      for(const part of flight.created)unload(part.component);entry.flight=null;active--;
      pending.delete(entry);
      if(!destroyed&&!entry.disposed&&entry.version!==version)schedule(entry);
      pump();
    }
  }
  function update(element,value,path=sourcePath,{streaming=false}={}){
    if(destroyed)return;
    const text=String(value??'');
    let entry=entries.get(element);
    if(!entry){entry={element,text:null,path:null,version:0,renderedVersion:-1,display:null,parts:[],stage:null,flight:null,disposed:false,streaming:false,lastStarted:-Infinity,timer:null};entries.set(element,entry);}
    const changed=entry.text!==text||entry.path!==path;
    if(!changed&&entry.streaming===streaming)return;
    entry.streaming=streaming;
    if(changed){entry.text=text;entry.path=path;entry.version++;}
    if(!changed&&entry.renderedVersion===entry.version){cancelTimer(entry);return;}
    // Keep existing formatted output visible until the next version is ready.
    if(native&&text){if(!entry.display)publishText(entry);schedule(entry);}
    else {cancelTimer(entry);pending.delete(entry);publishText(entry);}
  }
  function dispose(element){
    const entry=entries.get(element);if(!entry)return;
    entry.disposed=true;entry.version++;cancelTimer(entry);pending.delete(entry);entries.delete(element);
    clearDisplay(entry);
    // The host renderer has no cancellation API. Its detached component is
    // unloaded as soon as its promise settles; it can never publish afterwards.
  }
  function destroy(){destroyed=true;for(const element of entries.keys())dispose(element);pending.clear();}
  return {update,dispose,destroy};
}
