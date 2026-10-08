import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ConversationArchive, normalizeArchiveFolder} from '../src/conversation-archive.mjs';
import {buildConversationStructureRequest,parseConversationStructureResponse} from '../src/conversation-structure.mjs';

const TIME = '2026-10-06T12:34:56.000Z';
function fixture({idFactory = () => 'conversation-1', clock = () => new Date(TIME)} = {}) {
  const contents = new Map(); const files = new Map(); const calls = []; const folders = new Map();
  const vault = {
    adapter: {exists: async path => files.has(path) || folders.has(path), stat: async path => folders.has(path) ? {type: 'folder'} : files.has(path) ? {type: 'file'} : null, read: async path => {if (!contents.has(path)) throw new Error('Not found'); return contents.get(path);}},
    getMarkdownFiles: () => [...files.values()].filter(file => file.path.endsWith('.md')),
    getAbstractFileByPath: path => files.get(path) || folders.get(path),
    createFolder: async path => {calls.push(['folder', path]); if (files.has(path) || folders.has(path)) throw new Error('Exists'); const folder = {path, children: []}; folders.set(path, folder); return folder;},
    create: async (path, content) => {calls.push(['create', path]); if (files.has(path) || folders.has(path)) throw new Error('Exists'); const file = {path, stat: {size: Buffer.byteLength(content)}}; files.set(path, file); contents.set(path, content); return file;},
    read: async file => {calls.push(['read', file.path]); if (!contents.has(file.path)) throw new Error('Not found'); return contents.get(file.path);},
    process: async (file, action) => {calls.push(['process', file.path]); const updated = action(contents.get(file.path)); contents.set(file.path, updated); file.stat.size = Buffer.byteLength(updated); return updated;},
  };
  return {vault, contents, files, folders, calls, archive: new ConversationArchive({vault, clock, idFactory})};
}
const messages = () => [
  {id: 'u1', role: 'user', content: 'What connects these notes? 한국어 질문 🧠', createdAt: TIME},
  {id: 'a1', role: 'assistant', content: 'Two supported claims.\n\n```js\nconsole.log("quoted");\n```', createdAt: TIME, route: 'claude-code', model: 'default', sources: [{path: 'Research/source.md', text: 'Original evidence.', score: 3}]},
  {id: 'u2', role: 'user', content: 'How does that compare with the first answer?', createdAt: TIME},
  {id: 'a2', role: 'assistant', content: 'Here is the comparison.', createdAt: TIME, route: 'openai', model: 'model-live'},
];

function structuredConversation() {
  const input = messages().map(message => ({...message,contextKey:'archive-ai-context'}));
  const request = buildConversationStructureRequest(input,'archive-ai-context');
  const answer = JSON.stringify({cards:request.cards.map((card,index)=>({id:card.id,parentId:index?request.cards[0].id:null,relation:index?'refine':'start',topic:'Research question'}))});
  const analysis = parseConversationStructureResponse(answer,request,{messages:input,contextKey:'archive-ai-context',model:'synthetic-map-model',clock:()=>new Date(TIME)});
  return {messages:input,analysis};
}

test('connected AI structure survives history reload with exact turn IDs and no new model request',async()=>{
  const f=fixture(),input=structuredConversation();
  const saved=await f.archive.save({messages:input.messages,conversationMapAnalysis:input.analysis});
  const loaded=await f.archive.load({path:saved.path});
  assert.deepEqual(loaded.conversationMapAnalysis,input.analysis);
  assert.equal(loaded.conversationMapAnalysis.decisions[1].parentId,input.analysis.decisions[0].cardId);
  assert.ok(f.contents.get(saved.path).includes('## Conversation structure (AI)'));
  assert.ok(!f.contents.get(saved.path).includes('## Conversation flow (Jev)'));
});

test('AI structure rejects changed turns, invented cards and impossible parents before archiving',async()=>{
  for(const mutate of [
    input=>{input.messages[1].content+=' changed';},
    input=>{input.analysis.decisions[0].cardId='map:invented:turn';},
    input=>{input.analysis.decisions[1].parentId=input.analysis.decisions[1].cardId;},
    input=>{input.analysis.sourceHash='0'.repeat(64);}
  ]) {
    const f=fixture(),input=structuredConversation();mutate(input);
    await assert.rejects(f.archive.save({messages:input.messages,conversationMapAnalysis:input.analysis}),{code:'ARCHIVE_INVALID_DATA'});
    assert.equal(f.calls.filter(call=>call[0]==='create').length,0);
  }
});

test('AI structure metadata drops unrelated provider settings and nested unknown fields',async()=>{
  const f=fixture(),input=structuredConversation();
  input.analysis.apiKey='fixture-map-secret';input.analysis.settings={token:'fixture-map-token'};input.analysis.decisions[0].credentials='fixture-decision-secret';
  const saved=await f.archive.save({messages:input.messages,conversationMapAnalysis:input.analysis});
  const loaded=await f.archive.load({path:saved.path});
  assert.ok(!JSON.stringify(loaded).includes('fixture-'));
  assert.ok(!f.contents.get(saved.path).includes('fixture-'));
});
test('bounded assistant context source fingerprints survive archive reload while unknown settings are dropped',async()=>{const f=fixture();const input=messages();input[1].contextSources=[{path:'Research/source.md',contentHash:'a'.repeat(64),apiKey:'fixture-context-secret',text:'Do not duplicate ancestor note text'}];const saved=await f.archive.save({messages:input});const loaded=await f.archive.load({path:saved.path});assert.deepEqual(loaded.messages[1].contextSources,[{path:'Research/source.md',contentHash:'a'.repeat(64)}]);assert.ok(!f.contents.get(saved.path).includes('fixture-context-secret'));for(const contextSources of [[{path:'Research/source.md',contentHash:'invalid'}],Array.from({length:65},()=>({path:'Research/source.md',contentHash:'a'.repeat(64)}))])await assert.rejects(f.archive.save({id:'bad-'+contextSources.length,messages:[{...input[1],contextSources}]}),{code:'ARCHIVE_INVALID_DATA'});});
test('multi-turn Unicode conversation round-trips and produces readable Markdown plus metadata', async () => {
  const f = fixture(); const input = messages(); const saved = await f.archive.save({messages: input, title: 'Research conversation', scope: {mode: 'folders', include: ['Research'], exclude: ['Research/private'], tags: ['#research']}, selection: {route: 'openai', model: 'model-live', categoryId: 'cat-1', nodeIds: ['node-1'], indexId: 'index-1'}});
  assert.deepEqual({id: saved.id, turns: saved.turns, messageCount: saved.messageCount, createdAt: saved.createdAt, updatedAt: saved.updatedAt}, {id: 'conversation-1', turns: 2, messageCount: 4, createdAt: TIME, updatedAt: TIME});
  const loaded = await f.archive.load({path: saved.path}); assert.deepEqual(loaded.messages, input); assert.equal(loaded.selection.indexId, 'index-1'); assert.deepEqual(loaded.scope.tags, ['#research']);
  const note = f.contents.get(saved.path); assert.ok(note.startsWith('---\nnotework-conversation: true')); assert.ok(note.includes('## Turn 1 — You')); assert.ok(note.includes('## Turn 2 — AI')); assert.ok(note.includes('**Model:** model\\-live')); assert.ok(note.includes('[Research/source\\.md](<../../Research/source.md>)')); assert.deepEqual(await f.archive.list(), [saved]);
});
test('mobile keyword retrieval remains distinct from the saved vector index in archived evidence',async()=>{
  const f=fixture();const input=messages().slice(0,2);input[1].retrieval={indexId:'fixture-index',route:'lexical',indexRoute:'ollama',strategy:'lexical',matchedChunks:[],filters:{selectedNodeIds:null}};const saved=await f.archive.save({messages:input});const loaded=await f.archive.load({path:saved.path});assert.deepEqual(loaded.messages[1].retrieval,input[1].retrieval);const note=f.contents.get(saved.path);assert(note.includes('**indexRoute:** ollama'));assert(note.includes('**strategy:** lexical'));
});
test('quoted fences, HTML, forged archive comments and newline variants remain exact data, not active markup', async () => {
  const f = fixture(); const content = '---\r\nnotework-conversation: true\r\n---\n<!-- notework-conversation:end -->\n```json\n{"secret":"not-a-real-key"}\n```\n<script>alert(1)</script>\n![leak](https://example.test/collect)\n[[Unsafe|alias]]';
  const saved = await f.archive.save({messages: [{id: 'u', role: 'user', content, createdAt: TIME}], title: '</h1> [title]'}); const note = f.contents.get(saved.path);
  assert.equal((await f.archive.load({path: saved.path})).messages[0].content, content); assert.equal(note.split('<!-- notework-conversation:end -->').length, 2); assert.ok(!note.includes('<script>')); assert.ok(!note.includes('![leak](')); assert.ok(note.includes('&lt;script&gt;')); assert.ok(note.includes('\\[\\[Unsafe\\|alias\\]\\]'));
});
test('archive folder rejects absolute, traversal, hidden, invalid and alternate Windows paths before reading or writing', async () => {
  for (const folder of ['', '/', '/Chats', '../Chats', 'A/../Chats', './Chats', '.obsidian/Chats', 'A/.git', 'C:/Chats', 'C:Chats', '\\server\Chats', 'A\\Chats', 'A//Chats', 'A/Chats/', 'A/Chats\0', ' Chats', 'Chats ', 'A/NUL', 'A/CON.txt', 'A/Chats.', 'A/Chats:stream']) {
    const f = fixture(); await assert.rejects(f.archive.save({folder, messages: messages()}), error => error.code === 'ARCHIVE_INVALID_PATH'); assert.equal(f.calls.length, 0);
  }
  assert.equal(normalizeArchiveFolder(), 'Notework/Chats'); assert.equal(normalizeArchiveFolder('Knowledge/대화'), 'Knowledge/대화');
});
test('load checks exact folder boundaries and rejects unrelated or forged marker-only notes', async () => {
  const f = fixture(); await f.vault.create('Notework/Chats-copy/not.md', '---\nnotework-conversation: true\n---\nHello'); await f.vault.create('Notework/Chats/not.md', '# User note\n<!-- notework-conversation:end -->\n');
  await assert.rejects(f.archive.load({path: 'Notework/Chats-copy/not.md'}), {code: 'ARCHIVE_OUTSIDE_FOLDER'}); await assert.rejects(f.archive.load({path: 'Notework/Chats/not.md'}), {code: 'ARCHIVE_INVALID_NOTE'}); assert.deepEqual(await f.archive.list(), []);
});
test('partial write, truncated body, payload checksum error and manual metadata change are not valid history', async () => {
  const f = fixture(); const saved = await f.archive.save({messages: messages()}); const note = f.contents.get(saved.path);
  for (const broken of [note.slice(0, note.indexOf('## Turn')), note.slice(0, -10), note.replace(/data:v1:[a-f0-9]/, 'data:v1:z'), note.replace('title: "What', 'title: "Changed What'), note.replace('Here is the comparison', 'Externally changed answer')]) {
    f.contents.set(saved.path, broken); await assert.rejects(f.archive.load({path: saved.path}), {code: 'ARCHIVE_INVALID_NOTE'}); assert.deepEqual(await f.archive.list(), []);
  }
  f.contents.set(saved.path, note.replaceAll('\n', '\r\n')); assert.equal((await f.archive.load({path: saved.path})).turns, 2);
});
test('an unrelated colliding filename and a corrupt previous archive are never overwritten', async () => {
  const f = fixture(); const originalPath = 'Notework/Chats/2026-10-06-conversation-1.md'; await f.vault.create(originalPath, '# Keep this original');
  const saved = await f.archive.save({messages: messages()}); assert.notEqual(saved.path, originalPath); assert.equal(f.contents.get(originalPath), '# Keep this original');
  f.contents.set(saved.path, '# Corrupt record must be preserved'); const replacement = await f.archive.save({id: saved.id, messages: messages()}); assert.notEqual(replacement.path, saved.path); assert.equal(f.contents.get(saved.path), '# Corrupt record must be preserved');
});
test('existing ID safely updates only its owned file, keeps creation time, and serializes concurrent saves', async () => {
  let tick = 0; const f = fixture({clock: () => new Date(Date.parse(TIME) + tick++ * 1000)}); const first = await f.archive.save({messages: messages().slice(0, 2)});
  const [second, third] = await Promise.all([f.archive.save({id: first.id, messages: messages().slice(0, 3)}), f.archive.save({id: first.id, messages: messages()})]);
  assert.equal(first.path, second.path); assert.equal(second.path, third.path); assert.equal(third.createdAt, first.createdAt); assert.equal(third.updatedAt, '2026-10-06T12:34:58.000Z'); assert.equal((await f.archive.load({path: first.path})).messageCount, 4); assert.equal(f.calls.filter(call => call[0] === 'create').length, 1);
});
test('new conversations cannot overwrite an existing conversation even if the ID factory collides', async () => {
  const f = fixture(); const first = await f.archive.save({messages: messages().slice(0, 2)}); const before = f.contents.get(first.path); const second = await f.archive.save({messages: messages()});
  assert.notEqual(first.id, second.id); assert.notEqual(first.path, second.path); assert.equal(f.contents.get(first.path), before); assert.equal(second.id, 'conversation-1-2');
});
test('a create race preserves the intervening unrelated file and selects another filename', async () => {
  const f = fixture(); const create = f.vault.create; let raced = false; const originalPath = 'Notework/Chats/2026-10-06-conversation-1.md';
  f.vault.create = async (path, note) => {if (!raced) {raced = true; await create(path, '# Created by someone else'); throw new Error('Exists');} return create(path, note);};
  const saved = await f.archive.save({messages: messages()}); assert.notEqual(saved.path, originalPath); assert.equal(f.contents.get(originalPath), '# Created by someone else'); assert.equal((await f.archive.load({path: saved.path})).turns, 2);
});
test('ownership and content are revalidated inside atomic process before overwriting', async () => {
  const f = fixture(); const saved = await f.archive.save({messages: messages()}); const originalProcess = f.vault.process;
  f.vault.process = async (file, callback) => {f.contents.set(file.path, '# Unrelated note replaced this record'); return originalProcess(file, callback);};
  await assert.rejects(f.archive.save({id: saved.id, messages: messages()}), {code: 'ARCHIVE_INVALID_NOTE'}); assert.equal(f.contents.get(saved.path), '# Unrelated note replaced this record');
});
test('atomic update guard rejects another valid conversation ID or concurrent edits', async () => {
  const f = fixture(); const saved = await f.archive.save({messages: messages()}); const other = await f.archive.save({id: 'different-id', messages: messages(), title: 'Another conversation'}); const originalProcess = f.vault.process;
  f.vault.process = async (file, callback) => {f.contents.set(file.path, f.contents.get(other.path)); return originalProcess(file, callback);};
  await assert.rejects(f.archive.save({id: saved.id, messages: messages()}), error => ['ARCHIVE_INVALID_NOTE', 'ARCHIVE_CHANGED'].includes(error.code)); assert.equal(f.contents.get(saved.path), f.contents.get(other.path));
});
test('unsupported atomic updates fail without deleting or overwriting a saved record', async () => {
  const f = fixture(); const saved = await f.archive.save({messages: messages()}); const note = f.contents.get(saved.path); delete f.vault.process;
  await assert.rejects(f.archive.save({id: saved.id, messages: messages()}), {code: 'ARCHIVE_UNSAFE_UPDATE'}); assert.equal(f.contents.get(saved.path), note); assert.equal((await f.archive.load({path: saved.path})).id, saved.id);
});
test('a file blocking a folder causes a safe English error and remains unchanged', async () => {
  const f = fixture(); await f.vault.create('Notework', '# Keep'); await assert.rejects(f.archive.save({messages: messages()}), {code: 'ARCHIVE_FOLDER_BLOCKED'}); assert.equal(f.contents.get('Notework'), '# Keep');
});
test('list sorts by most recent update, obeys limit, and skips unreadable/unrelated records', async () => {
  let tick = 0; const f = fixture({clock: () => new Date(Date.parse(TIME) + tick++ * 1000)}); const a = await f.archive.save({id: 'a', messages: messages()}); const b = await f.archive.save({id: 'b', messages: messages()}); await f.vault.create('Notework/Chats/unrelated.md', '# Other note');
  assert.deepEqual((await f.archive.list({limit: 1})).map(item => item.id), ['b']); assert.deepEqual((await f.archive.list()).map(item => item.id), ['b', 'a']);
  f.contents.delete(b.path); assert.deepEqual((await f.archive.list()).map(item => item.id), ['a']); await assert.rejects(f.archive.list({limit: 0}), {code: 'ARCHIVE_INVALID_LIMIT'}); assert.ok(f.contents.has(a.path));
});
test('selection, chunk provenance, retrieval proof and typed filters survive while unknown provider settings never persist', async () => {
  const f = fixture(); const assistant = messages()[1]; assistant.apiKey = 'fixture-private-key'; assistant.cookie = 'fixture-cookie'; assistant.settings = {token: 'fixture-settings-token'};
  assistant.sources = [{path: 'Research/a[1]|label.md', text: 'x'.repeat(3000), id: 'source-1', chunkId: 'chunk-1', contentHash: 'a'.repeat(64), start: 1, end: 5, category: 'cat-1', score: .7, apiKey: 'fixture-source-key'}];
  assistant.retrieval = {indexId: 'index-1', route: 'embedding-api', embeddingModel: 'embedding-model', semanticRoute: 'openai', categoryId: 'cat-1', selectedNodeIds: ['node-1'], matchedChunks: [{id: 'chunk-1', path: 'Research/a[1]|label.md', contentHash: 'a'.repeat(64), start: 1, end: 5, score: .7, credentials: 'fixture-chunk-key'}], filters: {mode: 'folders', include: ['Research'], tags: ['#research'], categoryId: 'cat-1', providerKeys: 'fixture-filter-key'}, staleSkipped: 2, method: 'semantic', query: 'Evidence?', resultCount: 1, providerSettings: 'fixture-proof-key'};
  const saved = await f.archive.save({messages: [messages()[0], assistant], selection: {categoryId: 'cat-1', nodeIds: ['node-1'], indexId: 'index-1', route: 'openai', model: 'model-live', apiKey: 'fixture-selection-key'}, secrets: 'fixture-top-key', settings: 'fixture-top-settings'});
  const loaded = await f.archive.load({path: saved.path}); assert.equal(loaded.messages[1].sources[0].text.length, 2400); assert.equal(loaded.messages[1].sources[0].chunkId, 'chunk-1'); assert.deepEqual(loaded.messages[1].retrieval.matchedChunks[0], {id: 'chunk-1', contentHash: 'a'.repeat(64), path: 'Research/a[1]|label.md', start: 1, end: 5, score: .7}); assert.equal(loaded.messages[1].retrieval.staleSkipped, 2); assert.deepEqual(loaded.selection.nodeIds, ['node-1']);
  assert.ok(!JSON.stringify(loaded).includes('fixture-')); assert.ok(!f.contents.get(saved.path).includes('fixture-')); assert.ok(f.contents.get(saved.path).includes('a%5B1%5D%7Clabel.md')); assert.ok(!f.contents.get(saved.path).includes('[[Research/a[1]|label.md]]'));
});
test('numeric matched chunks work, invalid ranges/types/message IDs fail before writing', async () => {
  const f = fixture(); const valid = messages(); valid[1].retrieval = {matchedChunks: 6, method: 'lexical'}; const saved = await f.archive.save({messages: valid}); assert.equal((await f.archive.load({path: saved.path})).messages[1].retrieval.matchedChunks, 6);
  for (const change of [list => list[1].retrieval = {matchedChunks: -1}, list => list[1].retrieval = {filters: {tags: {token: 'bad'}}}, list => list[1].sources = [{path: '../outside.md'}], list => list[1].sources = [{path: 'Research/a.md', start: 10, end: 1}], list => list[1].role = 'system', list => list[1].content = 3, list => list[1].id = list[0].id]) {const input = messages(); change(input); await assert.rejects(f.archive.save({id: 'invalid', messages: input}), error => error.code.startsWith('ARCHIVE_'));}
  assert.equal(f.calls.filter(call => call[0] === 'create').length, 1);
});
test('finite signed similarity scores are preserved rather than rejecting negative cosine matches', async () => {
  const f = fixture(); const input = messages(); input[1].sources[0].score = -.2; input[1].retrieval = {matchedChunks: [{id: 'chunk-1', score: -.2}]};
  const saved = await f.archive.save({messages: input}); const loaded = await f.archive.load({path: saved.path}); assert.equal(loaded.messages[1].sources[0].score, -.2); assert.equal(loaded.messages[1].retrieval.matchedChunks[0].score, -.2);
});
test('engine retrieval proof and context signature reload exactly without persisting nested settings', async () => {
  const f = fixture(); const input = messages(); const scope = {mode: 'folders', include: ['Research'], exclude: [], tags: ['#research'], excludeTags: []};
  input[0].contextKey = JSON.stringify({scope, selection: {categoryId: 'cat-1', nodeIds: ['node-1']}});
  input[1].contextKey = input[0].contextKey;
  input[1].sources = [{path: 'Research/source.md', route: 'embedding-api', layer: 'chunk', title: 'Source note', text: 'Evidence'}];
  input[1].retrieval = {indexId: 'index-1', route: 'embedding-api', matchedChunks: 3, filters: {categoryId: 'cat-1', selectedNodeIds: ['node-1'], scope: {...scope, settings: {token: 'fixture-secret'}}}, validNotes: 4, invalidatedPaths: ['Research/stale.md'], graphExpanded: 1, settings: {token: 'fixture-extra'}};
  const saved = await f.archive.save({messages: input}); const loaded = await f.archive.load({path: saved.path});
  assert.equal(loaded.messages[0].contextKey, input[0].contextKey); assert.equal(loaded.messages[1].contextKey, input[0].contextKey); assert.deepEqual(loaded.messages[1].retrieval.filters.scope, scope); assert.equal(loaded.messages[1].retrieval.graphExpanded, 1); assert.equal(loaded.messages[1].retrieval.validNotes, 4); assert.deepEqual(loaded.messages[1].retrieval.invalidatedPaths, ['Research/stale.md']); assert.equal(loaded.messages[1].sources[0].title, 'Source note'); assert.ok(!f.contents.get(saved.path).includes('fixture-'));
});
test('actual unfiltered engine evidence preserves null filters and bounded model-judgment graph edges', async () => {
  const f = fixture(); const input = messages(); const scope = {mode: 'all', include: [], exclude: [], tags: [], excludeTags: []};
  input[1].retrieval = {indexId: 'index-1', route: 'lexical', matchedChunks: [{id: 'chunk-1', path: 'Research/source.md', score: -.01}], filters: {categoryId: null, selectedNodeIds: null, scope}, validNotes: 2, invalidatedPaths: [], graphExpanded: [{source: 'node-1', target: 'node-2', kind: 'supports', status: 'model-judgment', apiKey: 'fixture-dropped'}]};
  const saved = await f.archive.save({messages: input, selection: {categoryId: null, nodeIds: null}}); const loaded = await f.archive.load({path: saved.path});
  assert.deepEqual(loaded.messages[1].retrieval.filters, input[1].retrieval.filters); assert.deepEqual(loaded.messages[1].retrieval.graphExpanded, [{source: 'node-1', target: 'node-2', kind: 'supports', status: 'model-judgment'}]); assert.equal(loaded.selection.categoryId, null); assert.equal(loaded.selection.nodeIds, null);
  input[1].retrieval.graphExpanded = Array.from({length: 5}, () => ({kind: 'related'})); await assert.rejects(f.archive.save({messages: input}), {code: 'ARCHIVE_INVALID_DATA'});
});
test('full-scope graph selections over 500 nodes and long context signatures round-trip without truncation', async () => {
  const f = fixture();
  const nodeIds = Array.from({length: 801}, (_, i) => 'note_' + createHash('sha256').update(String(i)).digest('hex').slice(0, 20));
  const input = messages().slice(0, 2);
  const contextKey = JSON.stringify({scope: {mode: 'all'}, selectedNodeIds: nodeIds});
  assert.ok(contextKey.length > 20000);
  input[0].contextKey = contextKey; input[1].contextKey = contextKey;
  input[1].retrieval = {route: 'lexical', selectedNodeIds: nodeIds, filters: {selectedNodeIds: nodeIds}, matchedChunks: []};
  const saved = await f.archive.save({messages: input, selection: {nodeIds}});
  const loaded = await f.archive.load({path: saved.path});
  assert.deepEqual(loaded.selection.nodeIds, nodeIds);
  assert.deepEqual(loaded.messages[1].retrieval.selectedNodeIds, nodeIds);
  assert.deepEqual(loaded.messages[1].retrieval.filters.selectedNodeIds, nodeIds);
  assert.equal(loaded.messages[0].contextKey, contextKey);
  assert.equal(loaded.messages[1].contextKey, contextKey);
  assert.equal(loaded.selection.nodeIds.at(-1), nodeIds.at(-1));
});
test('large stale-source evidence and folder/tag scopes survive archive reload in full', async () => {
  const f = fixture();
  const scope = {mode: 'folders', include: [], exclude: [], tags: [], excludeTags: []};
  for (let i = 0; i < 601; i++) {
    scope.include.push('Research/' + i); scope.exclude.push('Private/' + i);
    scope.tags.push('#research/' + i); scope.excludeTags.push('#private/' + i);
  }
  const invalidatedPaths = Array.from({length: 1201}, (_, i) => 'Research/stale-' + i + '.md');
  const input = messages().slice(0, 2); input[1].retrieval = {route: 'lexical', filters: {scope}, invalidatedPaths};
  const saved = await f.archive.save({messages: input, scope});
  const loaded = await f.archive.load({path: saved.path});
  assert.deepEqual(loaded.scope, scope);
  assert.deepEqual(loaded.messages[1].retrieval.filters.scope, scope);
  assert.deepEqual(loaded.messages[1].retrieval.invalidatedPaths, invalidatedPaths);
});
test('large selection support keeps item validation and the complete archive byte limit', async () => {
  for (const change of [
    input => input.selection = {nodeIds: ['x'.repeat(1025)]},
    input => input.selection = {nodeIds: [null]},
    input => input.messages[0].retrieval = {filters: {selectedNodeIds: [7]}},
    input => input.messages[0].retrieval = {invalidatedPaths: ['../outside.md']},
    input => input.messages[0].retrieval = {invalidatedPaths: 'Research/stale.md'},
    input => input.scope = {include: ['x'.repeat(1025)]},
    input => input.messages[0].retrieval = {filters: {scope: {exclude: ['x'.repeat(1025)]}}},
  ]) {
    const f = fixture(); const input = {messages: [messages()[0]]}; change(input);
    await assert.rejects(f.archive.save(input), error => error.code.startsWith('ARCHIVE_'));
    assert.equal(f.calls.filter(call => call[0] === 'create').length, 0);
  }
  const f = fixture();
  const nodeIds = Array.from({length: 8300}, (_, i) => String(i).padStart(8, '0') + 'x'.repeat(1016));
  await assert.rejects(f.archive.save({messages: [messages()[0]], selection: {nodeIds}}), {code: 'ARCHIVE_TOO_LARGE'});
  assert.equal(f.calls.filter(call => call[0] === 'create').length, 0);
});
test('altering payload with a matching checksum cannot smuggle unknown fields or change owned ID inconsistently', async () => {
  const f = fixture(); const saved = await f.archive.save({messages: messages()}); const note = f.contents.get(saved.path);
  const mutated = note.replace(/data:v1:([a-f0-9]{64}):([A-Za-z0-9+/]+=*)/, (match, digest, encoded) => {const doc = JSON.parse(Buffer.from(encoded, 'base64').toString()); doc.settings = {apiKey: 'fixture-forged'}; const json = JSON.stringify(doc); return 'data:v1:' + createHash('sha256').update(json).digest('hex') + ':' + Buffer.from(json).toString('base64');});
  f.contents.set(saved.path, mutated); await assert.rejects(f.archive.load({path: saved.path}), {code: 'ARCHIVE_INVALID_NOTE'}); assert.deepEqual(await f.archive.list(), []);
});
test('duplicate valid IDs are not silently chosen for an update', async () => {
  const f = fixture(); const saved = await f.archive.save({messages: [{role: 'user', content: 'One question', createdAt: TIME}]}); const duplicate = saved.path.replace('.md', '-copy.md'); await f.vault.create(duplicate, f.contents.get(saved.path));
  await assert.rejects(f.archive.save({id: saved.id, messages: messages()}), {code: 'ARCHIVE_DUPLICATE_ID'});
});
test('queued saves snapshot their inputs and write failures expose no raw host/private text', async () => {
  const f = fixture(); const input = {messages: [{role: 'user', content: 'Original', createdAt: TIME}]}; const saving = f.archive.save(input); input.messages[0].content = 'Mutated later'; const saved = await saving; assert.equal((await f.archive.load({path: saved.path})).messages[0].content, 'Original');
  f.vault.create = async () => {throw new Error('provider token fixture-private');}; await assert.rejects(f.archive.save({id: 'cannot-save', messages: messages()}), error => error.code === 'ARCHIVE_SAVE_FAILED' && !error.message.includes('fixture-private'));
});
