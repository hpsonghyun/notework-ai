import {hasAsciiControl} from './text-safety.mjs';
import {relativePath} from './archive-paths.mjs';

export const CONVERSATION_MAP_LIMITS = Object.freeze({maxMessages:2000,maxCards:200,maxExcerptChars:1200,maxSources:20});
export const MAP_TRANSITION_LABELS = Object.freeze({start:'AI topic start',refine:'AI refinement',branch:'AI topic branch',continue:'AI continuation',unclear:'Pending AI classification'});
const CONTROL={test:value=>hasAsciiControl(value,{allowTextWhitespace:true})};
const BROKEN_SURROGATE=/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const BAD_STATUS=new Set(['failed','failure','error','aborted','cancelled','canceled','partial','streaming','pending','incomplete','stopped']);
const GOOD_STATUS=new Set(['complete','completed','success','succeeded','done']);
const segmenter=typeof Intl.Segmenter==='function'?new Intl.Segmenter(undefined,{granularity:'grapheme'}):null;
function record(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function validText(value,max,{empty=false}={}){return typeof value==='string'&&value.length<=max&&(empty||value.trim().length>0)&&!CONTROL.test(value)&&!BROKEN_SURROGATE.test(value);}
function budget(value,fallback,max){if(value===undefined)return fallback;if(!Number.isSafeInteger(value)||value<0||value>max)throw new RangeError('Conversation map limits must be bounded non-negative integers.');return value;}
/** Exact original prefix, measured in UTF-16 offsets and clipped only at grapheme boundaries. */
function extract(content,max){
  let end=0;
  if(segmenter){for(const item of segmenter.segment(content)){if(item.index+item.segment.length>max)break;end=item.index+item.segment.length;}}
  else for(const character of content){if(end+character.length>max)break;end+=character.length;}
  return {text:content.slice(0,end),start:0,end,truncated:end<content.length};
}
function title(content){const line=content.split(/\r?\n/u).find(value=>value.trim())||content;return extract(line.trim(),120).text;}
function completed(message){
  if(message.complete===false||message.completed===false||message.partial===true||message.incomplete===true||message.aborted===true||message.cancelled===true||message.canceled===true||message.streaming===true||message.error)return false;
  for(const key of ['finishReason','finish_reason'])if(['length','max_tokens','content_filter','error','aborted','cancelled','canceled'].includes(message[key]))return false;
  for(const key of ['status','phase'])if(message[key]!==undefined){if(typeof message[key]!=='string')return false;const value=message[key].toLowerCase();if(BAD_STATUS.has(value)||!GOOD_STATUS.has(value))return false;}
  return true; // Older archives store only final assistant messages, without a status field.
}
function refs(values){
  const out=[];const seen=new Set();
  for(const source of Array.isArray(values)?values.slice(0,100):[]){
    if(!record(source))continue;let path;try{path=relativePath(source.path);}catch{continue;}
    const ref={path};for(const key of ['chunkId','contentHash'])if(validText(source[key],256,{empty:true}))ref[key]=source[key];
    const key=JSON.stringify(ref);if(!seen.has(key)){seen.add(key);out.push(ref);}if(out.length===CONVERSATION_MAP_LIMITS.maxSources)break;
  }
  return out;
}
/**
 * Pure, bounded and deterministic local view of completed question/answer pairs.
 * Quotes are exact extracts. Relationships stay unclassified until the connected AI returns validated IDs.
 * No model/network call occurs while extracting cards.
 * An omitted contextKey rebuilds all archive contexts without joining different contexts.
 */
export function buildConversationMap(messages,{contextKey,maxCards,maxExcerptChars}={}){
  if(contextKey!==undefined&&!validText(contextKey,8*1024*1024,{empty:true}))throw new TypeError('Use a valid conversation context signature.');
  const selectedContext=contextKey===undefined?null:contextKey;
  const cardBudget=budget(maxCards,100,CONVERSATION_MAP_LIMITS.maxCards);const excerptBudget=budget(maxExcerptChars,240,CONVERSATION_MAP_LIMITS.maxExcerptChars);
  const out={schema:1,method:'local-quotes',contextKey:selectedContext,cards:[],topics:[],edges:[],totalCompletedPairs:0,omittedCompletedPairs:0,ignoredMessages:0,omittedMessages:0,aiBuilt:false,phase:'pending',status:'Completed questions and answers are recorded automatically. Topics update after each answer.'};
  if(!Array.isArray(messages)){out.invalidInput=true;return out;}
  out.omittedMessages=Math.max(0,messages.length-CONVERSATION_MAP_LIMITS.maxMessages);
  const inspected=messages.slice(-CONVERSATION_MAP_LIMITS.maxMessages);const counts=new Map();
  for(const message of inspected)if(validText(message?.id,256))counts.set(message.id,(counts.get(message.id)||0)+1);
  const full=[];const topics=new Map();let pending=null;
  for(const message of inspected){
    if(!record(message)||!['user','assistant'].includes(message.role)||!validText(message.id,256)||counts.get(message.id)!==1||!validText(message.content,512*1024)||message.contextKey!==undefined&&!validText(message.contextKey,8*1024*1024,{empty:true})){
      out.ignoredMessages++;pending=null;continue;
    }
    const key=message.contextKey??null;
    if(selectedContext!==null&&key!==selectedContext){pending=null;continue;}
    if(message.role==='user'){pending=message;continue;}
    if(!pending||!completed(message)||!completed(pending)||key!==(pending.contextKey??null)){out.ignoredMessages++;pending=null;continue;}
    const user=pending;pending=null;const transition='unclear';
    const id='map:'+encodeURIComponent(user.id)+':'+encodeURIComponent(message.id);
    const topicId='topic:'+id;
    const questionExcerpt=extract(user.content,excerptBudget);const answerExcerpt=extract(message.content,excerptBudget);
    const card={id,userMessageId:user.id,assistantMessageId:message.id,contextKey:key,title:title(user.content),question:questionExcerpt.text,answer:answerExcerpt.text,questionExcerpt,answerExcerpt,transition,transitionLabel:MAP_TRANSITION_LABELS[transition],transitionMethod:'unclassified',parentId:null,topicId,sources:refs(message.sources),contextSources:refs(message.contextSources)};
    for(const field of ['route','model','createdAt'])if(validText(message[field],256))card[field]=message[field];
    if(!topics.has(topicId))topics.set(topicId,{id:topicId,title:card.title,contextKey:key,anchorMessageId:user.id,cardIds:[],summary:'',answerMessageId:''});
    const topic=topics.get(topicId);topic.cardIds.push(id);topic.summary=card.answer;topic.answerMessageId=message.id;
    full.push(card);
  }
  out.totalCompletedPairs=full.length;out.omittedCompletedPairs=Math.max(0,full.length-cardBudget);
  const retained=cardBudget?full.slice(-cardBudget):[];const visible=new Set(retained.map(card=>card.id));
  for(const original of retained){
    const card={...original};
    out.cards.push(card);
    if(card.parentId)out.edges.push({id:'edge:'+card.id,source:card.parentId,target:card.id,relation:card.transition,method:'connected-llm'});
  }
  for(const topic of topics.values()){
    const cardIds=topic.cardIds.filter(id=>visible.has(id));if(!cardIds.length)continue;
    out.topics.push({...topic,cardIds,omittedCards:topic.cardIds.length-cardIds.length});
  }
  return out;
}
