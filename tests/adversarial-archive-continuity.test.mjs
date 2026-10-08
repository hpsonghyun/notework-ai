import test from 'node:test';
import assert from 'node:assert/strict';
import {ConnectionController} from '../src/controller.mjs';
import {ConversationArchive} from '../src/conversation-archive.mjs';

// Synthetic vault and providers only. No network or real Obsidian notes are used.
function fixture({metadata=true}={}) {
  const notes=new Map([['Research/source.md','alpha beta source evidence.']]);
  const files=new Map([['Research/source.md',{path:'Research/source.md',stat:{size:27,mtime:1}}]]);
  const folders=new Map(); const calls=[]; let ids=0;
  const vault={getMarkdownFiles:()=>[...files.values()],getAbstractFileByPath:path=>files.get(path)||folders.get(path),cachedRead:async file=>notes.get(file.path),read:async file=>notes.get(file.path),createFolder:async path=>folders.set(path,{path,children:[]}),create:async(path,text)=>{const file={path,stat:{size:Buffer.byteLength(text),mtime:1}};files.set(path,file);notes.set(path,text);return file;},process:async(file,fn)=>{notes.set(file.path,fn(notes.get(file.path)));return notes.get(file.path);}};
  const archive=new ConversationArchive({vault,idFactory:()=> 'synthetic-conversation-'+(++ids)});
  const provider={generate:async input=>{calls.push(input);return 'SYNTHETIC_PREVIOUS_ANSWER';}};
  const controller=new ConnectionController({providers:{chatgpt:provider},jev:{},secrets:{},vault,getTags:()=>[],isArchiveFile:metadata?(file=>notes.get(file.path)?.startsWith('---\nnotework-conversation: true\n')):undefined,settings:{mode:'chatgpt',scope:{include:['Research']}},saveSettings:async()=>{},archive});
  controller.set({model:'synthetic-model',models:[{id:'synthetic-model'}],authenticated:true,connection:'catalog-confirmed',verified:true});
  const ask=async draft=>{controller.set({draft,consent:true});await controller.ask();};
  return {controller,archive,calls,notes,ask};
}

test('saving a conversation inside the already excluded archive folder retains the actual chat context',async()=>{
  const f=fixture();await f.ask('alpha');const originalKey=f.controller.contextKey();await f.controller.saveConversation();
  assert.equal(f.controller.contextKey(),originalKey,'Metadata recognizing the saved archive must not change the retrieval boundary');
  await f.ask('beta');assert.ok(f.calls.at(-1).includes('SYNTHETIC_PREVIOUS_ANSWER'),'The next question should include the unchanged prior answer');
});

test('auto-save keeps prior user turns and answer lineage available on the second turn',async()=>{
  const f=fixture();await f.controller.setArchiveSettings({autoSave:true});await f.ask('alpha');await f.ask('beta');
  assert.ok(f.calls.at(-1).includes('SYNTHETIC_PREVIOUS_ANSWER'),'Saving after answer must retain continuity');
  assert.equal(f.controller.state.messages[0].contextKey,f.controller.state.messages[2].contextKey);
  assert.equal(f.controller.state.history.length,1);
});

test('sending the next question while the first manual save is pending updates one owned archive',async()=>{
  const f=fixture({metadata:false});await f.ask('alpha');
  const originalSave=f.archive.save.bind(f.archive);let release,started;const begun=new Promise(resolve=>started=resolve);
  f.archive.save=async snapshot=>{started();await new Promise(resolve=>release=resolve);return originalSave(snapshot);};
  const pending=f.controller.saveConversation();await begun;await f.ask('beta');release();await pending;f.archive.save=originalSave;
  await f.controller.saveConversation();
  assert.equal(f.controller.state.history.length,1,'The first save still belongs to the same conversation after another model operation');
  const loaded=await f.archive.load({path:f.controller.state.archivePath});assert.equal(loaded.messageCount,4);
});

test('starting New chat while a manual save is pending never applies the old identity to the new conversation',async()=>{
  const f=fixture({metadata:false});await f.ask('alpha');const originalSave=f.archive.save.bind(f.archive);
  let release,started;const begun=new Promise(resolve=>started=resolve);
  f.archive.save=async snapshot=>{started();await new Promise(resolve=>release=resolve);return originalSave(snapshot);};
  const pending=f.controller.saveConversation();await begun;f.controller.newConversation();await f.ask('beta');release();await pending;f.archive.save=originalSave;
  assert.equal(f.controller.state.activeConversationId,'');assert.equal(f.controller.state.messages.length,2);
  await f.controller.saveConversation();assert.equal(f.controller.state.history.length,2);
  const loaded=await f.archive.load({path:f.controller.state.archivePath});assert.equal(loaded.messages[0].content,'beta');assert.equal(loaded.messageCount,2);
});

test('two overlapping first saves in one conversation reuse the first successful archive identity',async()=>{
  const f=fixture({metadata:false});await f.ask('alpha');const saved=await Promise.all([f.controller.saveConversation(),f.controller.saveConversation()]);
  assert.equal(saved[0].id,saved[1].id);assert.equal(f.controller.state.history.length,1);
});

test('cancelling another operation while a manual save is pending retains archive ownership',async()=>{
  const f=fixture({metadata:false});await f.ask('alpha');const originalSave=f.archive.save.bind(f.archive);
  let release,started;const begun=new Promise(resolve=>started=resolve);
  f.archive.save=async snapshot=>{started();await new Promise(resolve=>release=resolve);return originalSave(snapshot);};
  const pending=f.controller.saveConversation();await begun;f.controller.stop();release();await pending;f.archive.save=originalSave;
  await f.controller.saveConversation();assert.equal(f.controller.state.history.length,1,'Stopping a model request does not start a new conversation');
});

test('archive records moved outside the configured folder remain excluded from transmission',async()=>{
  const f=fixture();await f.ask('alpha');await f.controller.setArchiveSettings({folder:'Other/History'});const saved=await f.controller.saveConversation();
  await f.controller.setArchiveSettings({folder:'Notework/Chats'});
  assert.ok(f.controller.effectiveScope().exclude.includes(saved.path));assert.ok(!f.controller.scopeFiles().some(file=>file.path===saved.path));
});
