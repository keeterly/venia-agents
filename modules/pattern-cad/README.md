# Pattern CAD module

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
