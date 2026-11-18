-- VENIA OS — brands and subscriptions (Build 611, Stage 3 of the module plan)
--
-- VENIA OS is becoming a core plus modules that a brand subscribes to à la
-- carte. This adds the three tables that say WHICH BRAND a person works in and
-- WHICH MODULES that brand has switched on, and one function every policy can
-- ask: venia_can(brand, module, 'read' | 'write').
--
-- ADDITIVE ONLY. No existing table, column, row, policy or function is
-- changed or dropped. VENIA is brand 'main' (the workspace_id venia_module_data
-- already uses) with every module on, so nothing anyone sees changes. The
-- existing policies keep using venia_is_founder() and venia_module_role();
-- they move onto venia_can() only when a second brand is close (Stage 6).
-- Backup taken first: schema venia_backup, tables *__20261118.

-- ── brands ──────────────────────────────────────────────────────────────────
create table if not exists public.venia_tenants (
  id          text primary key check (id ~ '^[a-z0-9][a-z0-9_-]{1,40}$'),
  name        text not null,
  owner_email text,
  status      text not null default 'active' check (status in ('active', 'paused', 'closed')),
  created_at  timestamptz not null default now()
);

-- ── who belongs to a brand ──────────────────────────────────────────────────
-- owner / admin run the brand (grant modules, see subscriptions); member works
-- in whichever modules venia_members grants them.
create table if not exists public.venia_tenant_members (
  tenant_id  text not null references public.venia_tenants(id),
  email      text not null,
  role       text not null default 'member' check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  created_by text,
  primary key (tenant_id, email)
);

-- ── which modules a brand has ───────────────────────────────────────────────
-- One row per brand per module. 'on' and 'trial' (until a date) count as on;
-- 'paused' and 'off' hide the module and its data while keeping the data.
-- source says who set it: by hand now, by billing later.
create table if not exists public.venia_entitlements (
  tenant_id  text not null references public.venia_tenants(id),
  module     text not null,
  status     text not null default 'on' check (status in ('on', 'trial', 'paused', 'off')),
  plan       text,
  until      date,
  source     text not null default 'manual' check (source in ('manual', 'billing')),
  updated_at timestamptz not null default now(),
  updated_by text,
  primary key (tenant_id, module)
);

alter table public.venia_tenants        enable row level security;
alter table public.venia_tenant_members enable row level security;
alter table public.venia_entitlements   enable row level security;

-- ── the questions every policy asks ─────────────────────────────────────────
-- SECURITY DEFINER with an empty search_path, like venia_module_role: the
-- lookups must not be subject to the RLS they are used to decide.
create or replace function public.venia_tenant_role(t text)
  returns text language sql stable security definer set search_path = '' as $$
  select m.role from public.venia_tenant_members m
   where m.tenant_id = t and lower(m.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
   limit 1
$$;

-- Is this module switched on for this brand? Core modules always are. A
-- module with NO row counts as on for now, so a module added to the app later
-- is never hidden from VENIA by a missing row; billing flips that default in
-- Stage 6, when a brand's rows are written by its subscription.
create or replace function public.venia_entitled(t text, m text)
  returns boolean language sql stable security definer set search_path = '' as $$
  select case
    when m in ('home', 'settings', 'catalog', 'legacy') then true
    else coalesce((
      select e.status in ('on', 'trial') and (e.until is null or e.until >= current_date)
        from public.venia_entitlements e
       where e.tenant_id = t and e.module = m
    ), true)
  end
$$;

-- May the signed-in person read or write this module in this brand?
-- VENIA's founders keep exactly the access they have today in 'main'.
-- Module grants (venia_members) are VENIA's until they gain a brand column.
create or replace function public.venia_can(t text, m text, action text)
  returns boolean language sql stable security definer set search_path = '' as $$
  select
    (t = 'main' and public.venia_is_founder())
    or (
      public.venia_entitled(t, m)
      and (
        public.venia_tenant_role(t) in ('owner', 'admin')
        or (t = 'main' and action = 'read'  and public.venia_module_role(m) is not null)
        or (t = 'main' and action = 'write' and public.venia_module_role(m) in ('owner', 'editor'))
      )
    )
$$;

revoke all on function public.venia_tenant_role(text)          from public, anon;
revoke all on function public.venia_entitled(text, text)        from public, anon;
revoke all on function public.venia_can(text, text, text)       from public, anon;
grant execute on function public.venia_tenant_role(text)        to authenticated;
grant execute on function public.venia_entitled(text, text)     to authenticated;
grant execute on function public.venia_can(text, text, text)    to authenticated;

-- ── policies on the new tables ──────────────────────────────────────────────
-- Read: anyone in the brand (or with a module grant in VENIA). Change: the
-- brand's owners and admins for members; subscriptions only by VENIA's
-- founders, who run the platform until billing does.
drop policy if exists venia_tenants_read on public.venia_tenants;
create policy venia_tenants_read on public.venia_tenants for select to authenticated
  using (public.venia_is_founder() or public.venia_tenant_role(id) is not null
         or (id = 'main' and public.venia_has_access()));
drop policy if exists venia_tenants_admin on public.venia_tenants;
create policy venia_tenants_admin on public.venia_tenants for update to authenticated
  using (public.venia_is_founder()) with check (public.venia_is_founder());
drop policy if exists venia_tenants_insert on public.venia_tenants;
create policy venia_tenants_insert on public.venia_tenants for insert to authenticated
  with check (public.venia_is_founder());

drop policy if exists venia_tenant_members_read on public.venia_tenant_members;
create policy venia_tenant_members_read on public.venia_tenant_members for select to authenticated
  using (public.venia_is_founder()
         or lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
         or public.venia_tenant_role(tenant_id) in ('owner', 'admin'));
drop policy if exists venia_tenant_members_admin on public.venia_tenant_members;
create policy venia_tenant_members_admin on public.venia_tenant_members for all to authenticated
  using (public.venia_is_founder() or public.venia_tenant_role(tenant_id) in ('owner', 'admin'))
  with check (public.venia_is_founder() or public.venia_tenant_role(tenant_id) in ('owner', 'admin'));

drop policy if exists venia_entitlements_read on public.venia_entitlements;
create policy venia_entitlements_read on public.venia_entitlements for select to authenticated
  using (public.venia_is_founder() or public.venia_tenant_role(tenant_id) is not null
         or (tenant_id = 'main' and public.venia_has_access()));
drop policy if exists venia_entitlements_admin on public.venia_entitlements;
create policy venia_entitlements_admin on public.venia_entitlements for insert to authenticated
  with check (public.venia_is_founder());
drop policy if exists venia_entitlements_edit on public.venia_entitlements;
create policy venia_entitlements_edit on public.venia_entitlements for update to authenticated
  using (public.venia_is_founder()) with check (public.venia_is_founder());

-- Start from nothing, as the inbox migration does: Supabase hands new tables
-- to authenticated with ALL, including DELETE and TRUNCATE (which ignores RLS).
-- No deletes through the API: a brand or a subscription is closed or switched
-- off, never erased.
revoke all on public.venia_tenants, public.venia_tenant_members, public.venia_entitlements from anon, public, authenticated;
grant select, insert, update on public.venia_tenants        to authenticated;
grant select, insert, update, delete on public.venia_tenant_members to authenticated;
grant select, insert, update on public.venia_entitlements   to authenticated;

-- ── VENIA: brand 'main', both founders as owners, every module on ───────────
insert into public.venia_tenants (id, name, owner_email)
values ('main', 'VENIA', 'keeter@veniacollection.com')
on conflict (id) do nothing;

insert into public.venia_tenant_members (tenant_id, email, role, created_by)
select 'main', e, 'owner', 'migration-20261118b'
from unnest(array['keeter@veniacollection.com', 'christine@veniacollection.com']) e
on conflict (tenant_id, email) do nothing;

insert into public.venia_entitlements (tenant_id, module, status, plan, updated_by)
select 'main', m, 'on', 'founder', 'migration-20261118b'
from unnest(array['product', 'growth', 'sales', 'money', 'brainstorm']) m
on conflict (tenant_id, module) do nothing;
