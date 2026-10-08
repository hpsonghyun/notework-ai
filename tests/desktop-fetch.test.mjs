import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { desktopFetch } from '../src/desktop-fetch.mjs';

async function server(t, handler) {
  const instance = createServer(handler);
  await new Promise((resolve, reject) => { instance.once('error', reject); instance.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { instance.closeAllConnections(); await new Promise(resolve => instance.close(resolve)); });
  return { instance, url: `http://127.0.0.1:${instance.address().port}` };
}

test('Node transport sends JSON and first-party headers without renderer fetch', async t => {
  const endpoint = await server(t, async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk.toString('utf8');
    assert.equal(request.method, 'POST'); assert.equal(request.headers.authorization, 'Bearer synthetic-token');
    assert.equal(request.headers.host, new URL(endpoint.url).host);
    assert.equal(request.headers['content-length'], String(Buffer.byteLength(text)));
    assert.deepEqual(JSON.parse(text), { question: '내 노트는?' });
    response.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-ID': 'local-fixture' });
    response.end(JSON.stringify({ answer: '노트 답변' }));
  });
  const response = await desktopFetch(`${endpoint.url}/responses`, { method: 'POST',
    headers: { Authorization: 'Bearer synthetic-token', 'Content-Type': 'application/json', Host: 'another.test' },
    body: JSON.stringify({ question: '내 노트는?' }) });
  assert.equal(response.ok, true); assert.equal(response.status, 200); assert.equal(response.redirected, false);
  assert.equal(response.headers.get('x-REQUEST-id'), 'local-fixture'); assert.equal(response.headers.get('missing'), null);
  assert.deepEqual(await response.json(), { answer: '노트 답변' }); assert.equal(response.bodyUsed, true);
  await assert.rejects(response.text(), TypeError);
});

test('readable WebStream preserves UTF-8 chunks and supports getReader', async t => {
  const endpoint = await server(t, (request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const bytes = Buffer.from('data: 안녕하세요\n\n', 'utf8'); let index = 0;
    const timer = setInterval(() => { if (index < bytes.length) response.write(bytes.subarray(index, ++index)); else { clearInterval(timer); response.end(); } }, 1);
    response.on('close', () => clearInterval(timer));
  });
  const response = await desktopFetch(endpoint.url);
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let text = '';
  while (true) { const result = await reader.read(); if (result.done) break; text += decoder.decode(result.value, { stream: true }); }
  text += decoder.decode(); reader.releaseLock();
  assert.equal(text, 'data: 안녕하세요\n\n');
});

test('buffered text decoding handles Korean split across transport chunks', async t => {
  const endpoint = await server(t, (request, response) => {
    const bytes = Buffer.from('연결 성공', 'utf8');
    response.write(bytes.subarray(0, 1)); response.write(bytes.subarray(1, 5)); response.end(bytes.subarray(5));
  });
  assert.equal(await (await desktopFetch(endpoint.url)).text(), '연결 성공');
});

test('request timeout before headers destroys the connection', async t => {
  let closed;
  const disconnected = new Promise(resolve => { closed = resolve; });
  const endpoint = await server(t, (request, response) => { request.on('close', closed); });
  await assert.rejects(desktopFetch(endpoint.url, { timeoutMs: 30 }), error => error.code === 'TIMEOUT');
  await disconnected;
});

test('timeout remains active after headers and rejects an unfinished body', async t => {
  const endpoint = await server(t, (request, response) => { response.writeHead(200); response.write('started'); });
  const response = await desktopFetch(endpoint.url, { timeoutMs: 35 });
  assert.equal(response.status, 200);
  await assert.rejects(response.text(), error => error.code === 'TIMEOUT');
});

test('AbortSignal aborts before headers and preserves the caller reason', async t => {
  const endpoint = await server(t, () => {}); const controller = new AbortController();
  const pending = desktopFetch(endpoint.url, { signal: controller.signal });
  const reason = new Error('caller-cancelled'); controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
});

test('AbortSignal aborts after headers and terminates a reader waiting for the next chunk', async t => {
  let close; const disconnected = new Promise(resolve => { close = resolve; });
  const endpoint = await server(t, (request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write('first'); response.on('close', close);
  });
  const controller = new AbortController(); const response = await desktopFetch(endpoint.url, { signal: controller.signal });
  const reader = response.body.getReader(); assert.equal(new TextDecoder().decode((await reader.read()).value), 'first');
  const next = reader.read(); const reason = new Error('stream-cancelled'); controller.abort(reason);
  await assert.rejects(next, error => error === reason); await disconnected;
});

test('reader cancellation closes the Node response and its pending transport', async t => {
  let close; const disconnected = new Promise(resolve => { close = resolve; });
  const endpoint = await server(t, (request, response) => { response.write('first'); response.on('close', close); });
  const response = await desktopFetch(endpoint.url); const reader = response.body.getReader(); await reader.read();
  await reader.cancel(); await disconnected;
});

test('redirects are refused without forwarding authorization to the target', async t => {
  let targetRequests = 0;
  const target = await server(t, (request, response) => { targetRequests++; response.end('must not be reached'); });
  const initial = await server(t, (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer synthetic-token');
    response.writeHead(307, { Location: `${target.url}/steal` }); response.end();
  });
  await assert.rejects(desktopFetch(initial.url, { headers: { Authorization: 'Bearer synthetic-token' } }), error => error.code === 'REDIRECT_REFUSED');
  assert.equal(targetRequests, 0);
});

test('non-success HTTP bodies remain available for provider diagnostics', async t => {
  const endpoint = await server(t, (request, response) => { response.writeHead(429, { 'Content-Type': 'application/json' }); response.end('{"error":{"code":"fixture_limit"}}'); });
  const response = await desktopFetch(endpoint.url); assert.equal(response.ok, false); assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: { code: 'fixture_limit' } });
});

test('declared and streamed oversized buffered responses are rejected', async t => {
  const declared = await server(t, (request, response) => { response.writeHead(200, { 'Content-Length': 100 }); response.end('x'.repeat(100)); });
  const streamed = await server(t, (request, response) => { response.write('x'.repeat(40)); response.end('x'.repeat(40)); });
  await assert.rejects((await desktopFetch(declared.url, { maxBufferedBytes: 64 })).text(), error => error.code === 'BODY_TOO_LARGE');
  await assert.rejects((await desktopFetch(streamed.url, { maxBufferedBytes: 64 })).text(), error => error.code === 'BODY_TOO_LARGE');
});

test('concurrent requests have independent signals and timeout cleanup', async t => {
  const endpoint = await server(t, (request, response) => {
    if (request.url === '/slow') { response.writeHead(200); response.write('waiting'); }
    else response.end('successful');
  });
  const controller = new AbortController();
  const [slow, fast] = await Promise.all([desktopFetch(`${endpoint.url}/slow`, { signal: controller.signal }), desktopFetch(`${endpoint.url}/fast`)]);
  const waiting = slow.text(); controller.abort(new Error('cancel slow only'));
  await assert.rejects(waiting, /cancel slow only/); assert.equal(await fast.text(), 'successful');
});

test('URL allowlist rejects credential-bearing, remote HTTP, untrusted and non-default HTTPS endpoints before connecting', async () => {
  const values = [
    'https://example.test/api', 'http://api.openai.com/v1/models', 'https://api.openai.com.evil.test/v1/models',
    'https://api.openai.com:8443/v1/models', 'http://192.168.0.1:11434/api/tags', 'https://localhost:11434/api/tags',
    'http://user:password@127.0.0.1:11434/api/tags', 'http://127.0.0.1:11434/api/tags#fragment', 'file:///C:/private.txt',
  ];
  for (const url of values) await assert.rejects(desktopFetch(url), error => error.code === 'URL_NOT_ALLOWED', url);
});

test('pre-aborted official requests never reach a network service', async () => {
  const controller = new AbortController(); const reason = new Error('already cancelled'); controller.abort(reason);
  for (const host of ['auth.openai.com', 'api.openai.com', 'api.anthropic.com', 'api.typesafe.ai']) {
    await assert.rejects(desktopFetch(`https://${host}/fixture`, { signal: controller.signal }), error => error === reason);
  }
});

test('cookie and proxy-auth headers are refused and follow redirects cannot be enabled', async () => {
  for (const header of ['Cookie', 'Cookie2', 'Proxy-Authorization']) {
    await assert.rejects(desktopFetch('http://127.0.0.1:1', { headers: { [header]: 'synthetic' } }), error => error.code === 'HEADER_NOT_ALLOWED');
  }
  await assert.rejects(desktopFetch('http://127.0.0.1:1', { redirect: 'follow' }), error => error.code === 'REDIRECT_REFUSED');
});

test('URLSearchParams body is encoded with a computed length and appropriate content type', async t => {
  const endpoint = await server(t, async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk.toString('utf8');
    assert.equal(request.headers['content-type'], 'application/x-www-form-urlencoded;charset=UTF-8');
    assert.equal(request.headers['content-length'], String(Buffer.byteLength(body)));
    assert.equal(new URLSearchParams(body).get('query'), '한글'); response.end('ok');
  });
  assert.equal(await (await desktopFetch(endpoint.url, { method: 'POST', body: new URLSearchParams({ query: '한글' }) })).text(), 'ok');
});
