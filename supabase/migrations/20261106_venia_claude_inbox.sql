-- VENIA OS — the Claude connector's inbox (Build 577)
--
-- NOT YET APPLIED. Apply to VENIA CC (unxfaeqjskzzmhyrekqx) before merging the
-- connector, or every write tool will fail with "relation does not exist".
--
-- The connector at /mcp lets Claude read VENIA OS as the signed-in founder and
-- PROPOSE changes. A proposal is one venia_action object, the same shape Enigma
-- emits, filed here. The app shows pending rows under "From Claude" and applies
-- each one on a tap through agentRunAction, so there is still exactly one code
-- path that writes the workspace.
--
-- Why a table and not a direct write to venia_module_data: the app's push is a
-- three-way merge against what each device last agreed with the cloud. A
-- server writing the jsonb row underneath it would be a fourth party the merge
-- was never designed for, and the founders' own edits are what would lose.
--
-- WHAT RLS ENFORCES HERE
--   * you can only file a row in your own name, and only with some access to
--     the workspace;
--   * you cannot file anything if a founder switched the assistant off for you
--     (venia_agent_policy.can_write = false) — the same switch Enigma obeys;
--   * you see your own rows; founders see everyone's;
--   * the only thing anyone can change afterwards is the decision (status and
--     when it was made), and only on their own row or as a founder.
-- Applying a proposal still goes through the module grant and role checks in
-- the app and then the venia_module_data policies. Nothing here widens access.

create table if not exists public.venia_claude_inbox (
  id          uuid primary key default gen_random_uuid(),
  email       text not null default lower(coalesce(auth.jwt() ->> 'email', '')),
  action      jsonb not null,
  summary     text not null default '',
  source      text not null default 'claude-connector',
  status      text not null default 'pending'
              check (status in ('pending', 'applied', 'dismissed', 'denied')),
  created_at  timestamptz not null default now(),
  decided_at  timestamptz,
  decided_by  text,
  -- A proposal is a sentence's worth of change, not a data dump.
  constraint venia_claude_inbox_action_size check (pg_column_size(action) < 200000),
  constraint venia_claude_inbox_action_type check (jsonb_typeof(action -> 'type') = 'string')
);

create index if not exists venia_claude_inbox_email_status
  on public.venia_claude_inbox (email, status, created_at desc);

alter table public.venia_claude_inbox enable row level security;

drop policy if exists venia_claude_inbox_insert on public.venia_claude_inbox;
create policy venia_claude_inbox_insert on public.venia_claude_inbox
  for insert to authenticated
  with check (
    email = lower(coalesce(auth.jwt() ->> 'email', ''))
    and status = 'pending'
    and (public.venia_is_founder() or public.venia_has_access())
    -- Absent row = allowed, exactly as the app reads the switch.
    and coalesce((select p.can_write from public.venia_agent_policy p
                   where lower(p.email) = lower(coalesce(auth.jwt() ->> 'email', ''))), true)
  );

drop policy if exists venia_claude_inbox_read on public.venia_claude_inbox;
create policy venia_claude_inbox_read on public.venia_claude_inbox
  for select to authenticated
  using (email = lower(coalesce(auth.jwt() ->> 'email', '')) or public.venia_is_founder());

drop policy if exists venia_claude_inbox_decide on public.venia_claude_inbox;
create policy venia_claude_inbox_decide on public.venia_claude_inbox
  for update to authenticated
  using (email = lower(coalesce(auth.jwt() ->> 'email', '')) or public.venia_is_founder())
  with check (status in ('applied', 'dismissed', 'denied'));

-- Column privileges: the decision is the only thing that can change. The
-- action, the author and the timestamp are fixed the moment the row is filed.
revoke all on public.venia_claude_inbox from anon, public;
revoke update on public.venia_claude_inbox from authenticated;
grant select, insert on public.venia_claude_inbox to authenticated;
grant update (status, decided_at, decided_by) on public.venia_claude_inbox to authenticated;
-- No delete for anyone through the API: the inbox is also the record of what
-- the assistant asked for and who said yes.
