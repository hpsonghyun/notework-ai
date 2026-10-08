export const PANEL_VIEW='notework-ai-panel';
export const GRAPH_VIEW='notework-ai-workspace';
const GRAPH_NOTE_OWNERSHIP=Symbol.for('notework-ai.graph-note-ownership.v1');

// Keep Obsidian's editor leaves intact. Only our own views are reused/migrated.
export class WorkspaceHost {
  constructor(workspace,{isMobile=false}={}) {this.workspace=workspace;this.isMobile=isMobile;this.pendingPanel=null;this.pendingGraph=null;this.pendingMobile=null;this.graphNoteQueue=Promise.resolve();if(!workspace[GRAPH_NOTE_OWNERSHIP])workspace[GRAPH_NOTE_OWNERSHIP]={desktop:new Map(),mobile:null};this.graphNoteOwnership=workspace[GRAPH_NOTE_OWNERSHIP];}
  async openPanel(view='chat') {
    if(this.isMobile)return this.openMobile(view);
    if(this.pendingPanel){const leaf=await this.pendingPanel;leaf.view?.ui?.setView(view);return leaf;}
    this.pendingPanel=this.openSide(view);
    try{return await this.pendingPanel;}finally{this.pendingPanel=null;}
  }
  async openSide(view) {
    const workspace=this.workspace;
    const existing=workspace.getLeavesOfType(PANEL_VIEW);
    let leaf=existing.find(candidate=>candidate.getRoot?.()===workspace.rightSplit);
    if(!leaf){
      leaf=workspace.getRightLeaf(false);
      if(!leaf)throw new Error('The right sidebar is unavailable.');
      await leaf.setViewState({type:PANEL_VIEW,active:true,state:{view}});
      // Older versions opened this plugin in the editor. Retire only that view.
      for(const previous of existing)if(previous!==leaf)previous.detach();
    }
    workspace.rightSplit?.expand?.();
    await workspace.revealLeaf(leaf);
    await leaf.loadIfDeferred?.();
    leaf.view?.ui?.setView(view);
    return leaf;
  }
  async openWorkspace() {
    if(this.isMobile)return this.openMobile('graph');
    if(this.pendingGraph)return this.pendingGraph;
    this.pendingGraph=this.openGraph();
    try{return await this.pendingGraph;}finally{this.pendingGraph=null;}
  }
  async openMobile(view) {
    if(!this.pendingMobile)this.pendingMobile=this.createMobileLeaf();
    const pending=this.pendingMobile;
    try{const leaf=await pending;await this.workspace.revealLeaf(leaf);await leaf.loadIfDeferred?.();leaf.view?.ui?.setView(view);return leaf;}finally{if(this.pendingMobile===pending)this.pendingMobile=null;}
  }
  async createMobileLeaf() {
    const workspace=this.workspace;let leaf=workspace.getLeavesOfType(GRAPH_VIEW).find(candidate=>candidate.getRoot?.()===workspace.rootSplit);
    if(!leaf){leaf=workspace.getLeaf('tab');await leaf.setViewState({type:GRAPH_VIEW,active:true,state:{view:'chat'}});}
    return leaf;
  }
  async openGraph() {
    const workspace=this.workspace;
    // The graph is an additional native pane. Keep the conversation visible in
    // the right sidebar so each view gets its own full-height reading area.
    await this.openPanel('chat');
    const graphs=workspace.getLeavesOfType(GRAPH_VIEW);
    let leaf=graphs.find(candidate=>candidate.getRoot?.()===workspace.rootSplit);
    const recent=workspace.getMostRecentLeaf?.(workspace.rootSplit);
    const isEditor=candidate=>candidate&&candidate!==leaf&&candidate.getRoot?.()===workspace.rootSplit&&!['empty',PANEL_VIEW,GRAPH_VIEW].includes(candidate.view?.getViewType?.());
    const editor=isEditor(recent)?recent:isEditor(this.editorLeaf)?this.editorLeaf:['markdown','canvas'].flatMap(type=>workspace.getLeavesOfType(type)).find(isEditor);
    if(editor)this.editorLeaf=editor;
    // A legacy graph tab shared the editor's tab group, hiding the current note.
    if(leaf&&editor&&leaf.parent===editor.parent){leaf.detach();leaf=null;}
    if(!leaf){
      leaf=editor?workspace.createLeafBySplit(editor,'vertical'):workspace.getLeaf('split','vertical');
      await leaf.setViewState({type:GRAPH_VIEW,active:true});
      // A graph dragged into a sidebar must not disappear when it collapses.
      for(const previous of graphs)if(previous!==leaf&&!previous.detached)previous.detach();
    }
    await workspace.revealLeaf(leaf);await leaf.loadIfDeferred?.();
    return leaf;
  }
  async openSource(file) {
    const workspace=this.workspace;
    const isDocument=leaf=>leaf&&leaf.getRoot?.()===workspace.rootSplit&&leaf.view?.getViewType?.()==='markdown';
    const documents=workspace.getLeavesOfType('markdown').filter(isDocument);
    let leaf=documents.find(candidate=>candidate.view?.file?.path===file.path);
    if(!leaf){
      const editable=candidate=>isDocument(candidate)&&candidate.getViewState?.().pinned!==true;
      const recent=workspace.getMostRecentLeaf?.(workspace.rootSplit);
      leaf=editable(this.editorLeaf)?this.editorLeaf:editable(recent)?recent:documents.find(editable);
      if(!leaf){
        const anchor=workspace.getLeavesOfType(GRAPH_VIEW).find(candidate=>candidate.getRoot?.()===workspace.rootSplit)||this.editorLeaf;
        leaf=this.isMobile?workspace.getLeaf('tab'):anchor?.getRoot?.()===workspace.rootSplit?workspace.createLeafBySplit(anchor,'vertical'):workspace.getLeaf('split','vertical');
      }
      await leaf.openFile(file);
    }
    this.editorLeaf=leaf;
    await workspace.revealLeaf(leaf);
    return leaf;
  }
  async openGraphNote(file) {
    if(!file||typeof file.path!=='string'||!file.path||typeof file.extension!=='string'||file.extension.toLowerCase()!=='md')throw new Error('Choose an available Markdown source note.');
    // Rapid graph clicks share one native pane and open in their actual order.
    const pending=this.graphNoteQueue.catch(()=>{}).then(()=>this.openOwnedGraphNote(file));
    this.graphNoteQueue=pending;return pending;
  }
  liveLeaf(leaf,type) {
    return !!leaf&&leaf.detached!==true&&leaf.getRoot?.()===this.workspace.rootSplit&&leaf.view?.getViewType?.()===type&&this.workspace.getLeavesOfType(type).includes(leaf);
  }
  ownedGraphNote(record,graph) {
    if(!record||!this.liveLeaf(record.leaf,'markdown')||record.leaf.getViewState?.().pinned===true)return false;
    if(record.leaf.id!==record.noteId||record.leaf.parent!==record.noteParent||record.leaf.view?.file?.path!==record.filePath)return false;
    if(graph&&(record.graph!==graph||record.graphId!==graph.id||!this.liveLeaf(graph,GRAPH_VIEW)||graph.parent!==record.graphParent||graph.parent?.parent!==record.branch||record.leaf.parent?.parent!==record.branch))return false;
    return true;
  }
  async openOwnedGraphNote(file) {
    const workspace=this.workspace;
    const graph=await this.openWorkspace();
    let record=this.isMobile?this.graphNoteOwnership.mobile:this.graphNoteOwnership.desktop.get(graph);
    let leaf=this.ownedGraphNote(record,this.isMobile?null:graph)?record.leaf:null;
    const previous=!this.isMobile&&leaf&&record.layout!=='left-v1'?record:null;
    if(previous)leaf=null;
    if(!leaf){
      // Place the source to the left of the graph. Split only our graph's tab
      // group, leaving every existing editor, canvas and pinned note intact.
      leaf=this.isMobile?workspace.getLeaf('tab'):workspace.createLeafBySplit(graph,'vertical',true);
      if(!leaf||leaf===graph)throw new Error('A separate source note pane is unavailable.');
      record={leaf,noteId:leaf.id,noteParent:leaf.parent,graph,graphId:graph.id,graphParent:graph.parent,branch:graph.parent?.parent,filePath:null,layout:this.isMobile?'tab':'left-v1'};
      if(this.isMobile)this.graphNoteOwnership.mobile=record;else this.graphNoteOwnership.desktop.set(graph,record);
    }
    try{
      if(leaf.view?.file?.path!==file.path)await leaf.openFile(file);
      record.filePath=file.path;
      await leaf.loadIfDeferred?.();await workspace.revealLeaf(leaf);
      // Opening the new split changes the graph's ancestors. Revalidate the
      // old source itself before retiring a legacy lower pane, then refresh
      // anchors after Obsidian collapses that pane's now-empty split.
      if(previous&&this.ownedGraphNote(previous,null)&&graph.id===previous.graphId&&this.ownedGraphNote(record,graph)){
        previous.leaf.detach();
        record.noteParent=leaf.parent;record.graphParent=graph.parent;record.branch=graph.parent?.parent;
      }
      return leaf;
    }catch(error){
      // Failed opens relinquish ownership; never reclaim a partially changed view.
      if(this.isMobile)this.graphNoteOwnership.mobile=null;
      else if(previous){
        // An untouched empty split can be rolled back. Keep the previous
        // source and its ownership even when the replacement failed to load.
        if(this.liveLeaf(leaf,'empty')&&leaf.id===record.noteId&&leaf.parent===record.noteParent&&leaf.getViewState?.().pinned!==true){
          leaf.detach();
          if(this.ownedGraphNote(previous,null)&&this.liveLeaf(graph,GRAPH_VIEW)&&graph.id===previous.graphId){previous.graphParent=graph.parent;previous.branch=graph.parent?.parent;}
        }
        this.graphNoteOwnership.desktop.set(graph,previous);
      }else this.graphNoteOwnership.desktop.delete(graph);
      throw error;
    }
  }
}
