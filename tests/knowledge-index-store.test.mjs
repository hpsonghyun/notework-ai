import test from 'node:test';
import assert from 'node:assert/strict';
import {KnowledgeIndexStore} from '../src/runtime-storage.mjs';

const DIR='.obsidian/plugins/notework-ai';
const TARGET=DIR+'/knowledge-index.json';
const PENDING=TARGET+'.pending';
const PREVIOUS=TARGET+'.previous';
const index=id=>({schema:1,id,nodes:[],chunks:[],categories:[],scope:{mode:'all'}});

// Obsidian's DataAdapter contract: rename fails if its destination exists.
// Mutations are restricted to the three known private cache files.
function strictAdapter(initial=[]) {
  const values=new Map(initial),mutations=[],hooks={before:null,after:null};
  const allowed=new Set([TARGET,PENDING,PREVIOUS,DIR+'/knowledge-index-mobile.json',DIR+'/knowledge-index-mobile.json.pending',DIR+'/knowledge-index-mobile.json.previous']);
  const mutate=async(event,action)=>{
    for(const path of [event.path,event.from,event.to].filter(Boolean))assert.ok(allowed.has(path),'Only known plugin cache files may be mutated.');
    mutations.push(event);
    await hooks.before?.(event);
    const result=action();
    await hooks.after?.(event);
    return result;
  };
  const adapter={
    exists:async path=>values.has(path),
    read:async path=>{if(!values.has(path))throw new Error('File does not exist.');return values.get(path);},
    write:async(path,text)=>mutate({kind:'write',path},()=>values.set(path,text)),
    rename:async(from,to)=>mutate({kind:'rename',from,to},()=>{
      if(values.has(to))throw new Error('Destination file already exists!');
      if(!values.has(from))throw new Error('Source file does not exist.');
      values.set(to,values.get(from));values.delete(from);
    }),
    remove:async path=>mutate({kind:'remove',path},()=>{if(!values.delete(path))throw new Error('File does not exist.');})
  };
  const store=new KnowledgeIndexStore({adapter,directory:DIR});
  return {adapter,values,mutations,hooks,store};
}

test('strict adapter reproduces the native failure when renaming onto an existing cache',async()=>{
  const h=strictAdapter([[TARGET,JSON.stringify(index('old'))],[PENDING,JSON.stringify(index('new'))]]);
  await assert.rejects(h.adapter.rename(PENDING,TARGET),/Destination file already exists!/);
  assert.equal(JSON.parse(h.values.get(TARGET)).id,'old');
});

test('initial save commits to an absent destination and leaves no staged files',async()=>{
  const h=strictAdapter();
  await h.store.save(index('first'));
  assert.equal((await h.store.load()).id,'first');
  assert.deepEqual([...h.values.keys()],[TARGET]);
  assert.deepEqual(h.mutations.map(event=>event.kind),['write','rename']);
});

test('repeated saves protect the previous cache and replace without rename overwrite',async()=>{
  const h=strictAdapter();
  await h.store.save(index('first'));
  await h.store.save(index('second'));
  await h.store.save(index('third'));
  assert.equal((await h.store.load()).id,'third');
  assert.deepEqual([...h.values.keys()],[TARGET]);
  assert.deepEqual(h.mutations.slice(2,6).map(event=>[event.kind,event.path??event.from,event.to]),[
    ['write',PENDING,undefined],['rename',TARGET,PREVIOUS],['rename',PENDING,TARGET],['remove',PREVIOUS,undefined]
  ]);
});

test('a failed second rename restores the old bytes and a later load cannot adopt the failed save',async()=>{
  const oldRaw='\n'+JSON.stringify(index('old'))+'\n';
  const h=strictAdapter([[TARGET,oldRaw]]);
  h.hooks.before=event=>{if(event.kind==='rename'&&event.from===PENDING)throw new Error('Replacement rename failed.');};
  await assert.rejects(h.store.save(index('failed')),/Replacement rename failed/);
  assert.equal(h.values.get(TARGET),oldRaw);
  assert.equal((await h.store.load()).id,'old');
  assert.ok(!h.values.has(PREVIOUS)&&!h.values.has(PENDING));
  h.hooks.before=null;
  await h.store.save(index('retry'));
  assert.equal((await h.store.load()).id,'retry');
});

test('a rename that changes the target before rejecting still rolls back',async()=>{
  const oldRaw=JSON.stringify(index('old')),h=strictAdapter([[TARGET,oldRaw]]);
  h.hooks.after=event=>{if(event.kind==='rename'&&event.from===PENDING)throw new Error('Rename completion failed.');};
  await assert.rejects(h.store.save(index('uncommitted')),/Rename completion failed/);
  assert.equal(h.values.get(TARGET),oldRaw);
  assert.equal((await h.store.load()).id,'old');
  assert.deepEqual([...h.values.keys()],[TARGET]);
});

for(const phase of ['staging','old rename','new rename','backup cleanup']) {
  test('cancellation during '+phase+' restores the previous cache',async()=>{
    const oldRaw=JSON.stringify(index('old')),h=strictAdapter([[TARGET,oldRaw]]),abort=new AbortController();
    h.hooks.after=event=>{
      if((phase==='staging'&&event.kind==='write'&&event.path===PENDING)||
        (phase==='old rename'&&event.kind==='rename'&&event.from===TARGET)||
        (phase==='new rename'&&event.kind==='rename'&&event.from===PENDING)||
        (phase==='backup cleanup'&&event.kind==='remove'&&event.path===PREVIOUS))abort.abort();
    };
    await assert.rejects(h.store.save(index('cancelled'),{signal:abort.signal}),error=>error.name==='AbortError');
    assert.equal(h.values.get(TARGET),oldRaw);
    assert.equal((await h.store.load()).id,'old');
    assert.deepEqual([...h.values.keys()],[TARGET]);
  });
}

test('cancelling the first save after rename removes its uncommitted target',async()=>{
  const h=strictAdapter(),abort=new AbortController();
  h.hooks.after=event=>{if(event.kind==='rename'&&event.from===PENDING)abort.abort();};
  await assert.rejects(h.store.save(index('cancelled'),{signal:abort.signal}),error=>error.name==='AbortError');
  assert.equal(await h.store.load(),null);
  assert.equal(h.values.size,0);
});

test('backup cleanup failure rejects and restores old cache instead of committing a failed save',async()=>{
  const oldRaw=JSON.stringify(index('old')),h=strictAdapter([[TARGET,oldRaw]]);
  h.hooks.before=event=>{if(event.kind==='remove'&&event.path===PREVIOUS)throw new Error('Backup cleanup failed.');};
  await assert.rejects(h.store.save(index('failed')),/Backup cleanup failed/);
  assert.equal(h.values.get(TARGET),oldRaw);
  assert.equal((await h.store.load()).id,'old');
  assert.deepEqual([...h.values.keys()],[TARGET]);
});

test('load recovers a crash between the old and new renames',async()=>{
  const oldRaw=JSON.stringify(index('old')),h=strictAdapter([[PREVIOUS,oldRaw],[PENDING,JSON.stringify(index('abandoned'))]]);
  assert.equal((await h.store.load()).id,'old');
  assert.equal(h.values.get(TARGET),oldRaw);
  assert.deepEqual([...h.values.keys()],[TARGET]);
});

test('load recovers an uncommitted new target when its previous backup remains',async()=>{
  const oldRaw=JSON.stringify(index('old')),h=strictAdapter([[TARGET,JSON.stringify(index('uncommitted'))],[PREVIOUS,oldRaw]]);
  assert.equal((await h.store.load()).id,'old');
  assert.equal(h.values.get(TARGET),oldRaw);
  assert.deepEqual([...h.values.keys()],[TARGET]);
});

test('a staged cache without a previous backup is never adopted by load',async()=>{
  const h=strictAdapter([[PENDING,JSON.stringify(index('abandoned'))]]);
  assert.equal(await h.store.load(),null);
  assert.ok(h.values.has(PENDING));
});

test('invalid recovery data is rejected before changing an existing target',async()=>{
  const current=JSON.stringify(index('current')),h=strictAdapter([[TARGET,current],[PREVIOUS,'not valid JSON']]);
  await assert.rejects(h.store.load(),/could not be read/);
  assert.equal(h.values.get(TARGET),current);
  assert.equal(h.values.get(PREVIOUS),'not valid JSON');
  assert.equal(h.mutations.length,0);
});

test('failed rollback retains previous cache for a later recovery',async()=>{
  const oldRaw=JSON.stringify(index('old')),h=strictAdapter([[TARGET,oldRaw]]);
  h.hooks.before=event=>{
    if(event.kind==='rename'&&(event.from===PENDING||event.from===PREVIOUS))throw new Error('Temporary storage failure.');
  };
  await assert.rejects(h.store.save(index('failed')),error=>error instanceof AggregateError);
  assert.equal(h.values.get(PREVIOUS),oldRaw);
  h.hooks.before=null;
  assert.equal((await h.store.load()).id,'old');
  assert.equal(h.values.get(TARGET),oldRaw);
  assert.deepEqual([...h.values.keys()],[TARGET]);
});

test('load waits for an in-progress replacement and saves remain ordered',async()=>{
  const h=strictAdapter([[TARGET,JSON.stringify(index('old'))]]);
  let resume,entered;
  const paused=new Promise(resolve=>{entered=resolve;}),release=new Promise(resolve=>{resume=resolve;});
  h.hooks.after=async event=>{if(event.kind==='rename'&&event.from===TARGET){entered();await release;}};
  const first=h.store.save(index('first'));await paused;
  assert.ok(!h.values.has(TARGET)&&h.values.has(PREVIOUS));
  const load=h.store.load(),second=h.store.save(index('second'));
  let loaded=false;load.then(()=>{loaded=true;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(loaded,false);
  resume();await first;
  assert.equal((await load).id,'first');await second;
  assert.equal((await h.store.load()).id,'second');
});

test('mobile synced source recovers the PC cache while preserving its device copy',async()=>{
  const pc=index('pc'),mobile={...index('mobile'),portableImport:{sourceIndexId:'pc'}};
  const mobilePath=DIR+'/knowledge-index-mobile.json';
  const h=strictAdapter([[PREVIOUS,JSON.stringify(pc)],[PENDING,JSON.stringify(index('abandoned'))],[mobilePath,JSON.stringify(mobile)]]);
  const store=new KnowledgeIndexStore({adapter:h.adapter,directory:DIR,device:'mobile'});
  assert.equal((await store.loadSyncedSource()).id,'pc');
  assert.equal((await store.load()).id,'mobile');
  assert.equal(h.values.get(mobilePath),JSON.stringify(mobile));
  assert.ok(h.values.has(TARGET)&&!h.values.has(PREVIOUS));
});

test('minimal storage adapters preserve direct-write fallback and no count ceiling',async()=>{
  const h=strictAdapter();delete h.adapter.remove;
  const large={...index('large'),nodes:Array.from({length:707},(_,i)=>({id:'note-'+i}))};
  await h.store.save(index('first'));await h.store.save(large);
  assert.equal((await h.store.load()).nodes.length,707);
  assert.ok(h.mutations.every(event=>event.kind==='write'&&event.path===TARGET));
});

test('readIndex rejects paths outside the selected private cache',async()=>{
  const h=strictAdapter();
  await assert.rejects(h.store.readIndex('notes/private.md'),/plugin knowledge cache/);
  await assert.rejects(h.store.readIndex(null),/plugin knowledge cache/);
  assert.equal(h.mutations.length,0);
});
