// VENIA OS connector — the tools Claude sees.
//
// READS come straight from venia_module_data, filtered by RLS to what the
// signed-in person may see, and trimmed so a reply never carries a photo, a
// data URL or a credential.
//
// WRITES NEVER TOUCH THE WORKSPACE. Each one files a venia_action object, in
// the exact shape Enigma already emits, into venia_claude_inbox. VENIA OS then
// shows it under "From Claude" and applies it, on a tap, through the same
// agentRunAction handlers Enigma uses: the same checklist, the same Undo, the
// same module and role checks, and the same three-way merge between devices.
// One write path, already tested, instead of a second one on the server that
// could disagree with it.
import { readModules, queueAction, listInbox } from './supa.js';

const MAX_TEXT = 60000;
const SECRETISH = /(token|secret|password|passwd|api_?key|client_?secret|refresh|bearer|vapid|private)/i;
// Settings holds Google client ids, API keys and mail config. Legacy is the
// founders-only pre-module store. Neither is any tool's business.
const NEVER_READ = new Set(['settings', 'legacy']);

// ── trimming ────────────────────────────────────────────────────────────────
function slim(v, depth = 0) {
  if (v == null) return v;
  if (typeof v === 'string') {
    if (/^data:/.test(v) || (v.length > 400 && /^[A-Za-z0-9+/=_-]+$/.test(v))) return '[binary omitted]';
    return v.length > 600 ? v.slice(0, 600) + '…' : v;
  }
  if (typeof v !== 'object') return v;
  if (depth >= 3) return Array.isArray(v) ? '[' + v.length + ' items]' : '[object]';
  if (Array.isArray(v)) {
    const out = v.slice(0, 25).map((x) => slim(x, depth + 1));
    if (v.length > 25) out.push('… ' + (v.length - 25) + ' more');
    return out;
  }
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (SECRETISH.test(k)) continue;
    if (/photo|image|img|thumb|blob|sig(nature)?$/i.test(k) && typeof x === 'string' && x.length > 200) continue;
    out[k] = slim(x, depth + 1);
  }
  return out;
}

// One line per record: the fields that matter first, then other plain fields
// until there are a dozen.
function compact(rec, preferred) {
  if (!rec || typeof rec !== 'object') return rec;
  const out = {};
  const put = (k) => {
    const x = rec[k];
    if (x === undefined || x === null || x === '' || SECRETISH.test(k)) return;
    if (typeof x === 'string') out[k] = x.length > 140 ? x.slice(0, 140) + '…' : x;
    else if (typeof x === 'number' || typeof x === 'boolean') out[k] = x;
    else if (Array.isArray(x) && x.every((y) => typeof y !== 'object')) out[k] = x.slice(0, 10);
  };
  preferred.forEach(put);
  for (const k of Object.keys(rec)) {
    if (Object.keys(out).length >= 12) break;
    if (!(k in out) && !/photo|image|img|url$/i.test(k)) put(k);
  }
  return out;
}

const lc = (s) => String(s == null ? '' : s).toLowerCase();
const nameOf = (r) => (r && (r.name || r.title || r.client || r.outlet || r.headline || r.text || r.desc || r.id)) || '';
const has = (r, text) => !text || lc(JSON.stringify(r)).includes(lc(text));
const eqi = (a, b) => lc(a).trim() === lc(b).trim();
const clampLimit = (n, d = 50) => Math.max(1, Math.min(200, Number(n) || d));

function text(obj) {
  let s = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1);
  if (s.length > MAX_TEXT) s = s.slice(0, MAX_TEXT) + '\n… (cut short; narrow the search to see more)';
  return { content: [{ type: 'text', text: s }] };
}
function fail(msg) { return { content: [{ type: 'text', text: msg }], isError: true }; }

function moduleData(mods, id) { return (mods[id] && mods[id].data) || null; }
function arr(mods, id, key) {
  const d = moduleData(mods, id);
  return d && Array.isArray(d[key]) ? d[key] : null;
}
function noAccess(label) {
  return fail('Nothing to show from ' + label + ': either it is empty or this account has no access to it in VENIA OS.');
}

// ── schemas ─────────────────────────────────────────────────────────────────
const S = {
  str: (description) => ({ type: 'string', description }),
  num: (description) => ({ type: 'number', description }),
  bool: (description) => ({ type: 'boolean', description }),
  date: (description) => ({ type: 'string', description: description + ' (YYYY-MM-DD)' }),
};
const limitProp = { limit: { type: 'integer', description: 'How many to return (default 50, max 200)' } };
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const PROPOSE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const PROPOSE_NOTE = ' This only PROPOSES the change: it waits in VENIA OS under "From Claude" until someone with edit access approves it there. Nothing changes before that.';

// The app writes the log newest-first (unshift), and before Build 579 the sync
// merge appended the other device's copy with no order at all — so neither end
// of the array is reliably "latest". Sort by the entry's own time, every time.
export function newestActivity(log, n) {
  const t = (a) => Date.parse(a && a.ts) || 0;
  return (Array.isArray(log) ? log : []).filter((a) => a && typeof a === 'object')
    .slice().sort((a, b) => t(b) - t(a)).slice(0, n);
}

// ── wholesale orders ────────────────────────────────────────────────────────
// The order read used to pick a dozen plain fields, so payments (an array of
// objects) never made it out and Claude could not tell a paid order from an
// open one. These mirror the app's slTermsSchedule / slDueDate / slOrderPayments
// so the connector says what the order screen says. Read-only: nothing here
// creates, sends or changes a payment.
const SYM = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', CAD: 'C$', AUD: 'A$' };
export function moneyIn(code, n) {
  const c = String(code || 'USD').toUpperCase();
  const v = Math.round((Number(n) || 0) * 100) / 100;
  const cents = v % 1 ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : {};
  return (SYM[c] || c + ' ') + v.toLocaleString('en-US', cents);
}
export function termsSchedule(terms, total) {
  const t = String(terms || '').trim();
  const tot = Number(total) || 0;
  const amt = (pct) => Math.round(tot * pct) / 100;
  const split = (dep) => {
    const d = amt(dep);
    return [
      { key: 'deposit', label: 'Deposit', pct: dep, amount: d, basis: 'order', days: 7 },
      { key: 'balance', label: 'Balance', pct: 100 - dep, amount: Math.round((tot - d) * 100) / 100, basis: 'ship', days: 30 },
    ];
  };
  if (/^30% deposit/.test(t)) return split(30);
  if (/^50% deposit/.test(t)) return split(50);
  if (/^Proforma/i.test(t)) return [{ key: 'full', label: 'Payment in full', pct: 100, amount: amt(100), basis: 'ship', days: 14 }];
  if (/^Credit card on file/i.test(t)) return [{ key: 'full', label: 'Payment in full', pct: 100, amount: amt(100), basis: 'order', days: 1 }];
  const net = t.match(/Net\s*(\d+)/i);
  return [{ key: 'full', label: 'Payment in full', pct: 100, amount: amt(100), basis: 'invoice', days: net ? parseInt(net[1], 10) : 14 }];
}
const plusDays = (iso, d) => {
  const t = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
  if (isNaN(t)) return '';
  t.setUTCDate(t.getUTCDate() + (Number(d) || 0));
  return t.toISOString().slice(0, 10);
};
const shipDateOf = (o) => String((o && (o.deliveryDate || o.shipStart)) || '').slice(0, 10);
function dueDateOf(o, line, rec) {
  if (rec && rec.dueDate) return String(rec.dueDate).slice(0, 10);
  if (line.basis === 'ship') return shipDateOf(o);
  if (line.basis === 'order') return o.createdAt ? plusDays(o.createdAt, line.days) : '';
  return rec && rec.at ? plusDays(rec.at, line.days) : '';
}
// What each status means in words, so "link" is not read as "paid".
const PAY_STATUS = {
  paid: 'paid', link: 'payment link sent, not paid', invoiced: 'invoiced, not paid',
  void: 'void', uncollectible: 'uncollectible',
};
export function orderPayments(o) {
  const recs = Array.isArray(o.payments) ? o.payments.filter((p) => p && typeof p === 'object')
    : (o.payment && o.payment.status ? [o.payment] : []);
  const sched = termsSchedule(o.terms, o.total);
  // An old single o.payment is the first instalment, as the app folds it in.
  const byKey = (k, i) => recs.find((p) => p.key === k) || (!Array.isArray(o.payments) && i === 0 ? recs[0] : null);
  const cur = o.currency || 'USD';
  const lines = sched.map((line, i) => {
    const rec = byKey(line.key, i);
    const status = rec ? String(rec.status || 'pending') : 'not billed';
    const paidAmt = status === 'paid' ? (Number(rec.amountPaid) || Number(rec.amount) || line.amount)
      : (Number(rec && rec.amountPaid) || 0);
    const out = {
      label: line.label, pct: line.pct, amount: Number(rec && rec.amount) || line.amount,
      amountText: moneyIn(cur, Number(rec && rec.amount) || line.amount),
      status, statusText: PAY_STATUS[status] || status, paid: paidAmt,
    };
    const due = dueDateOf(o, line, rec);
    if (due) out.due = due;
    if (rec && rec.paidAt) out.paidAt = String(rec.paidAt).slice(0, 10);
    if (rec && rec.at) out.billedAt = String(rec.at).slice(0, 10);
    if (rec && rec.method) out.method = rec.method;
    if (rec && Number(rec.deduction) > 0) out.deduction = Number(rec.deduction);
    return out;
  });
  const paid = lines.reduce((s, l) => s + (Number(l.paid) || 0), 0);
  const tot = Number(o.total) || 0;
  return { lines, paid, balance: Math.round((tot - paid) * 100) / 100,
    summary: moneyIn(cur, paid) + ' paid of ' + moneyIn(cur, tot) };
}
// Orders carry no season of their own: it lives on the quote they came from,
// or in the "From quote … · SS27" note the app writes.
export function orderSeason(o, quotes) {
  if (o.season) return String(o.season);
  const q = (quotes || []).find((x) => x && (x.id === o.quoteId || (o.id && x.orderId === o.id)));
  if (q && q.season) return String(q.season);
  const m = String(o.notes || '').match(/·\s*((?:SS|FW|AW|PF|RS|Resort|Pre-?Fall)\s?\d{2,4})\b/i);
  return m ? m[1] : '';
}
export function orderView(o, quotes, seasonCal) {
  const season = orderSeason(o, quotes);
  const cal = season && seasonCal && seasonCal[season];
  const win = {};
  const start = shipDateOf(o);
  if (start) win.ships = start;
  if (o.cancelDate) win.cancelDate = String(o.cancelDate).slice(0, 10);
  if (cal && cal.deliveryStart) win.season = cal.deliveryStart + (cal.deliveryEnd ? ' to ' + cal.deliveryEnd : '');
  const pay = orderPayments(o);
  const out = {
    id: o.id, account: o.account || o.buyer || o.buyerName || '', status: o.status || '',
    season: season || undefined, currency: String(o.currency || 'USD').toUpperCase(),
    total: Number(o.total) || 0, totalText: moneyIn(o.currency, o.total),
    units: o.units, terms: o.terms || undefined,
    deliveryWindow: Object.keys(win).length ? win : undefined,
    payments: pay.lines, paid: pay.paid, balance: pay.balance, paymentSummary: pay.summary,
    booked: o.createdAt ? String(o.createdAt).slice(0, 10) : undefined,
    quoteId: o.quoteId || undefined,
  };
  Object.keys(out).forEach((k) => out[k] === undefined && delete out[k]);
  return out;
}

// ── read tools ──────────────────────────────────────────────────────────────
const readTools = [
  {
    name: 'venia_today',
    title: 'Today in VENIA OS',
    description: 'What is on the Today screen of VENIA OS: open tasks the founders added (with ids for complete_task), assignments, and the recent activity log.',
    inputSchema: { type: 'object', properties: {} },
    run(mods) {
      const d = moduleData(mods, 'home');
      if (!d) return noAccess('Today');
      const tasks = (d.todayTasks || []).filter((t) => t && !t.done)
        .map((t) => ({ id: t.id, text: t.text, by: t.by, added: t.at }));
      return text({
        open_tasks: tasks,
        assigned: d.todayAssign || {},
        recent_activity: newestActivity(d.activityLog, 15).map((a) => slim(a)),
        updated_at: mods.home.updated_at,
      });
    },
  },
  {
    name: 'search_venia',
    title: 'Search VENIA OS',
    description: 'Find records by any word (a store, style, editor, vendor, merchant…) across every part of VENIA OS this account can see. Returns where each match lives so a list_ or get_ tool can open it.',
    inputSchema: {
      type: 'object', required: ['text'],
      properties: {
        text: S.str('What to look for'),
        module: { type: 'string', enum: ['home', 'product', 'catalog', 'growth', 'sales', 'money', 'brainstorm'], description: 'Optional: only this part of VENIA OS' },
        ...limitProp,
      },
    },
    run(mods, a) {
      const q = String(a.text || '').trim();
      if (q.length < 2) return fail('Give at least two characters to search for.');
      const hits = [];
      for (const [mod, row] of Object.entries(mods)) {
        if (NEVER_READ.has(mod) || (a.module && a.module !== mod)) continue;
        for (const [key, val] of Object.entries(row.data || {})) {
          if (!Array.isArray(val) || SECRETISH.test(key)) continue;
          val.forEach((r) => {
            if (r && typeof r === 'object' && has(r, q)) hits.push({ module: mod, list: key, id: r.id || '', name: String(nameOf(r)).slice(0, 120) });
          });
        }
      }
      return text({ query: q, matches: hits.slice(0, clampLimit(a.limit, 40)), total: hits.length });
    },
  },
  {
    name: 'list_buyers',
    title: 'List wholesale buyers',
    description: 'The wholesale buyers CRM in VENIA OS (Sales): stores, where they are, stage, tier and last touch.',
    inputSchema: {
      type: 'object',
      properties: { text: S.str('Optional words to match'), stage: S.str('Optional stage or status, e.g. Approached'),
                    country: S.str('Optional country'), ...limitProp },
    },
    run(mods, a) {
      const list = arr(mods, 'sales', 'slBuyers');
      if (!list) return noAccess('Sales');
      const out = list.filter((b) => has(b, a.text)
        && (!a.stage || eqi(b.stage || b.status, a.stage))
        && (!a.country || eqi(b.country, a.country)));
      return text({ total: out.length, buyers: out.slice(0, clampLimit(a.limit)).map((b) => compact(b,
        ['id', 'name', 'location', 'country', 'type', 'tier', 'stage', 'status', 'contactName', 'email', 'lastTouch', 'nextAction', 'nextDue'])) });
    },
  },
  {
    name: 'get_buyer',
    title: 'Open a buyer',
    description: 'One wholesale buyer in full, with the quotes and orders that name them.',
    inputSchema: { type: 'object', required: ['name_or_id'], properties: { name_or_id: S.str('Store name or buyer id') } },
    run(mods, a) {
      const list = arr(mods, 'sales', 'slBuyers');
      if (!list) return noAccess('Sales');
      const key = String(a.name_or_id || '');
      const b = list.find((x) => x && (x.id === key || eqi(x.name, key)))
        || list.find((x) => x && lc(x.name).includes(lc(key)));
      if (!b) return fail('No buyer called "' + key + '". Try search_venia.');
      const mentions = (r) => r && [b.id, b.name].filter(Boolean).some((v) => lc(JSON.stringify(r)).includes(lc(v)));
      return text({
        buyer: slim(b),
        quotes: (arr(mods, 'sales', 'slQuotes') || []).filter(mentions).map((q) => slim(q)),
        // Same view as list_orders, so payments read the same in both places.
        orders: (arr(mods, 'sales', 'slOrders') || []).filter(mentions).map((o) => orderView(o,
          arr(mods, 'sales', 'slQuotes') || [],
          (moduleData(mods, 'product') || {}).seasonCal || (moduleData(mods, 'catalog') || {}).seasonCal || null)),
      });
    },
  },
  {
    name: 'list_orders',
    title: 'List wholesale orders',
    description: 'Wholesale orders in VENIA OS (Sales): account, status, season, total in the order\'s own currency, the delivery window, and each payment instalment (deposit, balance or full) with its amount, due date and status. A status of "link" means a payment link was sent and is NOT paid.',
    inputSchema: {
      type: 'object',
      properties: { status: S.str('Optional status'), buyer: S.str('Optional buyer name'), season: S.str('Optional season, e.g. SS27'), ...limitProp },
    },
    run(mods, a) {
      const list = arr(mods, 'sales', 'slOrders');
      if (!list) return noAccess('Sales orders');
      const quotes = arr(mods, 'sales', 'slQuotes') || [];
      const cal = (moduleData(mods, 'product') || {}).seasonCal || (moduleData(mods, 'catalog') || {}).seasonCal || null;
      const out = list.filter((o) => o && (!a.status || eqi(o.status, a.status))
        && (!a.buyer || has(o, a.buyer)) && (!a.season || eqi(orderSeason(o, quotes), a.season) || has(o, a.season)));
      return text({ total: out.length, orders: out.slice(0, clampLimit(a.limit)).map((o) => orderView(o, quotes, cal)) });
    },
  },
  {
    name: 'list_styles',
    title: 'List the line',
    description: 'Styles in VENIA OS (Product). Founders and Product members get costs; everyone else gets the cost-free catalogue.',
    inputSchema: {
      type: 'object',
      properties: { season: S.str('Optional season'), status: S.str('Optional status'), text: S.str('Optional words to match'), ...limitProp },
    },
    run(mods, a) {
      const src = arr(mods, 'product', 'styles') ? 'product' : (arr(mods, 'catalog', 'styles') ? 'catalog' : null);
      if (!src) return noAccess('Product');
      const out = arr(mods, src, 'styles').filter((s) => has(s, a.text)
        && (!a.season || eqi(s.season, a.season)) && (!a.status || eqi(s.status, a.status)));
      return text({ source: src === 'catalog' ? 'catalogue (no costs)' : 'product', total: out.length,
        styles: out.slice(0, clampLimit(a.limit)).map((s) => compact(s,
          ['id', 'name', 'styleId', 'season', 'category', 'status', 'wholesale', 'retail', 'cogs', 'fabric', 'colors', 'sizes', 'drop', 'stock'])) });
    },
  },
  {
    name: 'get_style',
    title: 'Open a style',
    description: 'One style in full: specs plus its BOM, POM and sample rounds where this account can see Product.',
    inputSchema: { type: 'object', required: ['name_or_id'], properties: { name_or_id: S.str('Style name, style code or id') } },
    run(mods, a) {
      const src = arr(mods, 'product', 'styles') ? 'product' : (arr(mods, 'catalog', 'styles') ? 'catalog' : null);
      if (!src) return noAccess('Product');
      const key = String(a.name_or_id || '');
      const list = arr(mods, src, 'styles');
      const s = list.find((x) => x && (x.id === key || eqi(x.styleId, key) || eqi(x.name, key)))
        || list.find((x) => x && lc(x.name).includes(lc(key)));
      if (!s) return fail('No style called "' + key + '". Try list_styles.');
      const refs = (r) => r && [s.id, s.styleId].filter(Boolean).some((v) => Object.values(r).some((x) => x === v));
      const related = {};
      if (src === 'product') {
        ['bom', 'pom', 'samples'].forEach((k) => {
          const v = arr(mods, 'product', k);
          if (v) related[k] = v.filter(refs).map((r) => slim(r));
        });
      }
      return text({ source: src, style: slim(s), ...related });
    },
  },
  {
    name: 'list_vendors',
    title: 'List vendors',
    description: 'Factories and suppliers in VENIA OS (Product).',
    inputSchema: { type: 'object', properties: { text: S.str('Optional words to match'), type: S.str('Optional type, e.g. Factory'), ...limitProp } },
    run(mods, a) {
      const list = arr(mods, 'product', 'vendors');
      if (!list) return noAccess('Product vendors');
      const out = list.filter((v) => has(v, a.text) && (!a.type || eqi(v.type, a.type)));
      return text({ total: out.length, vendors: out.slice(0, clampLimit(a.limit)).map((v) => compact(v,
        ['id', 'name', 'type', 'location', 'specialty', 'moq', 'contactName', 'email', 'terms', 'status'])) });
    },
  },
  {
    name: 'list_pulls',
    title: 'List press pulls',
    description: 'Sample pulls in VENIA OS (Growth): who has which pieces, pull and return dates, and whether the release is signed.',
    inputSchema: { type: 'object', properties: { status: S.str('Optional status, e.g. out or returned'), text: S.str('Optional words to match'), ...limitProp } },
    run(mods, a) {
      const list = arr(mods, 'growth', 'prPulls');
      if (!list) return noAccess('Growth');
      const out = list.filter((p) => has(p, a.text) && (!a.status || eqi(p.status, a.status)));
      return text({ total: out.length, pulls: out.slice(0, clampLimit(a.limit)).map((p) => ({
        ...compact(p, ['id', 'client', 'contact', 'publication', 'pullType', 'status', 'pullDate', 'shootDate', 'returnDate', 'signed']),
        items: Array.isArray(p.items) ? p.items.map((i) => compact(i, ['style', 'name', 'size', 'color', 'returned'])) : undefined,
      })) });
    },
  },
  {
    name: 'list_coverage',
    title: 'List press coverage and pitches',
    description: 'Press coverage logged in VENIA OS (Growth), plus open pitches.',
    inputSchema: { type: 'object', properties: { text: S.str('Optional words to match'), from: S.date('Optional earliest date'), ...limitProp } },
    run(mods, a) {
      const cov = arr(mods, 'growth', 'prCoverage');
      const pit = arr(mods, 'growth', 'prPitches');
      if (!cov && !pit) return noAccess('Growth');
      const dateOf = (r) => String(r.date || r.publishedAt || r.at || '');
      const lim = clampLimit(a.limit, 30);
      return text({
        coverage: (cov || []).filter((c) => has(c, a.text) && (!a.from || dateOf(c) >= a.from)).slice(-lim)
          .map((c) => compact(c, ['id', 'outlet', 'headline', 'date', 'covType', 'celebRef', 'styles', 'reach', 'aveValue', 'url'])),
        pitches: (pit || []).filter((p) => has(p, a.text)).slice(-lim)
          .map((p) => compact(p, ['id', 'outlet', 'editor', 'angle', 'status', 'date', 'nextAction'])),
      });
    },
  },
  {
    name: 'money_snapshot',
    title: 'Money snapshot',
    description: 'The headline money picture from VENIA OS (Money): business snapshot, bank balances, budgets and the money watch. Founders and Money members only.',
    inputSchema: { type: 'object', properties: {} },
    run(mods) {
      const d = moduleData(mods, 'money');
      if (!d) return noAccess('Money');
      const banks = Array.isArray(d.finBank) ? d.finBank
        : (d.finBank && Array.isArray(d.finBank.accounts) ? d.finBank.accounts : []);
      return text({
        snapshot: slim(d.bizSnap || null),
        accounts: banks.map((b) => compact(b, ['name', 'institution', 'type', 'balance', 'available', 'currency', 'asOf', 'mask'])),
        watch: slim(d.finWatchBrief || d.finWatch || null),
        plan: slim(d.finPlan || null),
        updated_at: mods.money.updated_at,
      });
    },
  },
  {
    name: 'list_transactions',
    title: 'List bank transactions',
    description: 'The bank feed in VENIA OS (Money), newest first. Use the ids with set_txn_category.',
    inputSchema: {
      type: 'object',
      properties: { text: S.str('Optional merchant or words to match'), from: S.date('Optional earliest date'),
                    to: S.date('Optional latest date'), uncategorised: S.bool('Only rows with no category'), ...limitProp },
    },
    run(mods, a) {
      const list = arr(mods, 'money', 'finTxns');
      if (!list) return noAccess('Money');
      const dateOf = (t) => String(t.date || t.postedAt || t.at || '');
      const out = list.filter((t) => has(t, a.text)
        && (!a.from || dateOf(t) >= a.from) && (!a.to || dateOf(t).slice(0, 10) <= a.to)
        && (!a.uncategorised || !(t.category || t.cat)))
        .sort((x, y) => dateOf(y).localeCompare(dateOf(x)));
      return text({ total: out.length, transactions: out.slice(0, clampLimit(a.limit)).map((t) => compact(t,
        ['id', 'date', 'desc', 'merchant', 'amount', 'currency', 'category', 'cat', 'account'])) });
    },
  },
  {
    name: 'list_proposals',
    title: 'Changes waiting in VENIA OS',
    description: 'Changes this connector has proposed and whether each was approved, dismissed or is still waiting in VENIA OS.',
    inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['pending', 'applied', 'dismissed', 'denied'], description: 'Optional filter' } } },
    async run(_mods, a, ctx) {
      const rows = await listInbox(ctx.access, ctx.email, a.status);
      return text({ proposals: rows.map((r) => ({ id: r.id, summary: r.summary, status: r.status, type: r.action && r.action.type,
                                                  proposed: r.created_at, decided: r.decided_at })) });
    },
  },
];

// ── write tools: each files one venia_action for approval ───────────────────
function need(cond, msg) { if (!cond) throw new Error(msg); }
const list = (v) => (Array.isArray(v) ? v : []);
const many = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');

const writeTools = [
  {
    name: 'add_task',
    title: 'Propose a Today task',
    description: 'Propose a task for the Today list in VENIA OS.' + PROPOSE_NOTE,
    inputSchema: { type: 'object', required: ['text'], properties: { text: S.str('The task, in a short line') } },
    build(a) {
      const t = String(a.text || '').replace(/\s+/g, ' ').trim();
      need(t, 'text is required');
      return [{ type: 'today_task_add', text: t.slice(0, 200) }, 'Add to Today: ' + t.slice(0, 120)];
    },
  },
  {
    name: 'complete_task',
    title: 'Propose ticking off a Today task',
    description: 'Propose marking a Today task done. Get the id from venia_today.' + PROPOSE_NOTE,
    inputSchema: { type: 'object', required: ['id'], properties: { id: S.str('Task id from venia_today'), text: S.str('The task text, for the approval card') } },
    build(a) {
      need(a.id, 'id is required');
      return [{ type: 'today_task_done', id: String(a.id) }, 'Mark done: ' + String(a.text || a.id).slice(0, 120)];
    },
  },
  {
    name: 'add_buyers',
    title: 'Propose new buyers',
    description: 'Propose adding stores to the wholesale buyers CRM.' + PROPOSE_NOTE,
    inputSchema: {
      type: 'object', required: ['buyers'],
      properties: { buyers: { type: 'array', minItems: 1, items: { type: 'object', required: ['name'], properties: {
        name: S.str('Store name'), location: S.str('City, State'), country: S.str('Country'), type: S.str('e.g. Concept store'),
        tier: S.str('e.g. dream, target'), fit: S.str('One line on why it fits VENIA'), website: S.str('Website'),
        contactName: S.str('Buyer name'), email: S.str('Buyer email'), phone: S.str('Phone'), address: S.str('Address'),
        approach: S.str('Optional first-move suggestion') } } } },
    },
    build(a) {
      const b = list(a.buyers).filter((x) => x && x.name);
      need(b.length, 'At least one buyer with a name is required');
      return [{ type: 'add_buyers', buyers: b }, 'Add ' + many(b.length, 'buyer') + ': ' + b.slice(0, 4).map((x) => x.name).join(', ')];
    },
  },
  {
    name: 'update_buyers',
    title: 'Propose buyer corrections',
    description: 'Propose changes to existing buyers (fields to set, contacts to add). Use the exact store name.' + PROPOSE_NOTE,
    inputSchema: {
      type: 'object', required: ['updates'],
      properties: { updates: { type: 'array', minItems: 1, items: { type: 'object', required: ['name'], properties: {
        name: S.str('Exact store name'), set: { type: 'object', description: 'Fields to change, e.g. {"location":"Chicago, IL"}', additionalProperties: true },
        addContacts: { type: 'array', items: { type: 'object', properties: { name: S.str('Name'), email: S.str('Email'), role: S.str('Role') } } } } } } },
    },
    build(a) {
      const u = list(a.updates).filter((x) => x && x.name);
      need(u.length, 'At least one update with a store name is required');
      return [{ type: 'update_buyers', updates: u }, 'Update ' + many(u.length, 'buyer') + ': ' + u.slice(0, 4).map((x) => x.name).join(', ')];
    },
  },
  {
    name: 'log_outreach',
    title: 'Propose logging outreach',
    description: 'Propose recording an email or call made to buyers, with the next step.' + PROPOSE_NOTE,
    inputSchema: {
      type: 'object', required: ['touches'],
      properties: { touches: { type: 'array', minItems: 1, items: { type: 'object', required: ['name', 'note'], properties: {
        name: S.str('Exact store name'), note: S.str('What was sent or said'), to: { type: 'array', items: { type: 'string' }, description: 'Addresses it went to' },
        stage: S.str('New stage, e.g. Approached'), nextAction: S.str('Next step'), nextDays: S.num('Days until the next step') } } } },
    },
    build(a) {
      const t = list(a.touches).filter((x) => x && x.name && x.note);
      need(t.length, 'At least one touch with a store name and note is required');
      return [{ type: 'log_outreach', touches: t }, 'Log outreach to ' + t.slice(0, 4).map((x) => x.name).join(', ')];
    },
  },
  {
    name: 'set_order_status',
    title: 'Propose an order status',
    description: 'Propose a new status for wholesale orders.' + PROPOSE_NOTE,
    inputSchema: {
      type: 'object', required: ['items'],
      properties: { items: { type: 'array', minItems: 1, items: { type: 'object', required: ['order', 'status'], properties: {
        order: S.str('Order number, e.g. ORD-XYZ'), status: S.str('New status'), note: S.str('Why') } } } },
    },
    build(a) {
      const i = list(a.items).filter((x) => x && x.order && x.status);
      need(i.length, 'At least one order with a status is required');
      return [{ type: 'set_order_status', items: i }, i.slice(0, 4).map((x) => x.order + ' → ' + x.status).join(', ')];
    },
  },
  {
    name: 'record_payment',
    title: 'Propose recording a payment',
    description: 'Propose recording money received against a wholesale order.' + PROPOSE_NOTE,
    inputSchema: {
      type: 'object', required: ['items'],
      properties: { items: { type: 'array', minItems: 1, items: { type: 'object', required: ['order', 'amount', 'date'], properties: {
        order: S.str('Order number'), amount: S.num('Amount received, in the order currency'), date: S.date('Date received'),
        method: S.str('e.g. wire, card'), note: S.str('Note') } } } },
    },
    build(a) {
      const i = list(a.items).filter((x) => x && x.order && Number(x.amount) > 0 && x.date);
      need(i.length, 'Each payment needs an order, a positive amount and a date');
      return [{ type: 'record_payment', items: i }, 'Record ' + many(i.length, 'payment') + ': ' + i.slice(0, 3).map((x) => x.order + ' ' + x.amount).join(', ')];
    },
  },
  {
    name: 'create_pull',
    title: 'Propose a press pull',
    description: 'Propose a sample pull for an editor or stylist, ready to send for signature from VENIA OS.' + PROPOSE_NOTE,
    inputSchema: {
      type: 'object', required: ['client', 'items'],
      properties: {
        client: S.str('Publication or stylist'), contact: S.str('Contact name'), email: S.str('Contact email'),
        pullType: { type: 'string', enum: ['editorial', 'celebrity', 'event', 'other'], description: 'Kind of pull' },
        publication: S.str('Usage, e.g. Vogue US September issue'), pullDate: S.date('Pull date'), returnDate: S.date('Return date'),
        shootDate: S.date('Shoot date'), photographer: S.str('Photographer'), notes: S.str('Notes'),
        items: { type: 'array', minItems: 1, items: { type: 'object', required: ['style'], properties: {
          style: S.str('Exact style name'), size: S.str('Size'), color: S.str('Colour') } } },
      },
    },
    build(a) {
      need(a.client, 'client is required');
      const items = list(a.items).filter((x) => x && x.style);
      need(items.length, 'At least one item is required');
      // draftEmail stays false: nothing leaves VENIA OS from this connector.
      const act = { type: 'create_pull', ...a, items, draftEmail: false };
      return [act, 'Pull for ' + a.client + ': ' + many(items.length, 'piece')];
    },
  },
  {
    name: 'log_coverage',
    title: 'Propose logging press coverage',
    description: 'Propose recording press that ran.' + PROPOSE_NOTE,
    inputSchema: {
      type: 'object', required: ['outlet', 'headline'],
      properties: {
        outlet: S.str('Publication or platform'), headline: S.str('What ran'), url: S.str('Link'),
        covType: S.str('e.g. editorial, celebrity, social'), celebRef: S.str('Artist or person, if any'),
        styles: { type: 'array', items: { type: 'string' }, description: 'Exact style names featured' },
        reach: S.num('Estimated reach'), aveValue: S.num('Advertising value equivalent'), pullId: S.str('Pull id, if it came from one'), notes: S.str('Notes'),
      },
    },
    build(a) {
      need(a.outlet && a.headline, 'outlet and headline are required');
      return [{ type: 'log_coverage', ...a }, 'Coverage: ' + a.outlet + ', ' + String(a.headline).slice(0, 90)];
    },
  },
  {
    name: 'update_styles',
    title: 'Propose style changes',
    description: 'Propose setting fields on styles, chosen by name or by a match such as season and status.' + PROPOSE_NOTE,
    inputSchema: {
      type: 'object', required: ['set'],
      properties: {
        names: { type: 'array', items: { type: 'string' }, description: 'Exact style names' },
        match: { type: 'object', description: 'Or a match, e.g. {"season":"SS27","status":"development"}', additionalProperties: true },
        set: { type: 'object', description: 'Fields to set, e.g. {"drop":"2027-02-01"}', additionalProperties: true },
      },
    },
    build(a) {
      need(a.set && typeof a.set === 'object' && Object.keys(a.set).length, 'set needs at least one field');
      need(list(a.names).length || (a.match && Object.keys(a.match).length), 'Give names or a match');
      // Prices and costs move through price_from_retail and the cost sheet in
      // the app, where the margin maths lives, never through a bare field set.
      const blocked = Object.keys(a.set).filter((k) => /cogs|cost|margin|wholesale|retail|price/i.test(k));
      need(!blocked.length, 'Prices and costs are changed in VENIA OS itself, not through the connector: ' + blocked.join(', '));
      const act = { type: 'update_styles', set: a.set };
      if (list(a.names).length) act.names = a.names; else act.match = a.match;
      const who = act.names ? act.names.slice(0, 4).join(', ') : JSON.stringify(act.match);
      return [act, 'Set ' + Object.keys(a.set).join(', ') + ' on ' + who];
    },
  },
  {
    name: 'add_vendors',
    title: 'Propose new vendors',
    description: 'Propose adding factories or suppliers.' + PROPOSE_NOTE,
    inputSchema: {
      type: 'object', required: ['vendors'],
      properties: { vendors: { type: 'array', minItems: 1, items: { type: 'object', required: ['name'], properties: {
        name: S.str('Company name'), type: S.str('e.g. Factory, Mill'), location: S.str('City, Country'),
        specialty: S.str('What they are known for and why they fit'), moq: S.str('Minimums, if known'),
        website: S.str('Website'), contactName: S.str('Contact'), email: S.str('Email') } } } },
    },
    build(a) {
      const v = list(a.vendors).filter((x) => x && x.name);
      need(v.length, 'At least one vendor with a name is required');
      return [{ type: 'add_vendors', vendors: v }, 'Add ' + many(v.length, 'vendor') + ': ' + v.slice(0, 4).map((x) => x.name).join(', ')];
    },
  },
  {
    name: 'set_txn_category',
    title: 'Propose transaction categories',
    description: 'Propose categories for bank transactions, by id or by a description match.' + PROPOSE_NOTE,
    inputSchema: {
      type: 'object', required: ['items'],
      properties: { items: { type: 'array', minItems: 1, items: { type: 'object', required: ['category'], properties: {
        id: S.str('Transaction id from list_transactions'),
        match: { type: 'object', properties: { desc: S.str('Words in the description, e.g. HISCOX') } },
        category: S.str('Category, e.g. insurance') } } } },
    },
    build(a) {
      const i = list(a.items).filter((x) => x && x.category && (x.id || (x.match && x.match.desc)));
      need(i.length, 'Each item needs a category and either an id or a match');
      return [{ type: 'set_txn_category', items: i }, 'Categorise: ' + i.slice(0, 4).map((x) => (x.id || x.match.desc) + ' → ' + x.category).join(', ')];
    },
  },
  {
    name: 'add_to_brainstorm',
    title: 'Propose a Brainstorm note',
    description: 'Propose dropping a note or idea on the Brainstorm scratchpad.' + PROPOSE_NOTE,
    inputSchema: {
      type: 'object', required: ['text'],
      properties: { kind: { type: 'string', enum: ['note', 'idea', 'goal'], description: 'Kind of entry' }, title: S.str('Optional title'),
                    text: S.str('The thought, in the founder’s own words'), steps: { type: 'array', items: { type: 'string' } }, due: S.date('Optional due date') },
    },
    build(a) {
      need(a.text, 'text is required');
      return [{ type: 'add_to_brainstorm', kind: a.kind || 'note', title: a.title || '', text: a.text, steps: list(a.steps), due: a.due || '' },
              'Brainstorm: ' + String(a.title || a.text).slice(0, 100)];
    },
  },
];

export const TOOLS = [
  ...readTools.map((t) => ({ ...t, annotations: { title: t.title, ...READ } })),
  ...writeTools.map((t) => ({ ...t, annotations: { title: t.title, ...PROPOSE } })),
];
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function listTools() {
  return TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations }));
}

export async function callTool(name, args, ctx) {
  const tool = BY_NAME.get(name);
  if (!tool) return fail('Unknown tool: ' + name);
  const a = (args && typeof args === 'object') ? args : {};
  try {
    if (tool.build) {
      const [action, summary] = tool.build(a);
      const row = await queueAction(ctx.access, ctx.email, action, summary);
      return text('Proposed in VENIA OS: ' + summary + '\nIt is waiting under "From Claude" in the app (proposal ' + (row && row.id) + '). '
        + 'Nothing has changed yet; it applies when someone with edit access approves it there.');
    }
    const mods = tool.name === 'list_proposals' ? {} : await (ctx.modules || (ctx.modules = readModules(ctx.access)));
    return await tool.run(mods, a, ctx);
  } catch (e) {
    return fail(e && e.message ? e.message : String(e));
  }
}
