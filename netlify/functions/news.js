// Server-side, read-only proxy to NewsAPI for the VENIA press scan.
//
// Why: newsapi.org blocks browser-origin requests on deployed sites (CORS /
// plan restrictions), and the API key must never live in the page. The key
// lives only in the NEWSAPI_KEY Netlify environment variable; the browser
// asks THIS function for results. Query is fixed server-side — the client
// cannot search arbitrary things on the account's quota.
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
  if (o) return ALLOWED_ORIGINS.has(o);
  const site = (req.headers.get('sec-fetch-site') || '').toLowerCase();
  return site === 'same-origin' || site === 'same-site';
}
const json = (o, status, cors) =>
  new Response(JSON.stringify(o), { status, headers: { ...(cors || {}), 'Content-Type': 'application/json' } });

export default async (req) => {
  const cors = corsHeaders(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405, cors);
  if (!originAllowed(req)) return json({ error: 'Forbidden' }, 403, cors);
  // Enforce the VENIA access code when a gate hash is configured (Origin is forgeable).
  const gateHash = (process.env.VENIA_GATE_HASH || process.env.STRIPE_GATE_HASH || '').toLowerCase();
  if (gateHash) {
    const sent = req.headers.get('x-venia-code') || '';
    if (!sent || (await sha256Hex(sent)) !== gateHash) return json({ error: 'Not authorized — VENIA access code required.' }, 401, cors);
  }

  const key = process.env.NEWSAPI_KEY;
  if (!key) return json({ configured: false, articles: [] }, 200, cors);

  try {
    const url = 'https://newsapi.org/v2/everything?q=' + encodeURIComponent('"VENIA Collection" OR "VENIA" fashion')
      + '&sortBy=publishedAt&pageSize=10&language=en';
    const r = await fetch(url, { headers: { 'X-Api-Key': key } });
    const data = await r.json();
    if (!r.ok) return json({ error: data.message || ('NewsAPI ' + r.status) }, 502, cors);
    const articles = (data.articles || []).map((a) => ({
      title: a.title, url: a.url,
      source: a.source && a.source.name || 'Unknown',
      publishedAt: a.publishedAt,
    }));
    return json({ configured: true, articles }, 200, cors);
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 502, cors);
  }
};

export const config = { path: ['/api/news', '/.netlify/functions/news'] };

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
