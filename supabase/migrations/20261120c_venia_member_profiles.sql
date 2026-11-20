-- Build 704: a role name and a pause switch for each person. ADDITIVE.
--
-- venia_members stays the one truth about WHAT someone can reach (one row per
-- module, owner/editor/viewer). This table only adds two things about the
-- person: which role preset the founders picked for them ("Press & Social"),
-- so the People screen can say it in words, and whether their access is
-- paused. Nothing is dropped or rewritten; a person with no row here is
-- exactly as before (no preset name, not paused).
--
-- Writes come only from the `team` edge function (service role), which is
-- founders-only. Founders can read every row; a person can read their own.

create table if not exists public.venia_member_profiles (
  email       text primary key,
  preset      text,
  paused      boolean not null default false,
  paused_at   timestamptz,
  updated_by  text,
  updated_at  timestamptz not null default now()
);

alter table public.venia_member_profiles enable row level security;

drop policy if exists venia_member_profiles_read on public.venia_member_profiles;
create policy venia_member_profiles_read on public.venia_member_profiles
  for select to authenticated
  using (public.venia_is_founder() or email = lower(coalesce(auth.jwt() ->> 'email', '')));

-- Is the signed-in person paused? A founder never is.
create or replace function public.venia_is_paused()
  returns boolean
  language sql stable security definer
  set search_path to ''
as $function$
  select (not public.venia_is_founder()) and exists (
    select 1 from public.venia_member_profiles p
     where p.email = lower(coalesce(auth.jwt() ->> 'email', '')) and p.paused
  )
$function$;

-- The two helpers every module policy already calls. Same answers as before,
-- except that a paused person gets none: no access, no module role. Their
-- grants stay in venia_members untouched, so Resume puts everything back.
create or replace function public.venia_has_access()
  returns boolean
  language sql stable security definer
  set search_path to ''
as $function$
  select exists (
    select 1 from public.venia_members r where r.email = (auth.jwt() ->> 'email')
  ) and not public.venia_is_paused()
$function$;

create or replace function public.venia_module_role(m text)
  returns text
  language sql stable security definer
  set search_path to ''
as $function$
  select case when public.venia_is_paused() then null else (
    select r.role from public.venia_members r
     where r.email = (auth.jwt() ->> 'email') and r.module = m
     limit 1
  ) end
$function$;
