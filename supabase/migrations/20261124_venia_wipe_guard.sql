-- Build 740: the database refuses a save that empties a whole section.
--
-- On Nov 23 at 11:08 PM a reloaded browser tab merged with the cloud before it
-- had loaded its own saved copy, and published Product, the catalog, Press and
-- Brainstorm with their sections empty: 116 styles became 0. The app no longer
-- does that (Build 740 waits for its copy to load, and puts back any section a
-- merge would empty). This is the last lock, for any window still running an
-- older build and for whatever is written next.
--
-- The rule: a signed-in browser may not turn a section of a module row that
-- holds something (a list with items, a map with keys, any other value) into
-- an empty one (an empty list, an empty map or null), unless the save carries
-- the app's mark that a person emptied that section on that device in the last
-- three days (data->'_emptyOk'->section, a time in milliseconds). Sections
-- whose names start with "_" (_who, _tomb, _ls, ...) are bookkeeping, not
-- data, and are not checked. A section left out of a save entirely is not
-- checked either: that is a key moving between modules, not a wipe.
--
-- A refused save changes nothing at all (the whole statement is rolled back,
-- the earlier copy stays, and the app keeps the edit on the device and says
-- "Not saved"). Only browsers are held to it: the database's own roles, the
-- service key used by server functions, and restores done by hand are not.
--
-- ADDITIVE ONLY: one function, one trigger. Nothing existing is changed or
-- dropped. To switch it off:  drop trigger venia_module_data_refuse_emptying
--                             on public.venia_module_data;

create or replace function public.venia_jcount(v jsonb)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case
    when v is null or jsonb_typeof(v) = 'null' then 0
    when jsonb_typeof(v) = 'array'  then jsonb_array_length(v)
    when jsonb_typeof(v) = 'object' then (select count(*)::int from jsonb_object_keys(v))
    else 1
  end
$$;

create or replace function public.venia_refuse_emptying()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  k       text;
  ok      jsonb;
  cut     numeric;
  emptied text[] := '{}';
begin
  -- Browsers sign in as 'authenticated'. Everything else passes untouched.
  if coalesce(auth.role(), '') <> 'authenticated' then
    return NEW;
  end if;
  if OLD.data is not distinct from NEW.data then
    return NEW;
  end if;
  ok  := coalesce(NEW.data -> '_emptyOk', '{}'::jsonb);
  if jsonb_typeof(ok) <> 'object' then ok := '{}'::jsonb; end if;
  cut := extract(epoch from now()) * 1000 - 3 * 86400000;
  for k in select jsonb_object_keys(OLD.data) loop
    continue when left(k, 1) = '_';
    continue when not (NEW.data ? k);
    continue when public.venia_jcount(OLD.data -> k) = 0;
    continue when public.venia_jcount(NEW.data -> k) > 0;
    -- A person emptied it on their device, recently: let it through.
    continue when jsonb_typeof(ok -> k) = 'number' and (ok ->> k)::numeric > cut;
    emptied := emptied || k;
  end loop;
  if array_length(emptied, 1) > 0 then
    raise exception 'VENIA refused a save that would empty % in % — nothing was changed',
      array_to_string(emptied, ', '), NEW.module
      using errcode = 'P0001',
            hint = 'Only a person can empty a whole section. Reload the app; the cloud copy is intact.';
  end if;
  return NEW;
end
$$;

revoke all on function public.venia_refuse_emptying() from public, anon, authenticated;
grant execute on function public.venia_jcount(jsonb) to authenticated;

drop trigger if exists venia_module_data_refuse_emptying on public.venia_module_data;
create trigger venia_module_data_refuse_emptying
  before update on public.venia_module_data
  for each row execute function public.venia_refuse_emptying();
