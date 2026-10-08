import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { CodexSubscriptionProvider } from '../src/providers/codex-subscription.mjs';

// Synthetic protocol fixtures only: no native process, real OAuth, credential
// file, network request, or inference is used by any test in this file.
const LOGIN_ID = 'synthetic-owned-login';
const AUTH_URL = 'https://auth.openai.com/oauth/authorize?state=synthetic-only';
const ACCOUNT = { type: 'chatgpt', planType: 'pro', email: 'synthetic-private@example.test', routing: 'synthetic-private-route' };
const MODEL = { id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', displayName: 'Sol', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'High' }], inputModalities: ['text'], serviceTiers: [] };

function fixture({ account = null, authUrl = AUTH_URL, loginId = LOGIN_ID, start, opener } = {}) {
  const children = [], spawns = [], opened = [], statuses = [];
  let reads = 0;
  const spawnImpl = (...args) => {
    spawns.push(args);
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.calls = []; child.killed = false;
    child.kill = () => { child.killed = true; };
    child.send = message => child.stdout.write(JSON.stringify(message) + '\n');
    child.reply = (request, result) => child.send({ id: request.id, result });
    child.complete = (id = loginId, success = true, extra = {}) => child.send({ method: 'account/login/completed', params: { loginId: id, success, ...extra } });
    child.stdin = new Writable({ write(chunk, _encoding, callback) {
      const request = JSON.parse(chunk.toString()); child.calls.push(request);
      queueMicrotask(() => {
        if (child.killed) return;
        if (request.method === 'initialize') child.reply(request, {});
        else if (request.method === 'account/read') child.reply(request, { account: ++reads === 1 ? account : ACCOUNT });
        else if (request.method === 'account/login/start') {
          if (start) start(request, child);
          else child.reply(request, { type: 'chatgpt', loginId, authUrl });
        } else if (request.method === 'model/list') child.reply(request, { data: [MODEL], nextCursor: null });
        else if (request.method === 'account/login/cancel' && request.id !== undefined) child.reply(request, { status: 'canceled' });
      });
      callback();
    } });
    children.push(child); return child;
  };
  const openExternal = opener === null ? undefined : url => {
    opened.push(url);
    if (opener) return opener(children.at(-1), url);
    children.at(-1).complete();
  };
  const provider = new CodexSubscriptionProvider({ cwd: process.cwd(), spawnImpl, resolveCommand: async () => '/synthetic/official/codex', openExternal, timeoutMs: 100 });
  const connect = options => provider.connect({ loginTimeoutMs: 100, onStatus: value => statuses.push(value), ...options });
  return { provider, connect, children, spawns, opened, statuses };
}

function calls(f, method) { return f.children.flatMap(child => child.calls).filter(call => call.method === method); }
function assertClosed(f) { assert.equal(f.provider.active.size, 0); assert.ok(f.children.every(child => child.killed)); }
function assertOnlyOwnedCancel(f) {
  const cancelled = calls(f, 'account/login/cancel');
  assert.ok(cancelled.length > 0, 'failure cancels the sign-in started by this connection');
  for (const request of cancelled) {
    assert.ok(Number.isInteger(request.id) && request.id > 0, 'cancel is a request with an RPC id');
    assert.deepEqual(request.params, { loginId: LOGIN_ID });
  }
}
function assertNoCredentialMutation(f) {
  const methods = f.children.flatMap(child => child.calls.map(call => call.method));
  assert.equal(methods.includes('account/logout'), false);
  assert.ok(methods.every(method => ['initialize', 'initialized', 'account/read', 'account/login/start', 'account/login/cancel', 'model/list'].includes(method)), 'only sign-in/account/catalog protocol methods are used');
  for (const [command, args, options] of f.spawns) {
    assert.equal(command, '/synthetic/official/codex');
    assert.equal(args[0], 'app-server');
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.ok(!args.some(value => /logout|auth\.json|remove|delete/i.test(value)));
  }
}

test('fresh ChatGPT sign-in waits for its completion then reads account and Sol/high catalog', async () => {
  const f = fixture();
  const status = await f.connect();
  assert.deepEqual(f.opened, [AUTH_URL]);
  assert.deepEqual(calls(f, 'account/login/start')[0].params, { type: 'chatgpt', useHostedLoginSuccessPage: true, appBrand: 'chatgpt' });
  assert.deepEqual(f.children[0].calls.map(call => call.method), ['initialize', 'initialized', 'account/read', 'account/login/start', 'account/read', 'model/list']);
  assert.deepEqual(status.account, { type: 'chatgpt', planType: 'pro' });
  assert.equal(status.connected, true); assert.equal(status.modelCount, 1);
  assert.deepEqual(f.provider.models.map(model => [model.model, model.supportedReasoningEfforts.map(option => option.reasoningEffort)]), [['gpt-6.1-sol', ['high']]]);
  assert.deepEqual(f.statuses.map(status => status.state), ['starting-login', 'waiting-login', 'confirming-login', 'connected']);
  assert.equal(JSON.stringify(f.statuses).includes('synthetic-private'), false);
  assert.equal(calls(f, 'account/login/cancel').length, 0);
  assertClosed(f); assertNoCredentialMutation(f);
});

test('existing ChatGPT login is reused without starting sign-in or opening a browser', async () => {
  const f = fixture({ account: ACCOUNT, opener: () => assert.fail('browser must not open') });
  const status = await f.connect({ reuseSession: true });
  assert.equal(status.connected, true); assert.deepEqual(f.opened, []);
  assert.equal(calls(f, 'account/login/start').length, 0);
  assert.equal(calls(f, 'account/read').length, 1);
  assert.equal(calls(f, 'model/list').length, 1);
  assertClosed(f); assertNoCredentialMutation(f);
});

test('existing-login option reports missing account without starting a browser login', async () => {
  const f = fixture();
  await assert.rejects(f.connect({ reuseSession: true }), { code: 'SUBSCRIPTION_LOGIN_REQUIRED' });
  assert.deepEqual(f.opened, []); assert.equal(calls(f, 'account/login/start').length, 0);
  assert.equal(calls(f, 'model/list').length, 0); assertClosed(f); assertNoCredentialMutation(f);
});

test('explicit newAccount starts a fresh browser sign-in even with an existing account', async () => {
  const f = fixture({ account: ACCOUNT });
  await f.connect({ newAccount: true, reuseSession: true });
  assert.equal(calls(f, 'account/login/start').length, 1); assert.equal(calls(f, 'account/read').length, 2);
  assert.deepEqual(f.opened, [AUTH_URL]); assertClosed(f); assertNoCredentialMutation(f);
});

test('completion arriving before login/start response is correlated and skips browser opening', async () => {
  const f = fixture({ start(request, child) {
    child.complete('someone-elses-login', true);
    child.complete(LOGIN_ID, true);
    child.reply(request, { type: 'chatgpt', loginId: LOGIN_ID, authUrl: AUTH_URL });
  }, opener: () => assert.fail('completed login does not need a browser') });
  await f.connect();
  assert.deepEqual(f.opened, []);
  assert.deepEqual(f.statuses.map(status => status.state), ['starting-login', 'confirming-login', 'connected']);
  assert.equal(calls(f, 'account/login/cancel').length, 0); assertClosed(f);
});

test('mismatched completion id cannot authorize the account or advance to the catalog', async () => {
  const f = fixture({ opener: child => child.complete('someone-elses-login', true) });
  await assert.rejects(f.connect(), { code: 'LOGIN_TIMEOUT' });
  assert.equal(calls(f, 'account/read').length, 1); assert.equal(calls(f, 'model/list').length, 0);
  assertOnlyOwnedCancel(f); assertClosed(f); assertNoCredentialMutation(f);
});

test('failed matching completion is sanitized and does not cancel an already completed login', async () => {
  const privateDiagnostic = 'synthetic-secret-private-account@example.test';
  const f = fixture({ opener: child => child.complete(LOGIN_ID, false, { error: privateDiagnostic, email: privateDiagnostic, authUrl: AUTH_URL }) });
  await assert.rejects(f.connect(), error => {
    assert.equal(error.code, 'LOGIN_FAILED'); assert.equal(error.message, 'ChatGPT sign-in did not complete. Retry sign-in.');
    assert.equal(JSON.stringify({ message: error.message, ...error }).includes(privateDiagnostic), false); return true;
  });
  assert.equal(JSON.stringify(f.statuses).includes(privateDiagnostic), false);
  assert.equal(calls(f, 'account/read').length, 1); assert.equal(calls(f, 'model/list').length, 0);
  assert.equal(calls(f, 'account/login/cancel').length, 0); assertClosed(f); assertNoCredentialMutation(f);
});

test('unsafe sign-in URLs never reach opener and cancel only the owned sign-in', async () => {
  for (const authUrl of ['http://auth.openai.com/oauth/authorize', 'https://auth.openai.com.evil.test/oauth/authorize', 'https://auth.openai.com/oauth/authorize#fragment', 'https://user:pass@auth.openai.com/oauth/authorize', 'https://chatgpt.com/unrecognized', 'https://auth.openai.com:444/oauth/authorize', 'javascript:alert(1)', 'https://auth.openai.com/oauth/authorize\n']) {
    const f = fixture({ authUrl });
    await assert.rejects(f.connect(), { code: 'UNSAFE_LOGIN_URL' });
    assert.deepEqual(f.opened, []); assertOnlyOwnedCancel(f); assertClosed(f); assertNoCredentialMutation(f);
  }
});

test('missing browser opener fails before creating a login identity', async () => {
  const f = fixture({ opener: null });
  await assert.rejects(f.connect(), { code: 'BROWSER_UNAVAILABLE' });
  assert.equal(calls(f, 'account/login/start').length, 0); assert.equal(calls(f, 'account/login/cancel').length, 0);
  assertClosed(f); assertNoCredentialMutation(f);
});

test('login deadline cancels using the owned RPC id and releases the child', async () => {
  const f = fixture({ opener: () => {} });
  await assert.rejects(f.connect(), { code: 'LOGIN_TIMEOUT' });
  assertOnlyOwnedCancel(f); assert.equal(calls(f, 'model/list').length, 0); assertClosed(f); assertNoCredentialMutation(f);
});

test('default sign-in stays active past five minutes and accepts browser completion at six minutes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ opener: () => {} });
  // Call the production entry point without loginTimeoutMs: the short timeout
  // used by the other test fixtures must not conceal a default-timeout defect.
  const connecting = f.provider.connect({ onStatus: value => f.statuses.push(value) });
  let settled = false;
  connecting.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.opened, [AUTH_URL]);
  assert.equal(f.provider.active.size, 1);
  t.mock.timers.tick(300001);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'the old five-minute boundary must not expire a live default login');
  assert.equal(f.children[0].killed, false);
  assert.equal(f.provider.active.size, 1);
  assert.equal(calls(f, 'account/login/cancel').length, 0);
  assert.equal(calls(f, 'account/read').length, 1);
  assert.equal(calls(f, 'model/list').length, 0);
  t.mock.timers.tick(59999);
  f.children[0].complete();
  const status = await connecting;
  assert.equal(status.connected, true);
  assert.equal(status.modelCount, 1);
  assert.equal(calls(f, 'account/read').length, 2);
  assert.equal(calls(f, 'model/list').length, 1);
  assertClosed(f);
  const statusCount = f.statuses.length;
  // Successful completion must clear the long deadline, not merely settle the
  // caller while leaving a later cancellation/status update behind.
  t.mock.timers.tick(3600000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.statuses.length, statusCount);
  assert.equal(calls(f, 'account/login/cancel').length, 0);
  assert.equal(f.statuses.at(-1).state, 'connected');
  assertNoCredentialMutation(f);
});

test('default sign-in still expires at twenty minutes and cleans up its owned session', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ opener: () => {} });
  const connecting = f.provider.connect();
  const rejection = assert.rejects(connecting, { code: 'LOGIN_TIMEOUT' });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(1199999);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.children[0].killed, false);
  assert.equal(calls(f, 'account/login/cancel').length, 0);
  t.mock.timers.tick(1);
  await rejection;
  assertOnlyOwnedCancel(f); assertClosed(f); assertNoCredentialMutation(f);
});

test('long sign-in timeout accepts one hour but rejects invalid or unbounded values', async () => {
  const max = fixture();
  await max.connect({ loginTimeoutMs: 3600000 });
  assertClosed(max); assertNoCredentialMutation(max);
  for (const loginTimeoutMs of [99, 3600001, Infinity, NaN, 1200000.5, '1200000']) {
    const f = fixture();
    await assert.rejects(f.connect({ loginTimeoutMs }), { code: 'INVALID_TIMEOUT' });
    assert.equal(calls(f, 'account/login/start').length, 0);
    assert.equal(calls(f, 'account/login/cancel').length, 0);
    assert.deepEqual(f.opened, []); assertClosed(f); assertNoCredentialMutation(f);
  }
});

test('abort during browser wait cancels owned sign-in and releases the child', async () => {
  const controller = new AbortController();
  const f = fixture({ opener: () => { queueMicrotask(() => controller.abort()); } });
  await assert.rejects(f.connect({ signal: controller.signal }), { code: 'CANCELLED', name: 'AbortError' });
  assertOnlyOwnedCancel(f); assertClosed(f); assertNoCredentialMutation(f);
});

test('already aborted connection does not spawn or open anything', async () => {
  const controller = new AbortController(); controller.abort();
  const f = fixture();
  await assert.rejects(f.connect({ signal: controller.signal }), { code: 'CANCELLED' });
  assert.deepEqual(f.spawns, []); assert.deepEqual(f.opened, []); assert.equal(f.provider.active.size, 0);
});

test('browser opener rejection is sanitized and cancels the owned login', async () => {
  const f = fixture({ opener: () => Promise.reject(new Error('synthetic-private-browser-diagnostic')) });
  await assert.rejects(f.connect(), error => {
    assert.equal(error.code, 'BROWSER_UNAVAILABLE'); assert.equal(error.message.includes('synthetic-private'), false); return true;
  });
  assertOnlyOwnedCancel(f); assertClosed(f); assertNoCredentialMutation(f);
});

test('hung browser opener remains bounded by the login deadline', { timeout: 2000 }, async () => {
  const f = fixture({ opener: () => new Promise(() => {}) });
  await assert.rejects(f.connect(), { code: 'LOGIN_TIMEOUT' });
  assertOnlyOwnedCancel(f); assertClosed(f); assertNoCredentialMutation(f);
});

test('matching login completion releases a hung browser opener', { timeout: 2000 }, async () => {
  const f = fixture({ opener: child => { queueMicrotask(() => child.complete()); return new Promise(() => {}); } });
  const status = await f.connect();
  assert.equal(status.connected, true); assert.equal(calls(f, 'account/login/cancel').length, 0);
  assert.equal(calls(f, 'model/list').length, 1); assertClosed(f);
});

test('abort releases a hung opener without waiting for its promise', { timeout: 2000 }, async () => {
  const controller = new AbortController();
  const f = fixture({ opener: () => { queueMicrotask(() => controller.abort()); return new Promise(() => {}); } });
  await assert.rejects(f.connect({ signal: controller.signal }), { code: 'CANCELLED' });
  assertOnlyOwnedCancel(f); assertClosed(f);
});

test('child close during a hung browser opener promptly fails the connection', { timeout: 2000 }, async () => {
  const f = fixture({ opener: child => { queueMicrotask(() => child.emit('close', 1)); return new Promise(() => {}); } });
  await assert.rejects(f.connect(), { code: 'CLI_EXITED' });
  assert.equal(calls(f, 'model/list').length, 0); assertClosed(f); assertNoCredentialMutation(f);
});

test('invalid login identity cannot open browser or cancel an unowned sign-in', async () => {
  for (const loginId of ['', 123, 'x'.repeat(257)]) {
    const f = fixture({ loginId });
    await assert.rejects(f.connect(), { code: 'INVALID_LOGIN' });
    assert.deepEqual(f.opened, []); assert.equal(calls(f, 'account/login/cancel').length, 0); assertClosed(f);
  }
});

test('disconnect closes an active sign-in without issuing logout or auth-file operations', async () => {
  const f = fixture({ opener: () => { queueMicrotask(() => f.provider.disconnect()); } });
  await assert.rejects(f.connect(), { code: 'CANCELLED' });
  assert.deepEqual(f.provider.status().account, null); assert.deepEqual(f.provider.models, []);
  assertClosed(f); assertNoCredentialMutation(f);
});
