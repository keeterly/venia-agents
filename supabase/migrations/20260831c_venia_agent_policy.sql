-- VENIA OS — may the assistant make changes for this person? (Build 425)
--
-- Modules decide what someone can SEE. Their role in a module decides whether
-- they can CHANGE it. Enigma inherits both — it can never do something its user
-- could not do by hand — and that is almost the whole answer.
--
-- Almost. One thing an agent does that a person does not is act in bulk and at
-- speed: "reprice the season from retail" is 57 writes from one sentence. So
-- there is one more switch, per person, that only ever SUBTRACTS: with it off,
-- Enigma still answers, analyses, researches and drafts for them, but emits no
-- action blocks at all. It cannot grant anything — every write still has to
-- pass the module grant, the role, and then RLS.
--
-- Absent row = allowed. Failing open is right here and only here: the person
-- can already make the same change by hand, so a missing row grants nothing.

create table if not exists public.venia_agent_policy (
  email      text primary key,
  can_write  boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by text
);

alter table public.venia_agent_policy enable row level security;

-- You can see your own setting (the app needs it to build the right prompt).
-- Only a founder can change it — otherwise the switch would be one a member
-- could flip back on themselves, which is no switch at all.
drop policy if exists venia_agent_policy_read  on public.venia_agent_policy;
drop policy if exists venia_agent_policy_admin on public.venia_agent_policy;

create policy venia_agent_policy_read on public.venia_agent_policy
  for select to authenticated
  using (public.venia_is_founder() or email = (auth.jwt() ->> 'email'));

create policy venia_agent_policy_admin on public.venia_agent_policy
  for all to authenticated
  using (public.venia_is_founder())
  with check (public.venia_is_founder());
