import webpush from 'web-push';

// PUSH SELF-TEST. "I never got a notification" has at least five causes —
// VAPID keys not configured, no subscription stored, an expired subscription,
// permission never granted, or an iOS app that was never added to the Home
// Screen — and from the outside they are indistinguishable. Nothing in the app
// could tell them apart, so every push problem was a guess. This sends one
// notification through exactly the path the workers use and REPORTS what
// happened per device, so the answer is a fact rather than a theory.
// Gated by the founder access code, like every other write-capable function.
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
const json = (o, status) => new Response(JSON.stringify(o), {
  status: status || 200, headers: { 'Content-Type': 'application/json' } });

export default async (req) => {
  if (req.method !== 'POST') return new Response('', { status: 405 });
  if (!originAllowed(req)) return new Response('', { status: 403 });

  const gateHash = (process.env.VENIA_GATE_HASH || process.env.STRIPE_GATE_HASH || '').toLowerCase();
  if (gateHash) {
    const sent = req.headers.get('x-venia-code') || '';
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sent));
    const hex = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
    if (!sent || hex !== gateHash) return new Response('', { status: 401 });
  }

  const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return json({ ok: false, reason: 'vapid_missing',
    detail: 'VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set in Netlify — no push can ever be sent.' });
  const secret = process.env.VENIA_DIGEST_SECRET;
  if (!secret) return json({ ok: false, reason: 'secret_missing',
    detail: 'VENIA_DIGEST_SECRET is not set, so the server cannot look up who to notify.' });

  let subs = [];
  try {
    const r = await fetch(SB_URL + '/rest/v1/rpc/venia_digest_fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SB_ANON, Authorization: 'Bearer ' + SB_ANON },
      body: JSON.stringify({ p_secret: secret }),
    });
    const p = await r.json();
    if (p && p.error) return json({ ok: false, reason: 'rpc_' + p.error, detail: 'The subscriber lookup was refused.' });
    if (p && Array.isArray(p.subs)) subs = p.subs;
  } catch (e) {
    return json({ ok: false, reason: 'rpc_failed', detail: String((e && e.message) || e) });
  }
  if (!subs.length) return json({ ok: false, reason: 'no_subs',
    detail: 'No device is subscribed. Turn the morning digest on for this phone, and on iOS the app must be added to the Home Screen first.' });

  webpush.setVapidDetails('mailto:keeter@veniacollection.com', pub, priv);
  const note = JSON.stringify({ title: 'VENIA push works',
    body: 'This is the test notification — agent replies will arrive the same way.', tag: 'venia-push-test' });
  const out = await Promise.allSettled(subs.slice(0, 12).map((s) => webpush.sendNotification(s, note)));
  const results = out.map((r, i) => {
    const host = (() => { try { return new URL(subs[i].endpoint).host; } catch (_) { return 'unknown'; } })();
    if (r.status === 'fulfilled') return { host, ok: true };
    const code = (r.reason && r.reason.statusCode) || 0;
    return { host, ok: false, code, why: (code === 404 || code === 410) ? 'expired — this device must re-subscribe' : String((r.reason && r.reason.message) || 'send failed').slice(0, 140) };
  });
  // Retire the endpoints the push service says are gone, so they stop taking a slot.
  for (const r of results.filter((x) => !x.ok && (x.code === 404 || x.code === 410))) {
    const s = subs[results.indexOf(r)];
    try {
      await fetch(SB_URL + '/rest/v1/rpc/venia_push_sub_drop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SB_ANON, Authorization: 'Bearer ' + SB_ANON },
        body: JSON.stringify({ p_secret: secret, p_endpoint: s && s.endpoint }),
      });
    } catch (_) {}
  }
  const sent = results.filter((r) => r.ok).length;
  return json({ ok: sent > 0, reason: sent ? 'sent' : 'all_failed', sent, total: results.length, results });
};
