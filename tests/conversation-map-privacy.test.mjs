import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ConnectionController} from '../src/controller.mjs';
import {historyWindow} from '../src/answer-policy.mjs';
import {ConversationArchive} from '../src/conversation-archive.mjs';
import {normalizeConversationMapAnalysis} from '../src/conversation-structure.mjs';

const hash=text=>createHash('sha256').update(text).digest('hex');
const answerCalls=f=>f.calls.filter(input=>!input.startsWith('NOTEWORK_CONVERSATION_STRUCTURE_V1'));
function structureResponse(input){const data=JSON.parse(input.split('\nDATA_JSON\n')[1]);return JSON.stringify({cards:data.cards.map(card=>({id:card.id,parentId:null,relation:'start',topic:'Synthetic conversation'}))});}
function fixture({count=2}={}) {
  const contents=new Map();const files=new Map();const folders=new Map();const tags=new Map();const calls=[];const reads=[];
  for(let index=0;index<count;index++){const path=count===2?'Research/'+(index===0?'a':'b')+'.md':'Research/note-'+index+'.md';const content=count===2?(index===0?'uniquealpha grounded evidence.':'uniquebeta grounded evidence.'):'Topic '+index+' grounded evidence.';contents.set(path,content);files.set(path,{path,stat:{size:Buffer.byteLength(content),mtime:1}});tags.set(path,['#research']);}
  const vault={getName:()=> 'Synthetic history privacy',getMarkdownFiles:()=>[...files.values()],getAbstractFileByPath:path=>files.get(path)||folders.get(path),cachedRead:async file=>contents.get(file.path),read:async file=>{reads.push(file.path);return contents.get(file.path);},createFolder:async path=>{const folder={path,children:[]};folders.set(path,folder);return folder;},create:async(path,content)=>{const file={path,stat:{size:Buffer.byteLength(content),mtime:1}};files.set(path,file);contents.set(path,content);return file;},process:async(file,fn)=>{const content=fn(contents.get(file.path));contents.set(file.path,content);return content;}};
  const provider={async generate(input){calls.push(input);if(input.startsWith('NOTEWORK_CONVERSATION_STRUCTURE_V1'))return structureResponse(input);return ['PRIVATE_NOTE_A_ANSWER','ANSWER_B_INHERITS_A','LATEST_ANSWER'][Math.min(answerCalls({calls}).length-1,2)];}};
  const archive=new ConversationArchive({vault,idFactory:()=> 'history-conversation'});
  const controller=new ConnectionController({providers:{chatgpt:provider},jev:{},secrets:{},vault,getTags:file=>tags.get(file.path)||[],settings:{mode:'chatgpt',scope:{tags:['#research']}},saveSettings:async()=>{},archive});controller.set({model:'synthetic-model',models:[{id:'synthetic-model'}],authenticated:true,connection:'catalog-confirmed',verified:true});
  const ask=async draft=>{controller.set({draft,consent:true});await controller.ask();await controller.mapPromise;};
  return{controller,vault,contents,files,tags,calls,reads,ask,archive};
}


const structureCalls=f=>f.calls.filter(input=>input.startsWith('NOTEWORK_CONVERSATION_STRUCTURE_V1'));
const sentCards=input=>JSON.parse(input.split('\nDATA_JSON\n')[1]).cards;

for(const mutation of ['excluded-tag','deleted','same-stat-content-change'])test('all external requests omit invalidated prior note text: '+mutation,async()=>{
  const f=fixture();await f.ask('uniquealpha');const original=structuredClone(f.controller.state.messages.slice(0,2));
  if(mutation==='excluded-tag')f.tags.set('Research/a.md',[]);
  else if(mutation==='deleted')f.files.delete('Research/a.md');
  else f.contents.set('Research/a.md',f.contents.get('Research/a.md').replace('uniquealpha','changedtext'));
  await f.ask('uniquebeta');
  assert.equal(f.calls.length,4);assert.equal(structureCalls(f).length,2);
  assert(!answerCalls(f)[1].includes('PRIVATE_NOTE_A_ANSWER'));
  assert(!structureCalls(f)[1].includes('PRIVATE_NOTE_A_ANSWER'));
  const cards=sentCards(structureCalls(f)[1]);assert.equal(cards.length,1);assert.equal(cards[0].id,f.controller.state.conversationMap.cards.at(-1).id);
  assert.equal(cards[0].question,'uniquebeta');assert.equal(cards[0].answer,f.controller.state.messages.at(-1).content);
  assert.deepEqual(f.controller.state.messages.slice(0,2),original);assert.equal(f.controller.state.conversationMap.cards.length,2);
  assert.equal(f.controller.state.conversationMap.cards[0].transitionMethod,'unclassified');assert.equal(f.controller.state.conversationMap.cards[1].transitionMethod,'connected-llm');
  const saved=await f.controller.saveConversation(),loaded=await f.archive.load({path:saved.path});
  assert.equal(loaded.messages[1].content,'PRIVATE_NOTE_A_ANSWER');assert.equal(loaded.messages.length,4);assert.equal(loaded.conversationMapAnalysis.decisions.length,1);
  f.controller.dispose();
});

test('map requests invalidate inherited source lineage even after the original pair falls outside the recent20 cards',async()=>{
  const f=fixture();await f.ask('uniquealpha');for(let i=0;i<21;i++)await f.ask('uniquebeta');
  assert(f.controller.state.messages.at(-1).contextSources.some(ref=>ref.path==='Research/a.md'));
  f.tags.set('Research/a.md',[]);await f.ask('uniquebeta');
  const map=structureCalls(f).at(-1),cards=sentCards(map);
  assert(!map.includes('PRIVATE_NOTE_A_ANSWER'));assert(!map.includes('ANSWER_B_INHERITS_A'));
  assert.equal(cards.length,1);assert.equal(cards[0].id,f.controller.state.conversationMap.cards.at(-1).id);
  assert.deepEqual(f.controller.state.messages.at(-1).contextSources.map(ref=>ref.path),['Research/b.md']);
  assert.equal(f.controller.state.messages.length,46);f.controller.dispose();
});

test('legacy unproven assistant text stays local and archived but never enters automatic structure input',async()=>{
  const f=fixture(),contextKey=f.controller.contextKey();
  f.controller.set({messages:[{id:'u-legacy',role:'user',content:'Private earlier question',contextKey},{id:'a-legacy',role:'assistant',content:'UNPROVEN_PRIVATE_ASSISTANT',contextKey,sources:[{path:'Research/a.md',contentHash:hash(f.contents.get('Research/a.md'))}]}]});
  await f.ask('uniquebeta');
  for(const input of f.calls)assert(!input.includes('UNPROVEN_PRIVATE_ASSISTANT'));
  assert.equal(sentCards(structureCalls(f)[0]).length,1);assert.equal(f.controller.state.messages[1].content,'UNPROVEN_PRIVATE_ASSISTANT');
  const saved=await f.controller.saveConversation(),loaded=await f.archive.load({path:saved.path});assert.equal(loaded.messages[1].content,'UNPROVEN_PRIVATE_ASSISTANT');f.controller.dispose();
});

test('a source changes between initial and final map verification and only the newly authorized B pair is transmitted',async()=>{
  const f=fixture();await f.ask('uniquealpha');
  // Do not inherit A into the new answer: this test isolates late mutation in the map path.
  const first=structuredClone(f.controller.state.messages);f.tags.set('Research/a.md',[]);
  await f.ask('uniquebeta');f.tags.set('Research/a.md',['#research']);
  // In the first verification pass A is valid; reading B changes A before the final pass.
  f.contents.set('Research/a.md','uniquealpha grounded evidence.');
  f.controller.state.conversationMapAnalysis=null;f.controller.mapAttempt=null;
  let mapBReads=0;const previous=f.vault.read;
  f.vault.read=async file=>{if(file.path==='Research/b.md'&&++mapBReads===1)f.contents.set('Research/a.md','Changed during map source validation.');return previous(file);};
  try{await f.controller.updateConversationMap();}finally{f.vault.read=previous;}
  assert.equal(structureCalls(f).length,3);assert(!structureCalls(f).at(-1).includes('PRIVATE_NOTE_A_ANSWER'));
  assert.equal(sentCards(structureCalls(f).at(-1)).length,1);assert.deepEqual(f.controller.state.messages.slice(0,2),first);
  f.controller.dispose();
});

test('cancelling during asynchronous map source validation prevents provider dispatch and keeps the answer',async()=>{
  const f=fixture();await f.ask('uniquealpha');f.controller.state.conversationMapAnalysis=null;f.controller.mapAttempt=null;
  let finish,start;const begun=new Promise(resolve=>start=resolve),previous=f.vault.read;
  f.vault.read=file=>{start();return new Promise(resolve=>finish=()=>resolve(f.contents.get(file.path)));};
  const pending=f.controller.updateConversationMap();await begun;f.controller.stop();finish();await pending;f.vault.read=previous;
  assert.equal(f.calls.length,2);assert.equal(f.controller.state.answer,'PRIVATE_NOTE_A_ANSWER');assert.equal(f.controller.state.messages.length,2);f.controller.dispose();
});

test('a provenance edit during source validation cancels the request even when visible message text is unchanged',async()=>{
  const f=fixture();await f.ask('uniquealpha');f.controller.state.conversationMapAnalysis=null;f.controller.mapAttempt=null;
  let finish,start;const begun=new Promise(resolve=>start=resolve),previous=f.vault.read;
  f.vault.read=file=>{start();return new Promise(resolve=>finish=()=>resolve(f.contents.get(file.path)));};
  const pending=f.controller.updateConversationMap();await begun;
  f.controller.set({messages:f.controller.state.messages.map(message=>message.role==='assistant'?{...message,contextSources:[]}:message)});
  finish();await pending;f.vault.read=previous;assert.equal(f.calls.length,2);assert.equal(f.controller.state.messages[1].content,'PRIVATE_NOTE_A_ANSWER');f.controller.dispose();
});

test('malformed incomplete lineage cannot authorize any external transmission',async()=>{
  for(const kind of ['invalid-hash','missing-own-source','oversized-lineage']){
    const f=fixture(),contextKey=f.controller.contextKey(),a={path:'Research/a.md',contentHash:hash(f.contents.get('Research/a.md'))},b={path:'Research/b.md',contentHash:hash(f.contents.get('Research/b.md'))};
    const assistant={id:'a-old',role:'assistant',content:'UNVERIFIED_OLD_PRIVATE',contextKey,sources:[a],contextSources:[a]};
    if(kind==='invalid-hash')assistant.contextSources=[{...a,contentHash:'bad'}];
    else if(kind==='missing-own-source')assistant.contextSources=[b];
    else if(kind==='oversized-lineage')assistant.contextSources=Array.from({length:65},()=>a);
    f.controller.set({messages:[{id:'u-old',role:'user',content:'Old question',contextKey},assistant]});await f.ask('uniquebeta');
    for(const input of f.calls)assert(!input.includes('UNVERIFIED_OLD_PRIVATE'),kind);assert.equal(sentCards(structureCalls(f)[0]).length,1);f.controller.dispose();
  }
});

test('a pair recorded with invalidated evidence remains local without sending an automatic map request',async()=>{
  const f=fixture(),contextKey=f.controller.contextKey(),a={path:'Research/a.md',contentHash:hash(f.contents.get('Research/a.md'))};
  f.controller.set({messages:[{id:'u-old',role:'user',content:'Old question',contextKey},{id:'a-old',role:'assistant',content:'INVALIDATED_OLD_PRIVATE',contextKey,sources:[a],contextSources:[a],retrieval:{invalidatedPaths:['Research/a.md']}}]});
  await f.controller.updateAutomaticConversationMap({contextKey});
  assert.equal(f.calls.length,0);assert.equal(f.controller.state.messages[1].content,'INVALIDATED_OLD_PRIVATE');assert.equal(f.controller.state.conversationMap.cards.length,1);f.controller.dispose();
});

test('map validation bounds distinct source reads across cards and keeps recent complete lineages intact',async()=>{
  const f=fixture({count:1280}),contextKey=f.controller.contextKey();
  const messages=Array.from({length:20},(_,pair)=>{
    const refs=Array.from({length:64},(_,offset)=>{const path='Research/note-'+(pair*64+offset)+'.md';return{path,contentHash:hash(f.contents.get(path))};});
    return[{id:'u-bounded-'+pair,role:'user',content:'Exact question '+pair,contextKey},{id:'a-bounded-'+pair,role:'assistant',content:'Exact answer '+pair,contextKey,sources:refs,contextSources:refs}];
  }).flat();
  f.controller.set({messages});const original=structuredClone(f.controller.state.messages);
  await f.controller.updateConversationMap();
  assert.equal(f.reads.length,128,'At most 64 distinct sources are read in each of two verification passes');
  assert.equal(new Set(f.reads).size,64);assert.equal(structureCalls(f).length,1);
  const cards=sentCards(structureCalls(f)[0]);assert.equal(cards.length,1);assert.equal(cards[0].answer,'Exact answer 19');
  assert.deepEqual(f.controller.state.messages,original);assert.equal(f.controller.state.conversationMap.cards.length,20);
  assert.equal(f.controller.state.conversationMap.cards.filter(card=>card.transitionMethod==='connected-llm').length,1);f.controller.dispose();
});

test('ask resolves while background map source validation is pending and returns the complete answer',async()=>{
  const f=fixture();let finishMapRead,startMapRead;
  const begun=new Promise(resolve=>startMapRead=resolve),previous=f.vault.read;
  const generate=f.controller.providers.chatgpt.generate;
  f.controller.providers.chatgpt.generate=async(...args)=>{
    const answer=await generate(...args);
    if(!args[0].startsWith('NOTEWORK_CONVERSATION_STRUCTURE_V1'))f.vault.read=file=>{startMapRead();return new Promise(resolve=>finishMapRead=()=>resolve(f.contents.get(file.path)));};
    return answer;
  };
  f.controller.set({draft:'uniquealpha',consent:true});
  await f.controller.ask();await begun;
  assert.equal(f.controller.state.busy,false);assert.equal(f.controller.state.answer,'PRIVATE_NOTE_A_ANSWER');
  assert.equal(structureCalls(f).length,0);assert.equal(f.controller.state.messages.length,2);
  f.vault.read=previous;finishMapRead();await f.controller.mapPromise;
  assert.equal(structureCalls(f).length,1);f.controller.dispose();
});

test('in-place message or lineage edits during source validation cancel dispatch without relying on a state setter',async()=>{
  for(const mutation of ['answer','inherited-source','own-source','invalidated']){
    const f=fixture();await f.ask('uniquealpha');f.controller.state.conversationMapAnalysis=null;f.controller.mapAttempt=null;
    let finish,start;const begun=new Promise(resolve=>start=resolve),previous=f.vault.read;
    f.vault.read=file=>{start();return new Promise(resolve=>finish=()=>resolve(f.contents.get(file.path)));};
    const pending=f.controller.updateConversationMap();await begun;
    const answer=f.controller.state.messages[1];
    if(mutation==='answer')answer.content='Edited while map sources are being read.';
    else if(mutation==='inherited-source')answer.contextSources[0].contentHash='1'.repeat(64);
    else if(mutation==='own-source')answer.sources[0].path='Research/b.md';
    else answer.retrieval.invalidatedPaths=['Research/a.md'];
    f.vault.read=previous;finish();await pending;
    assert.equal(f.calls.length,2,mutation+' must prevent a second map dispatch');f.controller.dispose();
  }
});

test('conversation map topic labels and completion-proof IDs reject every ASCII control',()=>{
  const analysis={schema:1,model:'synthetic',contextKey:'scope',sourceHash:'0'.repeat(64),analyzedAt:'2026-10-08T00:00:00.000Z',decisions:[{cardId:'map:synthetic',parentId:null,transition:'start',topicLabel:'Safe label'}],sourceProof:{schema:1,throughAssistantMessageId:'safe-answer',completedPairs:1}};
  assert.equal(normalizeConversationMapAnalysis(analysis).decisions[0].topicLabel,'Safe label');
  for(const code of [...Array.from({length:32},(_,index)=>index),127]){
    const label=structuredClone(analysis);label.decisions[0].topicLabel='before'+String.fromCharCode(code)+'after';assert.throws(()=>normalizeConversationMapAnalysis(label),/invalid conversation structure/,'label control '+code);
    const proof=structuredClone(analysis);proof.sourceProof.throughAssistantMessageId='before'+String.fromCharCode(code)+'after';assert.throws(()=>normalizeConversationMapAnalysis(proof),/invalid conversation structure/,'proof control '+code);
  }
});
