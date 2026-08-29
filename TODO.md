# VENIA OS — Open Items & Architecture Notes

_Last reviewed at Build 359._

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
- **Web Push: configured at Build 350.** `VAPID_PUBLIC_KEY` had been set alone
  since 16 July with no private half, so nothing ever sent — the dock, the 7 AM
  brief and the weekly money brief all skipped silently on
  `if (VAPID_PRIVATE_KEY && VAPID_PUBLIC_KEY)`. A fresh pair is now installed.
  Two things to know if it is ever touched again: a Netlify **secret** env var
  cannot use the `all` context (the API accepts the write and drops it — the
  only way to notice is to re-read the list), so `VAPID_PRIVATE_KEY` is scoped
  to `production`; and **function env changes need a redeploy** to take effect.
  The app no longer hardcodes the public key — it reads `/vapid-key` — so a
  future rotation is a Netlify change plus a deploy, with no code edit.

- **Bank feed: connected.** Chase via Stripe Financial Connections, read-only.
  `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY` and `VENIA_GATE_HASH` are set;
  the Financial Connections registration was approved.

## Open

- **Marketing and Brand own no actions of their own** — their work is
  drafting, which needs none. If campaign or calendar records ever become
  real objects, they get actions and the remit map is where to add them.

- **⚠️ ROTATE THE GOOGLE OAUTH CLIENT SECRET.** A `GOCSPX-` client secret had
  been pasted into the "Picker API key" field. It was stored in
  `STATE.googleApiKey`, which syncs — so it sat in every device's localStorage
  AND in `venia_workspace.data` in Supabase. Build 353 refuses it, purges it
  from both, and the cloud copy was cleared; but a secret that has been in a
  browser and a database has to be rotated at the source: Google Cloud Console
  → APIs & Services → Credentials → the OAuth client → Reset secret. The app
  never needed it — Drive signs in with the Client ID alone. Drive attach has
  in fact NEVER worked, because that field wants an `AIza…` Picker API key;
  create one (Credentials → Create credentials → API key) and paste it there.

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
- **A colourway belongs to a FABRIC, not a style.** A lab dip is of a material:
  Black in linen is a different dip, approval and lead time from Black in
  leather. Colours were a loose comma string on the style with nothing tying
  them to the fabric, so a style could carry a colour that fabric had never been
  dyed in. Three levels now, each named: the MATERIAL holds the colours that
  fabric comes in, the STYLE holds which of them it is cut in (not every style
  in linen is cut in every linen colour), and the SWATCH stays brand-wide so
  Black looks like Black everywhere. A one-time union lifts every existing style
  colour onto its fabric — idempotent, nothing lost. A colour the fabric does
  not list is shown under "On this style only" with one tap to file it, never
  dropped: changing a style's fabric is exactly how those appear. Retiring a
  colour from a fabric is cross-style, so it confirms and names how many styles
  lose the option.
- **A backdrop click never discards a form.** One global handler closed any open
  `.overlay`, so a stray click beside the four-tab pull cart threw away
  everything typed. An overlay can now carry `data-no-backdrop-close`; the pull
  cart does, leaving ✕ and Cancel as the ways out. The cart also holds its shape
  between tabs — Client Info is tall and Items short, so the shell collapsed
  ~330px, sliding the footer under the cursor and opening dark area exactly
  where you were about to click.
- **A draft pull is findable.** `Active` correctly excludes drafts — they are not
  out yet — but a draft was then reachable only under `All`, with no count
  anywhere, so a half-built pull with samples in it simply vanished. A `Drafts N`
  tab appears when there are any, and the empty Active tab points at them.
- **Season is editable in the table**, like fabric, colorway, category and
  gender — it was the one identity field that needed the full Edit Style modal,
  and the one most often wrong on an imported or duplicated style. Free text, so
  a season that does not exist yet can be typed straight in. `stEnumSet` already
  calls `styleResyncCode`, so moving a style renumbers its code to the next free
  number in the new season and keeps the old one as `prevStyleId`.
- **Brainstorm is a SPACE, not a takeover.** It rendered as a full-viewport
  overlay at z-9200 that covered the global bar and the space nav, drew its own
  ✕ as the only way back, and used the opposite typographic treatment to every
  other screen — an Apple large title (28px, weight 800, -0.02em, sentence case,
  shrinking on scroll) beside an app whose titles are uppercase Archivo at 6px
  tracking. In-app it now starts below the 44px bar at z-400, marks BRAINSTORM
  active, and uses `.cpl-hero` / `.cpl-title` / `.cpl-sub`, `.pill` tabs and one
  gutter matching the hero (48px desktop, 16px phone). The standalone
  home-screen app (`?app=brainstorm`) stays full-bleed — it has no VENIA chrome
  to sit under, and keeps the ⤢ OS button instead of a ✕. Navigating to any other
  space dismisses the sheet: making the nav clickable was only half the job, and
  `cpGoto` is the one place every space button, the phone's bottom bar and the
  drawer all pass through.
- **A Stripe invoice line must NAME its invoice.** A $200 pull fee reached the
  stylist's inbox as "Invoice paid $0.00". The invoiceitem was created with no
  `invoice` id, which leaves it PENDING, and API-created invoices default to
  `pending_invoice_items_behavior: 'exclude'` — so the line was never attached.
  An empty invoice finalises as already paid. The invoice is now created FIRST
  and the line names it, and the finalised total is checked against what was
  asked for BEFORE the send: a mismatch voids the invoice and refuses, because
  a wrong invoice in a buyer's inbox cannot be taken back. The pull records
  what Stripe billed, not what was typed, so the two can never disagree.
- **No Stripe key ever enters the browser.** Settings carried two Stripe cards
  sharing the same element ids, so `getElementById` only ever found the first —
  the real status went to the top card while the second sat frozen on "Not set"
  with the key live in Netlify all along. The second card also asked for a live
  SECRET key, and `prStripeRequest` read it back to call api.stripe.com straight
  from the page. `functions/stripe.js` had done all of it server-side behind the
  access code since it was written; the browser path was simply never retired.
  Both PR money flows (invoice, payment link) now go through it, the card and
  the input are gone, and a key stored before Build 352 is purged on boot.
  Status is probed from the server when the section opens rather than waiting
  for someone to press "Test Connection" — "Not tested" reads as "not set up".
- **Prices are stored in USD; the currency picker changes the VIEW only.** A
  line sheet has to be readable in the buyer's money, but the costing chain
  must not move — so `fxFmt()` converts what is shown and nothing else, and the
  pricing popover (the editing surface) stays in USD and says so when a
  converted view is active. The rate is the FOUNDER'S, set once and shown
  wherever converted money is, not live FX: a wholesale price quoted at market
  opens has to hold for the season, and a line sheet that moved with the spot
  rate would quote a Paris buyer differently on Tuesday than on Monday. A
  currency with no rate set stays in USD rather than inventing one.
- **A style's Delivery falls back to the season calendar.** Most of a line ships
  in one window and a handful are a second delivery, so `styleDelivery()` is the
  same stored-wins-else-derived shape as origin and category, and an inherited
  value renders muted. It is free text on purpose — brands write a delivery as a
  date, a window ("Feb-Mar 27") or a drop name ("Delivery 2"), and a date picker
  would make two of those unsayable.
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
- **A cloud reply is applied exactly once.** `cfoChatPoll` had no re-entrancy
  guard, and Builds 345 and 346 added two more callers (visibilitychange,
  `skRestorePending`) on top of the chained timer. Two overlapping polls read the
  same finished row before either deleted it, so the reply posted twice — the
  second labelled "· cloud" because the first had consumed the working bubble —
  and **its action ran twice**. A repeated price pass happens to be idempotent;
  a repeated `add_buyers` or `record_payment` is a real duplicate. A busy flag
  stops the overlap; `cfoChatClaim()` is the claim that survives it, taken
  BEFORE the delete await. Proven both ways in a browser: without the guard,
  four polls produced four replies and four action runs.
- **Who to push is the server's question, not the browser's.** The dock's worker
  sent only to the subscriber list the page attached, read from an RLS-protected
  table with every failure swallowed — not signed in, a transient error, a tab
  that never authenticated all mean no push, silently. It now fetches
  subscribers through the same secret-scoped RPC the scheduled digest always
  used, with the client list as fallback, and retires any endpoint the push
  service reports 404/410 (`venia_push_sub_drop`) instead of letting it hold one
  of the twelve slots for ever.
- **There is a push self-test.** "I never got a notification" had five
  indistinguishable causes — VAPID keys unset, no subscription, an expired one,
  permission denied, or an iOS app never added to the Home Screen. Today →
  "test notification" sends one through the real path and names which it was,
  per device.
- **A poller may only delete jobs it queued.** `venia_agent_jobs` is shared by
  three of them. Two fetch by id; `delegPoll` (Brainstorm delegations) selected
  EVERY row and deleted it — a queued row past 16 minutes outright, and any
  finished row that was not a Brainstorm item applied to nothing and deleted
  anyway. The dock's job vanished from under it and it waited out its own
  17-minute window on a row that no longer existed. The landmine was old; Build
  344 routed every dock turn over it. `delegPoll` now filters by kind server-side
  AND skips foreign kinds in the loop, and the dock deletes its own stale rows
  since nothing else sweeps them.
- **A run still in flight is visible when you come back.** `skRenderHistory`
  redrew the saved question with no working indicator, so reopening the app
  mid-run looked dead and invited a re-send — from a dock that had just told the
  founder to close the app. `skRestorePending()` puts the working bubble back on
  open and on every redraw, re-attached so the reply lands in it.
- **A failed run offers a button, not an instruction.** "Send “try again”"
  means retyping on a phone keyboard, and it re-queues down the path that just
  died. `skRetryLast()` drops the failed exchange (so the retry replaces the
  question rather than stacking a second copy) and re-runs it directly.
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

**Tests:** `node check.js` (inline script syntax) plus 57 suites in the session
scratchpad covering the money math, agent actions, ledger editing, custom
categories, operating expense, cloud-run conversation shape, and instruction
drift. A Playwright harness (`scratchpad/gauntlet`) drives the real app at
390px and 1440px against a seeded workspace — use it before claiming a UI or
a number is right; several apparent bugs turned out to be malformed fixtures.

## Build 360 — a fabric has one list of colours, and you can see them
- **The bug Keeter caught:** "bamboo jersey is black but the colorway shows no
  black." Two fields meant the same thing. The Materials modal has always
  written its "Available Colors" box to `material.color`; Build 359 gave
  colourways to the fabric and read a `material.colors` it invented, filled
  only by a lift over colours already on styles. Bamboo Jersey was the one
  fabric a human had typed into rather than one the lift reached, so its Black
  sat in the field nothing read.
- `matColors(m)` reads both halves and dedupes case-insensitively;
  `matSetColors(m, list)` is the only writer and empties the legacy half.
  `matMergeColorFields()` folds them together once (`STATE.__matColorMerge`),
  as a union, and says how many colours it recovered.
- **Invariant: nothing reads `m.color` directly any more.** Every fabric chip
  goes through `matSwatch(m, fallback)`; every colourway reader through
  `matColors`. A new reader on the raw field re-opens this bug.
- Materials tab is swatched: the card block splits into one band per colour
  (`matSwatchBlock`), a "Colours:" row lists them as chips, and a fabric with
  none says "none yet" — that silence is what hid the Black.
- EDIT MATERIAL shows live chips under Available Colors (`mmColorChips`); a
  chip sets the brand-wide swatch (`mmSetColorHex`) and saves on the spot,
  because a swatch belongs to the brand, not to this material's edit.

## Build 361 — a hold instead of a charge; a photo instead of a style ID
- **"an option for putting a hold on a card as well instead of just a charge."**
  The server has done manual-capture authorizations since the deposit flow was
  built (`create` with `hold:true`, plus `capture`/`cancel`); the only door to
  one was the NFC finish sheet. The payment modal now has a **Hold Card** tab:
  amount defaults to the retail on loan (security), not the pull fee (revenue).
- **Invariant: an authorization dies after 7 days.** That is the card networks.
  It is stated before the hold is created, and `prHoldRender` turns it into a
  date; past it, the panel says to expect a capture to fail rather than showing
  a button that lies. Anything longer than a week should be a deposit + refund.
- `prPayRepaint(pullId)` replaced the bare `prTagFinish(pullId)` calls in
  check/capture/release — those popped the NFC sheet open over whatever surface
  you were actually on. It repaints only what is on screen.
- A hold now shows on the pull detail even when there is no fee at all: real
  money is reserved on someone's card and only we can end it.
- **"the search bar should also show fabric and image"** — `prThumb` and
  `prFabLine` (fabric swatch + name + colourway dots) in the search results, the
  cart rows and the sample items. Two LARA VESTs in different fabrications were
  distinguishable only by a style ID.
- **"in the pull sheet itself, it should include the image"** — the PDF gets a
  56×70 photo column and the fabric under the style name; `tr{page-break-inside:
  avoid}` and `print-color-adjust:exact` so it survives the print dialog.
- Photos are read live via `prItemStyle(item)`, never copied onto the pull item:
  a re-shot photo reaches old sheets, and STATE does not carry a second copy of
  every image.
