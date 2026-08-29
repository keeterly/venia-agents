import webpush from 'web-push';

// CFO CHAT, CLOUD-SIDE. A streaming reply over a flaky phone connection dies
// mid-generation and surfaces as 504s / "no connection" — so when the direct
// path fails, the app queues the SAME turn here instead. This is a
// "-background" function: Netlify answers 202 instantly and gives the work up
// to 15 minutes, so the founder can pocket the phone or close the app; the
// reply lands in the job row and a push says it's ready.
// Write-back is the same secret-scoped RPC as the other workers — no
// service-role key anywhere.
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
      headers: { 'Content-Type': 'application/json', apikey: SB_ANON, Authorization: 'Bearer ' + SB_ANON },
      body: JSON.stringify({ p_id: id, p_secret: secret, p_status: status, p_result: result }),
    });
  } catch (_) { /* the client's stale sweep is the backstop */ }
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('', { status: 405 });
  if (!originAllowed(req)) return new Response('', { status: 403 });

  // Enforce-if-configured, like the Claude relay: the phone's fetch wrapper
  // attaches the access code automatically.
  const gateHash = (process.env.VENIA_GATE_HASH || process.env.STRIPE_GATE_HASH || '').toLowerCase();
  if (gateHash) {
    const sent = req.headers.get('x-venia-code') || '';
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sent));
    const hex = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
    if (!sent || hex !== gateHash) return new Response('', { status: 401 });
  }

  let p;
  try { p = JSON.parse(await req.text()); } catch (_) { return new Response('', { status: 400 }); }
  const { id, secret, system, messages } = p || {};
  if (!id || !secret || !Array.isArray(messages) || !messages.length) return new Response('', { status: 400 });
  const pushSubs = Array.isArray(p.push) ? p.push.slice(0, 12) : [];

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { await complete(id, secret, 'error', 'ANTHROPIC_API_KEY is not set'); return new Response('', { status: 500 }); }

  // System arrives as the same array of blocks the app sends its relay;
  // messages carry the chat history including the new user turn.
  const sysBlocks = (Array.isArray(system) ? system : [system])
    .filter((s) => s && String(s).trim())
    .map((s) => ({ type: 'text', text: String(s).slice(0, 100000) }));
  // NORMALIZE the conversation before it reaches the API. A history that
  // begins with an assistant turn, carries two of the same role in a row, or
  // ends on an assistant turn is rejected outright ("does not support
  // assistant message prefill"), losing the founder's question. The client can
  // legitimately produce any of those — a failed turn that never got its
  // reply, two questions sent before the first came back, a reply applied on
  // the other phone — so the worker repairs the shape rather than trusting it.
  const raw = messages.slice(-40).map((m) => {
    const role = m && m.role === 'assistant' ? 'assistant' : 'user';
    // A user turn can carry content BLOCKS (text + image) when a screenshot
    // rode the send. String() on those yields "[object Object]" — the picture
    // is thrown away and the model is handed nonsense — so blocks pass through.
    if (m && Array.isArray(m.content)) {
      const blocks = m.content
        .filter((b) => b && (b.type === 'text' || b.type === 'image'))
        .slice(0, 12);
      return blocks.length ? { role, content: blocks } : null;
    }
    const t = String((m && m.content) || '').trim().slice(0, 40000);
    return t ? { role, content: t } : null;
  }).filter(Boolean);
  const asBlocks = (c) => (Array.isArray(c) ? c : [{ type: 'text', text: c }]);
  const msgs = [];
  raw.forEach((m) => {
    if (!msgs.length && m.role !== 'user') return;              // must open on a user turn
    const last = msgs[msgs.length - 1];
    if (last && last.role === m.role) {                         // no doubles
      if (Array.isArray(last.content) || Array.isArray(m.content)) {
        last.content = asBlocks(last.content).concat(asBlocks(m.content));
      } else last.content += '\n\n' + m.content;
      return;
    }
    msgs.push(m);
  });
  while (msgs.length && msgs[msgs.length - 1].role !== 'user') msgs.pop();   // must close on a user turn
  if (!msgs.length) { await complete(id, secret, 'error', 'no usable conversation to send'); return new Response('', { status: 200 }); }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16384, system: sysBlocks, messages: msgs }),
    });
    if (!r.ok) {
      let d = 'HTTP ' + r.status;
      try { const e = await r.json(); if (e && e.error && e.error.message) d = e.error.message; } catch (_) {}
      throw new Error(d);
    }
    const data = await r.json();
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (!text) throw new Error('empty reply');
    await complete(id, secret, 'done', text);
    // WHO TO PUSH IS THE SERVER'S QUESTION, NOT THE BROWSER'S. This used to
    // send only to the list the client attached, read from venia_push_subs in
    // the page. That read is behind RLS and every failure of it was swallowed
    // — not signed in yet, a transient error, a tab that never authenticated —
    // and an empty list means no push, silently. The scheduled digest has
    // always fetched its own subscribers through the secret-scoped RPC; this
    // now does the same, and falls back to the client's list only if that
    // fetch fails outright.
    let subs = [];
    if (process.env.VENIA_DIGEST_SECRET) {
      try {
        const sr = await fetch(SB_URL + '/rest/v1/rpc/venia_digest_fetch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: SB_ANON, Authorization: 'Bearer ' + SB_ANON },
          body: JSON.stringify({ p_secret: process.env.VENIA_DIGEST_SECRET }),
        });
        const sp = await sr.json();
        if (sp && !sp.error && Array.isArray(sp.subs)) subs = sp.subs;
      } catch (_) { /* fall through to the client's list */ }
    }
    if (!subs.length) subs = pushSubs;
    subs = subs.slice(0, 12);
    if (subs.length && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_PUBLIC_KEY) {
      try {
        webpush.setVapidDetails('mailto:keeter@veniacollection.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
        // Whoever asked is who replies — a dock turn from Nigma must not push
        // as "Your CFO". The caller names it; the CFO's wording is the default.
        const n = (p && p.note) || {};
        const note = JSON.stringify({
          title: String(n.title || 'Your CFO replied').slice(0, 80),
          body: String(n.body || 'The answer is waiting in the Eni dock.').slice(0, 160),
          tag: String(n.tag || 'venia-cfo-chat').slice(0, 60),
        });
        // An expired subscription answers 404/410 and then sits in the table
        // forever, quietly consuming one of the twelve slots. Drop those.
        const out = await Promise.allSettled(subs.map((sb) => webpush.sendNotification(sb, note)));
        const dead = out.map((r, i) => (r.status === 'rejected'
          && (r.reason && (r.reason.statusCode === 404 || r.reason.statusCode === 410)) ? subs[i] : null)).filter(Boolean);
        for (const sb of dead) {
          try {
            await fetch(SB_URL + '/rest/v1/rpc/venia_push_sub_drop', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', apikey: SB_ANON, Authorization: 'Bearer ' + SB_ANON },
              body: JSON.stringify({ p_secret: process.env.VENIA_DIGEST_SECRET || '', p_endpoint: sb && sb.endpoint }),
            });
          } catch (_) {}
        }
      } catch (_) {}
    }
    return new Response('', { status: 200 });
  } catch (e) {
    await complete(id, secret, 'error', String((e && e.message) || 'cloud run failed'));
    return new Response('', { status: 200 });
  }
};
