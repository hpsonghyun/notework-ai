import test from 'node:test';
import assert from 'node:assert/strict';
import {buildConversationMap} from '../src/conversation-map.mjs';
import {ConversationArchive} from '../src/conversation-archive.mjs';
import {buildConversationStructureRequest,parseConversationStructureResponse,normalizeConversationMapAnalysis,validateConversationMapAnalysis,applyConversationMapAnalysis,CONVERSATION_STRUCTURE_LIMITS} from '../src/conversation-structure.mjs';

const contextKey='synthetic-context',model='synthetic-selected-model';
const pair=(i,context=contextKey)=>[{id:'u'+i,role:'user',content:'Exact synthetic question '+i,contextKey:context},{id:'a'+i,role:'assistant',content:'Exact synthetic answer '+i,contextKey:context}];
function create(messages){
  const request=buildConversationStructureRequest(messages,contextKey);
  const answer=JSON.stringify({cards:request.cards.map((card,index)=>({id:card.id,parentId:index?request.cards[index-1].id:null,relation:index?'refine':'start',topic:'Synthetic evidence'}))});
  return {request,answer,analysis:parseConversationStructureResponse(answer,request,{messages,contextKey,model,clock:()=>new Date('2026-10-08T00:00:00Z')})};
}

test('appending complete pairs preserves proven AI classifications and leaves new cards pending without an AI call',()=>{
  const initial=[...pair(1),...pair(2)];const {analysis}=create(initial);const original=structuredClone(analysis);
  const appended=[...initial,...pair(3),...pair(4)];const validated=validateConversationMapAnalysis(analysis,appended,contextKey,model);
  const map=applyConversationMapAnalysis(buildConversationMap(appended),validated);
  assert.deepEqual(analysis,original);assert.deepEqual(validated,original);assert.equal(map.cards[1].transitionMethod,'connected-llm');assert.equal(map.cards[1].parentId,map.cards[0].id);assert.equal(map.cards[2].transitionMethod,'unclassified');assert.equal(map.cards[3].parentId,null);assert.equal(map.edges.length,1);assert.equal(map.cards[2].question,appended[4].content);assert.equal(map.cards[3].answer,appended[7].content);assert.equal(map.classifiedCards,2);assert.match(map.status,/other cards remain unclassified/);
});
test('retention proves full source text including changes beyond displayed excerpts',()=>{
  const initial=[...pair(1),...pair(2)];initial[1].content='Long exact answer '+('A'.repeat(3000));const {analysis}=create(initial);
  const edits=[messages=>messages[0].content+=' changed',messages=>messages[1].content=messages[1].content.slice(0,-1)+'B',messages=>messages.splice(0,2),messages=>messages.splice(0,4,...messages.slice(2,4),...messages.slice(0,2)),messages=>messages[2].contextKey='different',messages=>messages[3].partial=true];
  for(const edit of edits){const messages=structuredClone(initial);edit(messages);messages.push(...pair(3));assert.throws(()=>validateConversationMapAnalysis(analysis,messages,contextKey,model),/invalid/);}
});
test('same pair IDs with revised context/model or a deleted completion anchor cannot retain a structure',()=>{
  const initial=[...pair(1),...pair(2)];const {analysis}=create(initial);
  assert.throws(()=>validateConversationMapAnalysis(analysis,[...initial,...pair(3)],contextKey,'another-model'),/invalid/);
  assert.throws(()=>validateConversationMapAnalysis(analysis,initial,'another-context',model),/invalid/);
  for(const messages of [initial.slice(0,-1),initial.map(message=>message.id==='a2'?{...message,role:'user'}:message),[...initial,{...initial[3]}]])assert.throws(()=>validateConversationMapAnalysis(analysis,messages,contextKey,model),/invalid/);
});
test('new metadata is bounded and sanitized, and malformed or foreign proof anchors are rejected',()=>{
  const initial=[...pair(1),...pair(2)];const {analysis}=create(initial);assert.deepEqual(analysis.sourceProof,{schema:1,throughAssistantMessageId:'a2',completedPairs:2});assert(!JSON.stringify(analysis.sourceProof).includes('Exact synthetic'));
  const normalized=normalizeConversationMapAnalysis({...analysis,sourceProof:{...analysis.sourceProof,unknownSecret:'discard'},extra:'discard'});assert.deepEqual(normalized,analysis);
  for(const sourceProof of [null,{}, {...analysis.sourceProof,schema:2},{...analysis.sourceProof,completedPairs:0},{...analysis.sourceProof,completedPairs:1001},{...analysis.sourceProof,completedPairs:1.5},{...analysis.sourceProof,throughAssistantMessageId:'bad\u0000id'}])assert.throws(()=>normalizeConversationMapAnalysis({...analysis,sourceProof}),/invalid/);
  for(const throughAssistantMessageId of ['missing','u2','a1'])assert.throws(()=>validateConversationMapAnalysis({...analysis,sourceProof:{...analysis.sourceProof,throughAssistantMessageId}},[...initial,...pair(3)],contextKey,model),/invalid/);
  const foreign=[...pair(8,'foreign'),...initial];assert.throws(()=>validateConversationMapAnalysis({...analysis,sourceProof:{...analysis.sourceProof,throughAssistantMessageId:'a8'}},foreign,contextKey,model),/invalid/);
});
test('proof cannot classify appended, cross-context or reordered cards that were outside the proven source prefix',()=>{
  const initial=[...pair(1),...pair(2)];const {analysis}=create(initial);const appended=[...initial,...pair(3),...pair(8,'foreign')];const cards=buildConversationMap(appended).cards;
  for(const cardId of [cards[2].id,cards[3].id])assert.throws(()=>validateConversationMapAnalysis({...analysis,decisions:[{cardId,parentId:null,transition:'start',topicLabel:'Forged'}]},appended,contextKey,model),/invalid/);
  const backwards=[analysis.decisions[1],analysis.decisions[0]];assert.throws(()=>normalizeConversationMapAnalysis({...analysis,decisions:backwards}),/invalid/);
});
test('legacy analysis remains strict and does not gain retention from an absent proof',()=>{
  const initial=[...pair(1),...pair(2)];const {analysis}=create(initial);const {sourceProof,...legacy}=analysis;
  assert.deepEqual(validateConversationMapAnalysis(legacy,initial,contextKey,model),legacy);
  assert.throws(()=>validateConversationMapAnalysis(legacy,[...initial,...pair(3)],contextKey,model),/invalid/);
  assert.throws(()=>validateConversationMapAnalysis({...analysis,sourceHash:'0'.repeat(64)},initial,contextKey,model),/invalid/);
});
test('completed and partial trailing turns do not change prior quotes, while an old asynchronous request cannot classify an appended snapshot',()=>{
  const initial=[...pair(1),...pair(2)];const {analysis,request,answer}=create(initial);const pending=[...initial,{id:'pending',role:'user',content:'Still waiting',contextKey},{id:'partial',role:'assistant',content:'Partial answer',contextKey,partial:true}];
  assert.deepEqual(validateConversationMapAnalysis(analysis,pending,contextKey,model),analysis);assert.equal(buildConversationMap(pending).cards.length,2);
  assert.throws(()=>parseConversationStructureResponse(answer,request,{messages:[...initial,...pair(3)],contextKey,model}),/invalid/);
  assert.throws(()=>parseConversationStructureResponse(answer,request,{messages:initial,contextKey:'foreign',model}),/invalid/);
});
test('retention uses bounded card proofs across larger exchanges, keeps latest20 and32KiB request limits, and expires outside the visible proof horizon',()=>{
  const initial=Array.from({length:180},(_,i)=>pair(i)).flat();const {analysis,request}=create(initial);
  assert.equal(analysis.decisions.length,20);assert.equal(request.cards.length,20);assert(new TextEncoder().encode(request.input).byteLength<=CONVERSATION_STRUCTURE_LIMITS.maxRequestBytes);assert.equal(analysis.sourceProof.completedPairs,180);
  const appended=[...initial,...Array.from({length:10},(_,i)=>pair(180+i)).flat()];assert.deepEqual(validateConversationMapAnalysis(analysis,appended,contextKey,model),analysis);
  const overflow=[...initial,...Array.from({length:250},(_,i)=>pair(180+i)).flat()];assert.throws(()=>validateConversationMapAnalysis(analysis,overflow,contextKey,model),/invalid/);
});
test('an appended synthetic archive round-trips only the validated prior structure and leaves new quotes pending',async()=>{
  const files=new Map(),contents=new Map(),folders=new Map();
  const vault={
    adapter:{exists:async path=>files.has(path)||folders.has(path),read:async path=>contents.get(path),stat:async path=>folders.has(path)?{type:'folder'}:files.has(path)?{type:'file'}:null},
    getAbstractFileByPath:path=>files.get(path)||folders.get(path),getMarkdownFiles:()=>[...files.values()],
    createFolder:async path=>{folders.set(path,{path,children:[]});},
    create:async(path,content)=>{const file={path,stat:{size:new TextEncoder().encode(content).byteLength}};files.set(path,file);contents.set(path,content);return file;},
    read:async file=>contents.get(file.path),process:async(file,callback)=>{const next=callback(contents.get(file.path));contents.set(file.path,next);return next;},
  };
  const archive=new ConversationArchive({vault,idFactory:()=> 'retention-fixture',clock:()=>new Date('2026-10-08T00:00:00Z')});
  const initial=[...pair(1),...pair(2)],{analysis}=create(initial),appended=[...initial,...pair(3)];
  const saved=await archive.save({messages:appended,conversationMapAnalysis:analysis});const loaded=await archive.load({path:saved.path});
  assert.deepEqual(loaded.conversationMapAnalysis,analysis);assert.deepEqual(loaded.messages.map(({createdAt,...message})=>message),appended);const map=applyConversationMapAnalysis(buildConversationMap(loaded.messages),loaded.conversationMapAnalysis);assert.equal(map.cards[1].transitionMethod,'connected-llm');assert.equal(map.cards[2].transitionMethod,'unclassified');assert.equal(map.edges.length,1);
  const bad=structuredClone(appended);bad[0].content='Changed source';await assert.rejects(archive.save({messages:bad,conversationMapAnalysis:analysis}),{code:'ARCHIVE_INVALID_DATA'});
});
