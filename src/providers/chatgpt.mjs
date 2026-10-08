import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual, createPublicKey, verify } from 'node:crypto';
import {validateReasoningEffort,reasoningEfforts} from '../model-options.mjs';

const AUTH_ORIGIN = 'https://auth.openai.com';
const AUTHORIZE = `${AUTH_ORIGIN}/api/accounts/authorize`;
const TOKEN = `${AUTH_ORIGIN}/api/accounts/oauth/token`;
const DISCOVERY = `${AUTH_ORIGIN}/.well-known/openid-configuration`;
const JWKS = `${AUTH_ORIGIN}/.well-known/jwks.json`;
const REVOKE = `${AUTH_ORIGIN}/api/accounts/oauth/revoke`;
const RESOURCE = 'https://api.openai.com/v1';
const DIRECT_SCOPE = 'chatgpt.tokens.use.direct';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const SESSION_KEY = 'chatgpt.session';
const refreshLocks = new WeakMap();

export class ChatGPTError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ChatGPTError';
    this.code = code;
    Object.assign(this, details);
  }
}

function failure(code, message, details) { return new ChatGPTError(code, message, details); }
function validateInstructions(value) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 16 * 1024) {
    throw failure('invalid_instructions', 'Response instructions must be text no larger than 16 KiB.');
  }
  return value;
}
function completedAnswer(response) {
  if (!Object.hasOwn(response ?? {}, 'output')) return null;
  if (!Array.isArray(response.output)) throw failure('invalid_completion', 'The completed response contains invalid output.');
  const messages = response.output.filter(item => item?.type === 'message' && item.role === 'assistant');
  const finals = messages.filter(item => item.phase === 'final_answer');
  const selected = finals.length ? finals : messages.filter(item => item.phase !== 'commentary');
  if (selected.some(item => item.status && item.status !== 'completed')) {
    throw failure('invalid_completion', 'The final answer was not completed.');
  }
  const answer = selected.flatMap(item => Array.isArray(item.content) ? item.content : [])
    .filter(item => item?.type === 'output_text' && typeof item.text === 'string').map(item => item.text).join('\n\n');
  if (!answer.trim()) throw failure('empty_response', 'The completed response contains no final answer text.');
  if (Buffer.byteLength(answer, 'utf8') > 4 * 1024 * 1024) throw failure('response_too_large', 'The response exceeds the supported size.');
  return answer;
}
function abortError() { return failure('cancelled', 'Connection or request cancelled.'); }
function assertNotAborted(signal) { if (signal?.aborted) throw abortError(); }
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function scopes(value) { return typeof value === 'string' ? [...new Set(value.split(/\s+/).filter(Boolean))] : []; }
function safeMessage(value) {
  return String(value ?? '').slice(0, 2000)
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted token]');
}
function safeBody(body) {
  if (!body || typeof body !== 'object') return safeMessage(body);
  if (Array.isArray(body)) return body.slice(0, 20).map(safeBody);
  return Object.fromEntries(Object.entries(body).slice(0, 30).map(([key, value]) => [key,
    /token|authorization|code_verifier|client_secret/i.test(key) ? '[redacted]' : safeBody(value)]));
}
function responseError(response, body) {
  const code = typeof body?.error?.code === 'string' ? body.error.code
    : typeof body?.error === 'string' ? body.error : `http_${response.status}`;
  const message = body?.error?.message ?? body?.error_description ?? body?.detail ?? `HTTP ${response.status}`;
  return failure(code, safeMessage(message), { status: response.status,
    requestId: response.headers?.get('x-request-id') || undefined,
    param: typeof body?.error?.param === 'string' ? body.error.param : undefined, body: safeBody(body) });
}
function validateTokenResponse(body, previous) {
  if (!body || typeof body.access_token !== 'string' || !body.access_token ||
      typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer' ||
      !Number.isFinite(body.expires_in) || body.expires_in <= 0 || body.expires_in > 86400) {
    throw failure('invalid_token_response', 'The provider returned an invalid token response.');
  }
  const granted = body.scope === undefined && previous ? previous.scopes : scopes(body.scope);
  const refreshToken = body.refresh_token ?? previous?.refreshToken;
  if (refreshToken !== undefined && (typeof refreshToken !== 'string' || !refreshToken)) {
    throw failure('invalid_token_response', 'The refresh token format is invalid.');
  }
  let earliestRefreshAt = 0;
  if (typeof body.earliest_refresh_at === 'number') {
    earliestRefreshAt = body.earliest_refresh_at < 1e12 ? body.earliest_refresh_at * 1000 : body.earliest_refresh_at;
  } else if (typeof body.earliest_refresh_at === 'string') {
    earliestRefreshAt = Date.parse(body.earliest_refresh_at) || 0;
  }
  return { accessToken: body.access_token, refreshToken, scopes: granted,
    expiresAt: Date.now() + body.expires_in * 1000, earliestRefreshAt };
}
function validateHttpsEndpoint(value, allowed) {
  if (value !== allowed) throw failure('invalid_discovery', 'The official authorization endpoint does not match the expected address.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw failure('invalid_endpoint', 'The authorization address is not secure.');
  return url.href;
}
function decodePart(part) {
  if (typeof part !== 'string' || !/^[A-Za-z0-9_-]+$/.test(part)) throw failure('invalid_id_token', 'The ID token format is invalid.');
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); }
  catch { throw failure('invalid_id_token', 'Could not read the ID token.'); }
}

// Exported for isolated cryptographic tests; the public provider always obtains JWKS from official discovery.
export function verifyIdToken(jwt, keys, { clientId, nonce, subject, now = Date.now() } = {}) {
  if (typeof jwt !== 'string' || jwt.length > 32768) throw failure('invalid_id_token', 'The ID token is missing.');
  const parts = jwt.split('.');
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[2])) throw failure('invalid_id_token', 'The ID token format is invalid.');
  const header = decodePart(parts[0]); const claims = decodePart(parts[1]);
  if (!header || typeof header !== 'object' || Array.isArray(header) || !claims || typeof claims !== 'object' || Array.isArray(claims)) {
    throw failure('invalid_id_token', 'The ID token format is invalid.');
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid || header.crit) {
    throw failure('invalid_id_token', 'The ID token signature type is not supported.');
  }
  const candidates = (Array.isArray(keys) ? keys : []).filter(key => key.kid === header.kid && key.kty === 'RSA'
    && (!key.use || key.use === 'sig') && (!key.alg || key.alg === 'RS256'));
  if (candidates.length !== 1) throw failure('unknown_signing_key', 'Could not verify the official signing key.');
  let valid = false;
  try {
    const key = createPublicKey({ key: candidates[0], format: 'jwk' });
    if (key.asymmetricKeyDetails?.modulusLength < 2048) throw new Error('weak key');
    valid = verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
  } catch { valid = false; }
  if (!valid) throw failure('invalid_id_token_signature', 'The ID token signature is invalid.');
  const seconds = Math.floor(now / 1000);
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== AUTH_ORIGIN || !audience.includes(clientId) ||
      (audience.length > 1 && claims.azp !== clientId) ||
      (claims.azp !== undefined && claims.azp !== clientId) ||
      !Number.isFinite(claims.exp) || claims.exp <= seconds ||
      (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > seconds + 60)) ||
      (claims.iat !== undefined && (!Number.isFinite(claims.iat) || claims.iat > seconds + 60)) ||
      typeof claims.sub !== 'string' || !claims.sub ||
      (nonce !== undefined && !same(claims.nonce, nonce)) ||
      (subject !== undefined && !same(claims.sub, subject))) {
    throw failure('invalid_id_token_claims', 'The ID token account, audience, expiration, or nonce is invalid.');
  }
  return { subject: claims.sub, email: typeof claims.email === 'string' ? claims.email : undefined,
    name: typeof claims.name === 'string' ? claims.name : undefined };
}

export class ChatGPTSubscription {
  constructor({ secrets, config = {}, onConfig = async () => {}, openExternal, fetchImpl = globalThis.fetch }) {
    if (!secrets?.get || !secrets?.set || !secrets?.delete || typeof fetchImpl !== 'function') {
      throw new TypeError('A secret store and fetch implementation are required.');
    }
    this.secrets = secrets; this.config = { ...config }; this.onConfig = onConfig;
    this.openExternal = openExternal; this.fetch = fetchImpl;
    this.controllers = new Set(); this.connection = null; this.sessionGeneration = 0;
    this.connectionDone = null; this.disconnecting = false;
    this.pendingWrites = new Set();
  }

  async _config(partial) {
    await this.onConfig(partial);
    Object.assign(this.config, partial);
  }
  async _saveSession(value) {
    const pending = Promise.resolve(this.secrets.set(SESSION_KEY, value));
    this.pendingWrites.add(pending);
    try { await pending; } finally { this.pendingWrites.delete(pending); }
  }
  async _session() {
    const raw = await this.secrets.get(SESSION_KEY);
    if (!raw) return null;
    try {
      const record = JSON.parse(raw);
      if (typeof record.clientId !== 'string' || !record.clientId || record.clientId === 'dynamic_agent_client' ||
          typeof record.subject !== 'string' || !record.subject || typeof record.accessToken !== 'string' ||
          !Array.isArray(record.scopes) || !Number.isFinite(record.expiresAt)) return null;
      if (this.config.clientId && (record.clientId !== this.config.clientId ||
          (this.config.accountSub && record.subject !== this.config.accountSub))) return null;
      return record;
    } catch { return null; }
  }
  async status() {
    const session = await this._session();
    const permissionGranted = Boolean(session?.scopes.includes(DIRECT_SCOPE));
    const renewable = Boolean(session && (session.expiresAt > Date.now() || session.refreshToken));
    return { connected: permissionGranted && renewable, signedIn: Boolean(session), permissionGranted,
      account: session ? { email: session.email, subject: session.subject, clientId: session.clientId } : undefined,
      scope: session ? [...session.scopes] : [], reason: !session ? 'not_connected'
        : !permissionGranted ? 'plan_permission_not_granted' : !renewable ? 'reauthorization_required' : undefined };
  }
  _requestScope(signal, timeoutMs = 30000) {
    if(this.disposed)throw failure('disposed','This ChatGPT connection was closed. Reopen the plugin to continue.');
    assertNotAborted(signal);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600000) {
      throw failure('invalid_timeout', 'The request timeout setting is invalid.');
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort(abortError());
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(failure('timeout', 'The request timed out.')), timeoutMs);
    this.controllers.add(controller);
    return { controller, signal: controller.signal, cleanup: () => {
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort); this.controllers.delete(controller);
    } };
  }
  async _fetch(url, init, signal) {
    if (![DISCOVERY, JWKS, TOKEN, REVOKE, `${RESOURCE}/models`, `${RESOURCE}/responses`].includes(url)) {
      throw failure('invalid_endpoint', 'This provider address is not allowed.');
    }
    assertNotAborted(signal);
    try { return await this.fetch(url, { ...init, redirect: 'error', signal }); }
    catch {
      if (signal?.aborted) throw signal.reason instanceof ChatGPTError ? signal.reason : abortError();
      throw failure('network_error', 'Could not connect to the provider. Check your connection.');
    }
  }
  async _json(url, init, signal) {
    const response = await this._fetch(url, init, signal);
    let body;
    try { const raw = await response.text();
      if (raw.length > 1024 * 1024) throw new Error('large response');
      body = raw ? JSON.parse(raw) : null;
    } catch {
      if (signal?.aborted) throw signal.reason instanceof ChatGPTError ? signal.reason : abortError();
      throw failure('invalid_response', 'Could not read the provider response.', { status: response.status });
    }
    if (!response.ok) throw responseError(response, body);
    return body;
  }
  async _identity(idToken, options, signal) {
    const discovery = await this._json(DISCOVERY, {}, signal);
    if (discovery?.issuer !== AUTH_ORIGIN) throw failure('invalid_discovery', 'Could not verify the official authorization issuer.');
    validateHttpsEndpoint(discovery.jwks_uri, JWKS);
    const keySet = await this._json(JWKS, {}, signal);
    return verifyIdToken(idToken, keySet?.keys, options);
  }

  async connect({ signal, onStatus = () => {}, timeoutMs = 180000, newAccount = false, reuseSession = false } = {}) {
    if (this.disconnecting) throw failure('disconnect_in_progress', 'Finish disconnecting before signing in again.');
    if (this.connection) throw failure('connection_in_progress', 'Sign-in is already in progress.');
    if(reuseSession&&!newAccount){
      const scope=this._requestScope(signal,timeoutMs);
      try{await this._access(scope.signal);assertNotAborted(scope.signal);onStatus('Using the existing authorized ChatGPT login.');return await this.status();}
      finally{scope.cleanup();}
    }
    if (typeof this.openExternal !== 'function') throw failure('browser_unavailable', 'Could not open the official sign-in page.');
    const scope = this._requestScope(signal, timeoutMs);
    this.connection = scope.controller;
    let finishConnection;
    this.connectionDone = new Promise(resolve => { finishConnection = resolve; });
    let server;
    try {
      if (!/^urn:uuid:[0-9a-f-]{36}$/i.test(this.config.hostId ?? '')) {
        await this._config({ hostId: `urn:uuid:${randomUUID()}` });
      }
      const selected = newAccount ? null : await this._session();
      const pendingClientId = newAccount ? null : selected?.clientId ?? this.config.clientId;
      const selectedSubject = newAccount ? null : selected?.subject ?? this.config.accountSub;
      const isNew = !pendingClientId || pendingClientId === 'dynamic_agent_client';
      const state = randomBytes(32).toString('base64url');
      const nonce = randomBytes(32).toString('base64url');
      const verifier = randomBytes(48).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      let settle;
      const callback = new Promise((resolve, reject) => { settle = { resolve, reject }; });
      // Attach a handler immediately so an abort during browser launch cannot become unhandled.
      callback.catch(() => {});
      let handled = false;
      let callbackUri;
      server = createServer((request, response) => {
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
        response.setHeader('Referrer-Policy', 'no-referrer');
        const answer = (status, message) => { response.writeHead(status); response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Notework connection</title><body><p>${message}</p><p>Return to Obsidian.</p></body></html>`); };
        if (handled) return answer(409, 'This sign-in request has already been processed.');
        if (request.method !== 'GET' || !request.url || request.url.length > 16384 ||
            request.headers.host !== new URL(callbackUri).host) return answer(400, 'Invalid request.');
        let url;
        try { url = new URL(request.url, callbackUri); } catch { return answer(400, 'Invalid request.'); }
        if (url.pathname !== '/auth/callback') return answer(404, 'This is not the sign-in callback path.');
        handled = true;
        for (const key of ['state', 'code', 'client_id', 'error']) {
          if (url.searchParams.getAll(key).length > 1) {
            answer(400, 'The sign-in callback contains duplicate values.');
            return settle.reject(failure('invalid_callback', 'The sign-in callback contains duplicate values.'));
          }
        }
        if (!same(url.searchParams.get('state'), state)) {
          answer(400, 'The sign-in verification value does not match.');
          return settle.reject(failure('state_mismatch', 'The sign-in verification value does not match. Connect again.'));
        }
        const error = url.searchParams.get('error');
        if (error) {
          answer(400, 'Sign-in did not complete.');
          return settle.reject(failure(error === 'access_denied' ? 'access_denied' : 'oauth_error', 'Sign-in did not complete.'));
        }
        const code = url.searchParams.get('code');
        const issued = url.searchParams.get('client_id');
        if (!code || (isNew && (!issued || issued === 'dynamic_agent_client')) ||
            (!isNew && issued && issued !== pendingClientId)) {
          answer(400, 'Could not verify the sign-in registration.');
          return settle.reject(failure('invalid_callback', 'Could not verify the sign-in registration.'));
        }
        answer(200, 'The official sign-in response was received. Notework is checking the connection.');
        settle.resolve({ code, clientId: isNew ? issued : pendingClientId });
      });
      server.requestTimeout = 10000; server.headersTimeout = 10000;
      const onAbort = () => settle.reject(scope.signal.reason instanceof ChatGPTError ? scope.signal.reason : abortError());
      scope.signal.addEventListener('abort', onAbort, { once: true });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
      });
      server.on('error', error => settle.reject(failure('callback_server_error', 'Could not prepare the sign-in callback.')));
      callbackUri = `http://127.0.0.1:${server.address().port}/auth/callback`;
      const url = new URL(AUTHORIZE);
      const params = { client_id: isNew ? 'dynamic_agent_client' : pendingClientId,
        ext_agent_host_id: this.config.hostId, response_type: 'code', redirect_uri: callbackUri,
        scope: SCOPES, resource: RESOURCE, state, nonce, code_challenge_method: 'S256', code_challenge: challenge };
      if (isNew) params.agent_name_hint = 'Notework';
      if (!isNew && selected?.idToken) params.id_token_hint = selected.idToken;
      if (!isNew && (selected?.email || this.config.email)) params.login_hint = selected?.email || this.config.email;
      Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
      assertNotAborted(scope.signal); onStatus('Allow the connection on the official ChatGPT sign-in page.');
      await this.openExternal(url.href);
      const result = await callback;
      onStatus('Checking the signed-in account and ChatGPT plan permission.');
      const body = await this._json(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: result.clientId,
          code: result.code, code_verifier: verifier, redirect_uri: callbackUri, resource: RESOURCE }).toString() }, scope.signal);
      const identity = await this._identity(body?.id_token, { clientId: result.clientId, nonce,
        subject: !isNew && selectedSubject ? selectedSubject : undefined }, scope.signal);
      const tokenFields = validateTokenResponse(body);
      const session = { ...tokenFields, clientId: result.clientId, subject: identity.subject,
        email: identity.email, idToken: body.id_token, savedAt: new Date().toISOString() };
      assertNotAborted(scope.signal);
      const oldRaw = await this.secrets.get(SESSION_KEY);
      const oldConfig = { clientId: this.config.clientId, accountSub: this.config.accountSub, email: this.config.email };
      await this._saveSession(JSON.stringify(session));
      try { await this._config({ clientId: session.clientId, accountSub: session.subject, email: session.email }); }
      catch (error) {
        if (oldRaw) await this._saveSession(oldRaw); else await this.secrets.delete(SESSION_KEY);
        Object.assign(this.config, oldConfig); throw error;
      }
      this.sessionGeneration++;
      return this.status();
    } finally {
      if (server) { server.closeAllConnections?.(); await new Promise(resolve => server.close(() => resolve())); }
      this.connection = null; scope.cleanup();
      finishConnection(); this.connectionDone = null;
    }
  }

  async _access(signal) {
    if (this.disconnecting) throw failure('disconnect_in_progress', 'Disconnecting ChatGPT.');
    let session = await this._session();
    if (!session) throw failure('not_connected', 'Connect with ChatGPT first.');
    if (!session.scopes.includes(DIRECT_SCOPE)) throw failure('plan_permission_not_granted', 'ChatGPT plan usage is not authorized. Allow it in connection settings.');
    const nearExpiry = session.expiresAt <= Date.now() + 60000;
    if (!nearExpiry) return session.accessToken;
    if (session.earliestRefreshAt > Date.now() && session.expiresAt > Date.now()) return session.accessToken;
    if (session.earliestRefreshAt > Date.now()) throw failure('refresh_not_yet_allowed', 'The provider does not allow token renewal yet. Try again later.');
    if (!session.refreshToken) throw failure('reauthorization_required', 'The ChatGPT connection expired. Sign in again.');
    let locks = refreshLocks.get(this.secrets);
    if (!locks) { locks = new Map(); refreshLocks.set(this.secrets, locks); }
    const key = `${session.clientId}:${session.subject}`;
    if (!locks.has(key)) {
      const generation = this.sessionGeneration;
      const refresh = this._refresh(session, signal, generation);
      locks.set(key, refresh);
      refresh.finally(() => { if (locks.get(key) === refresh) locks.delete(key); }).catch(() => {});
    }
    await locks.get(key);
    assertNotAborted(signal);
    session = await this._session();
    if (!session?.scopes.includes(DIRECT_SCOPE)) throw failure('plan_permission_not_granted', 'ChatGPT plan usage is not authorized.');
    return session.accessToken;
  }
  async _refresh(previous, signal, generation) {
    const body = await this._json(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: previous.clientId,
        refresh_token: previous.refreshToken, resource: RESOURCE }).toString() }, signal);
    const fields = validateTokenResponse(body, previous);
    let identity;
    if (body.id_token) identity = await this._identity(body.id_token, {
      clientId: previous.clientId, subject: previous.subject }, signal);
    assertNotAborted(signal);
    if (generation !== this.sessionGeneration) throw failure('session_changed', 'The active ChatGPT account changed.');
    const current = await this._session();
    if (!current || current.refreshToken !== previous.refreshToken) throw failure('session_changed', 'The ChatGPT connection changed.');
    assertNotAborted(signal);
    if (generation !== this.sessionGeneration || this.disconnecting) throw failure('session_changed', 'The active ChatGPT connection changed.');
    await this._saveSession(JSON.stringify({ ...previous, ...fields,
      idToken: body.id_token || previous.idToken, email: identity?.email ?? previous.email,
      savedAt: new Date().toISOString() }));
  }

  async listModels({ signal } = {}) {
    const scope = this._requestScope(signal);
    try {
      const access = await this._access(scope.signal);
      const body = await this._json(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${access}` } }, scope.signal);
      const subscription=Array.isArray(body?.models),rows=subscription?body.models:body?.data;
      if (!Array.isArray(rows)) throw failure('invalid_model_catalog', 'Could not read the model catalog for this account.');
      const seen=new Set();return rows.filter(row=>subscription?row?.visibility==='list':row?.visibility==null||row.visibility==='list').flatMap(row=>{
        const id=subscription?row.slug:row.id;if(typeof id!=='string'||!id.trim()||id.length>256||seen.has(id))return [];seen.add(id);
        const item={id,name:typeof row.display_name==='string'?row.display_name:id,source:'chatgpt-subscription'};
        const efforts=row.supported_reasoning_efforts ?? row.supportedReasoningEfforts;
        if(Array.isArray(efforts))item.supportedReasoningEfforts=reasoningEfforts({supportedReasoningEfforts:efforts});
        return [item];
      });
    } finally { scope.cleanup(); }
  }

  async generate(input, { model, signal, reasoningEffort, instructions, onDelta = () => {}, timeoutMs = 180000 } = {}) {
    if (typeof model !== 'string' || !model.trim()) throw failure('model_required', 'Select a ChatGPT model.');
    if (typeof input !== 'string' && !Array.isArray(input)) throw new TypeError('input must be a string or a Responses input array.');
    const effort=validateReasoningEffort(reasoningEffort);
    const responseInstructions=validateInstructions(instructions);
    const known=reasoningEfforts({id:model});if(effort&&known.length&&!known.includes(effort))throw failure('unsupported_reasoning_effort','Choose a reasoning effort supported by this model.');
    const scope = this._requestScope(signal, timeoutMs);
    let reader;
    try {
      const access = await this._access(scope.signal);
      const response = await this._fetch(`${RESOURCE}/responses`, { method: 'POST',
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ model, input: typeof input === 'string' ? [{ role: 'user', content: input }] : input,
          store: false, stream: true,...(effort?{reasoning:{effort}}:{}),
          ...(responseInstructions ? { instructions: responseInstructions } : {}) }) }, scope.signal);
      if (!response.ok) {
        let body; try { body = await response.json(); } catch { body = null; }
        throw responseError(response, body);
      }
      if (!response.body || !/^text\/event-stream\b/i.test(response.headers.get('content-type') ?? '')) {
        throw failure('invalid_stream', 'No streaming response was received.');
      }
      reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let buffer = ''; let text = ''; let completed = false; let dataLines = [];
      const phases = new Map();
      const itemKeys = event => [event.item_id, event.item?.id,
        Number.isInteger(event.output_index) ? `index:${event.output_index}` : undefined].filter(value => value !== undefined);
      const handle = async () => {
        if (!dataLines.length) return;
        const raw = dataLines.join('\n'); dataLines = [];
        if (raw === '[DONE]') return;
        let event; try { event = JSON.parse(raw); } catch { throw failure('invalid_stream_event', 'Could not read a streaming event.'); }
        if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
          if (typeof event.item?.phase === 'string') for (const key of itemKeys(event)) phases.set(key, event.item.phase);
        } else if (event.type === 'response.output_text.delta') {
          if (typeof event.delta !== 'string') throw failure('invalid_stream_event', 'The text response format is invalid.');
          if (itemKeys(event).some(key => phases.get(key) === 'commentary')) return;
          text += event.delta;
          if (text.length > 4 * 1024 * 1024) throw failure('response_too_large', 'The response exceeds the supported size.');
          await onDelta(event.delta);
        } else if (event.type === 'response.failed' || event.type === 'error') {
          const error = event.response?.error ?? event.error ?? event;
          throw failure(typeof error.code === 'string' ? error.code : 'response_failed',
            safeMessage(error.message ?? 'The ChatGPT request did not complete.'),
            { status: response.status, requestId: response.headers.get('x-request-id') || undefined,
              param: typeof error.param === 'string' ? error.param : undefined });
        } else if (event.type === 'response.incomplete') {
          throw failure('response_incomplete', 'The ChatGPT response is incomplete.',
            { reason: safeMessage(event.response?.incomplete_details?.reason ?? 'unknown') });
        } else if (event.type === 'response.completed') {
          if (event.response?.status && event.response.status !== 'completed') {
            throw failure('invalid_completion', 'The response completion status is invalid.');
          }
          const finalText = completedAnswer(event.response);
          if (finalText !== null) {
            // A delta stream can omit final items or contain earlier commentary.
            // Return the authoritative completed output; append only a safe missing suffix.
            if (finalText.startsWith(text) && finalText.length > text.length) await onDelta(finalText.slice(text.length));
            text = finalText;
          }
          completed = true;
        }
      };
      const consume = async (ending = false) => {
        let index;
        while ((index = buffer.search(/[\r\n]/)) !== -1) {
          // Hold a trailing CR until the next chunk, so a split CRLF is one newline.
          if (!ending && buffer[index] === '\r' && index === buffer.length - 1) break;
          const width = buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1;
          const line = buffer.slice(0, index); buffer = buffer.slice(index + width);
          if (line === '') await handle();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
          if (dataLines.reduce((sum, line) => sum + line.length, 0) > 1024 * 1024) throw failure('event_too_large', 'The response event is too large.');
          if (completed) return;
        }
        if (ending && buffer) {
          if (buffer.startsWith('data:')) dataLines.push(buffer.slice(5).replace(/^ /, ''));
          buffer = '';
        }
        if (ending) await handle();
      };
      while (!completed) {
        assertNotAborted(scope.signal);
        let chunk;
        try { chunk = await reader.read(); }
        catch { if (scope.signal.aborted) throw scope.signal.reason instanceof ChatGPTError ? scope.signal.reason : abortError();
          throw failure('stream_interrupted', 'The ChatGPT response stream was interrupted.'); }
        if (chunk.done) { buffer += decoder.decode(); await consume(true); break; }
        try { buffer += decoder.decode(chunk.value, { stream: true }); }
        catch { throw failure('invalid_stream_encoding', 'The response text encoding is invalid.'); }
        if (buffer.length > 1024 * 1024) throw failure('event_too_large', 'The response event is too large.');
        await consume();
      }
      if (!completed) throw failure('stream_missing_completion', 'The response stream ended without completion.');
      assertNotAborted(scope.signal);
      if (!text.trim()) throw failure('empty_response', 'The completed response contains no final answer text.');
      return text;
    } finally { try { await reader?.cancel(); } catch{/* Cancellation cleanup must not replace a response error. */} scope.cleanup(); }
  }

  dispose() {
    if(this.disposed)return;
    this.disposed=true;this.sessionGeneration++;
    // Unload cancels this instance's work. Stored tokens and remote grants survive.
    for(const controller of this.controllers)controller.abort(abortError());
  }

  async disconnect() {
    if (this.disconnecting) throw failure('disconnect_in_progress', 'Disconnect is already in progress.');
    this.disconnecting = true;
    try {
    this.sessionGeneration++;
    for (const controller of this.controllers) controller.abort(abortError());
    await this.connectionDone;
    await Promise.allSettled([...this.pendingWrites]);
    const session = await this._session();
    let remoteRevoked = !session?.refreshToken;
    if (session?.refreshToken) {
      const scope = this._requestScope(undefined, 10000);
      try {
        const discovery = await this._json(DISCOVERY, {}, scope.signal);
        if (discovery?.issuer !== AUTH_ORIGIN) throw failure('invalid_discovery', 'Could not verify the authorization issuer.');
        const endpoint = validateHttpsEndpoint(discovery.revocation_endpoint, REVOKE);
        const init = { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: session.refreshToken, token_type_hint: 'refresh_token', client_id: session.clientId }).toString() };
        for (let attempt = 0; attempt < 2; attempt++) {
          let response;
          try { response = await this._fetch(endpoint, init, scope.signal); }
          catch (error) { if (attempt || scope.signal.aborted) throw error; }
          remoteRevoked = response?.status === 200;
          if (remoteRevoked || (response && response.status < 500) || attempt) break;
          await new Promise(resolve => setTimeout(resolve, 250));
          assertNotAborted(scope.signal);
        }
      } catch { remoteRevoked = false; } finally { scope.cleanup(); }
    }
    await this.secrets.delete(SESSION_KEY);
    return { remoteRevoked, warning: remoteRevoked ? undefined
      : 'Disconnected on this computer. Remote revocation could not be confirmed; also remove the connection in ChatGPT settings.' };
    } finally { this.disconnecting = false; }
  }
}
