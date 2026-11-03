-- Auth accounts created before 0001 do not receive its INSERT-trigger profile.
-- Backfill only missing rows. Existing roles and profile details are preserved.
insert into public.profiles (id, email, full_name)
select u.id, u.email, u.raw_user_meta_data ->> 'full_name'
from auth.users u
where u.email is not null
on conflict (id) do nothing;

-- New Supabase projects may not automatically grant Data API table access.
-- These grants make app operations reachable; existing RLS/guards still decide
-- which rows and changes are allowed. No anonymous access or default grants.
grant usage on schema public to authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert, update on
  public.investing_entities, public.deals, public.deal_private,
  public.accreditations, public.subscriptions, public.documents,
  public.distributions, public.distribution_lines
to authenticated;
grant select on public.audit_log, public.journey_exceptions to authenticated;
