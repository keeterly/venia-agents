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
| growth | add-on | press pulls, coverage, marketing, brand |
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

## Modules that run in their own frame

A module may ship as its own app under `modules/<id>/` with a `module.json`
using the same fields, hosted by the shell in a frame (Boards does this). The
shell and the frame talk only by `postMessage` with `source: 'venia-module'`.
Its tables carry `workspace_id` (the brand) and check access through one SQL
helper, so they can follow the core's per-brand rules.

### Pattern CAD (Build 634)

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
