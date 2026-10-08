import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionController, isFlowCurrent } from '../src/controller.mjs';
import { ApiKeyProvider } from '../src/providers/api-key.mjs';

const model = { id: 'gpt-6.1-sol', name: 'GPT 6.1 Sol' };
function structureResponse(input){const data=JSON.parse(input.split('\nDATA_JSON\n')[1]);return JSON.stringify({cards:data.cards.map(card=>({id:card.id,parentId:null,relation:'start',topic:'Synthetic evidence'}))});}
function fixture({ realApi = false } = {}) {
  let catalog = [model]; const calls = []; const saved = []; const values = new Map([['api-openai', 'fixture-key']]);
  const secrets = { get: async key => values.get(key), set: async (key, value) => values.set(key, value), delete: async key => values.delete(key) };
  const fake = { connect: async () => {}, disconnect: async () => ({}), listModels: async () => { if (catalog instanceof Error) throw catalog; return structuredClone(catalog); }, generate: async (input, options) => { calls.push({ input, options }); return input.startsWith('NOTEWORK_CONVERSATION_STRUCTURE_V1')?structureResponse(input):'Connection confirmed.'; } };
  const api = realApi ? new ApiKeyProvider({ provider: 'openai', secrets, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: catalog }), { headers: { 'content-type': 'application/json' } });
    const input=JSON.parse(options.body).input[0].content[0].text;
    const answer=input.startsWith('NOTEWORK_CONVERSATION_STRUCTURE_V1')?structureResponse(input):'Connection confirmed.';
    return new Response('data: '+JSON.stringify({type:'response.output_text.delta',delta:answer})+'\n\ndata: {"type":"response.completed"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } }) : fake;
  const controller = new ConnectionController({ providers: { chatgpt: fake, openai: api }, availableModes: ['chatgpt', 'openai'], secrets,
    vault: { getMarkdownFiles: () => [], getAbstractFileByPath: () => null, cachedRead: async () => { throw new Error('No fixture note may be read.'); } },
    settings: { mode: realApi ? 'openai' : 'chatgpt', scope: { mode: 'all', include: [], exclude: [] }, reasoningEffort: '' },
    saveSettings: async value => saved.push(structuredClone(value)), jev: {} });
  return { controller, calls, saved, setCatalog: value => { catalog = value; } };
}

test('selected high reaches both short verification and chat provider generation', async () => {
  const { controller, calls } = fixture(); await controller.connect(); controller.selectReasoningEffort('high');
  await controller.verify(); assert.equal(controller.state.verified, true); assert.equal(calls[0].options.reasoningEffort, 'high');
  controller.set({ draft: 'Fixture question', consent: true }); await controller.ask(); await controller.mapPromise;
  assert.equal(calls.length, 3);assert(calls[2].input.startsWith('NOTEWORK_CONVERSATION_STRUCTURE_V1')); assert.equal(calls[1].options.reasoningEffort, 'high'); assert.equal(calls[1].options.model, 'gpt-6.1-sol');assert.equal(calls[2].options.reasoningEffort,'high');
});

test('OpenAI controller integration emits explicit high in actual API request payloads using fake network', async () => {
  const { controller, calls } = fixture({ realApi: true }); await controller.connect(); controller.selectReasoningEffort('high'); await controller.verify();
  controller.set({ draft: 'Fixture question', consent: true }); await controller.ask();await controller.mapPromise;
  const generated = calls.filter(call => call.options.method === 'POST'); assert.equal(generated.length, 3);assert(JSON.parse(generated[2].options.body).input[0].content[0].text.startsWith('NOTEWORK_CONVERSATION_STRUCTURE_V1'));
  for (const call of generated) { assert.equal(call.url, 'https://api.openai.com/v1/responses'); assert.deepEqual(JSON.parse(call.options.body).reasoning, { effort: 'high' }); }
});

test('unsupported selection never changes accepted effort, verification, consent, or sends a request', async () => {
  const { controller, calls, saved } = fixture(); await controller.connect(); controller.selectReasoningEffort('high'); await controller.verify(); controller.set({ consent: true });
  const writes = saved.length; const requests = calls.length;
  controller.selectReasoningEffort('ultra'); controller.selectReasoningEffort('typo');
  assert.equal(controller.state.reasoningEffort, 'high'); assert.equal(controller.state.verified, true); assert.equal(controller.state.consent, true); assert.equal(calls.length, requests); assert.equal(saved.length, writes);
});

test('refresh reorders current models while retaining selected model, effort, verified state and consent', async () => {
  const { controller, setCatalog } = fixture(); await controller.connect(); controller.selectReasoningEffort('high'); await controller.verify(); controller.set({ consent: true });
  setCatalog([{ id: 'other-account-model' }, { ...model, name: 'Updated display name' }]); await controller.refreshModels();
  assert.equal(controller.state.model, model.id); assert.equal(controller.state.reasoningEffort, 'high'); assert.equal(controller.state.verified, true); assert.equal(controller.state.consent, true); assert.equal(controller.state.connection, 'inference-confirmed');
});

test('refresh removing selected model requires explicit choice and never falls back to the first returned model', async () => {
  const { controller, calls, setCatalog } = fixture(); await controller.connect(); controller.selectReasoningEffort('high'); await controller.verify(); controller.set({ consent: true });
  setCatalog([{ id: 'other-account-model' }]); await controller.refreshModels();
  assert.equal(controller.state.model, ''); assert.equal(controller.state.reasoningEffort, ''); assert.equal(controller.state.verified, false); assert.equal(controller.state.consent, false); assert.equal(controller.state.connection, 'catalog-confirmed');
  const count = calls.length; controller.set({ draft: 'Fixture question', consent: true }); await controller.ask(); assert.equal(calls.length, count);
});

test('refresh failure retains the previous choice but invalidates inference and consent until catalog recovery', async () => {
  const { controller, calls, setCatalog } = fixture(); await controller.connect(); controller.selectReasoningEffort('high'); await controller.verify(); controller.set({ consent: true });
  const models = structuredClone(controller.state.models); setCatalog(new Error('Fixture catalog unavailable.')); await controller.refreshModels();
  assert.deepEqual(controller.state.models, models); assert.equal(controller.state.model, model.id); assert.equal(controller.state.reasoningEffort, 'high'); assert.equal(controller.state.verified, false); assert.equal(controller.state.consent, false); assert.equal(controller.state.connection, 'catalog-error'); assert.match(controller.state.status, /refresh successfully before sending/); assert.match(controller.state.status, /catalog unavailable/);
  const count = calls.length; controller.set({ draft: 'Fixture question', consent: true }); await controller.ask(); assert.equal(calls.length, count);
});

test('changing only reasoning effort marks an existing Flow analysis stale and preserves its local result', async () => {
  const { controller } = fixture(); await controller.connect(); controller.selectReasoningEffort('high');
  const contextKey = controller.contextKey(); const messages = [{ id: 'flow-user', role: 'user', content: 'Fixture question.', contextKey }];
  const result = { contextKey, observations: [{ messageId: 'flow-user' }], analyzedTurns: 1, totalUserTurns: 1 };
  controller.set({ messages, flow: { phase: 'ready', result, progress: null, status: 'Fixture analysis ready.' } });
  assert.equal(isFlowCurrent(result, messages, contextKey), true);
  controller.selectReasoningEffort('medium');
  assert.equal(controller.state.flow.phase, 'stale'); assert.equal(controller.state.flow.result, result); assert.equal(controller.state.flow.progress, null); assert.match(controller.state.flow.status, /Analyze again/);
});

test('catalog failure blocks diagnostics while successful refresh restores readiness without a test', async () => {
  const { controller, calls, setCatalog } = fixture(); await controller.connect(); controller.selectReasoningEffort('high'); await controller.verify();
  setCatalog(new Error('Fixture catalog unavailable.')); await controller.refreshModels(); const count = calls.length;
  await controller.verify(); assert.equal(calls.length, count); assert.equal(controller.state.verified, false); assert.equal(controller.state.connection, 'catalog-error'); assert.match(controller.state.status, /Refresh the model catalog successfully/);
  setCatalog([model]); await controller.refreshModels(); assert.equal(controller.state.connection, 'catalog-confirmed'); assert.equal(controller.state.model, model.id); assert.equal(controller.state.reasoningEffort, 'high'); assert.equal(controller.state.verified, true); assert.equal(controller.state.inferenceConfirmed,false); assert.equal(controller.state.consent, false);assert.equal(calls.length,count);
  controller.set({draft:'Fixture question',consent:true});await controller.ask();await controller.mapPromise;assert.equal(calls.length,count+2);assert(calls.at(-1).input.startsWith('NOTEWORK_CONVERSATION_STRUCTURE_V1'));
});

test('refresh removing an effort chooses provider default, preserves readiness, and clears old-context consent', async () => {
  const { controller, setCatalog } = fixture(); await controller.connect(); controller.selectReasoningEffort('high'); await controller.verify(); controller.set({ consent: true });
  const before = controller.contextKey(); setCatalog([{ ...model, supportedReasoningEfforts: ['low'] }]); await controller.refreshModels();
  assert.equal(controller.state.model, model.id); assert.equal(controller.state.reasoningEffort, ''); assert.equal(controller.state.verified, true); assert.equal(controller.state.inferenceConfirmed,false); assert.equal(controller.state.consent, false); assert.notEqual(controller.contextKey(), before);
});

test('changing supported reasoning effort stays ready, resets response confirmation and transmission consent and excludes old-context conversation from new requests', async () => {
  const { controller, calls, saved } = fixture(); await controller.connect(); controller.selectReasoningEffort('high'); await controller.verify(); controller.set({ consent: true });
  const previous = controller.contextKey(); controller.set({ messages: [{ id: 'old-user', role: 'user', content: 'Private fixture from old effort context.', contextKey: previous }] });
  controller.selectReasoningEffort('medium'); assert.notEqual(controller.contextKey(), previous); assert.equal(controller.state.verified, true);assert.equal(controller.state.inferenceConfirmed,false); assert.equal(controller.state.consent, false); assert.equal(saved.at(-1).reasoningEffort, 'medium');
  const result = { contextKey: previous, observations: [{ messageId: 'old-user' }], analyzedTurns: 1, totalUserTurns: 1 }; assert.equal(isFlowCurrent(result, controller.state.messages, controller.contextKey()), false);
  controller.set({ draft: 'New fixture question', consent: true }); await controller.ask();
  const generation = calls.filter(call=>!call.input.startsWith('NOTEWORK_CONVERSATION_STRUCTURE_V1')).at(-1); assert.equal(generation.options.reasoningEffort, 'medium'); assert.ok(!generation.input.includes('Private fixture from old effort context.'));
});
