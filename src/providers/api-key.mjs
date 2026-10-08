import {utf8ByteLength} from '../portable-crypto.mjs';
import { normalizeReasoningEffort, validateReasoningEffort } from '../model-options.mjs';
function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function abortError() { const error = failure('CANCELLED', 'Request cancelled.'); error.name = 'AbortError'; return error; }
const ENDPOINTS = Object.freeze({ openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com/v1', ollama: 'http://127.0.0.1:11434' });
const MAX_STREAM = 16 * 1024 * 1024;
const MAX_INSTRUCTIONS = 16 * 1024;

function instructionText(value) {
  if(value===undefined)return '';
  if(typeof value!=='string'||utf8ByteLength(value)>MAX_INSTRUCTIONS)throw failure('INVALID_INSTRUCTIONS','Response instructions must be text no larger than 16 KiB.');
  return value;
}
function finalOpenAiText(response) {
  if(!Object.hasOwn(response ?? {},'output'))return null;
  if(!Array.isArray(response.output))throw failure('INVALID_RESPONSE','The completed response contains invalid output.');
  const messages=response.output.filter(item=>item?.type==='message'&&item.role==='assistant');
  const finals=messages.filter(item=>item.phase==='final_answer');
  const selected=finals.length?finals:messages.filter(item=>item.phase!=='commentary');
  if(selected.some(item=>item.status&&item.status!=='completed'))throw failure('INCOMPLETE_RESPONSE','The final answer was not completed.');
  const answer=selected.flatMap(item=>Array.isArray(item.content)?item.content:[]).filter(item=>item?.type==='output_text'&&typeof item.text==='string').map(item=>item.text).join('\n\n');
  if(!answer.trim())throw failure('EMPTY_RESPONSE','The completed response contains no final answer text.');
  if(utf8ByteLength(answer)>MAX_STREAM)throw failure('OUTPUT_TOO_LARGE','The response exceeds the size limit.');
  return answer;
}

function normalizeInput(input) {
  if (typeof input === 'string') return { prompt: input, system: '' };
  if (!input || typeof input.prompt !== 'string') throw failure('INVALID_INPUT', 'Enter a question.');
  const context = typeof input.context === 'string' ? input.context : Array.isArray(input.context) ? input.context.map(item => typeof item === 'string' ? item : JSON.stringify(item)).join('\n\n') : '';
  return { prompt: context ? `Retrieved note evidence:\n${context}\n\nUser question:\n${input.prompt}` : input.prompt, system: instructionText(input.system) };
}

async function consumeLines(body, { signal, delimiter = '\n', onLine }) {
  if (!body?.getReader) throw failure('INVALID_STREAM', 'The provider did not return a response stream.');
  const reader = body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let total = 0;
  const abort = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw abortError();
      const { value, done } = await reader.read();
      if (signal?.aborted) throw abortError();
      if (done) break;
      total += value.byteLength; if (total > MAX_STREAM) throw failure('OUTPUT_TOO_LARGE', 'The response exceeds the size limit.');
      buffer += decoder.decode(value, { stream: true }); buffer = buffer.replace(/\r\n/g, '\n');
      let index;
      while ((index = buffer.indexOf(delimiter)) !== -1) { const line = buffer.slice(0, index); buffer = buffer.slice(index + delimiter.length); await onLine(line); }
    }
    buffer += decoder.decode(); if (buffer.trim()) await onLine(buffer);
  } finally { signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export class ApiKeyProvider {
  constructor({ provider, secrets, fetchImpl = globalThis.fetch, baseUrl, streamResponses=true } = {}) {
    if (!Object.hasOwn(ENDPOINTS, provider)) throw failure('INVALID_PROVIDER', 'This provider is not supported.');
    this.provider = provider; this.secrets = secrets; this.fetch = fetchImpl; this.models = []; this.connected = false;this.streamResponses=streamResponses!==false;
    this.baseUrl = ENDPOINTS[provider];
    if (baseUrl && provider !== 'ollama') throw failure('FIXED_PROVIDER_ENDPOINT', 'API keys can only be sent to the official provider endpoint.');
    if (baseUrl) {
      let url; try { url = new URL(baseUrl); } catch { throw failure('INVALID_LOCAL_ENDPOINT', 'Enter a local Ollama address.'); }
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.protocol !== 'http:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw failure('INVALID_LOCAL_ENDPOINT', 'Ollama only connects to an HTTP loopback address on this computer.');
      this.baseUrl = url.origin;
    }
  }

  async _headers() {
    if (this.provider === 'ollama') return { 'content-type': 'application/json' };
    const name = `api-${this.provider}`;
    const key = typeof this.secrets === 'function' ? await this.secrets(name) : await this.secrets?.get?.(name);
    if (typeof key !== 'string' || !key.trim() || /[\r\n]/.test(key)) throw failure('API_KEY_REQUIRED', 'Enter your own API key.');
    return this.provider === 'openai' ? { authorization: `Bearer ${key}`, 'content-type': 'application/json' } : { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
  }

  async _request(endpoint, { method = 'GET', body, signal } = {}) {
    if (signal?.aborted) throw abortError();
    try {
      const response = await this.fetch(`${this.baseUrl}${endpoint}`, { method, headers: await this._headers(), body: body ? JSON.stringify(body) : undefined, signal, redirect: 'error' });
      if(signal?.aborted)throw abortError();
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {});
        const category = response.status === 401 || response.status === 403 ? 'AUTH_FAILED' : response.status === 429 ? 'RATE_LIMITED' : 'PROVIDER_HTTP_ERROR';
        throw failure(category, `The provider request failed (HTTP ${response.status}). Check your key, usage limits, and selected model.`);
      }
      return response;
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError') throw abortError();
      if(error.name==='TimeoutError')throw error;
      if (['API_KEY_REQUIRED', 'AUTH_FAILED', 'RATE_LIMITED', 'PROVIDER_HTTP_ERROR'].includes(error.code)) throw error;
      throw failure('PROVIDER_NETWORK_ERROR', 'Could not connect to the provider. Check your network and the official service status.');
    }
  }

  async connect({ signal } = {}) { this.connected = false; const models = await this.listModels({ signal }); this.connected = true; return { ...await this.status(), models }; }
  async status() { return { provider: this.provider, mode: this.provider === 'ollama' ? 'local' : 'api-key', connected: this.connected, modelCount: this.models.length }; }
  async disconnect() { this.connected = false; this.models = []; return this.status(); }

  async listModels({ signal } = {}) {
    this.models = [];
    let models = []; let cursor = null;
    for (let page = 0; page < 20; page++) {
      const endpoint = this.provider === 'ollama' ? '/api/tags' : `/models${this.provider === 'anthropic' ? `?limit=100${cursor ? `&after_id=${encodeURIComponent(cursor)}` : ''}` : ''}`;
      const response = await this._request(endpoint, { signal }); let data;
      try { data = await response.json(); } catch { throw failure('INVALID_CATALOG', 'Could not read the provider model catalog.'); }
      const entries = this.provider === 'ollama' ? data?.models : data?.data;
      if (!Array.isArray(entries)) throw failure('INVALID_CATALOG', 'The provider model catalog format is invalid.');
      for (const item of entries) {
        if (!item || typeof item !== 'object') continue;
        const id = this.provider === 'ollama' ? item.model || item.name : item.id;
        if (typeof id !== 'string' || !id.trim()) continue;
        models.push({ id, name: typeof item.display_name === 'string' ? item.display_name : typeof item.name === 'string' ? item.name : id,
          source: this.provider === 'ollama' ? 'local-installed' : 'live-api-catalog', availability: this.provider === 'ollama' ? 'installed' : 'listed', verified: false,
          capabilities: item.capabilities || null,
          ...(Array.isArray(item.supported_reasoning_efforts) ? { supportedReasoningEfforts: item.supported_reasoning_efforts } : {}),
          ...(Number.isFinite(item.max_input_tokens) ? { maxInputTokens: item.max_input_tokens } : {}),
          ...(Number.isFinite(item.max_tokens) ? { maxOutputTokens: item.max_tokens } : {}),
          ...(typeof item.created_at === 'string' || Number.isFinite(item.created) ? { releasedAt: item.created_at || item.created } : {}) });
      }
      if (this.provider !== 'anthropic' || !data.has_more) break;
      if (!data.last_id || data.last_id === cursor || page === 19) throw failure('INCOMPLETE_CATALOG', 'Could not fetch the complete model catalog.');
      cursor = data.last_id;
    }
    this.models = [...new Map(models.map(model => [model.id, model])).values()]; return this.models.map(model => ({ ...model }));
  }

  async generate(input, { model, reasoningEffort, instructions, signal, onDelta = () => {} } = {}) {
    if (!this.connected) throw failure('NOT_CONNECTED', 'Connect to the provider first.');
    if (typeof model !== 'string' || !this.models.some(item => item.id === model)) throw failure('MODEL_NOT_VERIFIED', 'Select a model returned by the current connection.');
    let effort = '';
    if (this.provider === 'openai') {
      try { effort = validateReasoningEffort(reasoningEffort); } catch { throw failure('INVALID_REASONING_EFFORT', 'Choose a supported reasoning effort.'); }
      if (effort && !normalizeReasoningEffort(this.models.find(item => item.id === model), effort)) throw failure('INVALID_REASONING_EFFORT', 'The selected model does not list this reasoning effort.');
    }
    const normalized=normalizeInput(input);const prompt=normalized.prompt;
    const system=[instructionText(instructions),normalized.system].filter(Boolean).join('\n\n');
    if(utf8ByteLength(system)>MAX_INSTRUCTIONS)throw failure('INVALID_INSTRUCTIONS','Combined response instructions must be no larger than 16 KiB.');
    if (!prompt.trim() || utf8ByteLength(prompt) > 9 * 1024 * 1024) throw failure('INVALID_INPUT', 'The question and retrieved context must be no larger than 9 MB.');
    let endpoint; let body;
    if (this.provider === 'openai') { endpoint = '/responses'; body = { model, input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }], stream: this.streamResponses, store: false, ...(system ? { instructions: system } : {}), ...(effort ? { reasoning: { effort } } : {}) }; }
    else if (this.provider === 'anthropic') { endpoint = '/messages'; body = { model, messages: [{ role: 'user', content: prompt }], max_tokens: 4096, stream: this.streamResponses, ...(system ? { system } : {}) }; }
    else { endpoint = '/api/chat'; body = { model, messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }], stream: this.streamResponses }; }
    const response = await this._request(endpoint, { method: 'POST', body, signal });
    if(!this.streamResponses) {
      let raw;try{raw=await response.text();}catch{throw failure('INVALID_RESPONSE','Could not read the provider response.');}
      if(signal?.aborted)throw abortError();
      if(utf8ByteLength(raw)>MAX_STREAM)throw failure('OUTPUT_TOO_LARGE','The response exceeds the size limit.');
      let data;try{data=JSON.parse(raw);}catch{throw failure('INVALID_RESPONSE','Could not read the provider response.');}
      if(data.error)throw failure('PROVIDER_REQUEST_FAILED','The provider did not complete the request.');
      let answer;
      if(this.provider==='openai') {
        if(data.status!=='completed'||!Array.isArray(data.output))throw failure('INCOMPLETE_RESPONSE','The provider did not confirm response completion.');
        answer=finalOpenAiText(data);
      } else if(this.provider==='anthropic') {
        if(data.type!=='message'||data.role!=='assistant'||!['end_turn','stop_sequence'].includes(data.stop_reason)||!Array.isArray(data.content))throw failure('INCOMPLETE_RESPONSE','The provider did not confirm a complete answer.');
        answer=data.content.filter(item=>item.type==='text'&&typeof item.text==='string').map(item=>item.text).join('\n');
      } else {if(data.done!==true)throw failure('INCOMPLETE_RESPONSE','The provider did not confirm response completion.');answer=data.message?.content;}
      if(typeof answer!=='string'||!answer.trim())throw failure('EMPTY_RESPONSE','The provider returned no answer text.');
      await onDelta(answer);if(signal?.aborted)throw abortError();return answer;
    }
    let text = ''; let complete = false;let anthropicStopReason;
    const phases=new Map();const itemKeys=event=>[event.item_id,event.item?.id,Number.isInteger(event.output_index)?`index:${event.output_index}`:undefined].filter(value=>value!==undefined);
    await consumeLines(response.body, { signal, delimiter: this.provider === 'ollama' ? '\n' : '\n\n', onLine: async block => {
      if (!block.trim()) return;
      const payload = this.provider === 'ollama' ? block : block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!payload || payload === '[DONE]') return;
      let event; try { event = JSON.parse(payload); } catch { throw failure('INVALID_STREAM', 'Could not read the provider response.'); }
      if (event.error || ['error', 'response.failed', 'response.incomplete'].includes(event.type)) throw failure('PROVIDER_REQUEST_FAILED', 'The provider did not complete the request. Check usage limits and the selected model.');
      let delta;
      if (this.provider === 'openai') {
        if(['response.output_item.added','response.output_item.done'].includes(event.type)&&typeof event.item?.phase==='string')for(const key of itemKeys(event))phases.set(key,event.item.phase);
        if (event.type === 'response.output_text.delta'&&!itemKeys(event).some(key=>phases.get(key)==='commentary')) delta = event.delta;
        if (event.type === 'response.completed') {
          if(event.response?.status&&event.response.status!=='completed')throw failure('INCOMPLETE_RESPONSE','The provider did not confirm response completion.');
          const finalText=finalOpenAiText(event.response);
          if(finalText!==null){if(finalText.startsWith(text)&&finalText.length>text.length)await onDelta(finalText.slice(text.length));text=finalText;}
          complete = true;
        }
      }
      else if (this.provider === 'anthropic') {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') delta = event.delta.text;
        if(event.type==='message_delta'&&event.delta?.stop_reason!=null)anthropicStopReason=event.delta.stop_reason;
        if (event.type === 'message_stop') {if(anthropicStopReason!==undefined&&!['end_turn','stop_sequence'].includes(anthropicStopReason))throw failure('INCOMPLETE_RESPONSE','The provider stopped before completing the answer.');complete = true;}
      }
      else { delta = event.message?.content; if (event.done === true) complete = true; }
      if (typeof delta === 'string' && delta) { text += delta; await onDelta(delta); }
    } });
    if(signal?.aborted)throw abortError();
    if (!complete) throw failure('INCOMPLETE_RESPONSE', 'The connection ended without confirming response completion.');
    if (!text) throw failure('EMPTY_RESPONSE', 'The provider returned no answer text.');
    return text;
  }
}
