-- VENIA OS — Boards: the creative space (whiteboards, moodboards)
--
-- Boards is the Brainstorm module's canvas, grown up: it replaces the small
-- freeform Board inside Brainstorm and lives in its own folder
-- (modules/boards). It owns these two tables and one private storage bucket
-- and touches nothing else. Access rides on the Brainstorm grant
-- (venia_members.module = 'brainstorm', Build 416): a founder sees every
-- board; anyone else needs Brainstorm, and only owner/editor can change them.
-- A viewer can look without being able to move a thing.
--
-- ADDITIVE ONLY. No existing table, row or policy is changed.

-- ── boards ─────────────────────────────────────────────────────────────────
create table if not exists public.venia_boards (
  id            text primary key,
  workspace_id  text not null default 'main',
  parent_id     text references public.venia_boards(id) on delete set null,
  title         text not null default 'Untitled board',
  -- The canvas itself: Excalidraw elements plus the few view settings that
  -- belong to the board (background, grid). Images are NOT in here — only
  -- their ids; the bytes live in storage and are listed in venia_board_files.
  scene         jsonb not null default '{"elements":[],"appState":{}}'::jsonb,
  -- Every word on the board, so search can find a note without opening it.
  search_text   text not null default '',
  cover_file    text,
  item_count    integer not null default 0,
  sort          double precision not null default 0,
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_by    text,
  updated_at    timestamptz not null default now(),
  -- Bumped on every save. A save that names an older rev did not see the
  -- latest one; the app merges and saves again instead of overwriting.
  rev           bigint not null default 0,
  deleted_at    timestamptz
);
create index if not exists venia_boards_parent_idx on public.venia_boards (workspace_id, parent_id);

-- ── images and files placed on a board ─────────────────────────────────────
create table if not exists public.venia_board_files (
  id          text not null,                 -- Excalidraw file id
  board_id    text not null references public.venia_boards(id) on delete cascade,
  path        text not null,                 -- object path in the venia-boards bucket
  mime        text,
  bytes       integer,
  source_url  text,                          -- where it was collected from, if a link
  created_by  text,
  created_at  timestamptz not null default now(),
  -- An image copied onto a second board gets its own row (and its own copy),
  -- so deleting one board never takes a picture off another.
  primary key (board_id, id)
);

alter table public.venia_boards      enable row level security;
alter table public.venia_board_files enable row level security;

-- ── who may see and change boards ──────────────────────────────────────────
drop policy if exists venia_boards_read  on public.venia_boards;
drop policy if exists venia_boards_write on public.venia_boards;
drop policy if exists venia_boards_edit  on public.venia_boards;
drop policy if exists venia_boards_drop  on public.venia_boards;

create policy venia_boards_read on public.venia_boards
  for select to authenticated
  using (public.venia_is_founder() or public.venia_module_role('brainstorm') is not null);
create policy venia_boards_write on public.venia_boards
  for insert to authenticated
  with check (public.venia_is_founder() or public.venia_module_role('brainstorm') in ('owner','editor'));
create policy venia_boards_edit on public.venia_boards
  for update to authenticated
  using      (public.venia_is_founder() or public.venia_module_role('brainstorm') in ('owner','editor'))
  with check (public.venia_is_founder() or public.venia_module_role('brainstorm') in ('owner','editor'));
-- Boards are soft-deleted (deleted_at) so a mistake can be undone from Trash;
-- the hard delete is kept to founders and owners.
create policy venia_boards_drop on public.venia_boards
  for delete to authenticated
  using (public.venia_is_founder() or public.venia_module_role('brainstorm') = 'owner');

drop policy if exists venia_board_files_read  on public.venia_board_files;
drop policy if exists venia_board_files_write on public.venia_board_files;
drop policy if exists venia_board_files_drop  on public.venia_board_files;

create policy venia_board_files_read on public.venia_board_files
  for select to authenticated
  using (public.venia_is_founder() or public.venia_module_role('brainstorm') is not null);
create policy venia_board_files_write on public.venia_board_files
  for insert to authenticated
  with check (public.venia_is_founder() or public.venia_module_role('brainstorm') in ('owner','editor'));
create policy venia_board_files_drop on public.venia_board_files
  for delete to authenticated
  using (public.venia_is_founder() or public.venia_module_role('brainstorm') in ('owner','editor'));

-- ── the image store: PRIVATE ───────────────────────────────────────────────
-- Unlike venia-photos this bucket is not public. The app reads images through
-- short-lived signed links, so a board's references never leak by URL — which
-- matters once the module is licensed to other houses.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('venia-boards', 'venia-boards', false, 20971520,
        array['image/jpeg','image/png','image/webp','image/gif','image/svg+xml','image/avif'])
on conflict (id) do nothing;

drop policy if exists venia_boards_obj_read  on storage.objects;
drop policy if exists venia_boards_obj_write on storage.objects;
drop policy if exists venia_boards_obj_drop  on storage.objects;
drop policy if exists venia_boards_obj_edit  on storage.objects;

create policy venia_boards_obj_read on storage.objects
  for select to authenticated
  using (bucket_id = 'venia-boards'
         and (public.venia_is_founder() or public.venia_module_role('brainstorm') is not null));
create policy venia_boards_obj_write on storage.objects
  for insert to authenticated
  with check (bucket_id = 'venia-boards'
              and (public.venia_is_founder() or public.venia_module_role('brainstorm') in ('owner','editor')));
-- Board thumbnails are rewritten in place as the board changes.
create policy venia_boards_obj_edit on storage.objects
  for update to authenticated
  using      (bucket_id = 'venia-boards'
              and (public.venia_is_founder() or public.venia_module_role('brainstorm') in ('owner','editor')))
  with check (bucket_id = 'venia-boards'
              and (public.venia_is_founder() or public.venia_module_role('brainstorm') in ('owner','editor')));
create policy venia_boards_obj_drop on storage.objects
  for delete to authenticated
  using (bucket_id = 'venia-boards'
         and (public.venia_is_founder() or public.venia_module_role('brainstorm') in ('owner','editor')));
