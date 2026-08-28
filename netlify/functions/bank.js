// Server-side proxy to Stripe FINANCIAL CONNECTIONS — the live bank feed.
// Reuses the same STRIPE_SECRET_KEY as stripe.js; nothing here can move money.
// Every call is READ or link-plumbing: create the auth session the founder
// completes in Stripe's own UI, list linked accounts, refresh balances,
// subscribe to and pull transactions. Amounts leave this function in DOLLARS
// (Stripe returns cents); transaction amounts keep Stripe's sign convention —
// negative = money out, positive = money in.
//
// Setup (Netlify → Site configuration → Environment variables):
//   STRIPE_SECRET_KEY        already set for stripe.js
//   STRIPE_PUBLISHABLE_KEY   pk_… — needed by Stripe.js in the browser to run
//                            the bank-auth modal (publishable keys are public
//                            by design)
//   VENIA_GATE_HASH / STRIPE_GATE_HASH — the access-code hash; REQUIRED here.
// Plus one Dashboard step for live mode: complete the Financial Connections
// registration (Settings → Financial Connections), or transaction pulls only
// work with test data.
//
// Bank data is the most sensitive thing this app touches, so unlike the
// Shopify proxy (which gates only when a hash is configured) every action but
// 'ping' here FAILS CLOSED: no gate hash configured → refuse.
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

const FCA_RE = /^fca_[A-Za-z0-9]+$/;
const CURSOR_RE = /^fctxn_[A-Za-z0-9]+$/;

export default async (req) => {
  const cors = corsHeaders(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method Not Allowed — expected POST' }, 405, cors);
  if (!originAllowed(req)) return json({ error: 'Forbidden' }, 403, cors);

  // Heal keys entered on a phone: strip ALL whitespace (a paste from a wrapped
  // display smuggles in line breaks mid-key) and map common look-alike
  // characters (e.g. Cyrillic З for 3, О for O) back to ASCII — real Stripe
  // keys are strictly alphanumeric, so any such character is a transcription
  // artifact. A key with a non-ASCII char crashes fetch with a cryptic
  // "ByteString" error the moment it hits an Authorization header. Healing is
  // conservative: if the underlying character was genuinely different, the
  // live Stripe check on ping still reports the key invalid.
  const healKey = (v) => String(v || '')
    .replace(/\s+/g, '')
    .replace(/З/g,'3').replace(/з/g,'3').replace(/О/g,'O').replace(/о/g,'o')
    .replace(/А/g,'A').replace(/а/g,'a').replace(/В/g,'B').replace(/Е/g,'E')
    .replace(/е/g,'e').replace(/С/g,'C').replace(/с/g,'c').replace(/Р/g,'P')
    .replace(/р/g,'p').replace(/Х/g,'X').replace(/х/g,'x').replace(/у/g,'y')
    .replace(/К/g,'K').replace(/к/g,'k').replace(/М/g,'M').replace(/Н/g,'H')
    .replace(/Т/g,'T').replace(/В/g,'B').replace(/І/g,'I').replace(/і/g,'i')
    .replace(/Ѕ/g,'S').replace(/ѕ/g,'s');
  const key = healKey(process.env.STRIPE_SECRET_KEY);
  const pk  = healKey(process.env.STRIPE_PUBLISHABLE_KEY);
  const skFormatOk = /^[sr]k_(live|test)_[A-Za-z0-9]+$/.test(key);
  const pkFormatOk = /^pk_(live|test)_[A-Za-z0-9]+$/.test(pk);

  let body;
  try { body = JSON.parse(await req.text() || '{}'); } catch (e) { return json({ error: 'Bad JSON' }, 400, cors); }
  const action = body.action;

  if (action === 'ping') {
    const gate = !!(process.env.VENIA_GATE_HASH || process.env.STRIPE_GATE_HASH);
    // Live diagnosis: prove the secret key actually authenticates, so a
    // mis-pasted key is caught here and not as a cryptic failure mid-flow.
    let key_ok = false, key_error = '';
    if (key && skFormatOk) {
      try {
        const r = await fetch('https://api.stripe.com/v1/balance', { headers: { Authorization: 'Bearer ' + key } });
        const j = await r.json().catch(() => ({}));
        key_ok = r.ok;
        if (!r.ok) key_error = (j && j.error && j.error.message ? String(j.error.message) : ('Stripe HTTP ' + r.status)).slice(0, 160);
      } catch (e) { key_error = String(e && e.message || e).slice(0, 160); }
    } else if (key) {
      // Name the exact position and code point (never the key itself) so a
      // stubborn bad character can be identified without guessing.
      const bad = key.match(/[^A-Za-z0-9_]/);
      key_error = bad
        ? 'STRIPE_SECRET_KEY still has an invalid character at position ' + key.indexOf(bad[0]) + ' (code ' + bad[0].codePointAt(0) + ') even after auto-healing — delete the variable in Netlify and re-add it with a fresh copy/paste.'
        : 'STRIPE_SECRET_KEY has an unexpected format — it should start with sk_live_ or sk_test_.';
    }
    // Build marker forces a fresh function bundle so env-var changes are
    // captured (same pattern as the Shopify proxy).
    return json({ configured: !!key, sk_format_ok: skFormatOk, key_ok, key_error,
                  pk_configured: !!pk, pk_format_ok: pkFormatOk, gate_configured: gate, build: '2026-08-28d' }, 200, cors);
  }
  if (!key) return json({ error: 'Stripe not configured — set STRIPE_SECRET_KEY in Netlify environment variables.' }, 400, cors);
  if (!skFormatOk) return json({ error: 'STRIPE_SECRET_KEY contains an invalid character (a look-alike from typing it by hand?). Re-paste it in Netlify — copy/paste, never type.' }, 400, cors);

  // Fail CLOSED: every bank action requires the VENIA access code.
  const gateHash = (process.env.VENIA_GATE_HASH || process.env.STRIPE_GATE_HASH || '').toLowerCase();
  if (!gateHash) return json({ error: 'Bank access is disabled until VENIA_GATE_HASH (or STRIPE_GATE_HASH) is set in Netlify environment variables.' }, 503, cors);
  const sent = req.headers.get('x-venia-code') || '';
  if (!sent || (await sha256Hex(sent)) !== gateHash) return json({ error: 'Not authorized — VENIA access code required.' }, 401, cors);

  const form = (o) => Object.entries(o)
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  const call = async (path, data, method = 'POST') => {
    const r = await fetch('https://api.stripe.com/v1/' + path, {
      method,
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: method === 'GET' ? undefined : form(data || {}),
    });
    return r.json();
  };

  // One Stripe Customer stands in for VENIA itself as the account holder —
  // linking accounts to a customer is what lets us list them again later.
  const findOrCreateHolder = async () => {
    const s = await call("customers/search?query=" + encodeURIComponent("metadata['venia_bank']:'1'"), {}, 'GET');
    if (s.error) throw new Error(s.error.message);
    if (s.data && s.data[0]) return s.data[0].id;
    const c = await call('customers', { name: 'VENIA Collection — bank link', 'metadata[venia_bank]': '1' });
    if (c.error) throw new Error(c.error.message);
    return c.id;
  };

  const slimAccount = (a) => ({
    id: a.id,
    name: a.display_name || a.institution_name || 'Account',
    institution: a.institution_name || '',
    last4: a.last4 || '',
    status: a.status || '',
    subscriptions: a.subscriptions || [],
    // Balance arrives in cents keyed by currency; surface USD in dollars.
    balance: a.balance ? {
      as_of: a.balance.as_of ? new Date(a.balance.as_of * 1000).toISOString().slice(0, 10) : '',
      current: a.balance.current && a.balance.current.usd != null ? a.balance.current.usd / 100 : null,
      available: a.balance.cash && a.balance.cash.available && a.balance.cash.available.usd != null ? a.balance.cash.available.usd / 100 : null,
    } : null,
    txn_refresh: a.transaction_refresh ? { status: a.transaction_refresh.status || '' } : null,
  });

  try {
    // Start a bank-auth session: the browser opens Stripe's own modal with the
    // returned client_secret; credentials never touch VENIA code.
    if (action === 'link') {
      if (!pk) return json({ error: 'Set STRIPE_PUBLISHABLE_KEY in Netlify environment variables — the browser needs it to open the bank-auth flow.' }, 400, cors);
      if (!pkFormatOk) return json({ error: 'STRIPE_PUBLISHABLE_KEY contains an invalid character (a look-alike from typing it by hand?). Re-paste it in Netlify — copy/paste, never type.' }, 400, cors);
      const customer = await findOrCreateHolder();
      // form() keeps one value per key, and permissions/prefetch repeat — build
      // the body by hand for this one call.
      const r = await fetch('https://api.stripe.com/v1/financial_connections/sessions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'account_holder[type]=customer'
          + '&account_holder[customer]=' + encodeURIComponent(customer)
          + '&permissions[]=balances&permissions[]=transactions'
          + '&prefetch[]=balances&prefetch[]=transactions'
          + '&filters[countries][]=US',
      });
      const session = await r.json();
      if (session.error) return json({ error: session.error.message }, 400, cors);
      return json({ client_secret: session.client_secret, pk }, 200, cors);
    }

    // Linked accounts (with whatever balance data Stripe has cached).
    if (action === 'accounts') {
      const customer = await findOrCreateHolder();
      const list = await call('financial_connections/accounts?account_holder[customer]=' + encodeURIComponent(customer) + '&limit=25', {}, 'GET');
      if (list.error) return json({ error: list.error.message }, 400, cors);
      return json({ accounts: (list.data || []).map(slimAccount) }, 200, cors);
    }

    // Daily transaction subscription (also kicks off the first refresh).
    if (action === 'subscribe') {
      if (!FCA_RE.test(String(body.account || ''))) return json({ error: 'Bad account id' }, 400, cors);
      const a = await call('financial_connections/accounts/' + body.account + '/subscribe', { 'features[]': 'transactions' });
      if (a.error) return json({ error: a.error.message }, 400, cors);
      return json({ account: slimAccount(a) }, 200, cors);
    }

    // On-demand balance refresh.
    if (action === 'refresh') {
      if (!FCA_RE.test(String(body.account || ''))) return json({ error: 'Bad account id' }, 400, cors);
      const a = await call('financial_connections/accounts/' + body.account + '/refresh', { 'features[]': 'balance' });
      if (a.error) return json({ error: a.error.message }, 400, cors);
      return json({ account: slimAccount(a) }, 200, cors);
    }

    // Transactions, newest-capable pagination via starting_after. Amounts in
    // dollars, Stripe's sign kept: negative = out, positive = in.
    if (action === 'transactions') {
      if (!FCA_RE.test(String(body.account || ''))) return json({ error: 'Bad account id' }, 400, cors);
      let qs = 'account=' + encodeURIComponent(body.account) + '&limit=100';
      if (CURSOR_RE.test(String(body.starting_after || ''))) qs += '&starting_after=' + encodeURIComponent(body.starting_after);
      const list = await call('financial_connections/transactions?' + qs, {}, 'GET');
      if (list.error) return json({ error: list.error.message }, 400, cors);
      const txns = (list.data || []).map(t => ({
        id: t.id,
        account: t.account,
        amount: (t.amount || 0) / 100,
        currency: t.currency || 'usd',
        description: String(t.description || '').slice(0, 200),
        status: t.status || '',
        date: t.transacted_at ? new Date(t.transacted_at * 1000).toISOString().slice(0, 10) : '',
      }));
      const next = list.has_more && txns.length ? txns[txns.length - 1].id : null;
      return json({ transactions: txns, has_more: !!list.has_more, next }, 200, cors);
    }

    // Sever a linked account (Stripe stops all data access to it).
    if (action === 'disconnect') {
      if (!FCA_RE.test(String(body.account || ''))) return json({ error: 'Bad account id' }, 400, cors);
      const a = await call('financial_connections/accounts/' + body.account + '/disconnect', {});
      if (a.error) return json({ error: a.error.message }, 400, cors);
      return json({ status: a.status || 'disconnected' }, 200, cors);
    }

    return json({ error: 'Unknown action' }, 400, cors);
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 502, cors);
  }
};

const json = (o, status = 200, cors) =>
  new Response(JSON.stringify(o), { status, headers: { ...(cors || {}), 'Content-Type': 'application/json' } });

export const config = { path: ['/api/bank', '/.netlify/functions/bank'] };

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
