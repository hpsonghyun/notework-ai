import {hasAsciiControl} from './text-safety.mjs';
import {sha256HexSync,randomUUID,utf8ByteLength} from './portable-crypto.mjs';
import {relativePath} from './archive-paths.mjs';

export const DEFAULT_PROMPT_FOLDER='Notework/Prompts';
export const PROMPT_LIBRARY_LIMITS=Object.freeze({maxPrompts:100,maxNoteBytes:32768,maxTitleBytes:1024,maxFiles:1000});
const queues=new WeakMap(),ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const fail=(code,message)=>Object.assign(new Error(message),{code});
export function normalizePromptFolder(value=DEFAULT_PROMPT_FOLDER){try{if(typeof value==='string'&&/%[0-9a-f]{2}/i.test(value))throw new Error();return relativePath(value,{folder:true});}catch{throw fail('PROMPT_INVALID_PATH','Choose a visible folder inside the current vault.');}}
export function isPromptLibraryPath(path,folder=DEFAULT_PROMPT_FOLDER){try{return !/%[0-9a-f]{2}/i.test(path)&&relativePath(path).startsWith(normalizePromptFolder(folder)+'/');}catch{return false;}}
export function isPromptFrontmatter(value){return value!==null&&typeof value==='object'&&!Array.isArray(value)&&value['notework-prompt']===true;}
function pathInFolder(path,folder){if(!isPromptLibraryPath(path,folder))throw fail('PROMPT_OUTSIDE_FOLDER','Choose a Markdown prompt inside the configured prompt folder.');return path;}
function data(title,body){
  if(typeof title!=='string'||!title.trim()||utf8ByteLength(title)>PROMPT_LIBRARY_LIMITS.maxTitleBytes||hasAsciiControl(title))throw fail('PROMPT_INVALID_DATA','Enter a prompt title of up to 1,024 UTF-8 bytes without control characters.');
  if(typeof body!=='string'||!body.trim()||hasAsciiControl(body,{allowTextWhitespace:true}))throw fail('PROMPT_INVALID_DATA','Enter a nonempty prompt using ordinary text or Markdown.');
  if(utf8ByteLength(body)>PROMPT_LIBRARY_LIMITS.maxNoteBytes)throw fail('PROMPT_TOO_LARGE','A saved prompt must fit within 32 KiB, including its frontmatter.');
  return {title,body};
}
function scalar(value){
  if(value.startsWith('"')){try{const parsed=JSON.parse(value);if(typeof parsed==='string')return parsed;}catch{/* The invalid quoted title is rejected immediately below. */}throw fail('PROMPT_INVALID_NOTE','The prompt title has invalid quoting.');}
  if(value.startsWith("'")){if(!value.endsWith("'")||value.length<2||/(?:^|[^'])'(?:[^']|$)/.test(value.slice(1,-1)))throw fail('PROMPT_INVALID_NOTE','The prompt title has invalid quoting.');return value.slice(1,-1).replace(/''/g,"'");}
  if(!value||/^[>|[\]{&*!]/.test(value)||/\s#|:\s/.test(value))throw fail('PROMPT_INVALID_NOTE','Use a plain or quoted frontmatter title for this prompt.');
  return value;
}
function parse(raw,path){
  if(typeof raw!=='string')throw fail('PROMPT_READ_FAILED','Could not read this prompt.');
  if(utf8ByteLength(raw)>PROMPT_LIBRARY_LIMITS.maxNoteBytes)throw fail('PROMPT_TOO_LARGE','This prompt exceeds the 32 KiB limit. Shorten the Markdown note before using it.');
  const header=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if(!header)throw fail('PROMPT_UNMARKED','This Markdown note is not a marked Notework prompt.');
  const fields=new Map();
  for(const line of header[1].split(/\r?\n/)){
    const match=/^(notework-prompt|notework-prompt-id|title):\s*(.*?)\s*$/.exec(line);
    if(/^\s*["']?(?:notework-prompt(?:-id)?|title)["']?\s*:/.test(line)&&!match)throw fail('PROMPT_INVALID_NOTE','Use unindented, unquoted prompt frontmatter field names.');
    if(!match)continue;
    if(fields.has(match[1]))throw fail('PROMPT_INVALID_NOTE','This prompt has duplicate frontmatter fields.');fields.set(match[1],match[2]);
  }
  if(!fields.has('notework-prompt'))throw fail('PROMPT_UNMARKED','This Markdown note is not a marked Notework prompt.');
  if(fields.get('notework-prompt')!=='true')throw fail('PROMPT_INVALID_NOTE','The notework-prompt marker must be the Boolean true.');
  const title=fields.has('title')?scalar(fields.get('title')):path.split('/').at(-1).slice(0,-3);
  const id=fields.has('notework-prompt-id')?scalar(fields.get('notework-prompt-id')):'manual_'+sha256HexSync(path).slice(0,24);
  if(!ID.test(id))throw fail('PROMPT_INVALID_NOTE','This prompt has an invalid ID.');
  const body=raw.slice(header[0].length);data(title,body);
  return {id,title,body,revision:sha256HexSync(raw),bytes:utf8ByteLength(raw)};
}
function serialize({id,title,body}){const raw='---\nnotework-prompt: true\nnotework-prompt-id: '+JSON.stringify(id)+'\ntitle: '+JSON.stringify(title)+'\n---\n'+body;if(utf8ByteLength(raw)>PROMPT_LIBRARY_LIMITS.maxNoteBytes)throw fail('PROMPT_TOO_LARGE','A saved prompt must fit within 32 KiB, including its frontmatter.');return raw;}
function metadata(doc,file){return {id:doc.id,path:file.path,title:doc.title,revision:doc.revision,bytes:doc.bytes,mtime:Number.isFinite(file.stat?.mtime)?file.stat.mtime:0};}
function revision(value){if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw fail('PROMPT_REVISION_REQUIRED','Reload this prompt before updating or removing it.');return value;}

/** Vault Markdown only. No provider requests or automatic submission of prompt text. */
export class PromptLibrary{
  constructor({vault,folder=DEFAULT_PROMPT_FOLDER,idFactory=randomUUID}={}){
    if(!vault||typeof vault.getMarkdownFiles!=='function'||typeof vault.getAbstractFileByPath!=='function'||typeof vault.read!=='function')throw fail('PROMPT_VAULT_REQUIRED','Use the current vault to manage saved prompts.');
    this.vault=vault;this.configuredFolder=normalizePromptFolder(folder);this.idFactory=idFactory;
  }
  serial(action){const previous=queues.get(this.vault)||Promise.resolve();const result=previous.catch(()=>{}).then(action);queues.set(this.vault,result.catch(()=>{}));return result;}
  folder(value){return normalizePromptFolder(value===undefined?this.configuredFolder:value);}
  candidates(folder){return this.vault.getMarkdownFiles().filter(file=>isPromptLibraryPath(file.path,folder)).sort((a,b)=>a.path.localeCompare(b.path));}
  async document(path,folder){
    pathInFolder(path,folder);const file=this.vault.getAbstractFileByPath(path);
    if(!file||Array.isArray(file.children))throw fail('PROMPT_NOT_FOUND','The saved prompt is no longer available. Refresh the prompt library.');
    if(file.stat?.size>PROMPT_LIBRARY_LIMITS.maxNoteBytes)throw fail('PROMPT_TOO_LARGE','This prompt exceeds the 32 KiB limit. Shorten the Markdown note before using it.');
    let raw;try{raw=await this.vault.read(file);}catch{throw fail('PROMPT_READ_FAILED','Could not read this prompt. Refresh the library or check the note in the vault.');}
    if(file.path!==path||this.vault.getAbstractFileByPath(path)!==file)throw fail('PROMPT_CHANGED','The prompt moved while being read. Refresh the library.');
    return {file,raw,doc:parse(raw,path)};
  }
  async listing(folder){
    const candidates=this.candidates(folder),items=[],counts={valid:0,unmarked:0,invalid:0,unreadable:0,oversized:0},seen=new Set();
    for(const file of candidates.slice(0,PROMPT_LIBRARY_LIMITS.maxFiles)){
      try{const {doc}=await this.document(file.path,folder);if(seen.has(doc.id)){counts.invalid++;continue;}seen.add(doc.id);counts.valid++;if(items.length<PROMPT_LIBRARY_LIMITS.maxPrompts)items.push(metadata(doc,file));}
      catch(error){if(error?.code==='PROMPT_UNMARKED')counts.unmarked++;else if(error?.code==='PROMPT_TOO_LARGE')counts.oversized++;else if(['PROMPT_READ_FAILED','PROMPT_NOT_FOUND','PROMPT_CHANGED'].includes(error?.code))counts.unreadable++;else counts.invalid++;}
    }
    items.sort((a,b)=>b.mtime-a.mtime||a.path.localeCompare(b.path));
    return {items,counts,truncated:candidates.length>PROMPT_LIBRARY_LIMITS.maxFiles||counts.valid>PROMPT_LIBRARY_LIMITS.maxPrompts};
  }
  list({folder}={}){const target=this.folder(folder);return this.serial(()=>this.listing(target));}
  read({path,folder}={}){const target=this.folder(folder);pathInFolder(path,target);return this.serial(async()=>{const {file,doc}=await this.document(path,target);return {...metadata(doc,file),body:doc.body};});}
  async ensureFolder(folder){
    let current='';for(const part of folder.split('/')){
      current=current?current+'/'+part:part;const existing=this.vault.getAbstractFileByPath(current);
      if(existing){if(!Array.isArray(existing.children))throw fail('PROMPT_FOLDER_BLOCKED','A note is blocking the prompt folder. Choose another folder.');continue;}
      if(typeof this.vault.createFolder!=='function')throw fail('PROMPT_FOLDER_UNAVAILABLE','This vault cannot create the prompt folder.');
      try{await this.vault.createFolder(current);}catch{if(!Array.isArray(this.vault.getAbstractFileByPath(current)?.children))throw fail('PROMPT_SAVE_FAILED','Could not create the prompt folder.');}
    }
  }
  save({title,body,folder}={}){
    const input=data(title,body),target=this.folder(folder);return this.serial(async()=>{
      const library=await this.listing(target);if(library.truncated||library.counts.valid>=PROMPT_LIBRARY_LIMITS.maxPrompts)throw fail('PROMPT_LIBRARY_FULL','The prompt library supports up to 100 prompts. Remove a prompt before saving another.');
      if(typeof this.vault.create!=='function')throw fail('PROMPT_SAVE_FAILED','This vault cannot create prompt notes.');
      const generated=this.idFactory();if(typeof generated!=='string'||!ID.test(generated))throw fail('PROMPT_INVALID_ID','Could not generate a valid prompt ID.');
      await this.ensureFolder(target);const ids=new Set(library.items.map(item=>item.id));
      for(let attempt=0;attempt<1000;attempt++){
        const id=attempt?generated.slice(0,90)+'-'+(attempt+1):generated,path=target+'/'+id+'.md';
        if(ids.has(id)||this.vault.getAbstractFileByPath(path)||await this.vault.adapter?.exists?.(path))continue;
        const raw=serialize({id,...input});let file;
        try{file=await this.vault.create(path,raw);}catch{if(this.vault.getAbstractFileByPath(path)||await this.vault.adapter?.exists?.(path))continue;throw fail('PROMPT_SAVE_FAILED','Could not save this prompt. The draft remains available.');}
        return {...metadata(parse(raw,path),file),body:input.body};
      }
      throw fail('PROMPT_NAME_COLLISION','Could not choose a unique prompt filename.');
    });
  }
  update({path,title,body,revision:expected,folder}={}){
    const input=data(title,body),target=this.folder(folder);pathInFolder(path,target);revision(expected);
    return this.serial(async()=>{
      const {file,doc}=await this.document(path,target);if(doc.revision!==expected)throw fail('PROMPT_CHANGED','This prompt changed. Reload it before saving your edits.');
      if(typeof this.vault.process!=='function')throw fail('PROMPT_UNSAFE_UPDATE','This vault cannot safely update prompt notes.');
      const raw=serialize({id:doc.id,...input});
      try{await this.vault.process(file,current=>{if(file.path!==path||this.vault.getAbstractFileByPath(path)!==file)throw fail('PROMPT_CHANGED','This prompt moved. Reload it before saving.');const latest=parse(current,path);if(latest.revision!==expected)throw fail('PROMPT_CHANGED','This prompt changed. Reload it before saving your edits.');return raw;});}
      catch(error){if(String(error?.code||'').startsWith('PROMPT_'))throw error;throw fail('PROMPT_SAVE_FAILED','Could not update this prompt. Your edits remain available.');}
      return {...metadata(parse(raw,path),file),body:input.body};
    });
  }
  remove({path,revision:expected,folder}={}){
    const target=this.folder(folder);pathInFolder(path,target);revision(expected);
    return this.serial(async()=>{
      const {file,doc}=await this.document(path,target);if(doc.revision!==expected)throw fail('PROMPT_CHANGED','This prompt changed. Reload it before removing it.');
      if(typeof this.vault.trash!=='function')throw fail('PROMPT_REMOVE_UNAVAILABLE','This vault cannot move prompt notes to the trash. Remove the note through your vault instead.');
      // Recheck immediately before trashing. The host has no atomic compare-and-
      // trash API, so this catches intervening edits without claiming such a lock.
      const latest=await this.document(path,target);if(latest.file!==file||latest.doc.revision!==expected)throw fail('PROMPT_CHANGED','This prompt changed. Reload it before removing it.');
      try{await this.vault.trash(file,true);}catch{throw fail('PROMPT_REMOVE_FAILED','Could not remove this prompt. Refresh the library and try again.');}
      return {path,removed:true,trashed:true};
    });
  }
}
