import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {configPathWithinVault, deploymentManifest, deploymentPlan, refreshDeploymentRuntime, sourceFingerprint, verifyBuildProvenance, writeBuildProvenance} from '../scripts/deployment-guard.mjs';

const vaultRoot = 'C:\\workspace\\work-vault';
const snapshot = () => ({desktop: true,
  vault: {name: 'work-vault', root: vaultRoot, configDir: '.obsidian-desktop'},
  plugin: {installed: true, loaded: true, enabled: true, busy: false},
  sync: {present: true, enabled: true, filterKnown: true, activePluginList: false, pluginData: false}});
const plan = value => deploymentPlan(value, {vaultName: 'work-vault', vaultRoot});

test('deployment is blocked when either Sync community plugin channel is allowed', () => {
  for (const key of ['activePluginList', 'pluginData']) {
    const value = snapshot(); value.sync[key] = true;
    assert.throws(() => plan(value), /Disable Sync/);
  }
});

test('deployment refuses unknown active Sync filters and busy plugins', () => {
  const unknown = snapshot(); unknown.sync.filterKnown = false;
  assert.throws(() => plan(unknown), /could not be verified/);
  const busy = snapshot(); busy.plugin.busy = true;
  assert.throws(() => plan(busy), /idle/);
});

test('disabled and enabled-but-unloaded states are left unloaded', () => {
  for (const enabled of [false, true]) {
    const value = snapshot(); value.plugin = {installed: true, loaded: false, enabled, busy: null};
    const result = plan(value);
    assert.equal(result.resumeRuntime, false);
    assert.equal(result.previouslyEnabled, enabled);
  }
  assert.equal(plan(snapshot()).resumeRuntime, true);
});

test('deployment uses the actual configuration profile and rejects vault mismatches', () => {
  assert.equal(plan(snapshot()).pluginRoot, 'C:\\workspace\\work-vault\\.obsidian-desktop\\plugins\\notework-ai');
  const wrong = snapshot(); wrong.vault.root = 'C:\\workspace\\personal-vault';
  assert.throws(() => plan(wrong), /different vault/);
  const missing = snapshot(); missing.vault.root = '';
  assert.throws(() => plan(missing), /different vault/);
});

test('configuration paths cannot escape the selected vault', () => {
  for (const config of ['../outside', '.obsidian/../../outside', '..\\outside', 'C:\\outside', '/outside', '\\\\host\\share', '.obsidian:stream', '.obsidian/..', '.obsidian.']) {
    assert.throws(() => configPathWithinVault(vaultRoot, config));
  }
  assert.equal(configPathWithinVault(vaultRoot, '.obsidian-mobile'), 'C:\\workspace\\work-vault\\.obsidian-mobile');
});

async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'notework-deploy-guard-'));
  try {
    await mkdir(path.join(root, 'src')); await mkdir(path.join(root, 'scripts'));
    const dist = path.join(root, 'dist'); await mkdir(dist);
    for (const name of ['build.mjs', 'package.json', 'scripts/deployment-guard.mjs', 'scripts/deploy-local.mjs', 'src/main.mjs']) {
      await writeFile(path.join(root, name), `fixture:${name}`);
    }
    const manifest = JSON.stringify({id: 'notework-ai', version: '0.4.6'});
    await writeFile(path.join(root, 'manifest.json'), manifest);
    await writeFile(path.join(root, 'styles.css'), '.fixture{}');
    await writeFile(path.join(dist, 'manifest.json'), manifest);
    await writeFile(path.join(dist, 'styles.css'), '.fixture{}');
    await writeFile(path.join(dist, 'main.js'), 'module.exports={};');
    await writeBuildProvenance(root, dist);
    await run(root, dist);
  } finally { await rm(root, {recursive: true, force: true}); }
}

test('a source edit after build blocks deployment of the stale bundle', async () => {
  await fixture(async (root, dist) => {
    await verifyBuildProvenance(root, dist);
    await writeFile(path.join(root, 'src/main.mjs'), 'changed after build');
    await assert.rejects(verifyBuildProvenance(root, dist), /Build is stale/);
  });
});

test('a changed built asset cannot use old provenance', async () => {
  await fixture(async (root, dist) => {
    await writeFile(path.join(dist, 'main.js'), 'replaced bundle');
    await assert.rejects(verifyBuildProvenance(root, dist), /asset fingerprint changed/);
  });
});

test('a source edit during a build cannot certify the earlier compiled bundle', async () => {
  await fixture(async (root, dist) => {
    const before = await sourceFingerprint(root);
    await writeFile(path.join(root, 'src/main.mjs'), 'changed while building');
    await assert.rejects(writeBuildProvenance(root, dist, before.digest), /Source changed while building/);
  });
});

const oldManifest = {id: 'notework-ai', version: '0.4.6', isDesktopOnly: false};
const newManifest = {id: 'notework-ai', version: '0.4.7', isDesktopOnly: true};

function runtimeFixture({enabled = true, resumeRuntime = true, disk = newManifest} = {}) {
  const calls = [], filters = new Set(), enabledPlugins = new Set(['unrelated-plugin']);
  if (enabled) enabledPlugins.add('notework-ai');
  const plugins = {
    manifests: {'notework-ai': {...oldManifest}}, plugins: {}, enabledPlugins,
    async loadManifests() { calls.push('refresh'); this.manifests['notework-ai'] = {...disk}; },
    async enablePlugin(id) { calls.push('enable'); this.plugins[id] = {manifest: {...this.manifests[id]}, restorePromise: Promise.resolve(true)}; },
    async disablePlugin(id) { calls.push('disable'); delete this.plugins[id]; },
  };
  const app = {isMobile: false, plugins,
    vault: {getName: () => 'work-vault', configDir: '.obsidian-desktop', adapter: {getBasePath: () => vaultRoot}},
    internalPlugins: {plugins: {sync: {enabled: true, instance: {filter: {allowSpecialFiles: filters}}}}},
  };
  Object.defineProperty(app, 'secretStorage', {get() { assert.fail('Deployment cannot inspect credentials.'); }});
  const options = {vaultName: 'work-vault', vaultRoot, configDir: '.obsidian-desktop', resumeRuntime, previouslyEnabled: enabled};
  return {app, options, calls, filters, enabledBefore: [...enabledPlugins].sort()};
}

test('new deployment requires a desktop-only manifest while recovery accepts the original platform policy', () => {
  assert.deepEqual(deploymentManifest(newManifest, {desktopOnly: true}), newManifest);
  assert.deepEqual(deploymentManifest(oldManifest), oldManifest);
  assert.throws(() => deploymentManifest(oldManifest, {desktopOnly: true}), /desktop-only/);
  for (const value of [undefined, null, 'true']) assert.throws(() => deploymentManifest({...newManifest, isDesktopOnly: value}), /invalid/);
  assert.throws(() => deploymentManifest({...newManifest, id: 'different-plugin'}), /invalid/);
});

test('asynchronous disk manifest refresh finishes and is verified before enabling the runtime', async () => {
  const f = runtimeFixture();
  let finish;
  f.app.plugins.loadManifests = async () => {
    f.calls.push('refresh');
    await new Promise(resolve => { finish = resolve; });
    f.app.plugins.manifests['notework-ai'] = {...newManifest};
  };
  const restoring = refreshDeploymentRuntime(f.app, newManifest, f.options);
  await Promise.resolve();
  assert.deepEqual(f.calls, ['refresh']);
  assert.equal(f.app.plugins.plugins['notework-ai'], undefined);
  finish();
  const result = await restoring;
  assert.deepEqual(f.calls, ['refresh', 'enable']);
  assert.equal(result.manifest.status, 'completed');
  assert.equal(result.version, '0.4.7');
  assert.equal(result.isDesktopOnly, true);
  assert.deepEqual([...f.app.plugins.enabledPlugins].sort(), f.enabledBefore);
});

for (const enabled of [false, true]) test('manifest refresh preserves previously unloaded plugin with enabled=' + enabled, async () => {
  const f = runtimeFixture({enabled, resumeRuntime: false});
  const result = await refreshDeploymentRuntime(f.app, newManifest, f.options);
  assert.deepEqual(f.calls, ['refresh']);
  assert.equal(result.manifest.status, 'completed');
  assert.equal(result.load, 'left_unloaded');
  assert.equal(f.app.plugins.plugins['notework-ai'], undefined);
  assert.deepEqual([...f.app.plugins.enabledPlugins].sort(), f.enabledBefore);
});

for (const [name, changed] of [
  ['plugin id', {...newManifest, id: 'different-plugin'}],
  ['cached version', {...oldManifest, isDesktopOnly: true}],
  ['false platform policy', {...newManifest, isDesktopOnly: false}],
  ['missing platform policy', {id: 'notework-ai', version: '0.4.7'}],
  ['null platform policy', {...newManifest, isDesktopOnly: null}],
  ['string platform policy', {...newManifest, isDesktopOnly: 'true'}],
]) test('a refreshed manifest with wrong ' + name + ' never enables the plugin', async () => {
  const f = runtimeFixture({disk: changed});
  const result = await refreshDeploymentRuntime(f.app, newManifest, f.options);
  assert.equal(result.manifest.status, 'mismatch');
  assert.deepEqual(f.calls, ['refresh']);
});

test('a manifest disappearing during refresh blocks startup', async () => {
  const f = runtimeFixture();
  f.app.plugins.loadManifests = async () => { f.calls.push('refresh'); delete f.app.plugins.manifests['notework-ai']; };
  await assert.rejects(refreshDeploymentRuntime(f.app, newManifest, f.options), /disappeared/);
  assert.deepEqual(f.calls, ['refresh']);
});

for (const [name, runtimeManifest] of [
  ['absent runtime', null],
  ['wrong runtime version', oldManifest],
  ['wrong runtime platform policy', {...newManifest, isDesktopOnly: false}],
]) test('correct cache does not hide ' + name, async () => {
  const f = runtimeFixture();
  f.app.plugins.enablePlugin = async id => { f.calls.push('enable'); if (runtimeManifest) f.app.plugins.plugins[id] = {manifest: runtimeManifest}; };
  const result = await refreshDeploymentRuntime(f.app, newManifest, f.options);
  assert.equal(result.load, 'failed');
  assert.equal(f.app.plugins.plugins['notework-ai'], undefined);
  assert.deepEqual(f.calls, runtimeManifest ? ['refresh', 'enable', 'disable'] : ['refresh', 'enable']);
  assert.deepEqual([...f.app.plugins.enabledPlugins].sort(), f.enabledBefore);
});

test('missing and rejected manifest refresh never initiate enable', async () => {
  const missing = runtimeFixture(); delete missing.app.plugins.loadManifests;
  await assert.rejects(refreshDeploymentRuntime(missing.app, newManifest, missing.options), /cannot refresh/);
  assert.deepEqual(missing.calls, []);
  for (const rejected of [false, true]) {
    const f = runtimeFixture();
    f.app.plugins.loadManifests = () => { f.calls.push('refresh'); if (rejected) return Promise.reject(new Error('synthetic')); throw new Error('synthetic'); };
    const result = await refreshDeploymentRuntime(f.app, newManifest, f.options);
    assert.equal(result.manifest.status, 'failed');
    assert.deepEqual(f.calls, ['refresh']);
  }
});

test('a late refresh after timeout cannot initiate enable', async () => {
  const f = runtimeFixture(); let finish;
  f.app.plugins.loadManifests = async () => { f.calls.push('refresh'); await new Promise(resolve => { finish = resolve; }); f.app.plugins.manifests['notework-ai'] = {...newManifest}; };
  const result = await refreshDeploymentRuntime(f.app, newManifest, {...f.options, timeoutMs: 10});
  assert.equal(result.manifest.status, 'pending');
  finish(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(f.calls, ['refresh']);
  assert.equal(f.app.plugins.plugins['notework-ai'], undefined);
});

for (const [name, change] of [
  ['vault name', f => { f.app.vault.getName = () => 'other-vault'; }],
  ['vault root', f => { f.app.vault.adapter.getBasePath = () => 'C:\\other-vault'; }],
  ['configuration profile', f => { f.app.vault.configDir = '.obsidian-other'; }],
  ['Sync active plugin list', f => { f.filters.add('community-plugin'); }],
  ['Sync plugin data', f => { f.filters.add('community-plugin-data'); }],
  ['unknown Sync filters', f => { f.app.internalPlugins.plugins.sync.instance.filter.allowSpecialFiles = null; }],
  ['enabled plugin membership', f => { f.app.plugins.enabledPlugins.add('new-unrelated-plugin'); }],
  ['unexpected busy runtime', f => { f.app.plugins.plugins['notework-ai'] = {controller: {state: {busy: true}}}; }],
]) test('changing ' + name + ' during refresh blocks enable', async () => {
  const f = runtimeFixture();
  const reload = f.app.plugins.loadManifests;
  f.app.plugins.loadManifests = async () => { await reload.call(f.app.plugins); change(f); };
  await assert.rejects(refreshDeploymentRuntime(f.app, newManifest, f.options));
  assert.deepEqual(f.calls, ['refresh']);
});

test('mobile, inaccessible and already loaded hosts are rejected before refresh', async () => {
  for (const mutate of [f => { f.app.isMobile = true; }, f => { delete f.app.vault.adapter.getBasePath; }, f => { f.app.plugins.plugins['notework-ai'] = {controller: {state: {busy: false}}}; }]) {
    const f = runtimeFixture(); mutate(f);
    await assert.rejects(refreshDeploymentRuntime(f.app, newManifest, f.options));
    assert.deepEqual(f.calls, []);
  }
});

for (const [enabled, resumeRuntime] of [[true, true], [true, false], [false, false]]) test('rollback refreshes original disk policy with enabled=' + enabled + ', resume=' + resumeRuntime, async () => {
  const f = runtimeFixture({enabled, resumeRuntime, disk: oldManifest});
  f.app.plugins.manifests['notework-ai'] = {...newManifest};
  const result = await refreshDeploymentRuntime(f.app, deploymentManifest(oldManifest), f.options);
  assert.equal(result.manifest.status, 'completed');
  assert.equal(result.manifest.version, '0.4.6');
  assert.equal(result.manifest.isDesktopOnly, false);
  assert.equal(result.load, resumeRuntime ? 'completed' : 'left_unloaded');
  assert.deepEqual(f.calls, resumeRuntime ? ['refresh', 'enable'] : ['refresh']);
  assert.deepEqual([...f.app.plugins.enabledPlugins].sort(), f.enabledBefore);
});

test('serialized host refresh works without Node or module-scope helpers', async () => {
  const f = runtimeFixture();
  const expression = `(${refreshDeploymentRuntime.toString()})(app,expected,options)`;
  const context = vm.createContext({app: f.app, expected: newManifest, options: f.options, setTimeout, clearTimeout});
  assert.equal(vm.runInContext('typeof process + ":" + typeof require', context), 'undefined:undefined');
  const result = await vm.runInContext(expression, context);
  assert.equal(result.version, '0.4.7');
  assert.equal(result.manifest.status, 'completed');
  assert.deepEqual(f.calls, ['refresh', 'enable']);
});
