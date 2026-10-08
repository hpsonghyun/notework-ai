import test from 'node:test';
import assert from 'node:assert/strict';
import {buildConversationMap,CONVERSATION_MAP_LIMITS} from '../src/conversation-map.mjs';

const CONTEXT='fixture-provider|fixture-model|scope-a|graph-a';
function pair(index,question,answer='Actual answer '+index,extras={}){return [{id:'u'+index,role:'user',content:question,contextKey:CONTEXT},{id:'a'+index,role:'assistant',content:answer,contextKey:CONTEXT,route:'fixture-provider',model:'fixture-model',...extras}];}
function deepFreeze(value){if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))deepFreeze(child);}return value;}
test('completed pairs produce exact question and answer extracts, model and evidence IDs without rewriting frozen messages',()=>{
  const messages=deepFreeze(pair(1,'Explain the actual research method.','This is the actual answer.'));
  const before=JSON.stringify(messages);const map=buildConversationMap(messages,{contextKey:CONTEXT});
  assert.equal(map.method,'local-quotes');assert.equal(map.totalCompletedPairs,1);assert.equal(map.cards[0].question,messages[0].content);assert.equal(map.cards[0].answer,messages[1].content);
  assert.equal(map.cards[0].userMessageId,'u1');assert.equal(map.cards[0].assistantMessageId,'a1');assert.equal(map.cards[0].model,'fixture-model');assert.equal(map.cards[0].transition,'unclear');assert.equal(map.topics[0].summary,messages[1].content);assert.equal(map.topics[0].answerMessageId,'a1');assert.equal(JSON.stringify(messages),before);
});
test('local cards stay unclassified regardless of correction wording or word overlap',()=>{
  const map=buildConversationMap([...pair(1,'Research method references evidence'),...pair(2,'추가로 Research method'),...pair(3,'New topic: travel')]);
  assert.deepEqual(map.cards.map(card=>card.transition),['unclear','unclear','unclear']);assert(map.cards.every(card=>card.parentId===null&&card.transitionMethod==='unclassified'));assert.equal(map.edges.length,0);assert.equal(map.aiBuilt,false);
});
test('provider, scope and graph contexts filter exactly and archive rebuilding never links across contexts',()=>{
  const messages=[...pair(1,'First question'),...pair(2,'Other question').map(message=>({...message,contextKey:'other-provider|scope-b|graph-b'})),...pair(3,'Add detail')];
  const current=buildConversationMap(messages,{contextKey:CONTEXT});assert.deepEqual(current.cards.map(card=>card.userMessageId),['u1','u3']);
  const other=buildConversationMap(messages,{contextKey:'other-provider|scope-b|graph-b'});assert.equal(other.cards.length,1);assert.equal(other.cards[0].transition,'unclear');
  const archive=buildConversationMap(JSON.parse(JSON.stringify(messages)));assert.equal(archive.cards.length,3);assert.equal(archive.cards[1].parentId,null);assert.equal(archive.cards[2].parentId,null);
  assert.deepEqual(buildConversationMap(messages,{contextKey:'missing'}).cards,[]);
});
test('failed, aborted, streaming, partial and unknown-status answers cannot create completed cards',()=>{
  const bad=[{status:'failed'},{status:'aborted'},{status:'streaming'},{status:'partial'},{status:'invented'},{completed:false},{complete:false},{partial:true},{incomplete:true},{aborted:true},{cancelled:true},{canceled:true},{streaming:true},{error:'fixture error'},{finishReason:'length'},{finish_reason:'max_tokens'}];
  const messages=bad.flatMap((extra,index)=>pair(index,'Question '+index,'Unfinished answer',extra));messages.push(...pair(99,'Completed question','Complete answer',{status:'completed'}));
  const map=buildConversationMap(messages);assert.equal(map.cards.length,1);assert.equal(map.cards[0].userMessageId,'u99');assert.equal(map.cards[0].answer,'Complete answer');
});
test('invalid entries, duplicate IDs and broken pair boundaries are omitted without misattributing answers',()=>{
  const messages=[null,...pair(1,'Duplicate user'),...pair(1,'Duplicate again'),{id:'orphan',role:'assistant',content:'Orphan',contextKey:CONTEXT},{id:'pending',role:'user',content:'Pending',contextKey:CONTEXT},{id:'system',role:'system',content:'Not a pair'},...pair(9,'Valid completed question','Valid answer')];
  const map=buildConversationMap(messages);assert.deepEqual(map.cards.map(card=>card.userMessageId),['u9']);assert.ok(map.ignoredMessages>=6);
  assert.deepEqual(buildConversationMap({}).cards,[]);assert.equal(buildConversationMap({}).invalidInput,true);
  const mixed=pair(1,'Mixed');mixed[1].contextKey='another-context';assert.equal(buildConversationMap(mixed).cards.length,0);
  assert.equal(buildConversationMap([pair(1,'Pending')[0]]).cards.length,0);
  const malformed=pair(1,'Broken ID');malformed[0].id='broken\ud800';assert.equal(buildConversationMap(malformed).cards.length,0);
});
test('source refs are bounded, deduplicated and allowlisted without spreading source excerpts or secrets',()=>{
  const sources=[{path:'Research/fixture.md',chunkId:'c1',contentHash:'fixture-hash',text:'PRIVATE_EXCERPT',apiKey:'PRIVATE_KEY'},{path:'Research/fixture.md',chunkId:'c1',contentHash:'fixture-hash'},{path:'../private.md'},{path:'C:/private.md'},{path:'.obsidian/private.md'}];
  const card=buildConversationMap(pair(1,'Sources','Actual answer',{sources,contextSources:[{path:'Research/history.md',text:'PRIVATE_HISTORY'}]})).cards[0];
  assert.deepEqual(card.sources,[{path:'Research/fixture.md',chunkId:'c1',contentHash:'fixture-hash'}]);assert.deepEqual(card.contextSources,[{path:'Research/history.md'}]);assert.ok(!JSON.stringify(card).includes('PRIVATE_'));
  const many=buildConversationMap(pair(1,'Many','Answer',{sources:Array.from({length:100},(_,i)=>({path:'Research/'+i+'.md'}))})).cards[0];assert.equal(many.sources.length,CONVERSATION_MAP_LIMITS.maxSources);
});
test('Unicode, decomposed Korean, emoji and raw markup preserve exact source offsets without cutting graphemes',()=>{
  const content='한🙂👨‍👩‍👧‍👦 <script>fixture()</script> & "quotes"\nSecond line';const messages=pair(1,content,content);
  for(const maxExcerptChars of [0,1,2,3,4,5,6,10,17,40,100]){
    const card=buildConversationMap(messages,{maxExcerptChars}).cards[0];
    for(const [extract,message] of [[card.questionExcerpt,messages[0]],[card.answerExcerpt,messages[1]]]){assert.equal(message.content.slice(extract.start,extract.end),extract.text);assert.ok(extract.end<=maxExcerptChars);assert.ok(!/[\uD800-\uDBFF]$/.test(extract.text));assert.ok(!extract.text.endsWith('\u200d'));}
  }
  const card=buildConversationMap(messages,{maxExcerptChars:100}).cards[0];assert.equal(card.question,content);assert.ok(card.answer.includes('<script>fixture()</script>'));assert.equal(card.questionExcerpt.truncated,false);
});
test('tiny card budgets report omitted coverage without dangling parent edges or fabricating a new start',()=>{
  const messages=Array.from({length:4},(_,i)=>pair(i,'Add detail '+i,'Answer '+i)).flat();const full=buildConversationMap(messages);const small=buildConversationMap(messages,{maxCards:1,maxExcerptChars:0});
  assert.equal(small.totalCompletedPairs,4);assert.equal(small.omittedCompletedPairs,3);assert.equal(small.cards[0].id,full.cards[3].id);assert.equal(small.cards[0].parentId,null);assert.equal(small.cards[0].transition,'unclear');assert.equal(small.cards[0].answer,'');assert.equal(small.cards[0].answerExcerpt.truncated,true);assert.equal(small.edges.length,0);
  const empty=buildConversationMap(messages,{maxCards:0});assert.equal(empty.cards.length,0);assert.equal(empty.omittedCompletedPairs,4);assert.equal(empty.topics.length,0);
  for(const maxCards of [-1,1.5,201,NaN])assert.throws(()=>buildConversationMap(messages,{maxCards}),RangeError);
});
test('archived JSON messages deterministically reconstruct the map with no additional request',()=>{
  const messages=[...pair(1,'Initial question','Original answer'),...pair(2,'Add details','Actual additional answer')];const first=buildConversationMap(messages,{contextKey:CONTEXT});
  assert.deepEqual(buildConversationMap(JSON.parse(JSON.stringify(messages)),{contextKey:CONTEXT}),first);assert.equal(Object.hasOwn(first,'requestCount'),false);
});
test('bounded inspected message windows disclose omitted messages and keep IDs stable within the window',()=>{
  const messages=Array.from({length:1002},(_,i)=>pair(i,'Add detail '+i)).flat();const map=buildConversationMap(messages,{maxCards:2});
  assert.equal(map.omittedMessages,4);assert.equal(map.totalCompletedPairs,1000);assert.equal(map.omittedCompletedPairs,998);assert.deepEqual(map.cards.map(card=>card.userMessageId),['u1000','u1001']);assert.equal(map.edges.length,0);
});
