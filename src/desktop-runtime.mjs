// This module is loaded only after Platform.isDesktopApp is checked.
import {shell} from 'electron';
import os from 'node:os';
import path from 'node:path';
import {mkdir} from 'node:fs/promises';
import {ChatGPTSubscription} from './providers/chatgpt.mjs';
import {CodexSubscriptionProvider} from './providers/codex-subscription.mjs';
import {ClaudeCodeProvider} from './providers/claude-code.mjs';
import {OllamaEmbeddingsProvider} from './providers/ollama-embeddings.mjs';
import {desktopFetch} from './desktop-fetch.mjs';
export async function createDesktopRuntime({secrets,settings,pluginId,saveSettings}) {
  const lifetime=new AbortController(),managed=new Set();
  const closedError=()=>Object.assign(new Error('Notework was closed. Reopen the plugin to continue.'),{name:'AbortError',code:'CANCELLED'});
  const withSignal=options=>({...options,signal:options?.signal?AbortSignal.any([options.signal,lifetime.signal]):lifetime.signal});
  const fetchImpl=(url,options)=>{if(lifetime.signal.aborted)return Promise.reject(closedError());return desktopFetch(url,withSignal(options));};
  const manage=provider=>{
    managed.add(provider);
    for(const method of ['connect','listModels','generate'])if(typeof provider[method]==='function'){
      const original=provider[method];
      provider[method]=async(...args)=>{if(lifetime.signal.aborted)throw closedError();const index=method==='generate'?1:0;args[index]=withSignal(args[index]);return original.apply(provider,args);};
    }
    return provider;
  };
  let chatgptConfig={};try{chatgptConfig=JSON.parse(await secrets.get('chatgpt-host-config')||'{}');}catch{/* An invalid optional host config falls back to provider defaults. */}
  const cwd=path.join(os.tmpdir(),'notework-claude-'+pluginId);await mkdir(cwd,{recursive:true});
  const codexCwd=path.join(os.tmpdir(),'notework-codex-'+pluginId);await mkdir(codexCwd,{recursive:true});
  const claude=()=>{if(lifetime.signal.aborted)throw closedError();return manage(new ClaudeCodeProvider({config:settings.claude,cwd,onConfig:async partial=>{Object.assign(settings.claude,partial);await saveSettings();}}));};
  const providers={chatgpt:manage(new ChatGPTSubscription({secrets,config:chatgptConfig,onConfig:async partial=>{Object.assign(chatgptConfig,partial);await secrets.set('chatgpt-host-config',JSON.stringify(chatgptConfig));},openExternal:url=>shell.openExternal(url),fetchImpl})),codex:manage(new CodexSubscriptionProvider({cwd:codexCwd,openExternal:url=>shell.openExternal(url)})),'claude-code':claude()};
  return {fetch:fetchImpl,openExternal:url=>shell.openExternal(url),hardware:()=>({ramGiB:(os.totalmem()/2**30).toFixed(1),freeGiB:(os.freemem()/2**30).toFixed(1),threads:os.availableParallelism?.()||os.cpus().length}),createClaude:claude,embeddingProvider:new OllamaEmbeddingsProvider({fetchImpl}),providers,
    dispose(){
      if(lifetime.signal.aborted)return;lifetime.abort(closedError());
      for(const provider of managed){
        try{provider.dispose?.();}catch{/* Continue closing the remaining providers if one dispose fails. */}
        // Close only this runtime's transport/processes; never call account logout,
        // token revocation, disconnect, or delete a stored credential on unload.
        for(const operation of [...(provider.active||[])])try{if(typeof operation.close==='function')operation.close(closedError());else operation.kill?.('SIGTERM');}catch{/* Continue closing remaining transports; account state is preserved. */}
      }
    }};
}
