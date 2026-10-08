import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionController } from '../src/controller.mjs';

const SOL = { id: 'gpt-6.1-sol', name: 'Synthetic Sol', supportedReasoningEfforts: ['high', 'medium'] };
const OTHER = { id: 'synthetic-account-alternate', name: 'Synthetic alternate', supportedReasoningEfforts: ['high'] };
function structureResponse(input){const data=JSON.parse(input.split('\nDATA_JSON\n')[1]);return JSON.stringify({cards:data.cards.map(card=>({id:card.id,parentId:null,relation:'start',topic:'Synthetic evidence'}))});}
function fixture({ mode = 'codex' } = {}) {
  const calls = [], reads = [], saved = [];
  const control = { catalog: [SOL, OTHER], connectError: null, catalogError: null, generationError: null, jevCatalog: [{ id: 'synthetic-jev' }] };
  const file = { path: 'Research/source.md', stat: { size: 35 } };
  const provider = {
    async connect() { calls.push({ type: 'connect' }); if (control.connectError) throw control.connectError; },
    async listModels() { calls.push({ type: 'catalog' }); if (control.catalogError) throw control.catalogError; return structuredClone(control.catalog); },
    async generate(input, options) { calls.push({ type: 'generate', input, options }); if (control.generationError) throw control.generationError; if(input.startsWith('NOTEWORK_CONVERSATION_STRUCTURE_V1'))return structureResponse(input);return 'Synthetic answer from current source evidence.'; },
    async disconnect() { return {}; },
  };
  const jev = {
    async listModels() { calls.push({ type: 'jev-catalog' }); return structuredClone(control.jevCatalog); },
    async verify() { calls.push({ type: 'jev-paid-diagnostic' }); assert.fail('Jev catalog connection must not run a paid diagnostic'); },
  };
  const controller = new ConnectionController({ providers: { [mode]: provider }, availableModes: [mode], jev,
    secrets: { set: async () => {}, delete: async () => {} },
    vault: { getMarkdownFiles: () => [file], getAbstractFileByPath: path => path === file.path ? file : null, cachedRead: async source => { reads.push(source.path); return 'Ontology source evidence from this synthetic note.'; } },
    settings: { mode, reasoningEffort: 'high', scope: { mode: 'folders', include: ['Research'], exclude: [] } },
    saveSettings: async value => saved.push(structuredClone(value)),
  });
  return { controller, provider, control, calls, reads, saved };
}
const generationCalls = f => f.calls.filter(call => call.type === 'generate');

test('successful account and catalog connection is usable before any inference has occurred', async () => {
  const f = fixture(); await f.controller.connect();
  assert.deepEqual(f.calls.map(call => call.type), ['connect', 'catalog']);
  assert.deepEqual(f.reads, []);
  assert.equal(f.controller.state.authenticated, true);
  assert.equal(f.controller.state.verified, true);
  assert.equal(f.controller.state.inferenceConfirmed, false);
  assert.equal(f.controller.state.connection, 'catalog-confirmed');
  assert.match(f.controller.state.status, /Connected/);
  assert.doesNotMatch(f.controller.state.status, /test|responded/i);
  f.controller.set({ draft: 'Ontology evidence?', consent: true }); await f.controller.ask(); await f.controller.mapPromise;
  assert.equal(generationCalls(f).length, 2);assert(generationCalls(f)[1].input.startsWith('NOTEWORK_CONVERSATION_STRUCTURE_V1'));
  assert.doesNotMatch(generationCalls(f)[0].input, /This is a connection test/);
  assert.equal(generationCalls(f)[0].options.model, SOL.id);
  assert.equal(generationCalls(f)[0].options.reasoningEffort, 'high');
  assert.deepEqual(f.controller.state.sources.map(source => source.path), ['Research/source.md']);
  assert.match(f.controller.state.sources[0].contentHash, /^[a-f0-9]{64}$/);
  assert.equal(f.controller.state.messages.length, 2);
  assert.equal(f.controller.state.inferenceConfirmed, true);
});

test('connect, model changes and supported effort changes never generate a paid probe', async () => {
  const f = fixture(); await f.controller.connect();
  f.controller.set({ consent: true }); f.controller.selectModel(OTHER.id);
  assert.equal(f.controller.state.verified, true); assert.equal(f.controller.state.model, OTHER.id);
  assert.equal(f.controller.state.inferenceConfirmed, false); assert.equal(f.controller.state.consent, false);
  f.controller.selectModel(SOL.id); f.controller.selectReasoningEffort('medium');
  assert.equal(f.controller.state.verified, true); assert.equal(f.controller.state.reasoningEffort, 'medium');
  f.controller.selectReasoningEffort('high');
  assert.equal(generationCalls(f).length, 0); assert.deepEqual(f.reads, []);
  f.controller.set({ draft: 'Ontology evidence?', consent: true }); await f.controller.ask(); await f.controller.mapPromise;
  assert.equal(generationCalls(f).length, 2);assert(generationCalls(f)[1].input.startsWith('NOTEWORK_CONVERSATION_STRUCTURE_V1')); assert.equal(generationCalls(f)[0].options.reasoningEffort, 'high');
});

test('unlisted model and unsupported effort selections cannot replace current usable options', async () => {
  const f = fixture(); await f.controller.connect();
  f.controller.selectModel('not-in-current-account'); f.controller.selectReasoningEffort('ultra');
  assert.equal(f.controller.state.model, SOL.id); assert.equal(f.controller.state.reasoningEffort, 'high');
  assert.equal(f.controller.state.verified, true); assert.equal(generationCalls(f).length, 0);
  f.controller.set({ model: 'not-in-current-account', draft: 'Ontology evidence?', consent: true });
  await f.controller.ask(); assert.deepEqual(f.reads, []); assert.equal(generationCalls(f).length, 0);
});

test('catalog refresh retains a valid selection and never requires inference to recover readiness', async () => {
  const f = fixture(); await f.controller.connect(); f.controller.set({ consent: true });
  f.control.catalog = [OTHER, SOL]; await f.controller.refreshModels();
  assert.equal(f.controller.state.model, SOL.id); assert.equal(f.controller.state.verified, true);
  assert.equal(f.controller.state.inferenceConfirmed, false); assert.equal(f.controller.state.consent, true);
  f.control.catalogError = new Error('Synthetic catalog unavailable.'); await f.controller.refreshModels();
  assert.equal(f.controller.state.verified, false); assert.equal(f.controller.state.connection, 'catalog-error');
  assert.equal(f.controller.state.statusKind, 'error');
  f.controller.selectModel(SOL.id); f.controller.selectReasoningEffort('high');
  assert.equal(f.controller.state.verified, false, 'retained models must not bypass a failed live catalog');
  f.control.catalogError = null; await f.controller.refreshModels();
  assert.equal(f.controller.state.verified, true); assert.equal(f.controller.state.statusKind, '');
  assert.equal(f.controller.state.model, SOL.id); assert.equal(generationCalls(f).length, 0);
});

test('removed model clears readiness without falling back, and a listed choice becomes ready immediately', async () => {
  const f = fixture(); await f.controller.connect(); f.control.catalog = [OTHER]; await f.controller.refreshModels();
  assert.equal(f.controller.state.model, ''); assert.equal(f.controller.state.verified, false);
  f.controller.set({ draft: 'Ontology evidence?', consent: true }); await f.controller.ask();
  assert.equal(generationCalls(f).length, 0); assert.deepEqual(f.reads, []);
  f.controller.selectModel(OTHER.id); assert.equal(f.controller.state.verified, true);
  assert.equal(generationCalls(f).length, 0);
});

test('empty and malformed catalogs cannot advertise a usable connection', async () => {
  for (const catalog of [[], null, {}, [null], [{ id: '' }], [{ id: ' ' }], [{ id: 12 }]]) {
    const f = fixture(); f.control.catalog = catalog; await f.controller.connect();
    assert.equal(f.controller.state.verified, false); assert.equal(f.controller.state.inferenceConfirmed, false);
    assert.equal(f.controller.state.model, '');
    f.controller.set({ draft: 'Ontology evidence?', consent: true }); await f.controller.ask();
    assert.deepEqual(f.reads, []); assert.equal(generationCalls(f).length, 0);
  }
});

test('invalid credentials fail before catalog readiness and require successful reconnection', async () => {
  const f = fixture({ mode: 'openai' });
  f.control.connectError = Object.assign(new Error('Check your credentials.'), { code: 'AUTH_FAILED' });
  await f.controller.connect();
  assert.equal(f.controller.state.authenticated, false); assert.equal(f.controller.state.verified, false);
  assert.equal(f.controller.state.connection, 'failed'); assert.equal(f.controller.state.statusKind, 'error');
  assert.equal(f.calls.filter(call => call.type === 'catalog').length, 0);
  f.control.connectError = null; await f.controller.connect();
  assert.equal(f.controller.state.verified, true); assert.equal(f.controller.state.statusKind, '');
  assert.equal(generationCalls(f).length, 0);
  await f.controller.saveApiKey('openai', 'synthetic-replacement-key');
  assert.equal(f.controller.state.authenticated, false); assert.equal(f.controller.state.verified, false);
  assert.equal(f.controller.state.model, '');
});

test('first-question quota error is visible without inference confirmation or fallback', async () => {
  const f = fixture(); await f.controller.connect();
  f.control.generationError = Object.assign(new Error('Synthetic subscription usage limit reached.'), { code: 'RATE_LIMITED' });
  f.controller.set({ draft: 'Ontology evidence?', consent: true }); await f.controller.ask();
  assert.equal(generationCalls(f).length, 1); assert.equal(f.controller.state.verified, true);
  assert.equal(f.controller.state.inferenceConfirmed, false); assert.equal(f.controller.state.statusKind, 'error');
  assert.equal(f.controller.state.draft, 'Ontology evidence?'); assert.equal(f.controller.state.messages.length, 0);
  assert.equal(f.controller.state.mode, 'codex'); assert.match(f.controller.state.status, /usage limit/);
});

test('revoked credentials discovered by normal generation close readiness before another question', async () => {
  const f = fixture(); await f.controller.connect();
  f.control.generationError = Object.assign(new Error('Sign in again.'), { code: 'SUBSCRIPTION_LOGIN_REQUIRED' });
  f.controller.set({ draft: 'Ontology evidence?', consent: true }); await f.controller.ask();
  assert.equal(f.controller.state.authenticated, false); assert.equal(f.controller.state.verified, false);
  assert.equal(f.controller.state.connection, 'failed'); assert.equal(generationCalls(f).length, 1);
  f.controller.set({ consent: true }); await f.controller.ask(); assert.equal(generationCalls(f).length, 1);
});

test('Jev live catalog is ready without a paid diagnostic, while empty and malformed catalogs stay closed', async () => {
  const f = fixture(); await f.controller.loadJev();
  assert.equal(f.controller.state.jevVerified, true); assert.equal(f.controller.state.jevModel, 'synthetic-jev');
  assert.deepEqual(f.calls.map(call => call.type), ['jev-catalog']); assert.doesNotMatch(f.controller.state.jevStatus, /test|responded/i);
  for (const catalog of [[], null, [{ id: '' }]]) {
    f.control.jevCatalog = catalog; await f.controller.loadJev();
    assert.equal(f.controller.state.jevVerified, false); assert.equal(f.controller.state.jevModel, '');
  }
  assert.equal(f.calls.some(call => call.type === 'jev-paid-diagnostic'), false);
});
