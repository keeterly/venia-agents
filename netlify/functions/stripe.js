// Server-side Stripe proxy for stylist-pull deposits & holds.
// The secret key lives in the STRIPE_SECRET_KEY env var (Netlify → Site
// configuration → Environment variables) so it never reaches the browser.
//
// Actions (POST JSON):
//   {action:'ping'}                       → { configured: boolean }
//   {action:'create', amount, hold, email, description}
//       Creates a Stripe Checkout session the stylist opens on their phone.
//       hold:true authorizes without capturing (capture_method=manual) so you
//       can release or capture after the samples come back.
//       → { id, url }
//   {action:'status', id}                 → { payment_status, status, payment_intent }
//   {action:'capture', payment_intent}    → { status }   (capture a hold)
//   {action:'cancel',  payment_intent}    → { status }   (release a hold)
// Only VENIA's own site may call this endpoint. A browser always sends an
// Origin on these POSTs; a present-but-foreign Origin is a third-party trying
// to spin up Checkout sessions against the account — reject it. (capture/cancel
// keep their separate access-code gate below.)
const ALLOWED_ORIGINS = new Set([
  'https://creator.veniacollection.com',
  'https://venia-creator.netlify.app',
  'https://main--venia-creator.netlify.app',
]);
function originAllowed(req) {
  const o = req.headers.get('origin');
  if (o) return ALLOWED_ORIGINS.has(o);          // Origin present → must be ours
  const site = (req.headers.get('sec-fetch-site') || '').toLowerCase();
  return site === 'same-origin' || site === 'same-site';   // no Origin → browser same-origin only
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

export default async (req) => {
  const cors = corsHeaders(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405, cors);
  if (!originAllowed(req)) return json({ error: 'Forbidden' }, 403, cors);
  const key = process.env.STRIPE_SECRET_KEY;
  let body;
  try { body = await req.json(); } catch (e) { return json({ error: 'Bad JSON' }, 400); }

  if (body.action === 'ping') return json({ configured: !!key });
  if (!key) return json({ error: 'Stripe not configured — set STRIPE_SECRET_KEY in Netlify environment variables' }, 400);

  // Gate the money-moving actions. capture/cancel move real money on cards, and
  // the pull records (with their payment_intent IDs) sync to the shared
  // workspace — so without this, anyone who read those IDs could release or
  // charge holds against the public function. Require the VENIA access code:
  // the client sends it, we compare its SHA-256 to STRIPE_GATE_HASH (the same
  // hash the login gate uses). The raw code never appears in the page source,
  // only its hash does, so knowing the hash doesn't let you forge the header.
  // 'invoice' creates and SENDS a real invoice to a buyer's inbox — it was the
  // one money action left ungated, exploitable by any caller forging an Origin
  // header. Gated fail-closed like the card actions.
  const GATED = ['capture', 'cancel', 'invoice', 'invoice_status'];
  if (GATED.includes(body.action)) {
    const gateHash = process.env.STRIPE_GATE_HASH;
    // Fail CLOSED: if the gate hash isn't configured, refuse the money action
    // rather than letting it through unauthenticated.
    if (!gateHash) return json({ error: 'Card actions are disabled until STRIPE_GATE_HASH is set in Netlify environment variables.' }, 503, cors);
    const sent = req.headers.get('x-venia-code') || '';
    const ok = sent && (await sha256Hex(sent)) === gateHash.toLowerCase();
    if (!ok) return json({ error: 'Not authorized — enter your VENIA access code to move a card hold.' }, 401, cors);
  }

  const form = (o) => Object.entries(o)
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  const call = async (path, data, method = 'POST') => {
    const r = await fetch('https://api.stripe.com/v1/' + path, {
      method,
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: method === 'GET' ? undefined : form(data),
    });
    return r.json();
  };

  try {
    if (body.action === 'create') {
      const amt = Math.round(Number(body.amount) * 100);
      if (!amt || amt < 50) return json({ error: 'Amount must be at least $0.50' }, 400);
      if (amt > 5000000) return json({ error: 'Amount too large' }, 400);   // $50k sanity cap
      const s = await call('checkout/sessions', {
        mode: 'payment',
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][product_data][name]': body.description || 'VENIA sample pull deposit',
        'line_items[0][price_data][unit_amount]': amt,
        'line_items[0][quantity]': 1,
        ...(body.hold ? { 'payment_intent_data[capture_method]': 'manual' } : {}),
        ...(body.email ? { customer_email: body.email } : {}),
        success_url: 'https://creator.veniacollection.com/?pay=success',
        cancel_url: 'https://creator.veniacollection.com/?pay=cancelled',
      });
      if (s.error) return json({ error: s.error.message }, 400);
      return json({ id: s.id, url: s.url });
    }
    // Wholesale invoicing: find-or-create the customer, build the invoice,
    // finalize and send — one call from the client, secret stays here.
    if (body.action === 'invoice') {
      // 'pull' is the default because it is what every existing caller is: an
      // older cached client that sends no kind is invoicing a stylist pull, so
      // defaulting the other way would keep mislabelling them.
      const kind = body.kind === 'wholesale' ? 'wholesale' : 'pull';
      const LABEL = { pull: 'VENIA press & stylist pulls', wholesale: 'VENIA wholesale account' };
      const LINE  = { pull: 'VENIA stylist pull', wholesale: 'VENIA wholesale order' };
      const amt = Math.round(Number(body.amount) * 100);
      if (!amt || amt < 50) return json({ error: 'Amount must be at least $0.50' }, 400, cors);
      if (amt > 20000000) return json({ error: 'Amount too large' }, 400, cors);   // $200k sanity cap
      const email = String(body.email || '').trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'A valid buyer email is required' }, 400, cors);
      const search = await call('customers/search?query=' + encodeURIComponent("email:'" + email.replace(/'/g, '') + "'"), {}, 'GET');
      const found = search.data && search.data[0];
      let customerId = found && found.id;
      if (!customerId) {
        const cust = await call('customers', {
          email, name: String(body.name || ''), description: LABEL[kind],
          'metadata[venia_kind]': kind,
        });
        if (cust.error) return json({ error: cust.error.message }, 400, cors);
        customerId = cust.id;
      } else {
        // Correct a label we wrote ourselves, and only one we wrote ourselves —
        // a description typed by a human in the Stripe dashboard is theirs, not
        // ours to overwrite. Someone who both buys wholesale and borrows samples
        // is genuinely both, and the label says so rather than flip-flopping on
        // whichever invoice went out last.
        const cur = String(found.description || '');
        const ours = cur === LABEL.pull || cur === LABEL.wholesale || cur === '';
        if (ours && cur !== LABEL[kind]) {
          const next = cur === '' ? LABEL[kind] : 'VENIA wholesale + press pulls';
          try { await call('customers/' + encodeURIComponent(customerId), { description: next, 'metadata[venia_kind]': cur === '' ? kind : 'both' }); } catch (_) {}
        }
      }
      // THE INVOICE IS CREATED FIRST AND THE LINE IS ATTACHED TO IT BY ID.
      // Creating the invoiceitem first leaves it PENDING — unattached to any
      // invoice — and Stripe's API-created invoices default to
      // pending_invoice_items_behavior: 'exclude', so the line was never picked
      // up. The result was a $0.00 invoice that auto-finalised as PAID and went
      // to the buyer's inbox reading "Invoice paid $0.00" while VENIA recorded
      // the full amount. Naming the invoice on the line removes the dependency
      // on that default entirely.
      const inv = await call('invoices', {
        customer: customerId, collection_method: 'send_invoice',
        days_until_due: String(Math.min(parseInt(body.days, 10) || 14, 60)),
        description: String(body.description || '').slice(0, 300),
        footer: 'VENIA Collection | veniacollection.com',
        'metadata[venia_kind]': kind,
        ...(body.ref ? { 'metadata[venia_ref]': String(body.ref).slice(0, 60) } : {}),
      });
      if (inv.error) return json({ error: inv.error.message }, 400, cors);
      const item = await call('invoiceitems', {
        customer: customerId, invoice: inv.id, amount: amt, currency: 'usd',
        description: String(body.description || LINE[kind]).slice(0, 300),
      });
      if (item.error) return json({ error: item.error.message }, 400, cors);
      const fin = await call('invoices/' + encodeURIComponent(inv.id) + '/finalize', {});
      if (fin.error) return json({ error: fin.error.message }, 400, cors);
      // CHECK THE TOTAL BEFORE IT IS SENT, NOT AFTER. An invoice for the wrong
      // amount in a stylist's inbox cannot be taken back, and a $0 one is
      // already marked paid by the time anyone notices. Void and refuse.
      const total = Number(fin.total);
      if (total !== amt) {
        try { await call('invoices/' + encodeURIComponent(inv.id) + '/void', {}); } catch (_) {}
        return json({ error: 'Stripe finalized this invoice at $' + (total / 100).toFixed(2)
          + ' instead of $' + (amt / 100).toFixed(2) + '. It was voided and NOT sent — nothing reached the buyer.' }, 500, cors);
      }
      const sent = await call('invoices/' + encodeURIComponent(inv.id) + '/send', {});
      if (sent.error) return json({ error: sent.error.message }, 400, cors);
      return json({ id: inv.id, total,
        hosted_invoice_url: fin.hosted_invoice_url || sent.hosted_invoice_url || '' });
    }
    if (body.action === 'status') {
      const s = await call('checkout/sessions/' + encodeURIComponent(body.id), {}, 'GET');
      if (s.error) return json({ error: s.error.message }, 400);
      return json({ payment_status: s.payment_status, status: s.status, payment_intent: s.payment_intent });
    }
    // Invoice status (AR truth): the wholesale flow sends real Stripe INVOICES,
    // whose lifecycle (open → paid / void / uncollectible) was never read back
    // — the app counted every invoice as booked revenue forever. Amounts are
    // returned in dollars.
    if (body.action === 'invoice_status') {
      const inv = await call('invoices/' + encodeURIComponent(body.id), {}, 'GET');
      if (inv.error) return json({ error: inv.error.message }, 400, cors);
      return json({
        id: inv.id, status: inv.status,
        amount_paid: (inv.amount_paid || 0) / 100,
        amount_remaining: (inv.amount_remaining || 0) / 100,
        due_date: inv.due_date ? new Date(inv.due_date * 1000).toISOString().slice(0, 10) : '',
        hosted_invoice_url: inv.hosted_invoice_url || '',
      }, 200, cors);
    }
    if (body.action === 'capture') {
      const pi = await call('payment_intents/' + encodeURIComponent(body.payment_intent) + '/capture', {});
      if (pi.error) return json({ error: pi.error.message }, 400);
      return json({ status: pi.status });
    }
    if (body.action === 'cancel') {
      const pi = await call('payment_intents/' + encodeURIComponent(body.payment_intent) + '/cancel', {});
      if (pi.error) return json({ error: pi.error.message }, 400);
      return json({ status: pi.status });
    }
    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 500);
  }
};

const json = (o, status = 200, cors) =>
  new Response(JSON.stringify(o), { status, headers: { ...(cors || {}), 'Content-Type': 'application/json' } });

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
