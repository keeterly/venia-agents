-- VENIA OS — the catalogue projection (Build 424)
--
-- Modules made access a permission, but they also made Sales useless on its
-- own: a line sheet, a quote and a wholesale order are all built out of
-- `styles`, and `styles` is owned by Product. A Sales-only member would never
-- receive the styles row, so they would sign in to an empty app. The only fix
-- available was to grant them Product as well — which hands over COGS, margin
-- targets, BOM, POM, vendors and factory terms to build a price list.
--
-- So the line now travels separately, as a COST-STRIPPED PROJECTION written
-- into venia_module_data under module = 'catalog': style name, code, category,
-- season, fabric, composition, country of origin, colours, sizes, MOQ, drop,
-- photo, status, wholesale and retail. It is the same allowlist the freelance
-- sales-agent portal already publishes to people outside the company.
--
-- 'catalog' is NOT a grantable module. It never appears in the team screen and
-- the `team` function's allowlist does not contain it. It is implied by having
-- any access at all, and it is written only by whoever can write Product.

-- Do you have any access to this workspace? (Distinct from venia_module_role,
-- which asks about one module.) SECURITY DEFINER for the same reason as its
-- siblings: the lookup must not recurse into the policy it is used by.
create or replace function public.venia_has_access()
  returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.venia_members r where r.email = (auth.jwt() ->> 'email')
  )
$$;
revoke all on function public.venia_has_access() from public, anon;
grant execute on function public.venia_has_access() to authenticated;

-- Which module's membership decides a row. For every real module that is the
-- module itself; the catalogue is decided by Product, because that is where it
-- is derived from and nobody else should be able to publish the line that
-- Sales will quote from.
create or replace function public.venia_module_owner(m text)
  returns text language sql immutable set search_path = '' as $$
  select case when m = 'catalog' then 'product' else m end
$$;
revoke all on function public.venia_module_owner(text) from public, anon;
grant execute on function public.venia_module_owner(text) to authenticated;

-- ── read ───────────────────────────────────────────────────────────────────
drop policy if exists venia_module_data_read on public.venia_module_data;
create policy venia_module_data_read on public.venia_module_data
  for select to authenticated
  using (
    public.venia_is_founder()
    or public.venia_module_role(module) is not null
    -- Anyone with any access at all reads the catalogue. Nothing in it says
    -- what a piece cost to make, and without it Sales has nothing to sell.
    or (module = 'catalog' and public.venia_has_access())
  );

-- ── write ──────────────────────────────────────────────────────────────────
drop policy if exists venia_module_data_write on public.venia_module_data;
create policy venia_module_data_write on public.venia_module_data
  for insert to authenticated
  with check (
    public.venia_is_founder()
    or public.venia_module_role(public.venia_module_owner(module)) in ('owner','editor')
  );

drop policy if exists venia_module_data_edit on public.venia_module_data;
create policy venia_module_data_edit on public.venia_module_data
  for update to authenticated
  using (
    public.venia_is_founder()
    or public.venia_module_role(public.venia_module_owner(module)) in ('owner','editor')
  )
  with check (
    public.venia_is_founder()
    or public.venia_module_role(public.venia_module_owner(module)) in ('owner','editor')
  );
