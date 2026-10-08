import {hasAsciiControl} from '../text-safety.mjs';
// Public authorization addresses supplied by the official Codex runtime.
// This module stays portable; the controller must not import desktop Node APIs.
export function safeCodexLoginUrl(value) {
  if (typeof value !== 'string' || value.length > 16384 || (hasAsciiControl(value,{includeSpace:true})||value.includes(String.fromCharCode(92)))) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return '';
    const routes = url.hostname === 'auth.openai.com' ? ['/oauth/authorize', '/api/accounts/authorize'] : url.hostname === 'chatgpt.com' ? ['/auth/login', '/auth/authorize', '/codex/login', '/codex/authorize'] : [];
    return routes.includes(url.pathname) ? url.href : '';
  } catch { return ''; }
}
