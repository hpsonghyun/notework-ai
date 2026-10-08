/** Graph visibility is a projection of the current retrieval result, never chat selection. */
function notePath(value) {
  if (typeof value !== 'string') return null;
  const path = value.trim().replace(/\\/g, '/');
  if (!path || path.startsWith('/') || /^[a-z]:/i.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) return null;
  return path;
}

/**
 * Keep only current question references when enabled. Candidate matches are optional;
 * evidence is the smaller default set actually sent for the current answer. Scope
 * remains authoritative in either view. The caller supplies each new result afresh:
 * empty results and a new conversation therefore expose no stale stars.
 *
 * Path identity takes precedence over retrieval IDs (open-note IDs can differ).
 * An invalid/out-of-scope explicit path must never fall back to an otherwise valid ID.
 */
export function questionRelatedNodes(nodes, {enabled = false, sources = [], candidateNotes = [], related = 'evidence', allowedPaths} = {}) {
  const scope = allowedPaths == null ? null : new Set(Array.from(allowedPaths, notePath).filter(Boolean));
  const eligible = (Array.isArray(nodes) ? nodes : []).filter(node => {
    const path = notePath(node?.path);
    return path && (!scope || scope.has(path));
  });
  if (!enabled) return eligible;
  const byPath = new Map(eligible.map(node => [notePath(node.path), node]));
  const byId = new Map(eligible.filter(node => node.id != null).map(node => [String(node.id), node]));
  const references = Array.isArray(sources) ? [...sources] : [];
  if (related === 'matches' && Array.isArray(candidateNotes)) references.push(...candidateNotes);
  const selected = new Set();
  for (const reference of references) {
    if (!reference || typeof reference !== 'object') continue;
    const node = reference.path != null
      ? byPath.get(notePath(reference.path))
      : reference.id != null ? byId.get(String(reference.id)) : null;
    if (node) selected.add(node);
  }
  return eligible.filter(node => selected.has(node));
}

/** Previewing a following graph does not pin or change the next answer's retrieval. */
export function graphSelectionAction(mode) {
  return mode === 'follow' ? 'preview' : 'selection';
}

/** Mouse right drag pans; touch remains available for the existing pinch/pan gesture. */
export function graphPointerIntent(event = {}) {
  if (event.pointerType === 'touch') return 'rotate';
  if (event.button === 2 && (!event.pointerType || event.pointerType === 'mouse')) return 'pan';
  if ((event.button ?? 0) !== 0) return null;
  return event.altKey ? 'pan' : 'rotate';
}

/** A stationary pan/right click and a cancelled gesture never choose a note. */
export function graphPointerCanPreview(drag, {cancelled = false} = {}) {
  return !!drag && !cancelled && !drag.moved && drag.intent !== 'pan' && drag.pan !== true && drag.button !== 2;
}
