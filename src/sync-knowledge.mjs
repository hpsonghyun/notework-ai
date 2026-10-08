import {hasAsciiControl} from './text-safety.mjs';
import {knowledgeChunkingForPolicy} from './knowledge-engine.mjs';
import {normalizeScope} from './vault-search.mjs';
import {sha256HexSync} from './portable-crypto.mjs';
import {KNOWLEDGE_LAYERS,RELATION_KINDS,HIERARCHY_LEVELS,KNOWLEDGE_HIERARCHY_POLICY,knowledgeHierarchyLevels} from './providers/jev.mjs';

export const DEFAULT_SYNC_KNOWLEDGE_PATH='Notework/Sync/knowledge-index.json';
// A numeric vector coordinate needs at least two serialized bytes including its
// separator. This resource guard cannot exclude an index within the byte budget.
export const SYNC_KNOWLEDGE_LIMITS=Object.freeze({maxBytes:64*1024*1024,maxVectorElements:32*1024*1024});
const queues=new WeakMap();
const HASH=/^[a-f0-9]{64}$/;
const DEVICE_NAME=/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const STATS=['selectedNotes','indexedNotes','chunks','skippedNotes','limitedNotes','truncatedNotes','reusedChunks','reusedSemanticNodes','reusedEdges','embeddingCalls','semanticCalls','classifiedNotes','judgedPairs','maxSemanticCalls','builtNowNotes','addedNotes','replacedNotes','retainedNotes','removedNotes','retainedLexicalNotes','retainedLexicalChunks','retainedCategoryFallbacks','scoreAdjustments'];
function fail(code,message){return Object.assign(new Error(message),{code});}
function invalid(){return fail('INVALID_SYNC_KNOWLEDGE','The sync knowledge file is invalid. Export a new index from your computer.');}
function cancelled(signal){if(signal?.aborted)throw Object.assign(new Error('Knowledge sync stopped.'),{name:'AbortError',code:'CANCELLED'});}
function plain(value){return value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));}
function object(value){if(!plain(value)||Object.hasOwn(value,'__proto__'))throw invalid();return value;}
function text(value,max,{empty=false}={}){if(typeof value!=='string'||value.length>max||!empty&&!value.trim()||hasAsciiControl(value,{allowTextWhitespace:true}))throw invalid();return value;}
function integer(value,min=0,max=Number.MAX_SAFE_INTEGER){if(!Number.isSafeInteger(value)||value<min||value>max)throw invalid();return value;}
function choice(value,allowed){if(!allowed.includes(value))throw invalid();return value;}
function hash(value){if(typeof value!=='string'||!HASH.test(value))throw invalid();return value;}
function model(value){return value===null?null:text(value,1024);}
function probability(value){if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>1)throw invalid();return value;}
function edgeWeight(value){if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>1+1e-12)throw invalid();return Math.min(1,value);}
function mtime(value){if(value===null)return null;if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw invalid();return value;}
function date(value){text(value,40);if(!Number.isFinite(Date.parse(value)))throw invalid();return value;}
function list(value,max=Infinity){if(!Array.isArray(value)||value.length>max)throw invalid();return value;}
function unique(values,key){const seen=new Set();for(const item of values){if(seen.has(item[key]))throw invalid();seen.add(item[key]);}return values;}
function byteLimit(value){if(!Number.isSafeInteger(value)||value<1||value>SYNC_KNOWLEDGE_LIMITS.maxBytes)throw fail('INVALID_SYNC_LIMIT','Choose a bounded knowledge sync file size.');return value;}
function bytes(value){return new TextEncoder().encode(value).byteLength;}

/** A literal ordinary vault path. No normalization of unsafe input into a safe-looking path. */
export function normalizeSyncKnowledgePath(value=DEFAULT_SYNC_KNOWLEDGE_PATH){
  if(typeof value!=='string'||value.length>1024||!value||(hasAsciiControl(value)||/[\\:%?#*<>"|]/u.test(value))||value.startsWith('/')||value.split('/').some(part=>!part||part==='.'||part==='..'||part.startsWith('.')||part.endsWith('.')||part.trim()!==part||DEVICE_NAME.test(part))||!value.endsWith('.json'))throw fail('INVALID_SYNC_PATH','Choose an ordinary .json file inside the current vault, outside its configuration folders.');
  return value;
}
function notePath(value){text(value,1024);if((hasAsciiControl(value)||/[\\:?]/u.test(value))||value.startsWith('/')||value.split('/').some(part=>!part||part.startsWith('.')||part.trim()!==part)||!value.toLowerCase().endsWith('.md'))throw invalid();return value;}
function evidence(value){
  object(value);const out={path:notePath(value.path),contentHash:hash(value.contentHash),chunkId:text(value.chunkId,100),start:integer(value.start),end:integer(value.end),quote:text(value.quote,300,{empty:true}),offsetUnit:choice(value.offsetUnit,['utf16'])};
  if(out.end<out.start||out.end-out.start!==out.quote.length)throw invalid();return out;
}
function metadata(value,{node=false}={}){
  object(value);const out={status:choice(value.status,node?['local','classified']:['candidate','model-judgment']),route:choice(value.route,node?['local','jev','llm']:['authored-link','lexical','ollama','jev','llm']),model:model(value.model)};
  for(const key of node?['categoryConfidence','layerConfidence','hierarchyConfidence']:['relatedProbability','score','confidence'])if(value[key]!==undefined)out[key]=probability(value[key]);
  if(!node&&(value.scoreSource!==undefined||value.reportedScore!==undefined)){if(value.scoreSource!=='probabilities'||out.route!=='jev'||out.status!=='model-judgment')throw invalid();out.scoreSource='probabilities';out.reportedScore=probability(value.reportedScore);}
  return out;
}

/** Strict schema-1 allowlist. Source text and vectors are elected index content; settings and secrets are never copied. */
export function normalizeSyncKnowledgeIndex(value){
  object(value);const chunking=knowledgeChunkingForPolicy(value.chunkPolicy);if(value.schema!==1||!chunking||!/^index_[a-f0-9]{24}$/.test(value.id))throw invalid();
  object(value.embedding);object(value.semantic);
  const embedding={route:choice(value.embedding.route,['lexical','ollama']),model:model(value.embedding.model),dimension:integer(value.embedding.dimension,0,16384),fingerprint:model(value.embedding.fingerprint)};
  if(embedding.route==='ollama'&&(!embedding.dimension||!embedding.model)||embedding.route==='lexical'&&(embedding.dimension!==0||embedding.model!==null))throw invalid();
  const semantic={route:choice(value.semantic.route,['none','jev','llm']),model:model(value.semantic.model),taxonomySource:choice(value.semantic.taxonomySource,['user','llm','local-folders'])};
  if(value.semantic.hierarchyPolicy!==undefined)semantic.hierarchyPolicy=choice(value.semantic.hierarchyPolicy,[KNOWLEDGE_HIERARCHY_POLICY]);
  const rawScope=object(value.scope);for(const field of ['include','exclude'])for(const path of list(rawScope[field]??[],10000)){text(path,1024,{empty:true});if(path==='')continue;normalizeSyncKnowledgePath(path+'/fixture.json');}
  for(const field of ['tags','excludeTags'])list(rawScope[field]??[],10000);
  let scope;try{scope=normalizeScope(rawScope);}catch{throw invalid();}
  const categories=unique(list(value.categories,16).map(item=>{object(item);return {id:text(item.id,100),label:text(item.label,100),description:text(item.description,400,{empty:true}),count:integer(item.count)};}),'id');
  const layers=unique(list(value.layers,16).map(item=>{object(item);return {id:choice(item.id,Object.keys(KNOWLEDGE_LAYERS)),label:text(item.label,100),description:text(item.description,400,{empty:true}),count:integer(item.count)};}),'id');
  const categoryIds=new Set(categories.map(item=>item.id));let vectorElements=0;
  const chunks=unique(list(value.chunks).map(item=>{
    object(item);const chunk={id:text(item.id,100),path:notePath(item.path),text:text(item.text,chunking.maxChars),start:integer(item.start),end:integer(item.end),contentHash:hash(item.contentHash),offsetUnit:choice(item.offsetUnit,['utf16'])};
    if(chunking.maxBytes!==null&&bytes(chunk.text)>chunking.maxBytes)throw invalid();
    if(chunk.end-chunk.start!==chunk.text.length||chunk.id!=='chunk_'+sha256HexSync(JSON.stringify([chunk.path,chunk.contentHash,chunk.start,chunk.end])).slice(0,24))throw invalid();
    if(item.vectorState!==undefined&&(embedding.route!=='ollama'||item.vectorState!=='lexical-only'||item.vector!==undefined))throw invalid();
    if(embedding.route==='ollama'&&item.vectorState==='lexical-only')chunk.vectorState='lexical-only';
    else if(embedding.route==='ollama'){
      const vector=list(item.vector,embedding.dimension);vectorElements+=vector.length;if(vectorElements>SYNC_KNOWLEDGE_LIMITS.maxVectorElements)throw fail('SYNC_KNOWLEDGE_TOO_LARGE','The index vectors exceed the knowledge sync byte-size resource limit.');if(vector.length!==embedding.dimension||vector.some(number=>typeof number!=='number'||!Number.isFinite(number)||Math.abs(number)>1)||!vector.some(number=>number!==0))throw invalid();
      const norm=vector.reduce((sum,number)=>sum+number*number,0);if(Math.abs(norm-1)>0.0001)throw invalid();chunk.vector=[...vector];
    }
    return chunk;
  }),'id');
  const chunkMap=new Map(chunks.map(chunk=>[chunk.id,chunk]));const ownedChunks=new Set();
  const nodes=unique(unique(list(value.nodes).map(item=>{
    object(item);object(item.evidence);const node={id:text(item.id,100),path:notePath(item.path),title:text(item.title,200,{empty:true}),category:text(item.category,100),layer:choice(item.layer,Object.keys(KNOWLEDGE_LAYERS)),hierarchyLevel:item.hierarchyLevel===undefined?'unassigned':choice(item.hierarchyLevel,Object.keys(HIERARCHY_LEVELS)),chunkIds:list(item.chunkIds).map(id=>text(id,100)),mtime:mtime(item.mtime),contentHash:hash(item.contentHash),sourceLength:integer(item.sourceLength),summary:text(item.summary,250,{empty:true})};
    if(node.id!=='note_'+sha256HexSync(node.path).slice(0,20)||!categoryIds.has(node.category)||!node.chunkIds.length||new Set(node.chunkIds).size!==node.chunkIds.length)throw invalid();
    for(const id of node.chunkIds){const chunk=chunkMap.get(id);if(!chunk||ownedChunks.has(id)||chunk.path!==node.path||chunk.contentHash!==node.contentHash||chunk.end>node.sourceLength)throw invalid();ownedChunks.add(id);}
    node.evidence={...metadata(item.evidence,{node:true}),path:notePath(item.evidence.path),contentHash:hash(item.evidence.contentHash),chunks:list(item.evidence.chunks,2).map(evidence)};
    if(node.evidence.path!==node.path||node.evidence.contentHash!==node.contentHash)throw invalid();
    for(const quote of node.evidence.chunks){const chunk=chunkMap.get(quote.chunkId);if(!node.chunkIds.includes(quote.chunkId)||quote.path!==node.path||quote.contentHash!==node.contentHash||quote.start!==chunk.start||quote.end>chunk.end||quote.quote!==chunk.text.slice(0,quote.end-quote.start))throw invalid();}
    return node;
  }),'id'),'path');
  const canonicalHierarchy=knowledgeHierarchyLevels(nodes);
  const hierarchyLevels=value.hierarchyLevels===undefined?canonicalHierarchy:list(value.hierarchyLevels,4).map((item,i)=>{object(item);const level={id:choice(item.id,Object.keys(HIERARCHY_LEVELS)),label:text(item.label,100),description:text(item.description,400,{empty:true}),depth:integer(item.depth,0,3),count:integer(item.count)};if(level.id!==canonicalHierarchy[i].id||level.depth!==canonicalHierarchy[i].depth||level.count!==canonicalHierarchy[i].count)throw invalid();return level;});
  if(hierarchyLevels.length!==canonicalHierarchy.length)throw invalid();
  if(ownedChunks.size!==chunks.length)throw invalid();const nodeMap=new Map(nodes.map(node=>[node.id,node]));
  const edges=list(value.edges).map(item=>{
    object(item);object(item.evidence);const edge={source:text(item.source,100),target:text(item.target,100),kind:choice(item.kind,['link','vector-neighbor','keyword-overlap',...Object.keys(RELATION_KINDS).filter(kind=>kind!=='none')]),weight:edgeWeight(item.weight),evidence:{...metadata(item.evidence),source:evidence(item.evidence.source),target:evidence(item.evidence.target)}};
    for(const side of ['source','target']){const node=nodeMap.get(edge[side]);const quote=edge.evidence[side];const chunk=chunkMap.get(quote.chunkId);if(!node||!node.chunkIds.includes(quote.chunkId)||quote.path!==node.path||quote.contentHash!==node.contentHash||quote.start!==chunk.start||quote.end>chunk.end||quote.quote!==chunk.text.slice(0,quote.end-quote.start))throw invalid();}
    if(edge.source===edge.target)throw invalid();return edge;
  });
  const stats={};object(value.stats);for(const key of STATS)if(value.stats[key]!==undefined)stats[key]=key==='maxSemanticCalls'&&value.stats[key]===null?null:integer(value.stats[key]);if(value.stats.semanticStatus!==undefined)stats.semanticStatus=choice(value.stats.semanticStatus,['local','complete','budget-limited']);
  const out={schema:1,id:value.id,vaultId:hash(value.vaultId),builtAt:date(value.builtAt),chunkPolicy:value.chunkPolicy,configSignature:hash(value.configSignature),datasetHash:hash(value.datasetHash),embedding,semantic,scope,nodes,categories,layers,hierarchyLevels,edges,chunks,stats};
  if(value.buildSettings!==undefined){object(value.buildSettings);out.buildSettings={};for(const key of ['maxNotes','maxChunks','maxCalls'])if(value.buildSettings[key]!==undefined)out.buildSettings[key]=value.buildSettings[key]===null?null:integer(value.buildSettings[key]);out.buildSettings.categories=list(value.buildSettings.categories??[],15).map(label=>text(label,100));}
  // A serialized portableImport claim is never proof of local note verification.
  return out;
}
function serialize(index,maxBytes){const safe=normalizeSyncKnowledgeIndex(index);const raw=JSON.stringify(safe);const size=bytes(raw);if(size>maxBytes)throw fail('SYNC_KNOWLEDGE_TOO_LARGE','The knowledge sync file exceeds the selected size limit. Export a smaller selected index.');return {index:safe,raw,size};}
function decode(raw,maxBytes){if(typeof raw!=='string'||raw.length>maxBytes||bytes(raw)>maxBytes)throw fail('SYNC_KNOWLEDGE_TOO_LARGE','The knowledge sync file exceeds the selected size limit.');let index;try{index=JSON.parse(raw);}catch{throw invalid();}return normalizeSyncKnowledgeIndex(index);}

/** Explicit ordinary-vault export/import. Queued replacement never overwrites via rename. */
export class SyncKnowledgeStore{
  constructor({adapter,path=DEFAULT_SYNC_KNOWLEDGE_PATH,maxBytes=SYNC_KNOWLEDGE_LIMITS.maxBytes}={}){
    if(!adapter||typeof adapter!=='object'||!['exists','read'].every(key=>typeof adapter[key]==='function'))throw fail('SYNC_ADAPTER_REQUIRED','Use the current vault adapter for knowledge sync.');
    this.adapter=adapter;this.path=normalizeSyncKnowledgePath(path);this.maxBytes=byteLimit(maxBytes);
  }
  serial(action){let paths=queues.get(this.adapter);if(!paths){paths=new Map();queues.set(this.adapter,paths);}const operation=(paths.get(this.path)||Promise.resolve()).catch(()=>{}).then(action);paths.set(this.path,operation);return operation;}
  async remove(path){if(await this.adapter.exists(path))await this.adapter.remove(path);}
  supportsReplacement(){return ['write','rename','remove','mkdir'].every(key=>typeof this.adapter[key]==='function');}
  async recover(){
    const previous=this.path+'.previous';if(!await this.adapter.exists(previous))return;
    const raw=await this.adapter.read(previous);decode(raw,this.maxBytes);
    if(!this.supportsReplacement())throw fail('SYNC_RECOVERY_REQUIRED','Restore the interrupted knowledge export with an adapter that supports replacement.');
    await this.remove(this.path);await this.adapter.rename(previous,this.path);try{await this.remove(this.path+'.pending');}catch{/* Only the restored committed file is read. */}
  }
  async folders(signal){const parts=this.path.split('/').slice(0,-1);for(let at=1;at<=parts.length;at++){cancelled(signal);const folder=parts.slice(0,at).join('/');if(!await this.adapter.exists(folder))await this.adapter.mkdir(folder);cancelled(signal);}}
  export(index,{signal}={}){
    return this.serial(async()=>{
      cancelled(signal);if(!this.supportsReplacement())throw fail('SYNC_ATOMIC_UNAVAILABLE','This vault adapter cannot safely replace a synced knowledge file.');
      const data=serialize(index,this.maxBytes);cancelled(signal);await this.recover();cancelled(signal);await this.folders(signal);
      const pending=this.path+'.pending',previous=this.path+'.previous';const hadOld=await this.adapter.exists(this.path),oldRaw=hadOld?await this.adapter.read(this.path):null;let replacing=false;
      try{
        cancelled(signal);await this.adapter.write(pending,data.raw);cancelled(signal);
        // Read back staged bytes before touching a committed file.
        if(await this.adapter.read(pending)!==data.raw)throw fail('SYNC_WRITE_FAILED','The staged knowledge export did not match the intended bytes.');cancelled(signal);
        replacing=true;if(hadOld)await this.adapter.rename(this.path,previous);cancelled(signal);await this.adapter.rename(pending,this.path);cancelled(signal);
        if(hadOld)await this.adapter.remove(previous);cancelled(signal);
        return {path:this.path,indexId:data.index.id,bytes:data.size,noteCount:data.index.nodes.length,chunkCount:data.index.chunks.length};
      }catch(error){
        if(replacing)try{
          if(hadOld){if(!await this.adapter.exists(previous))await this.adapter.write(previous,oldRaw);await this.remove(this.path);await this.adapter.rename(previous,this.path);}else await this.remove(this.path);
        }catch(restoreError){throw new AggregateError([error,restoreError],'Knowledge export failed and its previous file could not be restored. The recovery file is retained when possible.');}
        try{await this.remove(pending);}catch{/* A pending export is never imported. */}throw error;
      }
    });
  }
  /** Returns a sanitized SOURCE index, never a locally adopted index. Caller must verify original notes. */
  load({signal}={}){return this.serial(async()=>{cancelled(signal);await this.recover();cancelled(signal);if(!await this.adapter.exists(this.path))return null;const raw=await this.adapter.read(this.path);cancelled(signal);const index=decode(raw,this.maxBytes);cancelled(signal);return index;});}
  /** Safe convenience route: only the existing engine's local original-note verification can adopt a source. */
  async import({engine,files,scope,consent=false,signal,onProgress}={}){
    cancelled(signal);if(consent!==true)throw fail('KNOWLEDGE_IMPORT_CONSENT_REQUIRED','Allow local verification of the synced source notes before importing.');
    if(typeof engine?.importPortableIndex!=='function'||typeof engine?.vaultId!=='function')throw fail('SYNC_VERIFIER_REQUIRED','Use the current vault knowledge engine to verify the original notes.');
    const index=await this.load({signal});if(!index)throw fail('SYNC_KNOWLEDGE_MISSING','Export knowledge from your computer and sync that file and its original notes first.');
    const adopted=await engine.importPortableIndex({index,files,scope,consent:true,signal,onProgress});cancelled(signal);
    if(adopted?.vaultId!==engine.vaultId()||adopted?.portableImport?.sourceIndexId!==index.id)throw invalid();
    return adopted;
  }
}
