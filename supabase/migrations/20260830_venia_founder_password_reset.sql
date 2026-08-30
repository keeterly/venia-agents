-- Applied to VENIA CC (unxfaeqjskzzmhyrekqx) on 2026-08-30. Kept in the repo so
-- the database change that Build 395's UI depends on is reviewable here, not
-- only in the Supabase dashboard.
--
-- VENIA has no outbound mail sender configured (RESEND_API_KEY unset), so an
-- emailed reset link cannot be delivered. This lets one signed-in founder set
-- the other's password from inside the app: no email, no service-role key, no
-- new secret.
--
-- SECURITY DEFINER is what makes it possible (auth.users is not writable by the
-- anon/authenticated roles), so every guard matters:
--   * search_path is pinned empty and every name is schema-qualified, so the
--     definer's privileges cannot be turned against it by a caller-controlled
--     search_path.
--   * the CALLER must be one of the two founder emails, proven by the JWT.
--   * the TARGET must be one of the two founder emails, so the function can
--     never be pointed at an account it was not written for.
--   * EXECUTE is granted to `authenticated` only — never anon, never public.
-- The same two addresses already gate every RLS policy on this database.
create or replace function public.venia_reset_founder_password(
  target_email text,
  new_password text
) returns text
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  founders constant text[] := array['keeter@veniacollection.com','christine@veniacollection.com'];
  caller text := lower(coalesce(auth.jwt() ->> 'email', ''));
  target text := lower(btrim(coalesce(target_email, '')));
  uid uuid;
begin
  if caller = '' or not (caller = any(founders)) then
    raise exception 'Only a signed-in VENIA founder can reset a password';
  end if;
  if not (target = any(founders)) then
    raise exception 'That is not a VENIA account';
  end if;
  -- Deliberately stricter than the sign-in screen's 6: this one is typed by
  -- someone else and travels by voice or message before it is used.
  if new_password is null or length(new_password) < 8 then
    raise exception 'Password must be at least 8 characters';
  end if;

  select u.id into uid
    from auth.users u
   where lower(u.email) = target and u.deleted_at is null;
  if uid is null then
    raise exception 'No such VENIA account';
  end if;

  -- bcrypt at cost 10 — the format GoTrue already stores ($2a$10$, 60 chars).
  update auth.users
     set encrypted_password = extensions.crypt(new_password, extensions.gen_salt('bf', 10)),
         updated_at = now()
   where id = uid;

  -- A password change must end the sessions opened with the old one, or a
  -- device still holding a refresh token keeps the access it just lost.
  update auth.refresh_tokens
     set revoked = true
   where user_id = uid::text and revoked = false;

  return target;
end;
$fn$;

revoke all on function public.venia_reset_founder_password(text, text) from public;
revoke all on function public.venia_reset_founder_password(text, text) from anon;
grant execute on function public.venia_reset_founder_password(text, text) to authenticated;
