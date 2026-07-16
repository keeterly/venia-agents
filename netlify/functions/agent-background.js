// Server-side delegate worker. The "-background" suffix makes Netlify return
// 202 to the caller immediately and let this run for up to 15 minutes — so the
// phone can queue a research job and go in a pocket (or the app can be closed)
// while the work happens here.
//
// Write-back happens WITHOUT a service-role key: the phone generates a per-job
// secret when it inserts the venia_agent_jobs row, hands it to us, and the
// venia_complete_agent_job RPC (SECURITY DEFINER) only accepts the update when
// the secret matches a still-queued row. The anon key below is the public
// client key that already ships in the app HTML — it grants nothing by itself.
const SB_URL = 'https://unxfaeqjskzzmhyrekqx.supabase.co';
const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVueGZhZXFqc2t6em1oeXJla3F4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4NDgxMTQsImV4cCI6MjA5MzQyNDExNH0.tqKiJJZE9iz29g9hIscLeMir4PhBMeTU8fbI04eC6xY';

const ALLOWED_ORIGINS = new Set([
  'https://creator.veniacollection.com',
  'https://venia-creator.netlify.app',
  'https://main--venia-creator.netlify.app',
]);
function originAllowed(req) {
  const o = req.headers.get('origin');
  if (o) return ALLOWED_ORIGINS.has(o);
  const site = (req.headers.get('sec-fetch-site') || '').toLowerCase();
  return site === 'same-origin' || site === 'same-site';
}

async function complete(id, secret, status, result) {
  try {
    await fetch(SB_URL + '/rest/v1/rpc/venia_complete_agent_job', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SB_ANON,
        Authorization: 'Bearer ' + SB_ANON,
      },
      body: JSON.stringify({ p_id: id, p_secret: secret, p_status: status, p_result: result }),
    });
  } catch (_) { /* the app's 16-minute stale sweep is the backstop */ }
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('', { status: 405 });
  if (!originAllowed(req)) return new Response('', { status: 403 });

  let p;
  try { p = JSON.parse(await req.text()); } catch (_) { return new Response('', { status: 400 }); }
  const { id, secret, sys, q } = p || {};
  if (!id || !secret || !q) return new Response('', { status: 400 });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { await complete(id, secret, 'error', 'ANTHROPIC_API_KEY is not set'); return new Response('', { status: 500 }); }

  const attempt = async (tools) => {
    const body = {
      model: 'claude-sonnet-5',
      max_tokens: 4096,
      system: String(sys || ''),
      messages: [{ role: 'user', content: String(q) }],
      ...(tools ? { tools } : {}),
    };
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      let d = 'HTTP ' + r.status;
      try { const e = await r.json(); if (e && e.error && e.error.message) d = e.error.message; } catch (_) {}
      throw new Error(d);
    }
    const data = await r.json();
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (!text) throw new Error('empty reply');
    return text;
  };

  let out = null, err = null;
  try { out = await attempt([{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }]); }
  catch (e1) {
    try { out = await attempt([{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]); }
    catch (e2) {
      try { out = await attempt(null); } catch (e3) { err = e3; }
    }
  }
  await complete(id, secret, out ? 'done' : 'error', out || String((err && err.message) || 'failed'));
  return new Response('', { status: 200 });
};
