-- GENERATED SETUP ARTIFACT: fresh testing project only.
-- Includes migrations 0001–0007 plus one synthetic offering.
-- Existing installations apply only their missing numbered migrations.
-- Regenerate from numbered migrations whenever those sources change.
begin;

-- Source: migrations/0001_init.sql
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


-- Source: migrations/0002_funding_accreditation_guard.sql
-- Funding invariant: verification precedes accepting/marking capital, for GP too.
-- Does not introduce a new accreditation method, expiry, or legal policy.
begin;

create or replace function subscriptions_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  a record;
  v_type entity_type;
begin
  -- Applicants/entities/initial commitments may exist before verification.
  -- Every protected write, including GP INSERT and unchanged-status UPDATE,
  -- requires verified accreditation for this investing entity.
  if new.status in ('documents', 'funding', 'funded')
     or new.funded_amount is not null or new.funded_at is not null
     or new.gp_countersigned_at is not null then

    -- Serialize against concurrent review/revocation while accepting this write.
    select * into a from accreditations where id = new.accreditation_id for share;

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

  -- LP INSERT cannot prepopulate fields reserved for GP actions.
  if tg_op = 'INSERT' and is_restricted_user() then
    if new.status <> 'committed' or new.funded_amount is not null
       or new.funded_at is not null or new.gp_countersigned_at is not null then
      raise exception 'Not allowed';
    end if;
  end if;

  -- Existing LP UPDATE restrictions remain in force.
  if tg_op = 'UPDATE' and is_restricted_user() then
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

  -- Capital cannot be recorded or requested before GP countersign.
  if (new.status in ('funding', 'funded')
      or new.funded_amount is not null or new.funded_at is not null)
     and new.gp_countersigned_at is null then
    raise exception 'GP countersign is required before funding';
  end if;

  return new;
end $$;

drop trigger subscriptions_guard on subscriptions;
create trigger subscriptions_guard before insert or update on subscriptions
  for each row execute function subscriptions_guard();

-- Read authorization checks the actual approval and countersign, rather than
-- trusting the status label. Existing recorded expiry/high-minimum rules apply.
alter policy deal_private_read on deal_private using (
  is_gp() or exists (
    select 1
    from subscriptions s
    join investing_entities e on e.id = s.entity_id
    join accreditations a on a.id = s.accreditation_id and a.entity_id = s.entity_id
    where s.deal_id = deal_private.deal_id and e.owner_id = auth.uid()
      and s.status in ('funding', 'funded')
      and s.gp_countersigned_at is not null
      and a.status = 'verified'
      and (a.expires_at is null or a.expires_at >= current_date)
      and (a.method <> 'high_minimum' or s.amount >= high_minimum_threshold(e.entity_type))
  )
);

commit;


-- Source: migrations/0003_k1_entity_isolation.sql
-- K-1 contract: one investing entity, canonical private path, owner/GP reads.
-- Existing malformed rows/files are retained and quarantined from LP reads.
begin;

-- Shared path contract for metadata writes, storage writes and read isolation.
create function is_entity_k1_path(object_name text, investing_entity_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from investing_entities e
    where e.id = investing_entity_id
      and split_part(object_name, '/', 1) = e.owner_id::text
      and split_part(object_name, '/', 2) = e.id::text
      and split_part(object_name, '/', 3) = 'k1'
      and split_part(object_name, '/', 4) <> ''
      and array_length(string_to_array(object_name, '/'), 1) = 4
  );
$$;

create function documents_k1_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind = 'k1' and not is_entity_k1_path(new.file_path, new.entity_id) then
    raise exception 'K-1 requires an investing entity and its owner/entity/k1/filename private path';
  end if;
  return new;
end $$;
create trigger documents_k1_guard before insert or update on documents
  for each row execute function documents_k1_guard();

-- A restrictive policy also protects malformed rows predating this migration.
create policy documents_k1_read on documents as restrictive
  for select to authenticated using (
    is_gp() or kind <> 'k1'
    or (owns_entity(entity_id) and is_entity_k1_path(file_path, entity_id))
  );

create function storage_k1_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_k1 boolean;
begin
  v_k1 := new.bucket_id = 'portal' and (
    split_part(new.name, '/', 3) = 'k1'
    or exists (select 1 from documents d where d.kind = 'k1' and d.file_path = new.name)
  );
  if tg_op = 'UPDATE' then
    -- Renaming a K-1 must not turn its bytes into a shared offering document.
    v_k1 := v_k1 or (old.bucket_id = 'portal' and (
      split_part(old.name, '/', 3) = 'k1'
      or exists (select 1 from documents d where d.kind = 'k1' and d.file_path = old.name)
    ));
  end if;
  if v_k1 and (new.bucket_id <> 'portal' or not exists (
    select 1 from investing_entities e where is_entity_k1_path(new.name, e.id)
  )) then
    raise exception 'K-1 storage requires an owner/entity/k1/filename private path';
  end if;
  return new;
end $$;
create trigger storage_k1_guard before insert or update on storage.objects
  for each row execute function storage_k1_guard();

-- Security definer sees K-1 references hidden by document RLS. Otherwise an LP
-- could bypass a hidden document row by requesting its shared raw object path.
create function can_read_k1_object(object_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select (
    split_part(object_name, '/', 3) <> 'k1'
    or exists (
      select 1 from investing_entities e
      where e.owner_id = auth.uid() and is_entity_k1_path(object_name, e.id)
    )
  ) and not exists (
    select 1 from documents d
    where d.kind = 'k1' and d.file_path = object_name
      and (not owns_entity(d.entity_id) or not is_entity_k1_path(object_name, d.entity_id))
  );
$$;
create policy portal_k1_read on storage.objects as restrictive
  for select to authenticated using (
    bucket_id <> 'portal' or is_gp() or can_read_k1_object(name)
  );

commit;


-- Source: migrations/0004_subscription_minimum.sql
-- Enforce the configured deal minimum when creating/revising a commitment.
-- Does not retroactively rewrite historical commitments after a minimum change.
begin;

create function subscriptions_minimum_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_minimum numeric;
begin
  if tg_op = 'UPDATE' then
    if new.amount is not distinct from old.amount
       and new.deal_id is not distinct from old.deal_id then
      return new;
    end if;
  end if;

  -- PostgreSQL numeric NaN compares above ordinary numbers, so amount > 0 alone
  -- does not reject it. No accepted commitment may introduce this sentinel.
  if new.amount = 'NaN'::numeric then
    raise exception 'Commitment amount must be finite';
  end if;

  -- Keep this decision consistent with a concurrent edit to the deal minimum.
  select min_investment into v_minimum from deals where id = new.deal_id for share;
  if new.amount < v_minimum then
    raise exception 'Minimum investment is %', v_minimum;
  end if;
  -- Unknown deals and nonpositive amounts retain their existing FK/CHECK errors.
  return new;
end $$;

create trigger subscriptions_minimum_guard before insert or update on subscriptions
  for each row execute function subscriptions_minimum_guard();

commit;


-- Source: migrations/0005_subscription_minimum_exceptions.sql
-- GP-only exact-amount exception on one immutable deal/entity subscription.
-- Approval is a commercial minimum exception, never accreditation approval.
begin;

alter table subscriptions
  add column minimum_exception_active boolean not null default false,
  add column minimum_exception_amount numeric(14,2),
  add column minimum_exception_reason text,
  add column minimum_exception_actor uuid references profiles,
  add column minimum_exception_at timestamptz;

create or replace function subscriptions_minimum_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_minimum numeric;
  v_changed boolean;
begin
  if tg_op = 'INSERT' then
    v_changed := new.minimum_exception_active or new.minimum_exception_amount is not null
      or new.minimum_exception_reason is not null or new.minimum_exception_actor is not null
      or new.minimum_exception_at is not null;
  else
    v_changed := row(new.minimum_exception_active, new.minimum_exception_amount,
      new.minimum_exception_reason, new.minimum_exception_actor, new.minimum_exception_at)
      is distinct from row(old.minimum_exception_active, old.minimum_exception_amount,
      old.minimum_exception_reason, old.minimum_exception_actor, old.minimum_exception_at);
    -- History must stay attached to its original investment, even after revocation.
    if old.minimum_exception_amount is not null and
       (new.id is distinct from old.id or new.deal_id is distinct from old.deal_id
        or new.entity_id is distinct from old.entity_id) then
      raise exception 'Minimum exception scope cannot change investment identity, deal or entity';
    end if;
  end if;

  if v_changed then
    if not is_gp() then raise exception 'Only a GP can approve, change or revoke a minimum exception'; end if;
    if nullif(btrim(new.minimum_exception_reason), '') is null then
      raise exception 'A reason is required for every minimum exception decision';
    end if;
    if new.minimum_exception_amount is null or new.minimum_exception_amount = 'NaN'::numeric
       or new.minimum_exception_amount <= 0 then
      raise exception 'Approved exception amount must be finite and positive';
    end if;
    if new.status not in ('committed', 'accreditation', 'withdrawn')
       or new.signed_doc_path is not null or new.gp_countersigned_at is not null
       or new.funded_amount is not null or new.funded_at is not null then
      raise exception 'Minimum exceptions must be decided before documents/signing begins';
    end if;
    if tg_op = 'UPDATE' then
      if old.status not in ('committed', 'accreditation')
         or old.signed_doc_path is not null or old.gp_countersigned_at is not null
         or old.funded_amount is not null or old.funded_at is not null then
        raise exception 'Minimum exceptions must be decided before documents/signing begins';
      end if;
    end if;
    if new.minimum_exception_active and new.amount <> new.minimum_exception_amount then
      raise exception 'Commitment must equal the approved exception amount';
    end if;
    new.minimum_exception_reason := btrim(new.minimum_exception_reason);
    new.minimum_exception_actor := auth.uid();
    new.minimum_exception_at := clock_timestamp();
  end if;

  if new.amount = 'NaN'::numeric then raise exception 'Commitment amount must be finite'; end if;
  if tg_op = 'UPDATE' and not v_changed then
    if new.amount is not distinct from old.amount and new.deal_id is not distinct from old.deal_id
       and new.entity_id is not distinct from old.entity_id
       and not (new.minimum_exception_amount is not null and not new.minimum_exception_active
                and new.status not in ('withdrawn', 'rejected')) then
      return new;
    end if;
  end if;
  -- Revocation may retain the historical amount only on a withdrawn commitment.
  if tg_op = 'UPDATE' and v_changed and old.minimum_exception_active
     and not new.minimum_exception_active and new.status = 'withdrawn'
     and new.amount = old.amount then return new; end if;

  select min_investment into v_minimum from deals where id = new.deal_id for share;
  if new.amount < v_minimum and not (
    new.minimum_exception_active and new.amount = new.minimum_exception_amount
    and new.minimum_exception_actor is not null and new.minimum_exception_at is not null
  ) then raise exception 'Minimum investment is % unless a GP approves this exact investment amount', v_minimum;
  end if;
  return new;
end $$;

-- Atomic grant/change: can create the initial commitment before LP form validation
-- would block it, or lower an existing early commitment without duplicating it.
create function set_subscription_minimum_exception(
  p_deal_id uuid, p_entity_id uuid, p_amount numeric, p_reason text
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not is_gp() then raise exception 'Only a GP can approve a minimum exception'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'A reason is required'; end if;
  if p_amount is null or p_amount = 'NaN'::numeric or p_amount <= 0 then
    raise exception 'Approved amount must be finite and positive';
  end if;
  if not exists (select 1 from deals where id = p_deal_id and status = 'open') then
    raise exception 'This offering is not open';
  end if;
  insert into subscriptions (deal_id, entity_id, amount, minimum_exception_active,
      minimum_exception_amount, minimum_exception_reason)
    values (p_deal_id, p_entity_id, p_amount, true, p_amount, p_reason)
    on conflict (deal_id, entity_id) do update set
      amount = excluded.amount, minimum_exception_active = true,
      minimum_exception_amount = excluded.minimum_exception_amount,
      minimum_exception_reason = excluded.minimum_exception_reason,
      minimum_exception_actor = excluded.minimum_exception_actor,
      minimum_exception_at = excluded.minimum_exception_at
    returning id into v_id;
  return v_id;
end $$;

create function revoke_subscription_minimum_exception(p_subscription_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare s subscriptions;
begin
  if not is_gp() then raise exception 'Only a GP can revoke a minimum exception'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'A reason is required'; end if;
  select * into s from subscriptions where id = p_subscription_id for update;
  if s.id is null or not s.minimum_exception_active then raise exception 'No active minimum exception'; end if;
  if s.status not in ('committed', 'accreditation') or s.signed_doc_path is not null
     or s.gp_countersigned_at is not null or s.funded_amount is not null or s.funded_at is not null then
    raise exception 'Revoke before documents/signing begins';
  end if;
  update subscriptions set minimum_exception_active = false,
    minimum_exception_reason = p_reason, status = 'withdrawn' where id = s.id;
end $$;
revoke all on function set_subscription_minimum_exception(uuid,uuid,numeric,text) from public;
revoke all on function revoke_subscription_minimum_exception(uuid,text) from public;
grant execute on function set_subscription_minimum_exception(uuid,uuid,numeric,text) to authenticated;
grant execute on function revoke_subscription_minimum_exception(uuid,text) to authenticated;
-- Existing audit_subscriptions captures every decision with before/after data,
-- authenticated actor and reason. Exception amounts never enter accreditation logic.
commit;


-- Source: migrations/0006_journey_exceptions.sql
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


-- Source: migrations/0007_profile_bootstrap_access.sql
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


-- Synthetic offering only. Auth users must be created through Supabase Auth.
-- No investor profile is promoted, no documents are fabricated, and no capital is accepted.
insert into public.deals (id, name, status, target_raise, min_investment, max_investors)
values ('de000000-0000-4000-8000-000000000001', 'DEMO — Sample Self Storage', 'open', 2000000, 50000, 25);
insert into public.deal_private (deal_id, wire_instructions)
values ('de000000-0000-4000-8000-000000000001', 'DEMO ONLY — No payment instructions. No money should be sent.');

commit;
