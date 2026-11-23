# Dr4ft (pattern CAD) module

Shown in VENIA OS as **Dr4ft** (Build 635). Internally it is still `pattern-cad` / `patterncad` (paths, switch, function), so nothing stored changes.

VENIA's pattern drafting CAD, its own module in VENIA OS (top bar on desktop,
Spaces in the phone menu), hosted at `/pattern-cad`. The CAD is built in its own private repository,
`keeterly/venia-pattern-cad`, which is the only source of truth.

**No CAD code is committed here** (this repository is public). Instead:

- `netlify/functions/pattern-cad.js` reads the CAD's own build
  (`dist/index.html`) from GitHub at the pinned commit, checks it against the
  pinned hash, and serves its styles and script only to a signed-in person
  allowed it (a founder, a `pattern-cad` grant, or for now anyone who can read
  Product), with Pattern CAD switched on (`venia_entitlements` module
  `pattern-cad`; no row means on). It does not need Product.
- `src/host.js` (copied to `dist/host.js`) is the frame page's loader: it
  fetches the CAD with the person's session, keeps the CAD's styles in
  IndexedDB rather than the site's localStorage, and answers the CAD's
  read-only style lookups through the shell. See the comments in it.
- `SOURCE.json` and `netlify/functions/_shared/pattern-cad-pin.js` say which
  commit is live.

## Setup (once)

The Netlify site needs `PATTERN_CAD_GITHUB_TOKEN`: a fine-grained GitHub
token with read-only **Contents** access to `keeterly/venia-pattern-cad` and
nothing else. Until it is set, Pattern CAD says it isn't connected yet.

## Moving VENIA OS to a newer CAD

```
git -C ../venia-pattern-cad pull
node modules/pattern-cad/scripts/sync.mjs ../venia-pattern-cad
```

Then commit and bump the build number as usual. The script refuses a checkout
whose `dist/` has uncommitted changes, or a commit not yet on GitHub.

## The pattern library (Build 683)

VENIA OS keeps Dr4ft's library, not the browser. Opening Dr4ft shows **Patterns**: a Continue card for
the last pattern you had open (it reopens at the view, size and zoom you left), patterns grouped by
season and style, patterns with no style, house blocks, and Trash. **New pattern** asks for the style,
name, season, base size, sizes and an optional house block, writes the library row, then has Dr4ft
start it. The style page and the tech pack's Pattern Card list each style's patterns with Open and
New pattern.

- Tables: `venia_patterns` (one row per pattern per brand: name, style, season, sizes, the latest
  pattern JSON in `doc`, a small SVG `thumb`, `rev`, `trashed_at`) and `venia_pattern_recent` (where
  each person left off in each pattern; own rows only). Access: Dr4ft's grant or Product's, and never
  while Dr4ft is switched off. Migration `supabase/migrations/20261120_venia_patterns.sql`, additive.
- Saves go through `venia_pattern_save(id, rev, patch)`. A save that started from an older `rev`
  (someone saved the same pattern on another computer) is kept as a new pattern, "(copy from this
  computer)", and Dr4ft switches to it. Nothing is overwritten.
- Patterns kept in a browser are offered once a library opens there: **Copy N in** copies them; the
  browser keeps its own. "Not now" asks again after two weeks.
- Nothing is deleted: Trash sets `trashed_at`, Restore clears it. There is no delete policy.
- How it talks to Dr4ft: `src/host.js` registers VENIA OS as Dr4ft's library host once Dr4ft starts
  (only if the library answered; otherwise Dr4ft works on its own as before) and passes Dr4ft's
  events to the shell as `pattern-cad:dr4ft-event`. The shell calls Dr4ft's commands through the
  frame's `window.dr4ft.command` (same origin). The contract is keeterly/venia-pattern-cad
  `docs/venia-os-contract.md`, version 2. Send to a tech pack stays off until Dr4ft switches it on.

## Sourcing fabrics and the BOM (Build 735)

Dr4ft's marker lists the Sourcing fabrics first ("From VENIA OS Sourcing"), each with a usable width
read from the width typed in Sourcing (a range like `52" / 53"` uses the narrower, and the marker
says so). The typed width is never changed.

- **Save this width to VENIA OS Sourcing** keeps the marker's width, selvage, shrinkage, stretch and
  nap on the material as `cutting`, with the one before it as `cutting.previous`. Only an empty width
  text is filled. Sourcing shows it as "Cut width (Dr4ft)".
- A marker cut in a Sourcing fabric, on a pattern linked to a style, sends its yield per garment after
  each Auto nest (and on **Send yield to the BOM**). It fills that fabric's BOM line when the line is
  empty or still holds the last yield from Dr4ft, adds the line if the style has none, and keeps a
  Pattern Card line's yield in step. A quantity typed by hand changes only when **Replace** is
  pressed in Dr4ft; the old quantity is kept on the line (`_fromDr4ft.replaced`).

## TUKAcad files (Build 736)

Dr4ft reads a TUKAcad DXF export the way Tuka shows it. A piece with a mirror line (fold) opens
whole, with the fold line drawn, and lays whole in markers. A piece marked "DO NOT CUT" or
"TEMPLATE" stays out of markers. Notches written as points come in once each, a smooth curve runs
through Tuka's curve points, and each allowance corner is cut as the file cuts it. Importing the same
file again can replace the pieces with the same names in place; the style is saved as a version first
and markers keep the pieces. Patterns imported before are not changed.

Build 737: Output › Print and plot can print every piece, cut pieces only, or templates only (the
do-not-cut pieces), on the tiled PDF, the 60" plot, the wide PDF and SVG.

Build 738: a marker can be deleted (Delete beside +, undoable), and the marker panel and Check list
any piece cut from fabric that no marker cuts, per material, with a button to add it or make a
marker for that material.
