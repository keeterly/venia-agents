// THE LEDGER IS FRESH BEFORE ANYONE LOOKS.
//
// The bank feed only moved when a founder opened VENIA OS, once per day, and
// "day" was the UTC date. A sync at 7:58 PM in Los Angeles counted as the next
// UTC day, so the next morning's open did nothing until 4 PM, and Money showed
// a ledger that stopped days ago. This scheduled function pulls the feed every
// morning, keyed by the Pacific date, so the app has today's data waiting.
//
// TWO STEPS, BECAUSE STRIPE ANSWERS LATER. A transaction refresh is asked for
// and finishes on Stripe's side in seconds to a few minutes, and a scheduled
// function gets 30 seconds. So the first run of a Pacific day asks Stripe to
// refresh every active account; a later run (at least 20 minutes on) reads
// the accounts and the last 60 days of transactions and keeps them. Every run
// after that on the same day does nothing. If a refresh is still pending, the
// read waits for up to three more runs, then reads what has landed.
//
// WHERE IT GOES. Into Netlify Blobs (see _shared/bank-feed.js), never into the
// workspace. The app reads it through bank.js ('cached', behind the access
// code) and folds it into the ledger with the same merge the device sync uses:
// matched by Stripe's transaction id, statement-imported rows absorbed rather
// than doubled, categories filed by hand kept. So a transaction can arrive from
// this pull and from a device sync on the same day and still be one row.
//
// Read-only, and fail-boring: no Stripe key, no linked bank, or any Stripe
// error leaves the stored feed as it was, and the next run tries again. It
// needs nothing beyond STRIPE_SECRET_KEY, which bank.js already uses.
import {
  healKey, SK_RE, stripeCaller, findHolder, slimAccount, slimTxn,
  pacificDay, readFeed, writeFeed,
} from './_shared/bank-feed.js';

const WINDOW_DAYS = 60;          // how far back each pull reads and keeps
const SETTLE_MS = 20 * 60e3;     // refresh → read
const MAX_WAITS = 3;             // extra runs to wait on a pending refresh
const PAGE_CAP = 25;             // 100 rows a page, per account
const BUDGET_MS = 22000;         // stay well inside the 30s limit

export default async (req) => {
  // Netlify invokes a scheduled function with { next_run } and gives it no
  // public address on the live site; refusing anything else keeps it that way.
  let ev = null;
  try { ev = await req.json(); } catch (_) { ev = null; }
  if (!ev || !ev.next_run) return new Response('Not found', { status: 404 });
  try {
    const out = await runMorningPull({ key: healKey(process.env.STRIPE_SECRET_KEY) });
    return new Response(out, { status: 200 });
  } catch (e) {
    // Nothing was written; the next run starts the same step again.
    return new Response('bank pull failed: ' + String(e && e.message || e).slice(0, 160), { status: 200 });
  }
};

const iso = (ms) => new Date(ms).toISOString();
const label = (a) => (a.display_name || a.institution_name || 'Account') + (a.last4 ? ' ••' + a.last4 : '');

async function listAccounts(call) {
  const holder = await findHolder(call);
  if (!holder) return null;
  const list = await call('financial_connections/accounts?account_holder[customer]='
    + encodeURIComponent(holder) + '&limit=25', {}, 'GET');
  if (list.error) throw new Error(list.error.message);
  return list.data || [];
}

export async function runMorningPull({ key, now = Date.now(), call } = {}) {
  if (!SK_RE.test(String(key || ''))) return 'stripe not configured';
  call = call || stripeCaller(key);
  const started = Date.now();
  const today = pacificDay(now);
  const prev = await readFeed();
  const st = (prev && prev.day === today) ? prev : null;
  if (st && st.phase === 'done') return 'already pulled for ' + today;

  // ── step 1: ask Stripe for fresh data ─────────────────────────────────────
  if (!st) {
    const accounts = await listAccounts(call);
    if (!accounts) return 'no bank linked';
    const active = accounts.filter((a) => a.status === 'active');
    if (!active.length) return 'no active accounts';
    const refreshed = [], refreshIssues = [];
    for (const a of active) {
      const path = 'financial_connections/accounts/' + a.id + '/refresh';
      // Transactions first; Stripe rate-limits those, and a refusal there
      // still leaves the balance worth asking for (the same order as bank.js).
      let r = await call(path, { 'features[]': ['balance', 'transactions'] });
      if (!r.error) { refreshed.push(a.id); continue; }
      r = await call(path, { 'features[]': 'balance' });
      if (r.error) refreshIssues.push({ id: a.id, name: label(a), step: 'refresh', error: String(r.error.message || 'failed').slice(0, 200), at: iso(now) });
    }
    await writeFeed({
      // Yesterday's rows stay until the read replaces them, so the app never
      // sees an empty feed between the two steps.
      ...(prev || {}),
      day: today, phase: 'refreshing', refreshedAt: iso(now), refreshed, refreshIssues, waits: 0,
    });
    return 'refresh asked for ' + active.length + ' account(s)';
  }

  // ── step 2: read what landed ──────────────────────────────────────────────
  if (now - Date.parse(st.refreshedAt || 0) < SETTLE_MS) return 'refresh settling';
  const accounts = await listAccounts(call);
  if (!accounts) return 'no bank linked';
  const refreshed = st.refreshed || [];
  const pending = accounts.filter((a) => refreshed.indexOf(a.id) >= 0
    && a.transaction_refresh && a.transaction_refresh.status === 'pending');
  if (pending.length && (st.waits || 0) < MAX_WAITS) {
    await writeFeed({ ...st, waits: (st.waits || 0) + 1 });
    return pending.length + ' refresh(es) still pending';
  }

  const since = pacificDay(now - WINDOW_DAYS * 864e5);
  const issues = [];
  const byId = {};
  // Keep what earlier pulls read inside the window, so a page that was not
  // reached this time does not drop rows the app may not have yet.
  const live = {}; accounts.forEach((a) => { if (a.status !== 'disconnected') live[a.id] = 1; });
  (Array.isArray(st.transactions) ? st.transactions : []).forEach((t) => {
    if (t && t.id && live[t.account] && String(t.date || '') >= since) byId[t.id] = t;
  });
  let complete = true;
  for (const a of accounts) {
    if (a.status !== 'active') continue;     // Stripe refuses reads on the rest
    let cursor = null;
    for (let page = 0; page < PAGE_CAP; page++) {
      if (Date.now() - started > BUDGET_MS) { complete = false; break; }
      let qs = 'account=' + encodeURIComponent(a.id) + '&limit=100';
      if (cursor) qs += '&starting_after=' + encodeURIComponent(cursor);
      const list = await call('financial_connections/transactions?' + qs, {}, 'GET');
      if (list.error) { issues.push({ id: a.id, name: label(a), step: 'transactions', error: String(list.error.message || 'failed').slice(0, 200), at: iso(now) }); break; }
      const rows = (list.data || []).map(slimTxn);
      rows.forEach((t) => { if (t.date >= since) byId[t.id] = t; });
      // Newest first: once a page reaches past the window, the rest is older.
      const oldest = rows.length ? rows[rows.length - 1].date : '';
      if (!list.has_more || !rows.length || (oldest && oldest < since)) break;
      cursor = rows[rows.length - 1].id;
    }
  }
  // One entry per account, the transaction read outranking the refresh: a
  // refresh that was refused but a read that worked is "behind", not "broken".
  const byAcct = {};
  (st.refreshIssues || []).concat(issues).forEach((i) => { if (!byAcct[i.id] || i.step === 'transactions') byAcct[i.id] = i; });
  const transactions = Object.values(byId).sort((x, y) => String(y.date || '').localeCompare(String(x.date || '')));
  await writeFeed({
    day: today, phase: 'done', at: iso(now), since, complete,
    accounts: accounts.map(slimAccount),
    transactions,
    issues: Object.values(byAcct),
  });
  return 'pulled ' + transactions.length + ' transaction(s) since ' + since + (complete ? '' : ' (partial)');
}

// Every 30 minutes from 11:15 to 14:45 UTC: 3:15–6:45 AM Pacific in winter,
// 4:15–7:45 AM in summer. The first run of the Pacific day asks for the
// refresh, the next one reads, the rest do nothing. All of them land on the
// same Pacific date in either season, and Money is current before the 7 AM
// digest goes out.
export const config = { schedule: '15,45 11-14 * * *' };
