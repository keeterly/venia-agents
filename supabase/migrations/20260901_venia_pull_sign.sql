-- VENIA OS — remote signing for press pulls (Build 427)
--
-- The signature pad only ever worked on the founder's own device: the stylist
-- had to be standing there holding the phone. For a pull going to someone who
-- is not in the room, that meant no signed release at all — on exactly the
-- loans where the paperwork matters most.
--
-- THE ROW CARRIES ITS OWN COPY OF EVERYTHING, deliberately.
--
-- The signing page is opened by a stranger with no login. It must therefore be
-- able to render without ever touching the workspace — so the terms, the item
-- list, the retail value and the return date are FROZEN into `snapshot` when
-- the link is minted. Two things follow, both of them the point:
--
--   1. There is no query a stylist's browser could make that reaches anything
--      but this one pull. Not "filtered client-side" — genuinely absent.
--   2. What they signed is what they saw. A later edit to the pull cannot
--      rewrite the agreement retroactively, which is the same guarantee the
--      in-person signature already gave by freezing prTermsLines().
--
-- The signature itself is written by the edge function, never the browser: the
-- timestamp, IP and user agent are what make this a record rather than a
-- drawing, and a value the client supplies is a value the client can invent.

create table if not exists public.venia_pull_sign (
  token        text primary key,
  pull_id      text not null,
  workspace_id text not null default 'main',
  -- What the signer sees, frozen at mint time. Never read back into the app.
  snapshot     jsonb not null,
  -- {name, image, at, ip, ua} — stamped server-side on signing.
  signature    jsonb,
  -- A signing link that lives forever is a link anyone it was forwarded to can
  -- sign with. Short by default, and dead the moment it is used.
  expires_at   timestamptz not null,
  signed_at    timestamptz,
  revoked      boolean not null default false,
  created_at   timestamptz not null default now(),
  created_by   text
);

create index if not exists venia_pull_sign_pull on public.venia_pull_sign (pull_id);

alter table public.venia_pull_sign enable row level security;

-- Founders manage links from the app. EVERYONE ELSE — including the person the
-- link was sent to — reaches this table only through the `pull-sign` edge
-- function, which holds the service role and answers for exactly one token.
-- There is deliberately no anon policy: a public SELECT here, however narrow,
-- would be a table a stranger could enumerate.
drop policy if exists venia_pull_sign_founder on public.venia_pull_sign;
create policy venia_pull_sign_founder on public.venia_pull_sign
  for all to authenticated
  using (public.venia_is_founder())
  with check (public.venia_is_founder());
