-- VENIA OS — Dr4ft handoffs from Product members (Build 689)
--
-- Dr4ft (module 'pattern-cad') opens for anyone holding Dr4ft OR Product
-- (veniaPatternCadOn in the app; venia_patterns_can in 20261120_venia_patterns.sql
-- for the pattern library). But venia_handoffs_send asks for
-- venia_can(tenant, from_module, 'read'), and from_module is 'pattern-cad', so a
-- Product-only member's "send this pattern to the tech pack" was refused by RLS:
-- the handoff landed on their screen and never reached the queue, so the other
-- devices (and the record) never saw it.
--
-- ADDITIVE ONLY. One new insert policy beside venia_handoffs_send, created only
-- if missing. Nothing existing is altered or removed; the existing policy keeps
-- doing exactly what it did. Postgres ORs permissive policies, so this only
-- ever widens sending to the one case below.
--
-- Same access question as venia_patterns_can: the brand has Dr4ft on, and the
-- person can use Dr4ft or can WRITE Product (inlined, so this file does not
-- depend on that function). Everything else matches venia_handoffs_send: a new
-- 'sent' row, as yourself, to a module the brand has.
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'venia_handoffs' and policyname = 'venia_handoffs_send_pattern_product') then
    create policy venia_handoffs_send_pattern_product on public.venia_handoffs for insert to authenticated
      with check (status = 'sent'
        and from_module = 'pattern-cad'
        and lower(coalesce(sent_by, '')) = lower(coalesce(auth.jwt() ->> 'email', ''))
        and coalesce(public.venia_entitled(tenant_id, 'pattern-cad'), true)
        and (public.venia_can(tenant_id, 'pattern-cad', 'read') or public.venia_can(tenant_id, 'product', 'write'))
        and public.venia_entitled(tenant_id, to_module));
  end if;
end $$;
