// VENIA OS connector — OAuth 2.1 for Claude's custom connectors.
//
// Claude connects to a remote MCP server the standard way: it reads the
// protected-resource metadata, finds this authorization server, registers
// itself (dynamic client registration), sends the person here to sign in with
// PKCE, and swaps the code for tokens. This file is all of that, and nothing
// more.
//
// THE PASSWORD NEVER TOUCHES THIS FUNCTION. The sign-in page signs in to
// Supabase straight from the browser (exactly as the app does) and hands this
// function the resulting session. The function checks that session with
// Supabase, checks the person has VENIA access, seals it, and gives Claude its
// own opaque tokens. Claude never holds a Supabase token either.
//
// LIFETIMES. Codes 5 minutes, access tokens 1 hour, refresh tokens 30 days of
// disuse. Refresh tokens rotate on every use, like Supabase's own.
import {
  getJSON, putJSON, del, randomToken, sha256b64url, seal, unseal,
} from './store.js';
import { SB_URL, anonKey, getUser, hasVeniaAccess, refreshSession } from './supa.js';

const CODE_TTL = 5 * 60 * 1000;
const ACCESS_TTL = 60 * 60 * 1000;
const REFRESH_TTL = 30 * 24 * 60 * 60 * 1000;
export const SCOPE = 'venia';

// Only Claude's own callbacks may receive a code. Without this, anyone could
// register a client pointing at their own site and send a founder a sign-in
// link that hands the session to them. Override with MCP_ALLOWED_REDIRECTS
// (comma-separated) if Claude ever adds another callback.
const DEFAULT_REDIRECTS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
];
function allowedRedirects() {
  const extra = (process.env.MCP_ALLOWED_REDIRECTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return extra.length ? extra : DEFAULT_REDIRECTS;
}
export function redirectAllowed(uri) { return allowedRedirects().includes(String(uri || '')); }

export function origin(req) { return new URL(req.url).origin; }

const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
             'Access-Control-Allow-Origin': '*', ...extra },
});
const oauthError = (error, description, status = 400) => json({ error, error_description: description }, status);

// ── metadata ────────────────────────────────────────────────────────────────
export function protectedResourceMetadata(req) {
  const o = origin(req);
  return json({
    resource: o + '/mcp',
    authorization_servers: [o],
    bearer_methods_supported: ['header'],
    scopes_supported: [SCOPE],
    resource_name: 'VENIA OS',
  });
}
export function authServerMetadata(req) {
  const o = origin(req);
  return json({
    issuer: o,
    authorization_endpoint: o + '/oauth/authorize',
    token_endpoint: o + '/oauth/token',
    registration_endpoint: o + '/oauth/register',
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE],
  });
}

// ── dynamic client registration ─────────────────────────────────────────────
export async function register(req) {
  let body;
  try { body = await req.json(); } catch (_) { return oauthError('invalid_client_metadata', 'Body must be JSON'); }
  const uris = Array.isArray(body && body.redirect_uris) ? body.redirect_uris.map(String) : [];
  if (!uris.length) return oauthError('invalid_redirect_uri', 'redirect_uris is required');
  const bad = uris.filter((u) => !redirectAllowed(u));
  if (bad.length) return oauthError('invalid_redirect_uri', 'This connector only signs in to Claude');
  const clientId = 'vc_' + randomToken(18);
  const client = {
    client_id: clientId,
    client_name: String((body && body.client_name) || 'Claude').slice(0, 80),
    redirect_uris: uris,
    created: Date.now(),
  };
  await putJSON('client:' + clientId, client);
  return json({
    client_id: clientId,
    client_id_issued_at: Math.floor(client.created / 1000),
    client_name: client.client_name,
    redirect_uris: uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }, 201);
}

// ── authorize: the sign-in page ─────────────────────────────────────────────
function readAuthParams(sp) {
  return {
    client_id: sp.get('client_id') || '',
    redirect_uri: sp.get('redirect_uri') || '',
    response_type: sp.get('response_type') || '',
    state: sp.get('state') || '',
    code_challenge: sp.get('code_challenge') || '',
    code_challenge_method: sp.get('code_challenge_method') || '',
    scope: sp.get('scope') || SCOPE,
    resource: sp.get('resource') || '',
  };
}
async function checkAuthParams(p) {
  if (!p.client_id) return 'Missing client_id';
  const client = await getJSON('client:' + p.client_id);
  if (!client) return 'This sign-in link is not from a registered client. Start again from Claude.';
  if (!client.redirect_uris.includes(p.redirect_uri) || !redirectAllowed(p.redirect_uri)) return 'Unknown redirect_uri';
  if (p.response_type !== 'code') return 'response_type must be code';
  if (!p.code_challenge || p.code_challenge_method !== 'S256') return 'PKCE (S256) is required';
  return null;
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(title, inner, status = 200) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
  :root{--bg:#E8E4DA;--ink:#1a1916;--mid:#6b675e;--rule:#6E2A25}
  *{box-sizing:border-box} body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  background:var(--bg);color:var(--ink);font:16px/1.5 Georgia,"Times New Roman",serif;padding:24px}
  main{width:100%;max-width:380px;border-top:1px solid var(--rule);padding-top:28px}
  h1{font:600 13px/1 "Helvetica Neue",Helvetica,Arial,sans-serif;letter-spacing:.24em;text-transform:uppercase;margin:0 0 18px}
  p{margin:0 0 18px;color:var(--mid)} label{display:block;font:12px "Helvetica Neue",Helvetica,Arial,sans-serif;
  letter-spacing:.08em;text-transform:uppercase;margin:14px 0 6px}
  input{width:100%;padding:11px 12px;border:1px solid #b9b3a6;background:#f4f1ea;font:16px Georgia,serif;color:var(--ink)}
  button{margin-top:22px;width:100%;padding:12px;border:0;background:var(--ink);color:var(--bg);
  font:13px "Helvetica Neue",Helvetica,Arial,sans-serif;letter-spacing:.18em;text-transform:uppercase;cursor:pointer}
  button[disabled]{opacity:.5} .err{color:var(--rule);min-height:1.5em;margin-top:14px;font-size:14px}
</style></head><body><main>${inner}</main></body></html>`, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
               'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' },
  });
}

export async function authorizeGet(req) {
  const p = readAuthParams(new URL(req.url).searchParams);
  const problem = await checkAuthParams(p);
  if (problem) return page('VENIA OS', `<h1>VENIA OS</h1><p>${esc(problem)}</p>`, 400);
  if (!anonKey()) return page('VENIA OS', '<h1>VENIA OS</h1><p>The connector is not set up yet: SUPABASE_ANON_KEY is missing on this site.</p>', 503);
  const cfg = JSON.stringify({ sb: SB_URL, anon: anonKey(), params: p }).replace(/</g, '\\u003c');
  return page('Connect Claude to VENIA OS', `
<h1>VENIA OS</h1>
<p>Sign in to let Claude read VENIA OS as you and propose changes for you to approve in the app.</p>
<form id="f">
  <label for="e">Email</label><input id="e" type="email" autocomplete="username" required>
  <label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required>
  <button id="b" type="submit">Sign in and connect</button>
  <div class="err" id="err" role="alert"></div>
</form>
<script>
(function(){
  var CFG = ${cfg};
  var f = document.getElementById('f'), b = document.getElementById('b'), err = document.getElementById('err');
  f.addEventListener('submit', async function(ev){
    ev.preventDefault(); err.textContent = ''; b.disabled = true;
    try {
      // Straight to Supabase, as the app does. The password goes nowhere else.
      var r = await fetch(CFG.sb + '/auth/v1/token?grant_type=password', {
        method: 'POST', headers: { apikey: CFG.anon, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: document.getElementById('e').value.trim(), password: document.getElementById('pw').value })
      });
      var s = await r.json().catch(function(){ return {}; });
      if (!r.ok || !s.access_token) throw new Error(s.error_description || s.msg || 'That email and password did not sign in.');
      var r2 = await fetch('/oauth/authorize', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ params: CFG.params, access_token: s.access_token,
                               refresh_token: s.refresh_token, expires_in: s.expires_in })
      });
      var d = await r2.json().catch(function(){ return {}; });
      if (!r2.ok || !d.redirect) throw new Error(d.error_description || 'VENIA OS could not finish connecting.');
      window.location.replace(d.redirect);
    } catch (e) { err.textContent = e.message || String(e); b.disabled = false; }
  });
})();
</script>`);
}

export async function authorizePost(req) {
  let body;
  try { body = await req.json(); } catch (_) { return oauthError('invalid_request', 'Body must be JSON'); }
  const p = readAuthParams(new URLSearchParams(Object.entries((body && body.params) || {})));
  const problem = await checkAuthParams(p);
  if (problem) return oauthError('invalid_request', problem);
  const access = String((body && body.access_token) || '');
  const refresh = String((body && body.refresh_token) || '');
  if (!access || !refresh) return oauthError('access_denied', 'Sign in first');
  const user = await getUser(access);
  if (!user) return oauthError('access_denied', 'That sign-in was not accepted by VENIA OS.', 401);
  if (!(await hasVeniaAccess(access))) {
    return oauthError('access_denied', 'This account has no access to VENIA OS.', 403);
  }
  const code = randomToken(32);
  await putJSON('code:' + await sha256b64url(code), {
    client_id: p.client_id, redirect_uri: p.redirect_uri,
    code_challenge: p.code_challenge, scope: p.scope, resource: p.resource,
    email: String(user.email).toLowerCase(),
    sealed: await seal({ access, refresh, exp: Date.now() + (Number(body.expires_in) || 3600) * 1000 }),
    exp: Date.now() + CODE_TTL,
  });
  const u = new URL(p.redirect_uri);
  u.searchParams.set('code', code);
  if (p.state) u.searchParams.set('state', p.state);
  return json({ redirect: u.toString() });
}

// ── token ───────────────────────────────────────────────────────────────────
async function pkceOk(verifier, challenge) {
  if (!verifier || verifier.length < 43 || verifier.length > 128) return false;
  return (await sha256b64url(verifier)) === challenge;
}

async function issue(sid, email, clientId) {
  const accessToken = randomToken(32);
  const refreshToken = randomToken(32);
  await putJSON('at:' + await sha256b64url(accessToken), { sid, email, client_id: clientId, exp: Date.now() + ACCESS_TTL });
  await putJSON('rt:' + await sha256b64url(refreshToken), { sid, email, client_id: clientId, exp: Date.now() + REFRESH_TTL });
  return json({
    access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TTL / 1000,
    refresh_token: refreshToken, scope: SCOPE,
  });
}

export async function token(req) {
  let params;
  const ct = req.headers.get('content-type') || '';
  try {
    params = ct.includes('application/json')
      ? new URLSearchParams(Object.entries(await req.json()).map(([k, v]) => [k, String(v)]))
      : new URLSearchParams(await req.text());
  } catch (_) { return oauthError('invalid_request', 'Unreadable body'); }
  const grant = params.get('grant_type');
  const clientId = params.get('client_id') || '';

  if (grant === 'authorization_code') {
    const code = params.get('code') || '';
    const key = 'code:' + await sha256b64url(code);
    const rec = await getJSON(key);
    // A code works once. It is deleted before anything else can go wrong, so a
    // replay of the same code always fails even if this request does.
    await del(key);
    if (!rec) return oauthError('invalid_grant', 'Unknown or expired code');
    if (rec.client_id !== clientId) return oauthError('invalid_grant', 'Code was issued to another client');
    if (rec.redirect_uri !== (params.get('redirect_uri') || '')) return oauthError('invalid_grant', 'redirect_uri mismatch');
    if (!(await pkceOk(params.get('code_verifier') || '', rec.code_challenge))) return oauthError('invalid_grant', 'PKCE check failed');
    const sid = 's_' + randomToken(18);
    await putJSON('sess:' + sid, { email: rec.email, sealed: rec.sealed, client_id: clientId, created: Date.now(),
                                   exp: Date.now() + REFRESH_TTL });
    return issue(sid, rec.email, clientId);
  }

  if (grant === 'refresh_token') {
    const key = 'rt:' + await sha256b64url(params.get('refresh_token') || '');
    const rec = await getJSON(key);
    await del(key);                                   // rotate: every refresh token works once
    if (!rec) return oauthError('invalid_grant', 'Unknown or expired refresh token');
    if (clientId && rec.client_id !== clientId) return oauthError('invalid_grant', 'Token was issued to another client');
    const sess = await getJSON('sess:' + rec.sid);
    if (!sess) return oauthError('invalid_grant', 'This connection was signed out. Connect again.');
    sess.exp = Date.now() + REFRESH_TTL;
    await putJSON('sess:' + rec.sid, sess);
    return issue(rec.sid, rec.email, rec.client_id);
  }

  return oauthError('unsupported_grant_type', 'Use authorization_code or refresh_token');
}

// ── resolving a bearer token to a live Supabase session ─────────────────────
// Returns { email, access } or null. Refreshes the Supabase session when it is
// within a minute of expiring and stores the rotated refresh token at once.
export async function resolveBearer(req) {
  const h = req.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return null;
  const at = await getJSON('at:' + await sha256b64url(m[1].trim()));
  if (!at) return null;
  const sess = await getJSON('sess:' + at.sid);
  if (!sess) return null;
  let sb;
  try { sb = await unseal(sess.sealed); } catch (_) { return null; }
  if (!sb.exp || sb.exp < Date.now() + 60 * 1000) {
    const next = await refreshSession(sb.refresh);
    if (!next) { await del('sess:' + at.sid); return null; }   // revoked in Supabase: make them reconnect
    sb = next;
    sess.sealed = await seal(sb);
    await putJSON('sess:' + at.sid, sess);
  }
  return { email: at.email, access: sb.access, sid: at.sid };
}

export function unauthorized(req, description = 'Sign in to VENIA OS') {
  const o = origin(req);
  return new Response(JSON.stringify({ error: 'invalid_token', error_description: description }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': `Bearer realm="VENIA OS", resource_metadata="${o}/.well-known/oauth-protected-resource"`,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'WWW-Authenticate',
    },
  });
}
