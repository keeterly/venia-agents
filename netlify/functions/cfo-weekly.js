import webpush from 'web-push';

// THE AUTONOMOUS WEEKLY BRIEF. Monday morning, the CFO speaks first —
// whether or not anyone opens the app.
//
// The client-side brief only ran when a founder launched VENIA OS, which meant
// a quiet week was a silent CFO. This is a scheduled function: it reads the
// money picture a signed-in device published with the daily digest (the same
// venia_digest_fetch RPC and shared secret — no new table, no new SQL), asks
// the model for a short honest read, and pushes it to both phones.
//
// Fail-boring by design: no secret, no VAPID keys, no published finance blob,
// or a stale one (nobody has opened the app in 3 days) → it does nothing at
// all rather than pushing figures that may have moved.
const SB_URL = 'https://unxfaeqjskzzmhyrekqx.supabase.co';
const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVueGZhZXFqc2t6em1oeXJla3F4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4NDgxMTQsImV4cCI6MjA5MzQyNDExNH0.tqKiJJZE9iz29g9hIscLeMir4PhBMeTU8fbI04eC6xY';

const money = (n) => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n || 0)).toLocaleString('en-US');

export default async () => {
  const secret = process.env.VENIA_DIGEST_SECRET;
  const vapidPub = process.env.VAPID_PUBLIC_KEY;
  const vapidPriv = process.env.VAPID_PRIVATE_KEY;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!secret || !vapidPub || !vapidPriv || !key) return new Response('weekly brief not configured', { status: 200 });

  let payload = null;
  try {
    const r = await fetch(SB_URL + '/rest/v1/rpc/venia_digest_fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SB_ANON, Authorization: 'Bearer ' + SB_ANON },
      body: JSON.stringify({ p_secret: secret }),
    });
    payload = await r.json();
  } catch (e) { return new Response('fetch failed', { status: 200 }); }
  if (!payload || payload.error) return new Response('unauthorized or empty', { status: 200 });

  const subs = Array.isArray(payload.subs) ? payload.subs.slice(0, 12) : [];
  const items = payload.items || {};
  const fin = items.fin;
  if (!subs.length || !fin) return new Response('nothing to brief', { status: 200 });
  // Money that moved days ago is not a brief, it is a rumour.
  if (!items.at || (Date.now() - new Date(items.at).getTime()) > 3 * 24 * 3600 * 1000) {
    return new Response('finance snapshot stale — skipped', { status: 200 });
  }

  const facts = [
    fin.connected ? `Cash on hand ${money(fin.cash)} (floor ${money(fin.floor)}). Owed on cards/loans ${money(fin.debt)}. Net position ${money(fin.net)}.`
                  : 'Bank not connected — no cash, burn or runway figures exist.',
    fin.connected ? `Last 30 days: in ${money(fin.in30)}, out ${money(fin.out30)}. Monthly ${fin.burn > 0 ? 'net burn ' + money(fin.burn) : 'net surplus ' + money(-fin.burn)}. Runway ${fin.runway == null ? 'n/a' : fin.runway + ' months'}.` : '',
    `Revenue YTD ${money(fin.revYtd)} (DTC ${money(fin.dtcYtd)}, wholesale booked ${money(fin.wsBooked)}, collected ${money(fin.wsCollected)}). Operating ${money(fin.operating)}${fin.opexYtd != null ? `, after ${money(fin.opexYtd)} of operating expense from the bank feed` : ''}.`,
    // Operating excludes outflow nobody has classified. Quoting the figure
    // without that is stating profit more confidently than the app does.
    fin.opexUncat ? `CAVEAT: ${money(fin.opexUncat)} of spending this year is still uncategorized and is NOT in operating expense, so operating is overstated by up to that much. Do not quote profit as settled without naming this.` : '',
    fin.ar ? `Receivables outstanding ${money(fin.ar)}${fin.arOldest ? `; oldest ${fin.arOldest.acct} ${money(fin.arOldest.amt)}${fin.arOldest.days > 0 ? ` (${fin.arOldest.days}d overdue)` : ''}` : ''}.` : 'No open receivables.',
    (fin.cat30 && fin.cat30.length) ? `Spend last 30d: ${fin.cat30.map((c) => c[0] + ' ' + money(c[1])).join(', ')}.` : '',
    fin.tight ? `Projected cash dips to ${money(fin.tight.cash)} the week of ${fin.tight.week} — below their floor.` : 'No projected dip below the cash floor in the next 90 days.',
    (fin.committed && fin.committed.length) ? `Committed and dated: ${fin.committed.map((e) => `${e[0]} ${e[1] === 'in' ? '+' : '−'}${money(e[2])} ${e[3]}`).join('; ')}.` : '',
    (fin.alerts && fin.alerts.length) ? `Already flagged to them: ${fin.alerts.join(' | ')}.` : '',
    fin.uncat ? `${fin.uncat} bank transactions are uncategorized, so burn and runway are estimates.` : '',
  ].filter(Boolean).join('\n');

  let text = '';
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 700,
        system: `You are the CFO of VENIA Collection, a two-person luxury womenswear label in Los Angeles, writing the Monday money brief that lands on both founders' phones as a push notification.

Under 55 words. No greeting, no sign-off, no headings. Lead with the single most important truth about their position — the number first. Then at most one more fact that changes a decision, then ONE specific action for this week.

Use only the figures given. Never invent one. If the bank is not connected or figures are flagged as estimates, say so in as few words as possible rather than implying precision. Say a hard thing plainly — a thin runway named early is the most useful thing you can give them. Do not repeat an alert they have already been shown unless it is now the most important fact.`,
        messages: [{ role: 'user', content: 'This week\'s figures:\n' + facts }],
      }),
    });
    if (!r.ok) return new Response('model error', { status: 200 });
    const data = await r.json();
    text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
  } catch (e) { return new Response('model call failed', { status: 200 }); }
  if (!text) return new Response('empty brief', { status: 200 });

  webpush.setVapidDetails('mailto:keeter@veniacollection.com', vapidPub, vapidPriv);
  const note = JSON.stringify({
    title: fin.connected ? 'Money · ' + money(fin.cash) + ' cash' : 'Monday money brief',
    body: text.slice(0, 320),
    tag: 'venia-cfo-weekly',
  });
  await Promise.allSettled(subs.map((s) => webpush.sendNotification(s, note)));
  return new Response('weekly brief sent to ' + subs.length + ' device(s)', { status: 200 });
};

// Mondays at 15:00 UTC — 8am Pacific, an hour after the daily digest so the
// two never arrive on top of each other.
export const config = { schedule: '0 15 * * 1' };
