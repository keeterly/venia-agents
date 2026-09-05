// Secure server-side proxy to the Anthropic API.
// The key lives in the ANTHROPIC_API_KEY env var (set in Netlify → Site
// configuration → Environment variables), so it is never exposed in the
// browser. The app calls /.netlify/functions/claude with the same body it
// would send to Anthropic directly.
//
// Only VENIA's own site may use this relay. A browser always sends an Origin
// header on these POSTs, so a request whose Origin is present but not ours is a
// third-party site trying to spend the Anthropic budget — reject it.
const ALLOWED_ORIGINS = new Set([
  'https://creator.veniacollection.com',
  'https://venia-creator.netlify.app',
  'https://main--venia-creator.netlify.app',
]);
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
function originAllowed(req) {
  const o = req.headers.get('origin');
  if (o) return ALLOWED_ORIGINS.has(o);          // Origin present → must be ours
  // No Origin header: browsers still mark same-origin POSTs with Sec-Fetch-Site,
  // which curl/script calls don't send. Allow only that case. This closes the
  // trivial "no Origin" bypass; it is not a hard wall against a client that
  // forges headers (a signed-session gate would be — planned follow-up).
  const site = (req.headers.get('sec-fetch-site') || '').toLowerCase();
  return site === 'same-origin' || site === 'same-site';
}
// Only these models may be driven through the relay, so a stray or malicious
// caller can't pick an expensive one. Anything else is coerced to the default.
const ALLOWED_MODELS = new Set(['claude-sonnet-5', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001']);
const DEFAULT_MODEL = 'claude-sonnet-5';

export default async (req) => {
  const cors = corsHeaders(req);
  // Preflight — answer it so a cross-origin POST (e.g. when the app is opened on
  // the .netlify.app address) is allowed through instead of failing.
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: { message: 'Method Not Allowed — expected POST' } }),
      { status: 405, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
  if (!originAllowed(req)) {
    return new Response(JSON.stringify({ error: { message: 'Forbidden' } }),
      { status: 403, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
  // Real wall (Origin headers are forgeable by non-browser callers): when a
  // gate hash is configured, require the VENIA access code on every call so a
  // stranger can't spend the ANTHROPIC_API_KEY budget. Enforce-if-configured
  // keeps the function working on sites that haven't set the hash yet.
  const gateHash = (process.env.VENIA_GATE_HASH || process.env.STRIPE_GATE_HASH || '').toLowerCase();
  if (gateHash) {
    const sent = req.headers.get('x-venia-code') || '';
    const okCode = sent && (await sha256Hex(sent)) === gateHash;
    if (!okCode) {
      return new Response(JSON.stringify({ error: { message: 'Not authorized — VENIA access code required.' } }),
        { status: 401, headers: { ...cors, 'Content-Type': 'application/json' } });
    }
  }
  const key = process.env.ANTHROPIC_API_KEY;
  // ping: does this site hold a key? Answered before any Anthropic call, so the
  // UI can show a true connection state for free. It reveals only a boolean,
  // and only to a caller that already passed the origin check and the gate.
  try {
    const peek = await req.clone().json();
    if (peek && peek.ping === true) {
      return new Response(JSON.stringify({ configured: !!key, build: '2026-08-30a' }),
        { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } });
    }
  } catch (e) { /* not JSON — fall through to the normal path */ }
  if (!key) {
    return new Response(
      JSON.stringify({ error: { message: 'ANTHROPIC_API_KEY is not set on this Netlify site' } }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } }
    );
  }

  // Read the request, and clamp max_tokens so a single call can't be turned
  // into an expensive one. The app never needs more than a few thousand.
  let payload;
  try { payload = JSON.parse(await req.text()); } catch (e) {
    return new Response(JSON.stringify({ error: { message: 'Bad JSON' } }),
      { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
  // 16384 ceiling: claude-sonnet-5's adaptive thinking counts against
  // max_tokens, and a long task (e.g. filing a big buyer list) was burning the
  // whole old 8192 budget on thinking and stopping before any text. max_tokens
  // is a ceiling, not a spend — you only pay for tokens actually generated.
  if (typeof payload.max_tokens !== 'number' || payload.max_tokens > 16384) payload.max_tokens = 16384;
  if (!ALLOWED_MODELS.has(payload.model)) payload.model = DEFAULT_MODEL;   // pin model server-side

  // TOOLS ARE SPEND, so the relay decides which ones exist rather than the
  // caller. The body was passed through whole: anything that got past the gate
  // could have asked for a tool we never intended to pay for, or for a hundred
  // searches in one turn. Only web search is allowed through, and its ceiling
  // is set here — a client asking for more gets the ceiling, not an error,
  // because failing the turn would be worse than capping it.
  if (payload.tools !== undefined) {
    // 24, not 8: at $10/1,000 searches one turn's worst case is 24 cents,
    // and the client asks for 20. A ceiling below what the app requests is
    // just a silent truncation of the answer.
    const MAX_USES = 24;
    const OK_TYPES = /^web_search_\d{8}$/;
    const tools = Array.isArray(payload.tools) ? payload.tools.filter(
      (t) => t && typeof t.type === 'string' && OK_TYPES.test(t.type)) : [];
    if (!tools.length) delete payload.tools;
    else payload.tools = tools.slice(0, 1).map((t) => ({
      type: t.type, name: 'web_search',
      max_uses: Math.max(1, Math.min(MAX_USES, Number(t.max_uses) || 5)),
    }));
    if (payload.tool_choice) delete payload.tool_choice;   // never force a paid tool
  }

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(payload),
  });

  // Streaming pass-through: long generations (agent research, big schedules)
  // exceed the buffered-function time window (the 504s). With stream:true the
  // first token arrives in ~1s and Netlify happily streams the rest, so the
  // relay stops being the ceiling on how long Eni may think.
  if (payload.stream && r.ok && r.body) {
    return new Response(r.body, {
      status: r.status,
      headers: { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    });
  }

  return new Response(await r.text(), {
    status: r.status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
};

// Serve the function at a clean, friendly path in addition to the default
// /.netlify/functions/claude. A dedicated /api/claude path can't be shadowed by
// the site's "/" rewrite or the root static publish, which is what was causing
// POSTs to be rejected with a bare 405 before they reached this code.
export const config = { path: ['/api/claude', '/.netlify/functions/claude'] };

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
