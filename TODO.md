# VENIA OS — Open Items & Architecture Notes

_Last reviewed at Build 345._

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

- **Marketing and Brand own no actions of their own** — their work is
  drafting, which needs none. If campaign or calendar records ever become
  real objects, they get actions and the remit map is where to add them.

- **Delete the old Stripe secret keys.** Several were created while getting the
  bank connected, including one that passed through a chat transcript. The live
  key in Netlify is the only one needed — remove the rest in Stripe →
  Developers → API keys. Rolling the live one is fine too; paste the
  replacement into Netlify and `/api/bank` `{"action":"ping"}` reports whether
  it authenticates.
- **Run the financial plan.** Money → Plan → Build the plan. Nothing grades a
  plan until one exists, so plan-vs-actual reporting stays unbuilt until then.
- **Tune Money Watch.** The thresholds ship as placeholder defaults. The CFO
  can now set them itself (`set_money_watch`) — ask it to calibrate them once
  it has enough of the cash rhythm to justify each number.
- **The floating agent dock overlaps a section-action button** at the bottom
  right on desktop (the Production block's "POs →"). Pre-existing; more
  visible now that content reaches the right edge.

---

# Agents — who owns what

Each named agent gets the actions it OWNS, an index of who owns the rest, and
one way to pass work along (`handoff`, which asks before it moves you). An
agent handed every action in the app is worse at its own work — that is why
the CFO timed out until Build 306.

| Agent | Owns | Prompt |
|---|---|---|
| CFO (`fin`) | money — cash, P&L, margins, AR, PO schedules, budgets, pricing | ~2.6k |
| Sales (`sl`) | wholesale — buyers CRM, outreach, quotes, orders | ~1.4k |
| PR (`pr`) | press — pulls, pitches, coverage, editor radar | ~2.0k |
| Marketing (`mk`) | campaigns, launches, captions, calendar | ~0.8k |
| Brand (`br`) | voice, guidelines, references, competitor watch | ~0.8k |

**Eni is deliberately exempt** and keeps every action. It follows whatever
screen you are on, and being able to ask it anything from anywhere is what
makes scoping the named agents safe rather than obstructive. Nothing is ever
unreachable: a scoped agent hands off, or you ask Eni where you already are.

**Presence is not delivery.** Builds 324–332 wrote four money specs into a
function the CFO is never handed, so its persona promised capabilities it
could not invoke. A suite now asserts what each agent RECEIVES.

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
- **A buyer's stage is derived, not just stored** (`slBuyerStage`). An account
  with a live order IS doing business; one with a quote out IS in
  conversation. The stored field wins only where it is ahead of the record or
  unknowable from it — `inactive` is a judgement no order book can make and is
  never overridden. The edit form and stage picker still show the STORED
  value, because they exist to change that field.
- **The CFO can change what a style costs** (`set_cost_sheet`). It mirrors the
  form's writer exactly — including writing the landed total back to
  `style.cogs`, the single source of truth every margin reads. A partial
  update keeps what it does not mention. It must never invent a cost.
- **The CFO maintains the PO payment schedule** (`set_po_terms`), not the PO
  itself — placing a factory order is production's call. The 90-day cash
  calendar is built from `depositPct`, `depositDue`, `balanceDue` and
  `exFactory`; without them a PO is one undated lump. PO units per style are
  what sell-through is measured against.
- **The CFO tunes its own alert thresholds** (`set_money_watch`), and is told
  never to widen one to silence an alert that is telling the truth.
- **A collection is the unit that pays for itself.** The P&L rolls up BY
  SEASON — revenue by channel, gross margin, sell-through against units
  actually ordered from the factory, account concentration. A style with no
  season is left out, never bucketed; with no PO units sell-through reads
  "unknown", never 0% or 100%.
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
- **The dock composer is sized by the DOCK, not the screen.** Three 38px attach
  buttons plus send left the field 176px of 390 — under half the width — so a
  one-line question wrapped to six lines. That width happens on a phone (full
  screen) and on a tablet or narrow window, where the floating panel bottoms out
  at 392px, so a screen-width media query fixed the phone and left the tablet
  broken. A container query on `#sk-dock` now gives the field its own full-width
  row below 430px of dock, with the phone media query restating it for browsers
  without container queries.
- **The dock sizes to the visible viewport, not `100dvh`.** iOS does not shrink
  the layout viewport for the keyboard, and `dvh` tracks the collapsing URL bar,
  not the keyboard — so the dock stayed 844px tall while 508px was visible, the
  composer sat below the fold, and iOS scroll-shifted the page to chase the
  caret. That was the band of dead black under the input. `skViewportFit()` sets
  height and top from `visualViewport`, publishes `--sk-fmax` so the field is
  capped against what is actually VISIBLE (a vh cap does not shrink for the
  keyboard), and scrolls the newest message back into view when the reading area
  halves. Starter prompts stand down while the keyboard is up — their display is
  set inline, so that decision has to live in JS, and `skSuggestFit()` is its one
  owner.
- **Every dock turn runs server-side.** The dock used to call the model in the
  foreground, so a long run — rewriting margin targets across 57 styles — died
  the moment the screen locked or the app was closed. Eni and Nigma now queue to
  `cfo-chat-background` exactly as the CFO does: the phone's job is one small
  POST, a push says when it is done, and the reply lands in the working bubble
  it was sent from. The direct streaming relay is the fallback for when the
  cloud cannot be reached. Nothing streamed in the dock anyway, so the only cost
  is poll granularity, and the poll opens at 1.2s before backing off.
  The job record PERSISTS who asked and which screen's actions the reply may
  run, because it can be picked up after a reload or on the other phone. The
  user's turn is saved before the request goes out — otherwise closing the app,
  which is the whole point, would orphan the answer. A cloud reply is policed
  exactly like a direct one (unbacked claims, malformed blocks, one action per
  turn, same Undo): a push saying something was filed is even harder to go back
  and check. A job that ages out says so rather than spinning forever.
- **The agent's context follows the work, not the calendar.** `plmContext()`
  used to give full per-style detail to "the two newest seasons" — so one
  placeholder style in a future season crowded out the entire season being
  sold. With SS27 (57 styles, 54 priced), FW27 (1) and SS28 (1), the agent was
  handed two stubs, told the real line was "details on request", and asked the
  founder to fetch prices it was holding. Seasons now fill a 140-line budget,
  starting with whatever Styles is filtered to. Every season also gets a
  one-line **wholesale economics** summary — count, priced count, average,
  median, range, booked, sell-in goal and units-to-goal — whether or not its
  styles are listed, so a "how many units to reach $X" question is arithmetic
  the agent already holds. Averaging 54 prices by hand is exactly where an
  agent invents a number.
- **A margin shown to a human is the one the prices produce**, never the
  stored target. `marginTarget` / `wsMarginTarget` are INPUTS to the pricing
  math, and only the pricing popover writes them back — so a price changed any
  other way (the agent's `update_styles` or `price_from_retail`, an inline
  cell, an import) left the target behind and the panel reported a margin the
  numbers beside it did not support. Every display reads `pxMarginLive` /
  `pxWsMarginLive`; a target the prices no longer meet is shown as a note
  rather than substituted for the truth. `pxTargetCogs` and Work back still
  aim at the target — that is what a target is for.

**Contracts are tested, not assumed.** One suite asserts that every specced
agent action is dispatched and has a runner, every undo an action card offers
exists, every `fin.*` key a scheduled function reads is one the app publishes,
and every bank action the client calls is handled server-side. Each of those
failures looks like nothing happening, which is also what success looks like.

**The autonomous chain is verified live.** A signed-in device publishes the
finance blob with the daily digest; `venia_daily_digest.items.fin` carried all
23 keys `cfo-weekly.js` reads when checked at Build 329. A test now asserts
that contract, so a key renamed in the app cannot silently break the Monday
brief — the function would just go quiet, which is the one failure mode
nobody would notice.

**Tests:** `node check.js` (inline script syntax) plus 46 suites in the session
scratchpad covering the money math, agent actions, ledger editing, custom
categories, operating expense, cloud-run conversation shape, and instruction
drift. A Playwright harness (`scratchpad/gauntlet`) drives the real app at
390px and 1440px against a seeded workspace — use it before claiming a UI or
a number is right; several apparent bugs turned out to be malformed fixtures.
