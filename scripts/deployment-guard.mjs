import {createHash} from 'node:crypto';
import {readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

export const DEPLOY_ASSETS = ['main.js', 'manifest.json', 'styles.css'];
export const REQUIRED_DEPLOY_TESTS = [
  'tests/desktop-only-release.test.mjs',
  'tests/mobile-startup.test.mjs',
  'tests/mobile-plugin.test.mjs',
  'tests/credential-lifecycle.test.mjs',
  'tests/runtime-chat-scope.test.mjs',
  'tests/deployment-guard.test.mjs',
];
const sha256 = value => createHash('sha256').update(value).digest('hex');
export const hashFile = async file => sha256(await readFile(file));

export function deploymentManifest(manifest, {desktopOnly = false} = {}) {
  if (manifest?.id !== 'notework-ai' || typeof manifest.version !== 'string' ||
      !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(manifest.version) || typeof manifest.isDesktopOnly !== 'boolean') {
    throw new Error('The deployment manifest has an invalid plugin identity, version or platform policy.');
  }
  if (desktopOnly && manifest.isDesktopOnly !== true) throw new Error('The new build must be desktop-only before local deployment.');
  return {id: manifest.id, version: manifest.version, isDesktopOnly: manifest.isDesktopOnly};
}

// This function also runs inside Obsidian through Runtime.evaluate. Keep it
// self-contained so its serialized form has no Node or module dependencies.
export async function refreshDeploymentRuntime(app, expected, options) {
  const {vaultName, vaultRoot, configDir, resumeRuntime, previouslyEnabled, timeoutMs = 8000} = options;
  if (expected?.id !== 'notework-ai' || typeof expected.version !== 'string' || !expected.version ||
      typeof expected.isDesktopOnly !== 'boolean' || typeof resumeRuntime !== 'boolean' || typeof previouslyEnabled !== 'boolean') {
    throw new Error('An exact manifest and previous runtime state are required.');
  }
  let enabledBefore;
  const normalizedRoot = value => typeof value === 'string' ? value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : '';
  const assertHost = () => {
    if (app?.isMobile !== false || typeof app.vault?.adapter?.getBasePath !== 'function') throw new Error('Manifest refresh requires desktop Obsidian.');
    if (!vaultName || !vaultRoot || !configDir || app.vault.getName() !== vaultName ||
        normalizedRoot(app.vault.adapter.getBasePath()) !== normalizedRoot(vaultRoot) || app.vault.configDir !== configDir) {
      throw new Error('The vault or configuration profile changed before runtime restoration.');
    }
    const sync = app.internalPlugins?.plugins?.sync, instance = sync?.instance, filter = instance?.filter?.allowSpecialFiles;
    if ((instance && typeof filter?.has !== 'function') || (sync?.enabled && !instance)) throw new Error('Sync file filters could not be verified before runtime restoration.');
    if (instance && (filter.has('community-plugin') || filter.has('community-plugin-data'))) throw new Error('Disable Sync community plugin channels before runtime restoration.');
    if (!app.plugins?.manifests?.[expected.id]) throw new Error('The existing plugin manifest disappeared before runtime restoration.');
    if (typeof app.plugins.enabledPlugins?.has !== 'function' ||
        app.plugins.enabledPlugins.has(expected.id) !== previouslyEnabled ||
        (enabledBefore && JSON.stringify([...app.plugins.enabledPlugins].sort()) !== JSON.stringify(enabledBefore))) {
      throw new Error('The enabled plugin list changed before runtime restoration.');
    }
  };
  const assertUnloaded = () => {
    assertHost();
    if (app.plugins.plugins?.[expected.id]) throw new Error('Notework AI must remain unloaded while its manifest is refreshed.');
  };
  const matches = manifest => manifest?.id === expected.id && manifest.version === expected.version && manifest.isDesktopOnly === expected.isDesktopOnly;
  const header = manifest => ({id: manifest?.id ?? null, version: manifest?.version ?? null, isDesktopOnly: manifest?.isDesktopOnly ?? null});
  const settle = async operation => {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(operation).then(() => 'completed', () => 'failed'),
        new Promise(resolve => { timer = setTimeout(() => resolve('pending'), timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  assertUnloaded();
  enabledBefore = [...app.plugins.enabledPlugins].sort();
  if (typeof app.plugins.loadManifests !== 'function') throw new Error('Obsidian cannot refresh plugin manifests safely.');
  const refresh = await settle(() => app.plugins.loadManifests());
  if (refresh !== 'completed') return {manifest: {status: refresh}, load: 'not_started', restore: 'not_observed', loaded: false};
  assertUnloaded();
  const manifest = app.plugins.manifests[expected.id];
  const manifestResult = {status: matches(manifest) ? 'completed' : 'mismatch', ...header(manifest)};
  if (manifestResult.status !== 'completed') return {manifest: manifestResult, load: 'not_started', restore: 'not_observed', loaded: false};
  if (!resumeRuntime) return {manifest: manifestResult, load: 'left_unloaded', restore: 'not_started', loaded: false, version: manifest.version};
  const load = await settle(() => app.plugins.enablePlugin(expected.id));
  if (load !== 'completed') return {manifest: manifestResult, load, restore: 'not_observed'};
  const plugin = app.plugins.plugins?.[expected.id];
  if (!plugin) return {manifest: manifestResult, load: 'failed', restore: 'not_observed', loaded: false};
  assertHost();
  if (!matches(plugin.manifest)) {
    await app.plugins.disablePlugin(expected.id);
    return {manifest: manifestResult, runtimeManifest: header(plugin.manifest), load: 'failed', restore: 'not_observed', loaded: !!app.plugins.plugins?.[expected.id]};
  }
  const restore = plugin.restorePromise ? await settle(() => plugin.restorePromise) : 'not_started';
  return {manifest: manifestResult, load: 'completed', restore, loaded: true, version: plugin.manifest.version, isDesktopOnly: plugin.manifest.isDesktopOnly};
}

async function sourceFiles(root) {
  const files = ['build.mjs', 'manifest.json', 'styles.css', 'package.json',
    'scripts/deployment-guard.mjs', 'scripts/deploy-local.mjs'];
  async function visit(relative) {
    for (const entry of await readdir(path.join(root, relative), {withFileTypes: true})) {
      if (entry.isSymbolicLink()) throw new Error('Source links are not accepted for deployment provenance.');
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) files.push(name);
    }
  }
  await visit('src');
  try { await readFile(path.join(root, 'package-lock.json')); files.push('package-lock.json'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return files.sort();
}

export async function sourceFingerprint(root) {
  const files = {};
  for (const relative of await sourceFiles(root)) files[relative] = await hashFile(path.join(root, relative));
  return {digest: sha256(JSON.stringify(files)), files};
}

export async function writeBuildProvenance(root, dist, expectedSourceDigest) {
  const source = await sourceFingerprint(root);
  if (expectedSourceDigest && source.digest !== expectedSourceDigest) throw new Error('Source changed while building; rebuild before deployment.');
  const assets = {};
  for (const name of DEPLOY_ASSETS) assets[name] = await hashFile(path.join(dist, name));
  const manifest = JSON.parse(await readFile(path.join(dist, 'manifest.json'), 'utf8'));
  const report = {schema: 1, pluginId: manifest.id, version: manifest.version,
    builtAt: new Date().toISOString(), sourceDigest: source.digest, sourceFiles: source.files, assets};
  await writeFile(path.join(dist, 'build-provenance.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

export async function verifyBuildProvenance(root, dist) {
  const report = JSON.parse(await readFile(path.join(dist, 'build-provenance.json'), 'utf8'));
  if (report.schema !== 1 || report.pluginId !== 'notework-ai') throw new Error('Invalid build provenance; rebuild before deployment.');
  const source = await sourceFingerprint(root);
  if (report.sourceDigest !== source.digest) throw new Error('Build is stale: source fingerprint changed. Rebuild before deployment.');
  for (const name of DEPLOY_ASSETS) {
    if (report.assets?.[name] !== await hashFile(path.join(dist, name))) throw new Error(`Build asset fingerprint changed: ${name}. Rebuild before deployment.`);
  }
  return report;
}

export function configPathWithinVault(vaultRoot, configDir) {
  if (typeof configDir !== 'string' || !configDir || configDir.includes('\0') ||
      path.win32.isAbsolute(configDir) || path.posix.isAbsolute(configDir) || configDir.includes(':')) {
    throw new Error('Configuration folder must be a relative path inside the selected vault.');
  }
  const components = configDir.split(/[\\/]/);
  if (components.some(part => !part || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' '))) {
    throw new Error('Configuration folder contains an unsafe path component.');
  }
  const root = path.win32.resolve(vaultRoot);
  const target = path.win32.resolve(root, configDir);
  const relative = path.win32.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith('..\\') || path.win32.isAbsolute(relative)) throw new Error('Configuration folder escapes the selected vault.');
  return target;
}

export function assertSyncIsolation(sync) {
  if (!sync || (sync.present && !sync.filterKnown) || (sync.enabled && !sync.present)) {
    throw new Error('Sync file filters could not be verified; deployment is blocked.');
  }
  if (sync.activePluginList === true || sync.pluginData === true) {
    throw new Error('Disable Sync active community plugin list and installed community plugin data before local deployment.');
  }
  if (sync.present && (typeof sync.activePluginList !== 'boolean' || typeof sync.pluginData !== 'boolean')) {
    throw new Error('Sync community plugin filters are unknown; deployment is blocked.');
  }
}

export function deploymentPlan(snapshot, {vaultName, vaultRoot}) {
  if (!snapshot?.desktop) throw new Error('Local deployment requires desktop Obsidian.');
  if (snapshot.vault?.name !== vaultName || typeof snapshot.vault?.root !== 'string' || !snapshot.vault.root ||
      path.win32.resolve(snapshot.vault.root).toLowerCase() !== path.win32.resolve(vaultRoot).toLowerCase()) {
    throw new Error('The CLI selected a different vault.');
  }
  assertSyncIsolation(snapshot.sync);
  if (!snapshot.plugin?.installed) throw new Error('An existing Notework AI installation is required.');
  if (snapshot.plugin.loaded && snapshot.plugin.busy !== false) throw new Error('Notework AI must be idle before deployment.');
  const configRoot = configPathWithinVault(vaultRoot, snapshot.vault.configDir);
  return {configDir: snapshot.vault.configDir, configRoot, pluginRoot: path.win32.join(configRoot, 'plugins', 'notework-ai'),
    enabledList: path.win32.join(configRoot, 'community-plugins.json'),
    resumeRuntime: snapshot.plugin.loaded === true,
    previouslyEnabled: snapshot.plugin.enabled === true};
}
