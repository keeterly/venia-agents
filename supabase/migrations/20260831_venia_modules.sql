-- VENIA OS — per-module storage and per-person access (Build 416)
--
-- The workspace has been ONE jsonb blob in venia_workspace, readable only by
-- the two founders. RLS is per-row, so access was all-or-nothing: you could not
-- give someone Sales without also giving them cost, margin and factory terms.
-- That is why the sales-agent portal had to be built as a separate surface
-- rather than a permission.
--
-- This adds the two tables that make access a permission:
--   venia_members      — who can reach which module, and in what role
--   venia_module_data  — the workspace, one row per module
--
-- ADDITIVE ONLY. venia_workspace is untouched and keeps being written as a
-- mirror for one build, so there is a rollback that costs nothing.

-- ── who may reach what ─────────────────────────────────────────────────────
create table if not exists public.venia_members (
  email      text not null,
  module     text not null,
  role       text not null default 'editor' check (role in ('owner','editor','viewer')),
  created_at timestamptz not null default now(),
  created_by text,
  primary key (email, module)
);

-- ── the workspace, split ───────────────────────────────────────────────────
create table if not exists public.venia_module_data (
  workspace_id text not null default 'main',
  module       text not null,
  data         jsonb not null default '{}'::jsonb,
  updated_by   text,
  updated_at   timestamptz not null default now(),
  rev          bigint not null default 0,
  primary key (workspace_id, module)
);

alter table public.venia_members     enable row level security;
alter table public.venia_module_data enable row level security;

-- ── the two questions every policy asks ────────────────────────────────────
-- SECURITY DEFINER so the membership lookup is not itself subject to RLS —
-- without it the policy on venia_module_data would recurse into the policy on
-- venia_members and deny everything.
-- search_path = '' so a schema on the caller's path can never shadow a name
-- used inside a definer function.
create or replace function public.venia_is_founder()
  returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(
    (auth.jwt() ->> 'email') = any (array[
      'keeter@veniacollection.com',
      'christine@veniacollection.com'
    ]), false)
$$;

create or replace function public.venia_module_role(m text)
  returns text language sql stable security definer set search_path = '' as $$
  select r.role from public.venia_members r
   where r.email = (auth.jwt() ->> 'email') and r.module = m
   limit 1
$$;

revoke all on function public.venia_is_founder() from public, anon;
revoke all on function public.venia_module_role(text) from public, anon;
grant execute on function public.venia_is_founder() to authenticated;
grant execute on function public.venia_module_role(text) to authenticated;

-- ── module data ────────────────────────────────────────────────────────────
-- A founder sees everything. Anyone else sees exactly the modules they are a
-- member of, and writes only the ones where they are owner or editor. A viewer
-- can read Sales without being able to change it; nobody can read a module they
-- were never given, because the row simply is not returned.
drop policy if exists venia_module_data_read  on public.venia_module_data;
drop policy if exists venia_module_data_write on public.venia_module_data;
drop policy if exists venia_module_data_edit  on public.venia_module_data;

create policy venia_module_data_read on public.venia_module_data
  for select to authenticated
  using (public.venia_is_founder() or public.venia_module_role(module) is not null);

create policy venia_module_data_write on public.venia_module_data
  for insert to authenticated
  with check (public.venia_is_founder() or public.venia_module_role(module) in ('owner','editor'));

create policy venia_module_data_edit on public.venia_module_data
  for update to authenticated
  using      (public.venia_is_founder() or public.venia_module_role(module) in ('owner','editor'))
  with check (public.venia_is_founder() or public.venia_module_role(module) in ('owner','editor'));
-- No delete policy: a module row is never dropped, only emptied. Deleting one
-- would look identical to "this workspace has no Sales data yet".

-- ── membership ─────────────────────────────────────────────────────────────
-- You can see your own grants (so the app can hide what you cannot reach).
-- Only a founder can grant or revoke — a member cannot widen their own access.
drop policy if exists venia_members_read_self on public.venia_members;
drop policy if exists venia_members_admin     on public.venia_members;

create policy venia_members_read_self on public.venia_members
  for select to authenticated
  using (public.venia_is_founder() or email = (auth.jwt() ->> 'email'));

create policy venia_members_admin on public.venia_members
  for all to authenticated
  using (public.venia_is_founder())
  with check (public.venia_is_founder());

-- ── the founders own every module ──────────────────────────────────────────
insert into public.venia_members (email, module, role, created_by)
select e, m, 'owner', 'migration-20260831'
from unnest(array['keeter@veniacollection.com','christine@veniacollection.com']) e
-- 'legacy' is in the list because the founders must hold it; it is deliberately
-- never granted to anyone else (see the MODULES registry for why).
cross join unnest(array['home','product','growth','sales','money','brainstorm','settings','legacy']) m
on conflict (email, module) do nothing;
