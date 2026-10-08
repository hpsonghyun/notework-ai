import {sha256HexSync} from './portable-crypto.mjs';
import {cleanPath,normalizeScope,selectedFiles} from './vault-search.mjs';
import {HIERARCHY_LEVELS,KNOWLEDGE_HIERARCHY_POLICY} from './providers/jev.mjs';
import {normalizeVector} from './providers/ollama-embeddings.mjs';
import {KNOWLEDGE_CHUNK_POLICY,knowledgeChunkingForPolicy} from './knowledge-engine.mjs';

export {KNOWLEDGE_CHUNK_POLICY};
export const INDEX_COVERAGE_STATUSES=Object.freeze(['Indexed','Up to date','Changed','Not indexed','Partial']);
const hash=value=>sha256HexSync(typeof value==='string'?value:JSON.stringify(value));
const has=(object,key)=>Object.hasOwn(object||{},key);
const pathOK=path=>{try{return typeof path==='string'&&path===cleanPath(path)&&path.toLowerCase().endsWith('.md')&&!path.split('/').some(part=>part.startsWith('.'));}catch{return false;}};
const stamp=file=>[file?.stat?.mtime??null,file?.stat?.size??null].join('|');
const check=signal=>{if(signal?.aborted){const error=new Error('Index coverage check stopped.');error.name='AbortError';error.code='CANCELLED';throw error;}};
const validDate=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const labels=values=>[...new Set((Array.isArray(values)?values:[]).map(value=>typeof value==='string'?value:value?.label).filter(value=>typeof value==='string').map(value=>value.trim().normalize('NFC').toLocaleLowerCase()).filter(value=>value&&value!=='other'))].sort();

/** Local-only, bounded source verification cache. Subscribe to vault modify/create/
 * delete/rename events and invalidate every affected path (even same-size/mtime
 * writes). Clear on unload/reload or uncertain event delivery. No text is retained.
 * A cached record proves the bytes last read, never an unobserved external write.
 */
export class IndexCoverageCache {
  constructor({maxEntries=20000}={}){this.maxEntries=maxEntries;this.entries=new Map();this.versions=new Map();this.generation=0;}
  invalidate(path){this.entries.delete(path);this.versions.set(path,(this.versions.get(path)||0)+1);this.generation++;}
  clear(){this.entries.clear();this.versions.clear();this.generation++;}
  version(path){return this.versions.get(path)||0;}
  get(file){const entry=this.entries.get(file.path);return entry?.stamp===stamp(file)&&entry.version===this.version(file.path)?entry:null;}
  put(file,record,version){if(version!==this.version(file.path))return false;if(this.entries.size>=this.maxEntries&&!this.entries.has(file.path))this.entries.delete(this.entries.keys().next().value);this.entries.set(file.path,{...record,stamp:stamp(file),version});return true;}
}

/** Compare only supplied settings. This does not contact or attest installed
 * model weights. Supply embeddingFingerprint when a local model was verified.
 * Existing vectors can remain reusable even when semantic/build limits drift.
 */
export function indexSettingsCompatibility(index,settings={}){
  const reasons=[];const add=reason=>{if(!reasons.includes(reason))reasons.push(reason);};
  if(!index||index.schema!==1||!Array.isArray(index.nodes)||!Array.isArray(index.chunks))add('index-format');
  if(index&&(!['lexical','ollama'].includes(index.embedding?.route)||(index.embedding.route==='ollama'&&(!Number.isInteger(index.embedding.dimension)||index.embedding.dimension<1||index.embedding.dimension>16384))||!['none','jev','llm'].includes(index.semantic?.route)))add('index-format');
  if(!knowledgeChunkingForPolicy(index?.chunkPolicy)||(has(settings,'chunkPolicy')&&settings.chunkPolicy!==index?.chunkPolicy))add('chunk-policy');
  for(const [key,field] of [['embeddingRoute','route'],['embeddingModel','model']])if(has(settings,key)&&(key!=='embeddingModel'||(settings.embeddingRoute||index?.embedding?.route)==='ollama')&&(settings[key]||null)!==(index?.embedding?.[field]||null))add(key);
  if(has(settings,'embeddingFingerprint')&&settings.embeddingFingerprint!==index?.embedding?.fingerprint)add('embedding-fingerprint');
  if(has(settings,'embeddingDimension')&&settings.embeddingDimension!==index?.embedding?.dimension)add('embedding-dimension');
  for(const [key,field] of [['semanticRoute','route'],['semanticModel','model']])if(has(settings,key)&&(key!=='semanticModel'||(settings.semanticRoute||index?.semantic?.route)!=='none')&&(settings[key]||null)!==(index?.semantic?.[field]||null))add(key);
  if(has(settings,'categories')||has(settings,'categoriesText')){
    const desired=labels(has(settings,'categories')?(Array.isArray(settings.categories)?settings.categories:[]):String(settings.categoriesText||'').split(/[\n,]/));
    const actual=labels(index?.buildSettings?.categories||((index?.semantic?.taxonomySource==='user')?index.categories||[]:[]));
    if(JSON.stringify(desired)!==JSON.stringify(actual))add('categories');
  }
  // Older indices lack limit metadata. Actual source spans still establish text
  // coverage; no invented budget mismatch is inferred for those releases.
  if(index?.buildSettings)for(const [key,flag] of [['maxNotes','limitNotes'],['maxChunks','limitChunks'],['maxCalls','limitCalls']]){
    if(!has(settings,key)&&!has(settings,flag))continue;
    const desired=has(settings,flag)?(settings[flag]?settings[key]:null):(settings[key]??null);
    if(desired!==(index.buildSettings[key]??null))add(key);
  }
  const embeddingReasons=reasons.filter(reason=>['index-format','chunk-policy','embeddingRoute','embeddingModel','embedding-fingerprint','embedding-dimension'].includes(reason));
  return{compatible:reasons.length===0,embeddingCompatible:embeddingReasons.length===0,reasons,modelFingerprintVerified:has(settings,'embeddingFingerprint')&&Boolean(settings.embeddingFingerprint)&&settings.embeddingFingerprint===index?.embedding?.fingerprint};
}

function ancestors(path){const parts=path.split('/');parts.pop();const result=[''];for(let at=1;at<=parts.length;at++)result.push(parts.slice(0,at).join('/'));return result;}
function emptyCounts(){return{selectedNotes:0,indexedNotes:0,upToDateNotes:0,changedNotes:0,notIndexedNotes:0,partialNotes:0,uncheckedNotes:0,removedNotes:0,unreadableNotes:0,chunks:0,semanticPendingNotes:0};}
function rowStatus(row){if(row.changedNotes||row.removedNotes)return'Changed';if(!row.selectedNotes)return'Not indexed';if(row.partialNotes||row.semanticPendingNotes||(row.notIndexedNotes&&row.indexedNotes))return'Partial';if(row.notIndexedNotes)return'Not indexed';if(row.uncheckedNotes)return'Indexed';return'Up to date';}
function aggregate(entries,removed,{builtAt,checkedAt,compatibility,index,reads,cacheHits}){
  const folders=new Map([['',{path:'',...emptyCounts()}]]);
  for(const entry of entries)for(const path of ancestors(entry.path)){
    if(!folders.has(path))folders.set(path,{path,...emptyCounts()});const row=folders.get(path);row.selectedNotes++;row.chunks+=entry.chunks;
    if(entry.indexed)row.indexedNotes++;
    if(entry.status==='Up to date')row.upToDateNotes++;
    else if(entry.status==='Changed')row.changedNotes++;
    else if(entry.status==='Not indexed')row.notIndexedNotes++;
    else if(entry.status==='Partial')row.partialNotes++;
    else row.uncheckedNotes++;
    if(entry.reason==='unreadable')row.unreadableNotes++;
    if(entry.semanticPending)row.semanticPendingNotes++;
  }
  for(const path of removed)for(const folder of ancestors(path)){if(!folders.has(folder))folders.set(folder,{path:folder,...emptyCounts()});folders.get(folder).removedNotes++;}
  const rows=[...folders.values()].map(row=>({...row,status:rowStatus(row),builtAt})).sort((a,b)=>a.path.localeCompare(b.path));
  const root=rows.find(row=>row.path==='');
  // Whitelist output: no excerpt, source hash, vector, exception text, credentials,
  // source index extra properties, or file metadata is allowed through.
  return{schema:1,indexId:/^index_[a-f0-9]{24}$/.test(index?.id||'')?index.id:null,builtAt,checkedAt,status:root.status,counts:Object.fromEntries(Object.keys(emptyCounts()).map(key=>[key,root[key]])),compatibility,folders:rows,files:entries,reads,cacheHits};
}
function inventory({files=[],currentFiles=files,index,scope={},getTags}){
  const normalized=normalizeScope(scope);const live=new Map(currentFiles.filter(file=>pathOK(file?.path)).map(file=>[file.path,file]));
  const requested=new Set(files.map(file=>file?.path));const selected=selectedFiles([...live.values()].filter(file=>requested.has(file.path)),normalized,{getTags});
  const nodes=new Map();const duplicates=new Set();for(const node of Array.isArray(index?.nodes)?index.nodes:[]){if(!pathOK(node?.path))continue;if(nodes.has(node.path))duplicates.add(node.path);else nodes.set(node.path,node);}
  const byPath=new Map();for(const chunk of Array.isArray(index?.chunks)?index.chunks:[]){if(!pathOK(chunk?.path))continue;const bucket=byPath.get(chunk.path)||[];bucket.push(chunk);byPath.set(chunk.path,bucket);}
  // Deleted nodes have no current tag metadata. Count only folder scope matches;
  // excluded current notes never become falsely "deleted" or "not indexed".
  const folderScope={...normalized,tags:[],excludeTags:[]};const removed=[...nodes.keys()].filter(path=>!live.has(path)&&selectedFiles([{path}],folderScope).length);
  return{selected,nodes,duplicates,byPath,removed};
}
function pendingSemantic(node,index){return index?.semantic?.route&&index.semantic.route!=='none'&&(node?.evidence?.status!=='classified'||index.semantic.hierarchyPolicy!==KNOWLEDGE_HIERARCHY_POLICY||!Object.hasOwn(HIERARCHY_LEVELS,node?.hierarchyLevel)||index?.stats?.semanticStatus==='budget-limited');}
function initialEntry(file,node,compatibility,duplicate){
  if(!node)return{path:file.path,status:'Not indexed',reason:'missing-source',indexed:false,chunks:0,semanticPending:false};
  if(!compatibility.compatible)return{path:file.path,status:'Changed',reason:'settings-changed',indexed:true,chunks:0,semanticPending:false};
  if(duplicate||!Array.isArray(node.chunkIds)||!/^[a-f0-9]{64}$/.test(node.contentHash||''))return{path:file.path,status:'Partial',reason:'invalid-source',indexed:true,chunks:0,semanticPending:false};
  return{path:file.path,status:'Indexed',reason:'verification-pending',indexed:true,chunks:0,semanticPending:false};
}

/** Metadata-only projection for immediate UI render. Indexed means a saved entry
 * exists; only computeIndexCoverage can assert Up to date after hashing bytes.
 */
export function indexCoverageSnapshot(options={}){
  const {selected,nodes,duplicates,removed}=inventory(options);const compatibility=indexSettingsCompatibility(options.index,options.settings);
  return aggregate(selected.map(file=>initialEntry(file,nodes.get(file.path),compatibility,duplicates.has(file.path))),removed,{index:options.index,builtAt:validDate(options.index?.builtAt),checkedAt:null,compatibility,reads:0,cacheHits:0});
}

function verifyChunks(node,chunks,text,index){
  const chunking=knowledgeChunkingForPolicy(index.chunkPolicy);if(!chunking)return{complete:false,chunks:0};
  const requested=new Set(node.chunkIds);const accepted=[];let invalid=requested.size!==node.chunkIds.length;
  const seen=new Set();let lexicalOnly=false;
  for(const chunk of chunks){if(!requested.has(chunk?.id))continue;
    if(seen.has(chunk.id)||chunk.path!==node.path||chunk.contentHash!==node.contentHash||!Number.isInteger(chunk.start)||!Number.isInteger(chunk.end)||chunk.start<0||chunk.end<=chunk.start||chunk.end>text.length||chunk.end-chunk.start>chunking.maxChars||typeof chunk.text!=='string'||(chunking.maxBytes!==null&&new TextEncoder().encode(chunk.text).byteLength>chunking.maxBytes)||chunk.text!==text.slice(chunk.start,chunk.end)||chunk.id!=='chunk_'+hash([chunk.path,chunk.contentHash,chunk.start,chunk.end]).slice(0,24)){invalid=true;continue;}
    if(index.embedding?.route==='ollama'){if(chunk.vectorState==='lexical-only'){if(chunk.vector!==undefined){invalid=true;continue;}lexicalOnly=true;}else {if(chunk.vectorState!==undefined){invalid=true;continue;}try{normalizeVector(chunk.vector,index.embedding.dimension);}catch{invalid=true;continue;}}}
    seen.add(chunk.id);accepted.push(chunk);
  }
  if(accepted.length!==requested.size||!accepted.length)invalid=true;
  accepted.sort((a,b)=>a.start-b.start);let end=0;for(const chunk of accepted){if(chunk.start>end&&text.slice(end,chunk.start).trim())invalid=true;end=Math.max(end,chunk.end);}
  if(text.slice(end).trim())invalid=true;
  if(Number.isInteger(node.sourceLength)&&node.sourceLength!==text.length)invalid=true;
  return{complete:!invalid,lexicalOnly,chunks:accepted.length};
}

/** Hash current selected source bytes locally, verify actual stored excerpt spans
 * and vector shape, then aggregate ancestor counts in O(notes * path depth).
 * read(file) must return current raw Markdown string, or {text}; throw/null means
 * unreadable and its error never escapes. No provider or vault write is invoked.
 * Scope changes reuse the event-invalidated cache; rendering uses this result or
 * indexCoverageSnapshot, never starts a read. cache is optional and disabled by
 * default. Pass force:true for an explicit disk recheck after missed events.
 */
export async function computeIndexCoverage(options={}){
  const {index,settings={},read,cache,signal,force=false,clock=()=>new Date(),onProgress=()=>{}}=options;
  const {selected,nodes,duplicates,byPath,removed}=inventory(options);const compatibility=indexSettingsCompatibility(index,settings);const entries=[];const verifiedSources=new Map();let reads=0,cacheHits=0;
  for(let at=0;at<selected.length;at++){
    check(signal);const file=selected[at];const node=nodes.get(file.path);let entry=initialEntry(file,node,compatibility,duplicates.has(file.path));
    // Content checks are still useful during config drift: Changed includes an
    // obsolete configuration, while unchanged bytes permit future vector reuse.
    if(node&&entry.reason!=='invalid-source'){
      const before=stamp(file),version=cache?.version(file.path);verifiedSources.set(file.path,{file,stamp:before,version});let record=!force?cache?.get(file):null;let text;
      if(record){cacheHits++;}
      else{
        try{reads++;const result=await read?.(file);check(signal);text=typeof result==='string'?result:result?.text;
          if(typeof text==='string'&&before===stamp(file)&&(cache===undefined||version===cache.version(file.path))){record={contentHash:hash(text),sourceLength:text.length};}
        }catch{check(signal);}
      }
      if(!record)entry={...entry,status:'Partial',reason:'unreadable'};
      else if(record.contentHash!==node.contentHash){entry={...entry,status:'Changed',reason:'source-changed'};if(text!==undefined)cache?.put(file,record,version);}
      else{
        // The cache keeps only digest/length and per-index span verification.
        // A new index requires rereading this note to validate its excerpt bytes.
        const indexKey=hash([index.id,node.contentHash,node.chunkIds,index.embedding?.route,index.embedding?.dimension,index.chunkPolicy,(byPath.get(file.path)||[]).map(chunk=>[chunk.id,chunk.path,chunk.contentHash,chunk.start,chunk.end,chunk.text,chunk.vector,chunk.vectorState])]);
        let verification=record.indexKey===indexKey?record.verification:null;
        if(!verification){
          if(text===undefined){try{reads++;const result=await read?.(file);check(signal);text=typeof result==='string'?result:result?.text;}catch{check(signal);}}
          if(typeof text==='string'&&before===stamp(file)&&(cache===undefined||version===cache.version(file.path))&&hash(text)===node.contentHash){verification=verifyChunks(node,byPath.get(file.path)||[],text,index);record={...record,indexKey,verification};cache?.put(file,record,version);}
        }
        const semanticPending=pendingSemantic(node,index);
        entry={...entry,chunks:verification?.chunks||0,semanticPending:Boolean(semanticPending),status:!verification?'Partial':!compatibility.compatible?'Changed':!verification.complete||verification.lexicalOnly||semanticPending?'Partial':'Up to date',reason:!verification?'unreadable':!compatibility.compatible?'settings-changed':!verification.complete?'incomplete-text':verification.lexicalOnly?'embedding-pending':semanticPending?'semantic-pending':'hash-verified'};
      }
    }
    entries.push(entry);onProgress({done:at+1,total:selected.length});if(at%32===31)await new Promise(resolve=>setTimeout(resolve,0));
  }
  // A previously checked note may change while a later note is being read. The
  // caller must likewise discard a result after an inventory/scope revision.
  for(const entry of entries){const verified=verifiedSources.get(entry.path);if(verified&&(verified.stamp!==stamp(verified.file)||(cache&&verified.version!==cache.version(entry.path)))){entry.status='Changed';entry.reason='source-changed';entry.semanticPending=false;}}
  check(signal);return aggregate(entries,removed,{index,builtAt:validDate(index?.builtAt),checkedAt:validDate(new Date(clock()).toISOString()),compatibility,reads,cacheHits});
}
