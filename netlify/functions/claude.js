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
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}
function originAllowed(req) {
  const o = req.headers.get('origin');
  if (!o) return true;
  return ALLOWED_ORIGINS.has(o);
}

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
  const key = process.env.ANTHROPIC_API_KEY;
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
  if (typeof payload.max_tokens !== 'number' || payload.max_tokens > 4096) payload.max_tokens = 4096;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(payload),
  });
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
