-- VENIA OS: Boards, a record of boards emptied out of Trash for good.
--
-- Emptying Trash runs through the boards-purge function (service role),
-- never through a browser, so the Boards tables keep no policy that removes
-- anything. Each board it removes is written here first: which board, what
-- it was called, how many images went with it, who asked and when. Boards
-- also reads this so a purged board is never brought back by the one-time
-- import of the old Brainstorm board.
--
-- ADDITIVE ONLY: one new table and one read policy, each created only if
-- missing. Nothing existing changes.
create table if not exists public.venia_boards_purged (
  id            text primary key,
  workspace_id  text not null default 'main',
  title         text,
  files         integer not null default 0,
  purged_by     text,
  purged_at     timestamptz not null default now()
);
alter table public.venia_boards_purged enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'venia_boards_purged' and policyname = 'venia_boards_purged_read') then
    create policy venia_boards_purged_read on public.venia_boards_purged for select to authenticated
      using (public.venia_boards_can('read'));
  end if;
end $$;
