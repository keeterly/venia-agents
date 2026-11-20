# VENIA OS modules

VENIA OS is moving from one app to a **core plus modules**, so a brand can
subscribe to the sections it needs à la carte. This file is the contract every
module follows. The plan and its stages are in the "VENIA OS module plan" doc.

## What a module is

A module is a unit of work: its screens, the data it owns, what the assistant
may do in it, and everything it needs outside the page (tables, functions,
connector tools). Today's modules are listed in `MODULES` and described in
`MODULE_MANIFEST`, both in `venia-control-panel-v1.html`.

| Module | Tier | Owns |
| --- | --- | --- |
| home (Today) | core | the day, tasks, activity log |
| settings | core | connections and preferences |
| catalog | core | the sellable line, cost stripped |
| product | add-on | styles, materials, BOM, POM, tech packs, costing, POs |
| growth | add-on | the data behind Press, Social and Brand (one module id, one data row) |
| ↳ Press (space `pr`) | add-on part | sample pulls, pitches, editors, coverage, press tools, the PR watchlist; sub-switch `growth-press` |
| ↳ Social (space `mk`) | add-on part | Social Command, the Writer, the Launch Machine; sub-switch `growth-social` |
| ↳ Brand (space `br`) | core page | voice, tone library, brand library, competitor watch, brand settings; its data rides in the growth row for now |
| sales | add-on | buyers, quotes, orders, line sheets |
| money | add-on | bank feed, cash, plan, CFO |
| brainstorm | add-on | ideas, plans, mind map, boards |
| legacy | core | the pre-module store; retires, never sold |

Tiers: **core** every brand has and cannot switch off; **base** part of every
subscription; **add-on** subscribed to on its own.

## The manifest

```js
sales: {
  tier: 'addon', version: '1.0.0',
  requires: ['core.catalog', 'core.brand', 'core.mail', 'core.fx'],  // core only
  uses:     ['money.cash', 'growth.coverage'],                        // optional
  provides: ['sales.buyers', 'sales.committedDemand'],
  emits:    ['sales.order.confirmed'],
  tables:   ['venia_agents', 'venia_agent_leads'],
  server:   ['stripe', 'mail'],  edge: ['agent-portal'],
  mcp:      ['list_buyers', 'get_buyer', 'list_orders'],
}
```

## The three rules

1. **A module writes only what it owns** — its `MODULES[id].keys`, its `ls`
   strings and its `tables`. Every STATE key has exactly one owner.
2. **A module reads another module only through what that module provides**,
   via `VeniaOS.get('<module>.<offer>')`, or through the core. Every `uses`
   needs a fallback, because the other module may be switched off.
3. **A module requires only the core.** Anything from another module is a
   `uses`, never a `requires`.

## The core

Account and brands, subscriptions, sync, the shell (nav, routing, Today's
frame), the Catalogue, the Brand kit, currency rates, the activity log, mail
and Google, photos and files, push, search, and the assistant host.
`CORE_SERVICES` in the app lists where each lives today.

## Growth shown as Press, Social and Brand (Build 682)

The `growth` module stays one module id with one `venia_module_data` row:
every key (`prPulls`, `mkPosts`, `brTone`, `brandDocs` …) is where it was, and
nothing is moved or renamed. What changed is how it reads:

- **Press** (today's PR, space `pr`) and **Social** (today's Marketing, space
  `mk`; Social Command is its home, with the Writer and the Launch Machine) are
  add-ons. Each has its own top-bar button and Home tile; Press also has the
  phone tab. Each has an optional sub-switch in `venia_entitlements`,
  `growth-press` and `growth-social`, read like `pattern-cad`: a part is off
  only when its row says so (`window.VENIA_ENTITLED['growth-social'] === false`),
  and missing or unknown means on. Both are also off when `growth` is off.
  `veniaGrowthPartOn('press' | 'social')` answers, and `veniaApplyAccess()`
  sets `html.no-press` / `html.no-social`, which hide `[data-space="press"]` /
  `[data-space="social"]`.
- **Brand** (space `br`) is a core page every brand has: voice, the tone
  library, the brand library (Brand → Library lists every document), competitor
  watch and brand settings. It is always shown, whatever Growth's switches say.
  Its data still rides in the growth row for now (`core.brand.*` offers read it),
  and moves into core storage in a later stage.

`MODULE_MANIFEST.growth.parts` describes the three; Settings → Modules lists
Brand with the core and Press and Social as two add-on rows. A person's grant
is still the one `growth` grant (Team & Access shows it as "Press & Social").
Old routes are unchanged: `cpGoto('pr' | 'mk' | 'br')`, `agNav('pr', …)` and
saved routes all open the same screens.

## Modules that run in their own frame

A module may ship as its own app under `modules/<id>/` with a `module.json`
using the same fields, hosted by the shell in a frame (Boards does this). The
shell and the frame talk only by `postMessage` with `source: 'venia-module'`.
Its tables carry `workspace_id` (the brand) and check access through one SQL
helper, so they can follow the core's per-brand rules.

### Pattern CAD, shown as Dr4ft (Build 634; renamed Build 635)

Since Build 635 VENIA OS shows this module as **Dr4ft** everywhere a person sees it (top bar, phone menu, Go to, Settings → Modules, page titles, sign-in messages). Its ids are unchanged (`pattern-cad`, `patterncad`, `/pattern-cad`, the `pattern-cad` switch and function), so nothing stored moves. `/dr4ft` opens it too.


Pattern CAD is its own add-on module, an app in its own frame
(`modules/pattern-cad`). Because it keeps no STATE keys it is listed in
`VENIA_APP_MODULES`, not `MODULES`, so it never gets a `venia_module_data` row.
It has its own brand switch, `pattern-cad` in `venia_entitlements`, and does
not need Product; it reads Product's styles only while Product is on. Its code
lives in its own private repository, `keeterly/venia-pattern-cad`, and never in
this one: the `pattern-cad` function serves it, at the commit pinned by
`modules/pattern-cad/scripts/sync.mjs`, only to a signed-in person allowed it.
Handing patterns to Tech Pack waits on the shared hand-off contract.

## Reaching another module: `VeniaOS`

```js
VeniaOS.get('sales.buyers')        // the same array as STATE.slBuyers while Sales is on; [] when it is off
VeniaOS.get('core.catalog')        // the line: always on
VeniaOS.enabled('money')           // is Money on for this brand and this person?
VeniaOS.emit('growth.coverage.logged', { id })
VeniaOS.on('growth.coverage.logged', 'sales', fn)       // runs only while Sales is on
VeniaOS.contribute('today.cards', 'sales', () => cards)  // VeniaOS.collect('today.cards')
```

Offers are listed in `VENIA_OFFERS`. While the owning module is on, an offer
is the very same object as the STATE key, so reading through it changes
nothing. Only reads go through offers: a module still never writes another
module's keys, and the check counts any direct use that is left.

## Sending work to another module: `VeniaHandoff` (Build 658)

Reading another module's data goes through `VeniaOS.get`. Sending it work goes
through the handoff layer, `VeniaHandoff` (also `VeniaOS.handoff`):

- **Addresses.** Any record can be named `venia://<kind>/<id>`, with an
  optional `#part` for where it lands (`venia://style/STY1#techpack`).
  `VENIA_KINDS` says which module owns each kind. `VeniaHandoff.cardFor(addr)`
  gives a small card for it (title, picture, Open) when its module is on.
- **Accept lists.** A module says what it takes and where:
  `VeniaHandoff.accept({ module, kind, into, label, deliver(pkg) })`.
  `VeniaHandoff.targets(kind)` lists where a record can go right now, only
  modules that are on, so Send to menus build themselves.
- **Sending.** `VeniaHandoff.send({ from, kind, address, version, title,
  snapshot, into })` checks both ends are on, writes a row to
  `venia_handoffs` (a link, the version and a copy of what was sent), then
  hands it to the receiver's `deliver`. A receiver shows it as waiting; it
  never overwrites anything without a person tapping. The receiver calls
  `VeniaHandoff.decide(id, 'accepted' | 'declined')`.
- **The queue.** `venia_handoffs` is additive and append-only: rows are never
  removed, and after sending only the decision can change (a trigger enforces
  it). `VeniaHandoff.collect(module)` picks up handoffs sent from another
  device or a framed module.

The first handoffs (the full Dr4ft contract is in [handoffs-dr4ft.md](handoffs-dr4ft.md)):

| From | Kind | Into | How |
|---|---|---|---|
| Dr4ft | pattern | a style's tech pack | the frame calls `window.veniaHandoff.send(...)` from `modules/pattern-cad/src/host.js`; the Pattern Card shows "Version N came in from Dr4ft" with Bring in, Not now and Put back |
| Sales | line sheet | Boards | Edit in Boards: each page becomes an A4 landscape slide with the sheet's grid; linked cards keep prices, colours and sizes in step with Product; Present or Save as PDF gives the finished sheet |
| Product | style, photo, material | Boards | Send to Board (Build 650), Add from VENIA (Build 657) |

## Brands and subscriptions

Every brand is a row in `venia_tenants`; VENIA is `main`, the same id the
cloud rows already carry in `workspace_id`. `venia_tenant_members` says who
belongs to a brand (owner, admin, member) and `venia_entitlements` says which
add-ons it has (`on`, `trial` until a date, `paused`, `off`).

- In the app, `window.VENIA_ENTITLED` holds the brand's switches after sign-in.
  A module is off only when its row says so; unknown, missing or failed means on.
- An off module is hidden from the nav, its offers return empty, and its cloud
  row is never written, so its data is kept for when it comes back on.
- In the database, `venia_can(brand, module, 'read' | 'write')` answers for
  every table. Existing policies move onto it when a second brand is close.
- Settings → Modules shows what the brand has. It is read-only for VENIA.

## The check

`node scripts/check-modules.mjs` fails when a STATE key has two owners, a
module has no manifest, a module requires another module, or a module reads
another module's data directly in more places than `scripts/module-baseline.json`
allows. The baseline only goes down: when reads move behind `VeniaOS.get()`,
run `node scripts/check-modules.mjs --update` and commit the lower numbers.
`--report` lists every remaining cross-read with its line.
