import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const readJson = async relative => JSON.parse(await readFile(new URL(relative, import.meta.url), 'utf8'));

test('release keeps the installed plugin identity and desktop-only host policy', async () => {
  const manifest = await readJson('../manifest.json');
  assert.equal(manifest.id, 'notework-ai');
  assert.equal(manifest.minAppVersion, '1.11.4');
  assert.equal(manifest.isDesktopOnly, true, 'Obsidian must reject this release on mobile.');
});

test('release version agrees across package metadata, lockfile, and Obsidian version mapping', async () => {
  const [manifest, pkg, lock, versions] = await Promise.all([
    readJson('../manifest.json'),
    readJson('../package.json'),
    readJson('../package-lock.json'),
    readJson('../versions.json'),
  ]);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.name, manifest.id);
  assert.equal(pkg.private, true, 'The private development package must not become publishable accidentally.');
  assert.equal(pkg.version, manifest.version);
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].name, pkg.name);
  assert.equal(lock.packages[''].version, manifest.version);
  assert.equal(versions[manifest.version], manifest.minAppVersion);
});

test('the packaged manifest carries the current release and desktop-only policy', async () => {
  const [source, packaged] = await Promise.all([
    readJson('../manifest.json'),
    readJson('../dist/notework-ai/manifest.json'),
  ]);
  assert.deepEqual(packaged, source, 'Build before testing or packaging; stale manifests must not ship.');
});
