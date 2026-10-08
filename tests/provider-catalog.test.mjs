import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ClaudeCodeProvider } from '../src/providers/claude-code.mjs';
import { ApiKeyProvider } from '../src/providers/api-key.mjs';
import { JevProvider } from '../src/providers/jev.mjs';

const auth = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' };
async function claudeFixture(t, catalog) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'notework-catalog-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const executablePath = path.join(dir, 'claude.exe'); await writeFile(executablePath, 'fixture');
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const call = { args, options, input: '' }; calls.push(call);
    child.kill = () => { queueMicrotask(() => child.emit('close', 143)); return true; };
    child.stdin = new Writable({ write(chunk, encoding, done) { call.input += chunk.toString(); done(); } });
    queueMicrotask(() => {
      let output;
      if (args.includes('--version')) output = '2.1.286';
      else if (args.includes('status')) output = JSON.stringify(auth);
      else if (args.includes('--input-format')) {
        const request = JSON.parse(call.input);
        output = JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: { models: typeof catalog === 'function' ? catalog() : catalog, account: { email: 'private@example.invalid', token: 'secret' } } } });
      } else output = JSON.stringify({ type: 'result', subtype: 'success', result: 'fixture answer' });
      child.stdout.end(output + '\n'); child.emit('close', 0);
    });
    return child;
  };
  const provider = new ClaudeCodeProvider({ config: { executablePath }, cwd: dir, spawnImpl });
  await provider.connect(); return { provider, calls };
}

test('Claude discovers fresh account menu via control initialization without an inference message', async t => {
  const { provider, calls } = await claudeFixture(t, [
    { value: 'default', displayName: 'Default', resolvedModel: 'claude-opus-5[1m]' },
    { value: 'claude-fable-5-1[1m]', displayName: 'Fable', resolvedModel: 'claude-fable-5-1', supportedEffortLevels: ['low', 'high', 'made-up'], description: 'Current account option' },
    null, { value: '' }, { value: 'claude-fable-5-1[1m]', displayName: 'Fable' }
  ]);
  const models = await provider.listModels(); assert.deepEqual(models.map(model => model.id), ['default', 'claude-fable-5-1[1m]']);
  const discovery = calls.at(-1); const request = JSON.parse(discovery.input);
  assert.equal(request.type, 'control_request'); assert.equal(request.request.subtype, 'initialize'); assert.equal(request.request.hooks, null);
  assert.ok(discovery.args.includes('--safe-mode')); assert.ok(discovery.args.includes('--no-session-persistence')); assert.equal(discovery.options.shell, false);
  assert.equal(models[0].source, 'claude-code-runtime-catalog'); assert.equal(models[0].verified, false);
  assert.ok(!JSON.stringify(models).includes('secret')); assert.ok(!JSON.stringify(models).includes('private@example'));
  models[0].supportedReasoningEfforts.push('corrupt'); assert.ok(!provider.models[0].supportedReasoningEfforts.includes('corrupt'));
  assert.equal(await provider.generate('fixture prompt', { model: 'claude-fable-5-1[1m]' }), 'fixture answer');
  assert.equal(calls.at(-1).args[calls.at(-1).args.indexOf('--model') + 1], 'claude-fable-5-1[1m]');
  const count = calls.length; await assert.rejects(provider.generate('fixture', { model: 'public-but-unlisted-model' }), { code: 'MODEL_NOT_VERIFIED' }); assert.equal(calls.length, count);
});

test('Claude malformed refresh removes stale selectable models and fails without inference', async t => {
  let current = [{ value: 'default' }, { value: 'account-model' }];
  const { provider, calls } = await claudeFixture(t, () => current);
  await provider.listModels(); current = null;
  await assert.rejects(provider.listModels(), { code: 'INVALID_CATALOG' }); assert.deepEqual(provider.models, []);
  const count = calls.length; await assert.rejects(provider.generate('fixture', { model: 'account-model' }), { code: 'MODEL_NOT_VERIFIED' }); assert.equal(calls.length, count);
  assert.ok(calls.filter(call => call.args.includes('-p')).every(call => JSON.parse(call.input).type === 'control_request'));
});

const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
test('Anthropic latest account IDs and capabilities survive paginated catalogs without hardcoded family filtering', async () => {
  const calls = []; const responses = [json({ data: [null, { id: 'claude-sonnet-5-5', display_name: 'Sonnet 5.5', capabilities: { thinking: { supported: true } }, max_input_tokens: 1000000, max_tokens: 128000 }], has_more: true, last_id: 'claude-sonnet-5-5' }), json({ data: [{ id: 'future-account-model' }], has_more: false })];
  const provider = new ApiKeyProvider({ provider: 'anthropic', secrets: new Map([['api-anthropic', 'fixture']]), fetchImpl: async (url, options) => { calls.push({ url, options }); return responses.shift(); } });
  const models = await provider.listModels(); assert.deepEqual(models.map(model => model.id), ['claude-sonnet-5-5', 'future-account-model']);
  assert.equal(models[0].maxInputTokens, 1000000); assert.equal(models[0].maxOutputTokens, 128000); assert.deepEqual(models[0].capabilities, { thinking: { supported: true } }); assert.equal(models[0].verified, false);
  assert.ok(calls.every(call => call.options.method === 'GET')); assert.ok(calls[1].url.includes('after_id=claude-sonnet-5-5'));
});

test('API catalog failure cannot leave an old model selectable after refresh', async () => {
  const responses = [json({ data: [{ id: 'gpt-6.1-sol' }] }), json(null)];
  const provider = new ApiKeyProvider({ provider: 'openai', secrets: new Map([['api-openai', 'fixture']]), fetchImpl: async () => responses.shift() });
  await provider.connect(); await assert.rejects(provider.listModels(), { code: 'INVALID_CATALOG' });
  await assert.rejects(provider.generate('fixture', { model: 'gpt-6.1-sol' }), { code: 'MODEL_NOT_VERIFIED' });
});

test('OpenAI API explicitly sends selected GPT 6.1 Sol effort and rejects unsupported effort before inference', async () => {
  const calls = []; const responses = [json({ data: [{ id: 'gpt-6.1-sol' }, { id: 'custom-account-model', supported_reasoning_efforts: ['low', 'high'] }] }), new Response('data: {"type":"response.output_text.delta","delta":"fixture"}\n\ndata: {"type":"response.completed"}\n\n')];
  const provider = new ApiKeyProvider({ provider: 'openai', secrets: new Map([['api-openai', 'fixture']]), fetchImpl: async (url, options) => { calls.push({ url, options }); return responses.shift(); } });
  await provider.connect();
  await assert.rejects(provider.generate('fixture', { model: 'gpt-6.1-sol', reasoningEffort: 'ultra' }), { code: 'INVALID_REASONING_EFFORT' });
  await assert.rejects(provider.generate('fixture', { model: 'gpt-6.1-sol', reasoningEffort: 'typo' }), { code: 'INVALID_REASONING_EFFORT' });
  await assert.rejects(provider.generate('fixture', { model: 'custom-account-model', reasoningEffort: 'max' }), { code: 'INVALID_REASONING_EFFORT' });
  assert.equal(calls.length, 1); assert.equal(await provider.generate('fixture', { model: 'gpt-6.1-sol', reasoningEffort: 'high' }), 'fixture');
  assert.equal(calls[1].url, 'https://api.openai.com/v1/responses'); assert.deepEqual(JSON.parse(calls[1].options.body).reasoning, { effort: 'high' });
});

test('Jev uses current returned aliases, preserves provenance and does not invent undocumented version access', async () => {
  let current = { models: [null, { name: 'jev-latest', description: 'Current stable', release_date: '2026-09-01' }, { name: 'jev-preview' }, { name: 'jev-latest', description: 'Current stable', release_date: '2026-09-01' }, { name: '' }] };
  const calls = []; const provider = new JevProvider({ secrets: new Map([['jev', 'fixture']]), fetchImpl: async (url, options) => { calls.push({ url, options }); return json(current); } });
  const models = await provider.listModels(); assert.deepEqual(models.map(model => model.id), ['jev-latest', 'jev-preview']); assert.equal(models[0].releasedAt, '2026-09-01'); assert.equal(models[0].verified, false);
  models[0].id = 'corrupt'; assert.equal(provider.models[0].id, 'jev-latest');
  current = null; await assert.rejects(provider.listModels(), /catalog/); assert.deepEqual(provider.models, []);
  assert.ok(calls.every(call => call.url.endsWith('/models') && !call.options.body));
});
