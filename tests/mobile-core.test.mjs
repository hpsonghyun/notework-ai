import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import {posix,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createContext,runInContext} from 'node:vm';
import {build} from 'esbuild';

const TIME='2026-10-06T12:34:56.000Z';
const sha=value=>createHash('sha256').update(value).digest('hex');
function mobileVault(contents={}){
  const notes=new Map(Object.entries(contents));const files=new Map([...notes].map(([path,content])=>[path,{path,stat:{mtime:1,size:new TextEncoder().encode(content).length}}]));const folders=new Map();
  return {notes,files,vault:{
    getName:()=> 'Synthetic Mobile Vault',getMarkdownFiles:()=> [...files.values()].filter(file=>file.path.endsWith('.md')),getAbstractFileByPath:path=>files.get(path)||folders.get(path),
    adapter:{exists:async path=>files.has(path)||folders.has(path),stat:async path=>folders.has(path)?{type:'folder'}:files.has(path)?{type:'file'}:null,read:async path=>{if(!notes.has(path))throw new Error('missing');return notes.get(path);}},
    createFolder:async path=>{const folder={path,children:[]};folders.set(path,folder);return folder;},
    read:async file=>{if(!files.has(file.path))throw new Error('missing');return notes.get(file.path);},
    create:async(path,content)=>{if(files.has(path)||folders.has(path))throw new Error('exists');const file={path,stat:{mtime:1,size:new TextEncoder().encode(content).length}};files.set(path,file);notes.set(path,content);return file;},
    process:async(file,callback)=>{const content=callback(notes.get(file.path));assert.equal(typeof content,'string','atomic process callback must remain synchronous');notes.set(file.path,content);file.stat.size=new TextEncoder().encode(content).length;return content;},
  }};
}

test('browser-targeted core runs without Buffer, require or process and keeps desktop key/index/archive hashes compatible',async()=>{
  const root=dirname(dirname(fileURLToPath(import.meta.url)));
  const bundle=await build({stdin:{contents:"export * from './src/portable-crypto.mjs'; export * from './src/secret-store.mjs'; export * from './src/conversation-archive.mjs'; export * from './src/knowledge-engine.mjs';",resolveDir:root,sourcefile:'mobile-core-fixture.mjs'},bundle:true,platform:'browser',format:'iife',globalName:'MobileCore',target:'es2022',write:false,logLevel:'silent'});
  const context=createContext({TextEncoder,TextDecoder,DOMException,structuredClone,crypto:webcrypto,setTimeout,clearTimeout});runInContext("Math.random=()=>{throw new Error('predictable random source must not be used');};",context);runInContext(bundle.outputFiles[0].text,context);const core=context.MobileCore;
  assert.equal(runInContext("typeof Buffer + ':' + typeof require + ':' + typeof process",context),'undefined:undefined:undefined');assert.equal(core.sha256HexSync('한국어 🧠'),sha('한국어 🧠'));assert.equal(await core.sha256Hex('한국어 🧠'),sha('한국어 🧠'));
  const ids=[];const desktopId='notework-ai-'+sha('api-openai').slice(0,32);const secrets=new core.SecretStore({getSecret:key=>{ids.push(key);return key===desktopId?'synthetic-credential':null;},setSecret:()=>{}});assert.equal(await secrets.get('api-openai'),'synthetic-credential');assert.deepEqual(ids,[desktopId]);
  const text='# Mobile source\nmethod evidence 한국어 🧠\r\n';const f=mobileVault({'Research/메모.md':text,'Private/private.md':'hidden method'});const engine=new core.KnowledgeEngine({vault:f.vault,clock:()=>new Date(TIME)});const index=await engine.build({consent:true,embeddingRoute:'lexical',semanticRoute:'none',scope:{include:['Research']}});assert.equal(index.vaultId,sha('Synthetic Mobile Vault'));assert.equal(index.nodes[0].contentHash,sha(text));assert.equal(index.nodes[0].id,'note_'+sha('Research/메모.md').slice(0,20));const chunk=index.chunks[0];assert.equal(chunk.id,'chunk_'+sha(JSON.stringify([chunk.path,chunk.contentHash,chunk.start,chunk.end])).slice(0,24));
  const result=await engine.retrieve({index,question:'method',selectedNodeIds:[]});assert.equal(result.sources.length,0);const searched=await engine.retrieve({index,question:'method'});assert.equal(searched.sources[0].text,text);assert(!searched.context.includes('hidden method'));
  const archive=new core.ConversationArchive({vault:f.vault,clock:()=>TIME});const messages=[{id:'u1',role:'user',content:'한국어 mobile question 🧠',createdAt:TIME},{id:'a1',role:'assistant',content:'An exact archived answer.\r\n',createdAt:TIME,sources:[{path:'Research/메모.md',text,contentHash:sha(text)}],contextSources:[{path:'Research/메모.md',contentHash:sha(text)}],retrieval:searched.proof}];const saved=await archive.save({messages});assert.match(saved.id,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);const note=f.notes.get(saved.path);const [,digest,base64]=/data:v1:([a-f0-9]{64}):([A-Za-z0-9+/=]+)/.exec(note);const desktopPayload=Buffer.from(base64,'base64').toString('utf8');assert.equal(digest,sha(desktopPayload));assert.equal(core.encodeBase64(desktopPayload),base64);const href=posix.relative(posix.dirname(saved.path),'Research/메모.md').split('/').map(encodeURIComponent).join('/');assert(note.includes('(<'+href+'>)'));const loaded=await archive.load({path:saved.path});assert.equal(loaded.messages[1].content,messages[1].content);assert.equal(loaded.messages[1].retrieval.route,'lexical');assert.equal(loaded.messages[1].retrieval.strategy,'lexical');
  await archive.save({id:saved.id,messages:[...messages,{id:'u2',role:'user',content:'Follow-up',createdAt:TIME}]});assert.equal((await archive.load({path:saved.path})).messageCount,3);
});
