import {stripAnsiCsi} from '../text-safety.mjs';
import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeClaudeLoginUrl } from './claude-login-url.mjs';
export { safeClaudeLoginUrl } from './claude-login-url.mjs';

const DEFAULT_MODEL = Object.freeze({ id: 'default', name: 'Model selected in Claude Code', source: 'host-managed' });
const MAX_OUTPUT = 16 * 1024 * 1024;
function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function cancelled() { const error = failure('CANCELLED', 'Request cancelled.'); error.name = 'AbortError'; return error; }
async function exists(file) { try { await access(file); return true; } catch { return false; } }

/** Do not read authentication files. Let the unmodified official CLI resolve its own login. */
export function subscriptionEnvironment(source = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_API_|OPENAI_|AWS_|GOOGLE_APPLICATION_CREDENTIALS$|AZURE_|VERTEX_|BEDROCK_)/i.test(key)) continue;
    if (/^(CLAUDE_CODE_SAFE_MODE|CLAUDE_CODE_SIMPLE|CLAUDE_CODE_SKIP_PROMPT_HISTORY)$/i.test(key)) continue;
    env[key] = value;
  }
  env.CLAUDE_CODE_SKIP_PROMPT_HISTORY = '1';
  return env;
}

async function officialNpmCommand(base, config, env, platform) {
  const packageDir = path.join(base, 'node_modules', '@anthropic-ai', 'claude-code');
  let pkg;
  try { pkg = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8')); }
  catch { return null; }
  if (pkg.name !== '@anthropic-ai/claude-code') return null;
  // New official npm packages contain a native executable; earlier ones use cli.js.
  const declaredBin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.claude;
  const entries = [...new Set([declaredBin, platform === 'win32' ? 'bin/claude.exe' : 'bin/claude', 'cli.js'].filter(value => typeof value === 'string' && value))];
  for (const entry of entries) {
    if (path.isAbsolute(entry) || entry.split(/[\\/]/).some(part => part === '..')) continue;
    const file = path.resolve(packageDir, entry);
    if (!file.startsWith(packageDir + path.sep) || !await exists(file)) continue;
    if (/^(claude|claude\.exe)$/i.test(path.basename(file))) return { command: file, prefix: [] };
    if (path.basename(file) === 'cli.js') return { command: await resolveNode(config.nodePath, env, platform), prefix: [file] };
  }
  return null;
}

function standardLocations(env, platform) {
  const home = env.USERPROFILE || env.HOME;
  const pathDirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const directories = [...pathDirs]; const npmBases = [];
  if (home) directories.push(path.join(home, '.local', 'bin'));
  if (platform === 'win32') {
    const appData = env.APPDATA || (home ? path.join(home, 'AppData', 'Roaming') : null);
    if (appData) npmBases.push(path.join(appData, 'npm'));
    if (env.LOCALAPPDATA) npmBases.push(path.join(env.LOCALAPPDATA, 'npm'));
  } else {
    directories.push('/usr/local/bin', '/opt/homebrew/bin', '/usr/bin');
    npmBases.push('/usr/local/lib', '/opt/homebrew/lib');
    if (home) npmBases.push(path.join(home, '.npm-global'), path.join(home, '.npm-global', 'lib'));
  }
  if (env.npm_config_prefix && path.isAbsolute(env.npm_config_prefix)) npmBases.push(env.npm_config_prefix);
  npmBases.push(...pathDirs);
  return { directories: [...new Set(directories)], npmBases: [...new Set(npmBases)] };
}

/** Windows .cmd/.ps1 files are never shell-executed; resolve the verified official package bin instead. */
export async function resolveClaudeCommand(config = {}, env = process.env, platform = process.platform) {
  if (config.cliJsPath) {
    if (!path.isAbsolute(config.cliJsPath) || path.basename(config.cliJsPath) !== 'cli.js') throw failure('INVALID_CLI_PATH', 'Specify the absolute path to the official Claude Code cli.js.');
    try {
      const pkg = JSON.parse(await readFile(path.join(path.dirname(config.cliJsPath), 'package.json'), 'utf8'));
      if (pkg.name !== '@anthropic-ai/claude-code' || !await exists(config.cliJsPath)) throw new Error();
    } catch { throw failure('INVALID_CLI_PATH', 'Could not verify the official Claude Code npm package.'); }
    return { command: await resolveNode(config.nodePath, env, platform), prefix: [config.cliJsPath] };
  }
  const { directories, npmBases } = standardLocations(env, platform);
  const candidates = config.executablePath ? [config.executablePath] : directories.flatMap(dir => platform === 'win32' ? [path.join(dir, 'claude.exe'), path.join(dir, 'claude.cmd'), path.join(dir, 'claude.ps1')] : [path.join(dir, 'claude')]);
  if (config.executablePath && !path.isAbsolute(config.executablePath)) throw failure('INVALID_CLI_PATH', 'Specify the absolute path to the Claude Code executable.');
  for (const file of candidates) {
    if (!/^(claude|claude\.exe|claude\.cmd|claude\.ps1)$/i.test(path.basename(file)) || !await exists(file)) continue;
    if (/\.(cmd|ps1)$/i.test(file)) {
      const command = await officialNpmCommand(path.dirname(file), config, env, platform);
      if (command) return command;
      continue;
    }
    return { command: file, prefix: [] };
  }
  if (!config.executablePath) for (const base of npmBases) { const command = await officialNpmCommand(base, config, env, platform); if (command) return command; }
  throw failure('CLI_NOT_FOUND', 'Install official Claude Code and specify its executable path.');
}

async function resolveNode(explicit, env, platform) {
  const candidates = explicit ? [explicit] : (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, platform === 'win32' ? 'node.exe' : 'node'));
  if (!explicit && /^(node|node\.exe)$/i.test(path.basename(process.execPath))) candidates.push(process.execPath);
  if (!explicit && platform === 'win32') for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')].filter(Boolean)) candidates.push(path.join(base, 'nodejs', 'node.exe'));
  for (const file of candidates) if (path.isAbsolute(file) && /^(node|node\.exe)$/i.test(path.basename(file)) && await exists(file)) return file;
  throw failure('NODE_NOT_FOUND', 'An absolute Node.js path is required to run the npm installation of Claude Code.');
}

function inputText(input) {
  if (typeof input === 'string') return input;
  if (!input || typeof input.prompt !== 'string') throw failure('INVALID_INPUT', 'Enter a question.');
  const context = typeof input.context === 'string' ? input.context : Array.isArray(input.context) ? input.context.map(item => typeof item === 'string' ? item : JSON.stringify(item)).join('\n\n') : '';
  return [input.system ? `Response instructions:\n${input.system}` : '', context ? `Retrieved note evidence:\n${context}` : '', `User question:\n${input.prompt}`].filter(Boolean).join('\n\n');
}

export class ClaudeCodeProvider {
  constructor({ config = {}, onConfig = () => {}, cwd, spawnImpl = spawn } = {}) {
    if (!cwd || !path.isAbsolute(cwd)) throw failure('INVALID_CWD', 'An absolute path to a dedicated working directory is required.');
    this.config = config; this.onConfig = onConfig; this.cwd = cwd; this.spawn = spawnImpl;
    this.connected = false; this.command = null; this.active = new Set(); this.loginChild = null; this.models = [{ ...DEFAULT_MODEL }];
  }

  async connect({ signal, onStatus = () => {}, newAccount = false, reuseSession = false, loginTimeoutMs = 300000 } = {}) {
    if (signal?.aborted) throw cancelled();
    this.connected = false;
    onStatus({ state: 'detecting', message: 'Checking the official Claude Code installation.' });
    this.command = await resolveClaudeCommand(this.config);
    const version = await this._run(['--version'], { signal, timeout: 15000 });
    if (version.code !== 0 || !/\d+\.\d+\.\d+/.test(version.stdout)) throw failure('CLI_VERSION_FAILED', 'Could not read the Claude Code version. Check the official installation.');
    onStatus({ state: 'checking-login', message: 'Checking the official Claude Code login.' });
    const auth = newAccount ? null : await this._readAuthStatus(signal);
    if(reuseSession&&!newAccount&&(auth.loggedIn===false||auth.authMethod==='none'))throw failure('LOGIN_REQUIRED','No saved Claude subscription login is available. Choose Connect to sign in.');
    if (newAccount || auth.loggedIn === false || auth.authMethod === 'none') {
      await this._login({ signal, onStatus, timeoutMs: loginTimeoutMs });
      onStatus({ state: 'checking-login', message: 'Checking the Claude subscription account after official sign-in.', loginUrl: null });
      await this._assertSubscriptionLogin(signal);
    } else this._requireSubscription(auth);
    this.version = version.stdout.match(/\d+\.\d+\.\d+/)?.[0];
    try { if(!reuseSession||newAccount)await this.onConfig({ ...this.config, executablePath: this.command.prefix.length ? this.config.executablePath : this.command.command }); }
    catch { throw failure('CONFIG_SAVE_FAILED', 'Could not save the Claude Code installation path.'); }
    if (signal?.aborted) throw cancelled();
    this.connected = true;
    const result = await this.status(); onStatus(result); return result;
  }

  async _assertSubscriptionLogin(signal) {
    this._requireSubscription(await this._readAuthStatus(signal));
  }

  async _readAuthStatus(signal) {
    const auth = await this._run(['auth', 'status'], { signal, timeout: 15000 });
    let status;
    try { status = JSON.parse(auth.stdout); } catch { throw failure('AUTH_STATUS_INVALID', 'Could not read the Claude Code login status. Update the official CLI.'); }
    if (!status || typeof status !== 'object' || typeof status.authMethod !== 'string') throw failure('AUTH_STATUS_INVALID', 'The official Claude Code login response is invalid.');
    if (auth.code !== 0 && status.loggedIn !== false && status.authMethod !== 'none') throw failure('AUTH_STATUS_FAILED', 'Could not confirm the official Claude Code login status.');
    return { loggedIn: status.loggedIn, authMethod: status.authMethod, apiProvider: status.apiProvider };
  }

  _requireSubscription(status) {
    if (status.loggedIn === false || status.authMethod === 'none') throw failure('LOGIN_REQUIRED', 'Complete official Claude subscription sign-in, then reconnect.');
    if (status.authMethod !== 'claude.ai' || (status.apiProvider && status.apiProvider !== 'firstParty')) throw failure('SUBSCRIPTION_LOGIN_REQUIRED', 'Choose Claude subscription sign-in. API billing is not selected automatically.');
  }

  async _login({ signal, onStatus, timeoutMs }) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw failure('INVALID_TIMEOUT', 'The login timeout setting is invalid.');
    const help = await this._run(['auth', 'login', '--help'], { signal, timeout: 15000 });
    if (help.code !== 0 || !/--claudeai\b/.test(help.stdout)) throw failure('CLI_UPDATE_REQUIRED', 'The official Claude Code CLI does not support subscription sign-in. Update it first.');
    onStatus({ state: 'waiting-login', message: 'Opening official Claude sign-in. Sign in to your subscription account in the browser.', loginUrl: null });
    const buffers = { stdout: '', stderr: '' }; let lastUrl = null;
    const receive = ({ stream, text, ending = false }) => {
      buffers[stream] += text; buffers[stream] = stripAnsiCsi(buffers[stream]);
      const lines = buffers[stream].split(/[\r\n]/); buffers[stream] = ending ? '' : lines.pop();
      if (buffers[stream].length > 32768) buffers[stream] = buffers[stream].slice(-32768);
      for (const line of lines) for (const match of line.matchAll(/https:\/\/[^\s<>"']+/g)) {
        const loginUrl = safeClaudeLoginUrl(match[0].replace(/[),.;]+$/, ''));
        if (!loginUrl && /\/oauth\/authorize(?:\?|$)/.test(match[0])) throw failure('LOGIN_URL_INVALID', 'Could not verify the official Claude login URL. Update the CLI or run claude auth login --claudeai in a terminal.');
        if (loginUrl && loginUrl !== lastUrl) { lastUrl = loginUrl; onStatus({ state: 'waiting-login', message: 'Complete official Claude subscription sign-in in the browser. If it did not open, select Open Claude login again.', loginUrl }); }
      }
    };
    let result;
    try { result = await this._run(['auth', 'login', '--claudeai'], { signal, timeout: timeoutMs, keepStdinOpen: true, onOutput: receive, onStart: child => { this.loginChild = child; } }); }
    catch (error) { if (error.code === 'TIMEOUT') throw failure('LOGIN_TIMEOUT', 'Claude sign-in timed out. Check the browser and retry, or run claude auth login --claudeai in a terminal.'); throw error; }
    finally { lastUrl = null; this.loginChild = null; }
    if (result.unsupportedOption) throw failure('CLI_UPDATE_REQUIRED', 'Update the official Claude Code CLI, then sign in again.');
    if (result.code !== 0) throw failure('LOGIN_FAILED', 'Claude sign-in did not complete. Check the browser or CLI, then try again.');
  }

  async submitLoginCode(value) {
    const code = typeof value === 'string' ? value.trim() : '';
    if (code.length < 16 || code.length > 4096 || !/^[A-Za-z0-9._~+/#=-]+$/.test(code) || /^(https?:|sk-|Bearer)/i.test(code)) throw failure('INVALID_LOGIN_CODE', 'Paste only the login code shown by the official Claude page.');
    const child = this.loginChild;
    if (!child || child.killed || child.stdin.destroyed || child.stdin.writableEnded) throw failure('LOGIN_NOT_PENDING', 'Start Claude subscription sign-in before submitting a login code.');
    await new Promise((resolve, reject) => child.stdin.write(code + '\n', error => error ? reject(failure('LOGIN_CODE_FAILED', 'Could not send the login code to the official Claude Code process. Start sign-in again.')) : resolve()));
    return true;
  }

  async listModels({ signal } = {}) {
    if (!this.connected || !this.command) throw failure('NOT_CONNECTED', 'Connect Claude Code first.');
    this.models = [];
    await this._assertSubscriptionLogin(signal);
    const requestId = randomUUID(); let catalog = null; let catalogFailure = null; let child;
    // This is the official SDK initialization handshake. No user message is sent,
    // so discovery does not generate an answer or consume model inference.
    const response = await this._run(['--safe-mode', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--tools', '', '--disallowedTools', '*', '--permission-mode', 'dontAsk', '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence', '--settings', '{"disableAllHooks":true,"apiKeyHelper":""}'], {
      signal, timeout: 30000, keepStdinOpen: true,
      stdin: JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'initialize', hooks: null } }) + '\n',
      onStart: process => { child = process; },
      onLine: line => {
        let event; try { event = JSON.parse(line); } catch { catalogFailure = failure('INVALID_CATALOG', 'Could not read the Claude Code account model menu.'); child.stdin.end(); return; }
        if (event.type !== 'control_response' || event.response?.request_id !== requestId) return;
        if (event.response.subtype !== 'success' || !Array.isArray(event.response.response?.models)) catalogFailure = failure('INVALID_CATALOG', 'The official Claude Code account model menu is unavailable. Update the CLI and reconnect.');
        else catalog = event.response.response.models;
        child.stdin.end();
      }
    });
    if (response.unsupportedOption) throw failure('CLI_UPDATE_REQUIRED', 'Update Claude Code to read its current account model menu.');
    if (catalogFailure) throw catalogFailure;
    if (response.code !== 0 || !catalog) throw failure('INVALID_CATALOG', 'Could not load the Claude Code account model menu. Update the CLI and reconnect.');
    const models = catalog.filter(item => item && typeof item.value === 'string' && item.value.trim() && item.value.length <= 200 && !/[\r\n\0]/.test(item.value))
      .map(item => ({ id: item.value, name: typeof item.displayName === 'string' ? item.displayName : item.value,
        source: 'claude-code-runtime-catalog', availability: 'listed', verified: false,
        ...(typeof item.resolvedModel === 'string' ? { resolvedModel: item.resolvedModel } : {}),
        ...(typeof item.description === 'string' ? { description: item.description } : {}),
        supportedReasoningEfforts: Array.isArray(item.supportedEffortLevels) ? item.supportedEffortLevels.filter(value => ['low', 'medium', 'high', 'xhigh', 'max'].includes(value)) : [] }));
    this.models = [...new Map(models.map(model => [model.id, model])).values()];
    return this.models.map(model => ({ ...model, supportedReasoningEfforts: [...model.supportedReasoningEfforts] }));
  }
  async status() { return { connected: this.connected, provider: 'claude-code', mode: 'subscription', version: this.version || null, state: this.connected ? 'connected' : 'disconnected', message: this.connected ? 'Connected to your Claude Code subscription login.' : 'Claude Code is not connected.' }; }
  async disconnect() { for (const child of this.active) child.kill('SIGTERM'); this.connected = false; this.command = null; this.models = []; return this.status(); }

  async generate(input, { model = 'default', signal, onDelta = () => {} } = {}) {
    if (!this.connected || !this.command) throw failure('NOT_CONNECTED', 'Connect Claude Code first.');
    if (!this.models.some(item => item.id === model)) throw failure('MODEL_NOT_VERIFIED', 'Refresh the Claude Code account model menu and select a listed model.');
    // A user may change the CLI login after connect. Recheck before any inference.
    await this._assertSubscriptionLogin(signal);
    const prompt = inputText(input);
    if (!prompt.trim() || Buffer.byteLength(prompt) > 9 * 1024 * 1024) throw failure('INVALID_INPUT', 'The question and retrieved context must be no larger than 9 MB.');
    let result = null; let streamed = ''; let streamFailure = null;
    const response = await this._run(['--safe-mode', '-p', ...(model === 'default' ? [] : ['--model', model]), '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--tools', '', '--disallowedTools', '*', '--permission-mode', 'dontAsk', '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence', '--settings', '{"disableAllHooks":true,"apiKeyHelper":""}'], {
      signal, stdin: prompt, timeout: this.config.timeoutMs || 180000,
      onLine: line => {
        let event; try { event = JSON.parse(line); } catch { streamFailure = failure('INVALID_STREAM', 'Could not read the Claude Code response.'); return; }
        if (event.type === 'stream_event' && event.event?.delta?.type === 'text_delta' && typeof event.event.delta.text === 'string' && !streamFailure) {
          streamed += event.event.delta.text; onDelta(event.event.delta.text);
        }
        if (event.type === 'result') result = event;
        if (event.type === 'error' || (event.type === 'system' && event.subtype === 'permission_denied')) streamFailure = failure('CLAUDE_REQUEST_FAILED', 'Claude Code rejected the request. Check its status in the official CLI.');
      }
    });
    if (response.code !== 0 && response.unsupportedOption) throw failure('CLI_UPDATE_REQUIRED', 'This Claude Code version does not support the required options. Update the official CLI and repeat the connection test.');
    if (streamFailure) throw streamFailure;
    if (response.code !== 0 || !result || result.is_error || result.subtype !== 'success') throw failure('CLAUDE_REQUEST_FAILED', 'The Claude Code request did not complete. Check login and usage limits in the official CLI.');
    const text = typeof result.result === 'string' ? result.result : streamed;
    if (!text) throw failure('EMPTY_RESPONSE', 'Claude Code returned no answer text.');
    if (!streamed) onDelta(text);
    return text;
  }

  _run(args, { signal, stdin = '', timeout, onLine, onOutput, onStart, keepStdinOpen = false } = {}) {
    if (signal?.aborted) return Promise.reject(cancelled());
    return new Promise((resolve, reject) => {
      let child; let stdout = ''; let lineBuffer = ''; let stderrSample = ''; let bytes = 0; let pendingError = null; let settled = false; let killTimer;
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort); if (child) this.active.delete(child); error ? reject(error) : resolve(value); };
      const stop = error => { if (pendingError || settled) return; pendingError = error; child?.kill('SIGTERM'); killTimer = setTimeout(() => { child?.kill('SIGKILL'); finish(error); }, 2000); killTimer.unref?.(); };
      const abort = () => stop(cancelled());
      const timer = setTimeout(() => stop(failure('TIMEOUT', 'The Claude Code request timed out.')), timeout);
      timer.unref?.();
      try { child = this.spawn(this.command.command, [...this.command.prefix, ...args], { cwd: this.cwd, env: subscriptionEnvironment(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch { finish(failure('CLI_START_FAILED', 'Could not start Claude Code.')); return; }
      this.active.add(child); signal?.addEventListener('abort', abort, { once: true });
      child.on('error', () => finish(failure('CLI_START_FAILED', 'Could not start Claude Code.')));
      const statusFailure = error => error?.code === 'LOGIN_URL_INVALID' ? failure('LOGIN_URL_INVALID', 'Could not verify the official Claude login URL. Update the CLI or run claude auth login --claudeai in a terminal.') : failure('STATUS_HANDLER_FAILED', 'Could not display the login progress.');
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { if (stderrSample.length < 8192) stderrSample += chunk.slice(0, 8192 - stderrSample.length); if (onOutput) try { onOutput({ stream: 'stderr', text: chunk }); } catch (error) { stop(statusFailure(error)); } });
      child.stdout.on('data', chunk => {
        bytes += Buffer.byteLength(chunk); if (bytes > MAX_OUTPUT) { stop(failure('OUTPUT_TOO_LARGE', 'The Claude Code response exceeds the size limit.')); return; }
        stdout += chunk;
        if (onOutput) try { onOutput({ stream: 'stdout', text: chunk }); } catch (error) { stop(statusFailure(error)); }
        if (onLine) { lineBuffer += chunk; const lines = lineBuffer.split('\n'); lineBuffer = lines.pop(); for (const line of lines) if (line.trim()) { try { onLine(line); } catch { stop(failure('STREAM_HANDLER_FAILED', 'Could not display the response.')); } } }
      });
      child.on('close', code => { if (onOutput && !pendingError) try { onOutput({ stream: 'stdout', text: '', ending: true }); onOutput({ stream: 'stderr', text: '', ending: true }); } catch (error) { pendingError = statusFailure(error); } if (onLine && lineBuffer.trim() && !pendingError) { try { onLine(lineBuffer); } catch { pendingError = failure('STREAM_HANDLER_FAILED', 'Could not display the response.'); } } finish(pendingError, { code, stdout, unsupportedOption: /(?:unknown|unrecognized|unsupported)\s+(?:option|argument)/i.test(stderrSample) }); });
      child.stdin.on('error', () => stop(failure('STDIN_FAILED', 'Could not send the question to Claude Code.')));
      if (onStart) onStart(child);
      if (keepStdinOpen) { if (stdin) child.stdin.write(stdin); } else child.stdin.end(stdin);
      if (signal?.aborted) abort();
    });
  }
}
