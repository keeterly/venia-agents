-- Build 658: the handoff queue between modules.
--
-- One row each time one module sends a record to another (a pattern to a
-- style's tech pack, a line sheet to Boards, ...). The row carries a link to
-- the original (its venia:// address), the version sent, and a snapshot of
-- what was sent, so the receiving module keeps working even if the sender is
-- later switched off. The receiver marks it accepted or declined.
--
-- Additive only: a new table, its indexes and its policies. Nothing existing
-- is changed, and rows are never removed: the queue is a record.
create table if not exists public.venia_handoffs (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   text not null default 'main' references public.venia_tenants(id),
  from_module text not null,
  to_module   text not null,
  kind        text not null,                 -- 'pattern', 'linesheet', ...
  address     text not null,                 -- venia://pattern/PAT-0042
  into_ref    text,                          -- where it should land: venia://style/STY123#techpack
  version     text,
  title       text,
  snapshot    jsonb not null default '{}'::jsonb,
  status      text not null default 'sent' check (status in ('sent', 'accepted', 'declined')),
  sent_by     text,
  sent_at     timestamptz not null default now(),
  decided_by  text,
  decided_at  timestamptz
);

create index if not exists venia_handoffs_inbox on public.venia_handoffs (tenant_id, to_module, status, sent_at desc);
create index if not exists venia_handoffs_address on public.venia_handoffs (tenant_id, address);

alter table public.venia_handoffs enable row level security;

do $$ begin
  -- Read: anyone who can read either end, inside the same brand.
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'venia_handoffs' and policyname = 'venia_handoffs_read') then
    create policy venia_handoffs_read on public.venia_handoffs for select to authenticated
      using (public.venia_can(tenant_id, from_module, 'read') or public.venia_can(tenant_id, to_module, 'read'));
  end if;
  -- Send: you can only send what you can read, to a module the brand has,
  -- as yourself, and only as a new 'sent' row.
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'venia_handoffs' and policyname = 'venia_handoffs_send') then
    create policy venia_handoffs_send on public.venia_handoffs for insert to authenticated
      with check (status = 'sent'
        and lower(coalesce(sent_by, '')) = lower(coalesce(auth.jwt() ->> 'email', ''))
        and public.venia_can(tenant_id, from_module, 'read')
        and public.venia_entitled(tenant_id, to_module));
  end if;
  -- Decide: whoever can change the receiving module marks it accepted or declined.
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'venia_handoffs' and policyname = 'venia_handoffs_decide') then
    create policy venia_handoffs_decide on public.venia_handoffs for update to authenticated
      using (public.venia_can(tenant_id, to_module, 'write'))
      with check (status in ('accepted', 'declined')
        and lower(coalesce(decided_by, '')) = lower(coalesce(auth.jwt() ->> 'email', ''))
        and public.venia_can(tenant_id, to_module, 'write'));
  end if;
end $$;

-- Only the decision can change after a row is sent. RLS has no policy for removing
-- a row, so none can be removed; this trigger keeps everything but the decision as
-- it was sent. (A trigger rather than narrower privileges, so this migration
-- takes nothing away from any role.)
create or replace function public.venia_handoffs_keep()
returns trigger language plpgsql set search_path to '' as $f$
begin
  if new.id is distinct from old.id or new.tenant_id is distinct from old.tenant_id
     or new.from_module is distinct from old.from_module or new.to_module is distinct from old.to_module
     or new.kind is distinct from old.kind or new.address is distinct from old.address
     or new.into_ref is distinct from old.into_ref or new.version is distinct from old.version
     or new.title is distinct from old.title or new.snapshot is distinct from old.snapshot
     or new.sent_by is distinct from old.sent_by or new.sent_at is distinct from old.sent_at then
    raise exception 'A handoff only changes by being accepted or declined';
  end if;
  if old.status <> 'sent' then
    raise exception 'This handoff was already %', old.status;
  end if;
  new.decided_at := coalesce(new.decided_at, now());
  return new;
end $f$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'venia_handoffs_keep' and tgrelid = 'public.venia_handoffs'::regclass) then
    create trigger venia_handoffs_keep before update on public.venia_handoffs
      for each row execute function public.venia_handoffs_keep();
  end if;
end $$;

grant select, insert, update on public.venia_handoffs to authenticated;
