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
