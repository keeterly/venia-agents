-- ══════════════════════════════════════════════════════════════════════════
--  INSTAGRAM CONNECTION — where the token lives, and who can read it
-- ══════════════════════════════════════════════════════════════════════════
-- A long-lived Instagram token can read the account's media and, with a wider
-- scope, publish to it. It is a credential, not workspace data, so it must not
-- live anywhere the browser can reach: not in STATE, not in localStorage, and
-- not in venia_module_data, which syncs to every device that can read Growth.
--
-- THIS TABLE HAS RLS ENABLED AND NO POLICIES AT ALL. That is deliberate and is
-- the whole security model: with RLS on and no policy, PostgREST returns
-- nothing to anon and nothing to authenticated — a founder's own session
-- included. Only the service role, which exists solely inside an edge function,
-- can see a row. There is no query a compromised page could make that returns
-- this token, because there is no policy that would let one through.
--
-- One brand, one account, so one row. id is a fixed key rather than a sequence:
-- a second row would be a second Instagram account nobody asked for.
create table if not exists public.venia_instagram (
  id            text primary key default 'venia',
  ig_user_id    text,
  username      text,
  account_type  text,
  access_token  text not null,
  -- When the long-lived token dies. Meta issues 60 days and lets it be
  -- refreshed while still valid; a token left past this is simply gone, and the
  -- founder has to reconnect. Storing the date is what lets the app say so
  -- BEFORE it stops working rather than after.
  expires_at    timestamptz,
  connected_at  timestamptz not null default now(),
  connected_by  text,
  last_sync_at  timestamptz,
  -- The last thing Instagram said when it refused. Kept so the screen can show
  -- the real reason instead of "could not connect".
  last_error    text,
  updated_at    timestamptz not null default now()
);
alter table public.venia_instagram enable row level security;
-- No policies. See above — this is the point, not an omission.

-- ── OAUTH STATE ───────────────────────────────────────────────────────────
-- The state parameter is what stops someone else's authorization code being
-- redeemed through this app. It is minted here, checked once on the way back,
-- and deleted whether or not it matched — a state that can be replayed is not
-- CSRF protection, it is a longer window.
create table if not exists public.venia_instagram_oauth (
  state       text primary key,
  created_at  timestamptz not null default now(),
  created_by  text
);
alter table public.venia_instagram_oauth enable row level security;
-- No policies here either: only the edge function ever touches it.

-- Housekeeping: an abandoned authorization leaves a row behind. Ten minutes is
-- longer than anyone takes to tap Allow, and far shorter than a useful attack.
create index if not exists venia_instagram_oauth_created_idx
  on public.venia_instagram_oauth (created_at);

-- The connection is a fact about the workspace, so its EXISTENCE is readable —
-- but only ever through the edge function, which returns the username and the
-- expiry and never the token. Nothing else is exposed. This view is not that
-- door; it is here so a founder querying the database directly can see whether
-- an account is attached without the token coming back with it.
create or replace view public.venia_instagram_status
  with (security_invoker = true) as
  select id, ig_user_id, username, account_type, expires_at,
         connected_at, connected_by, last_sync_at, last_error
    from public.venia_instagram;
