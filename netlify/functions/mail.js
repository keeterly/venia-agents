// Server-side sender so VENIA's mail comes FROM VENIA.
//
// A mailto: link cannot set a From address — the phone's mail app picks the
// account, which is how a pull sheet went out from a personal iCloud address.
// The only way an email leaves as info@veniacollection.com is if a server sends
// it. This is that server: the API key lives in Netlify, and the From address
// is set HERE, never taken from the caller — otherwise the endpoint would be a
// way to send mail as anyone.
//
// Env (Netlify → Site configuration → Environment variables):
//   RESEND_API_KEY   an API key from resend.com, with veniacollection.com
//                    verified as a sending domain (SPF + DKIM records).
//   MAIL_FROM        optional; defaults to VENIA Collection <info@veniacollection.com>
//   STRIPE_GATE_HASH reused as the access-code gate (same code as the card
//                    actions) — sending mail as the brand is not a public verb.
//
// Actions (POST JSON):
//   {action:'ping'}   → { configured, from }        (no gate — the UI asks this)
//   {action:'send', to, subject, text, html?, replyTo?, cc?}
//                     → { id }                      (gated)
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
function corsHeaders(req) {
  const o = req.headers.get('origin');
  const allow = (o && ALLOWED_ORIGINS.has(o)) ? o : 'https://creator.veniacollection.com';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-venia-code',
    'Vary': 'Origin',
  };
}
const DEFAULT_FROM = 'VENIA Collection <info@veniacollection.com>';
const EMAIL_RE = /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/;

export default async (req) => {
  const cors = corsHeaders(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405, cors);
  if (!originAllowed(req)) return json({ error: 'Forbidden' }, 403, cors);

  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM || DEFAULT_FROM;

  let body;
  try { body = await req.json(); } catch (e) { return json({ error: 'Bad JSON' }, 400, cors); }

  // The UI needs to know which path it is on BEFORE it drafts anything, so it
  // can say "sent from info@" or "drafted in your mail app" honestly.
  if (body.action === 'ping') return json({ configured: !!key, from: key ? from : '' }, 200, cors);

  if (!key) {
    return json({ error: 'Email is not connected — set RESEND_API_KEY in Netlify environment variables (and verify veniacollection.com at resend.com).' }, 400, cors);
  }

  // Sending as the brand is gated by the same access code as the card actions.
  // Fail CLOSED: an unset gate disables sending rather than opening it.
  const gateHash = process.env.STRIPE_GATE_HASH;
  if (!gateHash) return json({ error: 'Sending is disabled until STRIPE_GATE_HASH is set in Netlify environment variables.' }, 503, cors);
  const sent = req.headers.get('x-venia-code') || '';
  const okGate = sent && (await sha256Hex(sent)) === gateHash.toLowerCase();
  if (!okGate) return json({ error: 'Not authorized — enter your VENIA access code to send as VENIA.' }, 401, cors);

  if (body.action !== 'send') return json({ error: 'Unknown action' }, 400, cors);

  const to = String(body.to || '').trim();
  if (!EMAIL_RE.test(to)) return json({ error: 'A valid recipient email is required.' }, 400, cors);
  const cc = String(body.cc || '').trim();
  if (cc && !EMAIL_RE.test(cc)) return json({ error: 'The cc address is not a valid email.' }, 400, cors);
  const replyTo = String(body.replyTo || '').trim();
  if (replyTo && !EMAIL_RE.test(replyTo)) return json({ error: 'The reply-to address is not a valid email.' }, 400, cors);

  const subject = String(body.subject || '').slice(0, 200).trim();
  const text = String(body.text || '');
  const html = String(body.html || '');
  if (!subject) return json({ error: 'A subject is required.' }, 400, cors);
  if (!text && !html) return json({ error: 'The message body is empty.' }, 400, cors);
  // A pull sheet is a couple of pages of text. Anything at this size is a bug
  // upstream, and a provider rejection after the fact is a worse way to find out.
  if (text.length + html.length > 400000) return json({ error: 'That message is too large to send (over 400KB).' }, 413, cors);

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,                                  // set here, never by the caller
        to: [to],
        ...(cc ? { cc: [cc] } : {}),
        ...(replyTo ? { reply_to: replyTo } : {}),
        subject,
        ...(text ? { text } : {}),
        ...(html ? { html } : {}),
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      // Resend's domain errors are the ones that will actually happen here, and
      // "failed to send" would send someone hunting in the wrong place.
      const msg = (d && (d.message || d.error)) || ('Resend returned ' + r.status);
      return json({ error: String(msg).slice(0, 300) }, r.status === 401 ? 401 : 400, cors);
    }
    return json({ id: d.id || '', from }, 200, cors);
  } catch (e) {
    return json({ error: String((e && e.message) || e).slice(0, 300) }, 500, cors);
  }
};

const json = (o, status = 200, cors) =>
  new Response(JSON.stringify(o), { status, headers: { ...(cors || {}), 'Content-Type': 'application/json' } });

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
