import test from 'node:test';
import assert from 'node:assert/strict';
import {buildFolderTree,folderState,folderStates,toggleFolder,toggleTag} from '../src/ui.mjs';
import {selectedFiles} from '../src/vault-search.mjs';
const files=['Research/direct.md','Research/Methods/graph.md','Research/Methods/Deep/example.md','Research/private/direct.md','Research/private/Share/allowed.md','Research-old/sibling.md','root.md'].map(path=>({path}));
const tree=buildFolderTree(files,['Empty','Research/Methods/Deep/Empty']);
const scope=(patch={})=>({mode:'folders',include:[],exclude:[],tags:[],excludeTags:[],...patch});
const paths=scope=>selectedFiles(files,scope).map(x=>x.path);
test('tree keeps explicit depth, all descendants, subtree note counts and empty folders',()=>{
  assert.equal(tree.nodes.get('Research/Methods/Deep').depth,2);assert.equal(tree.nodes.get('Research').noteCount,5);assert.equal(tree.nodes.get('Research').descendantCount,5);assert.equal(tree.nodes.get('Empty').noteCount,0);assert.deepEqual(tree.rootFiles,['root.md']);assert.equal(tree.nodes.has('Research-old'),true);
});
test('checking a parent visibly includes every descendant without sibling-prefix leakage',()=>{
  const selected=toggleFolder(scope(),'Research',true,tree);assert.deepEqual(paths(selected),files.slice(0,5).map(x=>x.path));const states=folderStates(tree,selected);for(const [path,value] of states)if(path==='Research'||path.startsWith('Research/'))assert.equal(value.checked,true);assert.equal(states.get('Research-old').checked,false);
});
test('clearing an inherited child adds one exclusion and makes the parent partial',()=>{
  const selected=toggleFolder(scope({include:['Research']}),'Research/Methods',false,tree);assert.deepEqual(selected.exclude,['Research/Methods']);assert.deepEqual(paths(selected),['Research/direct.md','Research/private/direct.md','Research/private/Share/allowed.md']);assert.deepEqual(folderState(tree.nodes.get('Research'),selected),{checked:false,partial:true});assert.deepEqual(folderStates(tree,selected).get('Research'),{checked:false,partial:true});
});
test('checking partial parent clears child exclusions and includes the whole branch',()=>{
  const selected=toggleFolder(scope({include:['Research'],exclude:['Research/Methods','Research/private/direct.md']}),'Research',true,tree);assert.deepEqual(selected.exclude,[]);assert.equal(folderState(tree.nodes.get('Research'),selected).checked,true);assert.equal(paths(selected).length,5);
});
test('all children selected does not check a parent whose direct notes remain unselected',()=>{
  const selected=scope({include:['Research/Methods','Research/private']});assert.deepEqual(folderState(tree.nodes.get('Research'),selected),{checked:false,partial:true});assert.equal(paths(selected).includes('Research/direct.md'),false);
});
test('parent without direct notes remains partial if only existing children are explicitly selected',()=>{
  const isolated=buildFolderTree([{path:'Parent/Child/leaf.md'}]);const selected=scope({include:['Parent/Child']});assert.deepEqual(isolated.nodes.get('Parent').files,[]);assert.deepEqual(folderState(isolated.nodes.get('Parent'),selected),{checked:false,partial:true});assert.deepEqual(folderStates(isolated,selected).get('Parent'),{checked:false,partial:true});
});
test('legacy all-mode include restrictions can add a second folder without broadening the vault',()=>{
  const selected=toggleFolder(scope({mode:'all',include:['Research/Methods']}),'Research-old',true,tree);assert.equal(selected.mode,'folders');assert.deepEqual(paths(selected).sort(),['Research/Methods/Deep/example.md','Research/Methods/graph.md','Research-old/sibling.md'].sort());
});
test('root include and exclusion paths match the search scope semantics',()=>{
  const all=scope({include:['']});assert.equal(folderState(tree.nodes.get('Research'),all).checked,true);assert.equal(paths(all).length,files.length);const none=scope({mode:'all',exclude:['']});assert.equal(folderState(tree.nodes.get('Research'),none).checked,false);assert.deepEqual(paths(none),[]);const opened=toggleFolder(none,'Research/Methods',true,tree);assert.deepEqual(paths(opened).sort(),['Research/Methods/Deep/example.md','Research/Methods/graph.md'].sort());
});
test('reopening one descendant of excluded ancestor preserves existing selections without exposing siblings',()=>{
  const before=scope({mode:'all',exclude:['Research/private']});const selected=toggleFolder(before,'Research/private/Share',true,tree);const expected=[...paths(before),'Research/private/Share/allowed.md'].sort();assert.deepEqual(paths(selected).sort(),expected);assert.equal(paths(selected).includes('Research/private/direct.md'),false);assert.equal(selected.mode,'folders');assert.ok(selected.include.includes('Research/direct.md'));assert.ok(!selected.include.includes('Research'));
});
test('entire-vault mode supports a child exclusion and safe nested reopening',()=>{
  const before=scope({mode:'all'});const excluded=toggleFolder(before,'Research',false,tree);assert.deepEqual(excluded.exclude,['Research']);const selected=toggleFolder(excluded,'Research/Methods',true,tree);assert.deepEqual(paths(selected).sort(),['Research-old/sibling.md','Research/Methods/Deep/example.md','Research/Methods/graph.md','root.md'].sort());
});
test('checking tag parent includes nested tags while unchecking inherited child adds exclusion',()=>{
  const selected=toggleTag(scope(),'#knowledge',true);const partial=toggleTag(selected,'#knowledge/private',false);assert.deepEqual(partial.tags,['#knowledge']);assert.deepEqual(partial.excludeTags,['#knowledge/private']);assert.deepEqual(toggleTag(partial,'#knowledge',true).excludeTags,[]);
});
test('a tag blocked by excluded ancestor cannot silently reopen excluded sibling tags',()=>{
  const before=scope({tags:['#review'],excludeTags:['#knowledge']});assert.deepEqual(toggleTag(before,'#knowledge/ai',true),before);const selected=toggleTag(before,'#knowledge',true);assert.deepEqual(selected.excludeTags,[]);assert.deepEqual(selected.tags,['#review','#knowledge']);
});
