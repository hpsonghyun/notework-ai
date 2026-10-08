import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createChatMarkdownRenderer,safeChatMarkdown} from '../src/chat-markdown.mjs';

class Element {
  constructor(document){this.ownerDocument=document;this.children=[];this.value='';}
  set textContent(value){this.value=value;this.children=[];}
  get textContent(){return this.children.length?this.children.map(child=>child.textContent).join(''):this.value;}
  replaceChildren(...children){for(const child of this.children)child.parent=null;this.children=[];this.value='';this.append(...children);}
  append(...children){for(const child of children){child.remove();child.parent=this;this.children.push(child);}}
  remove(){if(this.parent){this.parent.children.splice(this.parent.children.indexOf(this),1);this.parent=null;}}
  get childNodes(){return this.children;}
  get firstChild(){return this.children[0];}
  get lastChild(){return this.children.at(-1);}
  set innerHTML(_){throw new Error('Answer output cannot enter an HTML sink.');}
}
const document={createElement:()=>new Element(document)};
const element=()=>new Element(document);
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function renderClock(){let time=0,id=0;const jobs=new Map();return {now:()=>time,setTimer:(fn,delay)=>{jobs.set(++id,{fn,due:time+delay});return id;},clearTimer:id=>jobs.delete(id),advance(ms){time+=ms;for(const [key,job]of [...jobs])if(job.due<=time){jobs.delete(key);job.fn();}},get pending(){return jobs.size;}};}
function controlled(extra={}){
  const components=[],calls=[];
  const renderer=createChatMarkdownRenderer({
    createComponent:()=>{const component={loads:0,unloads:0,load(){this.loads++;},unload(){this.unloads++;}};components.push(component);return component;},
    renderMarkdown:(text,stage,path,component)=>new Promise((resolve,reject)=>calls.push({text,stage,path,component,resolve:()=>{stage.textContent='formatted:'+text;resolve();},reject})),
    ...extra
  });
  return {renderer,components,calls};
}

test('native renderer receives Markdown syntax and note-link source path with a loaded component',async()=>{
  const markdown='# Heading\n\n**Strong** and *emphasis*.\n\n- First\n- Second\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n[[Research/Note|Source]]\n\n```js\nconst html="<img src=\"https://example.invalid/code\">";\n```';
  const {renderer,calls,components}=controlled({sourcePath:'Chats/current.md'});const answer=element();
  renderer.update(answer,markdown);assert.equal(answer.textContent,markdown);assert.equal(calls[0].text,markdown.replace('```js\n','```\n'));assert.equal(calls[0].path,'Chats/current.md');assert.equal(components[0].loads,1);
  calls[0].resolve();await flush();assert.equal(answer.children[0],calls[0].stage);assert.equal(components[0].unloads,0);
  renderer.destroy();assert.equal(components[0].unloads,1);
});

test('rapid updates coalesce, stale staging stays detached, and identical text does not re-render',async()=>{
  const {renderer,calls,components}=controlled();const answer=element();
  renderer.update(answer,'first');for(let i=0;i<50;i++)renderer.update(answer,'latest '+i);
  assert.equal(calls.length,1);assert.equal(answer.textContent,'latest 49');
  calls[0].resolve();await flush();assert.equal(answer.textContent,'latest 49');assert.equal(calls.length,2);assert.equal(calls[1].text,'latest 49');assert.equal(components[0].unloads,1);
  calls[1].resolve();await flush();assert.equal(answer.textContent,'formatted:latest 49');
  renderer.update(answer,'latest 49');assert.equal(calls.length,2);
  renderer.update(answer,'new answer');assert.equal(answer.textContent,'formatted:latest 49');calls[2].resolve();await flush();assert.equal(components[1].unloads,1);assert.equal(answer.textContent,'formatted:new answer');renderer.destroy();
});

test('streaming Markdown limits repeated parsing but final output renders immediately and completely',async()=>{
  const clock=renderClock(),{renderer,calls}=controlled(clock),answer=element();
  renderer.update(answer,'first',undefined,{streaming:true});calls[0].resolve();await flush();
  for(let i=0;i<20;i++){clock.advance(10);renderer.update(answer,'growing '+i,undefined,{streaming:true});await flush();}
  assert.equal(calls.length,1);assert.equal(answer.textContent,'formatted:first');assert.equal(clock.pending,1);
  renderer.update(answer,'growing 19\n\n**Complete final tail.**');assert.equal(calls.length,2);assert.equal(clock.pending,0);
  assert.equal(calls[1].text,'growing 19\n\n**Complete final tail.**');calls[1].resolve();await flush();
  assert.equal(answer.textContent,'formatted:growing 19\n\n**Complete final tail.**');renderer.destroy();
});

test('finishing with identical buffered text flushes it, and closing clears streaming render timers',async()=>{
  const clock=renderClock(),{renderer,calls}=controlled(clock),answer=element();
  renderer.update(answer,'first',undefined,{streaming:true});calls[0].resolve();await flush();
  clock.advance(10);renderer.update(answer,'latest',undefined,{streaming:true});assert.equal(calls.length,1);
  renderer.update(answer,'latest',undefined,{streaming:false});assert.equal(calls.length,2);calls[1].resolve();await flush();assert.equal(answer.textContent,'formatted:latest');
  renderer.update(answer,'closed text',undefined,{streaming:true});assert.equal(clock.pending,1);renderer.destroy();clock.advance(1000);assert.equal(clock.pending,0);assert.equal(calls.length,2);
});

test('long Markdown yields between independent sections and reuses immutable native DOM and components',async()=>{
  let yields=0;const {renderer,calls,components}=controlled({yieldToHost:async()=>{yields++;}}),answer=element();
  const first='# First\n\n'+('First paragraph. '.repeat(320))+'\n\n',second='# Second\n\n'+('Second paragraph. '.repeat(320))+'\n\n',tail='# Tail\n\nGrowing.';
  renderer.update(answer,first+second+tail);assert.equal(calls.length,1);
  calls[0].resolve();await flush();assert.equal(calls.length,2);calls[1].resolve();await flush();assert.equal(calls.length,3);calls[2].resolve();await flush();
  const prefix=answer.children[0].children.slice(0,2);assert.equal(yields,2);assert.equal(components[0].unloads,0);
  renderer.update(answer,first+second+tail+' Complete authoritative ending.');assert.equal(calls.length,4);calls[3].resolve();await flush();
  assert.deepEqual(answer.children[0].children.slice(0,2),prefix);assert.equal(components[0].unloads,0);assert.equal(components[1].unloads,0);assert.equal(components[2].unloads,1);
  assert.match(answer.textContent,/Complete authoritative ending\./);renderer.destroy();assert.equal(components[0].unloads,1);assert.equal(components[1].unloads,1);assert.equal(components[3].unloads,1);
});

test('closing a partially rendered large answer unloads detached sections and cannot publish stale markup',async()=>{
  const {renderer,calls,components}=controlled({yieldToHost:async()=>{}}),answer=element();
  const first='# First\n\n'+('Safe paragraph. '.repeat(350))+'\n\n',last='# Last\n\nPending.';
  renderer.update(answer,first+last);calls[0].resolve();await flush();assert.equal(calls.length,2);
  renderer.destroy();answer.textContent='Closed view';calls[1].resolve();await flush();
  assert.equal(answer.textContent,'Closed view');assert.equal(components[0].unloads,1);assert.equal(components[1].unloads,1);
});

test('history rendering has a bounded global concurrency and latest queued text wins',async()=>{
  const {renderer,calls}=controlled({maxConcurrent:2});const answers=Array.from({length:5},element);
  answers.forEach((answer,i)=>renderer.update(answer,'history '+i));assert.equal(calls.length,2);
  renderer.update(answers[2],'updated queued history');calls[0].resolve();await flush();assert.equal(calls.length,3);assert.equal(calls[2].text,'updated queued history');
  renderer.destroy();for(const call of calls)call.resolve();await flush();assert.equal(calls.length,3);
});

test('disposed and reused answer nodes never receive stale output; components clean up',async()=>{
  const {renderer,calls,components}=controlled();const answer=element();
  renderer.update(answer,'old');renderer.dispose(answer);answer.textContent='new view';
  renderer.update(answer,'new');calls[0].resolve();await flush();assert.equal(answer.textContent,'new');assert.equal(components[0].unloads,1);
  calls[1].resolve();await flush();assert.equal(answer.textContent,'formatted:new');renderer.dispose(answer);assert.equal(components[1].unloads,1);
  renderer.update(answer,'unmounted');renderer.destroy();answer.textContent='closed';calls[2].resolve();await flush();assert.equal(answer.textContent,'closed');assert.equal(components[2].unloads,1);
  renderer.update(answer,'ignored');assert.equal(answer.textContent,'closed');
});

test('errors fall back to literal plain text and a later answer can render successfully',async()=>{
  const {renderer,calls,components}=controlled();const answer=element();const text='<img src="https://example.invalid/private"> **answer**';
  renderer.update(answer,text);calls[0].stage.textContent='partial';calls[0].reject(new Error('host error'));await flush();assert.equal(answer.textContent,text);assert.equal(answer.children.length,0);assert.equal(components[0].unloads,1);
  renderer.update(answer,'retry');calls[1].resolve();await flush();assert.equal(answer.textContent,'formatted:retry');renderer.destroy();
});

test('standalone fixture needs no host API and only assigns textContent',async()=>{
  const renderer=createChatMarkdownRenderer(),answer=element();const text='<script>bad()</script>\n# Heading';renderer.update(answer,text);assert.equal(answer.textContent,text);assert.equal(answer.children.length,0);renderer.update(answer,'');assert.equal(answer.textContent,'');renderer.destroy();
  const source=await readFile(new URL('../src/chat-markdown.mjs',import.meta.url),'utf8');assert.doesNotMatch(source,/\.innerHTML\s*=/);
});

test('image and HTML embeds are inert before the host renderer sees answer Markdown',()=>{
  const source='![remote](https://example.invalid/pixel?private=value)\n![reference][remote]\n[remote]: https://example.invalid/pixel\n![[Note]]\n\\![escaped](https://example.invalid/pixel)\n<img src="https://example.invalid/pixel">\n<iframe src="https://example.invalid/frame"></iframe>\n`![code](https://example.invalid/code) <img>`\n> A quote\n[[Note|A note]]';
  const safe=safeChatMarkdown(source);
  assert.match(safe,/&#33;\[remote\]/);assert.match(safe,/&#33;\[reference\]\[remote\]/);assert.match(safe,/&#33;\[\[Note\]\]/);assert.match(safe,/\\&#33;\[escaped\]/);assert.doesNotMatch(safe.replace(/`[^`]*`/g,''),/<(?:img|iframe)/);assert.match(safe,/`!\[code\]\(https:\/\/example\.invalid\/code\) <img>`/);assert.match(safe,/> A quote/);assert.match(safe,/\[\[Note\|A note\]\]/);
});

test('commit hooks capture layout only for the latest ready stage',async()=>{
  const events=[];const {renderer,calls}=controlled({onBeforeCommit:node=>{events.push(['before',node.textContent]);return {top:37};},onRendered:(node,memory)=>{if(memory)events.push(['after',node.textContent,memory.top]);}});const answer=element();
  renderer.update(answer,'old');renderer.update(answer,'new');calls[0].resolve();await flush();assert.deepEqual(events,[]);
  calls[1].resolve();await flush();assert.deepEqual(events,[['before','new'],['after','formatted:new',37]]);renderer.destroy();
});

test('escaped or incomplete backticks never hide active HTML or images from filtering',()=>{
  assert.equal(safeChatMarkdown('\\`<img src=x>\\`'), '\\`&lt;img src=x>\\`');
  assert.equal(safeChatMarkdown('`unfinished <img src=x> ![x](url)'), '`unfinished &lt;img src=x> &#33;[x](url)');
  assert.equal(safeChatMarkdown('`` <img> ![x](url) ``'), '`` <img> ![x](url) ``');
  assert.equal(safeChatMarkdown('```js\n<img> ![x](url)\n```\n<img>'), '```\n<img> ![x](url)\n```\n&lt;img>');
  assert.equal(safeChatMarkdown('~~~\n<img>\n~~~\n![x](url)'), '~~~\n<img>\n~~~\n&#33;[x](url)');
});

test('active fence languages become plain code, retaining literal code in callouts and lists',()=>{
  for(const language of ['dataviewjs','dataview','mermaid','tasks','javascript']){
    const source='```'+language+'\nconst text="<img src=x> ![x](url)";\n```';
    assert.equal(safeChatMarkdown(source),'```\nconst text="<img src=x> ![x](url)";\n```');
  }
  assert.equal(safeChatMarkdown('> [!info]\n> ```dataviewjs\n> <img> ![x](url)\n> ```\n<img>'),'> [!info]\n> ```\n> <img> ![x](url)\n> ```\n&lt;img>');
  assert.equal(safeChatMarkdown('> > ~~~tasks\n> > <img>\n> > ~~~\n<img>'),'> > ~~~\n> > <img>\n> > ~~~\n&lt;img>');
  assert.equal(safeChatMarkdown('- ```dataviewjs\n  <img>\n  ```\n<img>'),'- ```\n  <img>\n  ```\n&lt;img>');
  assert.equal(safeChatMarkdown('- Item\n  ```javascript\n  <img>\n  ```\n<img>'),'- Item\n  ```\n  <img>\n  ```\n&lt;img>');
});

test('leaving an unclosed quote or list fence does not let ordinary HTML bypass the filter',()=>{
  assert.equal(safeChatMarkdown('> ```dataviewjs\n> <img>\n<img src=x>\n![x](url)'),'> ```\n> <img>\n&lt;img src=x>\n&#33;[x](url)');
  assert.equal(safeChatMarkdown('- ```dataviewjs\n  <img>\n<img src=x>'),'- ```\n  <img>\n&lt;img src=x>');
  assert.equal(safeChatMarkdown('- Item\n  - ```dataviewjs\n    <img>\n  <img src=x>'),'- Item\n  - ```\n    <img>\n  &lt;img src=x>');
  assert.equal(safeChatMarkdown('-\t```dataviewjs\n    <img>\n  <img src=x>'),'-\t```\n    <img>\n  &lt;img src=x>');
});

test('tab-indented list and quote fences cannot retain executable language processors',()=>{
  const source='- Item\n\t```dataviewjs\n\t1+1\n\t```';
  assert.equal(safeChatMarkdown(source),'- Item\n\t```\n\t1+1\n\t```');
  assert.equal(safeChatMarkdown('- Item\n \t~~~dataviewjs\n \t<img>\n \t~~~'),'- Item\n \t~~~\n \t<img>\n \t~~~');
  assert.equal(safeChatMarkdown('>  \t```dataviewjs\n>  \t<img>\n>  \t```'),'>  \t```\n>  \t<img>\n>  \t```');
  assert.equal(safeChatMarkdown('- Item\n\t> ```dataviewjs\n\t> <img>\n\t> ```'),'- Item\n\t> ```\n\t> <img>\n\t> ```');
  assert.equal(safeChatMarkdown('- Item\n\t> ```dataviewjs\n\t> <img>\n> <img src=x>'),'- Item\n\t> ```\n\t> <img>\n> &lt;img src=x>');
});

test('known Dataview prefixes remain visibly literal inline code without matching its processor',()=>{
  for(const value of ['$= dv.current().file.name','= this.file.name','  $= 1+1 ','\t= 1+1']){
    const rendered=safeChatMarkdown('`'+value+'`');
    assert.equal(rendered.replaceAll('\u2060',''),'`'+value+'`');
    const code=rendered.slice(1,-1).trim();assert.ok(!code.startsWith('$=')&&!code.startsWith('='));
  }
  assert.equal(safeChatMarkdown('``$= 1+1``'),'``\u2060$= 1+1``');
  assert.equal(safeChatMarkdown('`const value = 1`'),'`const value = 1`');
  // Dataview can also opt into inspecting code inside pre elements.
  assert.equal(safeChatMarkdown('```dataviewjs\n$= 1+1\n```'),'```\n\u2060$= 1+1\n```');
  assert.equal(safeChatMarkdown('`$= 1+\n1`'),'`\u2060$= 1+\n1`');
  assert.equal(safeChatMarkdown('`\n$= 1+1`'),'`\n\u2060$= 1+1`');
  assert.equal(safeChatMarkdown('`\n= this.file.name`'),'`\n\u2060= this.file.name`');
  assert.equal(safeChatMarkdown('> `\n> $= 1+1`'),'> `\n> \u2060$= 1+1`');
});

test('CR-only and CRLF line endings receive the same fence and inline-code protections',()=>{
  for(const newline of ['\r','\r\n']){
    assert.equal(safeChatMarkdown('```dataviewjs'+newline+'<img>'+newline+'```'),'```'+newline+'<img>'+newline+'```');
    assert.equal(safeChatMarkdown('- Item'+newline+'\t```dataviewjs'+newline+'\t1+1'+newline+'\t```'),'- Item'+newline+'\t```'+newline+'\t1+1'+newline+'\t```');
    assert.equal(safeChatMarkdown('`'+newline+'$= 1+1`'),'`'+newline+'\u2060$= 1+1`');
  }
});
