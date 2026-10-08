import {hasAsciiControl} from './text-safety.mjs';
import {normalizeScope} from './vault-search.mjs';

export function normalizeKnowledgeSettings(value={}) {
  if(!value||typeof value!=='object'||Array.isArray(value))value={};
  const numeric=value=>typeof value==='number'?value:typeof value==='string'&&value.trim()?Number(value):NaN;
  const positive=(number,fallback)=>Number.isSafeInteger(numeric(number))&&numeric(number)>0?numeric(number):fallback;
  // Older releases stored automatic budgets without any opt-in flags. They are
  // dormant suggestions after migration, never limits on the selected scope.
  return {
    embeddingRoute:value.embeddingRoute==='ollama'?'ollama':'lexical',
    embeddingModel:typeof value.embeddingModel==='string'?value.embeddingModel.slice(0,256):'',
    semanticRoute:['jev','llm','none'].includes(value.semanticRoute)?value.semanticRoute:'none',
    categoriesText:typeof value.categoriesText==='string'?value.categoriesText.slice(0,4000):'',
    buildLimitVersion:2,
    limitNotes:value.limitNotes===true,
    maxNotes:positive(value.maxNotes,200),
    limitCalls:value.limitCalls===true,
    maxCalls:Number.isSafeInteger(numeric(value.maxCalls))&&numeric(value.maxCalls)>=0?numeric(value.maxCalls):200,
    limitChunks:value.limitChunks===true,
    maxChunks:positive(value.maxChunks,1000)
  };
}

/** Private, vault-local runtime data. This cache is never part of a plugin release. */
export class KnowledgeIndexStore {
  constructor({adapter,directory,configDir=typeof directory==='string'?directory.slice(0,directory.lastIndexOf('/plugins/')):'',pluginId='notework-ai',device='desktop',syncedSourceLoader}) {
    const safe=value=>typeof value==='string'&&value.length<1024&&!(hasAsciiControl(value,{includeDelete:false})||/[\\:]/u.test(value))&&!value.startsWith('/')&&value.split('/').every(part=>part&&part!=='.'&&part!=='..');
    if(!safe(configDir)||!safe(directory)||typeof pluginId!=='string'||!/^[a-z0-9-]+$/.test(pluginId)||directory!==configDir+'/plugins/'+pluginId)throw new Error('Use the current vault configuration folder and this plugin runtime directory.');
    if(!['desktop','mobile'].includes(device))throw new Error('Choose a supported device cache.');
    this.adapter=adapter;this.path=directory+(device==='mobile'?'/knowledge-index-mobile.json':'/knowledge-index.json');this.fallbackPath=device==='mobile'?directory+'/knowledge-index.json':null;this.queue=Promise.resolve();
    this.syncedSourceLoader=typeof syncedSourceLoader==='function'?syncedSourceLoader:null;
  }
  serial(action) {
    const operation=this.queue.catch(()=>{}).then(action);
    this.queue=operation;return operation;
  }
  supportsReplacement() {return typeof this.adapter.rename==='function'&&typeof this.adapter.remove==='function';}
  decode(raw) {
    let index;try{index=JSON.parse(raw);}catch{throw new Error('The saved knowledge index could not be read. Rebuild it from the selected notes.');}
    if(index?.schema!==1||typeof index.id!=='string'||!Array.isArray(index.nodes)||!Array.isArray(index.chunks)||!Array.isArray(index.categories))throw new Error('The saved knowledge index format is invalid. Rebuild it from the selected notes.');
    normalizeScope(index.scope||{});return index;
  }
  async removeIfPresent(path) {if(await this.adapter.exists(path))await this.adapter.remove(path);}
  async recover(path) {
    const previous=path+'.previous';
    if(!await this.adapter.exists(previous))return null;
    const raw=await this.adapter.read(previous),index=this.decode(raw);
    // A retained backup means replacement did not commit, even if a new target
    // already exists. Validate the old cache before touching either file.
    if(!this.supportsReplacement())return index;
    await this.removeIfPresent(path);
    await this.adapter.rename(previous,path);
    // An abandoned staged cache is never a source of truth.
    try{await this.removeIfPresent(path+'.pending');}catch{/* Recovery already restored the committed cache. */}
    return null;
  }
  async readRecoveredIndex(path) {
    const recovered=await this.recover(path);if(recovered)return recovered;
    if(!await this.adapter.exists(path))return null;
    let raw;try{raw=await this.adapter.read(path);}catch{throw new Error('The saved knowledge index could not be read. Rebuild it from the selected notes.');}
    return this.decode(raw);
  }
  readIndex(path) {
    if(typeof path!=='string'||(path!==this.path&&path!==this.fallbackPath))return Promise.reject(new Error('Use this plugin knowledge cache.'));
    return this.serial(()=>this.readRecoveredIndex(path));
  }
  async syncedSource() {if(!this.fallbackPath)return null;const exported=await this.syncedSourceLoader?.();return exported||this.readRecoveredIndex(this.fallbackPath);}
  loadSyncedSource() {return this.serial(()=>this.syncedSource());}
  load() {
    return this.serial(async()=>{
      if(!this.fallbackPath)return this.readRecoveredIndex(this.path);
      // An ordinary-vault export or explicitly transferred PC cache is authoritative.
      // A standalone mobile copy never bypasses original-note verification.
      const desktop=await this.syncedSource();if(!desktop)return null;
      let mobile;try{mobile=await this.readRecoveredIndex(this.path);}catch{/* A damaged optional device copy must not block the synced PC source. */}
      return mobile?.portableImport?.sourceIndexId===desktop.id?mobile:desktop;
    });
  }
  async restorePrevious({hadOld,oldRaw}) {
    const previous=this.path+'.previous';
    if(!hadOld){await this.removeIfPresent(this.path);return;}
    if(!await this.adapter.exists(previous)) {
      if(await this.adapter.exists(this.path)&&await this.adapter.read(this.path)===oldRaw)return;
      // Keep the old bytes until commit so cancellation during backup cleanup
      // can still roll back. This writes only the private recovery file.
      await this.adapter.write(previous,oldRaw);
    }
    await this.removeIfPresent(this.path);
    await this.adapter.rename(previous,this.path);
  }
  save(index,{signal}={}) {
    return this.serial(async()=>{
      const cancelled=()=>{if(signal?.aborted)throw new DOMException('Build stopped.','AbortError');};
      cancelled();
      const data=JSON.stringify(index);
      const recovered=await this.recover(this.path);
      cancelled();
      // Minimal adapters keep the existing direct-write fallback. A backup
      // cannot be cleared safely without both rename and remove operations.
      if(!this.supportsReplacement()) {
        if(recovered)throw new Error('The interrupted knowledge index must be restored before saving with this storage adapter.');
        await this.adapter.write(this.path,data);return;
      }
      const temporary=this.path+'.pending',previous=this.path+'.previous';
      const hadOld=await this.adapter.exists(this.path),oldRaw=hadOld?await this.adapter.read(this.path):null;
      let replacing=false;
      try {
        cancelled();await this.adapter.write(temporary,data);cancelled();
        // Obsidian DataAdapter.rename refuses to overwrite an existing target.
        // Every rename below has an absent destination.
        replacing=true;
        if(hadOld)await this.adapter.rename(this.path,previous);
        cancelled();await this.adapter.rename(temporary,this.path);cancelled();
        if(hadOld)await this.adapter.remove(previous);
        cancelled();
        // Commit occurs after replacement, backup cleanup and the last abort
        // check. Loads share this queue and cannot observe an in-between state.
      } catch(error) {
        if(replacing) {
          try{await this.restorePrevious({hadOld,oldRaw});}
          catch(restoreError){throw new AggregateError([error,restoreError],'The knowledge index could not be saved or restored. The previous cache is retained for recovery when possible.');}
        }
        try{await this.removeIfPresent(temporary);}catch{/* A staged file is never loaded. */}
        throw error;
      }
    });
  }
}
