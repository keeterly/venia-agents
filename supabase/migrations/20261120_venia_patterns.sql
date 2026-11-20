-- VENIA OS — Dr4ft's pattern library (Build 683)
--
-- Until now every Dr4ft pattern lived only in the browser that drew it
-- (IndexedDB). VENIA OS now keeps the library: one row per pattern, per brand,
-- so a pattern opens on any computer, sits under its style and season, and
-- the person carries on where they left off. Dr4ft itself is unchanged: it
-- opens what it is handed and reports each save (modules/pattern-cad,
-- keeterly/venia-pattern-cad docs/venia-os-contract.md).
--
-- ADDITIVE ONLY. Two new tables and their policies, each created only if it
-- is missing. Nothing existing is altered, and there is no delete policy:
-- a pattern goes to Trash (trashed_at) rather than away. Patterns kept in a
-- browser are copied in, never moved, so the browser copy stays as a backup.

create table if not exists public.venia_patterns (
  id            text primary key,                 -- the library id Dr4ft is handed ('pat_…')
  workspace_id  text not null default 'main',     -- the brand (tenant)
  name          text not null default 'Untitled pattern',
  kind          text not null default 'style',    -- 'style' | 'block' (a house block)
  style_id      text,                             -- the VENIA OS style it belongs to, if any
  style_code    text,
  style_name    text,
  season        text,
  base_size     text,
  sizes         jsonb not null default '[]'::jsonb,
  piece_count   integer not null default 0,
  release       jsonb,                            -- { rev, state } as Dr4ft reports it
  doc           jsonb,                            -- the latest saved pattern (Dr4ft's own JSON)
  thumb         text,                             -- small SVG of the cut lines, for the card
  source        text not null default 'new',      -- 'new' | 'browser' (copied in from a browser)
  rev           bigint not null default 0,        -- bumped on every save; a stale save never overwrites
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_by    text,
  updated_at    timestamptz not null default now(),
  trashed_at    timestamptz
);
create index if not exists venia_patterns_ws_idx    on public.venia_patterns (workspace_id, updated_at desc);
create index if not exists venia_patterns_style_idx on public.venia_patterns (workspace_id, style_id);

-- Where each person left off in each pattern: the view Dr4ft reports
-- (draft / nest / marker, size, zoom, centre). The newest row is the
-- Continue card. Each person sees and writes only their own rows.
create table if not exists public.venia_pattern_recent (
  workspace_id  text not null default 'main',
  email         text not null,
  pattern_id    text not null references public.venia_patterns(id),
  view          jsonb,
  opened_at     timestamptz not null default now(),
  primary key (workspace_id, email, pattern_id)
);
create index if not exists venia_pattern_recent_me_idx on public.venia_pattern_recent (workspace_id, email, opened_at desc);

-- One access question: Dr4ft's own grant or Product's (who drafts patterns
-- today), and never while the brand has Dr4ft switched off.
create or replace function public.venia_patterns_can(ws text, mode text)
  returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(public.venia_entitled(ws, 'pattern-cad'), true)
     and (public.venia_can(ws, 'pattern-cad', mode) or public.venia_can(ws, 'product', mode))
$$;
revoke all on function public.venia_patterns_can(text, text) from public, anon;
grant execute on function public.venia_patterns_can(text, text) to authenticated;

alter table public.venia_patterns       enable row level security;
alter table public.venia_pattern_recent enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'venia_patterns' and policyname = 'venia_patterns_read') then
    create policy venia_patterns_read on public.venia_patterns for select to authenticated
      using (public.venia_patterns_can(workspace_id, 'read'));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'venia_patterns' and policyname = 'venia_patterns_add') then
    create policy venia_patterns_add on public.venia_patterns for insert to authenticated
      with check (public.venia_patterns_can(workspace_id, 'write'));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'venia_patterns' and policyname = 'venia_patterns_edit') then
    create policy venia_patterns_edit on public.venia_patterns for update to authenticated
      using (public.venia_patterns_can(workspace_id, 'write'))
      with check (public.venia_patterns_can(workspace_id, 'write'));
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'venia_pattern_recent' and policyname = 'venia_pattern_recent_own') then
    create policy venia_pattern_recent_own on public.venia_pattern_recent for select to authenticated
      using (email = lower(coalesce(auth.jwt() ->> 'email', '')));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'venia_pattern_recent' and policyname = 'venia_pattern_recent_add') then
    create policy venia_pattern_recent_add on public.venia_pattern_recent for insert to authenticated
      with check (email = lower(coalesce(auth.jwt() ->> 'email', '')) and public.venia_patterns_can(workspace_id, 'read'));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'venia_pattern_recent' and policyname = 'venia_pattern_recent_set') then
    create policy venia_pattern_recent_set on public.venia_pattern_recent for update to authenticated
      using (email = lower(coalesce(auth.jwt() ->> 'email', '')))
      with check (email = lower(coalesce(auth.jwt() ->> 'email', '')));
  end if;
end $$;

-- A save names the rev it started from; a stale one is refused, and the app
-- keeps that work as a copy instead of overwriting someone else's save.
create or replace function public.venia_pattern_save(p_id text, p_rev bigint, p_patch jsonb)
  returns bigint language plpgsql security invoker set search_path = '' as $$
declare r bigint;
begin
  update public.venia_patterns set
    name        = coalesce(p_patch ->> 'name', name),
    style_id    = case when p_patch ? 'style_id'   then p_patch ->> 'style_id'   else style_id end,
    style_code  = case when p_patch ? 'style_code' then p_patch ->> 'style_code' else style_code end,
    style_name  = case when p_patch ? 'style_name' then p_patch ->> 'style_name' else style_name end,
    season      = case when p_patch ? 'season'     then p_patch ->> 'season'     else season end,
    base_size   = coalesce(p_patch ->> 'base_size', base_size),
    sizes       = coalesce(p_patch -> 'sizes', sizes),
    piece_count = coalesce((p_patch ->> 'piece_count')::int, piece_count),
    release     = case when p_patch ? 'release' then p_patch -> 'release' else release end,
    doc         = coalesce(p_patch -> 'doc', doc),
    thumb       = coalesce(p_patch ->> 'thumb', thumb),
    rev         = rev + 1,
    updated_by  = lower(coalesce(auth.jwt() ->> 'email', '')),
    updated_at  = now()
  where id = p_id and rev = p_rev
  returning rev into r;
  return r;   -- null: someone saved a newer version first
end $$;
revoke all on function public.venia_pattern_save(text, bigint, jsonb) from public, anon;
grant execute on function public.venia_pattern_save(text, bigint, jsonb) to authenticated;
