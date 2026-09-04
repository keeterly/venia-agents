# VENIA OS — Open Items & Architecture Notes

_Last reviewed at Build 423._

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


## Build 402 — the same edit, whichever door you came in by
*"A lot of this should reflect the info that's on the Styles sheet, but there's
a dissonance right now."*

Build 399 made the rule in the pricing popover: a price you set is a fact, a
margin describes two prices. **`saveStyle` never got the memo.** It wrote
`cogs` / `wholesale` / `retail` straight through and never touched
`wsMarginTarget` or `marginTarget` — so:

- Change COGS in the **pricing popover** → the margins re-read from the prices.
- Change the same COGS in **Edit Style** → the margins stay where they were.

The Styles sheet then showed *"Your % 60 · Rtl % 60"* beside prices that produce
76%. Same style, same number, two answers depending on which door you used.

`pxReadMargins(st)` is now the single implementation, called from `pxSet` and
from both of `saveStyle`'s branches (existing and new styles). And the Edit
Style modal shows the two margins under COSTING, live as you type — read-only on
purpose: they are what the three prices produce, not a fourth number to keep in
step by hand.

`gauntlet/stylesync.js` walks one edit through both doors and checks they land
in the same place. Three of its seven assertions fail against the shipped build.

**Worth knowing (not a bug):** fabric, colourways, sizes and base size *are* in
Edit Style — on the Construction and Pattern tabs, not Identity. Only the
margins were genuinely absent.


## Build 403 — a selection of something deleted is not a selection
*"No style is selected but it still shows that it is. This was because I deleted
a style but the header didn't disappear."*

`BULK_SELECTED` kept the id of the deleted style, so the bar went on announcing
*"1 style selected"* over a list with nothing ticked — and worse, **every bulk
action would have run against an id that resolves to nothing**: Advance Stage,
Margin, Archive, Export, all silently doing nothing to a style that is gone.
Confirmed against the shipped build: the set still holds `["s1"]` after the
delete.

`bulkReconcile()` drops ids that are no longer in `STATE.styles`. Reconciling
against state rather than patching `dpDelete` covers every way a style can
leave, including a sync from the other founder's device removing one.

**The edge that made it interesting:** `renderStyles()` returns early when the
list is empty — which is exactly the case after deleting your last style — so a
reconcile living only in `updateBulkBar()` never ran. It is called at the top of
`renderStyles`, before anything can return, and the empty-state branch repaints
the bar on its way out.

`gauntlet/bulkbar.js` — 7 assertions; four fail against shipped.

**Found while fixing this: Build 402 shipped without a service-worker bump.**
`sw.js` was still on `venia-shell-v401`, so the fix was live on the URL and
invisible to anyone running the app from their home screen. The two numbers are
one decision and nothing but attention was keeping them in step — so
`smoke87.js` now fails the build if `const BUILD` and `venia-shell-vNNN`
disagree.


## Build 404 — the rail collapses, and zoom was fine
*"Have a way to compact left column. Also check to make sure that zoom in and
out scales properly."*

**Zoom checked first, measured on a 1440 screen at 100/110/125/150/175/200%:**
no page overflow at any level, the global bar never overflows, and at 200% it
correctly drops to the mobile layout. Zoom is not broken.

What the measurement *did* show is the real complaint. The rail is a fixed
220px, so its share of the window grows the further you zoom in:

| zoom | CSS width | rail's share of the row |
|---|---|---|
| 100% | 1440 | 15% |
| 150% | 960 | 23% |
| 175% | 823 | **27%** |

At 175% the navigation was taking a quarter of the screen from the table beside
it. It collapses now — from either the ‹ in any rail head, the › tab that
replaces it, or **⌘\ / Ctrl+\**. Per-device like the route, and it survives the
refresh that Build 397 made routine.

**It collapses to nothing rather than to an icon strip, on purpose.** This rail
is typographic — `.nav-item .ni{display:none}`, *"SSENSE has no icons in nav"* —
so a narrow strip would have to invent abbreviations for STYLES, SAMPLES and
SKUS and ask you to decode them. Hidden, with one tab back, is honest and
reclaims the whole 220px: at 175% the content went from 603px to 823px.

One rail system, one control: the six Growth/Sales/Money rails collapse with the
PLM one. `gauntlet/rail.js`, 13 assertions. **The PLM rail's head is indented
differently from the other six**, so the first pass silently skipped the very
rail in the screenshot — the gauntlet counted controls and caught it.

## Build 405 — the fabric fields offer what you already use
*"When adding a style in a diff fabrication, the fabric section doesn't show the
fabrics already in the library but it should."*

Primary and Secondary Fabric were bare text inputs. They now carry a datalist —
still typeable, since a genuinely new fabric has to be enterable — drawn from
**two** sources:

- the Materials library (skipping trims and labels; an *untyped* material is
  offered rather than hidden, since untyped usually means cloth), and
- every fabric already typed on a style, which is where most of them actually
  live — offering only the library would leave "Tencel Twill" missing from the
  list while sixty styles are made of it.

Deduped case-insensitively, which is the point: it is how "Tencel Twill" and
"tencel twill" stop becoming two materials.


## Build 406 — a quote's season is the season of what is on it
*"Check to make sure this quote page is in sync, like Season."*

The field defaulted to the string `'FW26'` — `q?.season || 'FW26'`, a literal
written once and never true again — so a quote for an SS27 skirt opened saying
FW26.

It is read off the line items now: the most common season among the styles on
the quote, re-read whenever a style is added or swapped. An empty quote falls
back to the season the line is actually working in (the most common across
non-archived styles) rather than any fixed string. **A season you type yourself
is never overwritten**, and an existing quote keeps whatever it was saved with.

`gauntlet/quoteseason.js`, 6 assertions.

### Answering the other half: quote → order already exists
`slCreateOrderFromQuote` carries the account, items, sizes, units, total,
currency, terms, ship window and cancel date across, stamps `createdAt` as the
booking date (deliberately not `updatedAt`, so a later edit cannot re-date the
revenue), links `quote.orderId` both ways, and refuses to convert twice. Two
ways in, **both gated on status = Accepted**, which is why a Draft quote looks
like a dead end:
- set a quote to **Accepted** and save → it offers to create the order
- or the quote row's **→ Order** button, shown when accepted and not yet converted

### Still to build: capturing payment on the terms
`SL_TERMS` is already a parseable schedule — Proforma, 30/70, 50/50, Net 30/60/90,
2/10 Net 30, card on file — and `netlify/functions/stripe.js` already serves
`invoice`, `invoice_status`, `invoice_find`, `create`, `capture` and `cancel`
for the pull sheet. So the wholesale side is a schedule derived from the terms
(deposit now, balance before ship) driving the same invoice machinery, plus the
same reconcile loop that Build 378 gave pulls so an order says *paid* without
anyone checking Stripe.


## Build 407 — the terms are the payment schedule
*"Need to be able to capture the order based on the terms… same kind of
processing as the Pull Sheet but set up for wholesale."* — both ways.

**The terms were decoration.** An order carrying *"30% deposit / 70% before
ship"* billed `amount: o.total, days: 14` — the whole $2,730 due in a fortnight,
every time, whatever the buyer had agreed to. `SL_TERMS` is a closed list, so
reading it is a lookup, not a guess:

| terms | schedule |
|---|---|
| 30% / 70% | Deposit 30% on order (7d) · Balance 70% before ship (30d) |
| 50% / 50% | the same, split evenly |
| Proforma | in full, before ship |
| Net 30 / 60 / 90 | in full, due in N days |
| 2/10 Net 30 | in full at 30 days, carrying the 2% early-payment note |
| Credit card on file | in full, on order |
| *none set* | once, in full — **and it says so** rather than inventing a split |

**The balance is the remainder, not its own percentage.** Rounding both shares
independently leaves them a cent off the order at awkward totals, and an invoice
pair that does not reconcile is an argument with a buyer waiting to happen.
Checked at 0.05, 1.01, 333.33, 999.99 and 12,345.67.

**Both ways to collect, per instalment:**
- **Invoice** — a real Stripe invoice, emailed with a pay link, on that
  instalment's own due window
- **Card link** — a Stripe Checkout link, copied to the clipboard to send. The
  buyer enters the card; VENIA never holds card details, the same rail the pull
  sheet uses.

`order.payments[]` tracks each instalment separately, and **↻ Check Stripe**
reconciles every one — the pull-sheet idea from Build 378: an order should say
*paid* without anyone opening Stripe to find out. When every instalment is paid
the order's own status follows the money.

**Two bugs fixed on the way:**
- Every wholesale invoice was going to Stripe **labelled as a stylist pull** —
  the server has supported `kind:'wholesale'` all along and the caller never
  passed it.
- An order invoiced before this build keeps that invoice, folded in as its first
  instalment, so nothing is lost or billed twice.

`gauntlet/wholesalepay.js` — 22 assertions against a stubbed Stripe that records
what the app asks for, so it checks our calls rather than a mock's behaviour.


## Build 408 — the visual line sheet
*"Export a visual line sheet that is landscape and has several styles per page…
image at the top and then the style information beneath it. Customizable based
on the amount of styles I want per page. And be able to export all genders or
men's or women's or unisex or a combination of any of them."*

The table export answers *what does it cost*. A buyer decides on the **garment**,
so this one is landscape, a few styles to a page, photo first and the numbers
under it. Same data, same season filter, same trade footer — only the shape is
different. **Export list** and **Export visual** now sit side by side.

- **1, 2, 3, 4, 6 or 8 per page**, three by default. Landscape, so 1–4 sit in one
  row and 6 and 8 take two; the photo grows when there are fewer to a page
  (108mm in a single row, 52mm in two).
- **Genders as a combination, not a choice** — tick any of Womens / Mens /
  Unisex, and *Gender not set* appears only when the line actually contains
  styles with none. Nothing ticked means all, which is what the dialog says and
  what the sheet does.
- The dialog states the outcome before you commit: *"8 styles over 3 pages — 3
  per page, landscape."*

**Details that decide whether it reads as a real line sheet:**

- **Pages are chunked in JavaScript, not left to flow.** A page break that
  depends on how tall a photo happens to render is how you get four styles on
  one page and a lone orphan on the next.
- **A short last page keeps its column width** using hidden filler cells —
  otherwise two styles stretch across the whole sheet and the last page looks
  like a different document.
- **`min-height`, not `height`**, on the page: 190mm fills A4 landscape less its
  margins, but a long colourway list has to be able to grow rather than be
  sliced off at the page edge.
- **The export waits for the images to decode** — every `<img>`, with a 6s
  ceiling so one slow photo cannot hang it — rather than guessing at a delay.
  The old table export guesses 1500ms.
- A style with no photo says so instead of collapsing its card.
- On screen it is shown as paper: page margins, a grey ground, an edge between
  pages. Print ignores all of it.

`gauntlet/vls.js` — 20 assertions, including the page arithmetic at every
per-page setting (1→8 pages, 2→4, 3→3, 6→2, 8→1) and that a mens-only sheet
carries only the mens styles and says so in its header.


## Build 409 — the line sheet reads a category at a time
*"It should be sorted by category as well — tops : bottoms etc."*

A buyer works a sheet one category at a time, so the order is now
**Tops · Bottoms · Outerwear · Dresses · Accessories** — `RP_CATS`, which is
already the line's canonical order in the range plan. Reusing that rather than
writing a second list is what stops the two drifting apart later.

- **Not alphabetical.** Accessories would otherwise lead the sheet and Tops
  land fourth.
- Within a category, by name.
- A category that is not on the canonical list (a one-off like Swimwear) sorts
  **last, grouped with the others, alphabetically** — never interleaved through
  the sheet.
- **Sorted in `slLsStyles()`, not in one exporter**, so the preview, the list
  export and the visual sheet cannot disagree about the order of the same line.
- The visual sheet's page header now names the categories that page carries —
  *"SS27 · Wholesale · all genders · Bottoms / Outerwear / Dresses"* — so a
  buyer knows where in the line they are.

`gauntlet/lscat.js`, 9 assertions, including that no category ever appears as
two separate blocks and that both exports produce identical ordering.


## Build 410 — the line sheet as a trade document
*"We can improve this formatting… include Country of Origin… other line sheet
relevant information… and export in various currencies."*

**The image was cropping garments.** `object-fit: cover` on a full-length
cutout takes the hem off the page. It is `contain` on white now, inside a
hairline frame — a little white space, and never a picture of a garment with
its bottom cut off. Empty frames are dashed and quiet, and say *"Photo to
follow"* rather than "No photo".

**What a line sheet owes a buyer, added:**
- **Country of origin** and **composition** — both already on the style (the
  tech pack's care-label check reads the same two fields) and never carried
  onto the sheet. A line sheet is a customs document too: origin decides duty,
  composition decides the tariff code.
- **Delivery, per style** — the footer only ever carried the season window, and
  a Delivery 2 piece is exactly the exception that needs saying. Formatted
  *15 Jan 2027*, not an ISO stamp.
- **A way to order.** The footer now carries terms, MOQ, delivery window and a
  contact. A line sheet with no way back to the brand is a catalogue.

**Currency.** Chosen per export from the ten the app knows, converted at the
**season rate** `fxEnsureRate` already holds — asked for at the moment you pick
the currency, not silently at export. With no rate it prints USD and says so
rather than inventing a number. The sheet states the conversion on every page:
*"Wholesale prices in EUR, FOB — converted at 0.92 EUR to 1 USD, the season
rate."*

Also: **only styles with a photo**, optional, since 24 pages of grey frames is
not a document you send a buyer. The dialog says how many that leaves out.

### The bug this nearly shipped with
Adding three fields and a four-line footer pushed a full card **past the page**.
Content that overflows is not clipped — it flows onto another sheet, so *"3 per
page"* quietly becomes 3, then 1, then 3. Measured with every optional field
filled and long values:

| | before | after |
|---|---|---|
| 1–3 per page | 202.5mm | **182.5mm** |
| 4 per page | 196.5mm | **180.5mm** |
| 6 / 8 per page | 252.9 / 258.2mm | **183.8mm** |

*(A4 landscape gives 190mm.)* The image height now follows the **column** count
as well as the row count — narrower columns wrap long values onto more lines, so
a 4-up card is taller than a 3-up one at the same image height, which is how
4 per page overflowed while 1, 2 and 3 fitted. **The gauntlet found that one**:
I had measured 1, 2, 3, 6 and 8 by hand and never 4. At two rows a card carries
only what stays legible at 40mm — composition and origin belong on the roomy
layouts and in the list export, not squeezed until nothing can be read.

`gauntlet/vls.js` now asserts every density fits A4 with every field filled, so
the next field someone adds cannot silently break the page count.

## Build 411 — swatches, keystone, and the style's own words
*"add all, description should also be synced to style as well."*

Three things I'd flagged as missing from the visual line sheet and left for a
decision. All three are in.

**Colour swatches beside every colourway name.** Painted from the same
`colorDef` / `colorCssFrom` vocabulary the material cards and the Colorways
column use — one colour library, so paper and screen can never disagree about
what *Parchment* looks like, and patterns (melange, pinstripe, check) come
through as patterns. A colour the library has **no swatch for prints hatched**,
never as a guessed colour: the buyer is told we don't know it rather than shown
the wrong one. The hatch is deliberately high-contrast — a pale one at 2.2mm
reads as a light colour, which defeats the whole point.

**Keystone.** `2.5×` beside the retail price, arithmetic on the two prices
already on the card rather than a stored field that could disagree with them.
No extra row: it sits in the Retail cell.

**The style's copy.** `desc` — *the same field* the Styles column, the Edit
Style modal and the tech pack read. Edit it in PLM and the next export says
the new thing; there is no second copy to drift. Two lines on a roomy card,
one at 4-up, none at 6/8 where a card is 34mm tall. Cut on a word boundary in
JS, not left to the renderer, so the card's height stays something we can
measure.

**⚠️ That field is also where factory notes go.** `sm-desc` is labelled
*"design intent, silhouette inspiration, fit references, mood, any notes for
manufacturer"*. One field synced both ways means internal notes can reach a
buyer. So the dialog has an **Include style copy** tick — on by default, and
its tooltip says exactly why you might turn it off. Read the field before
sending the sheet.

### Two things that would have shipped broken
**Backgrounds don't print.** Swatches are CSS backgrounds, and browsers drop
backgrounds from printed output unless told not to — the chips would have been
perfect on screen and blank on paper. `print-color-adjust: exact` is now set on
the export document.

**The page budget moved again.** Copy and chips both cost lines, so the photo
gives room back: image height is now 76mm at 1–3 up (was 88), 60mm at 4-up
(was 72), 34mm dense (was 40). Re-measured with every field filled, a long
description and **five** colourways including a long name:

| | 410 | 411 |
|---|---|---|
| 1 per page | 182.5mm | **176.2mm** |
| 2–3 per page | 182.5mm | **183.8mm** |
| 4 per page | 180.5mm | **178.5mm** |
| 6 per page | 183.8mm | **178.3mm** |
| 8 per page | 183.8mm | **184.8mm** |

*(A4 landscape gives 190mm.)* A first pass at 38mm dense came in at 186.3mm
with only four colourways — inside the page, but not with enough room for a
fifth. Chips make colourway lists wrap where plain text didn't.

`gauntlet/vls.js` gained 13 assertions for this. Run against Build 410 first:
11 of them fail, which is what makes them worth having.

## Build 412 — the sheet as a showpiece, and what may leave the building
*"reduce padding on outer edges… keep 1 per column… crop the image inwards…
description at the bottom… email should be sales@… we should never mention
creator.veniacollection.com publicly since it's an internal tool."*

**⚠️ The internal host was printing on a buyer's document.** The visual line
sheet footer said *"To order: keeter@veniacollection.com ·
creator.veniacollection.com"* — the internal tool's hostname, on a page handed
to stockists, plus whichever founder happened to run the export. Both are now
brand constants declared beside `VENIA_PUBLIC_BASE`, with a comment saying which
is which:

- `VENIA_PUBLIC_BASE` — **internal**. Factory share links, our own NFC/QR tags.
  Never on a document an outside party reads.
- `VENIA_PUBLIC_SITE = 'veniacollection.com'` and
  `VENIA_TRADE_EMAIL = 'sales@veniacollection.com'` — outward-facing.

A gauntlet assertion now fails the build if `creator.` or a personal address
appears in that footer. The rest of the app was already clean: the press kit,
the PO signature block, care labels and buyer emails all used
`veniacollection.com` already.

**Still to decide (not changed):** garment NFC/QR tags encode
`creator.veniacollection.com/?tag=<styleId>` and travel out on sample garments.
Anyone scanning one lands on the login gate, so nothing leaks but the hostname —
but tags already printed cannot be changed, so this is a decision, not a fix.

**Layout.** Margins 10mm → **7mm** (196 × 283mm of content). One style per
column, always a single row — 6 and 8 per page no longer stack into two rows.
The photo is scaled up 1.16 inside its frame and the overflow clipped: an even
crop inwards into the white margin a packshot carries, rather than `cover`,
which crops to fill and takes hems off. The description moved to the **foot** of
the card (`margin-top:auto`), so the copy lines up across every card whatever
the spec above it is, and the dead band under a short card is gone.

Past four across, the two-column spec table stopped working — a 34% label
column beside "Heavy Washed Cotton Jacquard" wrapped to four lines and no two
cards lined up. At `dense` the label now sits **above** its value. And `.nm`
reserves two lines whether or not the name needs them: one long style name used
to push its whole card down out of line with its neighbour.

### Measurement, again
Every layout re-measured with every field filled, a long description and five
colourways. Image heights by column count: `{1:76, 2:68, 3:64, 4:66, 6:84,
8:76}`. Three passes were needed — the first two overflowed by 7–25mm.

The page-total check had also stopped being informative once every layout sat
on the 182mm floor: a card can overflow its own grid cell inside a page that
fits. The gauntlet now measures each card against the cell it was given, as
well as the page.

**A colour-library check against real data** (72 styles): every colourway in
the live line resolves to a swatch — `black`, `oxblood`, `parchment` and
`black pinstripe` from the house library, `ivory` and `natural` from the
built-in table, and `printed parchment` down-matching to `parchment`. No
hatched chips. Worth knowing before shipping a feature that would otherwise
have printed 24 pages of "we don't know this colour".

## Build 413 — the block sits on the page, and the keystone comes off
*"lets vertically center align the content / we also dont need the 2.5x"*

**Keystone removed.** `slVlsMarkup` and the `.mk` rule are gone rather than
left unused — a retail price says what it says.

**The page is balanced.** On the real line the cards used about 110mm of the
182mm page and every spare millimetre piled up underneath them: no country of
origin on any of the 72 styles, no composition, and a description on 19 of them.

The fix is in the grid, not the card. The row track is **auto** (as tall as the
tallest card) and `align-content:center` puts that track in the middle of the
page. Both halves matter:

- an auto track means every card stretches to the same height, so the type stays
  level across the sheet and the copy still pins to a shared bottom edge;
- centring the *track* splits the leftover page above and below the block.

Centring each card instead (`justify-content:center` on `.c`) would have done
the opposite — a card with one fewer colourway rides up out of line with the one
beside it. The gauntlet asserts both halves: the free space above and below is
within 2mm, **and** every card on a page still starts on the same line.

One harness bug found writing that: the level check first read `.c` across the
whole document, so cards on page two counted as misaligned. Scoped to one grid.

## Build 414 — the refresh blip
*"refreshing the page has a blip that shows unstyled html page."*

**It was real, it was five seconds long, and it was one `<style>` tag in the
wrong place.**

The app's home screen and nav bar were styled by a `<style>` block **2.7MB into
a 2.9MB document** — after the markup it styles. `.cp-space` (the nav pills),
`.cpl-door` (the PRODUCT / SALES / GROWTH / MONEY cards), `.cpl-pulse`,
`.toast`, `.mob-card-list` and `body` itself all lived there, tucked behind 500
lines of Eni/Nigma CSS where nobody would look for them. The head sheet carried
707 rules; that block carried the other 128.

The browser paints as soon as the head sheet is in — about **240ms**. It does
not see the last 128 rules until the stream finishes, about **5.4 seconds**.
Everything in between is the app rendered as raw HTML: tab pills as default
browser buttons, the home screen as a list of unstyled paragraphs.

Measured, at a document streamed at 4 Mbps:

| | Build 413 | Build 414 |
|---|---|---|
| nav unstyled for | **5,182ms** | never |
| home cards raw for | **5,182ms** | never |
| rules at first paint | 707 of 835 | **835 of 835** |

The block is now at the END of the head sheet — last in the cascade, exactly
where it was relative to every other rule, so nothing changes but when it
arrives.

### Two more things were on the critical path
Both found by measuring what first paint was waiting for, not by reading:

- **The Supabase library was parser-blocking in `<head>`.** `<script src=…>`
  with no `defer` stops the parser dead until a CDN in another country answers.
  Deferred now. The catch: `sbInit` was called from an IIFE that runs *during*
  parse, so a naive `defer` would have left `window.supabase` undefined — and
  that path doesn't throw, it just quietly leaves cloud sync off. The boot now
  runs immediately if the library is there and on `DOMContentLoaded` otherwise
  (deferred scripts are guaranteed to have run by then). The gauntlet asserts
  the client actually initialises.
- **The font stylesheet is render-blocking, and stays that way** — without the
  `@font-face` rules the page paints in Helvetica and reflows when Archivo
  lands. Instead of unblocking it, it got cheaper: `preconnect` to both font
  hosts opens DNS/TCP/TLS while the HTML is still streaming. And
  `display=swap` → **`display=optional`**: swap means "paint in the fallback
  now and re-flow the whole page later", which is a second flash. `optional`
  gives the font ~100ms — always met once cached, which for a daily-use PWA is
  every load after the first — and otherwise keeps the fallback for that load
  and never swaps.

`gauntlet/fouc.js` is new and had to build its own server: **localhost hands
over 2.9MB in 200ms**, so no local test could ever have caught this. It streams
the document in 32KB chunks at 4 Mbps and samples the nav's computed padding
from the first frame it exists. Seven of its nine assertions fail against
Build 413.

### Still open
The service worker is **network-first** for the app shell, so every refresh
re-fetches 2.9MB before painting. Stale-while-revalidate would paint instantly
from cache — but it changes when a deploy lands, so it is a decision, not a fix.

## Build 415 — MODULES, and seven assistants becoming one
*"Merge them, have one entity named ENIGMA." / "Modules — let's do 1 and 2."*

Step 1 of the module plan and the assistant merge are **the same refactor**: the
registry is what a single assistant reads to scope itself. So they shipped
together.

### The registry
`MODULES` is now the one place that says what this system is made of — seven
modules (Today, Product, Growth, Sales, Money, Brainstorm, Settings), each with
its screens, the STATE keys it owns, what it owns in words, and the actions it
grants.

It is **load-bearing, not documentation**:
- `SYNC_KEYS` is now *derived* from it. There is no second list to keep in step,
  and a new key with no module is a key that dies on the next save — which is
  the finCats bug from Build 363, now impossible to reintroduce by omission.
- `AGENT_REMIT` is derived from it too. The handoff text and the module map
  cannot disagree about who owns what, because there is only one of them.
- **Every STATE key belongs to exactly one module.** Verified: 64 keys, none
  dropped, none duplicated, none orphaned, against the shipped build. That
  partition is the whole reason step 2 — per-module storage and per-person
  access — is later a mechanical change rather than a rewrite.

Marketing and Brand are screens of **Growth**, not modules of their own. You
cannot sensibly hand someone Marketing but not Brand.

### ENIGMA
There were **seven** personas, not three: Eni and Nigma in the dock plus PR,
Marketing, Sales, Brand and CFO. They were never really seven — every one of
them already funnelled into the same dock and the same `SK.history.eni`. What
actually differed was the SCOPE. So the personas are gone and the scope is kept:

    ENIGMA_SYS   — who it is. One voice, one set of rules, everywhere.
    VENIA_CANON  — what is true about VENIA. Every turn, every module.
    MODULE_FOCUS — the discipline of the work you are currently doing.

**The merge fixed something that was quietly wrong.** The brand's own story —
positioning, the placement history, what the press angle actually is — lived
inside the PR agent's persona string and *nothing else could see it*. Ask the
dock for a caption and it knew none of it. It is `VENIA_CANON` now, and the
gauntlet asserts it reaches every module.

Migrations, because a merge that loses work is not a merge:
- The stored two-thread history keeps **Eni's** thread — the one everything
  funnelled into. Nigma's is used only if Eni's is empty. They are NOT
  interleaved: stored turns carry no timestamps, so splicing them would produce
  a transcript that never happened.
- Two unread counters become one (1 + 2 = 3).
- A cloud job queued as `eni` or `nigma` before this build still lands. Nothing
  in flight is stranded by the rename.

### What the suite caught that I had missed
- **`SK.history[agent]` in `cfoChatApply`** — a local variable, so it survived
  the pass that rewrote `SK.history[SK.agent]`. Every cloud-queued reply would
  have thrown on arrival: the answer generated, paid for, and dropped. smoke6.
- **The CFO's read-capability block** — I folded the persona into the Money
  focus and dropped "WHAT YOU CAN DO", reasoning the action specs covered it.
  They don't: the specs cover *writes*. The prose is what tells it it can read
  the LEDGER, the CASH CALENDAR and OPERATIONS. Restored. smoke14/19/21/22/29.

Twelve smoke suites were pinned to the old structure and were updated to the
new one with their intent intact — the persistence checks now ask "does a module
claim this key?", which is a stronger question than "is it in that array?".

## Build 416 — the workspace splits, and access becomes a permission
*Step 2 of the module plan.*

**The constraint this removes.** `venia_workspace.data` was the entire STATE in
one jsonb blob, and RLS is per-row — so access was all-or-nothing. You could not
give someone Sales without also giving them cost, margin and factory terms.
That is *why* the sales-agent portal had to be built as a separate surface
rather than a permission.

Two new tables (`supabase/migrations/20260831_venia_modules.sql`, applied):
- **`venia_members`** — `(email, module, role)` where role is owner / editor /
  viewer. Both founders own all eight modules.
- **`venia_module_data`** — the workspace, one row per module.

The policies ask two questions, through SECURITY DEFINER helpers so the
membership lookup is not itself subject to RLS (without that, the policy on the
data table recurses into the policy on the members table and denies everything);
`search_path = ''` on both, and `anon` cannot execute either.

**Verified against the live database, not reasoned about** — a throwaway
workspace, three scoped identities, then cleaned up:

| | result |
|---|---|
| sales editor reads | **only the sales row** — not money, not product |
| sales editor writes sales | allowed |
| sales editor writes money | blocked, the row is invisible |
| **sales editor grants themselves money** | **blocked by RLS** — no self-escalation |
| viewer reads sales | 1 row |
| viewer writes sales | blocked |
| stranger | 0 module rows, 0 membership rows |
| founder | everything |

### The app side is two functions
`moduleSplit()` on the way out, `moduleAssemble()` on the way in. Everything
downstream — the 3-way merge, `save()`, the realtime apply — still works on ONE
snapshot object. A merge that had to reason about eight rows would be eight
times the places to lose an edit.

The gauntlet asserts the round trip is **lossless**: all 64 STATE keys and all
13 standalone localStorage stores come back identical, `_who` included.

**The blob is still written, as a mirror.** One build of belt and braces: if
anything about the split is wrong the whole workspace is still in one row
exactly as before, and the rollback is deleting six lines. Pull prefers the
module rows and falls back to the blob only when they are empty — which is
every boot until the first push after this build.

### An eighth module, and why
`VENIA_CC_DB` is a legacy multi-table localStorage store that predates all of
this. It holds `slBuyers`, `slQuotes`, `slOrders`, `leads`, `mediaContacts`,
`brTone`, `mkPrefs` and `pos` — sales, growth AND product, in one string. It
cannot be split by the registry. Putting it in an always-granted module would
have handed a Product-only person the buyer list, so it lives in a **`legacy`
module that is founders-only and deliberately never granted**. A scoped member
simply never receives it, and the features it backs are empty for them until it
is broken up properly. That is a known limitation, written down rather than
discovered later.

`EXTRA_LS_KEYS` is now derived from the registry too — a standalone feature's
localStorage key needs an owner as much as a STATE key does.

### What is NOT done
Nothing in the UI grants access yet. `venia_members` is real and enforced, but
adding a person is currently an INSERT. The screen for it is the next step, and
it should wait until there is someone to add.

## Build 417 — checking the refactor didn't break what was already there
*"Ensure that any of the build or refactor doesn't break what we've already built."*

Three real problems, two of them mine and only one of them something a test
would ever have found on its own.

### 1. The new realtime table was never published
`venia_module_data` was created but not added to `supabase_realtime`. The app's
new subscription was listening to a table that emits nothing — and worse, two
listeners on **one channel share its fate**: a subscription that errors takes
the working `venia_workspace` listener down with it, and partner live-sync goes
quiet with nothing on screen to say so.

Fixed both ends: the table is published (`replica identity full`, because
realtime applies RLS per change and `module` is what every policy keys on), and
the module listener now has **its own channel** so it can fail alone.

### 2. A module write could abort the whole push
The per-module upsert sat inside the same `try` as the blob write. A throw —
dropped connection mid-upsert, a policy rejecting one row — would skip the blob
entirely and the founder's edit would reach nothing at all. The blob is the
mirror the workspace can be recovered from; it must be unconditional. Its own
`try/catch` now.

### 3. A partial read is not a deletion
With one blob, "the cloud is missing a key" barely happened. With eight rows and
RLS it is **routine**: a scoped member is returned fewer rows *by design*, and a
founder can get a short read from a dropped connection. If the merge read absent
as deleted, one partial read would wipe every module it could not see.

It does not — `mergeSnapshots` already keeps the local value when the cloud has
none. That was already correct; what changed is that it is now load-bearing, so
it has an assertion.

### The regression method
`gauntlet/regress.js` is new and is not a feature test — it is a **behavioural
fingerprint**. It drives the real app through every space and every major
surface, records what it finds, and prints a report. Run it against the build
before the refactor and the build after, and diff.

Before (414) vs after: **one line differed** — the Product screen showing 302
controls instead of 304. Chased rather than assumed: the two are `sk-tab-eni`
and `sk-tab-nigma`, with `sk-launch` renamed from "Eni · Nigma" to "Enigma".
Exactly the intended change and nothing else.

The live Build 416 was then booted with the **real** Supabase library served
locally, because the sandbox has no route to a CDN and the question was never
whether jsdelivr is up. It is whether deferring that script still ends with a
client built — `sbInit`'s failure path does not throw, it just leaves cloud sync
off. It does: library loaded, client built, eight modules, 64 keys, zero errors.

### Two things the harness itself got wrong
Worth recording, because both produced a false "this is broken":
- The probe swept `.overlay` elements with `.remove()` between surfaces.
  `#search-modal` is a **static element in the document** — deleting it took
  search out of the DOM for every later probe, and the report said search was
  broken when it works perfectly. It closes overlays now instead of deleting
  them.
- Console errors were counted including `ERR_CONNECTION_RESET` from the
  sandbox's blocked egress — ten lines of noise that would have hidden a real
  error. Filtered.

## Build 418 — the Enigma bubble, and MORE
*"The enigma notification bubble should be clearer… we also need to trim the
extra functions or pathways from MORE. More and hamburger top left do the same.
In that case is More necessary."*

### The bubble had a real bug, and it was the notification that caused it
The launcher is icon-only on phones because of one rule:
`#sk-launch span:last-child { display:none }` — hide the label, keep the
sparkle. But `skPaintUnread()` **appends** the count badge to the launcher. So
the moment Enigma had a reply waiting, the badge became the last child:

- the rule hid **the count** instead of the label, and
- **the label came back** — "ENIGMA" spilling out of a 46px circle and off the
  right edge of the screen.

Which is exactly the screenshot. The one state where the bubble most needed to
be readable was the only state that broke it, and it broke *because* of the
notification.

Reproduced at a real phone viewport before touching anything: with three unread,
`sk-launch-label` was `display:block` and `.sk-unread` was `display:none`. The
label is hidden **by class** now, so nothing appended can steal the rule.

### What it does now
A circle with the AI sparkle inside, the count on it, and two signals at
deliberately different speeds:

- **the button hops twice on arrival** and stops — "it just landed". A button
  that keeps hopping is one you stop seeing.
- **a ring keeps breathing** (2.6s, soft) for as long as the reply is unread —
  "still waiting". That is what makes it readable across the room without
  turning the corner of the screen into an alarm.

The ring is **ink, not white**: it floats on the app's white page, so a white
ring expanding off a dark button is a ring nobody can see — which was the whole
point of adding it. With `prefers-reduced-motion` the ring stops moving and
stays visible: the message is not the animation.

### MORE: no, it was not necessary
Checked rather than assumed. The MORE tab called `openDrawer()` — **the identical
function, with no arguments**, that the ☰ in the header calls. And the ☰ is on
every space (verified at a phone viewport: 1 on Today and Product, 2 on Growth,
Sales and Money — all wired to `openDrawer`). So MORE was a sixth of the tab bar
spent on a second door into a room already one tap away.

Removed. Five tabs now, each an actual place, with more room per target. The
drawer still carries everything the bar does not — Brainstorm, Settings, and the
section list for whichever space you are in — which is what MORE was for.

### Two harness faults, again worth recording
The new gauntlet reported the drawer as empty. It was not: `openDrawer()` slides
the panel in, so reading it immediately reads nothing, and `innerText` comes back
CSS-uppercased so a mixed-case match found none of it. Both fixed — a test that
reports a working feature as broken is worse than no test.

## Build 419 — one menu button, and a regression Build 418 shipped
*"Collapse."*

### ⚠️ Build 418 broke the menu on Today. This fixes it.
Removing the MORE tab was right — it called `openDrawer()`, the identical
function the ☰ calls. What was wrong was the check that said it was safe: the
gauntlet asserted the ☰ was **visible** on every space. Visible is not tappable.

`.cp-screen` is `position:fixed; z-index:400`. `.mob-header` — which holds the
☰ on Today — is `z-index:300`. So on Today the button was painted, and buried
under the page. Hit-testing its own centre pixel returned `H1.cpl-title`. With
MORE gone there was **no way to open the menu on Today at all**.

Found by tapping, not by looking: aim at the button's centre, click the screen,
require the drawer to open. Today failed; every other space passed.

### The collapse
There were **three** menu buttons doing one job, and all three called
`openDrawer()` with no arguments:

| | state |
|---|---|
| `.mob-header` ☰ | buried under every `.cp-screen` — reachable only on Product |
| six `.ag-topbar` ☰ | one per agent screen, each a copy |
| the MORE tab | removed in 418 |

The global bar is the only chrome above `.cp-screen`, so the button lives there
now and reaches every screen **including Today**. The other two are off, and the
duplicate `.mob-header` — which was painting "Dashboard" and a search field
nobody could reach — is hidden wherever a screen brings its own bar.

Result: one door, in the same place, on all eight screens. The section bar keeps
its title and its actions and gets the width the ☰ was using.

### A cascade trap worth recording
The first attempt put `.cp-gb-menu{display:none}` next to the markup and
`display:flex` in the ≤768 block — and the button never appeared on any screen.
The media block is at line 1119; the base rule landed at ~1365. Equal
specificity, later wins, so `display:none` beat the media query. It is declared
beside `.ag-mob-menu{display:none}` now, above the block, which is the
convention the file already had for exactly this.

### The lesson in the gauntlet
`gauntlet/mobnav.js` no longer asks whether a button is visible. It finds the
button, aims at its centre pixel, clicks the *screen*, and requires the drawer
to open — on all eight spaces — and asserts there is exactly **one** such button.
That assertion fails against Build 418.

## Build 420 — the per-module split, confirmed on real data; one search button
*"I opened the app. Product has styles header. Growth sales and money have
Overview header."*

### The split is verified against the live workspace
The founders opened the app, the first push ran, and all eight module rows
landed at the same second as the blob mirror:

| module | carries |
|---|---|
| product | **72 styles** |
| sales | **82 buyers** |
| money | **227 bank transactions** |

- 57 data keys in the blob, **57 in the module rows — none lost**.
- **No data key appears in two modules.** The only keys in more than one row are
  `_ls` (4) and `_who` (8), both meta, both by design.
- Styles exist only in `product`, buyers only in `sales`, transactions only in
  `money`. The partition holds on the real data, not just the fixture.

### The headers are not inconsistent
"STYLES" on Product and "OVERVIEW" on Growth/Sales/Money is the **same rule**
producing different answers — each names the page you are on inside that space.
Checked by navigating, not by reading:

    Product   Dashboard → Styles → Material Library → Vendors
    Sales     Overview → Line Sheets → Buyers (CRM) → Quotes → Wholesale Orders

Two different components (`#mob-page-title` set by `goTo()`, `.ag-page-title`
set by the section navigator) — but one behaviour. Nothing to fix.

### One thing that WAS a duplicate
Product's header carried a second search button calling **`openSearch()`** — the
same function opening the same modal as the one in the global bar, two inches
away, on Product only. Same shape as MORE and the three hamburgers. Removed.

The Styles page's own "Search styles — commas for several…" box is a **filter**,
not the global search, and stays. The gauntlet asserts both: exactly one
`openSearch()` button on Product, and the filter still present.

## Build 421 — Team & Access, the screen behind venia_members
*"Build ui."*

Settings → System → **Team & Access**. Grant a person modules, set a role, take
one away, remove them, and create or reset their login.

### ⚠️ A security decision this quietly reverses — read this
`agent-portal` says, in its own words:

> *Password login (deliberately NOT Supabase Auth) — An agent must never hold a
> Supabase JWT: that would make her the `authenticated` Postgres role, and every
> RLS policy would then be the only thing standing between her and the
> workspace. Here her credential unlocks exactly one thing — this function — so
> the blast radius of any mistake is this file, not the database.*

**A team member added here DOES hold a Supabase JWT.** They are `authenticated`,
and the policies on `venia_module_data` are the only thing between them and the
rest of the workspace. That is a different trade for a different animal — a
freelance agent gets four narrow projections; a colleague needs ordinary
read/write across a whole module, which is what RLS expresses and what
re-projecting every module through a function could not. The policies are
tested (a sales editor cannot read money, cannot write money, and cannot grant
themselves money). But it is a real change of posture, made knowingly, and it
is written here rather than discovered later.

### The founder check is BY NAME, not by domain
`agent-portal` gates on `@veniacollection.com`, which is correct there because no
agent has one. Copying it here would have been **catastrophic**: the first thing
this screen is used for is giving a colleague a veniacollection.com address, and
a domain check would hand that colleague the power to grant themselves every
module. The `team` function lists the two founders explicitly, matching
`venia_is_founder()` in the database.

Verified against the deployed function: no JWT → 401; the anon key (a valid JWT,
not a founder) → `founders only`; anon trying to grant itself money, product and
sales as owner → `founders only`.

### Two things the screen refuses to be vague about
- **A grant is not a login.** Creating the Supabase Auth account needs the
  service role, so it happens in the edge function, on demand, from a button.
  Until then the row grants access to a door that does not exist — so the list
  says, in red, *"No password yet — they cannot sign in."*
- **Granting REPLACES the set.** Anything unticked is taken away, so the
  confirm says exactly that before it happens rather than after.

`legacy` is not offered. It holds a pre-module store spanning sales, growth and
product in one string, so it stays founders-only.

### The other half: what a member actually sees
The database already refuses to send a module a person does not hold — so
hiding the nav is not the security boundary, it is the difference between
*restricted* and *broken*. Without it a Sales-only member finds Product and
Money on the nav, opens them, and sees nothing, with no way to tell a permission
from a bug.

`veniaLoadAccess()` reads the member's own grants at sign-in and hides every
route into a module they do not hold — desktop nav, phone tab bar, drawer, and
the Today doors. **It only ever hides when it is certain.** A founder, a failed
lookup, an offline boot, a share or portal view: every uncertain case shows
everything, because hiding on a maybe would lock a founder out of their own app
and the data is protected either way. The gauntlet asserts both directions.

## Build 422 — "sold ×24" was the silhouette's, not the style's
*"For styles it states that Antigone sold x24 units… the units are based on
Antigone sales but of a different fabrication."*

Correct, and worse than reported: the number was not misattributed to one
fabrication — it was shown **in full on every one of them**.

### The mechanism
`plmSalesRefresh` keys Shopify sales on `plmSalesNorm(li.title)` — the product
TITLE. `styleSalesFor(st)` looks the style up by `plmSalesNorm(st.name)`. VENIA's
own rule is that two fabrications of one silhouette are separate styles that
**keep the same name**. So all three ANTIGONE SKIRTs matched the same aggregate
and each displayed 24.

**It is not one style.** In the live workspace **21 names are shared across 2–4
fabrications — about 50 of the 72 styles**: CORA PANT (4), ANTIGONE SKIRT,
ISOLDE TOP, LEWIS PANT, NOCTURNE SKIRT, RAUL SHIRT, RHIZOPHORA (3 each), and 14
more with 2.

### There is no smarter join, and I checked before assuming one
Shopify has **four products titled "ANTIGONE SKIRT"** — BLACK and SULFUR
colourways from FW20/SS22, two active and two draft. Two of them carry
**identical SKUs**; the other two have **blank or null SKUs**. Across the
catalogue the same is true of BUCHANAN BLAZER (×3), SALIX T-SHIRT, DOC SHIRT,
HEATHCLIFF PANTS, DECKARD JACKET, HAMLET CLOAK, JAVERT PULL OVER — duplicate
titles, and often one SKU repeated across every size.

So SKU attribution could not rescue this either. And these are 2017–2020
products while the PLM styles are SS27/SS28: the join is matching a current
season's fabrications to a legacy catalogue by name alone.

**The honest fix is not a better guess. It is to stop printing a shared number
as if it were one style's.**

### What changed
`styleSalesFor()` now returns `shared: N` when N styles answer to the name, and
`styleSalesNote()` is the one sentence that explains it, so the wording cannot
drift between places. Then, everywhere it is used:

- **Styles sheet** — `×24 · $7,800 · shared ÷3`, ambered, with the sentence on hover.
- **Mobile card** — the same marker.
- **Cost/margin table** — gross profit **refuses** a shared figure. It was
  `units × margin`, so three fabrications turned one silhouette's profit into three.
- **Inventory** — marked, and never read as this version's demand. Reordering
  Jacquard because Viscose sold is exactly what that column would have caused.
- **The assistant** — every shared line is labelled in the season digest and the
  line-plan context, with a note telling it not to add them up or call one
  fabrication a winner on a shared figure.

The finance layer already did this correctly (Build ~380 — "count the units ONCE
against the average landed cost and tell the CFO the split is unknown"). Nothing
else had ever been given the same treatment. Now it has.

### What would make it exact
Nothing in this app — it is a Shopify data question. Either one product per
fabrication with a distinct title, or genuinely unique SKUs per variant that the
styles can be linked to (`shopifySkus`, built in Build 400, currently linked on
**zero** styles). Until one of those is true, "which fabrication sold" is not a
question the data can answer, and the app now says so instead of guessing.

## Build 423 — say which Shopify product it is, once, and the number is right
*"The black Isolde top does match the one in store but the other variations do
not."*

Exactly right, and it sharpens Build 422. Marking the figure "shared ÷3" was
honest about the ambiguity but still overstated two of the three: the correct
answer for ISOLDE TOP in Jacquard is not "24, shared" — it is **0**. That
fabrication has never been sold online.

### What the orders actually say
Checked, not assumed. Every ISOLDE TOP sale in the window is Shopify product
**5030216204427** — the black one, SKU `20W006-2W-BLK-*`. Shopify has a second
ISOLDE TOP (white, created Jan 2026) which has sold **nothing**. Both are
Viscose; neither is Jacquard or Parchment Viscose. Same for ANTIGONE: every sale
is product 4982620356747, the black one.

And the decisive detail: **`product_id` is on every line item.** The title is
ambiguous; the product is not. One order even carries two HAMLET CLOAKs from
two different products.

### The fix
`plmSalesRefresh` now keeps sales **per product** as well as per title, and a
style can carry `shopifyProductIds`. Then:

| state | what the style shows |
|---|---|
| linked | exactly its own products' sales — `linked`, green |
| unlinked, a sibling is linked | what is **left** after the linked ones take theirs — usually 0 |
| linked to a product that never sold | **0**, which is an answer, not a blank |
| nothing linked anywhere | the title total, `shared ÷N`, as in 422 |

So linking the one version that IS sold online is a single action per silhouette,
and it drops its siblings to zero without touching them. Reversible: unlink and
it goes back to the shared figure.

The picker opens **from the Sold cell** — where the wrong number is — and lists
every product that has sold under that name with its units and last sale date,
so the choice is made on evidence. Ticking none and saving means "this
fabrication is not sold online" and shows 0.

A line item with no `product_id` (a custom sale, a deleted product) stays in the
title total and cannot be linked, which is the truth about it.

---

# CLO INTEGRATION — SESSION 1 RECONNAISSANCE (no feature code written)

_Against `VENIA_OS_CLO_Integration_Master_Handoff.docx`. Done at Build 430;
the handoff's baseline is Build 426 / `cf55e2d`, four builds behind._

The handoff's own Part XII says Session 1 is reconnaissance only, so nothing
below has been implemented. This is what the next six sessions have to build
on, and what is already wrong in the document because the repo moved.

## What the document gets right about this repo

Verified present and reusable exactly as it assumes:

| It assumes | Reality |
|---|---|
| `venia_members` (email, module, role) + `venia_module_data` | Yes, both live |
| RLS helpers `venia_is_founder()`, `venia_module_role(text)` | Yes; plus `venia_has_access()` and `venia_module_owner()` added at 424 |
| Product module owns pattern data | Yes — `MODULES.product` |
| Privileged Edge Functions as the pattern for machine access | Yes — `team` and `pull-sign` are exactly this shape |
| `measParse` / `measFmt` fractional-inch semantics | Yes, at 6584. `MEAS_DEN = 16`; a value off the grid renders as a decimal rather than being rounded |
| POM target + tolerance structure | Yes — `STATE.pom[styleId] = [{id, point, tol, comment, rounds, specs}]` |
| Development-spec revision history | Yes — `pomSpecs()` / `POM_SPEC_LABELS` = Initial/Revised/Final/Rev N, and every round records WHICH revision it was judged against (`pomRoundRev`) |
| Grading + stale detection | Yes — `pomGradeReadiness()` |
| Gauntlet methodology | Yes — 86 node smoke suites + ~15 Playwright gauntlets |

`pull-sign` (Build 427) is the closest working precedent for the whole CLO
machine story: a token IS the credential, the row carries its own frozen
snapshot so the caller can reach nothing else, and the server stamps the facts
the client must not be trusted to supply. Session 3 should copy its shape.

## Conflicts and corrections the document does not know about

1. **MODULES already has a ninth entry.** Build 424 added `catalog` — a
   cost-stripped projection of `styles` that owns no STATE key and is readable
   by ANYONE with any module grant. §7 ("do not create a ninth module") is
   satisfied in spirit; the live risk is different and sharper: **`catalog` is
   the one surface where pattern data could reach Sales.** It is an allowlist
   (`CATALOG_STYLE_FIELDS`), so it cannot today — but no pattern field may ever
   be added to that list, and Session 2 should assert it in a gauntlet.

2. **Storage is PUBLIC.** `veniaUploadImage` uploads to bucket `venia-photos`
   and hands back `getPublicUrl()`. The document requires private storage with
   signed uploads for ZPRJ/DXF, and it is right: a production DXF at a guessable
   public URL is a factory package anyone can take. **A new private bucket is
   required — the existing one must not be reused.** There are no storage
   policies in `supabase/migrations/` at all; they were set in the dashboard.

3. **A CLO3D screen already exists** (`renderClo3d`, ~11962) with `s.cloFile`
   and `s.cloStatus` — a hand-typed filename and a four-state label. The
   document's §4.6 ("content identity beats filenames") and §88 condemn exactly
   this. `cloFile` must NOT become the link key; the integration replaces this
   screen rather than extending it. `venia_styles` also has vestigial
   `clo_file` / `clo_status` columns from the same era.

4. **Two write paths to Supabase, not one.** The live sync is
   `venia_module_data` (per-module rows, RLS by membership). There is ALSO a
   manual normalized push (`venia_styles`, `venia_materials`, `venia_bom`,
   `venia_pom`) fired from Settings. Pattern revisions must hang off style
   identity, not off either mirror — and Session 2 must decide which table the
   FK points at. Recommendation: no FK to either; store `style_id` as text and
   treat the workspace as the resolver, because `venia_styles` is not
   guaranteed current.

5. **Style identity is `s.id`, not `styleId`.** `styleId` is the human code
   (VN-SS27-WT08) and is editable and sometimes blank — Build 430 deliberately
   leaves it empty on styles built from Shopify. The document's examples use
   "27B014" as though it were the key. **The machine API must key on `s.id` and
   treat `styleId` as a display label**, or a renamed style breaks its own
   pattern history.

6. **`landedCost()` reads a localStorage cost sheet**, not a synced table
   (`venia-cost-sheets`, carried in the workspace `_ls`). §3 says costing is
   VENIA-authoritative and CLO consumption "may inform" — fine, but any
   consumption→cost path has to go through that store, not around it.

## Required migrations (Session 2)

Per Appendix A, reconciled to this repo:

- `venia_clo_integrations` — machine tokens. Store the hash only. Founder-gated
  by `venia_is_founder()`, same as `venia_agent_policy`.
- `venia_pattern_revisions`, `venia_pattern_assets`, `venia_pattern_validations`,
  `venia_style_pattern_state` — read via `venia_module_role('product')`, write
  via the Edge Function only.
- A private storage bucket + policies, **committed as a migration** rather than
  set in the dashboard, since none of the current ones are.

## Files that will change

- `venia-control-panel-v1.html` — Pattern workspace in Style Detail (Session 5),
  replacing `renderClo3d`. Registry: pattern state is Product-owned, so any new
  STATE key goes in `MODULES.product.keys` and `modules.js`'s key count moves
  deliberately (it is 65 now).
- `supabase/functions/clo/index.ts` — new, modelled on `pull-sign`.
- `supabase/migrations/` — the tables above.
- `clo-plugin/` — new tree, per §35.

## Minimal Phase 1

Sessions 2 → 3 → 4 in that order, as the document says. Do not start the
plug-in until the machine API passes on its own — Session 3's fixtures are what
make Session 4 debuggable at all, since a CLO plug-in cannot be run here.

## Risks

- **The CLO API surface in §41 is unverified from here.** `ExportZPrj`,
  `ExportDXF(ExportDxfOption)`, `ExportTechPack`, `ExportPatternJSON` and the
  v11 seam-ID enrichment are stated as fact in the document; none of it has
  been checked against the installed SDK, and §40 already concedes some DXF
  options may not be controllable. Session 4 must verify each call against the
  real SDK and record anything unavailable as unavailable (§4.5) rather than
  building around an assumption.
- **Nothing here can be tested end to end in this environment.** No CLO, no
  Windows/macOS host. Sessions 2 and 3 are fixture-testable; Session 4 is not,
  and should be written so its hashing, manifest, mapping and retry logic are
  unit-testable OUTSIDE CLO (§35 says this too).
- **Token handling.** A machine token displayed once and stored hashed is the
  same pattern as `pull-sign`, but the raw token must never enter the workspace
  blob — `SYNC_KEYS` is derived from the registry, so a careless new key would
  sync it to both phones and into every module row.

## Rollback

Every table is additive and no existing path reads them, so Session 2 rolls
back by dropping four tables. Session 3 rolls back by deleting one function.
Session 5 is the first change to shipped UI and is the first that needs the
usual before/after gauntlet against the current build.

---

## SOCIAL COMMAND — PHASE 1 (Build 432)

The shell and the visual feed. **No new persistence**: `mkPosts` already carried
`sequenceOrder` from Phase 0, so the feed, the unscheduled drawer and the
calendar are three readings of one list. Everything added is a pure selector
over `mkPosts` or a call into a Phase 0 mutation.

### What landed

- `MODULES.growth` gains **no** new keys. Phase 1 adds none.
- `mkSocialFeed()` — the projection: `{ planned, published, drafts, conflicts,
  blockers, from, to }`. `socWhen()` / `socPlatform()` / `socThumb()` /
  `socCmp()` are the shared schedule and order calculation the grid AND the
  calendar both read.
- `agBuildSocialSection()` → `AG_SECTIONS.mk.social`, first Marketing route,
  page title **SOCIAL**, toolbar **IMPORT** + **+ NEW POST**. Local view row
  FEED / CALENDAR / CREATE / ASSETS. `cpGoto('mk')` lands here on first entry.
- The rail item feeds the mobile drawer automatically (`mobDrawerBuild` mirrors
  the rail), so GROWTH → MKTG → SOCIAL COMMAND needed no second list.
- Three-column grid, 3:4 default with 1:1 / 4:5, planned → full-width
  **Published** boundary → live posts newest first. Feed column capped at 520px
  so it stays a feed preview on desktop.
- Interaction: tap to select, long-press (touch) or drag (pointer) to swap,
  explicit ← Earlier / Later → , `[` and `]` on the keyboard, arrow keys to walk
  the grid. One selection = a swap with its neighbour; multi-selection = a block
  move. Every reorder is one undo through `mkSequenceReorder`.
- Unschedule pulls a post to the drawer and keeps the record; the drawer places
  it back. Replace assigns an asset. Carousel merges 2+. Approve is human-only.
- IMPORT = the two foundation asset sources that already exist in this
  workspace: style photography (rights `owned`, provenance recorded) and a
  manual URL. It does **not** read a live social feed and says so.
- `socMigrateOnce()` runs `mkSocialMigrateV1()` on the first render of the
  screen that reads its output — not at boot — and only when `moduleWritable
  ('growth')`. A Growth viewer migrates nothing.
- Conflicts: two planned posts on one day are marked and named, never blocked.

### Deliberate deviations from the brief, and why

- **Drop = swap, not insert.** Earlier/Later on one post is a swap with its
  neighbour, so the drag and the buttons agree; insertion would re-flow the
  whole grid and defeat judging a feed visually. A multi-post selection cannot
  swap with one neighbour, so it moves as a block.
- **Week grid is desktop-only.** §5 forbids seven columns on a phone; stacking
  them under an agenda that already said everything is worse than omitting it.
- **CREATE is a placer, not the Phase 3 composer.** Title, format, platform,
  date, caption, and the two ENIGMA prompts. It says plainly that ENIGMA cannot
  yet write a sequence in — that is Phase 5.
- **ASSETS is a shelf, not the Phase 2 library.** Import, list, use count,
  archive. No rights editor, filters, dedupe or visual search.

### Still open after Phase 1

- The floating sparkle opens the existing Growth assistant. Social Command
  context and actions are Phase 5; the section's suggest chips are the interim.
- No provider anywhere: nothing schedules, publishes or reconciles.
- Ratio, selection and view are per-glance except ratio, which syncs in
  `mkSocialPrefs`.

---

## TWO DIALOGS THAT WERE NEVER DIALOGS (fixed in Build 432)

Reported live: *"the style builder is stuck and cannot close out."*

`invBuildStyleOpen` (430) and `slOpenOrderModal` (429) were each built
element-by-element in JS with class names that **do not exist in this
stylesheet**: `modal-overlay`, `modal-box`, `modal-hdr`, `modal-footer`,
`btn-primary`, `form-row`, `form-input`. `closeModal()` only removes `.open`,
and `.open` styles nothing without `.overlay` — so the style builder rendered as
plain flow content that could not be dismissed, and the order editor, which also
carried an inline `display:none`, never appeared at all.

Both now use the app's real classes. The tests that passed on both were asking
whether the elements existed and prefilled correctly — which they did, inside
something nobody could see or close.

- `smoke88.js` — every `modal-*`, `btn-*`, `overlay` class the app applies must
  have a CSS rule behind it, and any overlay built in JS must wear `.overlay`.
- `invbuild.js` / `orders.js` now assert computed `position`, opacity and
  dismissal, not DOM presence.

Also fixed, found by the same sweep: `prOpenDetail` threw on any pull with no
fee (`(pull.feeAmount||0).toFixed ? pull.feeAmount.toFixed(2) : …` tests a
number that always has `toFixed`, then calls it on the undefined original).
Build 427 let a comped pull reach that badge for the first time; `alias.js` and
`perperson.js` had been red ever since. A pull with no fee now says so instead
of claiming an unpaid amount.

**A style built from a store product is created ⚑ Needs review** — it has no
cost, wholesale price, fabric or season, and unmarked it is indistinguishable
from one someone specified. The sheet says so before you agree to it.

### A boot signal that did not exist

`window.STATE` is assigned where it is declared, long before `init()` reads the
saved workspace out of localStorage — so "STATE exists" has never meant "the
workspace is loaded". `socMigrateOnce()` could therefore run against a
half-built STATE and stamp `schemaVersion`, marking a one-way migration done for
records it had not read. Because the stamp is the guard, the founder's real
calendar would then never convert.

Build 432 adds `window.__veniaBooted`, set once `init()` has finished reading,
and the migration waits for it. A founder whose last route was Marketing has
this screen restored *during* boot, so refusing to migrate there would have left
them looking at an empty feed with nothing to redraw it — `socWaitForBoot()`
polls (bounded, 6s) and re-renders once the workspace is actually there.

Found by the Phase 1 suite failing intermittently in three different places on
three different runs, which is what this bug looks like from outside.

### Known red, not ours

- `regress.js` — `[Supabase] init failed … createClient`: the supabase-js CDN is
  blocked in the sandbox. Identical on Build 431.
- `filtsweep.js` — skips its `prev389.html` half, a stale scratch snapshot with
  no `cpGoto` in scope. Its current-build half is clean.

---

## INSTAGRAM — THE LIVE FEED (Build 433)

Read only. The grid now shows what the account has actually published, below the
boundary, instead of what the old calendar claimed was posted.

### The shape of it

- `supabase/functions/instagram` — founders-only: `status`, `authurl`, `feed`,
  `disconnect`. Requests **`instagram_business_basic` and nothing else**, so a
  token minted here cannot publish, comment, or read a message. That is a
  property of the credential, not of the code that uses it.
- `supabase/functions/instagram-callback` — the one public door, because
  Instagram redirects a browser there with no headers of ours on it. It redeems
  a code only when it carries a state this app minted in the last ten minutes
  and has not used; the state is deleted on the way in, so a link cannot be
  replayed even when the exchange after it fails. Also serves Meta's deauthorize
  and data-deletion callbacks at `?event=`, both signature-verified.
- `venia_instagram` — **RLS on, no policies at all.** That is the security
  model: PostgREST returns nothing to anon and nothing to authenticated, a
  founder's own session included. Only the service role inside the function can
  read a row, and no action returns the token, including `status`.

### Two rules the screen keeps

**Nothing from Instagram is written down.** `media_url` is a CDN link that
expires; a workspace full of pictures that stop loading, synced to every device,
is the failure this avoids. The pull lives in `SOC_LIVE` for one visit and is
asked for again next time. Asserted, not assumed.

**The boundary says which claim it is making.** Connected, it reads *"6 from
Instagram"*; not connected, *"2 from your calendar · unverified"*. Those are
different claims and the screen never lets them read as one. The migrated rows
are not deleted when the account speaks — they simply are not what the grid
shows.

### Days Instagram does not cooperate

- A refused request shows the reason Meta gave, not "could not connect".
- A failed refresh keeps the token that is still valid — a bad minute is not a
  reconnection.
- An expired token says reconnect without troubling Instagram.
- A token within 10 days of expiry says so on the screen before it stops working.
- None of these hide the planned sequence: the grid above the line still works.

### Setup, and what is still the founders'

Supabase secrets `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`,
`INSTAGRAM_REDIRECT_URI`. Meta app: use case **Manage messaging and content on
Instagram**, no business portfolio connected, the Instagram account holding the
**Instagram Tester** role (accepted at instagram.com/accounts/manage_access/ —
the tab does not exist in the phone app). App stays unpublished; App Review is
the gate for Advanced Access, which serving your own account does not need.

Meta bundles `instagram_business_manage_comments` and `_manage_messages` into
that use case as required. They are permissions the APP may offer, not scopes
the token carries — the authorize URL asks for basic alone.

### Not done

- Reconciliation: a live post is drawn as a tile and never matched back to a
  planned `mkPost`. Matching needs provider evidence and belongs with publishing.
- Nothing schedules or publishes anywhere.
- 24 posts per pull, one pull per visit. No pagination.

---

## CAMPAIGNS, THE ROADMAP, AGENCY AND DRIVE (Build 438)

Three asks after the feed went live: plan from here, make it AI-assisted, and
connect a folder for assets.

### Campaigns

The record existed from Phase 0; this is the screen for it. **Create** hosts
them rather than a drawer route — the brief keeps campaigns out of the tab row
and is right that nine tabs on a phone is nobody's idea, but burying them while
the founder is asking to plan from this screen would be the letter over the
point.

- A brief **names what is still missing from it**: objective, narrative,
  audience, dates, styles. "Draft" on its own is not a status, it is a shrug.
- A campaign points at **real styles**, which is the thing no other planner can
  do — the sequence knows what it is selling, and the P&L knows what it cost.
- Deliverables are not a second list. A post belongs to a campaign by carrying
  its id, so progress cannot drift from the posts.
- The feed filters by campaign, applied **where the projection is built**, so
  the grid, the plan strip and the calendar narrow together.

### Roadmap

Campaigns over the weeks they occupy. The bar fills by what is **approved or
published**, not by time passing — a campaign is not 60% done because 60% of its
days have gone.

### Enigma writes the sequence in

`propose_social_plan`, Growth's first record-writing action. Until now Marketing
could only draft, which is why a proposal was always something to retype.

- It is given the real campaign and asset **ids** in context. Without them the
  model invents ids and the action rejects the whole plan — safe, and useless.
- An invented asset or campaign id loses the **whole** plan and names the id.
  Silently dropping the field would produce a sequence nobody asked for.
- Posts land `proposed` or `needs_asset`. Nothing arrives approved, scheduled or
  published, and the mutation refuses it even if asked.
- A post with no asset is created **blocked**, not quietly fine.
- The whole sequence is one undo.
- The card says nothing is approved and how many need a photo, because a card
  that reads like a finished job is the failure this app has a rule against.

### A Drive folder as the asset shelf

The shoot already lives in Drive; asking for a second library means one of them
rots.

- **Scope stays `drive.file`** — access to what the founder explicitly picks and
  nothing else. Picking the folder through Google's own Picker is what grants
  access to its contents. Widening to `drive.readonly` to avoid needing the
  Picker key would trade real privacy for two minutes of setup.
- Stored: folder id, file ids, names. **Not thumbnails** — Drive's
  `thumbnailLink` is authorised and expires, so storing one syncs rot to every
  device. They live in memory for the visit, like the Instagram feed. Asserted.
- Asset ids derive from the Drive file id, so syncing twice updates rather than
  doubling.
- Rights are `owned`: it is the brand's own Drive, which is the strongest
  provenance the app can state without asking a question it cannot verify.

### Still the founders' to do

- **The Picker API key.** Drive attach has never worked because the field wants
  an `AIza…` key that does not exist yet. Cloud Console → Credentials → Create
  credentials → API key, then paste it in Settings.
- **Rotate the Google OAuth client secret** (see the older note above). A
  `GOCSPX-` secret was once pasted into that field and synced; it was purged
  from both stores but has to be rotated at source.

### Not done

- No approvals queue, no composer, no Reel or Story planner, no provider
  publishing. Enigma proposes; a person approves; nothing publishes anywhere.

---

## ONE STOCK NUMBER (Build 439)

Asked: *"If I update stock in Shopify does it sync across the board?"* It did
not, and the way it failed was expensive.

**There were two numbers.** `invStock()` preferred Shopify's figure — and almost
nothing called it. The Inventory screen used it; the line sheet a buyer
receives, the production gap and the forecast shortfall all read `s.stock`
directly, the typed number Shopify never touches. A style could read 42 on
Inventory and 8 on the line sheet, and the line sheet is the one that leaves the
building. The production planner was the costly one: with 42 in the store and a
stale 8 typed in, it computed a gap of **92 units instead of 58** — fifty units
of production nobody needed.

`invStock()` is now the only way to ask, and every consumer routes through it.

### Two things one number cannot say

- **How old it is.** Shopify is polled, not pushed, so the age is part of the
  fact. Stock now carries it, and the line sheet prints it beside the figure.
- **What has happened since.** A delivered wholesale order takes real units off
  the shelf and Shopify never hears — this app cannot tell it, because the
  Shopify proxy is read-only by design. `invStockEffective()` shows the store's
  figure less anything wholesale shipped **after** the last sync, and keeps the
  raw figure readable. An order delivered before the sync is not double-counted.

### It refreshes itself

Opening Inventory re-syncs when the last answer is more than ten minutes old.
Not on every render — that would be a request per keystroke — and never when no
store is connected.

### Still not done, and it is a decision rather than a gap

**Nothing writes back to Shopify.** Ship a wholesale order and the storefront
still believes it has those units, so it can oversell. Fixing that means giving
this app permission to change the store's inventory, which is a different kind
of power from reading it and should be an explicit choice, not a side effect of
a sync. Until then the divergence is shown rather than hidden.

---

## Build 440 — the P&L you can leave, and where manufacturing money is counted

### The statement was a trap

`finPrintPL()` opened a window, wrote a document, and called `print()` 400ms
later. It had **no Close button** — the stylesheet even carried
`@media print{button{display:none}}`, anticipating buttons that were never
added. On a phone the print dialog is a full-screen share sheet thrown over a
document nobody has read yet, and behind it is a page with no way out.

Now: a fixed bar with **Print / Save PDF** and **Close**, hidden in the print
itself. Auto-print only on a desktop, where a print dialog is a dialog. Close
tries `window.close()` and falls back to `history.back()`.

### Where manufacturing money is counted

A payment to a factory or a mill must reach the P&L **exactly once**: through
cost of goods sold as the units it produced are sold, or through operating
expenses as cash that left the bank. Never both.

`fabric` and `production` were already excluded from opex on the assumption of
the first route. Nothing said so on the document, and nothing said what happens
to the categories that are *not* excluded. `landedCost()` is
material + labor + overhead + duties + freight — so `contractors` (labor),
`materials` (material) and `shipping` (freight) are all live double-count risks
the moment a cost sheet exists for the styles they made.

The statement now names both piles, with the second one broken out by category
and amount, and states the rule: recategorise them, or leave them and do not
cost those styles — **either is defensible, both is not.**

Counted in the same pass as opex, deliberately: they are one partition of one
set of transactions, and a second loop is a second set of filters to drift.

### The margin was the loudest lie on the page

With uncosted styles selling, gross margin is not a trading margin — it is close
to the share of revenue with no cost recorded against it. A 96% margin on a
document going to an accountant reads as a claim. It now carries a note saying
what it is measuring, and that it will fall as styles are costed — and that the
fall is the statement getting more accurate, not the business getting worse.

### An estimate that leaves the building says so

Cost sheets have always let a section be marked **not quoted**, and the tech
pack shows an amber banner when one is. The P&L said nothing — so a founder
doing the right thing (entering the best figure they have rather than leaving a
style uncosted) would hand an accountant estimated COGS presented as fact.

The statement now names the styles whose cost is part estimate and says that
COGS, gross profit and gross margin inherit it. That is what makes estimating
the safe move instead of the risky one.

`gauntlet/plcogs.js` — 21 assertions, all of which failed against Build 439.

---

## Build 441 — the year the money left is not the year the cost belongs to

### The question

2026's manufacturing spend has almost nothing to do with what sold in 2026.
Goods sold this year may have been paid for last year, or the year before. So
how do the two ever reconcile?

**They don't, and they are not supposed to.** A cost belongs to the sale it made
possible, not to the date the factory was paid.

### The app was already right about this, and silent about it

Verified rather than assumed: COGS is `landedCost(style) × units sold in the
period`, and `landedCost` is **dateless** — it reads the style's cost sheet, not
a transaction. Seed $50,000 of manufacturing cash leaving the bank and sell 20
units at $50, and the statement charges **$1,000**. Those two assertions in
`gauntlet/pltiming.js` pass against Build 440 unchanged.

What was missing was saying so. The statement excluded the money correctly and
then showed nothing about where it went — the founder watched $50k leave with no
expense appearing and had to take it on faith.

### Where the difference goes: the shelf

`finInventoryAtCost()` — units on hand × landed cost — as a memo line beside
"Paid to factories", plus a note carrying **both** figures in one sentence with
the reason they differ: the gap is stock moving on or off the shelf, an asset,
not a profit or a loss.

Units of a style with **no cost sheet cannot be valued** and are counted
separately rather than valued at zero, which would quietly understate the shelf.

### A cost sheet is a current fact, not a historical one

The consequence of costing by sale rather than by wire: COGS reads *today's*
cost sheet, so revising one changes cost of goods sold in periods already
reported. Usually what you want — every period on the best cost known today —
but not what a reader assumes about a statement. Now said on the document: a
view **as at** a date, not a frozen record.

### The contractor split needs no new category

`production` is already built in and already excluded from opex. Manufacturing
labour goes there; everyone else stays in `contractors`. `set_txn_category`
accepts a description match, so the split is a bulk refile through Enigma rather
than a transaction-by-transaction job.

`gauntlet/pltiming.js` — 15 assertions, 13 of which fail against Build 440. The
two that pass are the ones proving the matching was already correct.

---

## Build 442 — a statement headed "1 January" that the ledger could not reach

Reported: *"It looks like I'm not getting transactions from January 1st even
though I said year to date."* Three causes, and the dangerous one is not the
missing data.

### 1. Stripe only hands back about 180 days

From the docs, fetched not recalled: *"Stripe returns a paginated list of up to
the last 180 days of transaction history on an account, depending on the
account's financial institution."* On 2 September that window starts 6 March.
January is outside it and cannot be re-fetched.

### 2. The app was deleting the history it had

```js
if (STATE.finTxns.length > 600) STATE.finTxns = STATE.finTxns.slice(0, 600);
```

The list is sorted newest-first, so keeping the newest 600 **deletes the
oldest** — exactly what a year-to-date statement is made of. January captured in
March was thrown away in September, and Stripe will not sell it back.

Retention is now `bankTrimTxns()`, its own function so it can be tested without
a network call, and **the cut is never allowed to cross 1 January**: rows inside
the reporting year survive past the cap. Cap 600 → 3,000.

### 3. It could only walk back 500 rows per account

`for (let page = 0; page < 5; page++)` at 100 a page, always from the newest,
never resuming where it stopped. Now 25 pages, still exiting the moment Stripe
says there is no more.

### And Refresh only ever refreshed the balance

`features[]=balance`. The balance moved; the ledger never did. Now both, with a
balance-only fallback so a rate-limited transaction refresh does not lose both —
and `form()` expands array values into repeated keys, which an object literal
could not express.

### The part that mattered most

A missing month is not harmless: revenue for the year is counted in full and the
costs are not, so it **OVERSTATES PROFIT**. The heading now reads
*"…· expenses from March 6, 2026 only"* and a note names the gap in days and
says which way the statement is wrong.

**A tolerance, and why there has to be one.** The first version fired unless a
transaction was dated on or before 1 January — a business whose first spend was
2 January would get a false alarm every year. Fourteen days separates "nothing
was spent on New Year's Day" from "the feed starts in March". The strict fact
(`reachesJan1`) is kept apart from the judgement (`materialGap`), and the
tolerance is pinned from both sides.

### Still missing

**No manual entry and no CSV import.** January–early March cannot come from the
feed, so today there is no way to enter it at all. That is the next thing.

`gauntlet/plcoverage.js` — 14 assertions, 12 of which fail against Build 441.

---

## Build 443 — the months the feed cannot reach

Asked: *"Is there any way to go back farther than Stripe's limit? Otherwise I
can download all the bank statements and give it to Enigma."*

**No, and yes.** Stripe's ~180 days is a hard ceiling — no parameter extends it,
and `transacted_at` only narrows what is already in the window. Plaid offers up
to 730 days (`transactions.days_requested`, max 730), but that is a different
aggregator: new account, new integration, new cost.

### The statements are the answer — but not through the assistant

The obvious move is to paste the statement into chat and let Enigma file it. It
must not go that way. **A model asked to retype eight hundred amounts will get
some of them wrong, and a wrong amount in a ledger is indistinguishable from a
right one afterwards.** The P&L action already carries the rule — never type the
figures — and it applies with more force here, because these figures *become*
the ledger.

So the file is parsed deterministically and the assistant's job stays what it is
good at: deciding what each row **is**, once the numbers are safe.

### Money → Cash → ↑ Import statement

Handles the shape a real export has, not a tidy one: a preamble line above the
header, `MM/DD/YYYY`, quoted descriptions containing commas, `"-$9,000.00"`
with symbol and separators, separate Debit/Credit columns, and accounting
parentheses `(1,234.56)` meaning negative.

**It refuses rather than guesses.** An all-positive file with no debit column is
rejected with the reason — filing every expense as income is worse than
importing nothing. A file with no header row says to export CSV, not PDF.

**It never double-counts.** Rows are keyed on date + amount + a hard-folded
description, so a statement overlapping the feed is matched and skipped even
though Stripe and the bank capitalise differently. Importing the same file twice
adds nothing.

Imported rows carry `src: 'import'` and an `imp_` id, never a Stripe-shaped one,
so the ledger can always say which figures came from a feed and which from a
document somebody downloaded.

### The bug the gauntlet caught

The first version filed **every Chase transaction with the description "DEBIT"**.
Chase's first column is headed `Details` and holds DEBIT/CREDIT — it matched a
loose description pattern and sat to the LEFT of the real `Description`, so
first-match-wins took the wrong one. Column detection is now priority-ordered by
header NAME rather than position, and a column cannot be two fields at once.

Caught because the gauntlet seeds a real export rather than a clean one.

`gauntlet/bankimport.js` — 16 assertions, all of which fail against Build 442.

---

## Build 444 — a hole in the middle is as bad as a short start

Asked whether Plaid is worth it for the history, keeping Stripe for processing.

**The framing is right and the answer is no.** Financial Connections and payment
processing are separate Stripe products sharing one API key — `stripe.js` does
Checkout, holds and invoices, `bank.js` does the feed — so swapping the feed
would not touch processing. But the problem that prompted the question is gone,
and it is worth being precise about whose fault each part was:

| Cause | Whose |
|---|---|
| 180-day window | Stripe's limit — real, permanent |
| Deleted captured history | **ours** — fixed in 442 |
| Could not walk past 500 rows | **ours** — fixed in 442 |
| No backfill path | missing — built in 443 |

Two of three were ours. With retention keeping everything and the sync walking
2,500 rows, the feed now accumulates permanently: sync twice a year and no month
is ever lost again. The window only ever bit for backfill, which the importer
handles.

Plaid would buy 730 days automatically, wider institution coverage and merchant
enrichment. Against that: an integration the size of the Instagram connector, a
second vendor holding bank credentials, and pricing that needs a sales call
(Pay-as-you-go is month-to-month, and there is a 200-call free tier). Revisit if
Stripe FC drops an institution, or if enrichment would pay for itself in filing
time.

### The hole in that reasoning, found while making it

"Stripe plus the importer is enough" could not be said honestly without checking
whether the app can tell when it **is not**. It could not.

`finLedgerCoverage()` looked only at the EARLIEST date. A ledger holding January
and August with nothing between reported that it reaches 1 January and looked
complete — which is exactly what a 180-day window produces when nobody syncs for
half a year: the old months are kept, the new ones arrive, and the span the
window slid past is simply absent.

Every completed month inside the covered span is now checked. Empty ones are
named in plain English on the statement, with the same restraint as the rest: a
hole is called **more likely** than a dormant month, not certain, because a
genuinely unused account is possible and this cannot tell the difference. The
current month is never called empty — it is unfinished, not missing.

`gauntlet/plcoverage.js` — now 20 assertions, the 5 new ones failing against 443.

---

## Build 445 — the feed is a delivery van, not the archive

Asked: if Money is the financial backbone, is a 180-day feed a problem for
planning, P&L accuracy and company health?

**The 180 days limits what Stripe will HAND OVER. It does not limit what the
ledger holds.** `finTxns` syncs to `venia_module_data` — a Postgres `jsonb`
column, not just browser storage — so once a transaction is in, it stays.
Stripe could disconnect tomorrow and 2024 would still be there.

So the question is not how to see past 180 days. It is **how to get the years in,
once**: import 2024, 2025 and this year from statements, after which the feed
keeps up and it never has to happen again. That is not a workaround — it is how
you stop renting your financial history from a vendor's retention policy.

### What had to change to make that safe

**The cap was about to bite.** 3,000 rows is roughly four years at this volume;
importing two more years would have reached it and started deleting the oldest.
Raised to **10,000**. The gauntlet proves five years (3,500 rows) now import
whole where the old cap silently ate the oldest of them.

**Dropping rows is never silent again.** If the cap is ever reached the count and
date range are recorded, shown on the Money screen and named on the P&L —
precisely: this period is intact, earlier ones are not, and a comparison against
them would be wrong. **The original bug was never the cap. It was that hitting it
destroyed history without saying so.**

**↓ Export ledger.** Every transaction with date, description, amount, the
category somebody filed, and whether it came from the feed or an import. That
last column is the part no bank statement can give back. If statements are the
source of truth for the early years, re-typing them is the cost of losing this,
so the archive has to be able to leave.

### The honest limit

The cap exists because the whole workspace also lives in localStorage — about
5MB for everything. Ten thousand transactions is comfortable. If VENIA ever needs
fifty thousand, transactions belong in their own Supabase table rather than
riding inside the module blob. That is the real architecture for a financial
backbone, and it is years away.

`gauntlet/ledger.js` — 16 assertions, 13 of which fail against Build 444.

---

## Build 446 — three identical coffees are three transactions

Said before importing: *"I was planning to import transaction history CSV from
account opening that I exported from Chase."* Checking that path first found a
bug that would have silently cost money on exactly that import.

### Identical rows were collapsing into one

`bankImportReconcile` treated the dedupe key as **set membership**. A statement
genuinely repeats itself — two identical Zelle payments in a day, three coffees
at the same price — and all three became one transaction. On a full account
history that is potentially hundreds of real payments gone, with no signal
except a total that never foots against the bank.

Now it **counts**: occurrences per key in the ledger, occurrences per key in the
file, import the difference. Three identical coffees import as three, each with
its own stable id — and re-importing the same file still adds nothing. Set
membership could only ever deliver one of those two.

### The other Chase export

The card CSV is a different shape entirely — `Transaction Date, Post Date,
Description, Category, Type, Amount, Memo`. It already parsed correctly (taking
Transaction Date over Post Date, and not mistaking Chase's own `Category` for the
description), and is now pinned in the gauntlet so it cannot regress.

### The cap warns before, not after

An import that would push the ledger past 10,000 now says by how much **before
writing**, with the point made plainly: on a history import the rows that get
dropped are the years being imported for. Finding out afterwards would be the
same mistake the retention cap made for months.

`gauntlet/bankimport.js` — now 23 assertions, the 3 new behaviours failing
against Build 445.

---

## Build 447 — a draw is not an expense, and capital is not revenue

Asked to find what would cause a problem raising a loan or investment. Top of
the list was not a missing feature but a **misstatement**.

### There was no category for money the founders take out

A transfer to a founder had nowhere to go but `other`, where it was counted as an
**operating expense**. On the gauntlet's ledger the old build reported **$12,150
of operating expenses against a real $4,600** — the extra $7,550 being an owner
draw, loan principal and interest, none of which the business spent on running
itself.

The direction is what matters: it makes the business look like it burns more
than it does and earns less than it does, on the exact document somebody is
being asked to lend against.

The mirror image was live too: money the founders put IN had nowhere but
`income` — kept out of revenue, which is right, but invisible everywhere, which
is not. The opex loop discarded every inflow.

### Four categories, and where each belongs

- **owner draw, owner investment, loan principal** — financing. They change who
  owns what, not what the trading made. Excluded from operating expenses and
  listed under their own heading, outside every total above.
- **interest** — a real expense, but a financing one. Now between operating
  profit and a new **net profit after interest**, where a lender looks for it.

### Still open for an investor pack

- **No balance sheet.** Every input now exists — cash, AR, inventory at cost,
  factory commitments, loan principal and owner equity movements — but they are
  not assembled. A lender asks for P&L *and* balance sheet; today they get half.
- **No cash flow statement.** Same: the pieces exist, unassembled.
- **`taxes` is still an operating expense.** Sales and payroll tax belong there;
  income tax does not. Not moved, because the app cannot tell which a wire is
  and guessing would be worse than the current state.

`gauntlet/plfinancing.js` — 14 assertions, all failing against Build 446.

---

## Build 448 — the feed could not tell an imported row was the same payment

Checked the real ledger after a full Chase history import. **It worked**: 1,445
transactions, nothing trimmed, imported rows reaching **2024-08-31** — two years
the feed was never going to supply. The feed's own earliest is 2026-03-02, 184
days back, confirming the ~180-day window against live data rather than docs.

### But it exposed a bug: 9 transactions counted twice, $5,725

The import deduped against the ledger. **The sync never did** — it matched on the
Stripe id alone, and an imported row has no Stripe id, so every sync after a
history import re-added the overlap period as new transactions.

Two flavours, both live:
- exact matches the sync simply could not see (5 rows)
- **same payment, different text**: Chase writes `ORIG CO NAME:GUSTO CO ENTRY
  DESCR:…`, Stripe writes `ORIG CO NAME:GUSTO ORIG ID:…` (4 rows)

**Matched on date + amount, not description.** Both sources get date and amount
right; neither agrees on ACH descriptor text. Counting keeps it safe where a set
would not — two genuine $300 payments on one day match two-for-two and both
survive, while the Gusto pair becomes one.

The arriving feed row **upgrades** the imported row in place: it takes the real
id and live status, and **keeps any category filed by hand**. Ledgers already
damaged get a reviewed `bankMergeDupes()` behind a banner naming the count and
the value — never automatic, because it deletes financial records.

### And the balance sheet — the other half of the pack

Cash, receivables, inventory at landed cost and factory prepayments; cards and
factory commitments as liabilities; net position, working capital, and owner and
financing movements. Same chrome as the P&L so they read as one pack.

**It cannot balance by construction and says so.** There is no double-entry
ledger underneath, so equity is stated as assets less liabilities rather than
carried forward and reconciled — the first note says exactly that. A statement
quietly implying a reconciliation nobody performed would be worse than one
explaining why it cannot.

It also names what it is missing: uncosted stock excluded rather than valued at
zero, no bad-debt allowance, no write-downs for old or out-of-season stock, and
no supplier debt, accrued tax or lease obligation in the liabilities.

### Still needing the founders

**860 of 1,200 imported rows are uncategorised.** The P&L cannot be trusted until
that is done. Zelle payments *from* the founders are `owner_invest`, not income;
Zelle payments to sewing contractors need the production/contractors split.

`gauntlet/bankdupe.js` — 11 assertions, 8 failing against 447.
`gauntlet/balancesheet.js` — 20 assertions, 19 failing against 447.

---

## Build 449 — "my assignments aren't saving when I ask the CFO to file these"

Reported live: asked the CFO to file Klaviyo, Google Workspace and ClickUp as
software; it said it had, and nothing changed. The app had already caught the
lie — *"Nothing was actually saved — that reply had no save action behind it"* —
so the honesty layer worked. The filing did not, for two compounding reasons.

### The cap that made it impossible

```js
if (hits.length > 8) return { hits: [], why: '…too broad to file safely' };
```

Any description match hitting more than eight rows was refused. `CLICKUP` across
two years of monthly subscriptions is ~24 rows. So is `KLAVIYO`. So is
`Google Workspace`. **Every one was rejected**, and the refusal came back to the
model as a failed item which it reported as success.

That cap was written when the ledger was six months of bank feed. The history
import turned it into the bug: filing a recurring merchant across its whole
history is now the main job.

**Breadth is not what makes a match unsafe — vagueness is.** The guard moved to
the QUERY: under four characters is refused, a real merchant name files its whole
run however many rows that is. Every filing stays undoable.

### And it could not see them anyway

The snapshot listed the top **24** merchant patterns by dollar value. A $15
Google Workspace ranks below every five-figure wire, so with 860 uncategorised
rows they were never in context at all. Window widened to 60, and the spec now
says the list is not the whole ledger: file an unseen merchant by description
match and let the result answer.

### Two tests pushed back, and one was right

- **smoke26** asserts the biggest amount leads the list. Sorting repeats to the
  front was tried and **reverted** — materiality is the right order for a CFO
  snapshot, and widening the window alone fixes the crowding.
- **smoke7** asserted the 8-row cap as intended behaviour. That test was changed,
  because live data disproved the rule it encoded. It now asserts the new rule
  from both sides: a named merchant files its whole run, a one-letter query is
  still refused with its reason.

`gauntlet/txnfile.js` — 7 assertions, 5 failing against Build 448.

---

## Build 450 — the transcript was teaching the CFO not to emit action blocks

Reported after 449: still *"Filed — same three merchants, third time now"*, still
nothing saved, and **no working animation** while it ran. Two separate bugs.

### The history was a poisoned few-shot

The action block is stripped from a reply before it is shown — and the STRIPPED
text is what goes into the history the next turn is built from. So the model read
its own past turns as pure prose with no `venia:action` block anywhere. Three of
those in a row and its own transcript is an example teaching it that replies here
do not carry blocks. It writes "Filed" and emits nothing.

**That is why it escalated.** Each failure made the next more likely.

The transcript now records what actually happened: a turn that acted says so with
its action type; a turn that CLAIMED to act and did not carries a correction into
the place the model reads. The ⚠ warning was only ever shown to the founder.

Applied on all three paths — direct, cloud, and the dock.

### Queued is not finished

The cloud path called `think.__done()` and `agentEndWork()` the moment the job
was accepted, stopping the indicator while the run was still going, and never
registered the job in `SK.cloudJobs` — which is where `cfoChatApply` looks for
the bubble to land the answer in. So the app looked idle for the whole turn and
the reply arrived detached. The dock path already did this correctly.

### The dropdown disagreed with the accounting

`finTxnCat()` reads the description when nothing is filed, so a row can be
COUNTED under a category everywhere while its dropdown showed `—`. Measured:
STUDIO RENT counted as `rent`, shown as `—`; UPS STORE counted as `shipping`,
shown as `—`. Setting such a row explicitly moves a count the founder never knew
it was in — which reads as a tag being removed from another row.

The dropdown now shows the effective category, italic grey with a tooltip when it
was read from the description rather than filed by hand.

**Not proven:** a case where setting row A clears row B's stored category. No
duplicate ids exist in the live ledger (1,436 rows, 1,436 distinct) and
`bankSetCategory` was driven directly with only the targeted row changing.

### Two corrections to my own work

The history marker was first written with literal backticks around
`venia:action` — a fenced block inside a transcript could read as a real block
boundary, the exact confusion it exists to remove. Dropped.

**smoke6** then failed with "block leaked". It was right to fire, but its check
was a proxy — it grepped for `venia:action` to mean "the raw block leaked". It
now asserts what actually matters: no fence, no JSON payload, AND that the note
recording the action IS present.

`gauntlet/agenthistory.js` — 10 assertions, all failing against 449.
`gauntlet/txnfile.js` — now 11, the 4 new ones failing against 449.

---

## Build 451 — the third statement, and the only one with nothing inferred in it

A lender's pack is three documents. The P&L (440–447) is a mixed basis; the
balance sheet (448) has no double entry behind it. This one is neither: every
line is money that actually moved through the bank, so **nothing in it is
accrued, estimated or inferred**. It is the statement a lender can lean on
hardest, and it says so — leaving all three looking equally soft would have been
the wrong impression to give.

**Direct method, because it is derivable.** An indirect reconciliation starts
from net profit and adjusts for non-cash items, which needs a general ledger this
company does not keep. Listing what came in and went out needs only the bank.

### The two traps it must not fall into

**Factory money belongs here.** The P&L deliberately keeps fabric and production
out of operating expenses, because their cost arrives through COGS as garments
sell. Cash flow has the opposite job — that money left the bank whatever the P&L
does with it. The two statements are MEANT to disagree about this, and the note
says why, otherwise it looks like one of them is wrong.

**Transfers between our own accounts are not cash flow.** Counting one leg as
money leaving the business is how a healthy month reads as a bad one. They are
netted, reported apart, and if they do not net to zero the note says what that
means: only one side is in the ledger, usually because the other account is not
connected.

### Which end of the reconciliation it actually knows

Closing cash is the bank's own figure. **Opening is derived by subtracting the
movements from it** — this app was not connected on 1 January and never observed
that balance. Said outright, along with where the error lands if a movement is
missing: entirely on the opening balance.

`gauntlet/cashflow.js` — 20 assertions, all failing against Build 450.

---

## Build 452 — a false claim with no warning at all

Reported: the CFO was asked to set HISCOX to insurance, said it had, and nothing
changed. Checked against the live ledger:

- **21 HISCOX rows uncategorised, every one with an `imp_` id**
- 4 filed — 3 feed rows and 1 imported — and the CFO's own reply called those
  "the 4 already filed", so **this turn filed zero**

### The reply carried no warning

Its words were *"Filing all 21 uncategorized HISCOX rows as insurance"* and
*"All 25 HISCOX transactions now read as insurance."* `AGENT_CLAIM_RE` knew
`filed` and not `filing`, and had no pattern for "now read as" — so the founder
got a confident false report with **no ⚠ at all**, which is worse than the
failure it exists to catch.

Five real phrasings were slipping through, including a sentence that simply
opens with the verb: *"Filed — same three merchants."* The detector is now a
composed pattern covering past tense, present participle, "are now X", and a
bare sentence-opening assertion. Twelve cases pinned, four of them non-claims
(a question, a suggestion, two plain answers) that must NOT be flagged.

A missed claim costs a founder their trust in the ledger; a spurious warning
costs a sentence, and only ever appears when nothing was written anyway — so
this leans towards catching.

### And the app was pushing it down the fragile path

The snapshot said *"Use those ids in set_txn_category"* and the ledger block
ended *"Use set_txn_category with these ids."* For a merchant that repeats 25
times across two years, **twenty-one enumerated ids is a long block that can be
cut off mid-way, and every id is a chance to mistype**. One
`{"match":{"desc":"HISCOX"}}` files the whole history in one item.

That path already worked — Build 449 removed the cap that used to refuse it —
the app simply never told the model to prefer it. Both instructions and the spec
example now do.

**Not a new capability, a changed instruction:** 3 of the 4 new HISCOX
assertions pass against 451 too. They document that description matching works;
what changed is that the CFO is now told to use it.

### And a test that assumed a one-line regex

`smoke36` extracted `AGENT_CLAIM_RE` with `[^\n]+`. The detector outgrew one
line when the phrasings it has to catch did, so the extraction now takes the
whole declaration.

`gauntlet/agenthistory.js` — now 12, the 2 claim assertions failing against 451.
`gauntlet/txnfile.js` — now 15.

### Build 452, continued — the path that cannot fail

Same failure a third time, on INXPRESS: *"All 14 INXPRESS transactions now read
as shipping."* The live ledger held **14 uncategorised and 1 filed**. Nothing ran.

**The app pipeline is not the problem, and that was proved rather than assumed.**
Driving the exact cloud landing path with a realistic reply carrying 13 ids files
**1 → 14**, persists, and renders an action card listing every row. Also ruled
out by measurement: system-block truncation (20k and 12k against a 100k limit,
spec present at offset 6360), permissions, the resolver, and the old 8-row cap.

The model simply does not emit the block reliably. Three builds spent trying to
make it is two too many for something done this often, so filing a recurring
merchant stops depending on it.

**Search a merchant → "Select all 15 matching" → pick a category.** One tap, no
model, no ids, undoable. Offered only while a filter is narrowing the list,
because "select all 1,436" is nobody's intent.

### And the bug reported earlier, finally reproduced

*"When I set a transaction type, it removes a tag from another one."* Not
reproducible at the time; here it is.

```js
if (cat && finAllCats().indexOf(cat) < 0) return;   // '' is not a name, so it passed
```

`bankBulkCategorize` read the dropdown, which starts on "—". Select rows, some
already filed, press **Set category** without touching it, and **every selected
row was silently cleared**. The guard only rejected names it did not recognise.

Now an empty category refuses with a message, `bankBulkCat` keeps the stored
intent and the DOM select in step so they cannot drift, and an explicit
**Uncategorize** button covers the case where clearing is what you meant.

`gauntlet/bulkfile.js` — 10 assertions, all failing against the first half of 452.

---

## Build 453 — 725 decisions are about thirty decisions

Asked for accuracy above everything, so the P&L and balance sheet can be
submitted. Audited the live ledger rather than guessing at it.

### Where it stands

**725 of 1,436 transactions have no category — 50.5%.** $146,098 of payments and
$183,478 of receipts.

The two biggest unfiled vendors are the same thing:

| | Rows | Amount |
|---|---|---|
| Zelle from Christine Ko | 65 | **$96,210 in** |
| Zelle from Keeter Ly | 52 | **$58,763 in** |

**$154,973 of founder money, untagged.** Filed as owner investment it becomes
equity; left as it is, it appears nowhere and equity is understated by the whole
amount. It is the largest single line the balance sheet is missing.

### Three errors already in the books

- **Transfers net +$42,052 instead of zero** (129 rows) — one leg missing, or
  something that is not a transfer filed as one. The cash flow statement is
  wrong by that much.
- **15 rows tagged `payroll` on money coming IN** ($1,823).
- **2 rows tagged `income` on money going OUT** ($521).

### The review

**Money → Cash → "Review N unfiled"** — one row per vendor, biggest first, a
category dropdown and a File button. Thirty answers instead of seven hundred,
and the order matters more than the count: $96,000 of founder transfers before
$73 of taxi rides.

`finTagAudit()` runs the checks above in the app. Unfiled rows **block**
readiness rather than warning softly; the founder Zelles, the sign
contradictions and the transfer imbalance are each named with their size.

### The merchant key is the whole trick

A bank writes one vendor a dozen ways. Zelle names the counterparty, ACH names
the originator, a card charge buries it between a processor tag, a phone number
and a city.

- `HIS*HISCOX INC 888-202-3007 NY 08/24` → **HISCOX INC** — a short token before
  an asterisk is the processor's tag, not the merchant, and keeping it gives a
  list of vendors called "HIS HISCOX" and "SQ BLUE".
- `ORIG CO NAME:GUSTO CO ENTRY DESCR:…` and `ORIG CO NAME:GUSTO ORIG ID:…` both
  → **GUSTO**. Taking two words blind gives "GUSTO CO" and "GUSTO ORIG": one
  vendor split in two, which is exactly what the two sources do to the same
  payment.

**A test corrected, not the code:** the ACH assertion first ran through the
unfiled list, where it tested the auto-categoriser as much as the grouping —
Gusto is already a payroll rule, and the neutral name picked to replace it turned
out to be a transfer rule. It now asserts the key function directly.

`gauntlet/tagreview.js` — 17 assertions, all failing against Build 452.

---

## Build 454 — a filing is never undone by a sync

Reported four times, each time as *"I set a tag and another expense lost its
tag."* Every previous attempt looked in the wrong place. **The categorisation
logic was never the problem** — `bankSetCategory` only touches its target, the
live ledger has no duplicate ids, and the bulk path was proven correct. The loss
happens in the SYNC, and it is reproducible in nine lines.

### Two faults, either of which reverts a filing on its own

**1. The push read the wrong result.**

```js
var res = !writesBlob ? … : await c.from('venia_workspace').upsert(…);
if (!res || !res.error) { … setBase(localSnap); }
```

`res` is the BLOB's result. For a founder the blob almost always writes, so a
module row that did **not** land — RLS, a dropped connection, a payload the
server refused — was recorded in `__syncStat` and then **ignored**, and the merge
base advanced as though everything had been published.

**2. The three-way merge then reverts.** With the base level with local and the
cloud holding older values, `_mArray` reads every unpublished edit as "only the
cloud changed" and takes the cloud copy — blanking categories one row at a time,
silently. Which is exactly what the founder saw.

Measured against the pre-fix code: base level with local, stale cloud,
**0 of 3 filings survived**.

### The fix, in two parts

**The base only advances when what was pushed landed.** A failed module write now
fails the whole push, says so, and retries in twenty seconds — an unpushed change
that nothing retries is a change that gets reverted later.

**And the merge is allowed to change a category, never to blank one.** Emptying a
category is a rare deliberate act; losing one to a race is a bug. If this device
holds a category and the merge came back without it, it is put back. A partner
recategorising still wins, a deliberate clear still clears (that device is the
one holding the empty value), and nothing changes about which records exist.

`gauntlet/tagsync.js` — 9 assertions, 5 failing against Build 453. Runs the merge
machinery directly out of the file: this is arithmetic, not a screen.

### Build 454, continued — the dropdown lost tags and the bulk button did not

*"Changing the tag here doesn't set the tag sometimes. Changing a tag may remove
a tag of another still. Setting the category through the bulk action works
though."* That last sentence is the whole diagnosis.

They share every line of the write. The dropdown's handler ran INSIDE the
select's change event and **synchronously rebuilt the list, destroying the
element still delivering the event**. On iOS the picker stays bound to its
element until it closes; a picker whose element was torn out can deliver a
second change — to the detached element, whose value reads `""`, or to the new
element rendered into the same spot, which is a **different row**. The first is
"the tag did not stick"; the second is "changing this one cleared that one". A
button click has no picker and no second event, so bulk was fine.

Replayed deterministically against 453: **both symptoms reproduce.**

Three defences: an unrecognised value is rejected, not turned into a clear
(the old line made anything the list did not know into `""`); the element is
blurred and the re-render deferred past the end of the event; and an empty
value within 600ms of a real change is the echo, not a decision.

**The period pills scope the whole screen now.** They scoped the spend chart
and left the list on all-time, so "Uncategorized" showed two years of rows under
a pill that said 90d. One `finPeriodSince()` for both; the count says which it
is; select-all-matching inherits it, so "file all" never sweeps rows in another
year.

`gauntlet/tagdropdown.js` — 8 assertions, 7 failing against Build 453.

### Build 454, continued — two right asks that collided

The period pill now scopes the list (asked for), and "Select all matching"
exists to file a vendor across its whole history (built the build before). Under
the default 90-day pill the second silently became "file the last 90 days of
it" — `bulkfile.js` caught it in the sweep: 2 rows selected where 15 were meant.

Neither ask is wrong, so the control offers both and the founder chooses:
**"Select all 2 matching 'INXPRESS' in this period · or all 15 across all
time."** The list honours the pill; nothing about a vendor's history is hidden.

## Build 455 — the transfer imbalance was the founder's equity

Measured on the live ledger after the founder's own filing pass: 68 Zelle
receipts from the founder, $75,857, every one filed as **transfer**. Transfers
netted to **+$75,818**. Owner investment on the balance sheet: one row, $500.
The two big numbers are the same number.

"Transfer" meant "from my account" to the person filing it, and "between
VENIA's own accounts" to the statements. So $75k of equity appeared on neither
the balance sheet nor the cash flow statement, and the "transfers do not
cancel" line reported exactly that amount as a missing leg. Nothing in the
review screen suggested transfer — the dropdown defaulted to "Choose…" — but
nothing said what transfer meant either, and nothing noticed afterwards.

Three changes, none of them silent re-tagging of someone's books:

- The audit names it: **"68 Zelle receipts from KEETER LY filed as transfer —
  $75,857"**, with the plain-words difference between transfer, owner
  investment (equity) and loan (a liability VENIA repays). The transfer
  imbalance line points at it as the explanation.
- One click: **Refile as owner investment** / **Refile as loan** on that line.
  Receipts only — a Zelle *out* to the founder is a draw or a reimbursement,
  which is a question, not a rule. Anything but those two answers is refused.
  Undoable like every other filing.
- The dropdown label reads **transfer (own accounts)** so the next person
  filing a founder Zelle does not pick it.

`gauntlet/zelleequity.js` — 19 assertions, fails on 454 (the function and the
issue do not exist).

## Build 456 — the same mistake in a second category, and a loan filed as a cost

Measured the morning after 455 shipped:

- **62 Zelle receipts from the co-founder, $92,935, filed as "rent".** Rent
  all-time reads +$10,459 — as if the landlord pays VENIA. The P&L was safe
  (inflows never reach opex) but the cash flow statement counted $93k of
  capital as operating receipts, and the balance sheet saw none of it.
- **16 Upgrade loan repayments, $7,257, in a custom category "loan-repayment".**
  Only the built-in `loan` is routed below the operating line, so principal
  repaid was reported as a cost of running the brand.

Build 455 looked for founder money in "transfer" only. Now:

- **Every category.** Zelle receipts from a person in any category except
  income (a customer paying by Zelle is income), owner investment and loan get
  their own audit line — who, how many, which category, how much — with the
  two honest answers as buttons, scoped to that category. The sign check no
  longer double-reports the same rows.
- **A custom category whose name says financing** (loan / repay / principal,
  draw / distribution, invest / capital / equity / contribution) is named with
  its total and moved to the matching built-in in one click. The emptied custom
  category is retired; Undo brings both the rows and the category back.
- Built-in sources are refused — those have select-all already and do not
  disappear.

Noted, not changed: the five "taxes" rows are sales tax remitted to CDTFA and
tax-prep fees, not income tax; there is no income tax in the ledger (pass-
through entity), so the "income tax sitting in opex" item from the queue is
moot.

`gauntlet/personreceipts.js` — 21 assertions, fails on 455.

## Build 457 — a season set on a style is undone by the next pull

"I keep setting season tags here but they keep getting undone." Same family
as the ledger reverts of Build 454, a different door.

454 stopped the **push** advancing the merge base past what actually landed.
Every **pull** path still did `applySnapshot(merge(base, local, cloud));
setBase(snapshot())`. The merge keeps the local edit — correct — and the base
then carries it too. The next push merges base=SS27, local=SS27, cloud=CORE,
reads "only the cloud changed", takes CORE, publishes it and adopts it on
screen. Anything that pulls in the second and a half between the tap and the
push does it: a partner's realtime write (the Money tab being used on the
other phone is enough), the four-minute poll, switching tabs and back.

A three-way merge's base is the last state both sides agreed on. After a pull
that is the cloud as we just saw it. So: one `absorbRemote(row)` for all six
pull sites (realtime, the reload pill, the poll, both boot branches, manual
pull), and it sets the base to `row.data`. A push then sees exactly the edits
it has not published, and a deletion made locally stays a deletion instead of
coming back as "the cloud added it". The push path's own base advance is
unchanged — after a successful push the cloud *is* what was pushed.

The seams (`__syncAbsorb`, `__syncSnapshot`, `__syncBase`) exist so the
sequence can be replayed against the real functions instead of a re-typed
copy of them.

`gauntlet/seasonrevert.js` — 11 assertions: the arithmetic straight out of
the file, then the tap → pull → push sequence end to end, for a style season,
a style deletion and a ledger filing. Fails on 456.

### Build 457, continued — "some info here is getting cut off"

The review screen named vendors by their merchant **key** — the first two
words of the cleaned descriptor. Right thing to group on (a third word is a
store number as often as a name), wrong thing to show: "CA DEPT" for CA DEPT
TAX FEE, "NON CHASE" for NON-CHASE ATM WITHDRAW FEE, "I AM", "APPLICATION
USER". The founder cannot file what they cannot read.

The key is unchanged, so grouping and File are unchanged. Each group now also
carries the longest name every one of its rows agrees on (at least the key,
at most six words, never ending in a bare number), and the longest raw
descriptor in the group sits under it, in full on hover.

`gauntlet/merchantlabel.js` — 9 assertions, 6 failing before.

## Build 458 — the way back from a hidden sidebar was painted, buried and unclickable

"I also hid the sidebar, but don't know how to bring it back."

There WAS a way back: a 20px unlabelled "›" sliver on the left edge, plus ⌘\.
Both failed, for different reasons.

**The sliver was unclickable on half the app.** Today, Money and Brainstorm
are `.cp-screen` panels — `position:fixed`, `z-index:400`, covering everything
below the global bar. `#rail-open` sat at `z-index:320`. It was PAINTED on
those spaces and buried: the founder could see a hairline, tap it, and have
nothing happen. Measured: `elementFromPoint` at its centre returned
`cpl-hero` on Today, `page-band` on Money, and only on Product — a legacy
`.main` layout, no fixed panel — did it return the button itself. So on the
space they were actually in, the control did nothing at all.

**And ⌘\ is unknowable.** The one action whose undo you cannot see afterwards
is hiding your own navigation, because the thing that would tell you how is
the thing you just hid.

- `z-index:450` — clears the screens (400), stays under the global bar (500)
  and the phone drawer (585).
- A labelled control, not a hairline: 38×96 with a vertical "MENU", a shadow,
  and a tooltip naming both shortcuts.
- Hiding it now says, on screen for five seconds, exactly how to undo it.

Phones are unaffected — the drawer is the navigation there and the tab stays
hidden, which the gauntlet holds.

`gauntlet/railback.js` — 17 assertions driven on the Money space, where it was
buried. 6 fail on 457.

## Build 459 — a write is not saved until the cloud has it

"Sometimes my writes don't save. For instance in Product when setting a
season, or in Money with the category tag."

Two findings, one of them a dead end worth recording.

**Tested and disproved first.** The obvious suspect was a tap landing during
a push: `pushNow` snapshots local, then AWAITS a network read, and everything
after that await was thought to operate on the pre-tap snapshot. Driven
through the real `pushNow` against a fake Supabase client, with a partner row
in the cloud so the adopt branch actually runs — the tap survives. `snapshot()`
stores references, not copies, so the array the push serialises IS the live
one. Safe by construction. Kept as `gauntlet/pushrace.js` (9 assertions) so it
stays that way; it passes on 458 and that is the point of it.

**The real hole.** `pushNow` has six ways out and Build 454 made exactly ONE
of them retry. The rest returned in silence:

| exit | before |
|---|---|
| client not ready | return, no retry |
| first sync decision not made | return, no retry |
| blob write returned an error | toast, no retry |
| anything threw (dropped connection) | toast, no retry |
| module row refused | retry (454) |

In each silent case the edit is on the device and nowhere else, and nothing
will ever carry it up. A founder who keeps working never notices — state is
cumulative, so the next edit takes it. A founder who tags one row and puts the
phone down loses it. A phone in a lift, a laptop waking from sleep, a token
refreshing: a normal Tuesday.

- Every exit now arms a retry with backoff (3s, 8s, 20s, 45s, 90s), and the
  base still only advances on the write that landed.
- `__syncPending()` says whether this device is holding unaccepted work.
- A badge says it on screen — appended to `<body>` at z-index 9600, so no
  repaint and no fixed screen can hide it, and tapping it opens sync status.
- It appears only after a push has actually FAILED. "Not ready yet" (boot,
  before the first sync decision) retries quietly: a badge that flashes on
  every launch is a badge nobody reads on the day it matters.

`gauntlet/pushretry.js` — 11 assertions, hard-fails on 458.
`gauntlet/pendingbadge.js` — 11 assertions, hard-fails on 458.

## Build 460 — the statement a lender reads, closed on a real period

An outside review of the P&L asked for a second, lender-facing version. Most
of it was presentation. One part of it was not possible yet, and that part
mattered most.

**The period end.** The request was for January 1 – August 31, 2026. Bank rows
and wholesale orders carry dates and always could be windowed. DTC could not:
Shopify was held as a year-to-date and an all-time aggregate per product with
nothing in between, which is why `finPLPeriodNote()` said, in the code, that a
custom range "would mix one period with another". Printing a year-to-date
figure under a heading that says 31 August is the one thing a submitted
document must never do.

So the Shopify pull — which already spans from January of LAST year — is now
bucketed by month, in both places it lands: revenue on `bizPulse.byMonth`, and
units sold on `styleSales.map[k].m`. Both halves, deliberately: revenue cut at
August against units counted to today would overstate cost and understate
margin. `cmdMoneyData({end})` bounds everything else by date.

**And it refuses.** If those buckets are missing — a workspace that has not
re-synced since this build — `dtcBounded` comes back false and the lender
document prints nothing, saying what to do instead. A refusal is the feature.

**The document.** One page, the lender's row order (payroll, software, rent,
contractors, taxes … rather than sorted by size, so two months can be read
down the same rows), gross margin as a percentage, interest below operating,
then three sections outside net income: Financing and Ownership, Supplemental
Information (inventory at landed cost, units, styles), and five short notes.
The working statement is untouched and still carries every caveat.

**The manufacturing caveat is answered, not deleted.** Management confirmed
contractors are not production and shipping is outbound. That confirmation is
recorded in `STATE.finMfgConfirmed` with who and when, syncs to the other
founder's device, and turns the caveat into a stated confirmation. Untick it
and the caveat returns. A safeguard that can be silently removed is not a
safeguard; one that records who answered it is.

Historical payroll is kept in full, with a management note that it is no
longer part of the fixed operating structure — a note, never an add-back.

`gauntlet/lenderpl.js` — 25 assertions, including that both documents report
identical totals for the same period. Presentation changed; arithmetic did not.

## Build 461 — the balance sheet and cash flow, dated and plain

Same brief as 460, applied to the other two statements: one page each, a real
reporting date, and the internal hedging out. "No general ledger", "derived,
not observed", "the most reliable of the three" are true and useful to the
founders; an underwriter reads them as a warning label.

**Taking hedging out is not hiding a limitation, and the line between them is
the work.**

- **Cash and card balances can be dated exactly.** Every row carries its
  account, so the position on 31 August is the position today less what moved
  since. On the live ledger that is six rows and $4,856. `finCashAt(end)` does
  it: cash less post-date cash movement, debt plus post-date card movement
  (a charge is negative and debt is carried positive).
- **Inventory, receivables and factory commitments cannot.** No history of
  stock levels or open orders is kept, so those are the current recorded
  position whatever date is on the page. They are marked `current` and said
  once in a note. Dating them silently would be inventing a figure.

The cash flow was already right in structure — direct method, transfers netted
separately, financing apart from operating — so it needed the period bound and
the plain presentation, nothing more. Production and fabric payments stay
inside operating, visible, because they are the working-capital story a lender
is trying to see.

**Nothing unresolved was deleted.** `finReconcileFlags()` raises the three
items to the founders, beside the export where they will be read, and they do
NOT appear in the lender pack:

1. Receipts filed as income against revenue recognised from orders. Both can
   be right; the gap needs one sentence of explanation before it is asked for.
2. Owner draws. Correct outside the trading result if it really is owner money
   — and overstating profit by that much if any of it was reimbursement or pay.
3. Liabilities are limited to what is connected or recorded. A lease, an
   equipment loan, an EIDL, a personal guarantee or an unconnected card would
   not appear at all. This is the one that costs an application when found
   later.

One chooser now serves all three statements — working version or closed
period, same month ends on each, because an SBA file needs all three carrying
the same date.

`gauntlet/lenderbscf.js` — 32 assertions, including that the statement adds up
(opening + operating + financing + transfers = closing) and that the
reconciliation items reach the founders and not the pack.

## Build 462 — the garment is the point of the page

From a printed SS27 sheet: "a bit truncated and cropped… ensure the images are
portrait framing and do not crop the actual clothes", then "I'd rather have the
product info sit closer to the bottom and the image take up more of the
vertical space."

Three complaints, one cause. The photo band was a **fixed height per column
count** — 64mm at 3-up inside a 196mm page — so a landscape-ish frame sat in
the middle of the sheet with the spec under it and the rest of the page empty.
And because a wide frame leaves white margin around a tall garment, the image
was scaled 1.16 with the overflow clipped: a 7% crop into every edge. On a
packshot with a tight bounding box that lands on the garment. The ISOLDE TOP
lost its hem.

- The band **takes the slack** (`flex:1`), the grid row fills the page
  (`1fr`, not an auto track centred in leftover space), and the card hugs the
  bottom. At 3-up the frame is now 121mm tall in a 90mm column — portrait,
  and capped at 1.34× the column width so a narrow column does not get a band
  three times its own width with a stamp floating in it.
- **Nothing is scaled.** Contained on white, whole garment, always.
- The alignment the fixed height was protecting is kept a better way: every
  card gets the same spec band (`min-height` per density), so every photo gets
  the same remainder and the names still sit on one line across the sheet. A
  card whose spec overruns borrows from its own photo and nobody else's.

Text size is unchanged — asked for, then withdrawn in favour of the above.

**Two filters and a switch**, because a line sheet is not one document:

- **Made in** and **Factory**, from the values actually present in the line
  with counts, blanks excluded. Every filter narrows: Japan + Kaneta is what
  Kaneta makes in Japan, never the union. A filtered sheet says so in the
  header on every page — a buyer holding "the SS27 sheet" that is really the
  Japan-made half of it is how a style gets ordered that was never offered.
- **Show retail price**, on by default. Off leaves the figure off the page
  entirely rather than merely unlabelled, because a PDF is searched as often
  as it is read.
- A facet with one value offers no control at all.

**The existing `vls.js` caught a real regression before this shipped** — cards
286.8mm tall on a 182mm page at 2-up. Two causes, both from making the frame
flexible:

- `max-height:1.34 × column` is 185mm when the column is 138mm wide (2-up).
  Capped at 112mm as well, so the spec band and footer keep their room.
- A percentage `max-height` on the image had no definite parent to resolve
  against once `.ph` stopped having a fixed height, so a tall shot grew the
  band instead of fitting in it. The page is now a definite `height:196mm`
  (growth comes out of the photo, which is the flexible part) and the image is
  absolutely positioned and centred by auto margins.

Two of that gauntlet's assertions were deliberately superseded and rewritten
rather than deleted: the card's children are now `ph → info` (same reading
order, one level deeper), and there is no leftover page to split above and
below the block because the block fills it. In their place: the frame is
portrait, the photo outweighs its own spec, and the image is never larger than
its frame.

`gauntlet/linesheetframe.js` — 21 assertions. `slVlsPrint` split into
`slVlsDoc()` (builds) and `slVlsPrint()` (opens), so the document can be
asserted rather than the dialog that produces it.

## Build 463 — see what you typed

The access code is 320px of dots on a black screen, entered on a phone with no
way to check it. One wrong character and the only feedback is "Incorrect access
code" and a cleared field, so you type the whole thing again, blind. Every
login on the internet has an eye for this reason.

An eye button inside the field, left of the arrow, 40px so a thumb can find it.
Three things beyond "it toggles":

- **The caret stays put.** Changing `type` re-creates the text node and the
  browser drops the selection, so it is saved and restored. A cursor that moves
  without being asked is worse than no reveal at all: the next character lands
  somewhere you cannot see and you have no reason to look.
- **It resets to dots** on a wrong code and on a successful unlock. A revealed
  code left on the gate — through the Face-ID enrollment step, or the next time
  the gate is shown — is a shoulder-surf nobody asked for.
- **`type="button"`.** A button inside a field is a submit button unless told
  otherwise, and revealing the code is not entering it.

Drawn, not a character that depends on a font. The crossed-out state was
redrawn after looking at it: partial arcs plus a slash read as a squiggle at
19px, so it is now the full eye with a clean line through it.

`gauntlet/pwreveal.js` — 17 assertions, driven at 393×852 with no auth stub,
because the gate is the thing under test.

## Build 464 — the page a lender actually holds

From a printed P&L: the totals row split across a page break, the type ran to
the edge of the sheet, and the signature block was cut off at the bottom. A
statement with the signature line sliced in half is not a document anyone will
accept.

Three faults, and **all five statement stylesheets had them**, because each
carried its own copy of the print CSS:

- **No `@page` rule**, so the paper margin was whatever the browser chose, and
  `@media print{body{padding:24px 0}}` set the SIDE padding to zero — which is
  why the type ran into the edge.
- **Nothing kept a table row together**, so a two-line total could be cut
  through the middle.
- **Nothing protected the signature block**, which is the last thing on the
  page and therefore the first thing to be orphaned.

One `STMT_PRINT_CSS` now, spliced into every statement: `@page` at 16mm × 15mm,
`break-inside:avoid` on rows, notes and the signature, `break-after:avoid` on
section headings and titles so a heading is never left alone at the foot of a
page, and `thead` repeating on any table that does break. Five copies of a
print rule is five chances for one to be forgotten, which is how a document
ends up cut off in the first place.

The body keeps a **6mm × 5mm floor** in print rather than dropping to zero.
`@page` supplies the paper margin, but the browser's print dialog lets a reader
choose "Margins: None" — and type against the edge of the sheet is the same
fault arrived at a different way.

More room throughout: row padding 6–7px → 8–8.5px, screen margins 52/56px →
56/60px with 66px sides, note leading and spacing up, and the signature block
given 34mm of air above it.

`gauntlet/stmtprint.js` — 11 assertions across all six statement documents
(working and lender P&L, balance sheet, cash flow), each checked for the same
print contract and then actually rendered to a PDF to confirm it still
paginates. Fails 8 on 463.

## Build 465 — no signature block on the P&L

Removed from both P&L documents, working and lender. An interim profit and loss
is management's own statement of a period, not something anyone counter-signs,
and a blank rule at the foot of the page invites the question of whose
signature is missing.

The entity line stays — `VENIA Collection · Los Angeles, California` — in a
`.foot-id` block carrying the same air and the same break rule the signature
had, so the foot of the page does not suddenly ride up.

**The balance sheet and the cash flow keep theirs**, and that is deliberate
rather than an oversight: a balance sheet is a position as at a date, which is
the thing somebody attests to. Flagged to the founder in case they want those
removed too.

Asserted in `gauntlet/stmtprint.js`: neither P&L carries a signature block or a
"Prepared by" rule, both still carry the entity line, and all four other
statements still have theirs.

## Build 466 — earned money that never reached the P&L

"Does the P&L account for income that is not DTC? For instance this contract
work we did here." **It did not.**

Revenue was Shopify DTC plus wholesale orders booked in the app, and the
transaction loop threw away every inflow except owner investment and a loan:

```js
if (amt >= 0) { ...owner_invest / loan...; return; }
```

So an $8,712 service invoice paid by ACH, filed as `income`, sat on the bank
screen and appeared nowhere on the statement. Measured on the live ledger,
Jan–Aug 2026: **$49,621 of banked income, of which $28,425 are Shopify payouts
and $21,196 is not.** Against $31,620 of reported revenue. A statement handed
to an underwriter that understates revenue by two thirds is not conservative,
it is wrong — and it is the answer to the receipts-versus-revenue gap flagged
in Build 461, which I had put down to timing.

**The reason it was excluded is real and is kept.** A Shopify or Stripe payout
lands in the bank too, and counting it would double the DTC revenue already
recognised from the orders. So the rule is not "count every inflow" but "count
every inflow except the settlement of a channel already counted":
`finIsSettlement()` — one regex, one place, because it is the rule that decides
double counting.

- New revenue line, **Other income received**, noted as "banked receipts
  outside the sales channels". Absent when zero.
- Both statements carry the basis in a sentence, naming the excluded
  settlement total, so the exclusion is stated rather than silent.

**Three questions raised, not answered:**

1. `cash_deposits` — $5,434 of ATM cash deposits are filed as income and now
   count as revenue. If any of it was the founder banking their own cash it is
   owner investment, and leaving it here overstates revenue and understates
   equity by the same amount.
2. `wholesale_collections` — wholesale is recognised when the order is booked,
   so a customer's later payment must not be counted again. Processor
   settlements are excluded automatically; an ACH or Zelle payment against an
   invoice is not, because nothing in the descriptor says which invoice it is.
   ($0 today — no wholesale collections on the ledger.)
3. `receipts_vs_revenue` — reframed: what is left of that gap is timing, not
   missing revenue.

`gauntlet/otherincome.js` — 16 assertions, built from the real descriptor
shapes on the ledger.

## Build 467 — the lender statement did not foot

"So the P&L doesn't have the other income listed. Is that correct?" No — and
the missing line was the smaller half of it. The page showed **$31,620 of
listed revenue over a $52,816 total**. A statement that does not add up is
worse than one that is merely incomplete: it tells an underwriter the numbers
cannot be trusted, and adding the column is the first thing they do.

**Cause: a section that NAMES its rows instead of rendering them.** The lender
document hard-coded two revenue lines and two cost-of-goods lines and printed
`st.revenueTotal` beneath them. The working statement maps over `st.revenue`,
so it was correct all along — the fault was in the lender layout only, and it
appeared the moment Build 466 added a third revenue line.

Both sections now render from the statement, in the lender's order, with
anything the order does not anticipate kept rather than dropped — the same
rule already used for operating expenses.

**Also fixed: gross margin printed as a bare number in a column of dollars**,
reading as $92 of margin on $52,816 of revenue. The hazard was written down in
a comment in Build 460 and the number was left as it was. Noticing a fault is
not fixing it.

The assertion added is the invariant, not the symptom: **every listed line in a
revenue section sums to the total printed beneath it**, in both documents. "Is
other income on the page" would have passed the next time a line went missing.

## Build 468 — the print header leak, and gross margin belongs to the product

### The internal URL on every page of a lender document

A P&L saved to PDF and shown to an SBA underwriter came back with the app's
address and "9/3/26, 2:51 PM · Page 1 of 4" across all four pages. That is the
browser's own print header and footer — Chrome and Safari add them unless the
person saving unticks "Headers and footers", and **no CSS can switch them off**.

It matters more here than it usually would: the creator host is an internal
tool and is not named outside the company. A statement handed to a lender with
the admin URL stamped on every page is a disclosure nobody chose to make, and
by the time it is a PDF it has already been sent.

So every statement window says so, in the action bar beside the button that
opens the print dialog, where the choice is actually made. It is hidden on
paper by the same rule that hides the buttons, and it does **not** name the URL
— printing it in the document would be the leak.

`gauntlet/printleak.js` — 7 assertions across all six statements.

### Gross margin belongs to the product

With service income folded into revenue, gross profit was total revenue less
cost of goods sold — and a service invoice carries no cost of goods, so the
margin read **91.5%**. True arithmetic, wrong number: an apparel lender
comparing VENIA against other apparel businesses reads that and either
disbelieves it or misjudges the line. The garments' own margin is **85.8%**.

- Revenue block is product only (DTC + wholesale) and foots to **Total product
  revenue**; the cost of goods and the margin belong to it.
- **Service and other income** sits after gross profit and before expenses —
  still inside operating income, because it was earned running the business,
  but out of a margin it did not earn. **Total revenue** foots there.
- Net income does not move. This changes where the number is shown, not what
  it is, and the gauntlet asserts exactly that.

The footing invariant from Build 467 was widened rather than relaxed: a page
can add up in one place and not the other, so both totals are now checked, in
both documents.

`gauntlet/productmargin.js` — 15 assertions.

## Build 469 — a document that is tallied has to survive being tallied

Both faults found by adding up a real submitted PDF.

### The statement was a dollar out

Printed: gross profit 27,122, other income 21,196, operating expenses 58,064,
operating income **(9,747)**. Those three numbers make **(9,746)**. Every line
was rounded for display and every total was computed from the unrounded
figures beneath it, so the page added up to something the page did not say.

A dollar changes no lending decision. A statement that does not foot changes
what an underwriter thinks of every other number on it.

Rounding now happens **once**, in `finPLStatement`, and every total is the sum
of the rounded figures the reader can see — revenue lines, cost lines, the
seventeen expense lines, gross profit, operating income, net income. The
statement is internally exact rather than exact against a ledger the reader
does not have.

### The Print button now carries the warning

Build 468 put a line of text in the action bar: turn off "Headers and footers"
or the browser stamps this tool's address on every page. **A second PDF came
back with the address on all three pages.** Advice beside a button is read
after the button is pressed, and by then the person is in the print dialog
looking at something else.

So the button opens the reminder and the reminder opens the dialog — one extra
press, on the only path to paper, in the window that produces the document. It
names the setting and not the address it is protecting, because printing that
here would be the leak it exists to prevent.

`gauntlet/stmtfoot.js` — 18 assertions. The footing ones read the printed rows
the way a person with a calculator would, and the test data lands every line
on a half dollar so the drift is unmistakable; the live ledger was out by one
dollar, and one dollar is easy to pass by accident.

## Build 470 — a retry is only as good as its next chance to run

From a phone on 5G: **Push ✗ TypeError: Load failed**, with the badge showing
"Not saved to the cloud yet — retrying". That is Build 459 working — the
network dropped, the edit is on the device, a retry is armed. Two things about
it were still wrong, and both are about *when* the retry gets its chance.

- **The backoff runs to 90 seconds, and iOS suspends timers in a backgrounded
  tab.** The screenshot came from someone switching back from another app — so
  on the device where app-switching is the normal thing to do, a pending write
  waits out a timer that was frozen while they were away. Returning to the app
  already triggered a PULL; it now triggers the push it owes as well.
- **The network coming back is the one event that makes a retry certain to
  work**, and nothing was listening for it.

Both go through `pushWake()`, guarded on `pushDirty` — a wake is not an excuse
to write — and both reset the backoff to the front, because the condition that
was failing has changed: the next attempt is not the fifth failure, it is the
first of a new situation.

**And the error is in English now.** "TypeError: Load failed" is Safari's
phrasing for "the request never left the device" ("Failed to fetch" is
Chrome's). `syncReason()` translates the ones a founder will actually meet —
no network, timed out, signed out — and keeps the original in `raw` for
debugging. Every push failure path routes through it; three of them were
assigning `err` directly and overwriting the translation.

`gauntlet/pushwake.js` — 7 assertions, driven at phone size against a fake
client that throws the real `TypeError: Load failed`.
