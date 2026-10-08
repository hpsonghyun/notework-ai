import {execFileSync} from 'node:child_process';
import {copyFile, mkdir, readFile, readdir, realpath, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DEPLOY_ASSETS, REQUIRED_DEPLOY_TESTS, deploymentManifest, deploymentPlan, hashFile, refreshDeploymentRuntime, verifyBuildProvenance} from './deployment-guard.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(sourceRoot, 'dist', 'notework-ai');
const args = process.argv.slice(2);
const options = {};
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--check-only') options.checkOnly = true;
  else if (['--vault', '--workspace', '--cli'].includes(args[index]) && args[index + 1]) options[args[index].slice(2)] = args[++index];
  else throw new Error('Usage: node scripts/deploy-local.mjs --vault <vault-name> [--workspace <folder>] [--cli <Obsidian.com>] [--check-only]');
}
if (!options.vault || path.basename(options.vault) !== options.vault || /[\\/:]/.test(options.vault)) throw new Error('Specify one vault folder name with --vault.');
const aiRoot = path.resolve(sourceRoot, '../..');
const inferredWorkspace = path.basename(aiRoot) === '_ai' ? path.dirname(aiRoot) : null;
const workspace = options.workspace ? path.resolve(options.workspace) : inferredWorkspace;
if (!workspace) throw new Error('Specify --workspace for a source checkout outside the workspace artifact-builds folder.');
const vaultRoot = path.join(workspace, options.vault);
const cli = options.cli || (process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Obsidian', 'Obsidian.com'));
if (!cli) throw new Error('Specify the desktop Obsidian CLI with --cli.');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outputRoot = path.join(workspace, '_ai', 'temp', 'artifact-qa', 'notework-mobile-startup-20261008');
const backupRoot = path.join(workspace, '_ai', 'backups', 'notework-mobile-startup-20261008', `deploy-${options.vault}-${stamp}`);
const reportPath = path.join(outputRoot, `deploy-${options.vault}-${stamp}.json`);
const report = {vault: options.vault, startedAt: new Date().toISOString(), status: 'checking',
  helperReadNoteContents: false, phoneRecoveryVerified: false, assetsUpdated: false};
let temporarilyUnloaded = false;
let recoveryManifest, recoveryPlan;

function native(expression) {
  let raw;
  try {
    raw = execFileSync(cli, [`vault=${options.vault}`, 'dev:cdp', 'method=Runtime.evaluate',
      `params=${JSON.stringify({expression, awaitPromise: true, returnByValue: true})}`],
    {encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  } catch { throw new Error('Desktop Obsidian command did not complete; private diagnostics suppressed.'); }
  let result;
  try { result = JSON.parse(raw); } catch { throw new Error('Desktop Obsidian returned no readable evaluation result.'); }
  if (result.exceptionDetails || !result.result?.value) throw new Error('Desktop evaluation failed; private diagnostics suppressed.');
  return result.result.value;
}

function snapshot() {
  return native(`(()=>{
    const p=app.plugins.plugins['notework-ai'];
    const sync=app.internalPlugins.plugins.sync;
    const instance=sync?.instance,filter=instance?.filter?.allowSpecialFiles;
    const filterKnown=typeof filter?.has==='function';
    return {desktop:app.isMobile===false&&typeof app.vault.adapter.getBasePath==='function',
      vault:{name:app.vault.getName(),root:app.vault.adapter.getBasePath(),configDir:app.vault.configDir},
      plugin:{installed:!!app.plugins.manifests['notework-ai'],loaded:!!p,
        enabled:app.plugins.enabledPlugins.has('notework-ai'),busy:p? p.controller?.state?.busy:null,version:p?.manifest.version||null},
      sync:{present:!!instance,enabled:!!sync?.enabled,filterKnown,
        activePluginList:filterKnown?filter.has('community-plugin'):null,
        pluginData:filterKnown?filter.has('community-plugin-data'):null}};
  })()`);
}

async function containedTarget(target) {
  const root = await realpath(vaultRoot), destination = await realpath(target);
  const relative = path.relative(root, destination);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('A deployment target resolves outside the vault.');
}

async function optionalHash(file) {
  try { return await hashFile(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function preservedHashes(plan) {
  const files = {};
  for (const name of (await readdir(plan.pluginRoot)).sort()) {
    if (/^(data\.json|knowledge-index.*\.json.*)$/.test(name)) {
      await containedTarget(path.join(plan.pluginRoot, name));
      files[name] = await hashFile(path.join(plan.pluginRoot, name));
    }
  }
  return {enabledList: await optionalHash(plan.enabledList), settingsAndIndexes: files};
}

function sameHashes(before, after) { return JSON.stringify(before) === JSON.stringify(after); }

function restoreRuntime(expectedManifest, plan) {
  const hostOptions = {vaultName: options.vault, vaultRoot, configDir: plan.configDir,
    resumeRuntime: plan.resumeRuntime, previouslyEnabled: plan.previouslyEnabled};
  return native(`(${refreshDeploymentRuntime.toString()})(app,${JSON.stringify(expectedManifest)},${JSON.stringify(hostOptions)})`);
}

try {
  await mkdir(outputRoot, {recursive: true});
  const provenance = await verifyBuildProvenance(sourceRoot, dist);
  const expectedManifest = deploymentManifest(JSON.parse(await readFile(path.join(dist, 'manifest.json'), 'utf8')), {desktopOnly: true});
  if (expectedManifest.version !== provenance.version) throw new Error('The built manifest version does not match its deployment provenance.');
  async function unchangedBuild() {
    const current = await verifyBuildProvenance(sourceRoot, dist);
    if (current.sourceDigest !== provenance.sourceDigest || JSON.stringify(current.assets) !== JSON.stringify(provenance.assets)) {
      throw new Error('The build changed during deployment checks; retry after review.');
    }
  }
  report.build = {...expectedManifest, sourceDigest: provenance.sourceDigest, assetHashes: provenance.assets};
  const before = snapshot();
  let plan = deploymentPlan(before, {vaultName: options.vault, vaultRoot});
  report.before = before;
  await containedTarget(plan.configRoot);
  await containedTarget(plan.pluginRoot);
  for (const name of DEPLOY_ASSETS) await containedTarget(path.join(plan.pluginRoot, name));
  if (await optionalHash(plan.enabledList)) await containedTarget(plan.enabledList);
  let testOutput = '', testExitCode = 0;
  try {
    testOutput = execFileSync(process.execPath, ['--test', '--test-isolation=none', ...REQUIRED_DEPLOY_TESTS],
      {cwd: sourceRoot, encoding: 'utf8', timeout: 120000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  } catch (error) { testExitCode = error.status ?? 1; testOutput = String(error.stdout || '') + String(error.stderr || ''); }
  await writeFile(reportPath.replace(/\.json$/, '-tests.log'), testOutput);
  report.regressionTests = {files: REQUIRED_DEPLOY_TESTS, passed: testExitCode === 0, exitCode: testExitCode};
  if (testExitCode !== 0) throw new Error('Required mobile startup and credential regression tests did not pass.');
  await unchangedBuild();
  const current = snapshot();
  plan = deploymentPlan(current, {vaultName: options.vault, vaultRoot});
  if (current.plugin.loaded !== before.plugin.loaded || current.plugin.enabled !== before.plugin.enabled || current.vault.configDir !== before.vault.configDir) {
    throw new Error('Plugin or configuration state changed while tests ran; retry after review.');
  }
  if (options.checkOnly) {
    report.status = 'checks_passed_no_deployment';
  } else {
    const preserved = await preservedHashes(plan);
    recoveryManifest = deploymentManifest(JSON.parse(await readFile(path.join(plan.pluginRoot, 'manifest.json'), 'utf8')));
    recoveryPlan = plan;
    await mkdir(backupRoot, {recursive: true});
    for (const name of DEPLOY_ASSETS) await copyFile(path.join(plan.pluginRoot, name), path.join(backupRoot, name));
    if (preserved.enabledList) await copyFile(plan.enabledList, path.join(backupRoot, 'community-plugins.json'));
    report.backupDirectory = backupRoot;
    if (plan.resumeRuntime) {
      const disabled = native(`(async()=>{await app.plugins.disablePlugin('notework-ai');return{unloaded:!app.plugins.plugins['notework-ai']};})()`);
      if (!disabled.unloaded) throw new Error('Plugin did not unload; no asset copy was started.');
      temporarilyUnloaded = true;
    }
    const unloaded = snapshot();
    const unloadedPlan = deploymentPlan(unloaded, {vaultName: options.vault, vaultRoot});
    if (unloadedPlan.configRoot !== plan.configRoot || unloaded.plugin.loaded || unloaded.plugin.enabled !== current.plugin.enabled) {
      throw new Error('Plugin or configuration state changed during unload; no asset copy was started.');
    }
    if (!sameHashes(preserved, await preservedHashes(plan))) {
      throw new Error('Settings, indexes or enabled list changed during unload; no asset copy was started.');
    }
    await unchangedBuild();
    try {
      for (const name of DEPLOY_ASSETS) await copyFile(path.join(dist, name), path.join(plan.pluginRoot, name));
      report.assetsUpdated = true;
    } catch {
      for (const name of DEPLOY_ASSETS) await copyFile(path.join(backupRoot, name), path.join(plan.pluginRoot, name));
      report.runtimeAfterCopyRollback = restoreRuntime(recoveryManifest, plan);
      temporarilyUnloaded = false;
      throw new Error('Asset copy failed; the original three assets were restored.');
    }
    const matches = await Promise.all(DEPLOY_ASSETS.map(async name => provenance.assets[name] === await hashFile(path.join(plan.pluginRoot, name))));
    report.installedAssetHashesMatch = matches.every(Boolean);
    if (!report.installedAssetHashesMatch) throw new Error('Installed assets did not match the tested build.');
    report.runtime = restoreRuntime(expectedManifest, plan);
    temporarilyUnloaded = false;
    report.after = snapshot();
    const afterPlan = deploymentPlan(report.after, {vaultName: options.vault, vaultRoot});
    if (afterPlan.configRoot !== plan.configRoot) throw new Error('The active configuration profile changed during deployment; review the report.');
    const afterHashes = await preservedHashes(plan);
    report.enabledListPreserved = preserved.enabledList === afterHashes.enabledList;
    report.settingsAndIndexesPreserved = sameHashes(preserved.settingsAndIndexes, afterHashes.settingsAndIndexes);
    report.settingsIndexesAndEnabledListPreserved = report.enabledListPreserved && report.settingsAndIndexesPreserved;
    if (!report.settingsIndexesAndEnabledListPreserved) throw new Error('Settings, indexes or enabled list changed; review the deployment report.');
    if (report.after.plugin.enabled !== current.plugin.enabled) throw new Error('The in-memory enabled plugin state changed; review the deployment report.');
    if (report.runtime.manifest?.status !== 'completed') throw new Error('The host did not refresh the expected installed manifest; review the deployment report.');
    if (report.runtime.load === 'failed' || report.runtime.restore === 'failed') throw new Error('Desktop startup failed; review the deployment report.');
    report.status = report.runtime.load === 'pending' || report.runtime.restore === 'pending' ? 'assets_updated_desktop_restore_pending' : 'assets_updated_desktop_observed';
  }
} catch (error) {
  if (temporarilyUnloaded && !report.assetsUpdated) {
    try { report.runtimeAfterBlockedCopy = restoreRuntime(recoveryManifest, recoveryPlan); }
    catch { report.runtimeAfterBlockedCopy = {load: 'failed', restore: 'not_observed'}; }
  }
  report.status = report.assetsUpdated ? 'deployment_needs_review' : 'deployment_blocked';
  report.error = error.message;
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await mkdir(outputRoot, {recursive: true});
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({status: report.status, assetsUpdated: report.assetsUpdated, report: reportPath}));
}
