import test from 'node:test';
import assert from 'node:assert/strict';
import {questionRelatedNodes, graphSelectionAction, graphPointerIntent, graphPointerCanPreview} from '../src/graph-focus.mjs';

const nodes = [
  {id: 'a', path: 'Notes/Alpha.md'},
  {id: 'b', path: 'Notes/Beta.md'},
  {id: 7, path: 'Other/Gamma.md'},
  {id: 'outside', path: 'Excluded/Private.md'},
];
const ids = list => list.map(node => node.id);

test('only-related view uses bounded evidence rather than every retrieval candidate', () => {
  const options = {enabled: true, sources: [{path: nodes[1].path}], candidateNotes: nodes.map(node => ({path: node.path}))};
  assert.deepEqual(ids(questionRelatedNodes(nodes, options)), ['b']);
  assert.deepEqual(ids(questionRelatedNodes(nodes, {...options, related: 'matches'})), ['a', 'b', 7, 'outside']);
  assert.deepEqual(ids(questionRelatedNodes(nodes, {...options, enabled: false})), ids(nodes));
});

test('each question replaces the visible result instead of accumulating previous notes', () => {
  const options = {enabled: true, sources: [{path: nodes[0].path}]};
  const first = questionRelatedNodes(nodes, options);
  const second = questionRelatedNodes(nodes, {...options, sources: [{path: nodes[1].path}]});
  assert.deepEqual(ids(first), ['a']);
  assert.deepEqual(ids(second), ['b']);
  assert.deepEqual(ids(questionRelatedNodes(nodes, {...options, sources: []})), []);
  assert.deepEqual(options.sources, [{path: nodes[0].path}]);
  assert.deepEqual(ids(nodes), ['a', 'b', 7, 'outside']);
});

test('new conversations and empty current results hide every star while the toggle stays enabled', () => {
  assert.deepEqual(questionRelatedNodes(nodes, {enabled: true}), []);
  assert.deepEqual(questionRelatedNodes(nodes, {enabled: true, sources: null, candidateNotes: null}), []);
  assert.deepEqual(questionRelatedNodes(nodes, {enabled: true, related: 'matches', sources: [], candidateNotes: []}), []);
  assert.deepEqual(questionRelatedNodes([], {enabled: true, sources: [{path: nodes[0].path}]}), []);
});

test('path references and validated numeric IDs map to existing nodes without duplicate stars', () => {
  const sources = [{id: 'active-note', path: 'Notes\\Beta.md'}, {id: '7'}, {path: nodes[1].path}, {id: 'unknown'}, {chunkId: 'unrelated'}];
  assert.deepEqual(ids(questionRelatedNodes(nodes, {enabled: true, sources})), ['b', 7]);
  assert.equal(questionRelatedNodes(nodes, {enabled: true, sources})[0], nodes[1]);
});

test('current scope excludes saved stars in both views and invalid paths cannot fall back to an ID', () => {
  const allowedPaths = new Set(['Notes/Alpha.md', 'Notes/Beta.md']);
  const sources = [{id: 'outside'}, {id: 7, path: nodes[2].path}, {id: 'a', path: '../Notes/Alpha.md'}, {id: 'a', path: 'C:/Notes/Alpha.md'}, {id: 'a', path: 'Missing.md'}, {path: nodes[1].path}];
  assert.deepEqual(ids(questionRelatedNodes(nodes, {enabled: true, sources, allowedPaths})), ['b']);
  assert.deepEqual(ids(questionRelatedNodes(nodes, {allowedPaths})), ['a', 'b']);
  assert.deepEqual(questionRelatedNodes(nodes, {allowedPaths: []}), []);
  assert.deepEqual(questionRelatedNodes(nodes, {enabled: true, sources: [{id: 'a'}], allowedPaths: []}), []);
});

test('preview and explicit pin actions stay separate from graph visibility', () => {
  assert.equal(graphSelectionAction('follow'), 'preview');
  assert.equal(graphSelectionAction('pinned'), 'selection');
  assert.equal(graphSelectionAction('all'), 'selection');
  // A pin candidate or preview ID is not a current source until retrieval returns it.
  const selection = {selectedNodeIds: ['a'], selectedNodesActive: true};
  assert.deepEqual(ids(questionRelatedNodes(nodes, {enabled: true, sources: [{path: nodes[1].path}], ...selection})), ['b']);
  assert.deepEqual(selection, {selectedNodeIds: ['a'], selectedNodesActive: true});
});

test('right mouse drag pans while left drag rotates and stationary left clicks may preview', () => {
  const right = {pointerType: 'mouse', button: 2};
  assert.equal(graphPointerIntent(right), 'pan');
  assert.equal(graphPointerIntent({pointerType: 'mouse', button: 0}), 'rotate');
  assert.equal(graphPointerIntent({pointerType: 'mouse', button: 0, altKey: true}), 'pan');
  assert.equal(graphPointerIntent({pointerType: 'mouse', button: 1}), null);
  assert.equal(graphPointerCanPreview({intent: graphPointerIntent(right), moved: false}), false);
  assert.equal(graphPointerCanPreview({intent: 'rotate', moved: false}), true);
  assert.equal(graphPointerCanPreview({intent: 'rotate', moved: true}), false);
});

test('touch still starts the existing gesture; right release and cancellation never select', () => {
  assert.equal(graphPointerIntent({pointerType: 'touch', button: 0}), 'rotate');
  assert.equal(graphPointerCanPreview({touch: true, moved: false}), true);
  assert.equal(graphPointerCanPreview({touch: true, moved: true}), false);
  assert.equal(graphPointerCanPreview({pan: true, moved: false}), false);
  assert.equal(graphPointerCanPreview({button: 2, moved: false}), false);
  assert.equal(graphPointerCanPreview({intent: 'rotate', moved: false}, {cancelled: true}), false);
  assert.equal(graphPointerCanPreview(null), false);
});
