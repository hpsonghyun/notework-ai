import {hasAsciiControl} from '../text-safety.mjs';
/** Validate only official sign-in destinations. Authorization URLs stay in memory. */
export function safeClaudeLoginUrl(value) {
  if (typeof value !== 'string' || hasAsciiControl(value,{includeSpace:true})) return null;
  let url; try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port) return null;
  const authorization = (url.hostname === 'claude.com' && url.pathname === '/cai/oauth/authorize') ||
    (['claude.ai', 'auth.claude.ai'].includes(url.hostname) && ['/oauth/authorize', '/authorize'].includes(url.pathname));
  const legacyLogin = ['claude.ai', 'auth.claude.ai'].includes(url.hostname) && url.pathname === '/login';
  if (!authorization && !legacyLogin) return null;
  for (const [key, entry] of url.searchParams) {
    // The official CLI sends code=true to request a login-code fallback. It is
    // a boolean switch, not the authorization code returned after sign-in.
    if (/^code$/i.test(key)) { if (!authorization || key !== 'code' || entry !== 'true') return null; }
    else if (/^(token|access_token|refresh_token|id_token|session|api_key|authorization)$/i.test(key)) return null;
  }
  return url.href;
}
