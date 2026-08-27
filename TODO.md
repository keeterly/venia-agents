# VENIA Control Center — Open Decisions & Setup Notes

## ⚠️ TODO: Bank feed setup (Money → Bank, Build 301) — one-time
The CFO agent's expenses/burn/runway come from a live read-only bank feed via
Stripe Financial Connections (`netlify/functions/bank.js`, same Stripe account
that sends invoices). To activate:
1. Netlify env var `STRIPE_PUBLISHABLE_KEY` (pk_…) — the browser needs it for
   Stripe's bank-auth modal. (`STRIPE_SECRET_KEY` is already set.)
2. Netlify env var `VENIA_GATE_HASH` (or reuse `STRIPE_GATE_HASH`) — every bank
   action fails closed without the access-code gate.
3. Stripe Dashboard → Settings → Financial Connections: complete the
   registration. Live-mode **transactions** require it; test mode works now.
Then Money → Bank → "Connect bank" on either phone. Accounts subscribe to
daily transaction refreshes; data syncs to the shared workspace like all other
records (`finBank` / `finTxns` in SYNC_KEYS).

## ⚠️ TODO: Connect Supabase (database) — NOT YET DONE
The app talks to Supabase directly from the browser (anon key). A separate
Supabase project (kept apart from the QWST app) still needs to be created and wired in.

When ready:
- Create a new Supabase project (suggested name `venia-plm`).
- Put its **Project URL** + **anon public key** into the app (Settings → Integrations →
  Supabase), or update the pre-configured default in `venia-control-panel-v1.html`
  (search `Pre-configure VENIA CC project on first load`).
- Run the in-app setup SQL once (Settings → Supabase → "run the setup SQL") to create
  `venia_styles / venia_materials / venia_vendors / venia_bom / venia_pom`.
- **Security:** tighten the RLS policies — the default setup SQL uses
  `USING (true)` (anyone with the URL + anon key can read/write all PLM data).
  Prefer Supabase Auth, and if hosting on Netlify, proxy writes through a function
  so the anon key isn't public in page source.

## ⚠️ DECISION PENDING: Host on GitHub Pages vs Netlify
Both are static hosts; the Supabase browser connection is identical on either.
- **GitHub Pages** — simplest, free, auto-deploys on push. Pure static (no secrets/functions).
- **Netlify** — adds serverless/edge functions, env vars, previews. Lets us hide the
  Anthropic/Shopify keys behind a function (currently those live in the browser).
- Current state: Netlify site `venia-creator` created; repo is Netlify-ready (`netlify.toml`).
  GitHub `CNAME` was removed. Custom domain target: `creator.veniacollection.com`.
- Recommendation leaning Netlify for the server-side headroom — confirm before finalizing DNS.

## In progress
- PWA enablement (manifest, service worker, iOS meta, safe-area) for iPhone home-screen use.
- Desktop + mobile UI refinement pass.
