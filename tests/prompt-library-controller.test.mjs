import test from 'node:test';
import assert from 'node:assert/strict';
import {ConnectionController} from '../src/controller.mjs';
import {PromptLibrary} from '../src/prompt-library.mjs';
import {ConversationArchive} from '../src/conversation-archive.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
function fixture(){
  const files=new Map(),contents=new Map(),writes=[],requests=[],hooks={};let serial=0,tick=0;
  const put=(path,body)=>{const file=files.get(path)||{path,extension:path.split('.').at(-1)};file.stat={mtime:++tick,size:Buffer.byteLength(body)};files.set(path,file);contents.set(path,body);return file;};
  const vault={getMarkdownFiles:()=>[...files.values()].filter(file=>file.extension==='md'),getAbstractFileByPath:path=>files.get(path),
    read:async file=>{await hooks.read?.(file);return contents.get(file.path);},cachedRead:async file=>contents.get(file.path),
    createFolder:async path=>files.set(path,{path,children:[]}),create:async(path,body)=>{if(files.has(path))throw Error('Exists');return put(path,body);},
    process:async(file,fn)=>put(file.path,fn(contents.get(file.path))),trash:async file=>{files.delete(file.path);contents.delete(file.path);},
    adapter:{exists:async path=>files.has(path)}};
  const promptLibrary=new PromptLibrary({vault,idFactory:()=> 'prompt-'+(++serial)});
  const controller=new ConnectionController({providers:{chatgpt:{generate:async input=>{requests.push(input);return 'Synthetic answer';}}},secrets:{},jev:{},vault,
    promptLibrary,isPromptFile:file=>contents.get(file.path)?.includes('notework-prompt: true'),isArchiveFile:file=>contents.get(file.path)?.includes('notework-conversation: true'),
    archive:new ConversationArchive({vault}),settings:{mode:'chatgpt',scope:{mode:'all',include:[],exclude:[]},archive:{folder:'Saved/Conversations'}},saveSettings:async settings=>{await hooks.persist?.();writes.push(structuredClone(settings));}});
  return {controller,promptLibrary,vault,files,contents,writes,requests,hooks,put};
}
test('prompt CRUD is local, exact, refreshable and excludes bodies from controller settings/catalog',async()=>{
  const f=fixture(),c=f.controller;const body='\n# Reusable\n  {{notes}}\n';
  const saved=await c.savePrompt({title:'Review notes',text:body});assert.equal(saved.text,body);assert.equal(saved.body,body);
  assert.equal(c.state.promptLibrary.items.length,1);assert(!('body' in c.state.promptLibrary.items[0]));assert(!('text' in c.state.promptLibrary.items[0]));
  assert.equal((await c.readPrompt(saved.id)).text,body);const edited=await c.savePrompt({id:saved.id,title:'Review better',text:'updated',revision:saved.revision});assert.equal(edited.text,'updated');
  f.put(edited.path,f.contents.get(edited.path).replace('updated','manual edit'));await c.refreshPromptLibrary();assert.equal((await c.readPrompt(saved.id)).text,'manual edit');
  await c.persist();assert.equal(f.writes.at(-1).prompts.folder,'Notework/Prompts');assert(!JSON.stringify(f.writes).includes('manual edit'));assert.deepEqual(f.requests,[]);
  const record=await c.readPrompt(saved.id);assert.equal((await c.deletePrompt(record)).removed,true);assert.equal(c.state.promptLibrary.items.length,0);
});
test('use fills or inserts exact text into a draft and never submits or mutates existing answer/history',async()=>{
  const f=fixture(),c=f.controller,p=await c.savePrompt({title:'Draft',text:'Saved prompt'});c.set({answer:'Existing answer',messages:[{role:'user',content:'Before',id:'u1'}],draft:''});
  assert.deepEqual(await c.usePrompt({id:p.id,revision:p.revision,mode:'replace',expectedDraft:''}),{draft:'Saved prompt'});
  c.set({draft:'Original question'});await c.usePrompt({id:p.id,revision:p.revision,mode:'insert',expectedDraft:'Original question'});assert.equal(c.state.draft,'Original question\n\nSaved prompt');
  assert.equal(c.state.answer,'Existing answer');assert.equal(c.state.messages[0].content,'Before');assert.deepEqual(f.requests,[]);
});
test('prompt Use refuses stale draft, new chat, changed file and a chat started during read',async()=>{
  for(const change of ['draft','owner','file','busy']){
    const f=fixture(),c=f.controller,p=await c.savePrompt({title:'Saved',text:'Saved text'}),gate=deferred();c.set({draft:'Original'});f.hooks.read=()=>gate.promise;
    const use=c.usePrompt({id:p.id,revision:p.revision,mode:'replace',expectedDraft:'Original'});
    await Promise.resolve();await Promise.resolve();
    if(change==='draft')c.set({draft:'Newly typed'});if(change==='owner')c.conversationOwner={id:'new'};if(change==='file')f.put(p.path,f.contents.get(p.path).replace('Saved text','Externally edited'));if(change==='busy')c.set({busy:true});
    gate.resolve();assert.equal(await use,undefined);assert.equal(c.state.draft,change==='draft'?'Newly typed':'Original');assert.equal(c.state.promptLibrary.statusKind,'error');assert.deepEqual(f.requests,[]);
  }
});
test('local prompt operations do not cancel authentication/chat or advance its epoch',async()=>{
  const f=fixture(),c=f.controller,p=await c.savePrompt({title:'A',text:'Text'}),epoch=c.epoch;c.set({busy:true});
  assert.equal(await c.readPrompt(p.id),undefined);assert.equal(await c.savePrompt({title:'B',text:'B'}),undefined);assert.equal(await c.refreshPromptLibrary(),undefined);
  assert.equal(c.state.busy,true);assert.equal(c.epoch,epoch);c.set({busy:false});await c.readPrompt(p.id);assert.equal(c.epoch,epoch);
});
test('closing the originating prompt library during read prevents late draft insertion',async()=>{
  const f=fixture(),c=f.controller,p=await c.savePrompt({title:'Close while loading',text:'Saved text'}),gate=deferred();let open=true;c.set({draft:'Existing draft'});f.hooks.read=()=>gate.promise;
  const use=c.usePrompt({id:p.id,revision:p.revision,mode:'replace',expectedDraft:'Existing draft',canApply:()=>open});open=false;gate.resolve();assert.equal(await use,undefined);assert.equal(c.state.draft,'Existing draft');assert.equal(c.state.promptLibrary.busy,false);
});
test('a prompt update conflict preserves the note and existing chat draft',async()=>{
  const f=fixture(),c=f.controller,p=await c.savePrompt({title:'A',text:'Saved'});c.set({draft:'Keep typed draft'});f.put(p.path,f.contents.get(p.path).replace('Saved','Edited externally'));
  assert.equal(await c.savePrompt({id:p.id,title:'A',text:'Stale edit',revision:p.revision}),undefined);assert.equal(c.state.promptLibrary.statusKind,'error');assert.match(f.contents.get(p.path),/Edited externally/);assert.equal(c.state.draft,'Keep typed draft');
});
test('prompt catalog refresh failure after successful create returns saved record to avoid duplicate retries',async()=>{
  const f=fixture(),c=f.controller,original=f.promptLibrary.list.bind(f.promptLibrary);f.promptLibrary.list=async()=>{throw Error('Read unavailable');};
  const p=await c.savePrompt({title:'Still saved',text:'Local body'});assert(p?.revision);assert.equal(c.state.promptLibrary.items.length,1);assert(!('body' in c.state.promptLibrary.items[0]));assert.match(c.state.promptLibrary.status,/was saved/);
  f.promptLibrary.list=original;await c.refreshPromptLibrary();assert.equal(c.state.promptLibrary.items.length,1);
});
test('configured prompt folder persists, excludes retrieval, leaves files and rolls back invalid/failed settings',async()=>{
  const f=fixture(),c=f.controller,p=await c.savePrompt({title:'Keep file',text:'Prompt text'});f.put('Notes/normal.md','ordinary knowledge');
  assert.deepEqual(c.scopeFiles().map(file=>file.path),['Notes/normal.md']);assert.equal((await c.setPromptLibraryFolder('Templates/Reusable')).folder,'Templates/Reusable');assert.equal(c.state.promptLibrary.busy,false);assert(f.files.has(p.path));assert.equal(f.writes.at(-1).prompts.folder,'Templates/Reusable');
  f.put('Templates/Reusable/ordinary.md','unmarked text');f.put('Moved/manual.md','---\nnotework-prompt: true\n---\nMoved template');
  assert.deepEqual(c.scopeFiles().map(file=>file.path),['Notes/normal.md']);assert.equal(await c.setPromptLibraryFolder('../Outside'),undefined);assert.equal(c.settings.prompts.folder,'Templates/Reusable');
  f.hooks.persist=()=>{throw Error('Settings write failed');};assert.equal(await c.setPromptLibraryFolder('Failed/Folder'),undefined);assert.equal(c.settings.prompts.folder,'Templates/Reusable');assert.equal(c.state.promptLibrary.busy,false);assert.equal(c.state.promptLibrary.statusKind,'error');
});
test('archive icon action saves directly to configured conversation folder and never into the prompt folder',async()=>{
  const f=fixture(),c=f.controller;c.set({messages:[{id:'u1',role:'user',content:'Synthetic question',contextKey:'fixture'},{id:'a1',role:'assistant',content:'**Synthetic answer**',sources:[],contextKey:'fixture'}]});
  await c.saveConversation();assert(c.state.archivePath.startsWith('Saved/Conversations/'));assert(!c.state.archivePath.startsWith('Notework/Prompts/'));const saved=await c.archive.load({path:c.state.archivePath,folder:c.settings.archive.folder});assert.equal(saved.messages[1].content,'**Synthetic answer**');assert.match(c.state.archiveStatus,/Conversation saved to/);assert.deepEqual(f.requests,[]);
});
test('disposed controller never publishes late library reads',async()=>{
  const f=fixture(),c=f.controller,p=await c.savePrompt({title:'Late',text:'Late prompt'}),gate=deferred();f.hooks.read=()=>gate.promise;const reading=c.readPrompt(p.id);c.dispose();gate.resolve();assert.equal(await reading,undefined);
});
test('source validation rejects prompt metadata added during a source read before model transmission',async()=>{
  const f=fixture(),c=f.controller,file=f.put('Notes/changed.md','Ordinary text initially'),scope=c.effectiveScope();let marked=false;
  c.isPromptFile=()=>marked;f.vault.read=async()=>{marked=true;return 'Prompt body introduced during read';};
  assert.equal(await c.readCurrentSource(file.path,scope),null);assert.deepEqual(f.requests,[]);
});
