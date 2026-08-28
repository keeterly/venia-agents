# VENIA OS — Open Items & Architecture Notes

_Last reviewed at Build 324._

## ✅ Settled (kept here so they are not re-litigated)

- **Hosting: Netlify.** Live at `creator.veniacollection.com` (site `venia-creator`).
  Chosen over GitHub Pages for the serverless functions — every secret
  (Anthropic, Shopify, Stripe) lives in a Netlify env var and is reached through
  a function, never from the browser.
- **Supabase: connected and locked.** Project `VENIA CC`
  (`unxfaeqjskzzmhyrekqx`). RLS is enabled on every `venia_*` table; the ones
  carrying real data are restricted to the two founder emails, and tables with
  no policy deny all by default. Verified at Build 319 — including
  `venia_daily_digest`, which now carries the finance blob the Monday brief
  reads.
- **Bank feed: connected.** Chase via Stripe Financial Connections, read-only.
  `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY` and `VENIA_GATE_HASH` are set;
  the Financial Connections registration was approved.

## Open

- **Delete the old Stripe secret keys.** Several were created while getting the
  bank connected, including one that passed through a chat transcript. The live
  key in Netlify is the only one needed — remove the rest in Stripe →
  Developers → API keys. Rolling the live one is fine too; paste the
  replacement into Netlify and `/api/bank` `{"action":"ping"}` reports whether
  it authenticates.
- **Run the financial plan.** Money → Plan → Build the plan. Nothing grades a
  plan until one exists, so plan-vs-actual reporting stays unbuilt until then.
- **Tune Money Watch.** The thresholds (cash floor, runway, burn spike, margin
  floor) ship with placeholder defaults, not opinions about this business.

---

# CFO Agent — how it fits together

**Money pages** (grouped by the question each answers):
`Overview` what needs you now · `Cash` accounts, ledger, 90-day calendar ·
`P&L` · `Orders` · `Plan` financial plan + Money Watch · `Goals` · `Budget`.

**Where the numbers come from**
| Source | Via | Feeds |
|---|---|---|
| Shopify | `functions/shopify.js` (read-only allowlist) | DTC revenue, per-style sales |
| Stripe invoices | `functions/stripe.js` (money actions gated) | wholesale AR, collections |
| Chase | `functions/bank.js` (read-only, fails closed) | cash, debt, transactions |
| PLM | in-app cost sheets + BOM | landed cost, margins |

**The three things that run without being asked**
1. Money Watch alerts → the Today brief → the existing 7 AM push.
2. `functions/cfo-weekly.js` — Mondays 15:00 UTC, reads the finance blob a
   device published with the daily digest and pushes a short brief. Needs no
   app to be open; goes silent if that data is more than 3 days old.
3. The weekly written brief, generated on first app open of a new week.

**Agent runs are server-side.** CFO chat queues to
`cfo-chat-background.js` first (15-min window, push on completion) with the
direct streaming path as the fallback. The financial plan is
`cfo-plan-background.js`: analyst → planner → **adversarial critic** → reviser.

**Invariants worth protecting** (each was a real bug; each has a test)
- Cash accounts are money held; card and loan balances are money **owed**.
  Never summed. Mirror cards on one credit line count once.
- Wholesale revenue is dated by `createdAt` (booking), collections by
  `payment.paidAt` — never by `updatedAt`, which moves on every edit.
- Two fabrications of one silhouette share a name by design, so DTC sales are
  matched to a **group** of styles, not each one, or COGS doubles.
- Cash-calendar events carry `committed` / `expected` / `estimated` and the
  agent must never flatten them. Recurring detection covers overhead only —
  fabric and production are already counted as dated PO obligations.
- The agent drafts and files; **it never moves money.** Invoices and card
  captures stay behind the human access-code gate.
- Every bulk write is one undo. The ledger's bulk set and the agent's
  `set_txn_category` share `__agPrevTxnCats`, and both surface the same Undo.
- **The Money overview leads with cash**, then AR, then what we owe, then
  profit. Profit is a scoreboard; cash is the constraint. The claims line
  (bank − what we owe + what is owed to us) is the number that ends seasons.
- **A wholesale payment can be recorded without Stripe** (`record_payment`).
  Wholesale in this segment settles by wire; before this only a Stripe invoice
  could move an order out of AR, so paid orders sat there forever. It records
  a payment that already happened — it never moves money, and it must never
  infer one from an order merely being old.
- **Operating expense comes from the bank feed**, not the Budget Tracker.
  Overhead categories are charged; `fabric` and `production` are excluded
  because landed cost already carries them into COGS; `transfer` and `income`
  are not spend. Uncategorized outflow is reported as the margin of error,
  never guessed into the total. With a feed the Budget Tracker is a plan and
  is not subtracted as well — that would charge marketing twice.
- Expense categories are **built-ins plus whatever the founders added**. Every
  validation site goes through `finAllCats()`, and the CFO's action spec is
  built at call time so a new category is immediately filable by the agent.
- The ledger's ask box sends the CFO the **rows on screen, by id** — ticked
  ones if any, else exactly what the filter shows. It never asks the agent to
  guess at a transaction it was not shown.

**Tests:** `node check.js` (inline script syntax) plus 16 suites in the session
scratchpad covering the money math, agent actions, ledger editing, custom
categories, operating expense, cloud-run conversation shape, and instruction
drift. A Playwright harness (`scratchpad/gauntlet`) drives the real app at
390px and 1440px against a seeded workspace — use it before claiming a UI or
a number is right; several apparent bugs turned out to be malformed fixtures.
