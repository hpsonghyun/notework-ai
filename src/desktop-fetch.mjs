import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';

const HTTPS_HOSTS = new Set(['auth.openai.com', 'api.openai.com', 'api.anthropic.com', 'api.typesafe.ai']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_BUFFER_LIMIT = 4 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class DesktopFetchError extends Error {
  constructor(code, message) {
    super(message); this.name = code === 'ABORTED' ? 'AbortError' : code === 'TIMEOUT' ? 'TimeoutError' : 'DesktopFetchError';
    this.code = code;
  }
}

function error(code, message) { return new DesktopFetchError(code, message); }
function abortReason(signal) { return signal?.reason instanceof Error ? signal.reason : error('ABORTED', 'Request cancelled.'); }
function allowedUrl(input) {
  let url;
  try { url = new URL(input instanceof URL ? input.href : String(input)); }
  catch { throw error('URL_NOT_ALLOWED', 'Invalid request URL.'); }
  if (url.username || url.password || url.hash) throw error('URL_NOT_ALLOWED', 'URLs must not contain credentials or fragments.');
  const official = url.protocol === 'https:' && HTTPS_HOSTS.has(url.hostname) && (!url.port || url.port === '443');
  const local = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if (!official && !local) throw error('URL_NOT_ALLOWED', 'Only official providers and local services on this computer are allowed.');
  return url;
}
function headerEntries(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input;
  if (typeof input.entries === 'function') return [...input.entries()];
  if (typeof input === 'object') return Object.entries(input);
  throw new TypeError('headers must be an object or iterable header collection.');
}
function outgoingHeaders(input, body) {
  const headers = {};
  for (const entry of headerEntries(input)) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new TypeError('Invalid header entry.');
    const [key, value] = entry;
    const name = String(key).toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || /[\r\n]/.test(String(value))) throw new TypeError('Invalid HTTP header.');
    if (['cookie', 'cookie2', 'proxy-authorization'].includes(name)) throw error('HEADER_NOT_ALLOWED', 'Browser cookies and proxy credentials are not forwarded.');
    if (['host', 'connection', 'transfer-encoding', 'content-length'].includes(name)) continue;
    headers[name] = String(value);
  }
  // Node http/https does not transparently decompress renderer-style encodings.
  // All provider calls request an ordinary byte stream for JSON and SSE parsing.
  if (!headers['accept-encoding']) headers['accept-encoding'] = 'identity';
  if (body) headers['content-length'] = String(body.byteLength);
  return headers;
}
function requestBody(body) {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8');
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new TypeError('Only text, URLSearchParams and binary request bodies are supported.');
}

class ResponseHeaders {
  constructor(headers) {
    this.values = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(),
      Array.isArray(value) ? value.join(', ') : String(value ?? '')]));
  }
  get(name) { return this.values.get(String(name).toLowerCase()) ?? null; }
  has(name) { return this.values.has(String(name).toLowerCase()); }
  entries() { return this.values.entries(); }
  [Symbol.iterator]() { return this.entries(); }
}

function responseObject(nodeResponse, url, maxBufferedBytes) {
  // Count bytes instead of chunks: the default chunk-count strategy can over-buffer large streams.
  const body = Readable.toWeb(nodeResponse, {
    strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength },
  });
  let consumed = false;
  async function text() {
    if (consumed || body.locked) throw new TypeError('The response body has already been consumed.');
    consumed = true;
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let bytes = 0; let value = '';
    try {
      const declared = Number(nodeResponse.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBufferedBytes) throw error('BODY_TOO_LARGE', 'The provider response exceeds the supported size.');
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > maxBufferedBytes) throw error('BODY_TOO_LARGE', 'The provider response exceeds the supported size.');
        value += decoder.decode(result.value, { stream: true });
      }
      value += decoder.decode();
      return value;
    } catch (problem) {
      try { await reader.cancel(problem); } catch{/* Cancellation must not replace the original transport error. */}
      throw problem;
    } finally { reader.releaseLock(); }
  }
  return {
    ok: nodeResponse.statusCode >= 200 && nodeResponse.statusCode < 300,
    status: nodeResponse.statusCode, statusText: nodeResponse.statusMessage ?? '',
    url: url.href, redirected: false, headers: new ResponseHeaders(nodeResponse.headers), body,
    get bodyUsed() { return consumed || body.locked; },
    text, async json() { return JSON.parse(await text()); },
  };
}

/** Node transport for Obsidian Desktop, independent of renderer fetch and its CORS rules. */
export async function desktopFetch(input, init = {}) {
  const url = allowedUrl(input);
  if (init.signal?.aborted) throw abortReason(init.signal);
  if (init.redirect !== undefined && init.redirect !== 'error') throw error('REDIRECT_REFUSED', 'Redirects are not allowed.');
  const method = String(init.method ?? 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method)) throw new TypeError('Unsupported request method.');
  const body = requestBody(init.body);
  if ((method === 'GET' || method === 'HEAD') && body) throw new TypeError('GET and HEAD requests cannot include a body.');
  const headers = outgoingHeaders(init.headers, body);
  if (init.body instanceof URLSearchParams && !headers['content-type']) headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBufferedBytes = init.maxBufferedBytes ?? DEFAULT_BUFFER_LIMIT;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600000 ||
      !Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes <= 0 || maxBufferedBytes > 16 * 1024 * 1024) {
    throw new TypeError('Invalid timeout or response buffer limit.');
  }
  return new Promise((resolve, reject) => {
    let request; let response; let headersReceived = false; let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true; clearTimeout(timer); init.signal?.removeEventListener('abort', abort);
    };
    const stop = problem => {
      // Headers may already have resolved the promise; destroying the response also rejects body reads.
      response?.destroy(problem); request?.destroy(problem);
      cleanup();
      if (!headersReceived) reject(problem);
    };
    const abort = () => stop(abortReason(init.signal));
    const timer = setTimeout(() => stop(error('TIMEOUT', 'The provider request timed out.')), timeoutMs);
    init.signal?.addEventListener('abort', abort, { once: true });
    try {
      const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
      request = transport(url, {
        method, headers,
        // Do not weaken certificate or hostname verification. No proxy or cookie state is inherited.
        ...(url.protocol === 'https:' ? { rejectUnauthorized: true } : {}),
      }, incoming => {
        response = incoming;
        incoming.once('end', cleanup);
        incoming.once('close', cleanup);
        incoming.once('error', problem => { cleanup(); if (!headersReceived) reject(problem); });
        if (REDIRECT_STATUSES.has(incoming.statusCode)) {
          const problem = error('REDIRECT_REFUSED', 'The provider redirect was refused. Credentials were not forwarded to another address.');
          incoming.destroy(); request.destroy(); cleanup(); reject(problem); return;
        }
        try {
          const result = responseObject(incoming, url, maxBufferedBytes);
          headersReceived = true; resolve(result);
        } catch (problem) { stop(problem); }
      });
      request.once('error', problem => {
        cleanup();
        if (response && !response.destroyed) response.destroy(problem);
        if (!headersReceived) reject(problem);
      });
      if (init.signal?.aborted) { abort(); return; }
      if (body) request.end(body); else request.end();
    } catch (problem) { stop(problem); }
  });
}
