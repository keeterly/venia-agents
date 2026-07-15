// Secure server-side proxy to the Anthropic API.
// The key lives in the ANTHROPIC_API_KEY env var (set in Netlify → Site
// configuration → Environment variables), so it is never exposed in the
// browser. The app calls /.netlify/functions/claude with the same body it
// would send to Anthropic directly.
// Only VENIA's own site may use this relay. A browser always sends an Origin
// header on these POSTs, so a request whose Origin is present but not ours is a
// third-party site trying to spend the Anthropic budget — reject it. (Requests
// with no Origin at all are left to pass for now; the strong lock is the
// signed-in-user check that lands with the database work.)
const ALLOWED_ORIGINS = new Set([
  'https://creator.veniacollection.com',
  'https://venia-creator.netlify.app',
  'https://main--venia-creator.netlify.app',
]);
function originAllowed(req) {
  const o = req.headers.get('origin');
  if (!o) return true;
  return ALLOWED_ORIGINS.has(o);
}

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  if (!originAllowed(req)) {
    return new Response(JSON.stringify({ error: { message: 'Forbidden' } }),
      { status: 403, headers: { 'Content-Type': 'application/json' } });
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return new Response(
      JSON.stringify({ error: { message: 'ANTHROPIC_API_KEY is not set on this Netlify site' } }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Read the request, and clamp max_tokens so a single call can't be turned
  // into an expensive one. The app never needs more than a few thousand.
  let payload;
  try { payload = JSON.parse(await req.text()); } catch (e) {
    return new Response(JSON.stringify({ error: { message: 'Bad JSON' } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } });
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
    headers: { 'Content-Type': 'application/json' },
  });
};
