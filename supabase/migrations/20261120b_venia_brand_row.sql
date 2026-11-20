-- Build 691: Brand's own row in venia_module_data.
--
-- NOT APPLIED. Written for a founder to review and apply.
--
-- Brand is a core page (Build 682), but its data (brTone, brToneBackup,
-- brPrefs, brandDocs and the brand watch) rides in the 'growth' row, and RLS
-- returns that row only to people with a Growth grant. A teammate with
-- Product or Money therefore cannot see Brand, or file a brand doc.
--
-- This adds a 'brand' row that carries a COPY of those keys:
--   * readable by anyone who holds any grant in the workspace (Brand is core),
--   * writable by the founders (existing policies already allow that) and by
--     anyone who can write growth, product or money (they file brand docs).
-- The growth row is untouched and keeps being written with the same keys by
-- every device (Build 691 writes both rows), so devices on 690 and earlier
-- keep working, and anything that reads the growth row keeps reading it.
--
-- What the Brand row does NOT carry: the docs Money and Product file into the
-- Brand library (the weekly "Money brief — …", the CFO's "Financial plan — …",
-- season retros, and anything marked from: 'money' / 'product'). Those hold
-- cash, sales and margin figures, and the Brand row is readable by every
-- teammate. They stay in the growth row only. The app applies the same test
-- (brandRowPrivateDoc in venia-control-panel-v1.html).
--
-- ADDITIVE ONLY. No table, column, policy or function is dropped, altered or
-- replaced, and no existing row is updated or deleted. Every statement is
-- safe to run twice.
--
-- What the app does around this:
--   * Before this is applied: no 'brand' row exists, the app never writes one
--     (it writes the row only after a pull has seen it), and behaves as 690.
--   * After: the next pull sees the row, and from then on every push writes
--     the growth row (if this person may) and the brand row (if it changed).

-- ── 1. Read: anyone with any grant may read the 'brand' row ───────────────
-- A new permissive policy, OR'd with venia_module_data_read. Same shape as
-- the catalogue's clause (module = 'catalog' and venia_has_access()).
do $$
begin
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'venia_module_data'
                    and policyname = 'venia_module_data_brand_read') then
    create policy venia_module_data_brand_read on public.venia_module_data
      for select to authenticated
      using (workspace_id = 'main' and module = 'brand' and public.venia_has_access());
  end if;
end $$;

-- ── 2. Write: founders (already allowed), and growth/product/money writers ─
-- Two new permissive policies, OR'd with venia_module_data_write / _edit.
-- They reach the 'brand' row only; every other row keeps exactly its rules.
do $$
begin
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'venia_module_data'
                    and policyname = 'venia_module_data_brand_insert') then
    create policy venia_module_data_brand_insert on public.venia_module_data
      for insert to authenticated
      with check (workspace_id = 'main' and module = 'brand' and (
           public.venia_module_role('growth')  in ('owner', 'editor')
        or public.venia_module_role('product') in ('owner', 'editor')
        or public.venia_module_role('money')   in ('owner', 'editor')));
  end if;
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'venia_module_data'
                    and policyname = 'venia_module_data_brand_edit') then
    create policy venia_module_data_brand_edit on public.venia_module_data
      for update to authenticated
      using (workspace_id = 'main' and module = 'brand' and (
           public.venia_module_role('growth')  in ('owner', 'editor')
        or public.venia_module_role('product') in ('owner', 'editor')
        or public.venia_module_role('money')   in ('owner', 'editor')))
      with check (workspace_id = 'main' and module = 'brand' and (
           public.venia_module_role('growth')  in ('owner', 'editor')
        or public.venia_module_role('product') in ('owner', 'editor')
        or public.venia_module_role('money')   in ('owner', 'editor')));
  end if;
end $$;
-- No delete policy, as for every module row.

-- ── 3. The first copy, only if there is no brand row yet ──────────────────
-- Reads the growth row and inserts a NEW 'brand' row holding only Brand's
-- keys (each only if the growth row has it). The growth row is not touched.
-- If a brand row already exists, nothing happens (not exists + on conflict
-- do nothing). updated_at and rev are the growth row's, so the copy does not
-- look newer than the data it copies.
insert into public.venia_module_data (workspace_id, module, data, updated_by, updated_at, rev)
select g.workspace_id,
       'brand',
         (case when g.data ? 'brTone'       then jsonb_build_object('brTone',       g.data -> 'brTone')       else '{}'::jsonb end)
      || (case when g.data ? 'brToneBackup' then jsonb_build_object('brToneBackup', g.data -> 'brToneBackup') else '{}'::jsonb end)
      || (case when g.data ? 'brPrefs'      then jsonb_build_object('brPrefs',      g.data -> 'brPrefs')      else '{}'::jsonb end)
      || (case when jsonb_typeof(g.data -> 'brandDocs') = 'array' then jsonb_build_object('brandDocs', (
            select coalesce(jsonb_agg(d.e order by d.o), '[]'::jsonb)
              from jsonb_array_elements(g.data -> 'brandDocs') with ordinality as d(e, o)
             where not (
                    coalesce(d.e ->> 'from', '') in ('money', 'product')
                 or coalesce(d.e ->> 'kind', '') = 'retro'
                 or coalesce(d.e ->> 'title', '') like 'Money brief — %'
                 or coalesce(d.e ->> 'title', '') like 'Financial plan — %')))
              when g.data ? 'brandDocs' then jsonb_build_object('brandDocs', g.data -> 'brandDocs')
              else '{}'::jsonb end)
      || (case when (g.data -> '_ls') ? 'venia-brand-watch'
               then jsonb_build_object('_ls', jsonb_build_object('venia-brand-watch', g.data -> '_ls' -> 'venia-brand-watch'))
               else '{}'::jsonb end),
       'migration-20261120b',
       g.updated_at,
       g.rev
  from public.venia_module_data g
 where g.workspace_id = 'main'
   and g.module = 'growth'
   and not exists (select 1 from public.venia_module_data b
                    where b.workspace_id = g.workspace_id and b.module = 'brand')
on conflict (workspace_id, module) do nothing;
