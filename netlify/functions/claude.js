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
// OPUS 5 FOR THE THINKING, HAIKU FOR THE ERRANDS.
//
// Everything ran on Sonnet 5, and the relay's allow-list meant nothing else
// could be asked for. What kept failing was instruction-following under a long,
// rule-dense prompt -- six replies in a row that described a save and omitted
// the block that performs it. That is the class of thing the more capable model
// handles better, and for a two-person brand the difference in spend is small
// against one lost evening of buyer research.
//
// Sonnet stays allowed so a caller can still ask for it deliberately; Haiku
// stays the retry and the small-parse model, where capability buys nothing.
const ALLOWED_MODELS = new Set([
  'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001',
]);
const DEFAULT_MODEL = 'claude-opus-5';

// THE APP'S OWN SAVE TOOL. Unlike web search it costs nothing to offer, but it
// is still DEFINED HERE rather than trusted from the request body: the body is
// caller-controlled, and a caller past the gate must not be able to reshape
// what the model is told it may write. The client ships an identical copy so
// the direct-key fallback still works when the relay is unreachable — if the
// two ever drift, this one wins for every call that comes through here.
const VENIA_ACTION_TOOL = {
  name: 'venia_action',
  description: 'Write a change into the VENIA workspace. This is the ONLY thing that saves anything \u2014 '
    + 'buyers, corrections, outreach, styles, vendors, plans, handoffs. Saying you saved, filed, added or '
    + 'updated something WITHOUT calling this tool saves nothing at all. Pass the action object exactly as '
    + 'shown in the example for that action type in your instructions: "type" plus every other field that '
    + 'example carries. Call it once, alongside your one-sentence reply. Do not call it for research, '
    + 'analysis, drafting or advice \u2014 only when a record should actually change.',
  input_schema: {
    type: 'object',
    properties: {
      type: { type: 'string', description: 'The action type, exactly as named in your instructions (add_buyers, update_buyers, log_outreach, handoff, \u2026).' },
    },
    required: ['type'],
    additionalProperties: true,
  },
};

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
    // Search AND fetch: search finds the page, fetch reads it, and clamping to
    // one tool would have silently dropped the second -- a stripped tool is not
    // an error the caller ever sees, it just quietly stops working. Each keeps
    // its own name and its own ceiling; nothing else gets through.
    const OK = { web_search: /^web_search_\d{8}$/, web_fetch: /^web_fetch_\d{8}$/ };
    const nameFor = (type) => Object.keys(OK).find((n) => OK[n].test(type)) || '';
    const seen = {};
    const tools = (Array.isArray(payload.tools) ? payload.tools : []).reduce((acc, t) => {
      // The save tool has no `type` — it is ours, not one of Anthropic's server
      // tools — so it would have fallen straight through the filter below and
      // been dropped, silently, which is the one failure mode this whole change
      // exists to remove. Match it by name and substitute our own definition.
      if (t && t.name === 'venia_action') {
        if (!seen.venia_action) { seen.venia_action = 1; acc.push(VENIA_ACTION_TOOL); }
        return acc;
      }
      const n = t && typeof t.type === 'string' ? nameFor(t.type) : '';
      if (!n || seen[n]) return acc;                       // one of each, at most
      seen[n] = 1;
      const keep = { type: t.type, name: n,
        max_uses: Math.max(1, Math.min(MAX_USES, Number(t.max_uses) || 5)) };
      if (n === 'web_fetch') {
        keep.max_content_tokens = Math.max(1000, Math.min(40000, Number(t.max_content_tokens) || 20000));
        if (t.citations) keep.citations = { enabled: true };
      }
      acc.push(keep);
      return acc;
    }, []);
    if (!tools.length) delete payload.tools; else payload.tools = tools;
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
