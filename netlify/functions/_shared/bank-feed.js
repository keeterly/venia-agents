// The bank feed, shared by the live proxy (bank.js) and the morning pull
// (bank-sync.js), so both hand the app exactly the same shapes.
//
// Read-only Stripe Financial Connections plumbing: nothing here links, unlinks
// or moves money. Amounts leave in DOLLARS (Stripe returns cents); transaction
// amounts keep Stripe's sign — negative = money out, positive = money in.
import { getStore } from '@netlify/blobs';

// ── keys pasted on a phone ─────────────────────────────────────────────────
// Strip ALL whitespace (a paste from a wrapped display smuggles in line breaks
// mid-key) and map common look-alike characters back to ASCII — real Stripe
// keys are strictly alphanumeric, so any such character is a transcription
// artifact. A key with a non-ASCII char crashes fetch with a cryptic
// "ByteString" error the moment it hits an Authorization header.
const HOMOGLYPHS = {
  'З':'3','з':'3','б':'6','Ч':'4','ч':'4','О':'O','о':'o','А':'A','а':'a',
  'В':'B','в':'B','Е':'E','е':'e','С':'C','с':'c','Р':'P','р':'p','Х':'X',
  'х':'x','У':'Y','у':'y','К':'K','к':'k','М':'M','м':'m','Н':'H','н':'H',
  'Т':'T','т':'t','І':'I','і':'i','Ѕ':'S','ѕ':'s','Ј':'J','ј':'j','Ь':'b',
  'ь':'b','Ѡ':'w','Ԛ':'Q','ԛ':'q','Ԝ':'W','ԝ':'w','ѵ':'v','Ѵ':'V','ԁ':'d',
  'ԍ':'g','ѡ':'w','Ғ':'F','ғ':'f',
  // Seen in the wild in this workspace's key: a dagger where an f belongs
  // (stylized-text artifact), and the common smart-punct swaps.
  '†':'f','‘':"'",'’':"'",'—':'-','–':'-',
};
export const healKey = (v) => String(v || '')
  .replace(/\s+/g, '')
  .replace(/[^\x00-\x7F]/g, (ch) => HOMOGLYPHS[ch] != null ? HOMOGLYPHS[ch] : ch);
export const SK_RE = /^[sr]k_(live|test)_[A-Za-z0-9]+$/;

// ── one Stripe call ────────────────────────────────────────────────────────
// Stripe takes repeated keys for list parameters (features[]=a&features[]=b),
// which an object literal cannot express — so an array value expands into one
// pair per element rather than being stringified into "a,b" and rejected.
const form = (o) => Object.entries(o)
  .flatMap(([k, v]) => (Array.isArray(v) ? v : [v])
    .map((x) => encodeURIComponent(k) + '=' + encodeURIComponent(x))).join('&');
export function stripeCaller(key) {
  return async (path, data, method = 'POST') => {
    const r = await fetch('https://api.stripe.com/v1/' + path, {
      method,
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: method === 'GET' ? undefined : form(data || {}),
    });
    return r.json();
  };
}

// The one Stripe Customer that stands in for VENIA as the account holder.
// FIND ONLY: the morning pull must never create anything in Stripe.
export async function findHolder(call) {
  const s = await call("customers/search?query=" + encodeURIComponent("metadata['venia_bank']:'1'"), {}, 'GET');
  if (s.error) throw new Error(s.error.message);
  return (s.data && s.data[0]) ? s.data[0].id : null;
}

export const slimAccount = (a) => ({
  id: a.id,
  name: a.display_name || a.institution_name || 'Account',
  institution: a.institution_name || '',
  last4: a.last4 || '',
  status: a.status || '',
  // category: cash | credit | investment | other. Only 'cash' is money you
  // HAVE — a credit card or loan balance is money you OWE, and summing the
  // two together is how a dashboard reports catastrophic fake numbers.
  category: a.category || 'other',
  subcategory: a.subcategory || 'other',
  subscriptions: a.subscriptions || [],
  // Balance arrives in cents keyed by currency; surface USD in dollars.
  balance: a.balance ? {
    as_of: a.balance.as_of ? new Date(a.balance.as_of * 1000).toISOString().slice(0, 10) : '',
    current: a.balance.current && a.balance.current.usd != null ? a.balance.current.usd / 100 : null,
    available: a.balance.cash && a.balance.cash.available && a.balance.cash.available.usd != null ? a.balance.cash.available.usd / 100 : null,
    used: a.balance.credit && a.balance.credit.used && a.balance.credit.used.usd != null ? a.balance.credit.used.usd / 100 : null,
    type: a.balance.type || '',
  } : null,
  txn_refresh: a.transaction_refresh ? { status: a.transaction_refresh.status || '',
    // When Stripe will take the next transaction refresh, so a refusal can say
    // "try after 4:10 PM" rather than only "refused".
    next: a.transaction_refresh.next_refresh_available_at
      ? new Date(a.transaction_refresh.next_refresh_available_at * 1000).toISOString() : '' } : null,
});

export const slimTxn = (t) => ({
  id: t.id,
  account: t.account,
  amount: (t.amount || 0) / 100,
  currency: t.currency || 'usd',
  description: String(t.description || '').slice(0, 200),
  status: t.status || '',
  date: t.transacted_at ? new Date(t.transacted_at * 1000).toISOString().slice(0, 10) : '',
});

// ── the day, as the founders count it ──────────────────────────────────────
// VENIA runs on Los Angeles time. A UTC date turns over at 4 or 5 PM there,
// which is how a sync at 7:58 PM counted as "tomorrow" and blocked the next
// morning's. Both the server and the app key "once a day" by this.
export function pacificDay(when) {
  const d = when == null ? new Date() : new Date(when);
  if (isNaN(d)) return '';
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

// ── where the morning pull keeps what it read ──────────────────────────────
// Netlify Blobs, private to this site's functions, the same home the Claude
// connector uses. NOT venia_module_data: the app's push is a three-way merge
// against what each device last agreed with the cloud, and a server writing
// the workspace underneath it is a party that merge was never built for. The
// app takes this feed in through the same merge the device sync uses, so
// there is still one code path that writes the ledger.
const STORE_NAME = 'venia-bank';
const FEED_KEY = 'feed';
let _memory = null;            // test hook: an in-memory stand-in for Blobs
export function useMemoryFeedStore() {
  const m = new Map();
  _memory = {
    async get(k) { return m.has(k) ? JSON.parse(m.get(k)) : null; },
    async setJSON(k, v) { m.set(k, JSON.stringify(v)); },
    _map: m,
  };
  return _memory;
}
function store() {
  if (_memory) return _memory;
  const s = getStore({ name: STORE_NAME, consistency: 'strong' });
  return { get: (k) => s.get(k, { type: 'json' }), setJSON: (k, v) => s.setJSON(k, v) };
}
export async function readFeed() { return (await store().get(FEED_KEY)) || null; }
export async function writeFeed(feed) { await store().setJSON(FEED_KEY, feed); }
