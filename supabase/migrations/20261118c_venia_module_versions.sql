-- Build 618: version history for VENIA's module data.
--
-- Every save overwrites a whole module row in venia_module_data, and until now
-- the database kept no earlier copy. This keeps one, automatically, in a fixed
-- set of slots per module, so it can never grow without limit and nothing is
-- ever removed to make room (a slot is simply reused once it is old enough):
--   min0..min5    the last hour, one copy per 10 minutes
--   hour0..hour23 the last day, one copy per hour
--   day0..day29   the last 30 days, one copy per day
--   restore       the state just before the last restore from Settings
-- A copy is the row as it stood BEFORE a save changed it.
--
-- Purely additive: a new table, a new trigger and a new function. The trigger
-- swallows its own errors, so keeping a copy can never stop a save.

create table if not exists public.venia_module_versions (
  workspace_id text        not null,
  module       text        not null,
  slot         text        not null,
  data         jsonb       not null,
  rev          bigint,
  updated_by   text,
  updated_at   timestamptz,
  kept_at      timestamptz not null default now(),
  primary key (workspace_id, module, slot)
);

alter table public.venia_module_versions enable row level security;

create policy venia_module_versions_read on public.venia_module_versions
  for select to authenticated using ((select public.venia_is_founder()));
-- No insert/update policy: only the trigger and the founder-only function
-- below write here.

create or replace function public.venia_keep_module_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  t timestamptz := now();
  s text;
  ttl interval;
begin
  if OLD.data is not distinct from NEW.data then
    return NEW;
  end if;
  begin
    foreach s in array array[
      'min'  || floor(extract(minute from t at time zone 'UTC') / 10)::int,
      'hour' || extract(hour from t at time zone 'UTC')::int,
      'day'  || (floor(extract(epoch from t) / 86400)::bigint % 30)
    ] loop
      ttl := case when s like 'min%' then interval '50 minutes'
                  when s like 'hour%' then interval '23 hours'
                  else interval '29 days' end;
      insert into public.venia_module_versions as v
        (workspace_id, module, slot, data, rev, updated_by, updated_at, kept_at)
      values (OLD.workspace_id, OLD.module, s, OLD.data, OLD.rev, OLD.updated_by, OLD.updated_at, t)
      on conflict (workspace_id, module, slot) do update
        set data = excluded.data, rev = excluded.rev, updated_by = excluded.updated_by,
            updated_at = excluded.updated_at, kept_at = excluded.kept_at
        where v.kept_at < t - ttl;
    end loop;
  exception when others then
    -- Keeping a copy must never stop the save itself.
    raise warning 'venia_keep_module_version: %', sqlerrm;
  end;
  return NEW;
end
$$;

revoke all on function public.venia_keep_module_version() from public, anon, authenticated;

create trigger venia_module_data_keep_version
  before update on public.venia_module_data
  for each row execute function public.venia_keep_module_version();

-- Before Settings restores a module, keep what is there now in the 'restore'
-- slot, so the restore itself can be undone. Founders only.
create or replace function public.venia_keep_version_now(p_module text)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  t timestamptz := now();
begin
  if not public.venia_is_founder() then
    raise exception 'Only a VENIA founder can restore data';
  end if;
  insert into public.venia_module_versions as v
    (workspace_id, module, slot, data, rev, updated_by, updated_at, kept_at)
  select d.workspace_id, d.module, 'restore', d.data, d.rev, d.updated_by, d.updated_at, t
    from public.venia_module_data d
   where d.workspace_id = 'main' and d.module = p_module
  on conflict (workspace_id, module, slot) do update
    set data = excluded.data, rev = excluded.rev, updated_by = excluded.updated_by,
        updated_at = excluded.updated_at, kept_at = excluded.kept_at;
  return t;
end
$$;

revoke all on function public.venia_keep_version_now(text) from public, anon;
grant execute on function public.venia_keep_version_now(text) to authenticated;
