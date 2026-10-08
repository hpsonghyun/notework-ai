import {hasAsciiControl} from './text-safety.mjs';
const RELATIONS = new Set(['refine', 'branch', 'continue']);
export const CONVERSATION_PENDING_TOPIC = 'pending';
const validId = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 4096 && !hasAsciiControl(value);
const validContext = value => value == null || typeof value === 'string';
const contextOf = card => card.contextKey ?? null;

function dimension(value, fallback, min, max) {
  const result = value === undefined ? fallback : value;
  if (!Number.isFinite(result) || result < min || result > max) throw new RangeError('Use finite, bounded conversation layout dimensions.');
  return result;
}

/**
 * Deterministic topic regions containing left-to-right AI parent trees. Card text
 * is retained exactly; grouping and edges come only from supplied structure.
 * A topic filter hides boundary edges unless both endpoints are included. Explicit
 * includeAncestors adds validated parent cards with boundary:true for inspection.
 * No inference, network calls, dependencies, or changes to the input occur here.
 */
export function layoutConversationMap(map, options = {}) {
  const {topicId = 'all', includeAncestors = false, maxCards = 200, direction = 'right'} = options;
  if (!['right', 'down'].includes(direction)) throw new TypeError('Use right or down for the conversation layout direction.');
  if (!Number.isSafeInteger(maxCards) || maxCards < 0 || maxCards > 200) throw new RangeError('Conversation layouts support at most 200 cards.');
  const nodeWidth = dimension(options.nodeWidth, 200, 80, 600);
  const nodeHeight = dimension(options.nodeHeight, 72, 40, 300);
  const columnGap = dimension(options.columnGap, 76, 16, 300);
  const rowGap = dimension(options.rowGap, 28, 8, 200);
  const groupGap = dimension(options.groupGap, 40, 8, 300);
  const padding = dimension(options.padding, 24, 8, 100);
  const headerHeight = dimension(options.headerHeight, 32, 20, 100);
  const groupMaxWidth = options.groupMaxWidth === undefined ? null : dimension(options.groupMaxWidth, 1000, 80, 1000000);
  const input = Array.isArray(map?.cards) ? map.cards : [];
  const counts = new Map();
  for (const card of input) if (validId(card?.id)) counts.set(card.id, (counts.get(card.id) || 0) + 1);
  const unique = input.map((card, order) => ({card, order})).filter(({card}) => validId(card?.id) && counts.get(card.id) === 1);
  const retained = maxCards ? unique.slice(-maxCards) : [];
  const byId = new Map(retained.map(item => [item.card.id, item]));
  const declarations = retained.filter(({card}) => card.parentId).map(({card}) => ({source: card.parentId, target: card.id, relation: card.transition, method: card.transitionMethod}));
  const suppliedEdges = Array.isArray(map?.edges) ? map.edges : declarations;
  const parents = new Map();
  const validEdges = [];
  for (const edge of suppliedEdges) {
    const source = byId.get(edge?.source), target = byId.get(edge?.target);
    if (!source || !target || source.order >= target.order || edge.method !== 'connected-llm' || !RELATIONS.has(edge.relation)) continue;
    if (source.card.transitionMethod !== 'connected-llm' || target.card.transitionMethod !== 'connected-llm' || target.card.parentId !== source.card.id || target.card.transition !== edge.relation) continue;
    if (!validContext(source.card.contextKey) || !validContext(target.card.contextKey) || contextOf(source.card) !== contextOf(target.card)) continue;
    if (parents.has(target.card.id)) continue;
    parents.set(target.card.id, source.card.id);
    validEdges.push({id: 'layout-edge:' + encodeURIComponent(source.card.id) + ':' + encodeURIComponent(target.card.id), source: source.card.id, target: target.card.id, relation: edge.relation, method: 'connected-llm'});
  }
  validEdges.sort((a, b) => byId.get(a.target).order - byId.get(b.target).order);
  const topicOf = card => card.transitionMethod === 'connected-llm' && validId(card.topicId) ? card.topicId : CONVERSATION_PENDING_TOPIC;
  const visibleIds = new Set(retained.filter(({card}) => topicId === 'all' || topicOf(card) === topicId).map(({card}) => card.id));
  if (includeAncestors && topicId !== 'all') {
    for (const id of [...visibleIds]) {
      let parent = parents.get(id);
      while (parent) {visibleIds.add(parent); parent = parents.get(parent);}
    }
  }
  const visible = retained.filter(({card}) => visibleIds.has(card.id));
  const depths = new Map();
  // Parent order is strictly earlier, so this pass cannot introduce cycles.
  for (const {card} of retained) depths.set(card.id, parents.has(card.id) ? depths.get(parents.get(card.id)) + 1 : 0);
  const groups = [], groupLookup = new Map();
  for (const item of visible) {
    const id = topicOf(item.card), context = contextOf(item.card);
    if (!groupLookup.has(id)) groupLookup.set(id, new Map());
    const contexts = groupLookup.get(id);
    if (!contexts.has(context)) {
      const topic = (Array.isArray(map?.topics) ? map.topics : []).find(value => value?.id === id && (value.contextKey === undefined || (value.contextKey ?? null) === context));
      const pending = id === CONVERSATION_PENDING_TOPIC;
      const title = pending ? 'Awaiting AI structure' : typeof topic?.title === 'string' && topic.title.trim() ? topic.title : 'AI topic';
      const group = {id: 'layout-group:' + encodeURIComponent(id) + ':' + contexts.size, topicId: id, title, pending, x: padding, y: 0, width: 0, height: 0, nodeIds: [], items: []};
      groups.push(group); contexts.set(context, group);
    }
    const group = contexts.get(context); group.items.push(item); group.nodeIds.push(item.card.id);
  }
  const nodes = [], positions = new Map();
  let nextY = padding;
  for (const group of groups) {
    group.y = nextY;
    const memberIds = new Set(group.nodeIds), children = new Map(group.nodeIds.map(id => [id, []]));
    for (const id of group.nodeIds) if (memberIds.has(parents.get(id))) children.get(parents.get(id)).push(id);
    const roots = group.nodeIds.filter(id => !memberIds.has(parents.get(id)));
    const leaves = new Map();
    const measure = id => {const next = children.get(id); const count = next.length ? next.reduce((sum, child) => sum + measure(child), 0) : 1; leaves.set(id, count); return count;};
    for (const root of roots) measure(root);
    const rows = new Map();
    const place = (id, firstRow) => {
      rows.set(id, firstRow + (leaves.get(id) - 1) / 2);
      let row = firstRow;
      for (const child of children.get(id)) {place(child, row); row += leaves.get(child);}
    };
    let rowCount = 0;
    for (const root of roots) {place(root, rowCount); rowCount += leaves.get(root);}
    for (const [slot, {card, order}] of group.items.entries()) {
      const depth = depths.get(card.id);
      const column = group.pending ? direction === 'down' ? slot % 2 : 0 : direction === 'down' ? rows.get(card.id) : depth;
      const row = group.pending ? direction === 'down' ? Math.floor(slot / 2) : slot : direction === 'down' ? depth : rows.get(card.id);
      const xGap = direction === 'down' ? rowGap : columnGap;
      const yGap = direction === 'down' && !group.pending ? columnGap : rowGap;
      const node = {id: card.id, card, x: group.x + padding + column * (nodeWidth + xGap), y: group.y + padding + headerHeight + row * (nodeHeight + yGap), width: nodeWidth, height: nodeHeight, topicId: group.topicId, groupId: group.id, depth, order, boundary: topicId !== 'all' && group.topicId !== topicId};
      nodes.push(node); positions.set(node.id, node);
    }
    group.width = Math.max(...group.nodeIds.map(id => positions.get(id).x + nodeWidth)) - group.x + padding;
    group.height = Math.max(...group.nodeIds.map(id => positions.get(id).y + nodeHeight)) - group.y + padding;
    nextY += group.height + groupGap;
    delete group.items;
  }
  // Pack independent topic regions across the available viewport width. Their
  // internal tree geometry and semantic parent relationships stay unchanged.
  if (groupMaxWidth !== null) {
    let x = padding, y = padding, rowHeight = 0;
    for (const group of groups) {
      if (x > padding && x + group.width + padding > groupMaxWidth) { x = padding; y += rowHeight + groupGap; rowHeight = 0; }
      const dx = x - group.x, dy = y - group.y;
      group.x = x; group.y = y;
      for (const id of group.nodeIds) { const node = positions.get(id); node.x += dx; node.y += dy; }
      x += group.width + groupGap; rowHeight = Math.max(rowHeight, group.height);
    }
  }
  nodes.sort((a, b) => a.order - b.order);
  const edges = validEdges.filter(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target)).map(edge => {
    const source = positions.get(edge.source), target = positions.get(edge.target);
    const start = direction === 'down' ? {x: source.x + source.width / 2, y: source.y + source.height} : {x: source.x + source.width, y: source.y + source.height / 2};
    const end = direction === 'down' ? {x: target.x + target.width / 2, y: target.y} : {x: target.x, y: target.y + target.height / 2};
    const middle = direction === 'down' ? (start.y + end.y) / 2 : (start.x + end.x) / 2;
    const points = direction === 'down' ? [start, {x: start.x, y: middle}, {x: end.x, y: middle}, end] : [start, {x: middle, y: start.y}, {x: middle, y: end.y}, end];
    return {...edge, points, path: points.map((point, index) => (index ? 'L' : 'M') + point.x + ',' + point.y).join(' ')};
  });
  const width = groups.length ? Math.max(...groups.map(group => group.x + group.width)) + padding : 0;
  const height = groups.length ? Math.max(...groups.map(group => group.y + group.height)) + padding : 0;
  return {nodes, edges, groups, width, height, direction, omittedCards: input.length - retained.length, invalidCards: input.length - unique.length};
}
