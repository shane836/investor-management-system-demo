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
