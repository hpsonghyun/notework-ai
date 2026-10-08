import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeTag,normalizeScope,fileTags,tagCatalog,selectedFiles,searchVault,contextPrompt} from '../src/vault-search.mjs';

function fixture() {
  const rows=[
    ['projects/alpha/a.md',['#Research/AI','#todo']],
    ['projects/alpha/nested/b.md',['#research']],
    ['projects/beta/c.md',['#finance']],
    ['projects/alpha-copy/d.md',['#research/ai']],
    ['root.md',[]],
    ['.hidden/private.md',['#research']],
    ['assets/image.png',['#research']]
  ];
  const files=rows.map(([path])=>({path,stat:{size:40}}));
  const cache=new Map(rows.map(([path,tags])=>[path,{tags:tags.map(tag=>({tag})),frontmatter:{}}]));
  const reads=[]; const metadataCache={getFileCache:file=>cache.get(file.path) ?? null};
  const getTags=file=>fileTags(file,metadataCache);
  const vault={getMarkdownFiles:()=>files.filter(file=>file.path.endsWith('.md')),getAbstractFileByPath:path=>files.find(file=>file.path===path),cachedRead:async file=>{reads.push(file.path);return 'research evidence from '+file.path;}};
  return {files,cache,reads,metadataCache,getTags,vault};
}
function paths(files){return files.map(file=>file.path);}

test('tag provider uses official helper on actual cached metadata without reading note content',()=>{
  const file={path:'notes/a.md'}; const cache={tags:[{tag:'#Inline'}],frontmatter:{tags:['Frontmatter']}}; let seen;
  const result=fileTags(file,{getFileCache:requested=>{assert.equal(requested,file);return cache;}},{getAllTags:value=>{seen=value;return ['#Inline','#Frontmatter','#inline'];}});
  assert.equal(seen,cache);assert.deepEqual(result,['#inline','#frontmatter']);
});

test('metadata fallback combines inline tags and frontmatter tags and deduplicates',()=>{
  const cache={tags:[{tag:'#Research'},{tag:'#research'},null],frontmatter:{tags:['#Work','Research']}};
  assert.deepEqual(fileTags({path:'a.md'},{getFileCache:()=>cache}),['#research','#work']);
  assert.deepEqual(fileTags({path:'a.md'},{getFileCache:()=>({frontmatter:{tags:'one-tag'}})}),['#one-tag']);
});

test('cache pending is distinguished from an indexed note without tags',()=>{
  assert.equal(fileTags({path:'new.md'},{getFileCache:()=>null}),null);
  assert.deepEqual(fileTags({path:'untagged.md'},{getFileCache:()=>({})}),[]);
  assert.equal(fileTags({path:'bad.md'},{getFileCache:()=>({})},{getAllTags:()=>{throw new Error('partial cache');}}),null);
});

test('tag matching is case-insensitive and supports nested Unicode tags',()=>{
  assert.equal(normalizeTag('  #Research/AI  '),'#research/ai');
  assert.equal(normalizeTag('연구/📖'),'#연구/📖');
  assert.equal(normalizeTag('Cafe\u0301'),'#café');
  const file={path:'note.md'};
  assert.deepEqual(selectedFiles([file],{tags:['#RESEARCH']},{getTags:()=>['#Research/AI']}),[file]);
});

test('invalid tag filters are rejected before retrieval',()=>{
  for(const tag of ['', '#', '#has space', '#two,#tags', '#topic//child', '#topic/', '#one#two'])assert.throws(()=>normalizeTag(tag));
  assert.throws(()=>selectedFiles([{path:'a.md'}],{tags:'#topic'},{getTags:()=>['#topic']}));
});

test('tag catalog includes inferred parents with descendant counts once per note',()=>{
  const f=fixture();f.cache.get('projects/alpha/a.md').tags.push({tag:'#research'},{tag:'#research/ai'});
  assert.deepEqual(Object.fromEntries(tagCatalog([...f.files,f.files[0]],{getTags:f.getTags}).map(item=>[item.tag,item.count])),{'#finance':1,'#research':3,'#research/ai':2,'#todo':1});
  assert.equal(f.reads.length,0);
});

test('tag catalog reflects cache updates without re-reading note bodies',()=>{
  const f=fixture();const first=tagCatalog(f.files,{getTags:f.getTags});f.cache.get('root.md').frontmatter.tags=['new-topic'];
  const next=tagCatalog(f.files,{getTags:f.getTags});assert.ok(!first.some(item=>item.tag==='#new-topic'));assert.equal(next.find(item=>item.tag==='#new-topic').count,1);assert.equal(f.reads.length,0);
});

test('included parent folder covers descendants while a prefix neighbor is separate',()=>{
  const f=fixture();assert.deepEqual(paths(selectedFiles(f.files,{mode:'folders',include:['projects/alpha','projects/alpha/nested']})),['projects/alpha/a.md','projects/alpha/nested/b.md']);
});

test('folder and tag include filters intersect, with any matching tag accepted',()=>{
  const f=fixture();assert.deepEqual(paths(selectedFiles(f.files,{mode:'folders',include:['projects'],tags:['#research/ai','#finance']},{getTags:f.getTags})),['projects/alpha/a.md','projects/beta/c.md','projects/alpha-copy/d.md']);
  assert.deepEqual(paths(selectedFiles(f.files,{mode:'folders',include:['projects/alpha'],tags:['#research/ai']},{getTags:f.getTags})),['projects/alpha/a.md']);
});

test('parent tag includes nested tags but not a prefix neighbor',()=>{
  const files=[{path:'exact.md'},{path:'nested.md'},{path:'neighbor.md'}];const tags={'exact.md':['#topic'],'nested.md':['#topic/child'],'neighbor.md':['#topic-extra']};
  assert.deepEqual(paths(selectedFiles(files,{tags:['#topic']},{getTags:file=>tags[file.path]})),['exact.md','nested.md']);
});

test('tag exclusion wins even when the note has another included tag',()=>{
  const f=fixture();assert.deepEqual(paths(selectedFiles(f.files,{tags:['#research','#todo'],excludeTags:['#research/ai']},{getTags:f.getTags})),['projects/alpha/nested/b.md']);
});

test('folder exclusion wins before tag lookup',()=>{
  const f=fixture();let excludedLookups=0;const getTags=file=>{if(file.path.startsWith('projects/alpha/'))excludedLookups++;return f.getTags(file);};
  assert.deepEqual(paths(selectedFiles(f.files,{tags:['#research'],exclude:['projects/alpha']},{getTags})),['projects/alpha-copy/d.md']);assert.equal(excludedLookups,0);
});

test('tag-only scope includes matching root notes',()=>{
  const f=fixture();f.cache.get('root.md').frontmatter.tags=['research'];assert.ok(paths(selectedFiles(f.files,{mode:'all',tags:['#research']},{getTags:f.getTags})).includes('root.md'));
});

test('unknown metadata is skipped for both include and exclude tag rules',()=>{
  const files=[{path:'known.md'},{path:'pending.md'}];const getTags=file=>file.path==='pending.md'?null:[];
  assert.deepEqual(paths(selectedFiles(files,{excludeTags:['#private']},{getTags})),['known.md']);
  assert.equal(selectedFiles(files,{tags:['#research']},{getTags}).length,0);
});

test('missing tag provider fails closed when any tag filter is active',()=>{
  assert.throws(()=>selectedFiles([{path:'a.md'}],{tags:['#research']}),/metadata/);
  assert.throws(()=>selectedFiles([{path:'a.md'}],{excludeTags:['#private']}),/metadata/);
});

test('ordinary all-notes scope still includes untagged and unindexed notes',()=>{
  const files=[{path:'untagged.md'},{path:'unindexed.md'}];assert.deepEqual(selectedFiles(files,{mode:'all'},{getTags:()=>null}),files);
});

test('empty selected-folders mode remains empty even when tags are chosen',()=>{
  const f=fixture();assert.equal(selectedFiles(f.files,{mode:'folders',include:[],tags:['#research']},{getTags:f.getTags}).length,0);
});

test('scope normalization restores old scope and allowlists tag settings',()=>{
  assert.deepEqual(normalizeScope({include:['projects','projects'],exclude:[],tags:['Research','#research'],excludeTags:['#PRIVATE'],irrelevant:'do not persist'}),{mode:'all',include:['projects'],exclude:[],tags:['#research'],excludeTags:['#private']});
  assert.throws(()=>normalizeScope({mode:'invalid'}));assert.throws(()=>normalizeScope({include:['../outside']}));
});

test('actual search reads only notes matching folder and tag filters',async()=>{
  const f=fixture();const matches=await searchVault(f.vault,'research',{mode:'folders',include:['projects/alpha'],tags:['#research/ai']},{getTags:f.getTags});
  assert.deepEqual(f.reads,['projects/alpha/a.md']);assert.deepEqual(paths(matches),['projects/alpha/a.md']);assert.ok(contextPrompt('research',matches).includes('projects/alpha/a.md'));assert.ok(!contextPrompt('research',matches).includes('projects/alpha/nested/b.md'));
});

test('tag changing while a note is read cannot leak a newly excluded note',async()=>{
  const f=fixture();f.vault.cachedRead=async file=>{f.cache.get(file.path).tags=[{tag:'#private'}];return 'research private content';};
  const matches=await searchVault(f.vault,'research',{tags:['#research'],excludeTags:['#private']},{getTags:f.getTags});assert.equal(matches.length,0);
});

test('scope filters are snapshotted rather than changed by caller mutation during read',async()=>{
  const f=fixture();const scope={mode:'all',tags:['#research/ai']};f.vault.cachedRead=async file=>{scope.tags[0]='#finance';return 'research evidence';};
  assert.deepEqual(paths(await searchVault(f.vault,'research',scope,{getTags:f.getTags})).sort(),['projects/alpha/a.md','projects/alpha-copy/d.md'].sort());
});

test('moving a selected note during read excludes its old snapshot',async()=>{
  const f=fixture();f.vault.cachedRead=async file=>{file.path='outside/moved.md';return 'research evidence';};
  assert.equal((await searchVault(f.vault,'research',{mode:'folders',include:['projects/alpha']},{getTags:f.getTags})).length,0);
});

test('cancellation during cachedRead stops before any source is returned',async()=>{
  const f=fixture();const controller=new AbortController();f.vault.cachedRead=async()=>{controller.abort();return 'research evidence';};
  await assert.rejects(searchVault(f.vault,'research',{tags:['#research']},{getTags:f.getTags,signal:controller.signal}),{name:'AbortError'});
});

test('progress reaches selected total even when oversized notes are skipped',async()=>{
  const f=fixture();f.files[0].stat.size=2_000_000;const progress=[];
  await searchVault(f.vault,'research',{mode:'folders',include:['projects/alpha']},{getTags:f.getTags,onProgress:value=>progress.push(value)});
  assert.deepEqual(progress.at(-1),{done:2,total:2});assert.ok(!f.reads.includes('projects/alpha/a.md'));
});

test('hidden paths and non-Markdown files never appear in tag-scoped sources',async()=>{
  const f=fixture();const selected=selectedFiles(f.files,{tags:['#research']},{getTags:f.getTags});assert.ok(selected.every(file=>!file.path.startsWith('.')&&file.path.endsWith('.md')));
  assert.ok(tagCatalog(f.files,{getTags:f.getTags}).every(item=>item.count<=3));
});
