import webpush from 'web-push';

// THE CFO PLANNER — a multi-pass financial planning engine.
//
// A real plan is not one model call. This runs a chain of specialist passes,
// each seeing the previous one's output, with an adversarial CRITIC in the
// middle whose only job is to find what is wrong:
//
//   1. ANALYST  — establish the baseline from the data alone (run rates,
//                 seasonality, margin structure, fixed vs variable cost).
//   2. PLANNER  — build the month-by-month plan on that baseline.
//   3. CRITIC   — adversarially verify: does the arithmetic reconcile, is each
//                 assumption grounded in the data, what is missing or unsafe?
//   4. REVISER  — fix what the critic found and emit the final plan as
//                 narrative + one strict JSON block the app can act on.
//
// It is a "-background" function so Netlify returns 202 immediately and allows
// up to 15 minutes — the founders can close the app while it thinks. Write-back
// uses the same secret-scoped RPC as agent-background (no service-role key).
const SB_URL = 'https://unxfaeqjskzzmhyrekqx.supabase.co';
const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVueGZhZXFqc2t6em1oeXJla3F4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4NDgxMTQsImV4cCI6MjA5MzQyNDExNH0.tqKiJJZE9iz29g9hIscLeMir4PhBMeTU8fbI04eC6xY';

const ALLOWED_ORIGINS = new Set([
  'https://creator.veniacollection.com',
  'https://venia-creator.netlify.app',
  'https://main--venia-creator.netlify.app',
]);
function originAllowed(req) {
  const o = req.headers.get('origin');
  if (o) return ALLOWED_ORIGINS.has(o);
  const site = (req.headers.get('sec-fetch-site') || '').toLowerCase();
  return site === 'same-origin' || site === 'same-site';
}
async function complete(id, secret, status, result) {
  try {
    await fetch(SB_URL + '/rest/v1/rpc/venia_complete_agent_job', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SB_ANON, Authorization: 'Bearer ' + SB_ANON },
      body: JSON.stringify({ p_id: id, p_secret: secret, p_status: status, p_result: result }),
    });
  } catch (_) { /* the client's stale sweep is the backstop */ }
}

const BRAND = `VENIA Collection — a two-person luxury womenswear label in Los Angeles.
Retail $280–$1,400. Channels: DTC (Shopify), wholesale (Stripe invoices, net terms), and live events.
There is no finance team: every recommendation must be executable by two people who are also the designers.`;

const RULES = `HARD RULES — these are not style preferences:
• Use ONLY numbers present in the DATA below. Never invent a figure. If something needed is missing, name it explicitly as a gap and proceed with a clearly-labelled assumption.
• Cash accounts are money HELD. Credit-card and loan balances are money OWED. Never add them together or call debt "cash".
• Booked revenue is not collected revenue. Wholesale invoices are paid on terms, and some are never paid.
• The bank feed covers linked accounts only and may be partly uncategorized — treat heavy uncategorized volume as a stated confidence limit, not something to smooth over.
• Round to whole dollars. Every month's arithmetic must reconcile: revenue − cogs − opex = net; cash_end = prior cash_end + net.`;

async function callModel(key, system, user, maxTokens) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: maxTokens || 8192,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!r.ok) {
    let d = 'HTTP ' + r.status;
    try { const e = await r.json(); if (e && e.error && e.error.message) d = e.error.message; } catch (_) {}
    throw new Error(d);
  }
  const data = await r.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  if (!text) throw new Error('empty reply');
  return text;
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('', { status: 405 });
  if (!originAllowed(req)) return new Response('', { status: 403 });

  let p;
  try { p = JSON.parse(await req.text()); } catch (_) { return new Response('', { status: 400 }); }
  const { id, secret, snapshot } = p || {};
  if (!id || !secret || !snapshot) return new Response('', { status: 400 });

  const gateHash = (process.env.VENIA_GATE_HASH || process.env.STRIPE_GATE_HASH || '').toLowerCase();
  if (gateHash) {
    const sent = req.headers.get('x-venia-code') || '';
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sent));
    const hex = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
    if (!sent || hex !== gateHash) return new Response('', { status: 401 });
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { await complete(id, secret, 'error', 'ANTHROPIC_API_KEY is not set'); return new Response('', { status: 500 }); }

  const horizon = Math.max(3, Math.min(24, parseInt(p.horizon, 10) || 12));
  const goal = String(p.goal || '').slice(0, 600);
  const DATA = String(snapshot).slice(0, 120000);
  const pushSubs = Array.isArray(p.push) ? p.push.slice(0, 12) : [];

  try {
    // ── PASS 1 — ANALYST: what is true today, before any planning ──────────
    const baseline = await callModel(key,
      `You are a financial analyst reading a small fashion brand's live operating data.\n\n${BRAND}\n\n${RULES}\n\nYou do NOT plan or advise here. You establish the factual baseline the plan will rest on.`,
      `DATA:\n${DATA}\n\nEstablish the baseline. Report, with the figures behind each:\n`
      + `1. Revenue run rate by channel (DTC vs wholesale), and what the data does and does not tell us about seasonality.\n`
      + `2. Margin structure: landed cost vs price across the line; which styles carry the business and which destroy value.\n`
      + `3. Cost base: what is being spent monthly, split into what looks fixed vs variable, from the bank categories available.\n`
      + `4. Cash and obligations: cash held, owed on cards/loans, receivables outstanding, factory commitments.\n`
      + `5. GAPS — every number a competent CFO would need that is absent or untrustworthy here. Be specific and blunt.\n\n`
      + `Plain prose and short tables. No recommendations.`,
      6000);

    // ── PASS 2 — PLANNER: the month-by-month plan on that baseline ──────────
    const plan = await callModel(key,
      `You are the CFO of VENIA building its ${horizon}-month financial plan.\n\n${BRAND}\n\n${RULES}\n\nThe plan must be defensible line by line: every figure traces to the baseline or to a stated, justified assumption.`,
      `BASELINE (from the analyst):\n${baseline}\n\nRAW DATA:\n${DATA}\n\n`
      + (goal ? `FOUNDERS' STATED GOAL: ${goal}\n\n` : '')
      + `Build the ${horizon}-month plan:\n`
      + `1. Assumptions — each with the figure and the evidence for it.\n`
      + `2. Month-by-month: DTC revenue, wholesale revenue, total revenue, COGS, operating expense, net, and ending cash. Arithmetic must reconcile every month.\n`
      + `3. The targets this implies — revenue goals and marketing budget lines the founders should actually set.\n`
      + `4. Risks: what breaks this plan, how likely, what to do about each.\n`
      + `5. The first five actions, in order, with timing.\n\n`
      + `Be honest about a hard position if the data shows one — a plan that flatters is worthless.`,
      10000);

    // ── PASS 3 — CRITIC: an adversarial subagent hunting for what is wrong ──
    const critique = await callModel(key,
      `You are a sceptical CFO reviewing another CFO's plan for a two-person brand. Your ONLY job is to find what is wrong. A plan that survives you must be arithmetically sound and grounded in evidence. Do not be polite; do not praise. If something is right, say nothing about it.`,
      `THE DATA THE PLAN WAS BUILT FROM:\n${DATA}\n\nBASELINE:\n${baseline}\n\nTHE PLAN:\n${plan}\n\n`
      + `Find every one of these that applies:\n`
      + `• ARITHMETIC: months where revenue − cogs − opex ≠ net, or cash_end doesn't roll from the prior month, or totals don't sum.\n`
      + `• FABRICATION: any figure that does not trace to the data or to a stated assumption.\n`
      + `• CATEGORY ERRORS: debt treated as cash, booked treated as collected, credit-card balances added to cash.\n`
      + `• OPTIMISM: growth, collection or cost assumptions the history does not support.\n`
      + `• OMISSION: obligations, costs or risks present in the data that the plan ignores.\n`
      + `• EXECUTABILITY: anything that assumes staff, systems or time two people do not have.\n\n`
      + `List each issue as: SEVERITY (blocking / serious / minor) — what is wrong — the correct treatment. If you genuinely find nothing in a category, write "none" for it.`,
      6000);

    // ── PASS 4 — REVISER: fix everything found, emit the final artifact ─────
    const finalOut = await callModel(key,
      `You are the CFO of VENIA finalising the plan after review.\n\n${BRAND}\n\n${RULES}\n\nYou must fix every blocking and serious issue the reviewer raised. Where you disagree with the reviewer, say so explicitly and justify it with the data.`,
      `THE DATA:\n${DATA}\n\nYOUR DRAFT PLAN:\n${plan}\n\nREVIEWER'S FINDINGS:\n${critique}\n\n`
      + `Produce the final plan in TWO parts.\n\n`
      + `PART 1 — the brief the founders read. Under 500 words, plain language, leading with the single most important truth about their position. Cover what the plan does, the few numbers that matter, the main risk, and the first actions. Then one short line: what the review changed.\n\n`
      + `PART 2 — on its own, after the brief, exactly ONE fenced block and nothing after it:\n`
      + '```venia:plan\n'
      + `{"horizon_months":${horizon},"generated_for":"VENIA","headline":"one sentence on the position",`
      + `"assumptions":[{"label":"","value":"","basis":""}],`
      + `"months":[{"month":"YYYY-MM","dtc":0,"wholesale":0,"revenue":0,"cogs":0,"opex":0,"net":0,"cash_end":0}],`
      + `"targets":{"revenue_goals":[{"name":"","target":0,"period":"monthly","source":""}],"budget":[{"item":"photoshoots","budget":0}]},`
      + `"risks":[{"risk":"","likelihood":"high|medium|low","mitigation":""}],`
      + `"actions":[{"action":"","when":"","why":""}],`
      + `"gaps":["what the data could not tell us"],`
      + `"verification":{"issues_fixed":[""],"issues_disputed":[""],"confidence":"high|medium|low","confidence_reason":""}}\n`
      + '```\n\n'
      + `JSON rules: every month from the next calendar month forward, ${horizon} entries, whole dollars, arithmetic reconciling exactly. "budget" items ∈ photoshoots | influencer | adspend | events | misc. "period" ∈ monthly | quarterly | annual | seasonal. "source" ∈ "" | dtc-30 | dtc-ytd | wholesale-ytd | total-ytd. Set confidence honestly — if the bank feed is thin or largely uncategorized, it is not "high".`,
      12000);

    await complete(id, secret, 'done', finalOut);

    if (pushSubs.length && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_PUBLIC_KEY) {
      try {
        webpush.setVapidDetails('mailto:keeter@veniacollection.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
        const note = JSON.stringify({ title: 'Your financial plan is ready',
          body: 'The CFO built and self-reviewed a ' + horizon + '-month plan — open Money → CFO Agent.', tag: 'venia-cfo-plan' });
        await Promise.allSettled(pushSubs.map((s) => webpush.sendNotification(s, note)));
      } catch (_) {}
    }
    return new Response('', { status: 200 });
  } catch (e) {
    await complete(id, secret, 'error', String((e && e.message) || 'planning failed'));
    return new Response('', { status: 200 });
  }
};
