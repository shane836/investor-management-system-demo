-- Internal sponsor exception tracking. Resolving a problem never changes
-- subscription, accreditation, signature or funding approval state.
begin;
create table journey_exceptions (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references subscriptions,
  kind text not null check (kind in ('verification','signing','funding','documents','other')),
  summary text not null check (length(btrim(summary)) > 0),
  status text not null default 'open' check (status in ('open','resolved')),
  owner_id uuid not null references profiles,
  created_by uuid not null references profiles,
  updated_by uuid not null references profiles,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  resolved_by uuid references profiles,
  resolved_at timestamptz,
  resolution text,
  check ((status = 'open' and resolved_by is null and resolved_at is null and resolution is null)
    or (status = 'resolved' and resolved_by is not null and resolved_at is not null
        and resolution is not null and length(btrim(resolution)) > 0))
);
create unique index journey_exceptions_one_open on journey_exceptions(subscription_id,kind)
  where status = 'open';
alter table journey_exceptions enable row level security;
create policy journey_exceptions_read on journey_exceptions for select to authenticated using (is_gp());
grant select on journey_exceptions to authenticated;
-- No application INSERT/UPDATE/DELETE policies: all changes use checked RPCs.
create trigger audit_journey_exceptions after insert or update or delete on journey_exceptions
  for each row execute function audit_row();

create function open_journey_exception(
  p_subscription_id uuid, p_kind text, p_summary text, p_owner_id uuid default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_owner uuid := coalesce(p_owner_id,auth.uid()); v_id uuid;
begin
  if not is_gp() then raise exception 'Only a GP can record a journey exception'; end if;
  if nullif(btrim(p_summary),'') is null then raise exception 'An exception description is required'; end if;
  if p_kind is null or p_kind not in ('verification','signing','funding','documents','other') then
    raise exception 'Unknown exception category';
  end if;
  if not exists (select 1 from profiles where id = v_owner and role = 'gp') then
    raise exception 'Exception owner must be a GP';
  end if;
  insert into journey_exceptions(subscription_id,kind,summary,owner_id,created_by,updated_by)
    values(p_subscription_id,p_kind,btrim(p_summary),v_owner,auth.uid(),auth.uid())
    on conflict(subscription_id,kind) where status = 'open' do nothing returning id into v_id;
  if v_id is null then
    select id into v_id from journey_exceptions
      where subscription_id = p_subscription_id and kind = p_kind and status = 'open';
  end if;
  return v_id;
end $$;

create function update_journey_exception(
  p_exception_id uuid, p_expected_version integer, p_owner_id uuid,
  p_summary text, p_status text, p_resolution text default null
) returns void language plpgsql security definer set search_path = public as $$
declare issue journey_exceptions;
begin
  if not is_gp() then raise exception 'Only a GP can update a journey exception'; end if;
  select * into issue from journey_exceptions where id = p_exception_id for update;
  if issue.id is null then raise exception 'Exception not found'; end if;
  if issue.status = 'resolved' then raise exception 'Resolved issue history cannot be rewritten; open a new issue'; end if;
  if p_expected_version is null or issue.version <> p_expected_version then
    raise exception 'This exception changed. Refresh before saving';
  end if;
  if nullif(btrim(p_summary),'') is null then raise exception 'An exception description is required'; end if;
  if not exists (select 1 from profiles where id = p_owner_id and role = 'gp') then
    raise exception 'Exception owner must be a GP';
  end if;
  if p_status is null or p_status not in ('open','resolved') then raise exception 'Unknown exception status'; end if;
  if p_status = 'resolved' and nullif(btrim(p_resolution),'') is null then
    raise exception 'A resolution explanation is required';
  end if;
  if p_status = 'open' and nullif(btrim(p_resolution),'') is not null then
    raise exception 'Use Resolve to record a resolution';
  end if;
  update journey_exceptions set owner_id = p_owner_id, summary = btrim(p_summary), status = p_status,
    updated_by = auth.uid(), updated_at = clock_timestamp(), version = issue.version + 1,
    resolved_by = case when p_status = 'resolved' then auth.uid() else null end,
    resolved_at = case when p_status = 'resolved' then clock_timestamp() else null end,
    resolution = case when p_status = 'resolved' then btrim(p_resolution) else null end
    where id = issue.id;
end $$;
revoke all on function open_journey_exception(uuid,text,text,uuid) from public;
revoke all on function update_journey_exception(uuid,integer,uuid,text,text,text) from public;
grant execute on function open_journey_exception(uuid,text,text,uuid) to authenticated;
grant execute on function update_journey_exception(uuid,integer,uuid,text,text,text) to authenticated;
commit;
