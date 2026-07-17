// Server-side, READ-ONLY proxy to the Shopify Admin API.
// deploy: rebuild to capture SHOPIFY_STORE_DOMAIN / SHOPIFY_ADMIN_TOKEN env vars (2026-07-15).
//
// Why this exists: the Shopify Admin token (shpat_…) is a powerful credential
// — it can read and write orders, products, and customers. It must never live
// in the browser (localStorage is readable by any script on the page and, in
// this app, syncs to the shared workspace). So the token lives only in a
// Netlify environment variable and the browser asks THIS function for data
// instead of calling Shopify directly. (Browsers can't call the Admin API
// directly anyway — it sends no CORS headers — which is why the old in-page
// path never returned live data.)
//
// Set in Netlify → Site configuration → Environment variables:
//   SHOPIFY_STORE_DOMAIN   e.g. veniacollection.myshopify.com
//   SHOPIFY_ADMIN_TOKEN    the Admin API access token (shpat_…)
//   SHOPIFY_API_VERSION    optional, defaults to 2024-10
//
// This proxy only ever issues GET requests to a fixed allowlist of read
// endpoints. It accepts no arbitrary path, method, or body from the client, so
// even a compromised page can only READ shop/orders/products — never write,
// and never see the token.
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
  if (o) return ALLOWED_ORIGINS.has(o);          // Origin present → must be ours
  // No Origin: allow only a browser same-origin/site POST (Sec-Fetch-Site is set
  // by the browser, absent on curl/script). Closes the trivial no-Origin bypass
  // that would otherwise hand this store's customer/order data to any caller.
  const site = (req.headers.get('sec-fetch-site') || '').toLowerCase();
  return site === 'same-origin' || site === 'same-site';
}

export default async (req) => {
  const cors = corsHeaders(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method Not Allowed — expected POST' }, 405, cors);
  if (!originAllowed(req)) return json({ error: 'Forbidden' }, 403, cors);

  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token  = process.env.SHOPIFY_ADMIN_TOKEN;
  // Keep this on a currently-supported Admin API version. Shopify removes very
  // old versions on a rolling schedule, so a stale default (e.g. 2024-10) can
  // start failing with no code change on our side. Override with
  // SHOPIFY_API_VERSION if needed.
  const version = process.env.SHOPIFY_API_VERSION || '2026-01';

  let body;
  try { body = JSON.parse(await req.text() || '{}'); } catch (e) { return json({ error: 'Bad JSON' }, 400, cors); }
  const action = body.action;

  // ping lets the UI show a "Connected" state without ever revealing the token.
  // The build marker forces a fresh function bundle so env-var changes are
  // captured (esbuild strips comments, so a real output change is needed).
  if (action === 'ping') return json({ configured: !!(domain && token), version, build: '2026-07-16a' }, 200, cors);

  if (!domain || !token) {
    return json({ error: 'Shopify not configured — set SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_TOKEN in Netlify environment variables.' }, 400, cors);
  }

  // Aggregated order history: loops Shopify's pagination server-side so the
  // client gets ONE slim payload covering a whole date range (year-to-date,
  // trailing 12 months…) instead of a single 250-order page. Read-only, slim
  // fields, capped at 10 pages / 2,500 orders.
  if (action === 'ordersAll') {
    const min = /^\d{4}-\d{2}-\d{2}/.test(String(body.created_at_min || '')) ? String(body.created_at_min) : null;
    const fields = 'created_at,total_price,cancelled_at,test,line_items';
    let url = `https://${domain}/admin/api/${version}/orders.json?status=any&limit=250&fields=${fields}`
      + (min ? `&created_at_min=${encodeURIComponent(min)}` : '');
    const all = [];
    try {
      for (let page = 0; page < 10 && url; page++) {
        const r = await fetch(url, { method: 'GET', headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' } });
        if (!r.ok) {
          if (r.status === 401 || r.status === 403) return json({ error: `Shopify rejected the credentials (${r.status}).` }, 401, cors);
          return json({ error: `Shopify ${r.status} ${r.statusText} (API ${version})` }, 502, cors);
        }
        const j = await r.json();
        (j.orders || []).forEach((o) => all.push({
          created_at: o.created_at, total_price: o.total_price,
          cancelled_at: o.cancelled_at, test: o.test,
          line_items: (o.line_items || []).map((li) => ({ title: li.title, quantity: li.quantity })),
        }));
        const link = r.headers.get('link') || '';
        const m = link.match(/<([^>]+)>;\s*rel="next"/);
        url = m ? m[1] : null;
      }
      return json({ orders: all, truncated: !!url }, 200, cors);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 502, cors);
    }
  }

  // Map each allowed action to a fixed GET endpoint. The client cannot ask for
  // anything outside this table — no raw paths, no writes.
  let endpoint;
  if (action === 'shop') {
    endpoint = '/shop.json';
  } else if (action === 'orders') {
    const limit = clampInt(body.limit, 1, 250, 20);
    const status = ['any', 'open', 'closed', 'cancelled'].includes(body.status) ? body.status : 'any';
    endpoint = `/orders.json?status=${status}&limit=${limit}`;
  } else if (action === 'products') {
    const limit = clampInt(body.limit, 1, 250, 50);
    endpoint = `/products.json?limit=${limit}`;
  } else if (action === 'customers') {
    const limit = clampInt(body.limit, 1, 250, 50);
    endpoint = `/customers.json?limit=${limit}`;
  } else {
    return json({ error: 'Unknown action' }, 400, cors);
  }

  try {
    const r = await fetch(`https://${domain}/admin/api/${version}${endpoint}`, {
      method: 'GET',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    });
    const text = await r.text();
    if (!r.ok) {
      // Surface a clean, actionable message; never echo the token or headers.
      let detail = '';
      try { const j = JSON.parse(text); detail = typeof j.errors === 'string' ? j.errors : (j.errors ? JSON.stringify(j.errors) : ''); } catch (_) {}
      let msg;
      if (r.status === 401 || r.status === 403) {
        msg = `Shopify rejected the credentials (${r.status}). Update SHOPIFY_ADMIN_TOKEN in Netlify with a current Admin API access token.`;
      } else if (r.status === 404) {
        msg = `Shopify returned 404. Check SHOPIFY_STORE_DOMAIN (should be your-store.myshopify.com) and that API version ${version} is valid.`;
      } else {
        msg = `Shopify ${r.status} ${r.statusText}${detail ? ' — ' + detail : ''} (API ${version})`;
      }
      return json({ error: msg }, (r.status === 401 || r.status === 403) ? 401 : 502, cors);
    }
    return new Response(text, { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } });
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 502, cors);
  }
};

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}
const json = (o, status, cors) =>
  new Response(JSON.stringify(o), { status, headers: { ...(cors || {}), 'Content-Type': 'application/json' } });

// Serve at a clean path that can't be shadowed by the site's "/" rewrite,
// matching the pattern used by the Anthropic relay.
export const config = { path: ['/api/shopify', '/.netlify/functions/shopify'] };
