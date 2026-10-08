import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceHost,PANEL_VIEW,GRAPH_VIEW} from '../src/workspace-host.mjs';

function fixture({legacy=false,noSidebar=false,isMobile=false}={}) {
  const right={expanded:0,collapsed:0,expand(){this.expanded++;},collapse(){this.collapsed++;}},center={};const leaves=[];const calls=[];
  const make=(root,type,parent={})=>{const leaf={id:'leaf-'+leaves.length,root,type,parent,getRoot(){return this.root;},getViewState(){return {pinned:this.pinned};},async openFile(file){this.type='markdown';this.view.file=file;calls.push(['openFile',file.path]);},async setViewState(state){this.type=state.type;calls.push(['state',this.root===right?'right':'center',state.type]);},detach(){this.detached=true;},async loadIfDeferred(){calls.push(['load',this.type]);}};leaf.view={getViewType:()=>leaf.type,ui:{setView:view=>calls.push(['view',view])}};leaves.push(leaf);return leaf;};
  const editor=make(center,'markdown');if(legacy)make(center,PANEL_VIEW);
  const workspace={rightSplit:right,rootSplit:center,getMostRecentLeaf:()=>editor,getLeavesOfType:type=>leaves.filter(leaf=>leaf.type===type&&!leaf.detached),getRightLeaf:split=>{calls.push(['right',split]);return noSidebar?null:make(right,'empty');},getLeaf:(type,direction)=>{calls.push(['editorLeaf',type,direction]);return make(center,'empty');},createLeafBySplit:(current,direction,before=false)=>{calls.push(['split',current.type,direction]);const parent={};const branch={direction,parent:current.parent.parent,children:before?[parent,current.parent]:[current.parent,parent]};current.parent.parent=branch;parent.parent=branch;const leaf=make(center,'empty',parent);leaf.splitAnchor=current;leaf.splitDirection=direction;leaf.splitBefore=before;return leaf;},async revealLeaf(leaf){calls.push(['reveal',leaf.type]);}};
  return {host:new WorkspaceHost(workspace,{isMobile}),workspace,leaves,calls,editor,right,make,center};
}
test('ordinary launch opens the right sidebar and preserves the active editor',async()=>{const f=fixture();const leaf=await f.host.openPanel();assert.equal(leaf.getRoot(),f.right);assert.equal(f.right.expanded,1);assert.equal(f.editor.detached,undefined);assert.ok(!f.calls.some(call=>call[0]==='editorLeaf'));});
test('repeated and concurrent launch reuses the same side leaf',async()=>{const f=fixture();const [a,b]=await Promise.all([f.host.openPanel(),f.host.openPanel('history')]);assert.equal(a,b);await f.host.openPanel();assert.equal(f.calls.filter(call=>call[0]==='right').length,1);});
test('legacy center view is migrated without closing Markdown leaves',async()=>{const f=fixture({legacy:true});const legacy=f.leaves[1];const current=await f.host.openPanel();assert.equal(current.getRoot(),f.right);assert.equal(legacy.detached,true);assert.equal(f.editor.detached,undefined);});
test('graph opens beside the editor while its separate right chat stays visible',async()=>{
  const f=fixture();
  f.editor.view.file={path:'Research/open-note.md'};
  const [a,b]=await Promise.all([f.host.openWorkspace(),f.host.openWorkspace()]);
  assert.equal(a,b);assert.equal(a.type,GRAPH_VIEW);
  const chat=f.workspace.getLeavesOfType(PANEL_VIEW)[0];
  assert.equal(chat.getRoot(),f.right);assert.equal(a.getRoot(),f.center);assert.notEqual(chat,a);
  assert.deepEqual(f.calls.filter(call=>call[0]==='state'),[['state','right',PANEL_VIEW],['state','center',GRAPH_VIEW]]);
  await f.host.openWorkspace();
  assert.deepEqual(f.calls.filter(call=>call[0]==='split'),[['split','markdown','vertical']]);
  assert.ok(!f.calls.some(call=>call[0]==='editorLeaf'));assert.equal(f.editor.type,'markdown');
  assert.equal(f.editor.view.file.path,'Research/open-note.md');assert.equal(f.editor.detached,undefined);
  assert.notEqual(a.parent,f.editor.parent);assert.equal(f.right.collapsed,0);assert.equal(f.right.expanded,2);
  assert.equal(f.calls.filter(call=>call[0]==='right').length,1);
});
test('an old graph tab that hid Markdown is migrated to an adjacent split',async()=>{const f=fixture();const old=f.make(f.center,GRAPH_VIEW,f.editor.parent);await f.host.openWorkspace();assert.equal(old.detached,true);assert.equal(f.editor.detached,undefined);assert.deepEqual(f.calls.find(call=>call[0]==='split'),['split','markdown','vertical']);});
test('canvas anchors the separate graph split while right chat stays visible',async()=>{const f=fixture();f.editor.type='canvas';f.editor.view.file={path:'Research/open.canvas'};await f.host.openWorkspace();assert.deepEqual(f.calls.find(call=>call[0]==='split'),['split','canvas','vertical']);assert.equal(f.editor.type,'canvas');assert.equal(f.editor.view.file.path,'Research/open.canvas');assert.equal(f.editor.detached,undefined);assert.equal(f.workspace.getLeavesOfType(PANEL_VIEW)[0].getRoot(),f.right);assert.equal(f.right.expanded,1);assert.equal(f.right.collapsed,0);});
test('sidebar unavailable reports error instead of falling back over the note',async()=>{const f=fixture({noSidebar:true});await assert.rejects(f.host.openPanel(),/sidebar/);assert.equal(f.editor.type,'markdown');});
test('a graph moved into the sidebar is migrated while right chat stays expanded',async()=>{const f=fixture();const old=f.make(f.right,GRAPH_VIEW);const graph=await f.host.openWorkspace();assert.equal(graph.getRoot(),f.center);assert.equal(old.detached,true);assert.equal(f.editor.detached,undefined);assert.equal(f.workspace.getLeavesOfType(PANEL_VIEW)[0].getRoot(),f.right);assert.equal(f.right.collapsed,0);});
test('concurrent graph and chat opening creates one chat leaf and one graph leaf',async()=>{const f=fixture();const [chat,graph]=await Promise.all([f.host.openPanel(),f.host.openWorkspace()]);assert.notEqual(chat,graph);assert.equal(f.workspace.getLeavesOfType(PANEL_VIEW).length,1);assert.equal(f.workspace.getLeavesOfType(GRAPH_VIEW).length,1);assert.equal(f.calls.filter(call=>call[0]==='right').length,1);assert.equal(f.calls.filter(call=>call[0]==='split').length,1);assert.equal(f.right.collapsed,0);});
test('closing the native graph leaf preserves both chat and the pinned note',async()=>{const f=fixture();f.editor.pinned=true;f.editor.view.file={path:'Research/pinned.md'};const graph=await f.host.openWorkspace();const chat=f.workspace.getLeavesOfType(PANEL_VIEW)[0];graph.detach();assert.equal(f.editor.detached,undefined);assert.equal(f.editor.view.file.path,'Research/pinned.md');assert.equal(chat.detached,undefined);assert.equal(chat.getRoot(),f.right);assert.equal(f.workspace.getLeavesOfType(GRAPH_VIEW).length,0);assert.equal(f.right.collapsed,0);});
test('graph does not open a competing conversation when the right sidebar is unavailable',async()=>{const f=fixture({noSidebar:true});await assert.rejects(f.host.openWorkspace(),/sidebar/);assert.equal(f.editor.type,'markdown');assert.equal(f.workspace.getLeavesOfType(GRAPH_VIEW).length,0);assert.ok(!f.calls.some(call=>call[0]==='split'));});
test('opening evidence uses the document beside an active graph',async()=>{const f=fixture();const graph=await f.host.openWorkspace();f.workspace.getMostRecentLeaf=()=>graph;const source=await f.host.openSource({path:'Research/evidence.md'});assert.equal(source,f.editor);assert.equal(graph.type,GRAPH_VIEW);assert.equal(graph.detached,undefined);assert.equal(source.view.file.path,'Research/evidence.md');assert.equal(f.calls.filter(call=>call[0]==='split').length,1);});
test('an already-open pinned source is revealed without reopening it',async()=>{const f=fixture();f.editor.pinned=true;f.editor.view.file={path:'Research/evidence.md'};const leaf=await f.host.openSource({path:'Research/evidence.md'});assert.equal(leaf,f.editor);assert.ok(!f.calls.some(call=>call[0]==='openFile'));});
test('a different source preserves a pinned document and the graph',async()=>{const f=fixture();f.editor.pinned=true;f.editor.view.file={path:'Research/pinned.md'};const graph=await f.host.openWorkspace();const source=await f.host.openSource({path:'Research/evidence.md'});assert.notEqual(source,f.editor);assert.notEqual(source,graph);assert.equal(f.editor.view.file.path,'Research/pinned.md');assert.equal(graph.type,GRAPH_VIEW);assert.equal(source.view.file.path,'Research/evidence.md');});
test('source opening preserves a canvas rather than replacing it',async()=>{const f=fixture();f.editor.type='canvas';const graph=await f.host.openWorkspace();const source=await f.host.openSource({path:'Research/evidence.md'});assert.equal(f.editor.type,'canvas');assert.equal(graph.type,GRAPH_VIEW);assert.notEqual(source,f.editor);assert.notEqual(source,graph);});

test('phone launch uses a main tab even when the right sidebar is unavailable',async()=>{const f=fixture({isMobile:true,noSidebar:true});const leaf=await f.host.openPanel();assert.equal(leaf.type,GRAPH_VIEW);assert.equal(leaf.getRoot(),f.center);assert.deepEqual(f.calls.filter(call=>call[0]==='editorLeaf'),[['editorLeaf','tab',undefined]]);assert.ok(!f.calls.some(call=>['right','split'].includes(call[0])));assert.equal(f.editor.type,'markdown');assert.equal(f.editor.detached,undefined);});
test('phone Chat Graph and History share a single view with no narrow splits',async()=>{const f=fixture({isMobile:true});const [chat,graph]=await Promise.all([f.host.openPanel(),f.host.openWorkspace()]);assert.equal(chat,graph);assert.equal(await f.host.openPanel('history'),graph);assert.equal(await f.host.openPanel('flow'),graph);assert.equal(f.calls.filter(call=>call[0]==='editorLeaf').length,1);assert.deepEqual(f.calls.filter(call=>call[0]==='view').map(call=>call[1]),['chat','graph','history','flow']);assert.equal(f.right.expanded,0);assert.equal(f.right.collapsed,0);});
test('phone reuses a graph main tab without migrating unrelated leaves',async()=>{const f=fixture({isMobile:true});const old=f.make(f.right,PANEL_VIEW);const graph=f.make(f.center,GRAPH_VIEW,f.editor.parent);assert.equal(await f.host.openWorkspace(),graph);assert.equal(f.calls.filter(call=>call[0]==='editorLeaf').length,0);assert.equal(old.detached,undefined);assert.equal(f.editor.detached,undefined);});
test('phone source opening preserves pinned notes by creating a new tab',async()=>{const f=fixture({isMobile:true});f.editor.pinned=true;f.editor.view.file={path:'Research/pinned.md'};const graph=await f.host.openWorkspace();const source=await f.host.openSource({path:'Research/evidence.md'});assert.notEqual(source,graph);assert.notEqual(source,f.editor);assert.equal(f.editor.view.file.path,'Research/pinned.md');assert.deepEqual(f.calls.filter(call=>call[0]==='editorLeaf').map(call=>call[1]),['tab','tab']);assert.ok(!f.calls.some(call=>call[0]==='split'));});
test('phone source opening preserves Canvas and returns to the same graph',async()=>{const f=fixture({isMobile:true});f.editor.type='canvas';const graph=await f.host.openWorkspace();const source=await f.host.openSource({path:'Research/evidence.md'});assert.equal(f.editor.type,'canvas');assert.notEqual(source,f.editor);assert.equal(await f.host.openWorkspace(),graph);assert.equal(graph.detached,undefined);assert.ok(!f.calls.some(call=>call[0]==='split'));});

const graphFile=path=>({path,extension:'md'});
test('graph note opens left of the graph in a native vertical branch without replacing any existing editor',async()=>{
  const f=fixture();f.editor.view.file=graphFile('Research/current.md');
  const canvas=f.make(f.center,'canvas');canvas.view.file={path:'Research/current.canvas'};
  const pinned=f.make(f.center,'markdown');pinned.pinned=true;pinned.view.file=graphFile('Research/pinned.md');
  const graph=await f.host.openWorkspace(),chat=f.workspace.getLeavesOfType(PANEL_VIEW)[0];
  const source=await f.host.openGraphNote(graphFile('Research/evidence.md'));
  assert.equal(source.splitAnchor,graph);assert.equal(source.splitDirection,'vertical');assert.equal(source.splitBefore,true);
  assert.equal(graph.parent.parent,source.parent.parent);assert.deepEqual(graph.parent.parent.children,[source.parent,graph.parent]);
  assert.notEqual(source,f.editor);assert.notEqual(source,pinned);assert.notEqual(source,canvas);assert.equal(source.view.file.path,'Research/evidence.md');
  assert.equal(f.editor.view.file.path,'Research/current.md');assert.equal(canvas.view.file.path,'Research/current.canvas');assert.equal(pinned.view.file.path,'Research/pinned.md');
  for(const leaf of [f.editor,canvas,pinned,graph,chat])assert.equal(leaf.detached,undefined);
  assert.equal(chat.getRoot(),f.right);assert.equal(f.right.collapsed,0);
});
test('subsequent and concurrent graph note clicks reuse only the owned left pane in click order',async()=>{
  const f=fixture();f.editor.view.file=graphFile('Research/current.md');
  const [a,b]=await Promise.all([f.host.openGraphNote(graphFile('Research/first.md')),f.host.openGraphNote(graphFile('Research/second.md'))]);
  assert.equal(a,b);assert.equal(b.view.file.path,'Research/second.md');assert.equal(f.editor.view.file.path,'Research/current.md');
  assert.deepEqual(f.calls.filter(call=>call[0]==='openFile'),[['openFile','Research/first.md'],['openFile','Research/second.md']]);
  assert.equal(f.calls.filter(call=>call[0]==='split'&&call[1]===GRAPH_VIEW&&call[2]==='vertical').length,1);
  await f.host.openGraphNote(graphFile('Research/second.md'));
  assert.equal(f.calls.filter(call=>call[0]==='openFile').length,2);
});
test('in-memory ownership survives host reconstruction without adopting another Markdown leaf',async()=>{
  const f=fixture();const owned=await f.host.openGraphNote(graphFile('Research/first.md'));
  const arbitrary=f.make(f.center,'markdown');arbitrary.view.file=graphFile('Research/arbitrary.md');
  const restarted=new WorkspaceHost(f.workspace);
  assert.equal(await restarted.openGraphNote(graphFile('Research/next.md')),owned);
  assert.equal(arbitrary.view.file.path,'Research/arbitrary.md');assert.equal(arbitrary.detached,undefined);
  assert.equal(f.calls.filter(call=>call[0]==='split'&&call[1]===GRAPH_VIEW&&call[2]==='vertical').length,1);
});
test('lost ownership after pinned, repurposed, moved, detached or changed-ID leaves never overwrites those views',async()=>{
  const changes=[leaf=>{leaf.pinned=true;},leaf=>{leaf.view.file=graphFile('Research/user-opened.md');},leaf=>{leaf.type='canvas';leaf.view.file={path:'Research/user.canvas'};},leaf=>{leaf.parent={};},leaf=>{leaf.detach();},leaf=>{leaf.id='different-native-leaf';}];
  for(const change of changes){const f=fixture();const previous=await f.host.openGraphNote(graphFile('Research/first.md'));change(previous);const before={type:previous.type,file:previous.view.file.path,pinned:previous.pinned,detached:previous.detached,id:previous.id,parent:previous.parent};
    const next=await new WorkspaceHost(f.workspace).openGraphNote(graphFile('Research/next.md'));
    assert.notEqual(next,previous);assert.equal(previous.type,before.type);assert.equal(previous.view.file.path,before.file);assert.equal(previous.pinned,before.pinned);assert.equal(previous.detached,before.detached);assert.equal(previous.id,before.id);assert.equal(previous.parent,before.parent);
    assert.equal(next.splitDirection,'vertical');assert.equal(next.splitBefore,true);assert.equal(next.view.file.path,'Research/next.md');
  }
});
test('closing or moving the graph never gives a new graph ownership of an unrelated old note pane',async()=>{
  for(const move of [graph=>graph.detach(),(graph,f)=>{graph.root=f.right;}]){
    const f=fixture(),first=await f.host.openGraphNote(graphFile('Research/first.md')),oldGraph=first.splitAnchor;move(oldGraph,f);
    const next=await f.host.openGraphNote(graphFile('Research/next.md'));
    assert.notEqual(next,first);assert.notEqual(next.splitAnchor,oldGraph);assert.equal(first.view.file.path,'Research/first.md');assert.equal(first.detached,undefined);assert.equal(f.editor.type,'markdown');
  }
});
test('an already-open matching user note is preserved while graph clicks get their dedicated left pane',async()=>{
  const f=fixture();f.editor.view.file=graphFile('Research/evidence.md');f.editor.pinned=true;
  const source=await f.host.openGraphNote(graphFile('Research/evidence.md'));
  assert.notEqual(source,f.editor);assert.equal(f.editor.pinned,true);assert.equal(f.editor.view.file.path,'Research/evidence.md');assert.equal(source.splitDirection,'vertical');assert.equal(source.splitBefore,true);
});
test('graph-note validation rejects folders and non-Markdown inputs before changing the workspace',async()=>{
  const f=fixture();
  for(const file of [null,{path:'Research/folder'},{path:'Research/file.pdf',extension:'pdf'},{path:'',extension:'md'}])await assert.rejects(f.host.openGraphNote(file),/Markdown/);
  assert.equal(f.calls.length,0);assert.equal(f.editor.type,'markdown');
});
test('phone graph notes use a dedicated reusable native tab while preserving editor, canvas and graph',async()=>{
  const f=fixture({isMobile:true});f.editor.view.file=graphFile('Research/current.md');const canvas=f.make(f.center,'canvas');canvas.view.file={path:'Research/current.canvas'};
  const graph=await f.host.openWorkspace();const source=await f.host.openGraphNote(graphFile('Research/first.md'));
  assert.equal(await f.host.openGraphNote(graphFile('Research/next.md')),source);assert.notEqual(source,graph);assert.notEqual(source,f.editor);assert.notEqual(source,canvas);
  assert.equal(f.editor.view.file.path,'Research/current.md');assert.equal(canvas.view.file.path,'Research/current.canvas');assert.equal(graph.type,GRAPH_VIEW);assert.equal(graph.detached,undefined);
  assert.ok(!f.calls.some(call=>call[0]==='split'));assert.deepEqual(f.calls.filter(call=>call[0]==='editorLeaf').map(call=>call[1]),['tab','tab']);
  source.pinned=true;const alternate=await f.host.openGraphNote(graphFile('Research/third.md'));assert.notEqual(alternate,source);assert.equal(source.view.file.path,'Research/next.md');
});

async function legacyGraphSource(f){
  const split=f.workspace.createLeafBySplit;
  f.workspace.createLeafBySplit=(anchor,direction,before)=>split(anchor,anchor.type===GRAPH_VIEW?'horizontal':direction,anchor.type===GRAPH_VIEW?false:before);
  const source=await f.host.openGraphNote(graphFile('Research/legacy.md'));
  f.workspace.createLeafBySplit=split;
  const graph=source.splitAnchor,record=f.host.graphNoteOwnership.desktop.get(graph);delete record.layout;
  return {source,graph,record};
}

test('legacy lower source migrates once to the left and retains ownership after native split collapse',async()=>{
  const f=fixture();f.editor.view.file=graphFile('Research/current.md');
  const old=await legacyGraphSource(f),detach=old.source.detach.bind(old.source);
  old.source.detach=()=>{detach();const source=f.host.graphNoteOwnership.desktop.get(old.graph).leaf;const collapsed={direction:'vertical',children:[source.parent,old.graph.parent]};source.parent.parent=collapsed;old.graph.parent.parent=collapsed;};
  const restarted=new WorkspaceHost(f.workspace),source=await restarted.openGraphNote(graphFile('Research/first.md'));
  assert.notEqual(source,old.source);assert.equal(old.source.detached,true);assert.equal(old.graph.detached,undefined);
  assert.equal(source.splitDirection,'vertical');assert.equal(source.splitBefore,true);assert.equal(f.editor.view.file.path,'Research/current.md');
  const splits=f.calls.filter(call=>call[0]==='split').length;
  assert.equal(await new WorkspaceHost(f.workspace).openGraphNote(graphFile('Research/second.md')),source);
  assert.equal(f.calls.filter(call=>call[0]==='split').length,splits);assert.equal(source.view.file.path,'Research/second.md');
});

test('legacy source changed during replacement load is preserved instead of retired',async()=>{
  for(const change of [source=>{source.pinned=true;},source=>{source.view.file=graphFile('Research/user.md');},source=>{source.parent={};},source=>{source.id='user-moved-id';}]){
    const f=fixture(),old=await legacyGraphSource(f),split=f.workspace.createLeafBySplit;
    f.workspace.createLeafBySplit=(...args)=>{const leaf=split(...args);leaf.loadIfDeferred=async()=>change(old.source);return leaf;};
    const source=await new WorkspaceHost(f.workspace).openGraphNote(graphFile('Research/next.md'));
    assert.notEqual(source,old.source);assert.equal(old.source.detached,undefined);assert.equal(old.graph.detached,undefined);
    assert.equal(source.view.file.path,'Research/next.md');assert.equal(source.splitBefore,true);
  }
});

test('failed legacy replacement preserves old source and ownership at open, load and reveal boundaries',async()=>{
  for(const boundary of ['open','load','reveal']){
    const f=fixture(),old=await legacyGraphSource(f),split=f.workspace.createLeafBySplit;let candidate;
    f.workspace.createLeafBySplit=(...args)=>{candidate=split(...args);if(boundary==='open')candidate.openFile=async()=>{throw Error('Open failed');};if(boundary==='load')candidate.loadIfDeferred=async()=>{throw Error('Load failed');};return candidate;};
    const reveal=f.workspace.revealLeaf;
    if(boundary==='reveal')f.workspace.revealLeaf=async leaf=>{if(leaf===candidate)throw Error('Reveal failed');return reveal(leaf);};
    await assert.rejects(new WorkspaceHost(f.workspace).openGraphNote(graphFile('Research/next.md')),/failed/);
    assert.equal(old.source.detached,undefined);assert.equal(old.source.view.file.path,'Research/legacy.md');assert.equal(old.graph.detached,undefined);
    assert.equal(f.host.graphNoteOwnership.desktop.get(old.graph),old.record);
    assert.equal(candidate.detached,boundary==='open'?true:undefined);
  }
});
