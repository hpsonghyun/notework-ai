import test from 'node:test';
import assert from 'node:assert/strict';
import {layoutConversationMap, CONVERSATION_PENDING_TOPIC} from '../src/conversation-layout.mjs';

function card(id, parentId = null, transition = parentId ? 'continue' : 'start', topicId = 'topic-a', contextKey = 'context-a') {
  return {id, title: 'Question ' + id, question: 'Exact question ' + id, answer: 'Exact answer ' + id, parentId, transition, transitionMethod: 'connected-llm', topicId, contextKey};
}
function map(cards) {
  return {cards, topics: [...new Set(cards.map(value => value.topicId))].map(id => ({id, title: 'Topic ' + id})), edges: cards.filter(value => value.parentId).map(value => ({source: value.parentId, target: value.id, relation: value.transition, method: value.transitionMethod}))};
}
const intersects = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
function verifyGeometry(layout) {
  for (const node of layout.nodes) {
    assert.ok([node.x, node.y, node.width, node.height].every(Number.isFinite));
    assert.ok(node.x >= 0 && node.y >= 0 && node.x + node.width <= layout.width && node.y + node.height <= layout.height);
    const group = layout.groups.find(value => value.id === node.groupId);
    assert.ok(node.x >= group.x && node.y >= group.y && node.x + node.width <= group.x + group.width && node.y + node.height <= group.y + group.height);
  }
  for (let i = 0; i < layout.nodes.length; i++) for (let j = i + 1; j < layout.nodes.length; j++) assert.equal(intersects(layout.nodes[i], layout.nodes[j]), false, layout.nodes[i].id + '/' + layout.nodes[j].id);
  for (let i = 0; i < layout.groups.length; i++) for (let j = i + 1; j < layout.groups.length; j++) assert.equal(intersects(layout.groups[i], layout.groups[j]), false);
  const ids = new Set(layout.nodes.map(node => node.id));
  for (const edge of layout.edges) {
    assert.ok(ids.has(edge.source) && ids.has(edge.target));
    assert.ok(edge.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)));
    const source = layout.nodes.find(node => node.id === edge.source), target = layout.nodes.find(node => node.id === edge.target);
    assert.deepEqual(edge.points[0], layout.direction === 'down' ? {x: source.x + source.width / 2, y: source.y + source.height} : {x: source.x + source.width, y: source.y + source.height / 2});
    assert.deepEqual(edge.points.at(-1), layout.direction === 'down' ? {x: target.x + target.width / 2, y: target.y} : {x: target.x, y: target.y + target.height / 2});
  }
}

test('AI branching and refinement form a spatial tree with separated siblings and readable topic regions', () => {
  const input = map([card('a'), card('b', 'a', 'refine'), card('c', 'a', 'branch'), card('d', 'b'), card('e', 'c'), card('f', 'c', 'refine'), card('g', 'c', 'branch', 'topic-b')]);
  const layout = layoutConversationMap(input), node = id => layout.nodes.find(value => value.id === id);
  assert.ok(node('b').x > node('a').x && node('d').x > node('b').x);
  assert.equal(node('b').x, node('c').x);
  assert.ok(node('b').y + node('b').height < node('c').y);
  assert.notEqual(node('e').y, node('f').y);
  assert.deepEqual(layout.edges.map(edge => edge.relation), ['refine', 'branch', 'continue', 'continue', 'refine', 'branch']);
  assert.equal(layout.groups.length, 2);
  assert.equal(layout.groups[1].title, 'Topic topic-b');
  assert.ok(layout.edges.find(edge => edge.target === 'g'));
  verifyGeometry(layout);
});

test('layout is deterministic, preserves chronology and quotes, and does not mutate frozen input', () => {
  const input = map([card('z'), card('a', 'z', 'refine'), card('b', 'z', 'branch')]);
  const before = JSON.stringify(input);
  for (const value of input.cards) Object.freeze(value);
  Object.freeze(input.cards); Object.freeze(input.edges); Object.freeze(input);
  const first = layoutConversationMap(input);
  assert.deepEqual(layoutConversationMap(JSON.parse(before)), first);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(first.nodes.map(node => node.id), ['z', 'a', 'b']);
  assert.deepEqual(first.nodes.map(node => node.order), [0, 1, 2]);
  assert.equal(first.nodes[1].card.question, 'Exact question a');
  assert.equal(first.nodes[1].card, input.cards[1]);
});

test('unclassified cards have no inferred semantic links even with misleading parent and edge fields', () => {
  const input = map([card('a'), {...card('b', 'a', 'refine'), transitionMethod: 'unclassified'}, {...card('c', 'a', 'unclear'), transitionMethod: 'unclassified'}]);
  input.edges.push({source: 'a', target: 'b', relation: 'refine', method: 'connected-llm'});
  const layout = layoutConversationMap(input);
  assert.equal(layout.nodes.length, 3); assert.equal(layout.edges.length, 0);
  assert.ok(layout.nodes.every(node => node.depth === 0));
  verifyGeometry(layout);
});

test('topic filtering omits invisible boundary endpoints while optional ancestors retain explicit relations', () => {
  const input = map([card('a'), card('b', 'a', 'refine'), card('c', 'b', 'branch', 'topic-b'), card('d', 'c', 'refine', 'topic-b')]);
  const filtered = layoutConversationMap(input, {topicId: 'topic-b'});
  assert.deepEqual(filtered.nodes.map(node => node.id), ['c', 'd']);
  assert.deepEqual(filtered.edges.map(edge => [edge.source, edge.target]), [['c', 'd']]);
  assert.deepEqual(filtered.nodes.map(node => node.depth), [2, 3]);
  assert.ok(filtered.nodes.every(node => !node.boundary));
  const ancestors = layoutConversationMap(input, {topicId: 'topic-b', includeAncestors: true});
  assert.deepEqual(ancestors.nodes.map(node => node.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ancestors.nodes.filter(node => node.boundary).map(node => node.id), ['a', 'b']);
  assert.equal(ancestors.edges.length, 3);
  assert.equal(ancestors.groups.length, 2);
  verifyGeometry(filtered); verifyGeometry(ancestors);
  assert.deepEqual(layoutConversationMap(input, {topicId: 'missing'}).nodes, []);
});

test('malformed, later, cyclic, contradictory and cross-context references cannot become edges', () => {
  const cards = [card('a', 'd'), card('b', 'a', 'refine', 'topic-a', 'other-context'), card('c', 'missing'), card('d', 'a'), card('e', 'd', 'branch')];
  const input = map(cards);
  input.edges.push({source: 'a', target: 'e', relation: 'branch', method: 'connected-llm'}, {source: 'd', target: 'e', relation: 'refine', method: 'connected-llm'}, null, {source: 'a', target: 'd', relation: 'continue', method: 'local'});
  const layout = layoutConversationMap(input);
  assert.deepEqual(layout.edges.map(edge => [edge.source, edge.target]), [['a', 'd'], ['d', 'e']]);
  assert.deepEqual(layout.nodes.map(node => node.depth), [0, 0, 0, 1, 2]);
  assert.equal(layout.groups.length, 2);
  assert.notEqual(layout.groups[0].id, layout.groups[1].id);
  verifyGeometry(layout);
});

test('duplicate IDs are omitted, duplicate edges deduplicate, and explicitly absent edges stay absent', () => {
  const input = map([card('a'), card('b', 'a'), card('duplicate'), card('duplicate')]);
  input.edges.push({...input.edges[0]});
  const layout = layoutConversationMap(input);
  assert.deepEqual(layout.nodes.map(node => node.id), ['a', 'b']);
  assert.equal(layout.edges.length, 1); assert.equal(layout.invalidCards, 2);
  assert.equal(layoutConversationMap({...input, edges: []}).edges.length, 0);
  const {edges, ...declarationsOnly} = input;
  assert.equal(layoutConversationMap(declarationsOnly).edges.length, 1);
});

test('200-card branching and chain layouts stay finite, bounded by their canvas, and nonoverlapping', () => {
  for (const direction of ['right', 'down']) for (const parent of [i => 'n' + Math.floor((i - 1) / 3), i => 'n' + (i - 1)]) {
    const input = map(Array.from({length: 200}, (_, i) => card('n' + i, i ? parent(i) : null, i ? i % 3 ? 'refine' : 'branch' : 'start')));
    const layout = layoutConversationMap(input, {direction});
    assert.equal(layout.nodes.length, 200); assert.equal(layout.edges.length, 199);
    assert.ok(Number.isFinite(layout.width) && Number.isFinite(layout.height));
    assert.equal(layout.omittedCards, 0);
    verifyGeometry(layout);
  }
});

test('downward trees grow vertically with branch siblings horizontally separated', () => {
  const input = map([card('a'), card('b', 'a', 'refine'), card('c', 'a', 'branch'), card('d', 'b'), card('e', 'c')]);
  const layout = layoutConversationMap(input, {direction: 'down', nodeWidth: 168, nodeHeight: 68}), node = id => layout.nodes.find(value => value.id === id);
  assert.equal(layout.direction, 'down');
  assert.ok(node('b').y > node('a').y && node('d').y > node('b').y);
  assert.equal(node('b').y, node('c').y);
  assert.ok(node('b').x + node('b').width < node('c').x);
  verifyGeometry(layout);
  assert.deepEqual(layoutConversationMap(input, {direction: 'down', nodeWidth: 168, nodeHeight: 68}), layout);
});

test('pending turns share one context region in a bounded two-column grid without invented topics or links', () => {
  const pending = Array.from({length: 11}, (_, i) => ({...card('p' + i, i ? 'p' + (i - 1) : null, 'unclear', 'provisional-topic-' + i), transitionMethod: 'unclassified'}));
  const input = map([...pending, {...card('other', null, 'unclear', 'provisional-other', 'context-b'), transitionMethod: 'unclassified'}, card('classified')]);
  const layout = layoutConversationMap(input, {direction: 'down', nodeWidth: 168, nodeHeight: 68});
  const region = layout.groups.find(group => group.topicId === CONVERSATION_PENDING_TOPIC);
  assert.equal(region.title, 'Awaiting AI structure'); assert.equal(region.pending, true);
  assert.deepEqual(region.nodeIds, pending.map(value => value.id));
  const turns = layout.nodes.filter(node => region.nodeIds.includes(node.id));
  assert.equal(new Set(turns.map(node => node.x)).size, 2);
  assert.equal(turns[0].y, turns[1].y); assert.ok(turns[2].y > turns[0].y);
  assert.ok(region.width <= 168 * 2 + 28 + 24 * 2);
  assert.equal(layout.edges.length, 0); assert.equal(layout.groups.length, 3);
  assert.ok(turns.every(node => node.depth === 0 && node.topicId === CONVERSATION_PENDING_TOPIC));
  const filtered = layoutConversationMap(input, {direction: 'down', topicId: CONVERSATION_PENDING_TOPIC});
  assert.equal(filtered.nodes.length, 12); assert.ok(filtered.groups.every(group => group.pending));
  verifyGeometry(layout); verifyGeometry(filtered);
  const right = layoutConversationMap(input, {direction: 'right', topicId: CONVERSATION_PENDING_TOPIC});
  assert.equal(new Set(right.nodes.slice(0, 11).map(node => node.x)).size, 1); verifyGeometry(right);
});

test('bounded budgets retain newest cards and safely omit dropped parents', () => {
  const input = map(Array.from({length: 201}, (_, i) => card('n' + i, i ? 'n' + (i - 1) : null)));
  const full = layoutConversationMap(input);
  assert.equal(full.nodes.length, 200); assert.equal(full.nodes[0].id, 'n1'); assert.equal(full.omittedCards, 1);
  assert.equal(full.nodes[0].depth, 0); assert.equal(full.edges.length, 199);
  const small = layoutConversationMap(input, {maxCards: 2});
  assert.deepEqual(small.nodes.map(node => node.id), ['n199', 'n200']);
  assert.equal(small.edges.length, 1); assert.equal(small.omittedCards, 199);
  assert.equal(layoutConversationMap(input, {maxCards: 0}).nodes.length, 0);
  for (const maxCards of [-1, 201, 1.5, NaN]) assert.throws(() => layoutConversationMap(input, {maxCards}), RangeError);
});

test('empty and malformed maps return empty geometry; custom dimensions remain checked', () => {
  for (const input of [null, {}, {cards: [null, {id: ''}]}]) {
    const layout = layoutConversationMap(input);
    assert.deepEqual(layout.nodes, []); assert.deepEqual(layout.edges, []); assert.deepEqual(layout.groups, []);
    assert.equal(layout.width, 0); assert.equal(layout.height, 0);
  }
  const layout = layoutConversationMap(map([card('a'), card('b', 'a')]), {nodeWidth: 240, nodeHeight: 90, columnGap: 100, rowGap: 40});
  assert.equal(layout.nodes[0].width, 240); assert.equal(layout.nodes[0].height, 90); verifyGeometry(layout);
  for (const options of [{nodeWidth: NaN}, {nodeHeight: Infinity}, {columnGap: -1}, {rowGap: 0}]) assert.throws(() => layoutConversationMap({}, options), RangeError);
  assert.throws(() => layoutConversationMap({}, {direction: 'sideways'}), TypeError);
});


test('wide view packs independent topics beside each other and keeps original branch endpoints', () => {
  const input = map([card('a'), card('b', 'a', 'refine'), card('c', 'a', 'branch'), card('d', 'b'), card('e', null, 'start', 'topic-b'), card('f', 'e', 'refine', 'topic-b')]);
  const base = layoutConversationMap(input, {direction:'down'});
  const wide = layoutConversationMap(input, {direction:'down',groupMaxWidth:1000});
  assert.equal(wide.groups[0].y, wide.groups[1].y);
  assert.ok(wide.groups[1].x > wide.groups[0].x + wide.groups[0].width);
  assert.ok(wide.height < base.height);
  assert.deepEqual(wide.edges.map(({source,target,relation})=>({source,target,relation})),base.edges.map(({source,target,relation})=>({source,target,relation})));
  verifyGeometry(wide);
});

test('narrow topic packing wraps without overlap or changing semantic links', () => {
  const input = map([card('a'),card('b','a','branch'),card('c',null,'start','topic-b'),card('d','c','refine','topic-b'),card('e',null,'start','topic-c')]);
  const narrow = layoutConversationMap(input,{direction:'down',groupMaxWidth:420});
  assert.equal(narrow.groups[0].x,narrow.groups[1].x);
  assert.ok(narrow.groups[1].y > narrow.groups[0].y+narrow.groups[0].height);
  assert.deepEqual(layoutConversationMap(input,{direction:'down',groupMaxWidth:420}),narrow);
  verifyGeometry(narrow);
  assert.throws(()=>layoutConversationMap(input,{groupMaxWidth:Infinity}),RangeError);
});
