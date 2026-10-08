import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { CodexRpcSession, CodexSubscriptionProvider, codexSubscriptionEnvironment, resolveCodexCommand } from '../src/providers/codex-subscription.mjs';

const model = { id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', displayName: 'Sol', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'High' }], inputModalities: ['text'], serviceTiers: [] };
function fixture(handler) {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false; child.calls = [];
  child.kill = () => { child.killed = true; };
  child.emitMessage = message => child.stdout.write(JSON.stringify(message) + '\n');
  child.stdin = new Writable({ write(chunk, _encoding, callback) {
    const request = JSON.parse(chunk.toString()); child.calls.push(request);
    queueMicrotask(() => { handler(request, child); }); callback();
  } });
  return child;
}
function providerWith(extra = () => false, config = {}) {
  const children = []; const spawnCalls = [];
  const spawnImpl = (...args) => {
    spawnCalls.push(args);
    const child = fixture((request, child) => {
      if (extra(request, child)) return;
      const result = request.method === 'initialize' ? {} : request.method === 'account/read' ? { account: { type: 'chatgpt', email: 'private@example.test', planType: 'pro' } } : request.method === 'model/list' ? { data: [model], nextCursor: null } : request.method === 'thread/start' ? { thread: { id: 'thread-1', ephemeral: true }, model: 'gpt-6.1-sol', sandbox: { type: 'readOnly' }, approvalPolicy: 'never' } : request.method === 'turn/start' ? { turn: { id: 'turn-1' } } : {};
      if (request.id) child.emitMessage({ id: request.id, result });
      if (request.method === 'turn/start') {
        child.emitMessage({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'Hello' } });
        child.emitMessage({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } } });
      }
    }); children.push(child); return child;
  };
  return { provider: new CodexSubscriptionProvider({ cwd: process.cwd(), spawnImpl, resolveCommand: async () => '/official/codex', config, timeoutMs: 100 }), children, spawnCalls };
}

test('native executable discovery rejects shell wrappers and relative commands', async () => {
  await assert.rejects(resolveCodexCommand({ executablePath: 'codex.cmd' }), { code: 'INVALID_CLI_PATH' });
  await assert.rejects(resolveCodexCommand({ executablePath: 'C:\\cli\\codex.ps1' }, {}, 'win32'), { code: 'INVALID_CLI_PATH' });
  assert.deepEqual(codexSubscriptionEnvironment({ PATH: 'safe', OPENAI_API_KEY: 'secret', OPENAI_BASE_URL: 'override', CODEX_AUTH_TOKEN: 'token' }), { PATH: 'safe' });
});

test('Windows desktop fallback stays within bounded hash folders and selects newest regular binary', async () => {
  const root = 'C:\\Local\\OpenAI\\Codex\\bin'; let stats = 0;
  const entries = Array.from({ length: 25 }, (_, index) => ({ name: (index + 1).toString(16).padStart(16, '0'), isDirectory: () => true }));
  entries.unshift({ name: '..', isDirectory: () => true }, { name: 'not-a-hash', isDirectory: () => true });
  const fsImpl = {
    readdir: async directory => { assert.equal(directory, root); return entries; },
    lstat: async file => { stats++; return { isFile: () => !file.includes('0000000000000002'), mtimeMs: file.includes('0000000000000003') ? 99 : 1 }; },
    realpath: async file => file.includes('0000000000000004') ? 'C:\\Outside\\codex.exe' : file
  };
  const found = await resolveCodexCommand({}, { LOCALAPPDATA: 'C:\\Local' }, 'win32', fsImpl);
  assert.equal(found, root + '\\0000000000000003\\codex.exe'); assert.equal(stats, 20);
  await assert.rejects(resolveCodexCommand({}, { LOCALAPPDATA: 'relative' }, 'win32', fsImpl), { code: 'CLI_NOT_FOUND' });
});

test('connect uses initialize/initialized, sanitized account metadata and native hidden spawn', async () => {
  const { provider, children, spawnCalls } = providerWith();
  const result = await provider.connect();
  assert.equal(result.connected, true); assert.deepEqual(result.account, { type: 'chatgpt', planType: 'pro' });
  assert.equal(JSON.stringify(result).includes('private@example'), false);
  assert.deepEqual(children[0].calls.map(call => call.method), ['initialize', 'initialized', 'account/read', 'model/list']);
  assert.deepEqual(children[0].calls[2].params, { refreshToken: false });
  assert.equal(spawnCalls[0][2].shell, false); assert.equal(spawnCalls[0][2].windowsHide, true); assert.equal(children[0].killed, true);
});

test('retained metadata-only spawn wrapper explains successful connection followed by write failure', async () => {
  const clean = providerWith();
  const nativeSpawn = clean.provider.spawn;
  const metadataOnlySpawn = (...args) => {
    const child = nativeSpawn(...args); const write = child.stdin.write;
    child.stdin.write = function(chunk, ...rest) {
      const message = JSON.parse(chunk.toString());
      if (!['initialize', 'initialized', 'account/read', 'model/list'].includes(message.method)) {
        throw new Error('Blocked by metadata-only lifecycle QA.');
      }
      return write.call(this, chunk, ...rest);
    };
    return child;
  };
  // Construction captures the injected spawn function. Restoring the external
  // module property alone cannot replace this already-constructed provider.
  const retained = new CodexSubscriptionProvider({ cwd: process.cwd(), spawnImpl: metadataOnlySpawn, resolveCommand: async () => '/official/codex', timeoutMs: 100 });
  await retained.connect({ reuseSession: true });
  assert.equal(retained.status().connected, true);
  await assert.rejects(retained.generate('synthetic mock question', { model: model.id, reasoningEffort: 'high' }), { code: 'CLI_WRITE_FAILED' });
  assert.equal(clean.children.at(-1).calls.some(call => call.method === 'thread/start'), false);
  const rebuilt = new CodexSubscriptionProvider({ cwd: process.cwd(), spawnImpl: nativeSpawn, resolveCommand: async () => '/official/codex', timeoutMs: 100 });
  await rebuilt.connect({ reuseSession: true });
  assert.equal(await rebuilt.generate('synthetic mock question', { model: model.id, reasoningEffort: 'high' }), 'Hello');
  assert.equal(clean.children.flatMap(child => child.calls).filter(call => call.method === 'turn/start').length, 1);
});

test('model pagination preserves capabilities and rejects repeating cursors', async () => {
  let pages = 0;
  const { provider } = providerWith((request, child) => {
    if (request.method !== 'model/list') return false;
    child.emitMessage({ id: request.id, result: { data: [model], nextCursor: ++pages === 1 ? 'next' : null } }); return true;
  });
  const models = await provider.listModels(); assert.equal(models.length, 1); assert.equal(pages, 2);
  assert.deepEqual(models[0].supportedReasoningEfforts, model.supportedReasoningEfforts);
  const loop = providerWith((request, child) => { if (request.method !== 'model/list') return false; child.emitMessage({ id: request.id, result: { data: [], nextCursor: 'repeat' } }); return true; });
  await assert.rejects(loop.provider.listModels(), { code: 'INVALID_PAGINATION' });
});

test('generation streams exact selected model/effort through ephemeral read-only thread', async () => {
  const { provider, children } = providerWith(); await provider.connect(); const deltas = [];
  assert.equal(await provider.generate('Synthetic question', { model: 'gpt-6.1-sol', reasoningEffort: 'high', onDelta: text => deltas.push(text) }), 'Hello');
  assert.deepEqual(deltas, ['Hello']);
  const thread = children[1].calls.find(call => call.method === 'thread/start').params;
  assert.equal(thread.ephemeral, true); assert.equal(thread.sandbox, 'read-only'); assert.equal(thread.approvalPolicy, 'never'); assert.equal(thread.allowProviderModelFallback, false);
  assert.deepEqual(thread.environments, []); assert.deepEqual(thread.runtimeWorkspaceRoots, []); assert.deepEqual(thread.dynamicTools, []);
  const turn = children[1].calls.find(call => call.method === 'turn/start').params;
  assert.equal(turn.model, 'gpt-6.1-sol'); assert.equal(turn.effort, 'high'); assert.deepEqual(turn.sandboxPolicy, { type: 'readOnly', networkAccess: false });
});

test('unknown model/unsupported effort fails before inference', async () => {
  const { provider, children } = providerWith(); await provider.connect();
  await assert.rejects(provider.generate('q', { model: 'invented', reasoningEffort: 'high' }), { code: 'MODEL_NOT_VERIFIED' });
  await assert.rejects(provider.generate('q', { model: 'gpt-6.1-sol', reasoningEffort: 'ultra' }), { code: 'INVALID_REASONING_EFFORT' });
  assert.equal(children.length, 1);
});

test('model default effort is used only when advertised and explicit high is preserved', async () => {
  const { provider, children } = providerWith(); await provider.connect();
  for (const reasoningEffort of [undefined, '', 'high']) {
    assert.equal(await provider.generate('q', { model: model.id, reasoningEffort }), 'Hello');
    const turn = children.at(-1).calls.find(call => call.method === 'turn/start'); assert.equal(turn.params.effort, 'high');
  }
  provider.models[0].defaultReasoningEffort = 'unadvertised';
  await assert.rejects(provider.generate('q', { model: model.id }), { code: 'INVALID_REASONING_EFFORT' });
  provider.models[0].defaultReasoningEffort = undefined;
  await assert.rejects(provider.generate('q', { model: model.id, reasoningEffort: '' }), { code: 'INVALID_REASONING_EFFORT' });
});

test('tool action notification interrupts instead of returning success', async () => {
  const { provider, children } = providerWith((request, child) => {
    if (request.method !== 'turn/start') return false;
    child.emitMessage({ id: request.id, result: { turn: { id: 'turn-1' } } });
    child.emitMessage({ method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'commandExecution' } } }); return true;
  });
  await provider.connect(); await assert.rejects(provider.generate('q', { model: 'gpt-6.1-sol', reasoningEffort: 'high' }), { code: 'TEXT_ONLY_RUNTIME_UNAVAILABLE' });
  assert.ok(children[1].calls.some(call => call.method === 'turn/interrupt')); assert.equal(children[1].killed, true);
});

test('failed completion and externally changed account are surfaced', async () => {
  const failing = providerWith((request, child) => {
    if (request.method !== 'turn/start') return false;
    child.emitMessage({ id: request.id, result: { turn: { id: 'turn-1' } } });
    child.emitMessage({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'failed', items: [] } } }); return true;
  });
  await failing.provider.connect(); await assert.rejects(failing.provider.generate('q', { model: model.id, reasoningEffort: 'high' }), { code: 'TURN_FAILED' });
  let authReads = 0;
  const changed = providerWith((request, child) => { if (request.method !== 'account/read' || ++authReads === 1) return false; child.emitMessage({ id: request.id, result: { account: { type: 'apiKey' } } }); return true; });
  await changed.provider.connect(); await assert.rejects(changed.provider.generate('q', { model: model.id, reasoningEffort: 'high' }), { code: 'SUBSCRIPTION_LOGIN_REQUIRED' });
});

test('abort interrupts a live turn and closes the child', async () => {
  const controller = new AbortController();
  const { provider, children } = providerWith((request, child) => {
    if (request.method !== 'turn/start') return false;
    child.emitMessage({ id: request.id, result: { turn: { id: 'turn-1' } } });
    setImmediate(() => controller.abort()); return true;
  });
  await provider.connect(); await assert.rejects(provider.generate('q', { model: model.id, reasoningEffort: 'high', signal: controller.signal }), { code: 'CANCELLED' });
  assert.ok(children[1].calls.some(call => call.method === 'turn/interrupt')); assert.equal(children[1].killed, true);
});

test('bounded RPC rejects malformed JSON, interactive server request and timeout', async () => {
  for (const scenario of ['malformed', 'interactive', 'timeout']) {
    const child = fixture((_request, child) => {
      if (scenario === 'malformed') child.stdout.write('broken\n');
      if (scenario === 'interactive') child.emitMessage({ id: 'approval', method: 'item/commandExecution/requestApproval', params: {} });
    });
    const session = new CodexRpcSession(child, { timeoutMs: 100 });
    const code = { malformed: 'INVALID_PROTOCOL', interactive: 'UNSUPPORTED_SERVER_REQUEST', timeout: 'TIMEOUT' }[scenario];
    await assert.rejects(session.request('initialize', {}), { code }); assert.equal(child.killed, true);
  }
});

test('output overflow closes connection without retaining diagnostics', async () => {
  const child = fixture((_request, child) => child.stderr.write('x'.repeat(2048)));
  const session = new CodexRpcSession(child, { timeoutMs: 100, maxBytes: 1024 });
  await assert.rejects(session.request('initialize', {}), { code: 'OUTPUT_LIMIT' }); assert.equal(child.killed, true);
});

const fivePointAnswer = '1. Identify the cause.\n2. Compare the evidence.\n3. Explain the options.\n4. Recommend the next action.\n5. State what remains uncertain.';
function answerFixture(events) {
  return providerWith((request, child) => {
    if (request.method !== 'turn/start') return false;
    child.emitMessage({ id: request.id, result: { turn: { id: 'turn-1' } } });
    for (const event of events) child.emitMessage(event);
    return true;
  });
}
const itemEvent = (method, item) => ({ method, params: { threadId: 'thread-1', turnId: 'turn-1', item } });
const deltaEvent = (itemId, delta) => ({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId, delta } });
const completedEvent = (items = [], status = 'completed') => ({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status, items } } });

test('authoritative completed item restores all five points omitted from streaming deltas', async () => {
  const item = { type: 'agentMessage', id: 'final-1', phase: 'final_answer', text: fivePointAnswer };
  const { provider } = answerFixture([itemEvent('item/started', { ...item, text: '' }), deltaEvent(item.id, '1. Identify the cause.'), itemEvent('item/completed', item), completedEvent()]);
  await provider.connect(); const deltas = [];
  assert.equal(await provider.generate('Give all five points.', { model: model.id, reasoningEffort: 'high', onDelta: text => deltas.push(text) }), fivePointAnswer);
  assert.equal(deltas.join(''), fivePointAnswer);
});

test('completed-only final answer is retained even when completed turn has no items', async () => {
  const item = { type: 'agentMessage', id: 'final-1', phase: 'final_answer', text: fivePointAnswer };
  const { provider } = answerFixture([itemEvent('item/completed', item), completedEvent()]);
  await provider.connect(); const deltas = [];
  assert.equal(await provider.generate('Give all five points.', { model: model.id, reasoningEffort: 'high', onDelta: text => deltas.push(text) }), fivePointAnswer);
  assert.equal(deltas.join(''), fivePointAnswer);
});

test('commentary and late phase metadata never become the displayed final answer', async () => {
  const commentary = { type: 'agentMessage', id: 'comment-1', phase: 'commentary', text: 'I will examine the evidence.' };
  const final = { type: 'agentMessage', id: 'final-1', phase: 'final_answer', text: fivePointAnswer };
  const { provider } = answerFixture([deltaEvent(commentary.id, commentary.text), itemEvent('item/completed', commentary), itemEvent('item/completed', final), completedEvent([commentary, final])]);
  await provider.connect(); const deltas = [];
  assert.equal(await provider.generate('Give all five points.', { model: model.id, reasoningEffort: 'high', onDelta: text => deltas.push(text) }), fivePointAnswer);
  assert.equal(deltas.join(''), fivePointAnswer);
});

test('legacy phase-null messages use authoritative completed text and preserve order', async () => {
  const first = { type: 'agentMessage', id: 'legacy-1', phase: null, text: 'First complete section.' };
  const second = { type: 'agentMessage', id: 'legacy-2', text: 'Second complete section.' };
  const { provider } = answerFixture([deltaEvent(first.id, 'First'), itemEvent('item/completed', first), itemEvent('item/completed', second), completedEvent()]);
  await provider.connect(); const deltas = [];
  const expected = first.text + '\n' + second.text;
  assert.equal(await provider.generate('Give both sections.', { model: model.id, reasoningEffort: 'high', onDelta: text => deltas.push(text) }), expected);
  assert.equal(deltas.join(''), expected);
});

for (const useTurnSnapshot of [false, true]) {
  test(`unattributed legacy deltas reconcile identified completed text once with ${useTurnSnapshot ? 'nonempty' : 'empty'} turn snapshot`, async () => {
    const item = { type: 'agentMessage', id: 'legacy-final-1', phase: null, text: fivePointAnswer };
    const delta = { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: '1. Identify the cause.' } };
    const { provider } = answerFixture([delta, itemEvent('item/completed', item), completedEvent(useTurnSnapshot ? [item] : [])]);
    await provider.connect(); const deltas = [];
    assert.equal(await provider.generate('Give all five points.', { model: model.id, reasoningEffort: 'high', onDelta: text => deltas.push(text) }), fivePointAnswer);
    assert.equal(deltas.join(''), fivePointAnswer);
  });
}

test('completed-turn snapshot determines message membership without content-string deduplication', async () => {
  const prior = { type: 'agentMessage', id: 'prior-1', phase: null, text: 'Earlier provisional section.' };
  const final = { type: 'agentMessage', id: 'snapshot-1', phase: null, text: 'Repeated text is intentional.' };
  const second = { ...final, id: 'snapshot-2' };
  const { provider } = answerFixture([itemEvent('item/completed', prior), completedEvent([final, second])]);
  await provider.connect(); const deltas = []; const expected = final.text + '\n' + second.text;
  assert.equal(await provider.generate('Keep both identical sections.', { model: model.id, reasoningEffort: 'high', onDelta: text => deltas.push(text) }), expected);
  assert.equal(deltas.join(''), expected);
});

test('a corrected authoritative final text replaces its earlier delta in the returned answer', async () => {
  const item = { type: 'agentMessage', id: 'final-1', phase: 'final_answer', text: fivePointAnswer };
  const { provider } = answerFixture([itemEvent('item/started', { ...item, text: '' }), deltaEvent(item.id, 'An earlier draft.'), itemEvent('item/completed', item), completedEvent()]);
  await provider.connect(); const deltas = [];
  assert.equal(await provider.generate('Give all five points.', { model: model.id, reasoningEffort: 'high', onDelta: text => deltas.push(text) }), fivePointAnswer);
  // An append-only callback cannot remove an earlier draft; do not concatenate
  // the authoritative replacement onto it. The caller receives the exact final.
  assert.equal(deltas.join(''), 'An earlier draft.');
});

test('failed turns cannot return completed item text as successful final answers', async () => {
  const item = { type: 'agentMessage', id: 'final-1', phase: null, text: fivePointAnswer };
  const { provider } = answerFixture([itemEvent('item/completed', item), completedEvent([], 'failed')]);
  await provider.connect(); const deltas = [];
  await assert.rejects(provider.generate('Give all five points.', { model: model.id, reasoningEffort: 'high', onDelta: text => deltas.push(text) }), { code: 'TURN_FAILED' });
  assert.deepEqual(deltas, []);
});

test('cancel discards buffered legacy final text and closes the active child', async () => {
  const abort = new AbortController(); const item = { type: 'agentMessage', id: 'legacy-1', phase: null, text: fivePointAnswer };
  const { provider, children } = providerWith((request, child) => {
    if (request.method !== 'turn/start') return false;
    child.emitMessage({ id: request.id, result: { turn: { id: 'turn-1' } } });
    child.emitMessage(itemEvent('item/completed', item)); setImmediate(() => abort.abort()); return true;
  });
  await provider.connect(); const deltas = [];
  await assert.rejects(provider.generate('Give all five points.', { model: model.id, reasoningEffort: 'high', signal: abort.signal, onDelta: text => deltas.push(text) }), { code: 'CANCELLED' });
  assert.deepEqual(deltas, []); assert.equal(children.at(-1).killed, true);
});

test('bounded task instructions are separate from evidence and retain text-only protections', async () => {
  const { provider, children } = providerWith(); await provider.connect();
  const instructions = 'For this classification task return only the exact JSON object requested by the user.';
  await provider.generate({ prompt: 'Classify the supplied example.', context: 'Synthetic evidence.' }, { model: model.id, reasoningEffort: 'high', instructions });
  const thread = children.at(-1).calls.find(call => call.method === 'thread/start').params;
  const turn = children.at(-1).calls.find(call => call.method === 'turn/start').params;
  assert.match(thread.baseInstructions, /Ground claims about the user's vault/); assert.ok(thread.baseInstructions.includes(instructions));
  assert.match(thread.baseInstructions, /Follow exact output formats/); assert.match(thread.developerInstructions, /Do not use shell/);
  assert.equal(turn.input[0].text.includes(instructions), false); assert.equal(turn.effort, 'high');
  for (const invalid of [null, {}, 1, 'x'.repeat(16 * 1024 + 1), '한'.repeat(6000)]) await assert.rejects(provider.generate('q', { model: model.id, reasoningEffort: 'high', instructions: invalid }), { code: 'INVALID_INSTRUCTIONS' });
  assert.equal(children.length, 2);
});
