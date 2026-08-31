# VENIA OS — Open Items & Architecture Notes

_Last reviewed at Build 401._

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

## Build 362 — Money gets a tab
- **"money doesnt have a tab at the top."** It never had one. The Money screen
  (`cp-screen-cmd`) has always had its own nav headed "Money" — Overview, Cash,
  P&L, Orders, Plan, Goals, Budget — but the only ways in were a door on Today
  and a link in the pulse, and `cpGoto` mapped `cmd` to the **today** highlight,
  so standing in Money lit TODAY.
- Money is now a tab in the desktop bar and the phone bottom bar (six tabs; the
  label drops its letter-spacing under 430px so PRODUCT cannot clip), and `cmd`
  highlights **money** in both. Nothing maps `cmd` to `today` any more.
- The drawer's "Go to" list was missing Growth *and* Money; both added.

## Build 363 — the CFO could not write a category you invented
- **"the CFO agent wasnt writing the changes to the transactions."** It could
  not. `save()` persists ONLY the keys in `SYNC_KEYS`, and `finCats` — the spend
  categories the founders create — was never in that list. Every category typed
  into "+ Add category" lived in memory and died on reload, while the
  transactions filed into it kept pointing at a name the app no longer knew.
  `finAllCats()` then rejected it, so `set_txn_category` answered
  "unknown category" and wrote nothing.
- **Proven against the live workspace**: 43 transactions filed under six
  categories (dining, insurance, parking, materials, office-supplies, travel)
  and no `finCats` key in the synced blob at all.
- **Invariant: a key left out of `SYNC_KEYS` is not a smaller bug than the
  feature it belongs to.** `finCats` is now synced, and `finCatsHeal()` rebuilds
  the list from the filings that outlived it (idempotent, additive, logged).
- `catOpts` always includes the row's own value — a filed row can never render
  as "—". `bankSetCategory` repaints the count that was saying it hadn't saved,
  while holding the just-filed row on screen ("Filed ✓") so nothing vanishes
  under the cursor.
- The CFO's item cap went 40 → 200, and anything past it is the FIRST thing
  reported. An unknown category now lists the ones that exist.
- **Where the money goes** (Money → Cash): spend by category with share bars,
  30d/90d/YTD/all, uncategorized called out as outside the total, every row a
  tap into the transactions behind it. The P&L's flat opex list got the same
  bars and the same drill-down.
- Every category is a tag now, built-in or not — only the ones you made carry a
  ×. Showing just the custom six made the founders' own vocabulary look bolted
  on and hid the built-in names entirely.
- **A default is not an observation.** `sample: 'Proto'` is what a style is born
  with; the briefing read it as "58 styles stuck at Proto" while all 57 were at
  stage SMS. `plmContext` now names both fields and says "no sample logged" when
  the sample log is empty.

## Build 364 — a piece that isn't in Styles
- **"How do I add custom styles that are not in the system here?"** You couldn't.
  The pull search matched existing styles only and answered a name it had never
  seen with "No styles found" — a dead end at the rail.
- The search now offers **+ Add "<what you typed>"** whenever that exact style
  does not already exist (not only on zero matches — "LARA VEST (archive)" is a
  real thing to pull and it partial-matches).
- A one-off carries `oneOff: true`, its own editable name and retail, no
  invented style code, and rides the sheet, the email, the return flow and the
  fee exactly like any other item. `prItemStyle` finds nothing, so its photo
  hatches rather than borrowing someone else's.
- **Invariant: it never pretends to be a catalogue style.** The row says "Not in
  Styles"; nothing is written to the Styles library.
- `prCartRetail` updates the cart total and the fee without re-rendering the row
  out from under the cursor.

## Build 365 — the pull is signed for, and the email is the agreement
- **Playtest of the whole pull system** (draft → client → items → pricing/terms
  → review → finalize → email → PDF → list → returns → close → payment): sound
  end to end. Two things were missing entirely.
- **The email was a teaser.** It listed the pieces and said "the full pull sheet
  with terms is available on request" — on a handover document whose purpose IS
  the terms. No value on loan, no fee, no return date, nothing to agree to. It
  now carries all of it, plus an explicit line to reply to, and the subject says
  whether it is signed or awaiting confirmation.
- **Invariant: one draft for every path that emails a pull.** The agent-created
  pulls had their own thinner template; `agentDraftPullEmail` now delegates to
  `prSendEmail(pull, opener)`. Two templates for one agreement is how only one
  of them ever gets fixed.
- **Signature confirmation** (`prSignOpen`): the stylist signs on the phone at
  handover. Canvas at device pixel ratio, pointer events (finger/stylus/mouse),
  name required, mark required. `prTermsLines()` is the single definition of the
  terms, shown in the pad, printed on the sheet, sent in the email.
- **The signature freezes what it covered** — terms, item count, retail value —
  so a later edit can never look like it was signed for. `prSignDrift()` says
  which of the three changed.
- The sheet prints the real signature and its timestamp; unsigned still prints
  the ink line. Finalizing opens the pad while the stylist is still in the room.

## Build 366 — mail that comes from VENIA
- **"The email defaulted to this when finalizing — it should be from
  info@veniacollection.com."** The pull sheet went out from a personal iCloud
  address. Not a bug in the draft: **a `mailto:` link cannot set a From
  address.** The phone's mail app picks its own default account, and no amount
  of client-side work changes that. The only way mail leaves as info@ is if a
  server sends it.
- `netlify/functions/mail.js` — Resend behind the existing origin check and the
  access-code gate (fail-closed). **Invariant: `from` is set by the server and
  never read from the request**, or the endpoint becomes a way to send mail as
  anyone. `MAIL_FROM` overrides via env only; defaults to
  `VENIA Collection <info@veniacollection.com>`.
- `prMailBuild()` writes the message once in plain text **and** HTML;
  `prSendEmail()` sends it. The HTML sheet carries no `data:` images — Gmail
  strips them, and a broken box in the one place we cannot see it is worse than
  no photo.
- **The app never claims more than it did.** If the server is not connected it
  still drafts in the mail app, and says the mail will leave from *your* account
  rather than info@. A real send records `emailedAt` / `emailedFrom`, and the
  pull detail shows both.
- Settings → API Keys has an Email card: connected state, the address mail
  leaves from, and the Resend + DNS steps.
- **Needs from Keeter:** a Resend account, `veniacollection.com` verified there
  (SPF + DKIM), then `RESEND_API_KEY` in Netlify and a redeploy.

## Build 367 — a stylist pull is not a wholesale order
- **"This was processed and it said wholesale, but a pull sheet is not
  wholesale, it's a stylist pull."** Stripe filed the contact as *"VENIA
  wholesale account"*. The string was hardcoded in the `invoice` action — and
  the only caller of that action is the pull payment modal, so **every** press
  contact this app has ever invoiced was filed as a wholesale buyer.
- The action now takes `kind` ('pull' | 'wholesale'). **Default is `pull`**,
  because that is what every existing caller is: defaulting the other way would
  keep mislabelling anyone on a cached client.
- Customer label, invoice-line description and `metadata[venia_kind]` all follow
  the kind; `metadata[venia_ref]` carries the pull number, so a Stripe row can
  be traced back without opening the app.
- **Invariant: only a label we wrote ourselves is eligible to be rewritten.** A
  description typed by a human in the Stripe dashboard is left alone. A contact
  who both buys wholesale and borrows samples becomes "VENIA wholesale + press
  pulls" rather than flipping on whichever invoice went out last.
- Deidre's existing record corrects itself on the next pull invoice.

## Build 368 — Gmail sends it, press@ is copied
- **"The pull sheet should also cc press@veniacollection.com."** It does, by
  default, on every transport including the mail-app draft. Editable in
  Settings; empty means none.
- **"Can we email the pull sheet another way without another api? We have Google
  connected."** Yes — Drive already signs in through Google Identity Services,
  and Gmail is the same token client with one more scope. No second vendor, no
  API key, and the mail lands in the real Sent folder where a reply threads.
- Transport order: **Gmail → the mail server (Resend, if a key is set) → a
  mail-app draft.** A failure at any step falls through rather than losing the
  email, and the pull records `emailedVia` / `emailedFrom` / `emailedCc`.
- **The app never assumes who sent it.** `gmailWho()` reads the signed-in
  account back from Google. Gmail replaces a `From` it has not verified, so the
  Send-as field says plainly it must be the account or one of its verified
  "Send mail as" aliases.
- MIME is built by hand: encoded-word subject (VENIA subjects carry em dashes),
  base64 bodies, multipart/alternative, base64url raw.
- `gmail.send` is a sensitive scope — on an External consent screen the signing
  account must be a listed test user; Internal Workspace apps just work.
  Google's own error is surfaced, since those two cases need different fixes.
- **Found while testing:** `setShowSection` gated its auto-probe on `set-conns`,
  which was never a section id (the panel is `set-connections`). Every
  connection status had been stuck on "Not tested" no matter how often the panel
  was opened, and the one caller passing the short name opened Settings to a
  blank page. Both names resolve now.

## Build 369 — the reason survives the toast
- The screenshot said *"Connect Gmail in Settings to send as VENIA"* while the
  synced workspace had `mailGmail: true`. **Gmail was connected.** It had been
  tried, it had refused, and the reason was posted to the toast — a single
  element every call overwrites — so the generic fallback replaced it a moment
  later. The founders were told to do the thing they had already done, and the
  real reason never reached anyone.
- **Invariant: never post a message you are about to overwrite.** A Gmail
  refusal is now carried into the one final message ("Gmail is connected but
  refused: …"), shown for 9s, and stored in `STATE.mailLastError` (a synced key)
  so it outlives the toast. A success clears it.
- Settings shows the last refusal under the Email card until a send succeeds,
  and a **Send test email** button sends to the signed-in account from a real
  tap — the body names which account authenticated, so a wrong From is obvious.
- A token granted **without** the send scope (GIS lets you untick it and still
  returns a token) is now rejected up front with what to do differently, rather
  than surfacing later as a 403 nobody can act on.

## Build 370 — one Google account for everything
- **"Could we make Drive, Gmail, Calendar and Picker come from the same
  account?"** They could not. Each built its own GIS token client with its own
  scope, so each asked separately and each could land on a **different** account
  — files under one, the day planned around another's calendar, mail from a
  third — and nothing on screen could say which.
- **Invariant: exactly one `initTokenClient` in the app.** `G_SCOPES` requests
  drive.file + calendar.events + gmail.send + userinfo.email together;
  `googleTokenFor(scope)` hands out that one token and refuses when the scope
  was not granted (GIS lets you untick one and still returns a token).
- The account is **read back**, never assumed (`googleWho`), shown in Settings
  with a chip per permission, and remembered as a synced key.
- **Switch account** forces `select_account consent`. The cached email is never
  carried across a new grant — doing so made switching a no-op on screen.
- Turning Calendar off no longer revokes the shared token (it would have signed
  Drive and Gmail out too). A real sign-out revokes with Google and says what it
  costs first.
- **Note for the switch to info@:** `drive.file` only ever sees files the app
  created *under that account*, so Drive attachments made as keeter@ are not
  visible as info@, and `driveFolder` may point at a folder info@ cannot see.
  The Picker API key is unaffected — it is one key, for the Picker only; Drive,
  Gmail and Calendar authenticate with the OAuth token, not the key.

## Build 371 — which Cloud project, answered from the client ID
- **"How do I know this is the right project?"** The app had no answer, and the
  Console URL in the screenshot read `project=turnkey-axiom-285601` while
  Google's Gmail error named project **955725804965**.
- A Cloud project has three names — display name, id, and number. **Only the
  number is in the OAuth client ID and in Google's errors**, so the answer is
  computable: `googleProjectNo()` reads the leading digits of the client ID.
- The Google card now states that number and links straight into **that**
  project (`?project=<number>` — the Console honours a number) for Enable Gmail
  API, Drive API, Picker API and Credentials. A link that carries the number
  cannot open the wrong project.
- It also gives the confirmation test — the Credentials page must list this
  client ID — and names the trap from the screenshot: **Gmail sending uses
  OAuth, not an API key**; an API key created for the Gmail API does nothing.

## Build 372 — the Console account is not the sending account
- The Enable-Gmail-API link opened with the picker reading **"Select a project"**
  — the Google account signed into the *Console* could not see project
  955725804965, so the Enable button had nothing to act on. Read as "this is my
  personal account, it should be info@".
- Two different accounts, and confusing them costs an evening:
  the **Console account** administers the project; the account **VENIA signs in
  as** decides who mail comes from. They need not be the same, and changing one
  does nothing to the other.
- The Google card now says so, names the "Select a project" symptom, and points
  at the Console's own account switcher rather than the app's.

## Build 373 — the From it asked for is not the From it got
- Setting up a fresh project raised the real question: keeter@ can own the Cloud
  project while mail comes from info@ — those are separable. But it exposed a
  claim the app was making without evidence.
- `gmailSend` returned the address we **asked** to send as, and `prSendEmail`
  recorded it as fact. **Gmail substitutes an unverified "Send mail as" alias
  silently and reports success either way**, so a pull could read "emailed from
  info@" when it left as keeter@.
- **Invariant: record the account, which is known; never the alias, which is
  not.** `gmailSend` now returns `verified` (the From equals the authenticated
  account). When it doesn't, the pull stores `emailedFrom` = the account and
  `emailedAsked` = the request, the toast states the condition instead of the
  result, and both point at the cc copy — which carries the real From and is the
  only way to settle it from the app.

## Build 374 — green means we can vouch for it
- The test email arrived from **keeter@veniacollection.com** while the Settings
  card read **"GMAIL · SENDING AS INFO@VENIACOLLECTION.COM" in green.** The card
  printed `STATE.mailSendAs` — what we *asked* for — as though it were fact.
- **Invariant: the status shows the account Google authenticated, never the
  requested alias.** When Send-as differs from the account, the chip goes amber
  and reads `keeter@… · info@… unverified`, and a box gives the exact fix:
  Gmail → Settings → Accounts and Import → Send mail as → add + verify — or
  Switch account and sign in as info@ instead.
- Connecting says it at that moment too, and a mismatch is a warning, not a
  success.

## Build 375 — each of you sends as yourself
- **"What if I wanted it to send from keeter@ when I'm logged in and christine@
  when she is?"** That already worked — an empty Send-as means "whoever is
  signed in", the one arrangement needing no alias verification on either
  account. It was invisible: a blank box whose placeholder was a brand address,
  which reads as "unset, should probably be info@".
- The field now says `— whoever is signed in —`, with a button for it and one
  for info@, and spells out both consequences: empty = each founder sends as
  themselves (nothing to verify); a fixed address must be verified **on every
  device**.
- `mailSendAs` is synced, so changing it changes the other founder's device too
  — the toast says which of the two things just happened.
- The status chip reads `Sending as keeter@… · this device` when the address
  follows the signer, distinguishing it from a fixed brand address.
- The cc keeps both founders on every pull sheet regardless of who sent it, and
  the pull records who actually did.

## Build 376 — "it still says unpaid but Stripe reported that it was"
Three separate faults, all of them in the same direction: the app treating its
own old note as the fact.

- **The form did not own the whole pull, but it overwrote it.**
  `prBuildPullObj` rebuilds a pull from the fields on screen, and both
  `prSaveDraft` and `prFinalizePull` assigned that object straight over the
  stored record. Everything the form has no input for — `payment`, `signature`,
  `emailedAt/From/Cc/Via/Asked` — was discarded on **any** edit, and
  `createdAt` was reset to today, changing the date printed on the sheet.
  Supabase confirmed it before anything was changed: both real pulls had
  `payment: null`. Fixed with `prMergePull(prev, next)` — the stored record is
  the base, the form is the overlay, and `createdAt` is never rewritten. Both
  save paths go through it; one alone would have left the bug half-fixed.
- **Nothing ever asked Stripe again.** The app wrote `invoiced` once and
  believed itself forever. `prInvoiceCheck(pullId, quiet)` reads the invoice
  back and maps Stripe's own words (paid / open / void / uncollectible),
  recording `paidAt`, `amountPaid`, `amountRemaining` and `checkedAt`. It runs
  quietly when a pull is opened — but only while there is still something to
  find out — and by hand from a `↻ Check Stripe` button; `Open invoice` goes to
  the hosted invoice. A Stripe error leaves the stored status alone rather than
  guessing. The banner now names its source (`confirmed by Stripe`), shows the
  balance Stripe reports, distinguishes a voided invoice and a write-off from
  merely unpaid, and stamps when it last asked, so the number has an age.
  The `invoice_status` action already existed server-side from the wholesale AR
  work — the browser had simply never called it.
- **Re-opening a pull dropped the fee and the terms.** `openPrCart` restored the
  text inputs and nothing else, so editing a pull to fix a typo re-saved it with
  fee type `none`, `$0`, and every term unticked — after which the signature
  correctly reported that the terms had changed since signing, which was
  entirely our doing. Found by testing this build's own fix, not by a report.
  The radio, the matching amount field and all four term checkboxes are now
  restored, and `prBuildPullObj` stores `feePct` — the **rate**, not just the
  dollars it produced — with older pulls falling back to deriving it from the
  retail it was taken on rather than to zero.

Invariant, again: **a status that records what we did is not a status that
records what happened.** Anything reporting money must either have asked the
source or say when it last did.

## Build 377 — "where is check stripe"
It was hidden, and the button was right to hide: `canCheck` is
`!!pay.stripeInvoiceId`, and PR-2026-002 has no payment record at all. Supabase,
after 376 shipped, still reads `payment: null` on both real pulls. Build 376
stopped the erasing; it could not undo what had already been erased. So the
button was correct and the screen was still a dead end — a paid invoice reading
"Unpaid" forever, repairable only by someone editing the database by hand.

- **`⌕ Find in Stripe`** appears exactly where `↻ Check Stripe` cannot: a pull
  with a fee or a client email and no invoice id.
- **`invoice_find`** (new, gated with the other money actions, **GET only** —
  it creates and sends nothing) tries two doors, because either alone has a
  hole: `metadata['venia_ref']` is exact but Stripe's search index lags about a
  minute behind a fresh invoice, and the customer's invoice list is immediate
  but only as good as the email on the pull. Results merged, deduped, newest
  first, amounts in dollars. It reports which doors it tried, so "none found"
  can be read as an answer rather than a failure of unknown shape.
- **One match attaches. More than one asks** — a repeat client will have
  several, and attaching the wrong one puts someone else's money on this pull.
  The picker shows number, status, what is still owed, and which invoice carries
  this pull's tag, and says the tagged one is the safest match.
- **None offers the manual paste**, validated against `^in_[A-Za-z0-9]+$` —
  the only route that works when the email on the pull is not the email Stripe
  billed.
- **The attach is never the answer.** It merges over the payment object (not
  replaces it — the same mistake that lost these records), stamps `relinkedAt`
  so a reconnected pull is never mistaken for one tracked all along, and then
  calls `prInvoiceCheck` so the status comes from Stripe. A search error leaves
  the pull exactly as it was.

Invariant: **when a button is correctly unavailable, that is a dead end unless
something else is offered in its place.** "Nothing to check" is true and useless.

## Build 378 — payment should not need asking for
Both `↻ Check Stripe` and `⌕ Find in Stripe` are repairs: they exist because
something already went wrong. In normal use nobody should ever press either.

- **The app sweeps for itself** — `prReconcilePayments()` on boot, when the
  pulls page builds, when the list re-renders, when the tab comes back to the
  front, and every five minutes while it is open (never against a hidden tab).
  Four moments because any one alone leaves a gap: boot covers the first look of
  the day, the render covers walking onto the page, visibility covers a phone
  coming out of a pocket, the timer covers a screen left open while a client pays.
- **Bounded, because it runs unattended:** only pulls whose money is still open
  (paid / void / released / captured are final); never re-asks about the same
  invoice within 90s; at most 8 per sweep, least-recently-checked first so a long
  history converges over a few sweeps rather than hammering Stripe in one burst;
  one sweep a minute; skipped entirely with no access code stored, since every
  call would 401; never in the share or agent views.
- **It can never raise a passcode box.** `veniaAC(false)` reads the stored code
  without prompting — a background sweep must not be able to interrupt anyone.
- **`force` skips the per-invoice cooldown too.** Without that, `↻ Check now`
  would silently do nothing whenever an automatic sweep had just run — the worst
  possible moment for a button to look broken.
- **It only speaks when something changed.** A sweep reporting "still unpaid"
  every five minutes is noise that trains you to ignore it. When money lands the
  toast names who paid and how much.
- **`$X awaiting payment`** sits on the pulls page itself, with how many pulls,
  how fresh the number is and that nobody had to ask for it — and renders
  nothing at all when nothing is outstanding.

Two dead paths found while wiring this, both silent:
- `prPayRepaint` called **`renderPrPulls()`, which has never existed** — the
  ReferenceError was swallowed by its `try/catch`, so a payment status could
  change and the card badge behind the modal kept showing the old one.
- `prInvoiceCheck` repainted through `renderPR()`, whose container `#pr-content`
  only exists on the PLM redirect stub. The screen the founders actually use is
  `agRenderPrPullsList` → `#ag-pr-pulls-list`. Both now go through
  `prRepaintLists()`, which repaints whichever list is really on screen.

Not covered: this updates while the app is open or on opening it. Instant
updates with the app closed need a Stripe webhook — a new endpoint in the Stripe
dashboard plus `STRIPE_WEBHOOK_SECRET` and Supabase service credentials in
Netlify. Not built, because a half-configured webhook that silently does nothing
is worse than none.

Invariant: **a button that repairs something should be evidence of a bug, not a
step in the routine.** If the founders have to press it regularly, the automatic
path is missing.

## Build 379 — the tech pack speaks the factory's units
Read VENIA TECH PACK TEMPLATE and the real packs in *S10 Whisper on Winds*
(SPIKE PANTS, ISOLDE TOP, MISTRAL, GALE, ZEPHYRUS, DECKARD, NOTOS, EIJI…).
Every spec in that book is fractional inches: SPIKE PANTS specs FRONT RISE at
**13 3/8** with a **1/8"** tolerance and a cargo pocket flap at **0"**.

- **`parseFloat` was destroying every measurement.** `parseFloat("13 3/8")` is
  `13`; `parseFloat("1/8")` is `1`. So a fraction was truncated off every spec,
  and a 1/8" tolerance became **1"** — an eightfold error on the most
  precision-critical number in a tech pack. Five write paths did it: the POM
  sheet, the tech-pack POM table, a new POM row, grading, and the fit session
  (the one with a tape measure in hand). All now go through `measParse` /
  `measFmt`: parse on the way in, store a number, render house fractions on the
  way out. A value off the sixteenth grid shows as the decimal it really is
  rather than being quietly rounded — rounding someone's spec is the same class
  of mistake as truncating it.
  Confirmed against Supabase first: **0 POM points across 60 styles**, so this
  landed before the first real spec rather than after.
- **A blank size became `0`.** Which reads as "this measurement is zero inches"
  rather than "nobody has specced it yet" — and 0 is a number the deviation
  check will happily judge against. Blanks stay blank.
- **Exactly on tolerance was flagged out of tolerance**, and float dust
  (`3/8 + 1/4` landing a hair over `5/8`) failed real garments. Deltas snap to a
  64th and the comparison is inclusive.
- **The printed pack told the factory the numbers were centimetres.** A 13 3/8"
  front rise read as 13.375 cm is about 5 1/4" — the sheet was instructing a
  factory to cut a child's pattern. Now "All measurements in INCHES and taken ON
  THE FLAT", which is the template's own wording. Two other `(cm)` labels fixed;
  the seam-allowance dropdown keeps its `3/8" (1 cm)` conversions, which are
  correct and inches-first.
- **Grading asked for an increment in cm.** A unit that appears nowhere in
  VENIA's book. It now asks for inches, accepts `1/2` or `1 1/4`, and snaps the
  graded run to the fraction grid instead of drifting to `12.750000000000002`.
- **The POM library was missing nine points the sheet has**: side seam length,
  both armhole-straight readings, high hip, hem height and the whole
  pocket-placement block. Tolerances were `0.06` and `0.13` — which are not
  1/16 (.0625) and 1/8 (.125), and print as decimals a factory does not read.
- **Fields the sheet has always carried and the app never asked for:** Style #
  (`23B001-2M`), Group (woven tops / knit tops split), Gender, Designer, Tech
  Designer, Patternmaker, Date Created, Date Revised, and shrinkage as **four**
  numbers — self and lining × length and width — because one number cannot be
  applied to a pattern.
- **Production status.** The sheet offers 22 states (`SMS - CUTTING`,
  `PP - MARKER`, `PROD - WAITING ON FABRIC`…); the app had seven lifecycle
  words. That gap is exactly the earlier report *"it says SS7 is in proto stage,
  but I pushed them to SMS"* — there was nowhere to say it. Stage stays coarse,
  `prodStatus` carries the sheet's own vocabulary, and the factory dropdown is
  the sheet's contractor list.

Still to come (Build 380): importing previous styles from the Drive packs.

Invariant: **the unit label on a spec is never allowed to be wrong, and a
measurement must survive being typed the way the house writes it.**

## Build 380 — importing the eight years already in Drive
Retyping a POM sheet by hand is exactly how a 13 3/8 becomes a 13 3/4, so
`↑ Import from Drive` on the tech pack reads the sheet instead.

- Picks a **spreadsheet** (not every PDF and `.ai` in the season folder), reads
  every tab in one `values:batchGet`, and works on the **`drive.file`** scope the
  app already holds — which Google grants only for files picked in the Picker,
  so the import cannot read anything the founders did not hand it.
- **Nothing is invented.** A field absent from the sheet is left empty and named
  in the report; a cell that is not a measurement (`TBD`, `SEE PHOTO`) is skipped
  and named. An import that quietly guesses is worse than retyping — you would
  never know which numbers to check.
- **The preview comes before the write.** It shows the style fields found, the
  measurements as house fractions, the values it could not read, and the fields
  that were blank, then asks where it should land.
- **Merging never overwrites.** A field or a measurement you already entered is
  kept, and the result says how many it left alone.

Two bugs the test caught before this shipped, both from real sheet shape:
- **A blank field imported the next label as its value.** The labels sit side by
  side across the row — `STYLE DESCRIPTION:` then blanks then `DATE REVISED:` —
  and scanning right for "the first non-empty cell" grabbed the wrong one. The
  scan now stops at a label.
- **It read the wrong tab.** Ranking blocks by row count picked DEVELOPMENT
  SPECS (longer, one column of numbers) over GRADED SPECS (the size run a
  factory cuts from). Ranked by named size columns first now.

Mapping: the sheet's fine `STATUS` → `prodStatus`, never over the app's own
coarse lifecycle; shrinkage → four numbers; size columns → the app's size keys;
a development sheet's INITIAL/REVISED/FINAL SPEC column seeds the base size,
since that is what it is.

Not yet imported: BOM fabric/trim/wash rows, the cost sheet, pattern card pieces
and fit-comment sessions. The sheet has them; the app models most of them
already, so this is extension rather than new ground.

## Build 381 — the structural gap: DEVELOPMENT SPECS
The one place the spreadsheet was still better than the app. VENIA's tab reads
across the page:

    POM | TOL | INITIAL SPEC | 1ST | DIFF | REVISED SPEC | 2ND | DIFF | FINAL SPEC | 3RD | DIFF

The app had half of it. It recorded what each fit sample **measured**, and froze
the spec at measure time so a later edit could not silently flip a past verdict
— but **the spec itself had no history**. One current number, and no way to say
*"we specced 13 3/8, the proto came back 13 5/8, we moved the spec to 13 1/2,
the SMS hit it."* That story is what a development sheet **is**: the record of a
decision, not just a measurement.

- **`p.specs`** — an ordered list of revisions, labelled with the sheet's own
  words (Initial / Revised / Final, then Rev 4 and up, so development is not
  capped at three rounds). Derived from the base column until someone actually
  revises: a style that has never been revised gains nothing from being looked at.
- **Every round records which revision it was judged against.** A diff is
  meaningless without knowing which spec it is a diff from. Rounds recorded
  before this build are matched by the spec frozen with them.
- **Revising keeps the old number** and asks why. The previous value is what the
  earlier fits were judged against — overwriting it would make their diffs lie.
  The same number is refused as a revision; so is anything that is not a
  measurement.
- **Adopt** — one tap when the sample is right and the spec was wrong, still as
  a recorded revision. **Undo** removes a mistaken revision and walks the rounds
  back to a revision that still exists, while leaving the measurements alone:
  they really were taken.
- **The sheet**: one column group per revision, each with Spec / Fit / Diff and
  a `n/m in tol` summary. A revision nobody has fitted yet still gets a column —
  "revised, sample not back" is a state worth seeing. A round is filed under the
  revision most of its points used, so one straggler cannot split a column.
- **Two tabs on the POM page**, the same two the pack has always had: Graded
  specs (the size run a factory cuts from) and Development specs.
- **It reaches the factory.** The printed pack carries the history, with the
  revision notes — a factory that can see the spec moved 1/8" after the proto
  asks better questions than one that only sees the final figure. Printed only
  when there is a history, so an unfitted style never carries an empty table.

Three findings worth keeping from the test work:
- `document.body.innerHTML` matches the **app's own source**, because the whole
  app is one inline `<script>`. An assertion over it can pass on the code that
  would have produced the output rather than the output. Read the render
  container (`#techpack-content`, `#pom-content`) instead.
- Playwright's `dialog.accept('')` **wipes a prompt's prefilled value**; a person
  pressing OK keeps it. Use `dialog.defaultValue()` to test the real path.
- The tech pack renders into a container that is not the visible page, so
  `innerText` returns nothing for it. Assert on markup, not visible text.

Invariant: **a number that changed should say what it changed from, and every
judgement should name the number it was judged against.**

## Build 382 — hierarchy in the tech pack, and the order of the work
*"A ton of information that doesn't have clear hierarchy and is hard to read
and parse."* Fair — and Build 379 made it worse by adding eleven fields to
Overview without touching the layout.

**One structural bug was doing most of the damage.** The BOM header row
`<div class="tpbr tpbh">` was **never closed**, so every BOM line, the total
row, and then sections ⑤ POM, ⑥ Pattern Card, ⑦ Care and ⑧ Costing all rendered
*inside* it. That is why "Total" printed on top of the "Unit" column, why the
BOM columns never aligned, and why collapsing the BOM collapsed half the pack.
Its grid also declared seven columns for eight cells, so the edit pencil and the
status badge wrapped onto their own row. Both fixed; a nameless material now
reads "Unnamed material" instead of `undefined`.

**Type.** A label at 10px uppercase with 1.5px tracking is visually louder than
a 12px sentence-case value, so every section read as a wall of headings with the
content hiding between them. Labels are now 9px, quieter, less tracked; values
13px and heavier; a group title outranks the fields inside it.

**Overview**, which had eleven equal-weight fields and repeated five things the
black header bar already showed:
- A dense **fact strip** for the short identity values — style #, group, gender,
  size range, base size, fit, drop — read across, not down a form.
- **Empty fields fold** behind one line. They stay *enterable*: hiding an unset
  gender outright would make it impossible to set, which is worse than clutter.
  A pack with nothing filled opens them instead of hiding them.
- The three fields that all sound like "what stage is this at" — Stage,
  Production status, Sample round — are grouped **with a line saying what each
  is for**.
- Shrinkage is a 2×2 of self/lining × length/width instead of four full-width
  rows.
- Name, season and category fold away: the header bar already shows them.

**The base size is a column**, not `S ·base` jammed into the header — tinted,
bounded, with "Base" on its own line under the size. The tech pack's own POM
table marks it too; it never did.

**The order of the work, made visible.** Development specs is now the first tab
and the default. Grading multiplies the base spec across the run, so the graded
sheet says which step it is on: *not fitted yet* · *still in development — 1 of
2 points in tolerance on the Proto* · *approved on the Proto, safe to grade*.
Nothing is blocked; sometimes a rough run is needed for costing.

**Grading is no longer one-shot.** It filled blanks only — right for protecting
a hand-tuned grade, wrong the moment the base spec is revised, because then the
whole run derives from a number that no longer exists. It now asks: regrade
everything, or fill blanks only. Each point records the base it was graded from,
so a later revision surfaces *"1 point was graded from an older base spec"* with
a one-tap regrade.

Recurring mistake, fourth time this session: two explanations were written as
comments in the **patch script** rather than inside the replacement string, so
they never reached the file. Caught by smoke79 asserting on them.

## Build 383 — importing a PDF pack, without believing it
*"Also no way to import pdf atm."* Half the archive is PDFs — ISOLDE 3RD PP,
ZEPHYRUS, FLIP WATERFALL — exported from the sheet and never coming back as one.

One **Import pack** button now takes a Sheet or a PDF, from Drive or from the
device. A PDF has no cells, so the layout has to be *read* rather than
addressed, and that is a job for the model already wired into the app.

Which raises the obvious risk: a model asked to pull numbers out of a document
will occasionally produce a number that is not in the document. On a spec sheet
that is the worst failure there is — a plausible 13 1/2 that nobody typed.

**So the model's answer is a suggestion, and nothing more.** Every value must
appear **verbatim** in the extracted text before it is allowed in; anything that
does not is dropped and named by value in the report. The check is mechanical,
not a matter of prompting. The boundary is marked in the code: *"Everything
above this line is a suggestion."*

- Text is rebuilt into **lines from item positions** — one flat stream loses
  which value belongs to which point.
- The comparison survives how PDFs actually write fractions: `13 3/8`,
  `13-3/8`, the `⅜` ligature, `6.00`, and any case or dash style.
- Text fields are held to the same rule, so an invented designer name is refused
  too and the field reads blank rather than filled with fiction.
- A PDF with no text layer says it is **probably a scan** and stops: a scan
  would have to be re-typed, and the app will not guess at pixels.
- It lands in the **same preview and the same merge** as the Sheets importer, so
  the never-overwrite guarantees are the ones already tested.

Verified by feeding the verifier a model reply containing a real style, an
invented designer, an invented measurement point, and — separately — a
plausible-but-absent `13 1/2` on a real point. All three refused and named; the
real values imported exactly.

Prerequisite the app cannot do for them: **enable the Google Sheets API** on the
same Cloud project as the OAuth client (APIs & Services → Library). The error
message already says this and the Settings link goes to the right project.

## Build 384 — an unread mark on the chat box
*"If ENI replies and it hasn't been seen yet and the chat isn't open, let's have
a notification on the chat box."*

A reply can land long after the question: `callClaude` retries for ten seconds,
and a cloud job is explicitly built to finish after the app has been closed
("Working in the cloud — you can close the app"). That reply announced itself
with a **2.8-second toast and nothing else**.

**The bug underneath was worse than the missing badge.** When the dock was
closed, `cfoChatApply`'s `land()` returned false — the reply went into
`SK.history` and **never into the DOM** — and `skToggle` only re-rendered a body
that was still *empty*. So catching the toast, opening the dock and finding
nothing there was not confusion: the message really was missing. The thread now
rebuilds when a reply arrived while it was shut, because a notification pointing
at a message that is not there is worse than no notification.

- **Seen** = dock open, on that agent, and the window in front. A reply that
  arrives while the window is behind another one has not been seen.
- A **count**, not a bare dot — "Eni replied" and "Eni replied three times" are
  different situations. Caps at 9+.
- **Survives a reload**, because unseen is unseen.
- The **agent tab** carries a dot when it was the other one, so you know which
  before opening.
- The **tab title** carries the count too — that is the whole point of the
  window-in-the-background case — and does not stack counts on itself.
- Cleared three ways: opening the dock, switching to that agent, or returning to
  the window with the dock already open.
- Pulses twice and stops; a badge that never stops moving is one you stop
  seeing. No animation at all under `prefers-reduced-motion`.

Test note: `addInitScript` runs on **every** navigation, so clearing storage in
it wiped the very persistence the reload assertion was testing. And headless
Chromium reports `visibilityState: 'visible'` however many pages are opened over
a page, so the hidden state has to be driven directly.

## Build 385 — the cost sheet actually costs
*"The Cost Sheet section doesn't have any way of actually costing. Cost sheets
normally derive their cost from all aspects of the garment."* And: *"Vendor
Factory doesn't even use my factories."*

Both true. ⑧ Costing was **COGS, Wholesale and Retail as three numbers you
typed**, with nothing behind them and nothing connecting them to the BOM sitting
four sections above. You could put $48 in the COGS box for a style whose fabric
alone came to $62 and the pack would agree with you.

- **Materials come from the BOM**, itemised — each material named with its
  quantity, waste allowance, unit cost and extension, through the same
  `bomExt` the BOM page uses. No BOM says *"No BOM yet"* and points at where to
  build one, rather than costing it as zero.
- **Labour is the operations** — cutting, sewing, dyeing, grading, marking, the
  list the factory quotes against — each with its contractor and price.
- Overhead, duties and freight roll in. **Total cost is the style's COGS**, and
  writing it there means every margin, the dashboard and the P&L agree with the
  sheet. It never zeroes a hand-entered figure.
- **Derived vs typed is visible and reversible.** Typing over the material cost
  is allowed and detaches it, and the sheet says so — *"a typed figure of
  $62.00, not the BOM's $33.32"* — with one tap to follow the BOM again. A
  number with no visible source means something different from one with.
- **Pricing is computed, not imposed.** Markup (a margin — 60% means cost is 40%
  of wholesale, ×2.5) and a retail multiplier, both the template's own defaults.
  The calculated wholesale and retail sit beside the style's actual ones so the
  gap is visible, and are applied only by pressing *Use these prices*.
- **Factory now reads the Vendors library** — the ones typed as factories,
  falling back to every vendor rather than offering nothing, and saying plainly
  when the library is empty.
- **One store.** The tech pack writes the same `venia-cost-sheets` record the
  Cost Sheets page reads; two places computing a cost differently is how a style
  ends up with two costs.

A collision worth recording: the Cost Sheets page already owns
`csLaborAdd/Set/Del` on `window` and defines them **later** in the file, so the
tech pack's identically-named handlers were silently overwritten and its labour
rows went nowhere. Renamed `tpCostLabor*`. The browser test caught it — the
material total was right and the labour total was stubbornly zero.

Fifth time this session: an explanation written as a comment in the patch script
rather than in the replacement string. smoke82 asserts on it.

## Build 386 — inventory comes from Shopify
*"Inventory Should Come from Shopify Stock of Actively listed styles."*

Stock was a number typed into a box, on a page that computed a stock **value**
from it and reported it as fact. Nothing ever checked it against the store, so
the only thing "Total Units" measured was how recently someone had remembered to
update it.

- **Active listings only.** A draft or archived product still has variants and
  quantities; counting them inflates stock with garments no customer can buy.
- **Every page.** Shopify's cursor pagination lives in the `Link` header, and a
  silent first page would read as "that is all the stock we have". A pull that
  hits the page cap reports itself as **partial** rather than passing as a total.
- **Matching is by SKU and only by SKU.** The app builds SKUs as
  `${styleId}-${COLOR}-${SIZE}`, so a variant whose SKU is prefixed by a style's
  styleId *is* that style — exact and checkable. The **longest** styleId wins, so
  `VN-1` cannot claim `VN-10`'s SKUs. Nothing is matched on a title resembling a
  name: "SPIKE PANTS" and "Spike Pant (Sample)" would pass any fuzzy test, and
  attaching the wrong stock to a style is worse than attaching none.
- **What it could not match is named, not absorbed.** An unmatched variant is
  counted, sampled and shown — a stray 99-unit SKU stays out of the total instead
  of quietly inflating it. A variant with inventory tracking off is named too,
  rather than silently counting as zero.
- **Every number says where it came from.** `invStock()` returns `shopify`,
  `manual` or `none`, every total reads through it, each row is labelled, and the
  page states how many styles are live and how fresh the pull is. An unsynced
  page says *"These are hand-typed figures. Nothing has checked them against the
  store."*
- **Shopify owns what Shopify counts** — those rows are not hand-editable,
  because a number typed over one would be overwritten on the next sync without
  ever having meant anything. A style Shopify stops listing **drops** its figure
  and falls back to the typed one, labelled as typed, rather than freezing a
  stale live number.

`invSync` went into `SYNC_KEYS` — `save()` persists only what is listed there,
and this is the finCats bug from Build 363: the "last asked 4 min ago" line would
have vanished on the next save.

Test note, twice over now: `addInitScript` runs on **every** navigation, so
re-seeding storage in it wipes exactly what a reload assertion is testing. And
the app pings Shopify on load, so the first captured call is never the one under
test.

## Build 387 — cost sheets: edit, delete, estimate, and a history
*"Once I set the costs here there is no way to edit or delete it. Also I need to
be able to set an estimate cost for each section and know that it's an estimate.
Also how would I track revisions to cost from a previous cost to an updated
cost."*

- **Delete.** There was none. The button appears once a sheet exists, says how
  many revisions of history go with it, and then asks what to do with the COGS
  the sheet wrote — clear it, or keep it as a hand-entered figure. Leaving a COGS
  behind with no sheet under it is exactly the number-with-no-source this page
  exists to prevent, so it is asked rather than assumed either way.
- **Estimates, per section.** A guessed freight figure and a quoted one look
  identical once they are both a number in a box — and the landed cost, the
  margin, the P&L and the price quoted to a buyer all inherit that number without
  ever being told which it was. Each of the five sections carries its own flag,
  the landed cost reads *"Estimate — freight not quoted"*, and the tech pack
  repeats it: *"This cost is part estimate… the wholesale and retail below
  inherit that."* Ticking writes straight through, so the screen and the stored
  sheet never disagree.
- **Revisions.** Every save keeps what the numbers were. The page shows
  `$48.00 → $58.00 · +$10.00 (+20.8%)` with *"What moved: material $20.00 →
  $30.00"*, and the full list beneath. Saving twice without changing anything is
  not a revision; history caps at twenty, about a season of quotes. The tech pack
  carries the last movement too.

**Two bugs found doing it:**
- `saveCostSheet` did `all[sid] = d` — a **whole-object replace**. The tech
  pack's cost section keeps markup, the retail multiplier, the BOM link, the
  estimate flags and the revision history on that same record, so every Save on
  the Cost Sheets page threw all of it away. Same class as the pull-sheet
  overwrite in Build 376. It merges now.
- The history panel was not refreshed after saving, so it said *"1 revision"*
  while the record held two. A history that is wrong about itself is worse than
  no history.

Seventh time this session: an explanation written as a comment in the patch
script rather than inside the replacement string. Every one has been caught by a
smoke assertion, which is the only reason the count is knowable.

## Build 388 — one pricing model, kept in sync both ways
*"The cost sheet should be correct, however if I adjust margins and cost in the
style view, it should still be in sync and vice versa … we can get confirmation
popup as well."* And: *"when the Update popup shows and I hit update, it says
updating but never changes or refreshes."*

**There were two pricing models and they disagreed.** The Cost Sheets page
computed wholesale at landed × 1.45 (a 31% margin); the tech pack used the
template's 60% markup (× 2.5). The same cost produced two different prices
depending on which screen you were standing on.

The line settles it. RILEY PANT: landed $58, wholesale $146 — ×2.52. DEAR
SINCERELY TEE: $20 → $50 — ×2.5. Retail is wholesale × 2.5 in both. The ×1.45
was simply wrong for this house, and its own comment claimed it *"matches the
catalog"*. It is gone; markup is a margin percentage, **per style**, stored on
the cost sheet, and every surface reads it from there. ISOLDE sitting at 71% is a
decision about one garment, not a second model.

**Sync, in both directions, and nothing moves unasked.** The cost sheet is the
model; the style carries the prices actually quoted. They are allowed to differ —
but never to drift apart without someone deciding that.

- **Cost changes** → the popup states the new cost, the prices the markup
  implies, and what the style says now, noting when those prices came from the
  old cost. Declining says plainly that the sheet and the style now differ.
- **A price typed on the style** → it works out the markup that price implies
  (*"$300 on a cost of $90 is a 70% markup; the sheet says 60%"*) and offers to
  store it. Declining says the sheet no longer describes the style.
- A wholesale at or below cost has no markup to store, so it is refused and said
  rather than written as nonsense.
- An unpriced style is simply priced — nothing to disturb, no question.
- Every surface is wired: the tech pack's cost fields, its labour lines, Save on
  the Cost Sheets page, the margin fields now on that page, and the style editor.

**The Update button.** It said *"Updating…"* and then nothing happened. The
reload was deferred until the page was backgrounded — right for an automatic
swap, since nobody wants the page pulled out from under them mid-PO, but wrong
when the founder has just pressed Update and is watching the button. It now
reloads as soon as the new worker takes control, and reloads anyway after 3.5s if
it never does, behind one shared guard so it cannot reload twice.

## Build 389 — the margin on the style is the correct one
*"Lets have the margin in Styles be the correct one for now."*

The line was priced long before this app had a markup field, so a 60% default is
a guess about garments whose real answer is already on the style: ISOLDE is
70.83%, RILEY 60.27%, DEAR SINCERELY exactly 60%. Left alone, every one of them
would open with the sheet disagreeing with its own prices and offering to
"correct" prices that were never wrong.

- **The markup is read off the prices**, once per style, at first boot after the
  cloud pull — reading before the pull would read a local copy the sync is about
  to replace. Retail multiplier comes off retail ÷ wholesale the same way.
- **Nothing on the style changes.** Not the cost, not the wholesale, not the
  retail. Only the sheet's description of it, which is the thing that was wrong.
- **What it cannot read, it leaves and names**: a price with no cost, a cost with
  no price, and a wholesale at or below cost — that last is a pricing problem to
  look at, not a number to invent.
- **The number says where it came from.** `markupFrom: 'style-prices'`, and the
  page prints *"read from this style's prices"*, so a 70.83% markup is never
  mistaken for something someone chose today.
- **Re-runnable by hand** with a preview of exactly which styles change and by
  how much, and *"No cost or price is touched"* on the confirm. With nothing to
  do it says so rather than showing an empty dialog.

**Two things this exposed:**

- **`csModel.total` was the sheet's sum, and most styles have no sheet.** They
  carry a real COGS from years of costing and nothing else, so pricing off a $0
  sheet would have said every one of them should sell for nothing. There is now
  a `basis` — the sheet when there is one, the style's COGS when there is not —
  and `basisFrom` says which was used.
- **One decimal of margin loses fourteen cents.** ISOLDE's true margin is
  70.833…%; stored as 70.8% it recomputes to $119.86 against a real $120, and
  the app would have reported the sheet and the style as disagreeing forever
  over that. Markup is stored to two decimals, and `csSamePrice` treats two
  prices that round to the same price as the same price.


## Build 390 — the phone views
*"Fix these mobile views / The image is too large on mobile, maybe it's a small
icon that can be tapped for larger view, that way we preserve head space and
have more visibility."*

Two separate faults, both measured in a real browser at 390 × 844 before and
after.

**The style photo was 220px of a 345px sticky head** — 41% of the screen frozen
above every fact, leaving 226px of readable panel no matter how far you
scrolled. RETAIL MARGIN, the six action buttons and LIFECYCLE were all below the
fold on open.

- On a phone the hero floats at **56 × 72** with a ⤢ corner mark; the badge row
  and the margin bar sit beside it. Head is now **155px** and the first spec
  section lands at y=428 instead of y=618 — 79% more content on screen.
- Tapping the thumb still opens the full-size lightbox (`lbOpenStyle`), which is
  where the large image belongs.
- Both `.dp-tags` and `.dp-margin` carry `overflow:hidden` so each establishes
  its own formatting context and sits *beside* the float. Without it the margin
  bar draws its 3px rule straight through the photo.
- Desktop is untouched: full-width hero, overlay Replace button, 220px.
- **Replace photo moved into ⋯ More** (all sizes) — a legible overlay button
  does not fit on a 56px tile, and the action still needs a real tap target.

**The dropdowns were drawing on top of the stage pills.** Reproduced exactly:
`styles-gender-f over All 59`, `over Concept`, `over Design`, `over Sms`.

- **Cause: `.fs{width:100%}` plus the mobile-only `.filters .fs{flex-shrink:0}`.**
  In a form grid `width:100%` is right. In the filter bar the select is a flex
  item, and `flex-shrink:0` stops it giving that width back — so each of the
  three dropdowns claimed **368px inside a 366px group**, and the two that did
  not fit spilled straight over the pills laid out beside them. On desktop there
  is no `flex-shrink:0`, so they shrank to fit and nobody saw it.
- Fixed at the cause: `.filters .fs{width:auto}` with a 44vw cap, so each sizes
  to its own content (161 / 127 / 110 at 390px). `padding-right` needs
  `!important` — the selects carry an inline `padding` shorthand that otherwise
  wins and leaves the ▼ sitting on the text.
- **The Styles bar is now two rows on a phone**: dropdowns above, stage pills
  swiping below. Before, the first pill started at **x=401** — you had to swipe
  past three dropdowns before a single stage filter was visible. It now starts
  at x=12.
- `.filt-scroll` is the wrapper that makes the pill row scrollable. It is
  `display:contents` everywhere but a phone, so desktop layout is byte-identical
  to before the wrapper existed.

**Swept every `.filters` bar on eleven PLM pages at 390px, before and after.**
Only the Styles bar overlapped; all eleven are clean now.

Also removed a stray `min-height:48px` sitting at the top level of the
`max-width:768px` block, where it parsed as an invalid rule and set nothing.

Regression-locked by `gauntlet/mobile.js` (21 assertions across 360/390/430 and
desktop 1400). Every one of them fails against Build 389.


## Build 391 — the icons are drawn now
*"Icons need refinement on mobile."*

The chrome was Unicode glyphs. Rendered at 3× and looked at rather than read
from the source, the tab bar was six icons from four different families:

| | was | problem |
|---|---|---|
| Today | `◈` U+25C8 | a **filled** diamond beside five hollow marks |
| Product | `◻` U+25FB | a generic hairline square, much larger optically |
| Growth | `↗` U+2197 | thin, sitting high in the line box |
| Sales | `⇄` U+21C4 | widest mark in the row |
| Money | `$` U+0024 | a **letterform** — cap height, far taller than the rest |
| More | `⋯` U+22EF | three small dots resting near the **baseline**, well below centre |

And in the global bar, `✎` (U+270E) arrived as a **full-colour emoji pencil**
next to two flat monochrome marks, while `⌕` (U+2315) is TELEPHONE RECORDER,
not a magnifier — it is absent from some system fonts entirely.

A glyph is whatever the device's font decides it is. iOS, Chrome and Android
each decide differently and none of it is ours. So they are **drawn** now: one
24-unit grid, one stroke, `currentColor`, in `.ico`. Same weight, same optical
size, same centre line, on every device.

**Replaced:** the six tab-bar icons; the mobile header (menu / search / add);
the global bar (brain dump / search / settings — desktop too, same elements);
the Eni launcher's `◐` (a HALF BLACK CIRCLE said nothing about what it opens —
now a spark); the six style-detail actions, where `◑` for POM was drawing as a
small dark blob and is now a ruler, and `⊞` for BOM is now layers; the desktop
search button, the search modal, ⌕ Find in Stripe, and both ⚙ Settings entries;
and all 29 inline `✎` pencils, including the Today capture link, Edit, and the
small "this row is editable" hints.

**Two things this taught, both caught by rendering rather than by reading:**

- **A gear needs teeth, not spokes.** The first gear — a circle with eight
  radial lines — is a *sun*. Thickening the spokes made it a *flower*. Only a
  toothed ring reads as a gear at 16px. Likewise the first Money icon, a
  banknote rectangle with a centre circle, read as a **camera**; it is a drawn
  `$` now — same meaning as the old glyph, but at the set's weight instead of
  the font's.
- **Stroke width must scale with the icon.** Pinning it with
  `vector-effect:non-scaling-stroke` meant a 12px icon carried the same ink as a
  21px one, so the small ones filled in — the BOM layers went solid black and
  the ruler became a bar. The stroke is in grid units now and scales like a
  letterform does with its point size; inline icons get a touch more weight
  (1.8 vs 1.6) to hold their own beside type.

`dpMoreToggle` rewrote its button with `textContent`, which would have stripped
the icon on the first tap — it sets `innerHTML` now, and the gauntlet toggles it
and checks.

Regression-locked by `gauntlet/iconset.js` (13 assertions, including that all
six tab icons share one size and one centre line, that `currentColor` still
darkens the active tab, and that no `✎ ⌕ ⚙ ◐` survives in rendered text —
`SCRIPT`/`STYLE` text nodes excluded, since inline source is not rendered text).

**Three smoke assertions hardcoded the old glyphs** (`smoke60`, `smoke63`,
`smoke74`). The app was right and the tests were stale; each now matches an icon
or a character before the label rather than one specific codepoint.

**Not done:** the in-content glyphs elsewhere — `◫ ⌸ ⊞ ↻ ⇱ ◻` in the tech pack,
tables and menus — are still Unicode. They are labelled buttons rather than
chrome, so they are legible; sweeping them is a separate pass.


## Build 392 — three counters nobody could read
Found in a photo of the actual phone: a small black blob beside the brain-dump
pencil where a number should be.

`--gold` is `#000000` — the VENIA accent went monochrome. Every place that used
it as a **background** under dark text therefore became black on black, and all
three such places are unread counters:

| | sits on | was | contrast |
|---|---|---|---|
| brain-dump count | the white global bar | `#000` on `#000` | **1.00 : 1** |
| Eni unread count | the near-black launcher | `#000` on `#0a0a0a`, black ring | **1.06 : 1** |
| per-agent dot | the `#0a0a0a` dock | `#000` | **1.06 : 1** |

1.00:1 is the same colour. The brain-dump badge drew as a plain black dot with
the count invisible inside it; both Eni indicators were not visible at all.

The counters now take the light side of whatever they sit on: `var(--ink)` /
`var(--bg)` on the page chrome, white on the dark launcher and dock. 21:1,
19.8:1, 19.8:1.

**This is a Build 384 miss.** That build was *"if Eni replies and it hasn't been
seen yet, put a notification on the chat box"*, and its gauntlet asserted the
badge appeared and carried the right count — never that it could be read. The
new `gauntlet/badges.js` **measures** the contrast ratio of each badge against
its own background and against the surface behind it, and every assertion scores
1.0x against the live 389.


## Build 393 — "why are my API credentials empty on my phone?"
They are not missing. Two different things were being confused, and one of them
was the app lying.

**API keys are device-local, on purpose.** `getKey`/`setKey` write
`VENIA_API_KEYS` in `localStorage`. That key is in neither `SYNC_KEYS` nor
`EXTRA_LS_KEYS`, so it never syncs — correctly: a secret must not ride in the
workspace blob that goes to Supabase. A second device having no local copy is
the normal state, not a fault.

**The credentials that matter are not in the browser at all.** Anthropic,
Shopify's Admin token, Stripe and Gmail all live in Netlify env vars and are
used server-side. That is why the phone already showed Shopify **CONNECTED**
while its token field read "managed server-side" — that row asks the server
(`shopifyPing` → `_shopifyServerConfigured`).

**The bug: Claude never got that treatment.** Two indicators still read the
browser fallback key:

- `setUpdateDots` → `!!getKey('anthropic')` → Settings said **NOT SET**
- the agent chat header → `const online = !!getKey('anthropic')` → every agent
  read **Offline**

Meanwhile every agent call goes through `/api/claude`, which uses
`process.env.ANTHROPIC_API_KEY`. The browser key is only a fallback for when the
relay itself is down. So on any device where nothing was ever pasted — the phone
— the app reported all four agents as offline while they were working perfectly.

`claude.js` now answers `{ping:true}` with `{configured:<bool>}` **before** it
touches Anthropic, so the check is free and spends no tokens; it still sits
behind the origin check and the access-code gate. The app pings at boot exactly
as it does for Shopify, and `claudeConnected()` prefers the server's answer but
still counts a local key, since with one the app really can reach Anthropic
directly. The Settings field is labelled "set in Netlify, not here", like
Shopify's.

Locked by `gauntlet/claudeconn.js`, which boots with `VENIA_API_KEYS` removed —
the phone's exact situation — and stubs the relay both ways. Against live 389,
four of its six assertions fail.


## Build 394 — forgot password
*"Can we reset christine@veniacollection.com password?"*

Her sign-in is a **Supabase Auth** password — not Google, and not the shared
VENIA access code. She has signed in exactly once, on 23 July, 0.3 seconds after
the account was created, and never since. The app had no recovery path at all:
`resetPasswordForEmail` and `type=recovery` appeared nowhere in it.

- **"Forgot password?"** on the sign-in screen mails a link, restricted to the
  two founder addresses — the form is on a public page, and without the guard it
  would confirm-or-deny arbitrary addresses and spend VENIA's Supabase quota on
  them.
- The link is pinned to `VENIA_PUBLIC_BASE`, never `location.origin`: a link
  built from a `.netlify.app` or `github.io` address 404s for whoever opens it.
- **The recovery screen comes in above the access-code gate**, exactly as
  `?share` and `?agent` do. A recovery token proves control of the mailbox, so
  it is its own credential — and it can *only* set a password. The app stays
  locked behind the gate afterwards, so letting it past costs nothing. The
  founder sign-in stands down while it is up.
- Three link shapes are recognised, because the shape depends on which flow
  supabase-js is using: `?reset=1` (our own marker, for PKCE), `#type=recovery`
  (implicit), and `#error=…`. An expired or already-used link shows the reason
  and a way back, not a form that cannot work.
- On success it clears the token from the URL and reloads, so she returns
  through the ordinary front door rather than being dropped into the app by a
  link that is now spent.

Locked by `gauntlet/pwreset.js` — 14 assertions against a stubbed supabase-js
that records what the app asks of `auth`, so the test checks the app's calls and
not a mock's behaviour.

**Two Supabase settings decide whether the mail actually arrives, and neither is
reachable from here:**
1. **Authentication → URL Configuration → Redirect URLs** must allow
   `https://creator.veniacollection.com/*`, or Supabase refuses the redirect.
2. **Authentication → SMTP.** The built-in sender is rate-limited and meant for
   testing; production delivery wants custom SMTP.

If the email does not arrive, the fallback stands: her `auth.users` row is
disposable — **nothing** is keyed to her user id (no FK to `auth.users`, no
`user_id` / `owner` / `created_by` column in `public`, and all ten RLS policies
match on `auth.jwt() ->> 'email'`). Delete the row and her next sign-in
recreates the account with a password she chooses, losing nothing.


## Build 395 — an actual forgot-password
**The finding that decided the design: VENIA has no working mail sender.**
`/.netlify/functions/mail` with `{"action":"ping"}` answers
`{"configured":false,"from":""}` — `RESEND_API_KEY` is not set — and no function
holds a Supabase service-role key. So *no* emailed reset link can be delivered
today, whether Supabase sends it or we do. Build 394's flow was correct and
undeliverable. (Separately: this means **"Email — send as VENIA" is dead**, so
pull sheets are not going out from VENIA either.)

So the reset that works today does not use email. One signed-in founder sets the
other's password from Settings → Security.

**The guard is in the database, not the page.** `venia_reset_founder_password`
is `SECURITY DEFINER` — `auth.users` is not writable by `anon`/`authenticated`,
which is the whole point — so it carries its own checks:

- `set search_path = ''` with every name schema-qualified, so the definer's
  privileges cannot be turned against it by a caller-controlled search_path
- the **caller** must be a founder, proven by `auth.jwt() ->> 'email'`
- the **target** must be a founder, so it can never be aimed elsewhere
- 8 characters minimum — stricter than the sign-in screen's 6, because this one
  is typed by someone else and travels by voice before it is used
- existing refresh tokens for the target are revoked: a password change must end
  the sessions opened with the old one
- `EXECUTE` granted to `authenticated` only. Verified:
  `has_function_privilege` says anon **false**, authenticated **true**

Proven in SQL against the live database before any UI was wired to it:

| case | result |
|---|---|
| no JWT at all | blocked |
| signed-in non-founder | blocked |
| founder aiming outside VENIA | blocked |
| password too short | blocked |
| founder → founder | allowed; the new hash **verifies** under `crypt()`, so GoTrue would accept it |

The happy path ran inside a subtransaction that was then rolled back — both
password fingerprints are byte-identical to the baseline, so nothing was left
set. (plpgsql variables outlive the rollback; the write does not — which is why
the probe records its verdict *after* the handler.)

The UI derives the target rather than offering a field: there is no address to
mistype and the only account you can act on is your partner's. It is hidden
entirely unless a founder is signed in. `gauntlet/founderreset.js` — 11
assertions — covers both directions, the hidden case, and that a short or
mismatched password never reaches the database at all.

**The security advisor flags this function** under
`authenticated_security_definer_function_executable`. That is the design, not an
oversight: signed-in founders are exactly who may call it, and the function
checks the caller itself. It is deliberately **absent** from the `anon` version
of that lint.

Still worth doing when there is time: set `RESEND_API_KEY` (and verify the
domain at resend.com). It revives sending as VENIA *and* makes 394's emailed
reset work for real.


## Build 396 — the account menu, and a sign-out that finishes
*"Also we need a button for signing out of an account as well."*

There **was** one — buried in Settings → Security → Team sign-in, which nobody
will find — and it did not finish the job. Two faults:

- **The avatar was a hard-coded `K`.** `<div class="cp-gb-user" title="Keeter">K</div>`
  — a literal, with no behaviour attached. Christine's phone greeted her as
  Keeter on every screen.
- **Signing out left you inside the app.** `veniaSignOut` dropped the session and
  re-rendered a small status block, nothing more. The database is locked to VENIA
  accounts, so a signed-out session inside the app means every read and write
  quietly fails — the worst possible state, because it looks like it is working.

The avatar is now the account button, on every screen, desktop and phone: it
shows the initial of whoever is *actually* signed in (or `·` and "Not signed in"
when nobody is), and tapping it gives the full address and Sign out — or Sign in.
Signing out now brings the sign-in screen back up, so you land somewhere that
works instead of a workspace that cannot save.

`gauntlet/signout.js` — 11 assertions, including that the avatar reads **C** for
Christine, that it stops claiming an account after signing out, and that the
sign-in screen returns.


## Build 397 — a refresh keeps you where you were
*"Refreshing the page should keep you on the same screen."*

There was no route persistence at all: every reload dropped you on Today. On a
phone a reload is not rare — the PWA reloads on update, iOS evicts the tab under
memory pressure, and pull-to-refresh is one careless thumb away — so the tech
pack you were reading was gone every time.

`cpGoto` and `goTo` are the only two ways to move, so both now record
`{space, page}`; `routeRestore()` runs right after `init()`, once STATE is
loaded.

- **localStorage, deliberately NOT in `SYNC_KEYS`.** Where *you* are looking is a
  property of this device. Syncing it would mean Christine's phone jumping to
  Materials because Keeter opened Materials. The gauntlet asserts it never
  appears in the synced blob.
- **Unknown values fall back to Today** rather than stranding you on a screen
  that no longer exists — an old build's space name, a hand-edited store.
- **Share links, agent portals, the Stripe return and password recovery record
  nothing.** They are one-shot screens with no route to remember.
- For PLM, `STATE.currentPage` is set *before* `cpGoto('plm')`, since cpGoto
  renders that page itself — otherwise you would watch the dashboard flash past
  on the way to where you actually were.

One thing worth knowing for future tests: **PLM is the base layer.** There is no
`#cp-screen-plm`; the cp-screens are overlays, so "no active overlay" is what
being in Product looks like. Two assertions in `gauntlet/route.js` were wrong
about this before the app was.

## Build 398 — the gear moves into the account menu
*"Settings gear icon should move into the user icon."*

Settings is an account-shaped thing, and the global bar was the most crowded
strip in the app — a status pill plus four icons on a 390px phone. The gear is
now the first row of the avatar menu, so "who am I / my settings / sign out"
live in one place instead of two, and the bar is down to two icons.

`gauntlet/iconset.js` expected three bar icons and had to be corrected — the app
was right, the test was describing the old shape.


## Build 399 — a price you set is a fact; a margin describes two prices
*"If I set my retail at 585, but the COGS could be less, if I change the COGS it
changes the retail. Can we prioritize maintaining COGS/wholesale/retail and have
the margins adjust first?"*

Reproduced on the shipped build: with retail **$585** and wholesale **$234**,
typing COGS 60 rewrote them to **$375** and **$150**. `pxSet('cogs')` called
`flowDown()`, which recomputed wholesale from the *target* margin and then retail
from wholesale — so a cost estimate silently destroyed prices that were already
agreed with buyers.

The chain is unchanged; what moves along it is inverted:

```
COGS ──(your margin)──▶ WHOLESALE ──(boutique margin)──▶ RETAIL
```

- **Editing a PRICE** (COGS, wholesale or retail) leaves the other two alone and
  re-reads the margins that touch it. Wholesale sits between both, so editing it
  re-reads both.
- **Editing a MARGIN** moves the one price that margin defines — and only that
  one. Your margin moves wholesale; the boutique margin moves retail. The
  neighbouring margin then re-derives, so retail is never collateral damage from
  a cost change.
- **Work back** stays the single explicit way to run the whole chain backwards
  from retail, cost included.

**The one exception is a price that does not exist yet.** With nothing to
preserve there is no margin to read either, so a missing downstream price is
generated from the target margin — a brand-new style still gets wholesale and
retail built from a COGS. Preserve what exists; create what does not.

The popover footer now states the rule people actually get, rather than the old
"editing a price moves what sits below it".

`gauntlet/pricing.js` — 16 assertions walking the exact reported numbers. Against
the shipped build, eight of them fail, including "typing COGS 60 leaves retail at
$585" (it produced $375).


## Build 400 — the PLM and the store were speaking different languages
Inventory showed **0 units, $0k, an empty table**, and *"252 Shopify variants
matched no style by SKU"*. Two independent failures, both proven against the
real workspace and the real store.

**1. The page was hiding every style.** `renderInventory` filtered to
`active`/`sale`/`production`. Of the 64 real styles: **58 sms, 4 concept, 1
design, 1 archived — and zero in those three stages.** So even a perfect sync
would have rendered an empty table. Inventory now shows anything the store has
counted (or has a store code linked) whatever stage the PLM thinks it is at,
because stock is stock; with nothing linked yet it shows the line rather than a
blank page, so there is something to attach a code to.

**2. The SKU match could never have worked.** It compared Shopify SKUs against
`styleId` — but those are different namespaces:

| | PLM | Shopify |
|---|---|---|
| ANTIGONE SKIRT | `VN-SS27-WB08` | `20B001-2W-BLACK-XS` |
| SALIX T-SHIRT | `VN-SS27-WK03` | `19K003-4U-BLACK-XS` |

`devStyle` is null on every style, so there was no production code stored
either. Not a near miss — 252 of 252 could not match.

A style now carries `shopifySkus`, the store codes it answers to, tried before
`devStyle` and `styleId`. The sync collects unmatched **products** (not just
variants) and the Inventory page offers each one a style picker, pre-selected by
name, with the SKU's style-identifying prefix worked out as the longest common
prefix across the product's variants (`20B001-2W-BLACK`, not
`20B001-2W-BLACK-XS`). Linking is additive — a style selling in two colourways
answers to two codes.

**A title still never matches anything on its own.** It only pre-selects; a
person presses Link. Three products are literally named "SALIX T-SHIRT" in that
store, so a fuzzy rule would attach the wrong stock, which is worse than
attaching none. The comment that claimed SKUs are built as
`${styleId}-${COLOR}-${SIZE}` has been corrected — that assumption is what
failed.

`gauntlet/invlink.js` — 13 assertions built from the real shapes. Five fail
against the shipped build.

## Build 401 — Save was 1,166px below the fold
*"Save material is getting cut off here."*

`.modal-head` was sticky; `.modal-foot` was not. On Edit Material the form is
~1,985px with lot records, so at an 800px viewport **Save sat at y=1966** — you
had to scroll past every field and every lot to find the way out. Measured, not
guessed.

Footers are pinned now, for all eight modals, with a safe-area pad so they clear
the home indicator when a modal runs full height on a phone. `gauntlet/matmodal.js`
checks Save *and* Cancel are on screen on open and still there halfway down the
form, at three viewports; six of its assertions fail against the shipped build.
