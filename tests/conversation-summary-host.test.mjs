import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

async function fixture() {
  class Plugin {constructor(app){this.app=app;}}
  const obsidian={Plugin,ItemView:class{},PluginSettingTab:class{}};
  const sandbox={module:{exports:{}},exports:{},require:name=>{assert.equal(name,'obsidian');return obsidian;},console,setTimeout,clearTimeout};
  sandbox.exports=sandbox.module.exports;
  vm.runInNewContext(await readFile(new URL('../dist/notework-ai/main.js',import.meta.url),'utf8'),sandbox);
  const calls=[],app={setting:{close:()=>calls.push('settings-close')}};
  const plugin=new sandbox.module.exports.default(app);
  let resolve;const leaf={id:'graph'};
  plugin.host={openWorkspace:()=>{calls.push('open-graph');return new Promise(done=>{resolve=done;});}};
  plugin.controller={setConversationSummaryOpen:value=>calls.push(['summary-open',value])};
  return{plugin,calls,leaf,resolve:()=>resolve(leaf)};
}

test('compiled plugin opens the graph before publishing summary visibility',async()=>{
  const f=await fixture(),pending=f.plugin.openConversationSummary();
  assert.deepEqual(f.calls,['open-graph']);
  f.resolve();assert.equal(await pending,f.leaf);
  assert.deepEqual(f.calls,['open-graph',['summary-open',true]]);
});
test('compiled plugin closes settings only when the summary request originates there',async()=>{
  const f=await fixture(),pending=f.plugin.openConversationSummary({closeSettings:true});
  assert.deepEqual(f.calls,['settings-close','open-graph']);f.resolve();await pending;
  assert.deepEqual(f.calls,['settings-close','open-graph',['summary-open',true]]);
});
test('graph opening failure does not advertise a visible summary or suppress the error',async()=>{
  const f=await fixture();f.plugin.host.openWorkspace=async()=>{throw new Error('Graph unavailable');};
  await assert.rejects(f.plugin.openConversationSummary(),/Graph unavailable/);
  assert.deepEqual(f.calls,[]);
});
test('late graph opening after plugin unload cannot change controller visibility',async()=>{
  const f=await fixture(),pending=f.plugin.openConversationSummary();
  f.plugin.unloaded=true;f.resolve();assert.equal(await pending,f.leaf);
  assert.deepEqual(f.calls,['open-graph']);
});
