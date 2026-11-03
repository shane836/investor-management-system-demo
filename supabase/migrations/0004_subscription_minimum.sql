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
