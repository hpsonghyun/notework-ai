import {Plugin,ItemView,PluginSettingTab,Notice,getAllTags,Platform,requestUrl,MarkdownRenderer,Component,TFile} from 'obsidian';
import {SecretStore} from './secret-store.mjs';
import {ApiKeyProvider} from './providers/api-key.mjs';
import {JevProvider} from './providers/jev.mjs';
import {ConnectionController} from './controller.mjs';
import {NoteworkUI} from './ui.mjs';
import {createMobileFetch} from './mobile-fetch.mjs';
import {fileTags,normalizeScope} from './vault-search.mjs';
import {KnowledgeEngine} from './knowledge-engine.mjs';
import {ConversationArchive,normalizeArchiveFolder} from './conversation-archive.mjs';
import {PromptLibrary,normalizePromptFolder,isPromptFrontmatter,DEFAULT_PROMPT_FOLDER} from './prompt-library.mjs';
import {KnowledgeIndexStore,normalizeKnowledgeSettings} from './runtime-storage.mjs';
import {WorkspaceHost,PANEL_VIEW,GRAPH_VIEW} from './workspace-host.mjs';
import {readScopedNotePreview} from './note-preview.mjs';
import {SyncKnowledgeStore} from './sync-knowledge.mjs';

export default class NoteworkPlugin extends Plugin {
  async onload() {
    if(Platform?.isDesktopApp!==true||Platform?.isMobileApp||Platform?.isMobile){
      if(!this.desktopOnlyNoticeShown){this.desktopOnlyNoticeShown=true;new Notice('Notework AI is currently desktop-only. Mobile support is paused.');}
      return;
    }
    try {
      const saved=await this.loadData() || {};
      if(this.unloaded)return;
      // Explicit allowlist; never carry unknown fields or legacy raw credentials.
      let scope;
      try {scope=normalizeScope(saved.scope || {});} catch {scope=normalizeScope({mode:'folders'});new Notice('Saved scope could not be restored. Choose your folders and tags again.');}
      let archiveFolder;
      try {archiveFolder=normalizeArchiveFolder(saved.archive?.folder || 'Notework/Chats');}catch{archiveFolder='Notework/Chats';new Notice('Saved archive folder was invalid. Notework/Chats will be used.');}
      let promptFolder;
      try{promptFolder=normalizePromptFolder(saved.prompts?.folder || DEFAULT_PROMPT_FOLDER);}catch{promptFolder=DEFAULT_PROMPT_FOLDER;new Notice('Saved prompt folder was invalid. Notework/Prompts will be used.');}
      this.isMobile=Platform.isMobileApp||Platform.isMobile||!Platform.isDesktopApp;
      this.desktopSettings={mode:saved.mode||'chatgpt',model:typeof saved.model==='string'&&saved.model.length<=512?saved.model:'',reasoningEffort:typeof saved.reasoningEffort==='string'?saved.reasoningEffort:'',knowledge:normalizeKnowledgeSettings(saved.knowledge||{embeddingRoute:'ollama'})};
      this.mobileSettings={mode:['openai','anthropic'].includes(saved.mobile?.mode)?saved.mobile.mode:'openai',model:typeof saved.mobile?.model==='string'&&saved.mobile.model.length<=512?saved.mobile.model:'',reasoningEffort:typeof saved.mobile?.reasoningEffort==='string'?saved.mobile.reasoningEffort:'',knowledge:normalizeKnowledgeSettings(saved.mobile?.knowledge||{...saved.knowledge,embeddingRoute:'lexical'})};
      this.mobileSettings.knowledge.embeddingRoute='lexical';
      const active=this.isMobile?this.mobileSettings:this.desktopSettings;
      this.settings={mode:active.mode,reasoningEffort:active.reasoningEffort,scope,knowledge:active.knowledge,archive:{folder:archiveFolder,autoSave:saved.archive?.autoSave===true},prompts:{folder:promptFolder},claude:{executablePath:saved.claude?.executablePath || '',cliJsPath:saved.claude?.cliJsPath || '',nodePath:saved.claude?.nodePath || ''}};
      this.secrets=new SecretStore(this.app.secretStorage,this.manifest.id);
      // Importing this branch is the only entry point to Node/Electron code.
      this.runtime=this.isMobile?{fetch:createMobileFetch(requestUrl),providers:{},openExternal:url=>window.open(url,'_blank','noopener')}:
        await (await import('./desktop-runtime.mjs')).createDesktopRuntime({secrets:this.secrets,settings:this.settings,pluginId:this.manifest.id,saveSettings:()=>this.saveSafeSettings()});
      if(this.unloaded){this.runtime?.dispose?.();return;}
      this.providers={
        ...this.runtime.providers,
        openai:new ApiKeyProvider({provider:'openai',secrets:this.secrets,fetchImpl:this.runtime.fetch,streamResponses:!this.isMobile}),
        anthropic:new ApiKeyProvider({provider:'anthropic',secrets:this.secrets,fetchImpl:this.runtime.fetch,streamResponses:!this.isMobile}),
        ...(!this.isMobile?{ollama:new ApiKeyProvider({provider:'ollama',secrets:this.secrets,fetchImpl:this.runtime.fetch})}:{})
      };
      this.getTags=file=>fileTags(file,this.app.metadataCache,{getAllTags});
      this.jev=new JevProvider({secrets:this.secrets,fetchImpl:this.runtime.fetch});
      this.embeddingProvider=this.runtime.embeddingProvider;
      this.knowledgeEngine=new KnowledgeEngine({vault:this.app.vault,getTags:this.getTags,embeddingProvider:this.embeddingProvider,jev:this.jev,llmCall:(input,options)=>this.providers[this.controller.state.mode].generate(input,{...options,model:this.controller.state.model})});
      this.syncStore=new SyncKnowledgeStore({adapter:this.app.vault.adapter});
      this.promptLibrary=new PromptLibrary({vault:this.app.vault,folder:promptFolder});
      this.controller=new ConnectionController({providers:this.providers,availableModes:this.isMobile?['openai','anthropic']:undefined,retrievalStrategy:this.isMobile?'lexical':undefined,requiresSyncedIndex:this.isMobile,jev:this.jev,secrets:this.secrets,hardware:this.isMobile?undefined:this.runtime.hardware,vault:this.app.vault,getTags:this.getTags,getActiveNote:()=>this.app.workspace.getActiveFile?.(),syncStore:this.syncStore,isArchiveFile:file=>this.app.metadataCache.getFileCache(file)?.frontmatter?.['notework-conversation']===true,isPromptFile:file=>isPromptFrontmatter(this.app.metadataCache.getFileCache(file)?.frontmatter),promptLibrary:this.promptLibrary,settings:this.settings,saveSettings:()=>this.saveSafeSettings(),knowledgeEngine:this.knowledgeEngine,embeddingProvider:this.embeddingProvider,indexStore:new KnowledgeIndexStore({syncedSourceLoader:this.isMobile?()=>this.syncStore.load():undefined,device:this.isMobile?'mobile':'desktop',adapter:this.app.vault.adapter,directory:this.manifest.dir || this.app.vault.configDir+'/plugins/'+this.manifest.id,configDir:this.app.vault.configDir,pluginId:this.manifest.id}),archive:new ConversationArchive({vault:this.app.vault})});
      this.host=new WorkspaceHost(this.app.workspace,{isMobile:this.isMobile});
      this.registerView(PANEL_VIEW,leaf=>new NoteworkView(leaf,this,'sidebar'));
      this.registerView(GRAPH_VIEW,leaf=>new NoteworkView(leaf,this,'workspace'));
      this.addRibbonIcon('network','Open chat',()=>this.openPanel());
      this.addCommand({id:'open-notework',name:'Open chat',callback:()=>this.openPanel()});
      this.addCommand({id:'configure-connections',name:'Configure connections',callback:()=>this.openSettings('connection')});
      this.addCommand({id:'configure-scope',name:'Configure scope',callback:()=>this.openSettings('scope')});
      this.addCommand({id:'explore-knowledge',name:'Open graph workspace',callback:()=>this.openWorkspace()});
      this.addCommand({id:'open-conversation-history',name:'Open conversation history',callback:()=>{this.controller.refreshHistory();this.openPanel('history');}});
      this.settingsTab=new NoteworkSettings(this.app,this);this.addSettingTab(this.settingsTab);
      // Register views before Obsidian restores its workspace. Storage recovery
      // must never be part of the promise Obsidian awaits to load this plugin.
      if(this.isMobile)this.controller.set({knowledge:{...this.controller.state.knowledge,phase:'empty',status:'Open Build and choose Find synced knowledge export to load your PC knowledge. Choose Use synced knowledge on this device to verify its original notes.'},archiveStatus:'Load and verify your synced knowledge before opening saved conversations.'});
      this.restorePromise=new Promise(resolve=>{this.finishRestore=value=>{resolve(value);this.finishRestore=null;};});
      const ready=()=>{
        if(this.unloaded){this.finishRestore?.(false);return;}
        try{
          this.registerVaultObservers();
          if(this.isMobile){this.finishRestore?.(false);return;}
          void this.restoreAfterLayout().then(value=>this.finishRestore?.(value),()=>this.finishRestore?.(false));
        }catch{
          this.finishRestore?.(false);
          if(!this.unloaded)new Notice('Notework background restoration could not start. Open chat to try again.');
        }
      };
      if(typeof this.app.workspace.onLayoutReady==='function')this.app.workspace.onLayoutReady(ready);
      else{const timer=window.setTimeout(ready,0);this.register(()=>window.clearTimeout(timer));}
    } catch(error) {try{this.controller?.dispose();}finally{this.runtime?.dispose?.();}new Notice('Could not open Notework. '+String(error?.message || 'Check the plugin installation.').slice(0,180));throw error;}
  }
  registerVaultObservers() {
    if(this.unloaded||this.observersRegistered)return;
    this.observersRegistered=true;
    let scopeRefreshTimer;
    const refreshScope=(file,oldPath)=>{
      if(this.unloaded||this.controller.disposed||(this.isMobile&&!this.controller.state.knowledge.index))return;
      if(file?.path)this.controller.invalidateKnowledgeCoverage(file.path);else this.controller.invalidateKnowledgeCoverage();
      if(typeof oldPath==='string')this.controller.invalidateKnowledgeCoverage(oldPath);
      if(this.controller.state.busy)return;
      window.clearTimeout(scopeRefreshTimer);
      scopeRefreshTimer=window.setTimeout(()=>{if(!this.unloaded&&!this.controller.disposed&&!this.controller.state.busy){this.controller.emit();void this.controller.refreshIndexCoverage();}},350);
    };
    this.register(()=>window.clearTimeout(scopeRefreshTimer));
    for(const event of ['changed','resolved'])this.registerEvent(this.app.metadataCache.on(event,refreshScope));
    for(const event of ['create','modify','delete','rename'])this.registerEvent(this.app.vault.on(event,refreshScope));
  }
  async restoreAfterLayout() {
    const controller=this.controller;
    if(this.unloaded||!controller||controller.disposed)return false;
    const epoch=controller.epoch,mode=controller.state.mode;
    try{
      await controller.initializeRuntime();
      if(this.unloaded||controller.disposed||this.controller!==controller||controller.epoch!==epoch||controller.state.mode!==mode||controller.state.busy)return false;
      return await this.restoreSavedConnection();
    }catch{
      if(!this.unloaded&&!controller.disposed&&this.controller===controller)controller.set({status:'Saved Notework state could not be restored. Open Notework to try again. Your saved settings are retained.'});
      return false;
    }
  }
  async restoreSavedConnection() {
    const controller=this.controller;if(this.unloaded||!controller||controller.state.busy)return false;
    const {mode}=controller.state,epoch=controller.epoch;
    const current=()=>!this.unloaded&&!controller.disposed&&this.controller===controller&&controller.state.mode===mode&&controller.epoch===epoch&&!controller.state.busy;
    try{
      if(['openai','anthropic'].includes(mode)){if(!await this.secrets.get('api-'+mode))return false;}
      else if(mode==='chatgpt'){if(!(await this.providers.chatgpt.status()).connected)return false;}
      else if(!['codex','claude-code'].includes(mode))return false;
      if(!current())return false;
      const preferred=(this.isMobile?this.mobileSettings:this.desktopSettings)?.model;
      const reconnect=controller.connect({reuseSession:true}),connectionEpoch=controller.epoch;
      await reconnect;
      if(this.unloaded||controller.disposed||this.controller!==controller||controller.state.mode!==mode||controller.epoch!==connectionEpoch||controller.state.busy)return false;
      // A later user action owns its selection. Restoration changes only the
      // catalog's initial default and never persists an identical saved model.
      if(controller.state.verified&&preferred&&controller.state.model!==preferred&&controller.state.model===controller.state.models[0]?.id&&controller.state.models.some(model=>model.id===preferred))controller.selectModel(preferred,{persist:false});
      return controller.state.verified;
    }catch{
      if(current())controller.set({status:'Saved connection could not be restored. Your saved credentials are retained; choose Connect to try again.'});
      return false;
    }
  }
  async saveSafeSettings() {
    if(this.unloaded)return;
    const active=this.isMobile?this.mobileSettings:this.desktopSettings;
    active.mode=this.settings.mode;active.reasoningEffort=this.settings.reasoningEffort;active.knowledge=normalizeKnowledgeSettings(this.settings.knowledge);
    if(this.controller?.state.models.some(model=>model.id===this.controller.state.model))active.model=this.controller.state.model;
    await this.saveData({mode:this.desktopSettings.mode,model:this.desktopSettings.model,reasoningEffort:this.desktopSettings.reasoningEffort,scope:normalizeScope(this.settings.scope),knowledge:normalizeKnowledgeSettings(this.desktopSettings.knowledge),mobile:{mode:this.mobileSettings.mode,model:this.mobileSettings.model,reasoningEffort:this.mobileSettings.reasoningEffort,knowledge:normalizeKnowledgeSettings(this.mobileSettings.knowledge)},archive:{folder:normalizeArchiveFolder(this.settings.archive.folder),autoSave:this.settings.archive.autoSave===true},prompts:{folder:normalizePromptFolder(this.settings.prompts.folder)},claude:{executablePath:this.settings.claude.executablePath,cliJsPath:this.settings.claude.cliJsPath,nodePath:this.settings.claude.nodePath}});
  }
  mount(root,surface='settings') {
    return new NoteworkUI(root,this.controller,{
      surface,isMobile:this.isMobile,graphOnly:surface==='workspace'&&!this.isMobile,mobileCapabilities:this.isMobile?{subscriptions:false,localModels:false,localEmbeddings:false,hardware:false,knowledgeBuild:false,syncedIndexRequired:true}:undefined,version:this.manifest.version,vaultName:this.app.vault.getName(),vaultPath:this.app.vault.adapter.getBasePath?.(),
      markdown:{renderMarkdown:(text,element,path,component)=>MarkdownRenderer.render(this.app,text,element,path,component),createComponent:()=>new Component()},
      onOpenSettings:view=>this.openSettings(view || 'setup'),onOpenWorkspace:()=>this.openWorkspace({closeSettings:surface==='settings'}),onExpandGraph:()=>this.openWorkspace({closeSettings:surface==='settings'}),onReturnSidebar:()=>this.openPanel('chat',{closeSettings:surface==='settings'}),
      onShowConversationSummary:()=>this.openConversationSummary({closeSettings:surface==='settings'}),
      onShowConversationQuestion:!this.isMobile?id=>{
        const leaf=this.app.workspace.getLeavesOfType(PANEL_VIEW).find(candidate=>candidate.getRoot?.()===this.app.workspace.rightSplit);
        return leaf?.view?.ui?.scrollToQuestion(id);
      }:undefined,
      onFolders:()=>{
        const vault=this.app.vault;
        const folders=typeof vault.getAllFolders==='function'?vault.getAllFolders(false):vault.getAllLoadedFiles().filter(file=>Array.isArray(file.children));
        return folders.map(folder=>folder.path).filter(Boolean);
      },
      onOpenNote:note=>{
        const file=this.app.vault.getAbstractFileByPath(note);
        if(!file||typeof file.extension!=='string')throw new Error('This source note is no longer available.');
        return this.host.openSource(file);
      },
      onOpenGraphNote:surface==='workspace'&&!this.isMobile?note=>{
        const file=typeof note==='string'?this.app.vault.getAbstractFileByPath(note):null;
        if(!(file instanceof TFile)||file.extension.toLowerCase()!=='md'||!this.controller.scopeFiles().some(candidate=>candidate.path===file.path))throw new Error('This source note is no longer available in the current scope.');
        return this.host.openGraphNote(file);
      }:undefined,
      onReadNote:note=>readScopedNotePreview({vault:this.app.vault,scopeFiles:()=>this.controller.scopeFiles(),path:note,isArchiveFile:file=>this.app.metadataCache.getFileCache(file)?.frontmatter?.['notework-conversation']===true}),
      onLink:url=>this.runtime.openExternal(url),
      onHardware:this.runtime.hardware,
      onClaudeConfig:!this.isMobile?async config=>this.controller.run(async({current,update})=>{
        Object.assign(this.settings.claude,config);await this.saveSafeSettings();
        if(!current())return;
        this.providers['claude-code']=this.runtime.createClaude();
        update({models:[],model:'',verified:false,consent:false,connection:'unconfigured',connectionPhase:'',connectionIssue:'',loginUrl:'',status:'Claude Code installation path saved. Connect again to continue.'});
      }):undefined
    });
  }
  async openPanel(view='chat',options={}) {
    if(options.closeSettings)this.app.setting.close();
    return this.host.openPanel(view);
  }
  async openWorkspace({closeSettings=false}={}) {
    if(closeSettings)this.app.setting.close();
    return this.host.openWorkspace();
  }
  async openConversationSummary({closeSettings=false}={}) {
    const leaf=await this.openWorkspace({closeSettings});
    if(!this.unloaded)this.controller.setConversationSummaryOpen(true);
    return leaf;
  }
  openSettings(view='setup') {
    this.settingsTab.requestedView=view;
    this.app.setting.open();this.app.setting.openTabById(this.manifest.id);
    this.settingsTab.ui?.setView(view);
  }
  onunload() {this.unloaded=true;this.finishRestore?.(false);try{this.controller?.dispose();}finally{this.runtime?.dispose?.();}}
}
class NoteworkView extends ItemView {
  constructor(leaf,plugin,surface){super(leaf);this.plugin=plugin;this.surface=surface;}
  getViewType(){return this.surface==='workspace'?GRAPH_VIEW:PANEL_VIEW;}
  getDisplayText(){return this.surface==='workspace'&&!this.plugin.isMobile?'Notework graph':'Notework';}
  getIcon(){return 'network';}
  async onOpen(){this.contentEl.empty();this.contentEl.addClass('notework-view-content');this.ui=this.plugin.mount(this.contentEl.createDiv(),this.surface);}
  async onClose(){this.ui?.destroy();if(this.surface==='workspace'&&!this.plugin.isMobile&&!this.plugin.unloaded)this.plugin.controller?.setConversationSummaryOpen(false);}
}
class NoteworkSettings extends PluginSettingTab {
  constructor(app,plugin){super(app,plugin);this.plugin=plugin;}
  display(){this.ui?.destroy();this.containerEl.empty();this.ui=this.plugin.mount(this.containerEl.createDiv(),'settings');if(this.requestedView)this.ui.setView(this.requestedView);}
  hide(){this.ui?.destroy();}
}
