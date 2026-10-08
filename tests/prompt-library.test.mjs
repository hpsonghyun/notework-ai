import test from 'node:test';
import assert from 'node:assert/strict';
import {PromptLibrary,normalizePromptFolder,isPromptLibraryPath,isPromptFrontmatter,PROMPT_LIBRARY_LIMITS} from '../src/prompt-library.mjs';

function fixture(options={}){
  const files=new Map(),contents=new Map(),calls=[],hooks={};let tick=0;
  const put=(path,raw)=>{const file=files.get(path)||{path,stat:{}};file.stat={mtime:++tick,size:Buffer.byteLength(raw)};files.set(path,file);contents.set(path,raw);return file;};
  const vault={adapter:{exists:async path=>files.has(path)},getMarkdownFiles:()=>[...files.values()].filter(file=>file.path.endsWith('.md')&&!file.children),getAbstractFileByPath:path=>files.get(path),
    read:async file=>{calls.push(['read',file.path]);await hooks.read?.(file);if(!contents.has(file.path))throw new Error('PRIVATE SOURCE ERROR');return contents.get(file.path);},
    createFolder:async path=>{calls.push(['folder',path]);if(files.has(path))throw new Error('Exists');files.set(path,{path,children:[]});},
    create:async(path,raw)=>{calls.push(['create',path]);await hooks.create?.(path,raw);if(files.has(path))throw new Error('Exists');return put(path,raw);},
    process:async(file,action)=>{calls.push(['process',file.path]);await hooks.process?.(file);const raw=action(contents.get(file.path));put(file.path,raw);return raw;},
    trash:async(file,system)=>{calls.push(['trash',file.path,system]);contents.delete(file.path);files.delete(file.path);},
    delete:async file=>{calls.push(['delete',file.path]);contents.delete(file.path);files.delete(file.path);}};
  return {vault,files,contents,calls,hooks,put,library:new PromptLibrary({vault,idFactory:()=> 'prompt-1',...options})};
}
const note=(title='Manual prompt',body='Exact manual body',extra='')=>'---\nnotework-prompt: true\ntitle: '+JSON.stringify(title)+'\n'+extra+'---\n'+body;

test('generated Markdown prompts roundtrip exact multilingual title and body and list contains metadata only',async()=>{
  const f=fixture(),title='  한국어 "title": 🧭  ',body='\n# User Markdown\n\n```js\nconst q = "a";\n```\n---\n{{notes}}\r\n\n';
  const saved=await f.library.save({title,body});assert.equal(saved.path,'Notework/Prompts/prompt-1.md');assert.equal(saved.title,title);assert.equal(saved.body,body);assert.match(f.contents.get(saved.path),/^---\nnotework-prompt: true\n/);
  assert.deepEqual(await f.library.read({path:saved.path}),saved);const listed=await f.library.list();assert.equal(listed.counts.valid,1);assert(!('body' in listed.items[0]));assert(!('text' in listed.items[0]));assert.equal(listed.items[0].revision,saved.revision);
});

test('unsafe folders and sibling or arbitrary note paths fail before any vault access',async()=>{
  const f=fixture();for(const folder of ['', '/Prompts','C:/Prompts','../Prompts','Notework/.obsidian','Notework\\Prompts','Notework/../Prompts','Notework/CON','Notework/folder.','Notework/%2e%2e',' Notework'])assert.throws(()=>normalizePromptFolder(folder),{code:'PROMPT_INVALID_PATH'});
  for(const path of ['Secret/note.md','Notework/PromptsOther/note.md','Notework/Prompts/../note.md','Notework/Prompts/a.json','Notework/Prompts/%2f.md']){assert.equal(isPromptLibraryPath(path),false);assert.throws(()=>f.library.read({path}),{code:'PROMPT_OUTSIDE_FOLDER'});assert.throws(()=>f.library.remove({path,revision:'a'.repeat(64)}),{code:'PROMPT_OUTSIDE_FOLDER'});}
  assert.deepEqual(f.calls,[]);assert.equal(isPromptFrontmatter({'notework-prompt':true}),true);assert.equal(isPromptFrontmatter({'notework-prompt':'true'}),false);
});

test('custom nested folders and manually created marked Markdown are discoverable after external edits',async()=>{
  const f=fixture({folder:'Templates/Reusable'});f.put('Templates/Reusable/sub/handwritten.md',note('Handwritten','  original\n'));
  const listed=await f.library.list();assert.equal(listed.items.length,1);const first=await f.library.read({path:listed.items[0].path});assert.match(first.id,/^manual_/);assert.equal(first.body,'  original\n');
  f.put(first.path,'---\r\nnotework-prompt: true\r\ntitle: \'Writer\'\'s prompt\'\r\n---\r\nnew exact\r\n');const refreshed=await f.library.list();assert.equal(refreshed.items[0].title,"Writer's prompt");assert.notEqual(refreshed.items[0].revision,first.revision);assert.equal((await f.library.read({path:first.path})).body,'new exact\r\n');
});

test('unmarked, malformed, oversized and unreadable notes produce only safe listing counts',async()=>{
  const f=fixture();f.put('Notework/Prompts/ordinary.md','PRIVATE ordinary note');f.put('Notework/Prompts/quoted.md','---\nnotework-prompt: "true"\n---\nPRIVATE invalid');f.put('Notework/Prompts/duplicate.md',note('Duplicate','PRIVATE invalid','notework-prompt: false\n'));f.put('Notework/Prompts/large.md',note('Large','🧭'.repeat(9000)));f.put('Notework/Prompts/unreadable.md',note());f.contents.delete('Notework/Prompts/unreadable.md');f.put('Notework/Prompts/okay.md',note());
  const listed=await f.library.list();assert.deepEqual(listed.counts,{valid:1,unmarked:1,invalid:2,unreadable:1,oversized:1});assert(!JSON.stringify(listed).includes('PRIVATE'));await assert.rejects(f.library.read({path:'Notework/Prompts/large.md'}),{code:'PROMPT_TOO_LARGE'});await assert.rejects(f.library.read({path:'Notework/Prompts/unreadable.md'}),{code:'PROMPT_READ_FAILED'});
});

test('unmarked existing notes and generated filename collisions are never overwritten',async()=>{
  const f=fixture();f.put('Notework/Prompts/prompt-1.md','user-owned ordinary note');const a=await f.library.save({title:'A',body:'first'}),b=await f.library.save({title:'B',body:'second'});assert.equal(a.id,'prompt-1-2');assert.equal(b.id,'prompt-1-3');assert.equal(f.contents.get('Notework/Prompts/prompt-1.md'),'user-owned ordinary note');
  await assert.rejects(f.library.update({path:'Notework/Prompts/prompt-1.md',title:'X',body:'X',revision:'a'.repeat(64)}),{code:'PROMPT_UNMARKED'});await assert.rejects(f.library.remove({path:'Notework/Prompts/prompt-1.md',revision:'a'.repeat(64)}),{code:'PROMPT_UNMARKED'});
});

test('creation races choose another filename without replacing a newly arrived note',async()=>{
  const f=fixture();f.hooks.create=path=>{if(path.endsWith('/prompt-1.md'))f.put(path,'external new note');};const saved=await f.library.save({title:'Mine',body:'my text'});assert.equal(saved.id,'prompt-1-2');assert.equal(f.contents.get('Notework/Prompts/prompt-1.md'),'external new note');
});

test('shared per-vault operation queue and required revisions prevent lost concurrent edits',async()=>{
  const f=fixture(),saved=await f.library.save({title:'First',body:'original'}),other=new PromptLibrary({vault:f.vault});
  const outcomes=await Promise.allSettled([f.library.update({...saved,title:'Edited',body:'first update'}),other.update({...saved,title:'Other',body:'second update'})]);assert.equal(outcomes[0].status,'fulfilled');assert.equal(outcomes[1].reason.code,'PROMPT_CHANGED');assert.equal((await other.read({path:saved.path})).body,'first update');assert.throws(()=>f.library.update({path:saved.path,title:'Missing revision',body:'x'}),{code:'PROMPT_REVISION_REQUIRED'});
});

test('manual changes before and inside vault.process keep the user note intact',async()=>{
  const f=fixture(),saved=await f.library.save({title:'First',body:'original'});f.put(saved.path,note('External','external text'));await assert.rejects(f.library.update({...saved,title:'Mine',body:'replacement'}),{code:'PROMPT_CHANGED'});assert.match(f.contents.get(saved.path),/external text$/);
  const fresh=await f.library.read({path:saved.path});f.hooks.process=file=>f.put(file.path,note('Last minute','manual change during process'));await assert.rejects(f.library.update({...fresh,title:'Mine',body:'replacement'}),{code:'PROMPT_CHANGED'});assert.match(f.contents.get(saved.path),/manual change during process$/);
});

test('safe update preserves the ID and requires atomic processing support',async()=>{
  const f=fixture(),saved=await f.library.save({title:'First',body:'original'});const updated=await f.library.update({...saved,title:'Updated',body:'\nnew Markdown\n'});assert.equal(updated.id,saved.id);assert.equal(updated.path,saved.path);assert.notEqual(updated.revision,saved.revision);assert.equal((await f.library.read({path:saved.path})).body,'\nnew Markdown\n');delete f.vault.process;await assert.rejects(f.library.update({...updated,title:'Unsafe',body:'x'}),{code:'PROMPT_UNSAFE_UPDATE'});
});

test('remove trashes only the validated unchanged library file and never a folder',async()=>{
  const f=fixture(),saved=await f.library.save({title:'Trash me',body:'text'});await assert.rejects(f.library.remove({...saved,revision:'a'.repeat(64)}),{code:'PROMPT_CHANGED'});assert.equal(f.files.has(saved.path),true);assert.deepEqual(await f.library.remove(saved),{path:saved.path,removed:true,trashed:true});assert.deepEqual(f.calls.at(-1),['trash',saved.path,true]);assert.equal(f.files.has('Notework/Prompts'),true);assert.throws(()=>f.library.remove({path:'Notework/Prompts',revision:saved.revision}),{code:'PROMPT_OUTSIDE_FOLDER'});
});

test('missing trash support refuses removal without any permanent delete fallback',async()=>{
  const f=fixture(),saved=await f.library.save({title:'Keep',body:'text'});delete f.vault.trash;await assert.rejects(f.library.remove(saved),{code:'PROMPT_REMOVE_UNAVAILABLE'});assert.equal(f.files.has(saved.path),true);assert.equal((await f.library.read({path:saved.path})).body,'text');assert(!f.calls.some(call=>['trash','delete'].includes(call[0])));
});

test('existing non-Markdown files are rejected before read, update or removal',async()=>{
  const f=fixture(),path='Notework/Prompts/marked.json';f.put(path,note());
  assert.equal(isPromptLibraryPath(path),false);assert.throws(()=>f.library.read({path}),{code:'PROMPT_OUTSIDE_FOLDER'});assert.throws(()=>f.library.update({path,title:'x',body:'x',revision:'a'.repeat(64)}),{code:'PROMPT_OUTSIDE_FOLDER'});assert.throws(()=>f.library.remove({path,revision:'a'.repeat(64)}),{code:'PROMPT_OUTSIDE_FOLDER'});assert.deepEqual(f.calls,[]);assert.equal((await f.library.list()).items.length,0);
});

test('a revision change after the first removal read is caught by the final trash check',async()=>{
  const f=fixture(),saved=await f.library.save({title:'Keep',body:'original'});let reads=0;
  f.vault.read=async file=>{const raw=f.contents.get(file.path);if(++reads===1)f.put(file.path,note('External edit','keep this new body'));return raw;};
  await assert.rejects(f.library.remove(saved),{code:'PROMPT_CHANGED'});assert.equal(reads,2);assert.match(f.contents.get(saved.path),/keep this new body$/);assert(!f.calls.some(call=>['trash','delete'].includes(call[0])));
});

test('UTF-8 bounds include frontmatter and reject invalid drafts before writing',async()=>{
  const f=fixture();assert.throws(()=>f.library.save({title:'x',body:'🧭'.repeat(8193)}),{code:'PROMPT_TOO_LARGE'});await assert.rejects(f.library.save({title:'x',body:'x'.repeat(PROMPT_LIBRARY_LIMITS.maxNoteBytes)}),{code:'PROMPT_TOO_LARGE'});assert.throws(()=>f.library.save({title:'🧭'.repeat(257),body:'x'}),{code:'PROMPT_INVALID_DATA'});assert.throws(()=>f.library.save({title:'bad\nkey',body:'x'}),{code:'PROMPT_INVALID_DATA'});assert.throws(()=>f.library.save({title:'x',body:'  '}),{code:'PROMPT_INVALID_DATA'});assert(!f.calls.some(call=>call[0]==='create'));
});

test('100 prompt limit is enforced without dropping existing records or reading outside the library',async()=>{
  const f=fixture();for(let i=0;i<100;i++)f.put('Notework/Prompts/p'+i+'.md',note('Prompt '+i,'body '+i));f.put('Other/private.md','private');assert.equal((await f.library.list()).items.length,100);await assert.rejects(f.library.save({title:'Over limit',body:'x'}),{code:'PROMPT_LIBRARY_FULL'});assert(!f.calls.some(call=>call[1]==='Other/private.md'));f.put('Notework/Prompts/extra.md',note('Extra','x'));assert.equal((await f.library.list()).truncated,true);
});

test('blocked folders, removed and moved files fail without replacing user data',async()=>{
  const f=fixture();f.put('Notework','blocking ordinary note');await assert.rejects(f.library.save({title:'x',body:'x'}),{code:'PROMPT_FOLDER_BLOCKED'});assert.equal(f.contents.get('Notework'),'blocking ordinary note');
  const g=fixture(),saved=await g.library.save({title:'x',body:'x'});g.hooks.read=file=>{file.path='Outside/moved.md';};await assert.rejects(g.library.read({path:saved.path}),{code:'PROMPT_READ_FAILED'});assert(!g.calls.some(call=>['trash','delete','process'].includes(call[0])));
});
