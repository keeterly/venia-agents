// Secure server-side proxy to the Anthropic API.
// The key lives in the ANTHROPIC_API_KEY env var (set in Netlify → Site
// configuration → Environment variables), so it is never exposed in the
// browser. The app calls /.netlify/functions/claude with the same body it
// would send to Anthropic directly.
export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return new Response(
      JSON.stringify({ error: { message: 'ANTHROPIC_API_KEY is not set on this Netlify site' } }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
  const body = await req.text();
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body,
  });
  return new Response(await r.text(), {
    status: r.status,
    headers: { 'Content-Type': 'application/json' },
  });
};
