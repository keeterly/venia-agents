// VENIA OS connector — talking to Supabase AS THE SIGNED-IN PERSON.
//
// There is no service-role key anywhere in this connector. Every request goes
// out with the public anon key plus the person's own access token, so Postgres
// sees exactly who it would see in the app: the same RLS, the same module
// grants, the same venia_agent_policy switch. The connector can never read or
// write anything its user could not reach by hand.
//
// SUPABASE_ANON_KEY is the PUBLIC client key (the one the app's HTML already
// ships). It is read from the environment rather than written here so that no
// key of any kind lives in this public repository.
export const SB_URL = (process.env.SUPABASE_URL || 'https://unxfaeqjskzzmhyrekqx.supabase.co').replace(/\/+$/, '');
export function anonKey() { return process.env.SUPABASE_ANON_KEY || ''; }
export const WS_ID = 'main';

async function sbFetch(path, { method = 'GET', token, body, headers = {} } = {}) {
  const r = await fetch(SB_URL + path, {
    method,
    headers: {
      apikey: anonKey(),
      Authorization: 'Bearer ' + (token || anonKey()),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  return { ok: r.ok, status: r.status, data };
}

// ── auth ────────────────────────────────────────────────────────────────────
// Who does this access token belong to? Supabase answers only for a live,
// unrevoked session, so this doubles as the check that the sign-in is real.
export async function getUser(accessToken) {
  const r = await sbFetch('/auth/v1/user', { token: accessToken });
  return r.ok && r.data && r.data.email ? r.data : null;
}

// Swap a refresh token for a fresh session. Supabase ROTATES refresh tokens:
// the old one stops working shortly after use, so the caller must store the
// new one straight away.
export async function refreshSession(refreshToken) {
  const r = await sbFetch('/auth/v1/token?grant_type=refresh_token', {
    method: 'POST', body: { refresh_token: refreshToken },
  });
  if (!r.ok || !r.data || !r.data.access_token) return null;
  return {
    access: r.data.access_token,
    refresh: r.data.refresh_token,
    exp: Date.now() + (Number(r.data.expires_in) || 3600) * 1000,
  };
}

// Does this person have any access to the workspace at all? The same question
// every RLS policy asks, via the same SECURITY DEFINER helpers.
export async function hasVeniaAccess(accessToken) {
  const [founder, access] = await Promise.all([
    sbFetch('/rest/v1/rpc/venia_is_founder', { method: 'POST', token: accessToken, body: {} }),
    sbFetch('/rest/v1/rpc/venia_has_access', { method: 'POST', token: accessToken, body: {} }),
  ]);
  return (founder.ok && founder.data === true) || (access.ok && access.data === true);
}

// ── the workspace ───────────────────────────────────────────────────────────
// One row per module. RLS returns only the rows this person may read, so a
// missing module simply means "not yours", never an error.
export async function readModules(accessToken) {
  const r = await sbFetch('/rest/v1/venia_module_data?workspace_id=eq.' + WS_ID
    + '&select=module,data,updated_at', { token: accessToken });
  if (!r.ok) throw new Error('Could not read VENIA OS (HTTP ' + r.status + ')');
  const out = {};
  (Array.isArray(r.data) ? r.data : []).forEach((row) => { out[row.module] = row; });
  return out;
}

// File a proposed change into the inbox. RLS decides whether it lands: the row
// must carry the caller's own email, they must have access, and the assistant
// must not be switched off for them.
export async function queueAction(accessToken, email, action, summary) {
  const r = await sbFetch('/rest/v1/venia_claude_inbox', {
    method: 'POST', token: accessToken,
    headers: { Prefer: 'return=representation' },
    body: { email, action, summary: String(summary || '').slice(0, 300), source: 'claude-connector' },
  });
  if (!r.ok) {
    const msg = (r.data && (r.data.message || r.data.hint)) || ('HTTP ' + r.status);
    throw new Error('VENIA OS did not accept the change: ' + msg);
  }
  return Array.isArray(r.data) ? r.data[0] : r.data;
}

export async function listInbox(accessToken, email, status) {
  const q = '/rest/v1/venia_claude_inbox?select=id,summary,status,created_at,decided_at,action'
    + '&email=eq.' + encodeURIComponent(email)
    + (status ? '&status=eq.' + encodeURIComponent(status) : '')
    + '&order=created_at.desc&limit=25';
  const r = await sbFetch(q, { token: accessToken });
  if (!r.ok) throw new Error('Could not read the inbox (HTTP ' + r.status + ')');
  return Array.isArray(r.data) ? r.data : [];
}
