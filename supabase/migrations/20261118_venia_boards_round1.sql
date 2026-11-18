-- VENIA OS: Boards round one. Comments with @ mentions, pinned boards, and
-- private live channels for editing a board together.
--
-- ADDITIVE ONLY: new tables, one new function and new policies, each made
-- only if missing. No existing table, row or policy changes. Removing a
-- comment hides it (hidden_at); a pin is switched off (pinned = false).
-- Emptying a board out of Trash clears these rows through the boards-purge
-- function, never from a browser.

-- Comments pinned to a spot on a board (x, y in board coordinates), or to
-- one item on it (element_id; x, y then offset from that item).
create table if not exists public.venia_board_comments (
  id            text primary key,
  workspace_id  text not null default 'main',
  board_id      text not null references public.venia_boards(id),
  thread_id     text,
  element_id    text,
  x             double precision not null default 0,
  y             double precision not null default 0,
  body          text not null default '',
  mentions      text[] not null default '{}',
  author        text not null,
  created_at    timestamptz not null default now(),
  edited_at     timestamptz,
  resolved_at   timestamptz,
  resolved_by   text,
  hidden_at     timestamptz
);
create index if not exists venia_board_comments_board_idx on public.venia_board_comments (board_id, created_at);

-- One row per person mentioned; seen_at is set when they open it.
create table if not exists public.venia_board_mentions (
  comment_id    text not null references public.venia_board_comments(id),
  email         text not null,
  board_id      text not null references public.venia_boards(id),
  board_title   text,
  author        text not null,
  excerpt       text not null default '',
  created_at    timestamptz not null default now(),
  seen_at       timestamptz,
  primary key (comment_id, email)
);
create index if not exists venia_board_mentions_email_idx on public.venia_board_mentions (email, seen_at);

-- Each person's own pinned boards.
create table if not exists public.venia_board_pins (
  email         text not null,
  board_id      text not null references public.venia_boards(id),
  pinned        boolean not null default true,
  updated_at    timestamptz not null default now(),
  primary key (email, board_id)
);

-- Who can be @ mentioned: the founders and everyone holding Brainstorm.
create or replace function public.venia_boards_people()
  returns table (email text) language sql stable security definer set search_path = '' as $$
  select distinct lower(e) from (
    select m.email as e from public.venia_members m where m.module = 'brainstorm'
    union all select unnest(array['keeter@veniacollection.com','christine@veniacollection.com'])
  ) s
  where public.venia_boards_can('read')
$$;
revoke all on function public.venia_boards_people() from public, anon;
grant execute on function public.venia_boards_people() to authenticated;

alter table public.venia_board_comments enable row level security;
alter table public.venia_board_mentions enable row level security;
alter table public.venia_board_pins     enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'venia_board_comments' and policyname = 'venia_board_comments_read') then
    create policy venia_board_comments_read on public.venia_board_comments for select to authenticated
      using (public.venia_boards_can('read'));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'venia_board_comments' and policyname = 'venia_board_comments_write') then
    create policy venia_board_comments_write on public.venia_board_comments for insert to authenticated
      with check (public.venia_boards_can('read') and author = lower(coalesce(auth.jwt() ->> 'email', '')));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'venia_board_comments' and policyname = 'venia_board_comments_edit') then
    create policy venia_board_comments_edit on public.venia_board_comments for update to authenticated
      using (public.venia_boards_can('write') or author = lower(coalesce(auth.jwt() ->> 'email', '')))
      with check (public.venia_boards_can('read'));
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'venia_board_mentions' and policyname = 'venia_board_mentions_read') then
    create policy venia_board_mentions_read on public.venia_board_mentions for select to authenticated
      using (email = lower(coalesce(auth.jwt() ->> 'email', '')) or author = lower(coalesce(auth.jwt() ->> 'email', '')));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'venia_board_mentions' and policyname = 'venia_board_mentions_write') then
    create policy venia_board_mentions_write on public.venia_board_mentions for insert to authenticated
      with check (public.venia_boards_can('read') and author = lower(coalesce(auth.jwt() ->> 'email', '')));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'venia_board_mentions' and policyname = 'venia_board_mentions_seen') then
    create policy venia_board_mentions_seen on public.venia_board_mentions for update to authenticated
      using (email = lower(coalesce(auth.jwt() ->> 'email', '')))
      with check (email = lower(coalesce(auth.jwt() ->> 'email', '')));
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'venia_board_pins' and policyname = 'venia_board_pins_own') then
    create policy venia_board_pins_own on public.venia_board_pins for select to authenticated
      using (email = lower(coalesce(auth.jwt() ->> 'email', '')));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'venia_board_pins' and policyname = 'venia_board_pins_add') then
    create policy venia_board_pins_add on public.venia_board_pins for insert to authenticated
      with check (email = lower(coalesce(auth.jwt() ->> 'email', '')) and public.venia_boards_can('read'));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'venia_board_pins' and policyname = 'venia_board_pins_set') then
    create policy venia_board_pins_set on public.venia_board_pins for update to authenticated
      using (email = lower(coalesce(auth.jwt() ->> 'email', '')))
      with check (email = lower(coalesce(auth.jwt() ->> 'email', '')));
  end if;

  -- Live editing: private Realtime channels named board:<id>, open only to
  -- people who can read Boards.
  if not exists (select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname = 'venia_boards_live_listen') then
    create policy venia_boards_live_listen on realtime.messages for select to authenticated
      using (realtime.topic() like 'board:%' and public.venia_boards_can('read'));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname = 'venia_boards_live_send') then
    create policy venia_boards_live_send on realtime.messages for insert to authenticated
      with check (realtime.topic() like 'board:%' and public.venia_boards_can('read'));
  end if;
end $$;
