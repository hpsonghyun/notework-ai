import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ClaudeCodeProvider, resolveClaudeCommand, subscriptionEnvironment, safeClaudeLoginUrl } from '../src/providers/claude-code.mjs';

async function fixture(t) { const dir = await mkdtemp(path.join(os.tmpdir(), 'notework-claude-test-')); t.after(() => rm(dir, { recursive: true, force: true })); const executablePath = path.join(dir, 'claude.exe'); await writeFile(executablePath, 'test binary placeholder'); return { dir, executablePath }; }
function mockedSpawn(outputs, calls = []) {
  return (command, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); const call = { command, args, options, prompt: '', child }; calls.push(call); const output = outputs.shift();
    child.kill = signal => { child.killed = signal; queueMicrotask(() => child.emit('close', 143)); return true; };
    child.stdin = new Writable({ write(chunk, encoding, cb) { call.prompt += chunk.toString(); cb(); } });
    queueMicrotask(() => { if (output?.chunks) for (const {stream='stdout',text} of output.chunks) child[stream].write(text); if (output?.hold) { child.stdout.write(output?.stdout || ''); child.stderr.write(output?.stderr || ''); return; } child.stdout.end(output?.stdout || ''); child.stderr.end(output?.stderr || ''); child.emit('close', output?.code ?? 0); });
    return child;
  };
}
const connected = [{ stdout: '2.1.286 (Claude Code)' }, { stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }) }];
const subscribed = connected[1];

test('connect checks official version and own login without inference or credential collection', async t => {
  const { dir, executablePath } = await fixture(t); const calls = [];
  const provider = new ClaudeCodeProvider({ config: { executablePath }, cwd: dir, spawnImpl: mockedSpawn([...connected], calls) });
  const status = await provider.connect(); assert.equal(status.connected, true); assert.equal(status.mode, 'subscription');
  assert.deepEqual(calls.map(c => c.args), [['--version'], ['auth', 'status']]); assert.ok(calls.every(c => c.options.shell === false && c.options.windowsHide === true));
  // Connection itself checks login; account model discovery is a separate metadata-only handshake.
  assert.deepEqual(provider.models, [{ id: 'default', name: 'Model selected in Claude Code', source: 'host-managed' }]);
});

test('reload reuse checks existing Claude subscription without login or inference',async t=>{
  const {dir,executablePath}=await fixture(t),calls=[];
  const provider=new ClaudeCodeProvider({config:{executablePath},cwd:dir,onConfig:()=>assert.fail('Reload reuse must not rewrite an unchanged installation path.'),spawnImpl:mockedSpawn([...connected],calls)});
  assert.equal((await provider.connect({reuseSession:true})).connected,true);
  assert.deepEqual(calls.map(call=>call.args),[['--version'],['auth','status']]);
});

test('reload reuse with missing Claude login fails closed without launching auth login',async t=>{
  const {dir,executablePath}=await fixture(t);
  for(const status of [{loggedIn:false,authMethod:'none'},{loggedIn:false,authMethod:'claude.ai'}]){
    const calls=[],provider=new ClaudeCodeProvider({config:{executablePath},cwd:dir,spawnImpl:mockedSpawn([{stdout:'2.1.286'},{stdout:JSON.stringify(status),code:1}],calls)});
    await assert.rejects(provider.connect({reuseSession:true}),{code:'LOGIN_REQUIRED'});
    assert.deepEqual(calls.map(call=>call.args),[['--version'],['auth','status']]);assert.equal((await provider.status()).connected,false);
  }
});

test('subscription mode rejects API login and never falls back to API generation', async t => {
  const { dir, executablePath } = await fixture(t); const calls = [];
  const provider = new ClaudeCodeProvider({ config: { executablePath }, cwd: dir, spawnImpl: mockedSpawn([{ stdout: '2.1.286' }, { stdout: '{"loggedIn":true,"authMethod":"api_key"}' }], calls) });
  await assert.rejects(provider.connect(), { code: 'SUBSCRIPTION_LOGIN_REQUIRED' }); assert.equal(calls.length, 2);
  await assert.rejects(provider.generate('test'), { code: 'NOT_CONNECTED' });
});

test('missing login starts official subscription login, emits a safe browser URL and rechecks own auth', async t => {
  const { dir, executablePath } = await fixture(t);
  const calls = []; const statuses = []; const loginUrl = 'https://claude.ai/oauth/authorize?state=fake-state&code_challenge=fake-challenge';
  const provider = new ClaudeCodeProvider({ config: { executablePath }, cwd: dir, spawnImpl: mockedSpawn([{ stdout: '2.1.286' }, { stdout: '{"loggedIn":false,"authMethod":"none"}', code: 1 }, { stdout: 'Usage: claude auth login\n --claudeai  Use Claude subscription\n' }, { stdout: `\u001b[32m${loginUrl}\u001b[0m\nprivate-token-do-not-expose\n` }, subscribed], calls) });
  assert.equal((await provider.connect({ onStatus: status => statuses.push(status) })).connected, true);
  assert.deepEqual(calls.map(call => call.args), [['--version'], ['auth', 'status'], ['auth', 'login', '--help'], ['auth', 'login', '--claudeai'], ['auth', 'status']]);
  assert.ok(statuses.some(status => status.state === 'waiting-login' && status.loginUrl === loginUrl)); assert.ok(!JSON.stringify(statuses).includes('private-token'));
});

test('generation sends prompt over stdin without shell quoting, limits tools and verifies final result', async t => {
  const { dir, executablePath } = await fixture(t); const calls = []; const deltas = [];
  const stream = [{ type: 'system', subtype: 'init' }, { type: 'stream_event', event: { delta: { type: 'text_delta', text: '안녕' } } }, { type: 'result', subtype: 'success', is_error: false, result: '안녕' }].map(JSON.stringify).join('\n');
  const provider = new ClaudeCodeProvider({ config: { executablePath }, cwd: dir, spawnImpl: mockedSpawn([...connected, subscribed, { stdout: stream }], calls) });
  await provider.connect(); const prompt = '` & $(echo secret) "quoted"\n질문'; assert.equal(await provider.generate(prompt, { onDelta: delta => deltas.push(delta) }), '안녕');
  const call = calls[3]; assert.equal(call.prompt, prompt); assert.equal(call.options.shell, false); assert.ok(!call.args.includes(prompt));
  assert.ok(call.args.includes('--safe-mode')); assert.equal(call.args[call.args.indexOf('--tools') + 1], ''); assert.equal(call.args[call.args.indexOf('--disallowedTools') + 1], '*');
  assert.ok(!call.args.includes('--bare')); assert.ok(!call.args.some(arg => /skip-permissions/.test(arg))); assert.deepEqual(deltas, ['안녕']);
});

test('failure after streamed text is not treated as successful answer and error body stays private', async t => {
  const { dir, executablePath } = await fixture(t);
  const provider = new ClaudeCodeProvider({ config: { executablePath }, cwd: dir, spawnImpl: mockedSpawn([...connected, subscribed, { stdout: '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"sk-secret private email"}', stderr: 'token-secret' }]) });
  await provider.connect(); await assert.rejects(provider.generate('test'), error => error.code === 'CLAUDE_REQUEST_FAILED' && !/secret|email/.test(error.message));
});

test('truncated or malformed JSON stream fails closed', async t => {
  const { dir, executablePath } = await fixture(t);
  for (const stdout of ['not json', '{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"partial"}}}']) {
    const provider = new ClaudeCodeProvider({ config: { executablePath }, cwd: dir, spawnImpl: mockedSpawn([...connected, subscribed, { stdout }]) });
    await provider.connect(); await assert.rejects(provider.generate('test'), error => ['INVALID_STREAM', 'CLAUDE_REQUEST_FAILED'].includes(error.code));
  }
});

test('parent API, OAuth token and alternate provider environment is removed', () => {
  const env = subscriptionEnvironment({ PATH: 'safe-path', HOME: 'user-home', ANTHROPIC_API_KEY: 'key', ANTHROPIC_AUTH_TOKEN: 'token', ANTHROPIC_BASE_URL: 'http://evil', CLAUDE_CODE_OAUTH_TOKEN: 'token', CLAUDE_CODE_USE_BEDROCK: '1', OPENAI_API_KEY: 'key', AWS_SECRET_ACCESS_KEY: 'key', GOOGLE_APPLICATION_CREDENTIALS: '/secret', CLAUDE_CODE_SIMPLE: '1' });
  assert.deepEqual(env, { PATH: 'safe-path', HOME: 'user-home', CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1' });
});

test('Windows cmd shim resolves official npm script and node without invoking a shell', async t => {
  const { dir } = await fixture(t); const shim = path.join(dir, 'claude.cmd'); const pkg = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code');
  await mkdir(pkg, { recursive: true }); await writeFile(shim, '@echo off'); await writeFile(path.join(pkg, 'package.json'), '{"name":"@anthropic-ai/claude-code"}'); await writeFile(path.join(pkg, 'cli.js'), '// fixture');
  const resolved = await resolveClaudeCommand({ executablePath: shim, nodePath: process.execPath }, process.env, 'win32'); assert.equal(resolved.command, process.execPath); assert.deepEqual(resolved.prefix, [path.join(pkg, 'cli.js')]);
});

test('unknown Windows shim and relative path are rejected rather than shell-executed', async t => {
  const { dir } = await fixture(t); const shim = path.join(dir, 'claude.cmd'); await writeFile(shim, '@echo off');
  await assert.rejects(resolveClaudeCommand({ executablePath: shim }, process.env, 'win32'), { code: 'CLI_NOT_FOUND' });
  await assert.rejects(resolveClaudeCommand({ executablePath: 'claude.cmd' }), { code: 'INVALID_CLI_PATH' });
});

test('AbortSignal kills a real long-lived test subprocess and rejects without API fallback', async t => {
  const { dir } = await fixture(t); const pkg = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code'); await mkdir(pkg, { recursive: true });
  await writeFile(path.join(pkg, 'package.json'), '{"name":"@anthropic-ai/claude-code"}');
  await writeFile(path.join(pkg, 'cli.js'), `if(process.argv.includes('--version'))console.log('2.1.286');else if(process.argv.includes('status'))console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai'}));else {process.stdin.resume();setInterval(()=>{},1000);}`);
  const provider = new ClaudeCodeProvider({ config: { cliJsPath: path.join(pkg, 'cli.js'), nodePath: process.execPath }, cwd: dir }); await provider.connect();
  const controller = new AbortController(); const promise = provider.generate('fake test only', { signal: controller.signal }); setTimeout(() => controller.abort(), 100);
  await assert.rejects(promise, { name: 'AbortError', code: 'CANCELLED' }); assert.equal(provider.active.size, 0);
});

test('unverified model is rejected before making a request', async t => {
  const { dir, executablePath } = await fixture(t); const calls = []; const provider = new ClaudeCodeProvider({ config: { executablePath }, cwd: dir, spawnImpl: mockedSpawn([...connected], calls) }); await provider.connect();
  await assert.rejects(provider.generate('test', { model: 'imaginary-model' }), { code: 'MODEL_NOT_VERIFIED' }); assert.equal(calls.length, 2);
});

test('async configuration persistence failure fails connect without unhandled rejection', async t => {
  const { dir, executablePath } = await fixture(t); const provider = new ClaudeCodeProvider({ config: { executablePath }, cwd: dir, onConfig: async () => { throw new Error('disk private detail'); }, spawnImpl: mockedSpawn([...connected]) });
  await assert.rejects(provider.connect(), error => error.code === 'CONFIG_SAVE_FAILED' && !error.message.includes('private')); assert.equal((await provider.status()).connected, false);
});

test('login changed to API billing after connect is rejected before inference', async t => {
  const { dir, executablePath } = await fixture(t); const calls = [];
  const provider = new ClaudeCodeProvider({ config: { executablePath }, cwd: dir, spawnImpl: mockedSpawn([...connected, { stdout: '{"loggedIn":true,"authMethod":"api_key"}' }], calls) }); await provider.connect();
  await assert.rejects(provider.generate('test'), { code: 'SUBSCRIPTION_LOGIN_REQUIRED' }); assert.equal(calls.length, 3); assert.deepEqual(calls[2].args, ['auth', 'status']);
});

test('older unsupported CLI flags are reported as update needed without stderr exposure', async t => {
  const { dir, executablePath } = await fixture(t);
  const provider = new ClaudeCodeProvider({ config: { executablePath }, cwd: dir, spawnImpl: mockedSpawn([...connected, subscribed, { code: 1, stderr: "error: unknown option '--safe-mode' secret-token" }]) }); await provider.connect();
  await assert.rejects(provider.generate('test'), error => error.code === 'CLI_UPDATE_REQUIRED' && error.message.includes('Update') && !error.message.includes('secret'));
});

test('npm fallback refuses a shell executable supplied as nodePath', async t => {
  const { dir } = await fixture(t); const pkg = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code'); await mkdir(pkg, { recursive: true });
  await writeFile(path.join(pkg, 'package.json'), '{"name":"@anthropic-ai/claude-code"}'); await writeFile(path.join(pkg, 'cli.js'), '// fixture'); const shellPath = path.join(dir, 'cmd.exe'); await writeFile(shellPath, 'placeholder');
  await assert.rejects(resolveClaudeCommand({ cliJsPath: path.join(pkg, 'cli.js'), nodePath: shellPath }), { code: 'NODE_NOT_FOUND' });
});

test('Windows standard APPDATA npm native installation is found without Electron PATH', async t => {
  const { dir } = await fixture(t); const appData = path.join(dir, 'Roaming'); const pkg = path.join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code'); await mkdir(path.join(pkg, 'bin'), { recursive: true });
  await writeFile(path.join(pkg, 'package.json'), '{"name":"@anthropic-ai/claude-code","bin":{"claude":"bin/claude.exe"}}'); const binary = path.join(pkg, 'bin', 'claude.exe'); await writeFile(binary, 'fixture');
  assert.deepEqual(await resolveClaudeCommand({}, { APPDATA: appData, PATH: '' }, 'win32'), { command: binary, prefix: [] });
});

test('Windows explicit PowerShell npm shim resolves native official bin without PowerShell', async t => {
  const { dir } = await fixture(t); const shim = path.join(dir, 'claude.ps1'); const pkg = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code'); await mkdir(path.join(pkg, 'bin'), { recursive: true });
  await writeFile(shim, '# fixture'); await writeFile(path.join(pkg, 'package.json'), '{"name":"@anthropic-ai/claude-code","bin":{"claude":"bin/claude.exe"}}'); const binary = path.join(pkg, 'bin', 'claude.exe'); await writeFile(binary, 'fixture');
  assert.deepEqual(await resolveClaudeCommand({ executablePath: shim }, { PATH: '' }, 'win32'), { command: binary, prefix: [] });
});

test('native user-local installation is found without PATH or npm', async t => {
  const { dir } = await fixture(t); const bin = path.join(dir, '.local', 'bin'); await mkdir(bin, { recursive: true }); const binary = path.join(bin, 'claude.exe'); await writeFile(binary, 'fixture');
  assert.deepEqual(await resolveClaudeCommand({}, { USERPROFILE: dir, PATH: '' }, 'win32'), { command: binary, prefix: [] });
});

test('newAccount starts official subscription login even when previous login exists', async t => {
  const { dir, executablePath } = await fixture(t); const calls = [];
  const provider = new ClaudeCodeProvider({ config: { executablePath }, cwd: dir, spawnImpl: mockedSpawn([connected[0], { stdout: '--claudeai Use Claude subscription' }, { stdout: 'login completed' }, subscribed], calls) });
  assert.equal((await provider.connect({ newAccount: true })).connected, true); assert.deepEqual(calls.map(call => call.args), [['--version'], ['auth', 'login', '--help'], ['auth', 'login', '--claudeai'], ['auth', 'status']]);
  assert.ok(calls.every(call => !call.args.includes('--console')));
});

test('cancel while official login waits kills its child and does not finish connection', async t => {
  const { dir, executablePath } = await fixture(t); const calls = []; const controller = new AbortController();
  const provider = new ClaudeCodeProvider({ config: { executablePath }, cwd: dir, spawnImpl: mockedSpawn([connected[0], { stdout: '{"loggedIn":false,"authMethod":"none"}', code: 1 }, { stdout: '--claudeai' }, { hold: true, stdout: 'https://claude.ai/oauth/authorize?state=fake\n' }], calls) });
  const promise = provider.connect({ signal: controller.signal, onStatus: status => { if (status.loginUrl) controller.abort(); } });
  await assert.rejects(promise, { name: 'AbortError', code: 'CANCELLED' }); assert.equal(calls.at(-1).child.killed, 'SIGTERM'); assert.equal((await provider.status()).connected, false); assert.equal(calls.length, 4);
});

test('official login failure is sanitized and no inference or fallback follows', async t => {
  const { dir, executablePath } = await fixture(t); const calls = [];
  const provider = new ClaudeCodeProvider({ config: { executablePath }, cwd: dir, spawnImpl: mockedSpawn([connected[0], { stdout: '--claudeai' }, { code: 1, stderr: 'secret auth code private error' }], calls) });
  await assert.rejects(provider.connect({ newAccount: true }), error => error.code === 'LOGIN_FAILED' && !/secret|private/.test(error.message)); assert.equal(calls.length, 3); assert.equal((await provider.status()).connected, false);
});

test('login exit success is not enough; final auth must be a subscription', async t => {
  const { dir, executablePath } = await fixture(t);
  const provider = new ClaudeCodeProvider({ config: { executablePath }, cwd: dir, spawnImpl: mockedSpawn([connected[0], { stdout: '--claudeai' }, { code: 0 }, { stdout: '{"loggedIn":true,"authMethod":"api_key"}' }]) });
  await assert.rejects(provider.connect({ newAccount: true }), { code: 'SUBSCRIPTION_LOGIN_REQUIRED' }); assert.equal((await provider.status()).connected, false);
});

test('official browser URL helper rejects credentials, tokens and lookalike hosts', () => {
  assert.equal(safeClaudeLoginUrl('https://claude.ai/oauth/authorize?state=fake&code_challenge=fake'), 'https://claude.ai/oauth/authorize?state=fake&code_challenge=fake');
  for (const url of ['https://claude.ai.evil.example/oauth/authorize', 'http://claude.ai/oauth/authorize', 'https://user:password@claude.ai/oauth/authorize', 'https://claude.ai/oauth/authorize?code=private', 'https://claude.ai/oauth/authorize?access_token=private', 'https://claude.ai/oauth/authorize#token', 'https://claude.ai/chat/secret', 'https://console.anthropic.com/oauth/authorize']) assert.equal(safeClaudeLoginUrl(url), null);
});

test('CLI without the explicit subscription flag is stopped before login', async t => {
  const { dir, executablePath } = await fixture(t); const calls = [];
  const provider = new ClaudeCodeProvider({ config: { executablePath }, cwd: dir, spawnImpl: mockedSpawn([connected[0], { stdout: 'auth login --console' }], calls) });
  await assert.rejects(provider.connect({ newAccount: true }), { code: 'CLI_UPDATE_REQUIRED' }); assert.equal(calls.length, 2);
});

test('null auth JSON fails with a sanitized format error', async t => {
  const { dir, executablePath } = await fixture(t); const provider = new ClaudeCodeProvider({ config: { executablePath }, cwd: dir, spawnImpl: mockedSpawn([connected[0], { stdout: 'null' }]) });
  await assert.rejects(provider.connect(), { code: 'AUTH_STATUS_INVALID' });
});

test('official-login test subprocess keeps stdin open and is terminated on cancellation', async t => {
  const { dir } = await fixture(t); const pkg = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code'); await mkdir(pkg, { recursive: true });
  await writeFile(path.join(pkg, 'package.json'), '{"name":"@anthropic-ai/claude-code"}');
  await writeFile(path.join(pkg, 'cli.js'), `if(process.argv.includes('--version'))console.log('2.1.286');else if(process.argv.includes('--help'))console.log('--claudeai Use Claude subscription');else if(process.argv.includes('status')){console.log(JSON.stringify({loggedIn:false,authMethod:'none'}));process.exitCode=1;}else {process.stdin.resume();console.log('https://claude.ai/oauth/authorize?state=fake-test-state');setInterval(()=>{},1000);}`);
  const provider = new ClaudeCodeProvider({ config: { cliJsPath: path.join(pkg, 'cli.js'), nodePath: process.execPath }, cwd: dir }); const controller = new AbortController();
  const promise = provider.connect({ signal: controller.signal, onStatus: status => { if (status.loginUrl) controller.abort(); } });
  await assert.rejects(promise, { name: 'AbortError', code: 'CANCELLED' }); assert.equal(provider.active.size, 0); assert.equal((await provider.status()).connected, false);
});

test('unverified OAuth browser URL fails visibly instead of leaving hidden pending login', async t => {
  const { dir, executablePath } = await fixture(t); const calls = []; const statuses = [];
  const provider = new ClaudeCodeProvider({ config: { executablePath }, cwd: dir, spawnImpl: mockedSpawn([connected[0], { stdout: '--claudeai' }, { hold: true, stderr: 'https://evil.example/oauth/authorize?state=secret-auth-state\n' }], calls) });
  await assert.rejects(provider.connect({ newAccount: true, onStatus: status => statuses.push(status) }), error => error.code === 'LOGIN_URL_INVALID' && error.message.includes('official') && !error.message.includes('secret'));
  assert.equal(calls.at(-1).child.killed, 'SIGTERM'); assert.ok(!statuses.some(status => status.loginUrl));
});

const currentOfficialUrl='https://claude.com/cai/oauth/authorize?code=true&client_id=fixture-client&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A45678%2Fcallback&scope=user%3Ainference&code_challenge=fixture-pkce&code_challenge_method=S256&state=fixture-state';
test('current official Claude Code authorization destination and boolean code switch are accepted',()=>{
  assert.equal(safeClaudeLoginUrl(currentOfficialUrl),currentOfficialUrl);
  assert.equal(safeClaudeLoginUrl('https://claude.ai/oauth/authorize?code=true&state=fixture'), 'https://claude.ai/oauth/authorize?code=true&state=fixture');
});
test('new Claude domain does not weaken host, path, credential, fragment or code checks',()=>{
  for(const url of [
    currentOfficialUrl.replace('claude.com','claude.com.evil.example'),
    currentOfficialUrl.replace('https:','http:'),
    currentOfficialUrl.replace('claude.com','user:password@claude.com'),
    currentOfficialUrl.replace('/cai/oauth/authorize','/chat'),
    currentOfficialUrl.replace('/cai/oauth/authorize','/oauth/authorize'),
    currentOfficialUrl.replace('code=true','code=private-returned-code'),
    currentOfficialUrl.replace('code=true','code=true&code=private-returned-code'),
    currentOfficialUrl.replace('code=true','Code=true'),
    currentOfficialUrl+'&access_token=private',currentOfficialUrl+'&api_key=private',
    currentOfficialUrl+'#private', 'https://claude.com:1234/cai/oauth/authorize?code=true',
    'https://claude.ai/login?code=true'
  ])assert.equal(safeClaudeLoginUrl(url),null);
});
test('current official URL survives every stdout chunk boundary and ANSI wrapping',async t=>{
  const {dir,executablePath}=await fixture(t);
  for(let split=1;split<currentOfficialUrl.length;split++){
    const statuses=[];
    const provider=new ClaudeCodeProvider({config:{executablePath},cwd:dir,spawnImpl:mockedSpawn([connected[0],{stdout:'--claudeai'}, {chunks:[{text:'Open browser: \u001b[32m'+currentOfficialUrl.slice(0,split)},{text:currentOfficialUrl.slice(split)+'\u001b[0m\n'}]},subscribed])});
    assert.equal((await provider.connect({newAccount:true,onStatus:s=>statuses.push(s)})).connected,true);
    assert.equal(statuses.filter(s=>s.loginUrl===currentOfficialUrl).length,1);
  }
});
test('official URL without a trailing newline is flushed on process close',async t=>{
 const {dir,executablePath}=await fixture(t);const statuses=[];
 const provider=new ClaudeCodeProvider({config:{executablePath},cwd:dir,spawnImpl:mockedSpawn([connected[0],{stdout:'--claudeai'}, {stderr:currentOfficialUrl},subscribed])});
 assert.equal((await provider.connect({newAccount:true,onStatus:s=>statuses.push(s)})).connected,true);
 assert.ok(statuses.some(s=>s.loginUrl===currentOfficialUrl));
});
test('manual browser login code goes only to the pending official CLI stdin and is cleared on stop',async t=>{
 const {dir,executablePath}=await fixture(t);const calls=[];const abort=new AbortController();let ready;
 const wait=new Promise(resolve=>{ready=resolve;});
 const provider=new ClaudeCodeProvider({config:{executablePath},cwd:dir,spawnImpl:mockedSpawn([connected[0],{stdout:'--claudeai'},{hold:true,stdout:currentOfficialUrl+'\n'}],calls)});
 const running=provider.connect({newAccount:true,signal:abort.signal,onStatus:s=>{if(s.loginUrl)ready();}});await wait;
 await provider.submitLoginCode('fixture-login-code#fixture-state');
 assert.equal(calls.at(-1).prompt,'fixture-login-code#fixture-state\n');assert.deepEqual(calls.at(-1).args,['auth','login','--claudeai']);
 abort.abort();await assert.rejects(running,{code:'CANCELLED'});assert.equal(provider.loginChild,null);
 await assert.rejects(provider.submitLoginCode('fixture-login-code#fixture-state'),{code:'LOGIN_NOT_PENDING'});
});
test('manual login rejects URLs, keys, control characters and oversized input without echo',async t=>{
 const {dir,executablePath}=await fixture(t);const provider=new ClaudeCodeProvider({config:{executablePath},cwd:dir});
 for(const code of ['short','https://claude.ai/code/private-value','sk-private-long-secret','BearerPrivateCredential','fixture-private-code\nsecond-line','x'.repeat(4097)])await assert.rejects(provider.submitLoginCode(code),error=>error.code==='INVALID_LOGIN_CODE'&&!error.message.includes('private'));
});
