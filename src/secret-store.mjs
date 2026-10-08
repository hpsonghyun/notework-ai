import {sha256HexSync} from './portable-crypto.mjs';
const writes=new WeakMap();

// Obsidian SecretStorage is vault-local, not an OS keychain or plugin isolation.
// No credential value is saved to plugin data.json or a synced Markdown file.
export class SecretStore {
  constructor(storage,prefix='notework-ai') {
    if (!storage?.getSecret || !storage?.setSecret) throw new Error('Open this plugin in Obsidian 1.11.4 or later. SecretStorage support is required.');
    this.storage = storage;this.prefix=prefix;
  }
  id(name) { return this.prefix+'-'+sha256HexSync(name).slice(0,32); }
  async get(name) {
    const id=this.id(name);await writes.get(this.storage)?.get(id);
    return await this.storage.getSecret(id) || null;
  }
  async write(name,value) {
    const id=this.id(name);let queue=writes.get(this.storage);
    if(!queue){queue=new Map();writes.set(this.storage,queue);}
    // Stores sharing this module and storage serialize writes to the same key.
    const pending=(queue.get(id)||Promise.resolve()).catch(()=>{}).then(()=>this.storage.setSecret(id,value));
    queue.set(id,pending);
    try{await pending;}finally{if(queue.get(id)===pending)queue.delete(id);}
  }
  async set(name,value) {
    if (typeof value !== 'string') throw new Error('Invalid credential format.');
    await this.write(name,value);
  }
  async delete(name) { await this.write(name,''); }
}
