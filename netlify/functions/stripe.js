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
export default async (req) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  const key = process.env.STRIPE_SECRET_KEY;
  let body;
  try { body = await req.json(); } catch (e) { return json({ error: 'Bad JSON' }, 400); }

  if (body.action === 'ping') return json({ configured: !!key });
  if (!key) return json({ error: 'Stripe not configured — set STRIPE_SECRET_KEY in Netlify environment variables' }, 400);

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
    if (body.action === 'status') {
      const s = await call('checkout/sessions/' + encodeURIComponent(body.id), {}, 'GET');
      if (s.error) return json({ error: s.error.message }, 400);
      return json({ payment_status: s.payment_status, status: s.status, payment_intent: s.payment_intent });
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

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
