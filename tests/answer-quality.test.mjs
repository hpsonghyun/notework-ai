import test from 'node:test';
import assert from 'node:assert/strict';
import {ConnectionController} from '../src/controller.mjs';
import {ANSWER_INSTRUCTIONS,ANSWER_CONTEXT_LIMITS,historyExcerpt,historyWindow,boundHistoryBytes} from '../src/answer-policy.mjs';
function structureResponse(input){const data=JSON.parse(input.split('\nDATA_JSON\n')[1]);return JSON.stringify({cards:data.cards.map(card=>({id:card.id,parentId:null,relation:'start',topic:'Synthetic evidence'}))});}

test('long history preserves the original request and newest turns without duplicating them',()=>{
  const messages=Array.from({length:24},(_,i)=>({role:i%2?'assistant':'user',content:'turn-'+i}));
  const result=historyWindow(messages);assert.equal(result.length,16);assert.equal(result[0],messages[0]);assert.equal(result.at(-1),messages.at(-1));assert.equal(new Set(result).size,result.length);
});
test('history shortening preserves trailing constraints, marks omission, and respects UTF-8 byte budget',()=>{
  const text='Original request. '+'가'.repeat(10000)+' Required final constraint.';
  const excerpt=historyExcerpt(text);assert(excerpt.startsWith('Original request.'));assert(excerpt.endsWith('Required final constraint.'));assert(excerpt.includes('middle omitted'));assert(excerpt.length<=8000);
  const history=Array.from({length:16},(_,i)=>({role:i%2?'assistant':'user',content:historyExcerpt('가'.repeat(10000)+'tail-'+i)}));
  const result=boundHistoryBytes(history);assert(Buffer.byteLength(JSON.stringify(result))<=ANSWER_CONTEXT_LIMITS.historyBytes);assert.equal(result[0],history[0]);assert.equal(result.at(-1),history.at(-1));
});
function fixture({active=false,long=false}={}) {
  const contents=new Map(Array.from({length:13},(_,i)=>['Research/n'+i+'.md',i===0?'evidence '+'.'.repeat(long?14000:4900)+'OPEN_CONTEXT_CONSTRAINT': 'evidence '+i]));
  const files=[...contents].map(([path,content])=>({path,stat:{size:Buffer.byteLength(content),mtime:1}}));const requests=[];
  const vault={getMarkdownFiles:()=>files,getAbstractFileByPath:path=>files.find(file=>file.path===path),cachedRead:async file=>contents.get(file.path)};
  const models=[{id:'gpt-6.1-sol',supportedReasoningEfforts:[{reasoningEffort:'high'}],defaultReasoningEffort:'high'}];
  const provider={connect:async()=>{},listModels:async()=>models,generate:async(input,options)=>{requests.push({input,options});if(input.startsWith('NOTEWORK_CONVERSATION_STRUCTURE_V1'))return structureResponse(input);options.onDelta('Partial draft');return 'Complete authoritative answer.';}};
  const controller=new ConnectionController({providers:{codex:provider},availableModes:['codex'],getActiveNote:active?()=>files[0].path:undefined,secrets:{},jev:{},vault,settings:{mode:'codex',reasoningEffort:'high',scope:{mode:'folders',include:['Research']}},saveSettings:async()=>{}});
  return {controller,requests};
}
test('question sends high and complete-answer instructions, retrieves beyond six, and replaces streamed draft',async t=>{
  const {controller,requests}=fixture();t.after(()=>controller.dispose());await controller.connect();controller.set({draft:'evidence',consent:true});await controller.ask();await controller.mapPromise;
  assert.equal(requests.length,2);assert.equal(requests[0].options.reasoningEffort,'high');assert.equal(requests[0].options.instructions,ANSWER_INSTRUCTIONS);assert(!requests[0].input.includes('using only the current retrieved evidence'));assert(requests[1].input.startsWith('NOTEWORK_CONVERSATION_STRUCTURE_V1'));assert.equal(requests[1].options.reasoningEffort,'high');assert.equal(requests[1].options.instructions,undefined);
  assert.equal(controller.state.sources.length,12);assert.equal(controller.state.answer,'Complete authoritative answer.');assert.equal(controller.state.messages.at(-1).content,controller.state.answer);
});
test('already retrieved open note includes later opening constraints instead of only the matching fragment',async t=>{
  const {controller,requests}=fixture({active:true});t.after(()=>controller.dispose());await controller.connect();controller.set({draft:'evidence',consent:true});await controller.ask();await controller.mapPromise;
  assert(requests[0].input.includes('OPEN_CONTEXT_CONSTRAINT'));assert.equal(controller.state.retrievalProof.activeNote.alreadyRetrieved,true);assert.equal(controller.state.sources.filter(source=>source.path==='Research/n0.md').length,1);
});
test('open notes exceeding the context bound explicitly report the missing remainder to the model',async t=>{
  const {controller,requests}=fixture({active:true,long:true});t.after(()=>controller.dispose());await controller.connect();controller.set({draft:'evidence',consent:true});await controller.ask();await controller.mapPromise;
  assert(requests[0].input.includes('Opening excerpt only; the rest of this note was not included here.'));assert(!requests[0].input.includes('OPEN_CONTEXT_CONSTRAINT'));assert.equal(controller.state.sources[0].text.length,12000);assert.equal(controller.state.retrievalProof.activeNote.truncated,true);
});
test('original same-scope user constraints remain available after more than four exchanges',async t=>{
  const {controller,requests}=fixture();t.after(()=>controller.dispose());await controller.connect();const contextKey=controller.contextKey();
  controller.set({messages:Array.from({length:24},(_,i)=>({id:'m'+i,role:i%2?'assistant':'user',content:i===0?'ORIGINAL_REQUIREMENT':i===22?'RECENT_REQUIREMENT':'turn-'+i,contextKey})),draft:'evidence',consent:true});await controller.ask();await controller.mapPromise;
  assert(requests[0].input.includes('ORIGINAL_REQUIREMENT'));assert(requests[0].input.includes('RECENT_REQUIREMENT'));assert(!requests[0].input.includes('"content":"turn-23"'));
});
