-- LP Portal: schema, RLS, compliance guards, audit log
-- Run in Supabase SQL editor (or `supabase db push`).

create extension if not exists pgcrypto;

-- ─── Enums ────────────────────────────────────────────────────────────────
create type user_role     as enum ('lp', 'gp');
create type entity_type   as enum ('individual', 'joint', 'llc', 'trust', 'ira', 'other');
create type accred_method as enum ('third_party_letter', 'verification_service', 'high_minimum');
create type accred_status as enum ('pending', 'verified', 'rejected');
create type deal_status   as enum ('draft', 'open', 'closed');
create type sub_status    as enum ('committed', 'accreditation', 'documents', 'funding', 'funded', 'withdrawn', 'rejected');
create type doc_kind      as enum ('ppm', 'operating_agreement', 'subscription_template', 'update', 'k1', 'w9', 'other');

-- ─── Tables ───────────────────────────────────────────────────────────────
create table profiles (
  id          uuid primary key references auth.users on delete cascade,
  email       text not null,
  full_name   text,
  phone       text,
  role        user_role not null default 'lp',
  created_at  timestamptz not null default now()
);

create table investing_entities (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references profiles on delete cascade,
  legal_name  text not null,
  entity_type entity_type not null,
  state       text,
  created_at  timestamptz not null default now()
);

create table deals (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  status          deal_status not null default 'draft',
  target_raise    numeric(14,2),
  min_investment  numeric(14,2) not null default 0,
  max_investors   int not null default 25,
  created_at      timestamptz not null default now()
);

-- Wire instructions live apart from deals so LPs only see them once the GP
-- has countersigned their subscription (wire-fraud hygiene).
create table deal_private (
  deal_id           uuid primary key references deals on delete cascade,
  wire_instructions text
);

create table accreditations (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references investing_entities on delete cascade,
  method         accred_method not null,
  status         accred_status not null default 'pending',
  letter_date    date,                 -- date on the third-party letter / certificate
  verifier_name  text,                 -- e.g. "Jane Doe, CPA" or "VerifyInvestor"
  verifier_type  text,                 -- cpa | attorney | ria | broker_dealer | service
  file_path      text,                 -- storage path to the letter
  reps           jsonb,                -- high-minimum written representations
  reviewed_by    uuid references profiles,
  reviewed_at    timestamptz,
  expires_at     date,
  notes          text,
  created_at     timestamptz not null default now()
);

create table subscriptions (
  id                   uuid primary key default gen_random_uuid(),
  deal_id              uuid not null references deals on delete cascade,
  entity_id            uuid not null references investing_entities on delete cascade,
  amount               numeric(14,2) not null check (amount > 0),
  status               sub_status not null default 'committed',
  accreditation_id     uuid references accreditations,
  signed_doc_path      text,
  gp_countersigned_at  timestamptz,
  funded_amount        numeric(14,2),
  funded_at            date,
  created_at           timestamptz not null default now(),
  unique (deal_id, entity_id)
);

create table documents (
  id           uuid primary key default gen_random_uuid(),
  deal_id      uuid references deals on delete cascade,
  entity_id    uuid references investing_entities on delete cascade,
  kind         doc_kind not null,
  title        text not null,
  file_path    text not null,
  uploaded_by  uuid references profiles,
  created_at   timestamptz not null default now(),
  check (deal_id is not null or entity_id is not null)
);

create table distributions (
  id          uuid primary key default gen_random_uuid(),
  deal_id     uuid not null references deals on delete cascade,
  dist_date   date not null,
  total       numeric(14,2) not null check (total > 0),
  memo        text,
  created_at  timestamptz not null default now()
);

create table distribution_lines (
  id               uuid primary key default gen_random_uuid(),
  distribution_id  uuid not null references distributions on delete cascade,
  subscription_id  uuid not null references subscriptions on delete cascade,
  amount           numeric(14,2) not null,
  paid_at          timestamptz
);

create table audit_log (
  id            bigserial primary key,
  actor         uuid,
  action        text not null,
  target_table  text not null,
  target_id     uuid,
  details       jsonb,
  at            timestamptz not null default now()
);

-- ─── Helper functions ─────────────────────────────────────────────────────
create or replace function is_gp() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'gp');
$$;

create or replace function owns_entity(eid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from investing_entities where id = eid and owner_id = auth.uid());
$$;

create or replace function in_deal(did uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from subscriptions s join investing_entities e on e.id = s.entity_id
    where s.deal_id = did and e.owner_id = auth.uid()
  );
$$;

create or replace function has_deal_access(did uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_gp()
      or exists (select 1 from deals where id = did and status = 'open')
      or in_deal(did);
$$;

-- Mirrors lib/accreditation.ts → highMinimumThreshold()
create or replace function high_minimum_threshold(t entity_type) returns numeric
language sql immutable as $$
  select case when t in ('individual', 'joint') then 200000 else 1000000 end::numeric;
$$;

-- New auth user → profile row
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data ->> 'full_name')
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

-- ─── Guards (enforced in the DB, not just the UI) ─────────────────────────

-- Restrictions below apply to signed-in non-GP users. Requests with no JWT
-- (Supabase SQL editor, service role) are trusted admin access.
create or replace function is_restricted_user() returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and not is_gp();
$$;

-- LPs can't promote themselves to GP.
create or replace function profiles_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.role is distinct from old.role and is_restricted_user() then
    raise exception 'Only a GP can change roles';
  end if;
  return new;
end $$;

create trigger profiles_guard before update on profiles
  for each row execute function profiles_guard();

-- Investor cap per deal (default 25, counts distinct humans, not entities).
create or replace function subscriptions_cap() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_max   int;
  v_owner uuid;
  v_count int;
begin
  select max_investors into v_max from deals where id = new.deal_id;
  select owner_id into v_owner from investing_entities where id = new.entity_id;

  select count(distinct e.owner_id) into v_count
  from subscriptions s join investing_entities e on e.id = s.entity_id
  where s.deal_id = new.deal_id
    and s.status not in ('withdrawn', 'rejected')
    and e.owner_id <> v_owner;

  if v_count >= v_max then
    raise exception 'Deal is full (% investor cap)', v_max;
  end if;
  return new;
end $$;

create trigger subscriptions_cap before insert on subscriptions
  for each row execute function subscriptions_cap();

-- The 506(c) gate + LP state-machine limits.
create or replace function subscriptions_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  a record;
  v_type entity_type;
begin
  -- 1) Nobody (GP included) moves past accreditation without a valid,
  --    verified accreditation linked to THIS subscription.
  if new.status in ('documents', 'funding', 'funded')
     and new.status is distinct from old.status then

    select * into a from accreditations where id = new.accreditation_id;

    if a.id is null or a.status <> 'verified' then
      raise exception '506(c): no verified accreditation linked to this subscription';
    end if;
    if a.entity_id <> new.entity_id then
      raise exception '506(c): accreditation belongs to a different investing entity';
    end if;
    if a.expires_at is not null and a.expires_at < current_date then
      raise exception '506(c): accreditation expired on % — get a fresh letter', a.expires_at;
    end if;
    if a.method = 'high_minimum' then
      select entity_type into v_type from investing_entities where id = new.entity_id;
      if new.amount < high_minimum_threshold(v_type) then
        raise exception '506(c): amount is below the high-minimum threshold';
      end if;
    end if;
  end if;

  -- 2) LP-side restrictions.
  if is_restricted_user() then
    if new.deal_id <> old.deal_id or new.entity_id <> old.entity_id
       or new.funded_amount is distinct from old.funded_amount
       or new.funded_at is distinct from old.funded_at
       or new.gp_countersigned_at is distinct from old.gp_countersigned_at then
      raise exception 'Not allowed';
    end if;
    if new.amount <> old.amount and old.status <> 'committed' then
      raise exception 'Amount is locked once accreditation is submitted';
    end if;
    if new.signed_doc_path is distinct from old.signed_doc_path and old.status <> 'documents' then
      raise exception 'Signed documents can only be uploaded at the documents step';
    end if;
    if new.status is distinct from old.status and not (
         (old.status = 'committed' and new.status in ('accreditation', 'documents'))
      or (old.status in ('committed', 'accreditation', 'documents') and new.status = 'withdrawn')
    ) then
      raise exception 'Status change % → % not allowed', old.status, new.status;
    end if;
  end if;

  return new;
end $$;

create trigger subscriptions_guard before update on subscriptions
  for each row execute function subscriptions_guard();

-- ─── Audit log (every write to money/compliance tables) ───────────────────
create or replace function audit_row() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  rec jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  rid uuid  := coalesce(rec ->> 'id', rec ->> 'deal_id')::uuid;  -- deal_private keys on deal_id
begin
  insert into audit_log (actor, action, target_table, target_id, details)
  values (
    auth.uid(), tg_op, tg_table_name, rid,
    case tg_op
      when 'DELETE' then jsonb_build_object('old', to_jsonb(old))
      when 'UPDATE' then jsonb_build_object('old', to_jsonb(old), 'new', to_jsonb(new))
      else jsonb_build_object('new', to_jsonb(new))
    end
  );
  return case when tg_op = 'DELETE' then old else new end;
end $$;

create trigger audit_accreditations after insert or update or delete on accreditations
  for each row execute function audit_row();
create trigger audit_subscriptions after insert or update or delete on subscriptions
  for each row execute function audit_row();
create trigger audit_distributions after insert or update or delete on distributions
  for each row execute function audit_row();
create trigger audit_distribution_lines after insert or update or delete on distribution_lines
  for each row execute function audit_row();
create trigger audit_documents after insert or update or delete on documents
  for each row execute function audit_row();
create trigger audit_deal_private after insert or update or delete on deal_private
  for each row execute function audit_row();

-- ─── Row-level security ───────────────────────────────────────────────────
alter table profiles            enable row level security;
alter table investing_entities  enable row level security;
alter table deals               enable row level security;
alter table deal_private        enable row level security;
alter table accreditations      enable row level security;
alter table subscriptions       enable row level security;
alter table documents           enable row level security;
alter table distributions       enable row level security;
alter table distribution_lines  enable row level security;
alter table audit_log           enable row level security;

-- profiles
create policy profiles_read   on profiles for select using (id = auth.uid() or is_gp());
create policy profiles_update on profiles for update using (id = auth.uid() or is_gp());

-- investing_entities
create policy entities_read   on investing_entities for select using (owner_id = auth.uid() or is_gp());
create policy entities_insert on investing_entities for insert with check (owner_id = auth.uid() or is_gp());
create policy entities_update on investing_entities for update using (owner_id = auth.uid() or is_gp());

-- deals
create policy deals_read  on deals for select using (is_gp() or status = 'open' or in_deal(id));
create policy deals_write on deals for all    using (is_gp()) with check (is_gp());

-- deal_private: wire instructions only after GP countersign
create policy deal_private_read on deal_private for select using (
  is_gp() or exists (
    select 1 from subscriptions s join investing_entities e on e.id = s.entity_id
    where s.deal_id = deal_private.deal_id and e.owner_id = auth.uid()
      and s.status in ('funding', 'funded')
  )
);
create policy deal_private_write on deal_private for all using (is_gp()) with check (is_gp());

-- accreditations: LPs submit (pending only); only GPs review
create policy accred_read   on accreditations for select using (owns_entity(entity_id) or is_gp());
create policy accred_insert on accreditations for insert with check (
  is_gp() or (owns_entity(entity_id) and status = 'pending'
              and reviewed_by is null and reviewed_at is null and expires_at is null)
);
create policy accred_update on accreditations for update using (is_gp()) with check (is_gp());

-- subscriptions
create policy subs_read   on subscriptions for select using (owns_entity(entity_id) or is_gp());
create policy subs_insert on subscriptions for insert with check (
  is_gp() or (owns_entity(entity_id) and status = 'committed'
              and exists (select 1 from deals d where d.id = deal_id and d.status = 'open'))
);
create policy subs_update on subscriptions for update using (owns_entity(entity_id) or is_gp());

-- documents
create policy docs_read on documents for select using (
  is_gp()
  or (entity_id is not null and owns_entity(entity_id))
  or (entity_id is null and deal_id is not null and has_deal_access(deal_id))
);
create policy docs_write on documents for all using (is_gp()) with check (is_gp());

-- distributions
create policy dist_read  on distributions for select using (is_gp() or in_deal(deal_id));
create policy dist_write on distributions for all using (is_gp()) with check (is_gp());

create policy dist_lines_read on distribution_lines for select using (
  is_gp() or exists (select 1 from subscriptions s where s.id = subscription_id and owns_entity(s.entity_id))
);
create policy dist_lines_write on distribution_lines for all using (is_gp()) with check (is_gp());

-- audit_log: GP read-only (rows are written by triggers)
create policy audit_read on audit_log for select using (is_gp());

-- ─── Storage ──────────────────────────────────────────────────────────────
-- Path conventions:
--   {owner_user_id}/{entity_id}/{kind}/{file}   LP-private (letters, signed subs, K-1s)
--   deals/{deal_id}/{kind}/{file}               deal-wide (PPM, OA, updates)
insert into storage.buckets (id, name, public)
values ('portal', 'portal', false)
on conflict (id) do nothing;

create policy portal_read on storage.objects for select to authenticated using (
  bucket_id = 'portal' and (
    is_gp()
    or (storage.foldername(name))[1] = auth.uid()::text
    or ((storage.foldername(name))[1] = 'deals'
        and has_deal_access(((storage.foldername(name))[2])::uuid))
  )
);
create policy portal_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'portal' and (is_gp() or (storage.foldername(name))[1] = auth.uid()::text)
);
create policy portal_gp_update on storage.objects for update to authenticated
  using (bucket_id = 'portal' and is_gp());
create policy portal_gp_delete on storage.objects for delete to authenticated
  using (bucket_id = 'portal' and is_gp());
