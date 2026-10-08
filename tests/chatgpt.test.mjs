import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { ChatGPTSubscription, verifyIdToken } from '../src/providers/chatgpt.mjs';

const AUTH = 'https://auth.openai.com';
const TOKEN = `${AUTH}/api/accounts/oauth/token`;
const DISCOVERY = `${AUTH}/.well-known/openid-configuration`;
const JWKS = `${AUTH}/.well-known/jwks.json`;
const API = 'https://api.openai.com/v1';
const REVOKE = `${AUTH}/api/accounts/oauth/revoke`;
const DIRECT = 'chatgpt.tokens.use.direct';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
function jwt(claims = {}, key = privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: AUTH, sub: 'subject-1', aud: 'oaiapp_test', exp: now + 3600, iat: now,
    email: 'fixture@example.test', ...claims })).toString('base64url');
  return `${header}.${payload}.${sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), key).toString('base64url')}`;
}
function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'x-request-id': 'fixture-request' } }); }
function store() {
  const data = new Map();
  return { data, async get(key) { return data.get(key); }, async set(key, value) { assert.equal(typeof value, 'string'); data.set(key, value); },
    async delete(key) { data.delete(key); } };
}
function savedSession(extra = {}) {
  return { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', idToken: jwt(),
    clientId: 'oaiapp_test', subject: 'subject-1', email: 'fixture@example.test', scopes: [DIRECT, 'offline_access'],
    expiresAt: Date.now() + 3600000, ...extra };
}
function provider({ session, fetchImpl, openExternal, config = {} } = {}) {
  const secrets = store(); const changes = [];
  if (session) secrets.data.set('chatgpt.session', JSON.stringify(session));
  const safeConfig = { hostId: 'urn:uuid:11111111-1111-4111-8111-111111111111', ...config };
  const instance = new ChatGPTSubscription({ secrets, config: safeConfig, onConfig: async change => { changes.push(change); Object.assign(safeConfig, change); },
    fetchImpl: fetchImpl || (async () => { throw new Error('Unexpected service request'); }), openExternal });
  return { instance, secrets, config: safeConfig, changes };
}
function authFetch(getToken, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    if (url === TOKEN) return json(await getToken(new URLSearchParams(init.body)));
    if (url === DISCOVERY) return json({ issuer: AUTH, jwks_uri: JWKS, revocation_endpoint: REVOKE });
    if (url === JWKS) return json({ keys: [jwk] });
    throw new Error(`Unexpected service request: ${url}`);
  };
}
function stream(events, { byteChunks = false } = {}) {
  const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''));
  const body = new ReadableStream({ start(controller) {
    if (byteChunks) for (let index = 0; index < bytes.length; index++) controller.enqueue(bytes.slice(index, index + 1));
    else controller.enqueue(bytes);
    controller.close();
  } });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'x-request-id': 'stream-fixture' } });
}

test('explicit existing-login reuse validates a current grant without opening OAuth or making an inference request', async () => {
  let opened = 0; const calls = []; const previous = savedSession();
  const context = provider({ session: previous, openExternal: async () => { opened++; throw new Error('OAuth must not open during reuse.'); }, fetchImpl: async (url, init) => { calls.push({ url, init }); throw new Error('No service request is needed for a current grant.'); } });
  const status = await context.instance.connect({ reuseSession: true });
  assert.equal(status.connected, true); assert.equal(status.permissionGranted, true); assert.equal(status.account.subject, previous.subject); assert.equal(opened, 0); assert.deepEqual(calls, []);
  assert.deepEqual(JSON.parse(await context.secrets.get('chatgpt.session')), previous); assert.ok(!JSON.stringify(status).includes(previous.accessToken));
});

test('existing-login reuse refreshes an expired renewable grant only when renewal is permitted, without OAuth or inference', async () => {
  let opened = 0; const calls = [];
  const context = provider({ session: savedSession({ expiresAt: Date.now() - 1000, earliestRefreshAt: Date.now() - 2000 }),
    openExternal: async () => { opened++; throw new Error('OAuth must not open during refresh.'); },
    fetchImpl: authFetch(params => {
      assert.equal(params.get('grant_type'), 'refresh_token'); assert.equal(params.get('refresh_token'), 'fixture-refresh'); assert.equal(params.get('resource'), API);
      return { access_token: 'reused-rotated-access', refresh_token: 'reused-rotated-refresh', token_type: 'Bearer', expires_in: 3600, scope: `${DIRECT} offline_access` };
    }, calls) });
  const status = await context.instance.connect({ reuseSession: true }); assert.equal(status.connected, true); assert.equal(opened, 0); assert.deepEqual(calls.map(call => call.url), [TOKEN]);
  const stored = JSON.parse(await context.secrets.get('chatgpt.session')); assert.equal(stored.accessToken, 'reused-rotated-access'); assert.equal(stored.refreshToken, 'reused-rotated-refresh');
  const delayed = provider({ session: savedSession({ expiresAt: Date.now() - 1000, earliestRefreshAt: Date.now() + 60000 }), openExternal: async () => { opened++; }, fetchImpl: async () => { throw new Error('Early renewal must not request a token.'); } });
  await assert.rejects(delayed.instance.connect({ reuseSession: true }), { code: 'refresh_not_yet_allowed' }); assert.equal(opened, 0);
});

test('existing-login reuse fails closed for missing grant or missing permission without starting a browser sign-in', async () => {
  let opened = 0; let requests = 0;
  const noGrant = provider({ openExternal: async () => { opened++; }, fetchImpl: async () => { requests++; throw new Error('Missing grant must not call the service.'); } });
  await assert.rejects(noGrant.instance.connect({ reuseSession: true }), { code: 'not_connected' });
  const noPermission = provider({ session: savedSession({ scopes: ['offline_access'] }), openExternal: async () => { opened++; }, fetchImpl: async () => { requests++; throw new Error('Missing permission must not call the service.'); } });
  await assert.rejects(noPermission.instance.connect({ reuseSession: true }), { code: 'plan_permission_not_granted' });
  assert.equal(opened, 0); assert.equal(requests, 0);
});

test('OAuth uses an issued client ID, exact loopback redirect, PKCE, and protected token storage', async () => {
  let authUrl; let callbackPromise; const calls = [];
  const context = provider({
    openExternal: async url => {
      authUrl = new URL(url);
      assert.equal(authUrl.origin, AUTH);
      assert.equal(authUrl.searchParams.get('client_id'), 'dynamic_agent_client');
      assert.equal(authUrl.searchParams.get('agent_name_hint'), 'Notework');
      const redirect = new URL(authUrl.searchParams.get('redirect_uri'));
      assert.equal(redirect.hostname, '127.0.0.1'); assert.equal(redirect.pathname, '/auth/callback');
      redirect.searchParams.set('code', 'fixture-code'); redirect.searchParams.set('client_id', 'oaiapp_test');
      redirect.searchParams.set('state', authUrl.searchParams.get('state'));
      callbackPromise = fetch(redirect).then(response => assert.equal(response.status, 200));
      await callbackPromise;
    },
    fetchImpl: authFetch(params => {
      assert.equal(params.get('client_id'), 'oaiapp_test');
      assert.equal(params.get('redirect_uri'), authUrl.searchParams.get('redirect_uri'));
      assert.equal(params.get('resource'), API); assert.equal(params.get('grant_type'), 'authorization_code');
      assert.equal(createHash('sha256').update(params.get('code_verifier')).digest('base64url'), authUrl.searchParams.get('code_challenge'));
      return { access_token: 'new-access', refresh_token: 'new-refresh', id_token: jwt({ nonce: authUrl.searchParams.get('nonce') }),
        token_type: 'Bearer', expires_in: 3600, scope: `${DIRECT} offline_access openid email` };
    }, calls),
  });
  const status = await context.instance.connect();
  assert.equal(status.connected, true); assert.equal(status.account.email, 'fixture@example.test');
  assert.equal(context.config.clientId, 'oaiapp_test');
  assert.equal(JSON.stringify(context.config).includes('new-access'), false);
  assert.equal(JSON.stringify(context.config).includes('idToken'), false);
  const record = JSON.parse(await context.secrets.get('chatgpt.session'));
  assert.equal(record.accessToken, 'new-access'); assert.equal(record.refreshToken, 'new-refresh');
  assert.deepEqual(calls.map(call => call.url), [TOKEN, DISCOVERY, JWKS]);
});

test('wrong OAuth state never exchanges a code and preserves the previous connection', async () => {
  const previous = savedSession(); let requests = 0;
  const context = provider({ session: previous, config: { clientId: 'oaiapp_test', accountSub: 'subject-1' },
    fetchImpl: async () => { requests++; throw new Error('must not call'); },
    openExternal: async url => {
      const callback = new URL(new URL(url).searchParams.get('redirect_uri'));
      callback.searchParams.set('state', 'wrong-state'); callback.searchParams.set('code', 'wrong-code');
      assert.equal((await fetch(callback)).status, 400);
    } });
  await assert.rejects(context.instance.connect(), error => error.code === 'state_mismatch');
  assert.equal(requests, 0); assert.deepEqual(JSON.parse(await context.secrets.get('chatgpt.session')), previous);
});

test('returning OAuth rejects another issued client ID before token exchange', async () => {
  const context = provider({ session: savedSession(), config: { clientId: 'oaiapp_test', accountSub: 'subject-1' },
    openExternal: async url => {
      const auth = new URL(url); assert.equal(auth.searchParams.has('agent_name_hint'), false);
      assert.equal(auth.searchParams.get('client_id'), 'oaiapp_test'); assert.ok(auth.searchParams.get('id_token_hint'));
      const callback = new URL(auth.searchParams.get('redirect_uri'));
      callback.searchParams.set('state', auth.searchParams.get('state')); callback.searchParams.set('code', 'fixture-code');
      callback.searchParams.set('client_id', 'oaiapp_other'); await fetch(callback);
    } });
  await assert.rejects(context.instance.connect(), error => error.code === 'invalid_callback');
});

test('ID JWT rejects forged signatures, wrong issuer, audience, subject, expiry and nonce', () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(verifyIdToken(jwt({ nonce: 'n' }), [jwk], { clientId: 'oaiapp_test', nonce: 'n' }).subject, 'subject-1');
  for (const claims of [{ iss: 'https://example.test' }, { aud: 'other' }, { exp: now - 1 }, { nonce: 'wrong' }, { sub: 'other' }]) {
    assert.throws(() => verifyIdToken(jwt({ nonce: 'n', ...claims }), [jwk], { clientId: 'oaiapp_test', nonce: 'n', subject: 'subject-1' }),
      error => error.code === 'invalid_id_token_claims');
  }
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => verifyIdToken(jwt({}, other.privateKey), [jwk], { clientId: 'oaiapp_test' }),
    error => error.code === 'invalid_id_token_signature');
});

test('valid sign-in without direct permission stays signed in and blocks inference', async () => {
  let nonce;
  const context = provider({ openExternal: async url => {
    const auth = new URL(url); nonce = auth.searchParams.get('nonce'); const callback = new URL(auth.searchParams.get('redirect_uri'));
    for (const [key, value] of Object.entries({ state: auth.searchParams.get('state'), code: 'fixture-code', client_id: 'oaiapp_test' })) callback.searchParams.set(key, value);
    await fetch(callback);
  }, fetchImpl: authFetch(() => ({ access_token: 'identity-access', id_token: jwt({ nonce }), token_type: 'Bearer', expires_in: 3600, scope: 'openid email' })) });
  const status = await context.instance.connect();
  assert.equal(status.signedIn, true); assert.equal(status.connected, false);
  assert.equal(status.reason, 'plan_permission_not_granted');
  await assert.rejects(context.instance.generate('hello', { model: 'fixture-model' }), error => error.code === 'plan_permission_not_granted');
});

test('model catalog filters visibility and preserves server ordering', async () => {
  const context = provider({ session: savedSession(), fetchImpl: async (url, init) => {
    assert.equal(url, `${API}/models`); assert.equal(init.headers.Authorization, 'Bearer fixture-access'); assert.equal(init.redirect, 'error');
    return json({ models: [{ slug: 'model-b', display_name: 'Model B', visibility: 'list' },
      { slug: 'hidden', display_name: 'Hidden', visibility: 'hidden' }, { slug: 'model-a', display_name: 'Model A', visibility: 'list' }] });
  } });
  assert.deepEqual(await context.instance.listModels(), [{ id: 'model-b', name: 'Model B', source: 'chatgpt-subscription' },
    { id: 'model-a', name: 'Model A', source: 'chatgpt-subscription' }]);
});

test('concurrent catalog requests serialize refresh and atomically store token rotation', async () => {
  let refreshes = 0;
  const context = provider({ session: savedSession({ expiresAt: Date.now() - 1 }), fetchImpl: async (url, init) => {
    if (url === TOKEN) {
      refreshes++; const params = new URLSearchParams(init.body);
      assert.equal(params.get('grant_type'), 'refresh_token'); assert.equal(params.get('client_id'), 'oaiapp_test');
      assert.equal(params.get('refresh_token'), 'fixture-refresh'); assert.equal(params.has('scope'), false);
      await new Promise(resolve => setTimeout(resolve, 15));
      return json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600, token_type: 'Bearer', scope: `${DIRECT} offline_access` });
    }
    assert.equal(url, `${API}/models`); assert.equal(init.headers.Authorization, 'Bearer rotated-access');
    return json({ models: [] });
  } });
  await Promise.all([context.instance.listModels(), context.instance.listModels()]);
  assert.equal(refreshes, 1);
  const record = JSON.parse(await context.secrets.get('chatgpt.session'));
  assert.equal(record.refreshToken, 'rotated-refresh'); assert.equal(record.accessToken, 'rotated-access');
});

test('refresh refuses a replacement identity from another account', async () => {
  const prior = savedSession({ expiresAt: Date.now() - 1 });
  const context = provider({ session: prior, fetchImpl: authFetch(() => ({ access_token: 'wrong-account', refresh_token: 'wrong-refresh',
    id_token: jwt({ sub: 'other-user' }), token_type: 'Bearer', expires_in: 3600, scope: DIRECT })) });
  await assert.rejects(context.instance.listModels(), error => error.code === 'invalid_id_token_claims');
  assert.deepEqual(JSON.parse(await context.secrets.get('chatgpt.session')), prior);
});

test('Responses stream decodes split Korean UTF-8 and requires a completed terminal event', async () => {
  const deltas = [];
  const context = provider({ session: savedSession(), fetchImpl: async (url, init) => {
    assert.equal(url, `${API}/responses`);
    assert.deepEqual(JSON.parse(init.body), { model: 'fixture-model', input: [{ role: 'user', content: '노트 질문' }], store: false, stream: true });
    return stream([{ type: 'response.output_text.delta', delta: '안녕' }, { type: 'response.output_text.delta', delta: '하세요' },
      { type: 'response.completed', response: { status: 'completed' } }], { byteChunks: true });
  } });
  assert.equal(await context.instance.generate('노트 질문', { model: 'fixture-model', onDelta: delta => deltas.push(delta) }), '안녕하세요');
  assert.deepEqual(deltas, ['안녕', '하세요']);
});

test('stream ending without completed is an error, even after partial text', async () => {
  const context = provider({ session: savedSession(), fetchImpl: async () => stream([{ type: 'response.output_text.delta', delta: 'partial' }]) });
  await assert.rejects(context.instance.generate('question', { model: 'fixture-model' }), error => error.code === 'stream_missing_completion');
});

test('a usage limit arriving after streaming starts is preserved without retry or billing fallback', async () => {
  let requests = 0; const deltas = [];
  const context = provider({ session: savedSession(), fetchImpl: async () => { requests++; return stream([
    { type: 'response.output_text.delta', delta: 'partial' }, { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'app limit reached' } } },
  ]); } });
  await assert.rejects(context.instance.generate('question', { model: 'fixture-model', onDelta: delta => deltas.push(delta) }),
    error => error.code === 'subscription_sharing_usage_limit_exceeded' && error.requestId === 'stream-fixture');
  assert.equal(requests, 1); assert.deepEqual(deltas, ['partial']); assert.equal((await context.instance.status()).connected, true);
});

test('incomplete response remains distinguishable from successful completion', async () => {
  const context = provider({ session: savedSession(), fetchImpl: async () => stream([{ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }]) });
  await assert.rejects(context.instance.generate('question', { model: 'fixture-model' }), error => error.code === 'response_incomplete' && error.reason === 'max_output_tokens');
});

test('HTTP admission detail and request ID survive without assuming an API error object', async () => {
  const context = provider({ session: savedSession(), fetchImpl: async () => json({ detail: 'Direct routing is not enabled.' }, 503) });
  await assert.rejects(context.instance.generate('question', { model: 'fixture-model' }),
    error => error.code === 'http_503' && error.status === 503 && error.requestId === 'fixture-request' && error.body.detail === 'Direct routing is not enabled.');
});

test('request timeout aborts transport and never retries', async () => {
  let requests = 0;
  const context = provider({ session: savedSession(), fetchImpl: async (url, init) => {
    requests++; return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  await assert.rejects(context.instance.generate('question', { model: 'fixture-model', timeoutMs: 15 }), error => error.code === 'timeout');
  assert.equal(requests, 1);
});

test('OAuth cancellation closes the callback and keeps the previous session', async () => {
  const controller = new AbortController(); const previous = savedSession(); let redirect;
  const context = provider({ session: previous, openExternal: async url => {
    redirect = new URL(url).searchParams.get('redirect_uri'); controller.abort();
  } });
  await assert.rejects(context.instance.connect({ signal: controller.signal }), error => error.code === 'cancelled');
  assert.deepEqual(JSON.parse(await context.secrets.get('chatgpt.session')), previous);
  await assert.rejects(fetch(redirect));
});

test('sign-out revokes the renewable session and retains safe registration metadata', async () => {
  const context = provider({ session: savedSession(), config: { clientId: 'oaiapp_test', accountSub: 'subject-1' },
    fetchImpl: async (url, init) => {
      if (url === DISCOVERY) return json({ issuer: AUTH, revocation_endpoint: REVOKE });
      assert.equal(url, REVOKE);
      const params = new URLSearchParams(init.body);
      assert.equal(params.get('token'), 'fixture-refresh'); assert.equal(params.get('token_type_hint'), 'refresh_token');
      assert.equal(params.get('client_id'), 'oaiapp_test'); return new Response(null, { status: 200 });
    } });
  assert.deepEqual(await context.instance.disconnect(), { remoteRevoked: true, warning: undefined });
  assert.equal(await context.secrets.get('chatgpt.session'), undefined);
  assert.equal(context.config.clientId, 'oaiapp_test'); assert.equal((await context.instance.status()).connected, false);
});

test('unconfirmed remote revocation clears local tokens and reports the limitation', async () => {
  const context = provider({ session: savedSession(), fetchImpl: async () => { throw new Error('offline'); } });
  const result = await context.instance.disconnect();
  assert.equal(result.remoteRevoked, false); assert.ok(result.warning); assert.equal(await context.secrets.get('chatgpt.session'), undefined);
});

test('malicious discovery cannot redirect JWT key retrieval or revoke credentials', async () => {
  const context = provider({ session: savedSession(), fetchImpl: async url => {
    assert.equal(url, DISCOVERY); return json({ issuer: AUTH, revocation_endpoint: 'https://example.test/steal' });
  } });
  assert.equal((await context.instance.disconnect()).remoteRevoked, false);
});

test('stream accepts CR-only newlines and a final event without a blank separator', async () => {
  const raw = 'data: {"type":"response.output_text.delta","delta":"끝"}\r\rdata: {"type":"response.completed","response":{"status":"completed"}}\r';
  const context = provider({ session: savedSession(), fetchImpl: async () => new Response(raw, { headers: { 'Content-Type': 'text/event-stream' } }) });
  assert.equal(await context.instance.generate('question', { model: 'fixture-model' }), '끝');
});

test('disconnect waits for a pending OAuth attempt and cannot leave newly saved credentials', async () => {
  let launched;
  const browserReady = new Promise(resolve => { launched = resolve; });
  const context = provider({ openExternal: async () => { launched(); } });
  const connecting = context.instance.connect();
  const rejected = assert.rejects(connecting, error => error.code === 'cancelled');
  await browserReady;
  assert.equal((await context.instance.disconnect()).remoteRevoked, true);
  await rejected;
  assert.equal(await context.secrets.get('chatgpt.session'), undefined);
});

test('revocation retries a transient server failure once before clearing the local session', async () => {
  let attempts = 0;
  const context = provider({ session: savedSession(), fetchImpl: async url => {
    if (url === DISCOVERY) return json({ issuer: AUTH, revocation_endpoint: REVOKE });
    assert.equal(url, REVOKE); attempts++;
    return new Response(null, { status: attempts === 1 ? 503 : 200 });
  } });
  assert.equal((await context.instance.disconnect()).remoteRevoked, true);
  assert.equal(attempts, 2); assert.equal(await context.secrets.get('chatgpt.session'), undefined);
});

function answerItem(text, phase = 'final_answer', extra = {}) {
  return { type: 'message', role: 'assistant', phase, status: 'completed', content: [{ type: 'output_text', text }], ...extra };
}

test('subscription requests send explicit high effort and answer instructions without API-only output controls', async () => {
  let body;
  const context = provider({ session: savedSession(), fetchImpl: async (url, init) => {
    body = JSON.parse(init.body);
    return stream([{ type: 'response.completed', response: { status: 'completed', output: [answerItem('A complete answer.')] } }]);
  } });
  assert.equal(await context.instance.generate('question', { model: 'gpt-6.1-sol', reasoningEffort: 'high', instructions: 'Solve the problem and explain the evidence.' }), 'A complete answer.');
  assert.deepEqual(body.reasoning, { effort: 'high' });
  assert.equal(body.instructions, 'Solve the problem and explain the evidence.');
  assert.equal(Object.hasOwn(body, 'text'), false);
  assert.equal(Object.hasOwn(body, 'max_output_tokens'), false);
  assert.equal(body.store, false); assert.equal(body.stream, true);
});

test('invalid or overlong UTF-8 instructions fail before any subscription request', async () => {
  let calls = 0;
  const context = provider({ session: savedSession(), fetchImpl: async () => { calls++; throw new Error('No request is allowed.'); } });
  for (const instructions of [null, 12, {}, ['text'], '가'.repeat(5462)]) {
    await assert.rejects(context.instance.generate('q', { model: 'gpt-6.1-sol', instructions }), { code: 'invalid_instructions' });
  }
  assert.equal(calls, 0);
});

test('completed final output fills missing streamed suffix instead of truncating the answer', async () => {
  const deltas = [];
  const final = 'First point.\n\nSecond point with full supporting detail.';
  const context = provider({ session: savedSession(), fetchImpl: async () => stream([
    { type: 'response.output_text.delta', delta: 'First point.' },
    { type: 'response.completed', response: { status: 'completed', output: [answerItem(final)] } },
  ]) });
  assert.equal(await context.instance.generate('q', { model: 'fixture-model', onDelta: delta => deltas.push(delta) }), final);
  assert.equal(deltas.join(''), final);
});

test('final_answer output replaces an earlier divergent preview and excludes commentary', async () => {
  const deltas = [];
  const context = provider({ session: savedSession(), fetchImpl: async () => stream([
    { type: 'response.output_item.added', output_index: 0, item: answerItem('working', 'commentary', { id: 'commentary-1', status: 'in_progress' }) },
    { type: 'response.output_text.delta', item_id: 'commentary-1', output_index: 0, delta: 'I will look at the notes.' },
    { type: 'response.output_text.delta', item_id: 'unidentified-preview', output_index: 1, delta: 'Old brief draft.' },
    { type: 'response.completed', response: { status: 'completed', output: [answerItem('I will look at the notes.', 'commentary'), answerItem('The full final answer contains evidence and practical next steps.')] } },
  ]) });
  assert.equal(await context.instance.generate('q', { model: 'fixture-model', onDelta: delta => deltas.push(delta) }), 'The full final answer contains evidence and practical next steps.');
  assert.deepEqual(deltas, ['Old brief draft.']);
});

test('unphased completed assistant output remains compatible and completed content is required when supplied', async () => {
  const context = provider({ session: savedSession(), fetchImpl: async () => stream([
    { type: 'response.completed', response: { status: 'completed', output: [answerItem('Unphased answer.', null)] } },
  ]) });
  assert.equal(await context.instance.generate('q', { model: 'fixture-model' }), 'Unphased answer.');
  for (const [response, code] of [
    [{ status: 'completed', output: [] }, 'empty_response'],
    [{ status: 'completed', output: [answerItem('Only commentary.', 'commentary')] }, 'empty_response'],
    [{ status: 'completed', output: [answerItem('Unfinished.', 'final_answer', { status: 'incomplete' })] }, 'invalid_completion'],
    [{ status: 'incomplete', output: [answerItem('Partial.')] }, 'invalid_completion'],
    [{ status: 'completed', output: 'malformed' }, 'invalid_completion'],
  ]) {
    const invalid = provider({ session: savedSession(), fetchImpl: async () => stream([{ type: 'response.output_text.delta', delta: 'partial' }, { type: 'response.completed', response }]) });
    await assert.rejects(invalid.instance.generate('q', { model: 'fixture-model' }), { code });
  }
});

test('cancelling while delivering the authoritative final output cannot report success', async () => {
  const controller = new AbortController();
  const context = provider({ session: savedSession(), fetchImpl: async () => stream([
    { type: 'response.completed', response: { status: 'completed', output: [answerItem('Final answer.')] } },
  ]) });
  await assert.rejects(context.instance.generate('q', { model: 'fixture-model', signal: controller.signal, onDelta: async () => { await Promise.resolve(); controller.abort(); } }), { code: 'cancelled' });
});

test('disposing a plugin instance preserves the saved ChatGPT grant for reload reuse without revocation',async()=>{
  const previous=savedSession();let requests=0;
  const context=provider({session:previous,fetchImpl:async()=>{requests++;throw new Error('No service call is allowed.');}});
  context.instance.dispose();context.instance.dispose();
  assert.deepEqual(JSON.parse(await context.secrets.get('chatgpt.session')),previous);
  await assert.rejects(context.instance.listModels(),{code:'disposed'});assert.equal(requests,0);
  const replacement=new ChatGPTSubscription({secrets:context.secrets,config:context.config,fetchImpl:async()=>{requests++;throw new Error('No service call is needed to reuse a current grant.');}});
  assert.equal((await replacement.connect({reuseSession:true})).connected,true);assert.equal(requests,0);
});

test('disposing during official sign-in cancels only this callback and keeps the prior connection',async()=>{
  const ready={};ready.promise=new Promise(resolve=>{ready.resolve=resolve;});const previous=savedSession();let requests=0;
  const context=provider({session:previous,fetchImpl:async()=>{requests++;throw new Error('No token exchange is allowed.');},openExternal:async()=>ready.resolve()});
  const pending=context.instance.connect();const cancelled=assert.rejects(pending,{code:'cancelled'});await ready.promise;context.instance.dispose();await cancelled;
  assert.deepEqual(JSON.parse(await context.secrets.get('chatgpt.session')),previous);assert.equal(requests,0);
});
