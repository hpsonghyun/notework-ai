import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiKeyProvider } from '../src/providers/api-key.mjs';

const secrets = new Map([['api-openai', 'test-openai-key'], ['api-anthropic', 'test-anthropic-key']]);
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }); }
function sse(events, complete = true) { return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + (complete ? '' : '')); }
function fakeFetch(responses, calls = []) { return async (url, options) => { calls.push({ url, options }); const item = responses.shift(); if (!item) throw new Error('unexpected request'); return item; }; }

test('OpenAI connect lists live models with the supplied private key and makes no inference', async () => {
  const calls = []; const provider = new ApiKeyProvider({ provider: 'openai', secrets, fetchImpl: fakeFetch([json({ data: [{ id: 'account-model' }] })], calls) });
  const status = await provider.connect(); assert.equal(status.connected, true); assert.equal(status.mode, 'api-key'); assert.deepEqual(status.models.map(item => item.id), ['account-model']);
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://api.openai.com/v1/models'); assert.equal(calls[0].options.headers.authorization, 'Bearer test-openai-key'); assert.equal(calls[0].options.redirect, 'error');
  assert.equal(Object.hasOwn(provider, 'key'), false); assert.ok(!JSON.stringify(provider).includes('test-openai-key'));
});

test('Anthropic model pagination preserves API version and uses only returned models', async () => {
  const calls = []; const provider = new ApiKeyProvider({ provider: 'anthropic', secrets, fetchImpl: fakeFetch([json({ data: [{ id: 'first', display_name: 'First' }], has_more: true, last_id: 'first' }), json({ data: [{ id: 'second' }], has_more: false })], calls) });
  const status = await provider.connect(); assert.deepEqual(status.models.map(item => item.id), ['first', 'second']); assert.ok(calls[1].url.endsWith('after_id=first')); assert.equal(calls[0].options.headers['anthropic-version'], '2023-06-01'); assert.equal(calls[0].options.headers['x-api-key'], 'test-anthropic-key');
});

test('OpenAI Responses uses a streaming request and returns only a completed answer', async () => {
  const calls = []; const deltas = []; const provider = new ApiKeyProvider({ provider: 'openai', secrets, fetchImpl: fakeFetch([json({ data: [{ id: 'live-model' }] }), sse([{ type: 'response.output_text.delta', delta: 'Hello' }, { type: 'response.completed', response: { status: 'completed' } }])], calls) });
  await provider.connect(); assert.equal(await provider.generate({ prompt: 'question', context: 'local note', system: 'cite notes' }, { model: 'live-model', onDelta: item => deltas.push(item) }), 'Hello');
  const body = JSON.parse(calls[1].options.body); assert.equal(calls[1].url, 'https://api.openai.com/v1/responses'); assert.equal(body.store, false); assert.equal(body.stream, true); assert.equal(body.instructions, 'cite notes'); assert.ok(body.input[0].content[0].text.includes('local note')); assert.deepEqual(deltas, ['Hello']);
});

test('Anthropic Messages sends separate system instruction and detects message_stop', async () => {
  const calls = []; const provider = new ApiKeyProvider({ provider: 'anthropic', secrets, fetchImpl: fakeFetch([json({ data: [{ id: 'live-claude' }], has_more: false }), sse([{ type: 'content_block_delta', delta: { type: 'text_delta', text: '답변' } }, { type: 'message_stop' }])], calls) });
  await provider.connect(); assert.equal(await provider.generate({ prompt: '질문', system: '근거 제시' }, { model: 'live-claude' }), '답변'); const body = JSON.parse(calls[1].options.body); assert.equal(body.system, '근거 제시'); assert.equal(body.max_tokens, 4096); assert.equal(body.model, 'live-claude'); assert.equal(calls[1].url, 'https://api.anthropic.com/v1/messages');
});

test('Ollama lists installed local models without keys and detects done in NDJSON', async () => {
  const calls = []; const provider = new ApiKeyProvider({ provider: 'ollama', fetchImpl: fakeFetch([json({ models: [{ name: 'local-model:latest' }] }), new Response('{"message":{"content":"local"},"done":false}\n{"message":{"content":" answer"},"done":true}\n')], calls) });
  await provider.connect(); assert.equal(await provider.generate('question', { model: 'local-model:latest' }), 'local answer'); assert.ok(calls.every(call => call.url.startsWith('http://127.0.0.1:11434/'))); assert.equal(calls[0].options.headers.authorization, undefined);
});

test('Ollama remote addresses and custom credential destinations are rejected', () => {
  for (const baseUrl of ['http://remote.example:11434', 'https://127.0.0.1:11434', 'http://user:password@localhost:11434', 'http://localhost:11434/redirect']) assert.throws(() => new ApiKeyProvider({ provider: 'ollama', baseUrl }), { code: 'INVALID_LOCAL_ENDPOINT' });
  assert.throws(() => new ApiKeyProvider({ provider: 'openai', baseUrl: 'https://evil.example' }), { code: 'FIXED_PROVIDER_ENDPOINT' });
});

test('missing key makes no network request, and no environment or subscription auth is used', async () => {
  let called = false; const provider = new ApiKeyProvider({ provider: 'openai', secrets: new Map(), fetchImpl: async () => { called = true; throw new Error(); } });
  await assert.rejects(provider.connect(), { code: 'API_KEY_REQUIRED' }); assert.equal(called, false);
});

test('HTTP auth error is sanitized even if provider echoes private data', async () => {
  const provider = new ApiKeyProvider({ provider: 'openai', secrets, fetchImpl: fakeFetch([json({ error: { message: 'test-openai-key private-token' } }, 401)]) });
  await assert.rejects(provider.connect(), error => error.code === 'AUTH_FAILED' && !/test-openai-key|private-token/.test(error.message)); assert.equal((await provider.status()).connected, false);
});

test('unknown model is rejected before inference rather than guessed or substituted', async () => {
  const calls = []; const provider = new ApiKeyProvider({ provider: 'openai', secrets, fetchImpl: fakeFetch([json({ data: [{ id: 'only-model' }] })], calls) }); await provider.connect();
  await assert.rejects(provider.generate('question', { model: 'unknown' }), { code: 'MODEL_NOT_VERIFIED' }); assert.equal(calls.length, 1);
});

test('truncated stream and error event do not turn partial text into success', async () => {
  for (const events of [[{ type: 'response.output_text.delta', delta: 'partial' }], [{ type: 'response.output_text.delta', delta: 'partial' }, { type: 'response.failed', error: { message: 'secret' } }]]) {
    const provider = new ApiKeyProvider({ provider: 'openai', secrets, fetchImpl: fakeFetch([json({ data: [{ id: 'only-model' }] }), sse(events)]) }); await provider.connect();
    await assert.rejects(provider.generate('question', { model: 'only-model' }), error => ['INCOMPLETE_RESPONSE', 'PROVIDER_REQUEST_FAILED'].includes(error.code) && !error.message.includes('secret'));
  }
});

test('cancellation releases a streaming reader and rejects without changing providers', async () => {
  let readerCancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"part"}\n\n')); }, cancel() { readerCancelled = true; } });
  const provider = new ApiKeyProvider({ provider: 'openai', secrets, fetchImpl: fakeFetch([json({ data: [{ id: 'only-model' }] }), new Response(body)]) }); await provider.connect();
  const controller = new AbortController(); const promise = provider.generate('question', { model: 'only-model', signal: controller.signal, onDelta: () => controller.abort() });
  await assert.rejects(promise, { name: 'AbortError', code: 'CANCELLED' }); assert.equal(readerCancelled, true); assert.equal(provider.provider, 'openai');
});

test('CRLF streaming frame boundaries split across network chunks still parse', async () => {
  const chunks = ['data: {"type":"response.output_text.delta","delta":"yes"}\r', '\n\r', '\ndata: {"type":"response.completed"}\r\n\r\n'];
  const stream = new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } });
  const provider = new ApiKeyProvider({ provider: 'openai', secrets, fetchImpl: fakeFetch([json({ data: [{ id: 'm' }] }), new Response(stream)]) }); await provider.connect(); assert.equal(await provider.generate('q', { model: 'm' }), 'yes');
});

function finalItem(text, phase = 'final_answer', extra = {}) {
  return { type: 'message', role: 'assistant', phase, status: 'completed', content: [{ type: 'output_text', text }], ...extra };
}

test('answer instructions are merged with input system text in every API transport', async () => {
  for (const providerName of ['openai', 'anthropic', 'ollama']) {
    const calls = [];
    const catalog = providerName === 'ollama' ? { models: [{ name: 'model' }] } : { data: [{ id: 'model' }], has_more: false };
    const answer = providerName === 'openai' ? sse([{ type: 'response.completed', response: { status: 'completed', output: [finalItem('Answer.')] } }])
      : providerName === 'anthropic' ? sse([{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Answer.' } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }])
        : new Response('{"message":{"content":"Answer."},"done":true}\n');
    const provider = new ApiKeyProvider({ provider: providerName, secrets, fetchImpl: fakeFetch([json(catalog), answer], calls) });
    await provider.connect();
    assert.equal(await provider.generate({ prompt: 'Question.', system: 'Cite retrieved notes.' }, { model: 'model', instructions: 'Explain a workable solution.' }), 'Answer.');
    const body = JSON.parse(calls[1].options.body);
    const system = providerName === 'openai' ? body.instructions : providerName === 'anthropic' ? body.system : body.messages.find(item => item.role === 'system').content;
    assert.equal(system, 'Explain a workable solution.\n\nCite retrieved notes.');
  }
});

test('invalid instruction types and combined UTF-8 size fail before any inference request', async () => {
  const calls = [];
  const provider = new ApiKeyProvider({ provider: 'openai', secrets, fetchImpl: fakeFetch([json({ data: [{ id: 'model' }] })], calls) });
  await provider.connect();
  for (const instructions of [null, 12, {}, ['text'], '가'.repeat(5462)]) await assert.rejects(provider.generate('q', { model: 'model', instructions }), { code: 'INVALID_INSTRUCTIONS' });
  for (const system of [null, false, {}, '가'.repeat(5462)]) await assert.rejects(provider.generate({ prompt: 'q', system }, { model: 'model' }), { code: 'INVALID_INSTRUCTIONS' });
  await assert.rejects(provider.generate({ prompt: 'q', system: 'a'.repeat(8192) }, { model: 'model', instructions: 'b'.repeat(8192) }), { code: 'INVALID_INSTRUCTIONS' });
  assert.equal(calls.length, 1);
});

test('API OpenAI sends a supported high effort and preserves requests without optional instructions', async () => {
  const calls = [];
  const response = () => sse([{ type: 'response.completed', response: { status: 'completed', output: [finalItem('Answer.')] } }]);
  const provider = new ApiKeyProvider({ provider: 'openai', secrets, fetchImpl: fakeFetch([json({ data: [{ id: 'gpt-6.1-sol' }] }), response(), response()], calls) });
  await provider.connect();
  await provider.generate('q', { model: 'gpt-6.1-sol', reasoningEffort: 'high', instructions: 'Solve the problem.' });
  assert.deepEqual(JSON.parse(calls[1].options.body).reasoning, { effort: 'high' });
  assert.equal(JSON.parse(calls[1].options.body).instructions, 'Solve the problem.');
  await provider.generate('classification request', { model: 'gpt-6.1-sol' });
  const classification = JSON.parse(calls[2].options.body);
  assert.equal(Object.hasOwn(classification, 'instructions'), false);
  assert.equal(Object.hasOwn(classification, 'reasoning'), false);
});

test('OpenAI completed output restores a missing final suffix and excludes commentary deltas', async () => {
  const calls = []; const deltas = [];
  const answer = 'First point.\n\nSecond point with the evidence and a practical solution.';
  const provider = new ApiKeyProvider({ provider: 'openai', secrets, fetchImpl: fakeFetch([
    json({ data: [{ id: 'model' }] }), sse([
      { type: 'response.output_item.added', output_index: 0, item: finalItem('working', 'commentary', { id: 'commentary-1', status: 'in_progress' }) },
      { type: 'response.output_text.delta', item_id: 'commentary-1', output_index: 0, delta: 'I am inspecting the question.' },
      { type: 'response.output_text.delta', output_index: 1, delta: 'First point.' },
      { type: 'response.completed', response: { status: 'completed', output: [finalItem('I am inspecting the question.', 'commentary'), finalItem(answer)] } },
    ]),
  ], calls) });
  await provider.connect();
  assert.equal(await provider.generate('q', { model: 'model', onDelta: delta => deltas.push(delta) }), answer);
  assert.equal(deltas.join(''), answer); assert.equal(calls.length, 2);
});

test('OpenAI authoritative final_answer replaces a divergent partial preview', async () => {
  const deltas = [];
  const provider = new ApiKeyProvider({ provider: 'openai', secrets, fetchImpl: fakeFetch([
    json({ data: [{ id: 'model' }] }), sse([
      { type: 'response.output_text.delta', delta: 'Old short draft.' },
      { type: 'response.completed', response: { status: 'completed', output: [finalItem('Earlier unphased text.', null), finalItem('Complete final response.')] } },
    ]),
  ]) });
  await provider.connect();
  assert.equal(await provider.generate('q', { model: 'model', onDelta: delta => deltas.push(delta) }), 'Complete final response.');
  assert.deepEqual(deltas, ['Old short draft.']);
});

test('completed output rejects malformed, empty, commentary-only, and incomplete answers', async () => {
  for (const [response, code] of [
    [{ status: 'completed', output: [] }, 'EMPTY_RESPONSE'],
    [{ status: 'completed', output: [finalItem('Only commentary.', 'commentary')] }, 'EMPTY_RESPONSE'],
    [{ status: 'completed', output: [finalItem('Unfinished.', 'final_answer', { status: 'incomplete' })] }, 'INCOMPLETE_RESPONSE'],
    [{ status: 'incomplete', output: [finalItem('Partial.')] }, 'INCOMPLETE_RESPONSE'],
    [{ status: 'completed', output: 'malformed' }, 'INVALID_RESPONSE'],
  ]) {
    const provider = new ApiKeyProvider({ provider: 'openai', secrets, fetchImpl: fakeFetch([json({ data: [{ id: 'model' }] }), sse([{ type: 'response.output_text.delta', delta: 'partial' }, { type: 'response.completed', response }])]) });
    await provider.connect();
    await assert.rejects(provider.generate('q', { model: 'model' }), { code });
  }
});

test('nonstreaming OpenAI chooses final_answer and cancellation still prevents completion', async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController(); const deltas = [];
    const provider = new ApiKeyProvider({ provider: 'openai', secrets, streamResponses: false, fetchImpl: fakeFetch([
      json({ data: [{ id: 'model' }] }), json({ status: 'completed', output: [finalItem('Working.', 'commentary'), finalItem('Final answer.')] }),
    ]) });
    await provider.connect();
    const answer = provider.generate('q', { model: 'model', signal: controller.signal, onDelta: async delta => { deltas.push(delta); await Promise.resolve(); if (cancel) controller.abort(); } });
    if (cancel) await assert.rejects(answer, { name: 'AbortError', code: 'CANCELLED' });
    else assert.equal(await answer, 'Final answer.');
    assert.deepEqual(deltas, ['Final answer.']);
  }
});

test('cancelling during the streamed final suffix cannot report a successful answer', async () => {
  const controller = new AbortController();
  const provider = new ApiKeyProvider({ provider: 'openai', secrets, fetchImpl: fakeFetch([
    json({ data: [{ id: 'model' }] }), sse([{ type: 'response.completed', response: { status: 'completed', output: [finalItem('Final answer.')] } }]),
  ]) });
  await provider.connect();
  await assert.rejects(provider.generate('q', { model: 'model', signal: controller.signal, onDelta: async () => { await Promise.resolve(); controller.abort(); } }), { name: 'AbortError', code: 'CANCELLED' });
});

test('Anthropic max_tokens termination is an incomplete answer even when message_stop follows', async () => {
  const provider = new ApiKeyProvider({ provider: 'anthropic', secrets, fetchImpl: fakeFetch([
    json({ data: [{ id: 'model' }], has_more: false }), sse([
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Partial answer.' } },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }, { type: 'message_stop' },
    ]),
  ]) });
  await provider.connect();
  await assert.rejects(provider.generate('q', { model: 'model' }), { code: 'INCOMPLETE_RESPONSE' });
});
