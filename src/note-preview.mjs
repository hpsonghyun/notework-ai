import {relativePath} from './archive-paths.mjs';

export const MAX_NOTE_PREVIEW_BYTES=5*1024*1024;
function fail(code,message){return Object.assign(new Error(message),{code});}
function stopped(signal){if(signal?.aborted)throw new DOMException('Note preview stopped.','AbortError');}
function stat(file){return {mtime:file.stat.mtime,size:file.stat.size};}
function validFile(file,path){return file&&file.path===path&&!Array.isArray(file.children)&&file.stat&&Number.isFinite(file.stat.mtime)&&file.stat.mtime>=0&&Number.isFinite(file.stat.size)&&file.stat.size>=0;}
function allowed(scopeFiles,path,isArchiveFile,file){
  let files;try{files=scopeFiles();if(isArchiveFile?.(file))return false;}catch{throw fail('PREVIEW_SCOPE_UNAVAILABLE','The current note scope is unavailable. Wait for Obsidian to finish indexing and try again.');}
  if(!Array.isArray(files))throw fail('PREVIEW_SCOPE_UNAVAILABLE','The current note scope is unavailable. Choose a note scope and try again.');
  return files.some(candidate=>candidate?.path===path);
}

/** Read the exact whole Markdown note locally; the caller decides how to display it. */
export async function readScopedNotePreview({vault,scopeFiles,path,isArchiveFile,signal}={}){
  stopped(signal);
  try{relativePath(path);}catch{throw fail('PREVIEW_INVALID_PATH','Choose a visible Markdown note inside the current vault.');}
  if(!vault||typeof vault.getAbstractFileByPath!=='function'||(typeof vault.read!=='function'&&typeof vault.cachedRead!=='function')||typeof scopeFiles!=='function')throw fail('PREVIEW_UNAVAILABLE','Note previews are unavailable in this vault. Open the source note in the editor.');
  let file;try{file=vault.getAbstractFileByPath(path);}catch{throw fail('PREVIEW_UNAVAILABLE','The source note is unavailable in this vault.');}
  if(!validFile(file,path))throw fail('PREVIEW_NOT_FOUND','The source note no longer exists. Refresh the knowledge view or open the current source note.');
  if(!allowed(scopeFiles,path,isArchiveFile,file))throw fail('PREVIEW_OUTSIDE_SCOPE','This note is outside the current scope. Choose an included note or update Scope in settings.');
  const before=stat(file);
  if(before.size>MAX_NOTE_PREVIEW_BYTES)throw fail('PREVIEW_TOO_LARGE','This note is larger than 5 MB. Open the source note in the editor to read it in full.');
  let content;try{content=await (vault.read?vault.read(file):vault.cachedRead(file));}catch{stopped(signal);throw fail('PREVIEW_READ_FAILED','Could not read the source note. Open it in the editor and try again.');}
  stopped(signal);
  let current;try{current=vault.getAbstractFileByPath(path);}catch{throw fail('PREVIEW_CHANGED','The source note changed while opening. Select it again to read the current version.');}
  if(!validFile(current,path)||current!==file||current.stat.mtime!==before.mtime||current.stat.size!==before.size)throw fail('PREVIEW_CHANGED','The source note changed or moved while opening. Select it again to read the current version.');
  if(!allowed(scopeFiles,path,isArchiveFile,current))throw fail('PREVIEW_OUTSIDE_SCOPE','This note left the current scope while opening. Select an included note.');
  if(typeof content!=='string')throw fail('PREVIEW_READ_FAILED','Could not read the Markdown source as text. Open the source note in the editor.');
  if(content.length>MAX_NOTE_PREVIEW_BYTES||new TextEncoder().encode(content).byteLength>MAX_NOTE_PREVIEW_BYTES)throw fail('PREVIEW_TOO_LARGE','This note is larger than 5 MB. Open the source note in the editor to read it in full.');
  stopped(signal);
  return {path,title:typeof current.basename==='string'&&current.basename?current.basename:path.split('/').at(-1).replace(/\.md$/i,''),content,mtime:before.mtime};
}
