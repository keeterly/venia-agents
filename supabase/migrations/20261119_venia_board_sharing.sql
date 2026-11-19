-- VENIA OS — Boards: sharing (Build 660)
--
-- Who sees a board, chosen per board:
--   everyone   'edit' | 'view' | 'none'  — everyone in the workspace who has
--              Boards (the Brainstorm grant) can edit, can view, or can't see it
--   shares     named people, each 'edit' or 'view'
--   owner      the person who made it; only they (or a founder, on a board
--              whose maker isn't known) change who sees it
--   links      a view-only link for someone outside VENIA OS, read through the
--              board-view function (service role, read-only) — never through
--              these tables, so a link can't write anything
--
-- ADDITIVE ONLY. Nothing is dropped, renamed or rewritten:
--   * two columns are ADDED to venia_boards. Every board that exists today
--     gets everyone = 'edit', which is exactly today's access, so nobody loses
--     anything they see now. New boards are made private by the app (it sends
--     everyone = 'none'); the column default stays 'edit' so an older app
--     still makes boards the way it always has.
--   * the existing (permissive) policies stay as they are. The per-board rule
--     is added as RESTRICTIVE policies, which Postgres ANDs with them, so the
--     database enforces it whatever the app does.

-- ── columns ────────────────────────────────────────────────────────────────
alter table public.venia_boards add column if not exists owner text
  default lower(coalesce(auth.jwt() ->> 'email', ''));
alter table public.venia_boards add column if not exists everyone text not null default 'edit';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'venia_boards_everyone_chk') then
    alter table public.venia_boards add constraint venia_boards_everyone_chk check (everyone in ('edit','view','none'));
  end if;
end $$;

-- ── named people ───────────────────────────────────────────────────────────
create table if not exists public.venia_board_shares (
  board_id   text not null references public.venia_boards(id),
  email      text not null check (email = lower(email)),
  role       text not null default 'view' check (role in ('edit','view')),
  added_by   text default lower(coalesce(auth.jwt() ->> 'email', '')),
  created_at timestamptz not null default now(),
  primary key (board_id, email)
);

-- ── view-only links ────────────────────────────────────────────────────────
create table if not exists public.venia_board_links (
  token      text primary key default replace(gen_random_uuid()::text, '-', ''),
  board_id   text not null references public.venia_boards(id),
  created_by text default lower(coalesce(auth.jwt() ->> 'email', '')),
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz
);
create index if not exists venia_board_links_board_idx on public.venia_board_links (board_id);

-- ── the one question: what can I do on this board? ────────────────────────
-- 'owner' | 'edit' | 'view' | null. Module access (venia_boards_can) is still
-- needed first, then the board's own setting. A board that doesn't exist yet
-- (being created) answers by module access alone.
create or replace function public.venia_board_role(bid text)
  returns text language plpgsql stable security definer set search_path = '' as $$
declare
  me   text := lower(coalesce(auth.jwt() ->> 'email', ''));
  b    record;
  sr   text;
begin
  if not public.venia_boards_can('read') then return null; end if;
  select coalesce(nullif(x.owner, ''), lower(coalesce(x.created_by, ''))) as who, x.everyone
    into b from public.venia_boards x where x.id = bid;
  if not found then
    return case when public.venia_boards_can('write') then 'edit' else null end;
  end if;
  if me <> '' and b.who = me then return 'owner'; end if;
  if b.who = '' and public.venia_is_founder() then return 'owner'; end if;
  if b.everyone = 'edit' then
    return case when public.venia_boards_can('write') then 'edit' else 'view' end;
  end if;
  select s.role into sr from public.venia_board_shares s where s.board_id = bid and s.email = me;
  if sr = 'edit' then return case when public.venia_boards_can('write') then 'edit' else 'view' end; end if;
  if sr = 'view' or b.everyone = 'view' then return 'view'; end if;
  return null;
end $$;
revoke all on function public.venia_board_role(text) from public, anon;
grant execute on function public.venia_board_role(text) to authenticated;

-- The board an object in the venia-boards bucket belongs to:
--   main/<board>/<file>.<ext>   and   main/thumbs/<board>.png
create or replace function public.venia_board_of_object(name text)
  returns text language sql immutable set search_path = '' as $$
  select case when split_part(name, '/', 2) = 'thumbs'
              then regexp_replace(split_part(name, '/', 3), '\.png$', '')
              else split_part(name, '/', 2) end
$$;

-- Only the owner changes who sees a board, or who owns it.
create or replace function public.venia_boards_guard_sharing()
  returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (new.owner is distinct from old.owner or new.everyone is distinct from old.everyone)
     and coalesce(auth.jwt() ->> 'role', '') <> 'service_role'
     and coalesce(public.venia_board_role(old.id), '') <> 'owner' then
    raise exception 'Only the board''s owner can change who sees it';
  end if;
  return new;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'venia_boards_guard_sharing' and tgrelid = 'public.venia_boards'::regclass) then
    create trigger venia_boards_guard_sharing before update on public.venia_boards
      for each row execute function public.venia_boards_guard_sharing();
  end if;
end $$;

alter table public.venia_board_shares enable row level security;
alter table public.venia_board_links  enable row level security;

-- ── policies (created only if missing) ─────────────────────────────────────
do $$
declare me text := 'lower(coalesce(auth.jwt() ->> ''email'', ''''))';
begin
  -- boards: the per-board rule, ANDed with the module rule already there
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='venia_boards' and policyname='venia_boards_share_read') then
    create policy venia_boards_share_read on public.venia_boards as restrictive for select to authenticated
      using (public.venia_board_role(id) is not null);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='venia_boards' and policyname='venia_boards_share_edit') then
    create policy venia_boards_share_edit on public.venia_boards as restrictive for update to authenticated
      using (public.venia_board_role(id) in ('owner','edit')) with check (public.venia_board_role(id) in ('owner','edit'));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='venia_boards' and policyname='venia_boards_share_new') then
    execute 'create policy venia_boards_share_new on public.venia_boards as restrictive for insert to authenticated
      with check (coalesce(owner, '''') in ('''', ' || me || '))';
  end if;

  -- images, comments, mentions follow their board
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='venia_board_files' and policyname='venia_board_files_share_read') then
    create policy venia_board_files_share_read on public.venia_board_files as restrictive for select to authenticated
      using (public.venia_board_role(board_id) is not null);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='venia_board_files' and policyname='venia_board_files_share_write') then
    create policy venia_board_files_share_write on public.venia_board_files as restrictive for insert to authenticated
      with check (public.venia_board_role(board_id) in ('owner','edit'));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='venia_board_comments' and policyname='venia_board_comments_share_read') then
    create policy venia_board_comments_share_read on public.venia_board_comments as restrictive for select to authenticated
      using (public.venia_board_role(board_id) is not null);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='venia_board_comments' and policyname='venia_board_comments_share_write') then
    create policy venia_board_comments_share_write on public.venia_board_comments as restrictive for insert to authenticated
      with check (public.venia_board_role(board_id) is not null);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='venia_board_comments' and policyname='venia_board_comments_share_edit') then
    create policy venia_board_comments_share_edit on public.venia_board_comments as restrictive for update to authenticated
      using (public.venia_board_role(board_id) is not null) with check (public.venia_board_role(board_id) is not null);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='venia_board_mentions' and policyname='venia_board_mentions_share_write') then
    create policy venia_board_mentions_share_write on public.venia_board_mentions as restrictive for insert to authenticated
      with check (public.venia_board_role(board_id) is not null);
  end if;

  -- the pictures themselves, in the private bucket
  if not exists (select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='venia_boards_obj_share_read') then
    create policy venia_boards_obj_share_read on storage.objects as restrictive for select to authenticated
      using (case when bucket_id <> 'venia-boards' then true else public.venia_board_role(public.venia_board_of_object(name)) is not null end);
  end if;
  if not exists (select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='venia_boards_obj_share_write') then
    create policy venia_boards_obj_share_write on storage.objects as restrictive for insert to authenticated
      with check (case when bucket_id <> 'venia-boards' then true else public.venia_board_role(public.venia_board_of_object(name)) in ('owner','edit') end);
  end if;
  if not exists (select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='venia_boards_obj_share_edit') then
    create policy venia_boards_obj_share_edit on storage.objects as restrictive for update to authenticated
      using (case when bucket_id <> 'venia-boards' then true else public.venia_board_role(public.venia_board_of_object(name)) in ('owner','edit') end)
      with check (case when bucket_id <> 'venia-boards' then true else public.venia_board_role(public.venia_board_of_object(name)) in ('owner','edit') end);
  end if;

  -- named people: everyone who can see the board sees who it's shared with;
  -- only the owner adds, changes or removes them
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='venia_board_shares' and policyname='venia_board_shares_read') then
    create policy venia_board_shares_read on public.venia_board_shares for select to authenticated
      using (public.venia_board_role(board_id) is not null);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='venia_board_shares' and policyname='venia_board_shares_add') then
    create policy venia_board_shares_add on public.venia_board_shares for insert to authenticated
      with check (public.venia_board_role(board_id) = 'owner');
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='venia_board_shares' and policyname='venia_board_shares_set') then
    create policy venia_board_shares_set on public.venia_board_shares for update to authenticated
      using (public.venia_board_role(board_id) = 'owner') with check (public.venia_board_role(board_id) = 'owner');
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='venia_board_shares' and policyname='venia_board_shares_remove') then
    create policy venia_board_shares_remove on public.venia_board_shares for delete to authenticated
      using (public.venia_board_role(board_id) = 'owner');
  end if;

  -- links: the owner only; they're turned off (revoked_at), never deleted
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='venia_board_links' and policyname='venia_board_links_read') then
    create policy venia_board_links_read on public.venia_board_links for select to authenticated
      using (public.venia_board_role(board_id) = 'owner');
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='venia_board_links' and policyname='venia_board_links_add') then
    create policy venia_board_links_add on public.venia_board_links for insert to authenticated
      with check (public.venia_board_role(board_id) = 'owner');
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='venia_board_links' and policyname='venia_board_links_set') then
    create policy venia_board_links_set on public.venia_board_links for update to authenticated
      using (public.venia_board_role(board_id) = 'owner') with check (public.venia_board_role(board_id) = 'owner');
  end if;
end $$;

grant select, insert, update, delete on public.venia_board_shares to authenticated;
grant select, insert, update on public.venia_board_links to authenticated;

-- ── live editing follows the board too ─────────────────────────────────────
-- Live cursors and edits travel on private channels 'board:<id>'. Only people
-- who can see that board may listen or send there.
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='realtime' and tablename='messages' and policyname='venia_boards_live_share_listen') then
    create policy venia_boards_live_share_listen on realtime.messages as restrictive for select to authenticated
      using (case when realtime.topic() like 'board:%' then public.venia_board_role(substr(realtime.topic(), 7)) is not null else true end);
  end if;
  if not exists (select 1 from pg_policies where schemaname='realtime' and tablename='messages' and policyname='venia_boards_live_share_send') then
    create policy venia_boards_live_share_send on realtime.messages as restrictive for insert to authenticated
      with check (case when realtime.topic() like 'board:%' then public.venia_board_role(substr(realtime.topic(), 7)) is not null else true end);
  end if;
end $$;

-- the guard is only ever run as a trigger, never called directly
revoke all on function public.venia_boards_guard_sharing() from public, anon, authenticated;
